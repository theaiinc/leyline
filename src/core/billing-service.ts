import { isRouterPick } from './routing-strategies';
import { randomUUID } from 'crypto';
import {
  BillingError,
  CURRENCY,
  DEFAULT_SELLER,
  DEFAULT_VAT,
  METHOD_LABELS,
  cleanBuyerProfile,
  cleanVatInvoiceDetails,
  createPaymentReference,
  formatUsd,
  validateCreditAmount,
  vatFor,
  vietnamDate,
  type BillingAccount,
  type BillingOrder,
  type BuyerProfile,
  type EInvoice,
  type EInvoiceProvider,
  type EInvoiceRecord,
  type LegalSettings,
  type PaymentMethod,
  type Receipt,
  type VatInvoiceDetails,
  type VatSettings,
  type VndQuote,
} from './billing';
import { MICROS_PER_CENT, type D1BillingStore, type WorkspaceRecord } from './billing-store';
import { receiptPdf, type DocumentFonts } from './billing-documents';
import { captureFromEvent, PayPalError, type PayPalCapture, type PayPalClient } from './paypal';
import { getMode, type ProviderMode } from './provider-modes';
import { INVOICE_LOOKUP_URL } from './einvoice-viettel';
import type { FreeTierConfig } from './self-serve-workspaces';
import { PII_ADDON_ID, PII_ADDON_NAME, piiFeeMicros, piiPricePerMTokens } from './addons';
import { vndRate as publishedVndRate, type VndRate } from './fx';
import { SePayError, referencesIn, transactionFromWebhook, transferContentFor, type SePayClient, type SePayTransaction } from './sepay';
import { bestCampaign, publicCampaign, toMicros, type Campaign, type ChargeBasis, type D1CampaignStore } from './campaigns';

/** One email with attachments, as the Worker's Email Sending binding takes it. */
export type BillingEmail = {
  from: { email: string; name?: string };
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments: Array<{ filename: string; content: ArrayBuffer; type: string; disposition: 'attachment' }>;
};

export type BillingServiceOptions = {
  store: D1BillingStore;
  /** The invoice/receipt font (src/assets/fonts), loaded the way the host can. */
  fonts: () => Promise<DocumentFonts>;
  /** PayPal for a mode (null: that mode's secrets aren't set). Which mode is live is an admin setting. */
  paypal?: (mode: ProviderMode) => PayPalClient | null;
  /** Owner/admin workspaces: the only ones PayPal is offered to while it is in sandbox mode. */
  isAdminWorkspace?: (ws: WorkspaceRecord) => boolean;
  /** Sends billing email (the Worker's EMAIL binding); unset: no email on this host. */
  sendEmail?: (message: BillingEmail) => Promise<void>;
  /** BILLING_FROM, e.g. "Valefront Billing <billing@valefront.com>". */
  billingFrom?: string;
  /** https://dash.valefront.com: links in emails and PayPal's return address. */
  dashboardUrl: string;
  free: FreeTierConfig;
  /** Viettel S-Invoice for a mode; null until that mode is configured (requested VAT invoices wait as "pending"). */
  einvoice?: (mode: ProviderMode) => EInvoiceProvider | null;
  /** SePay (VND bank QR, sepay.ts); unset or null: not offered. Live only: SePay has no sandbox for bank accounts. */
  sepay?: SePayClient | null;
  /** The day's VND rate: the one /v1/pricing publishes (fx.ts), unless a test gives another. */
  vndRate?: () => Promise<VndRate | null>;
  /** Promotions (campaigns.ts, made on adm); unset: none, everything at the official price. */
  campaigns?: D1CampaignStore | null;
  /** Hook for the Bookkeeper service, which will later take over rendering and sharing receipts. */
  onReceiptIssued?: (receipt: Receipt) => Promise<void>;
  now?: () => number;
};

export const SETTINGS = { account: 'worldfirst_account', legal: 'legal', vat: 'vat', exchangeRate: 'einvoice_exchange_rate' } as const;

/** VND per USD for e-invoices in USD (Vietnamese law wants the rate on the invoice); set on the admin host. */
export type ExchangeRateSetting = { vndPerUsd: number; date: string };

/**
 * What charge() did, in micro-dollars: officialMicros is the payable part at the official price, chargedMicros what
 * was taken from the balance, discountMicros = officialMicros - chargedMicros exactly (0 without a campaign).
 */
export type ChargeResult = { officialMicros: number; chargedMicros: number; discountMicros: number; campaign: { id: string; name: string } | null; freeTokens: number };

/** A workspace may get a promo code wrong this many times an hour. */
export const PROMO_CODE_ATTEMPTS_PER_HOUR = 10;

export type Admission = { mode: 'free' | 'paid'; /** Free mode: the workspace also has a balance above 0. */ paid?: boolean } | { refusal: { status: number; code: string; message: string } };

/** A SePay quote is good for this long; after that the customer gets a new one (the rate moves daily). */
export const SEPAY_QUOTE_MS = 30 * 60_000;
/** "Check now" asks SePay at most this often per workspace. */
export const SEPAY_CHECK_INTERVAL_MS = 15_000;
/** Polling looks at pending SePay orders made this recently. */
export const SEPAY_POLL_WINDOW_MS = 3 * 86_400_000;

export type SepayMethod = { enabled: boolean; vndPerUsd: number | null; rateDate: string | null; bankName: string | null; quoteMinutes: number };

/** What happened with one SePay transaction. */
export type SepayOutcome = { outcome: string; orderId?: string | null; credited?: boolean; duplicate?: boolean };

const vnd = (n: number) => `${n.toLocaleString('en-US')} VND`;

export const ADD_CREDIT_URL = 'https://dash.valefront.com/billing';

/** A VAT invoice can be asked for after payment within this many days of paying (the receipt's date). */
export const VAT_REQUEST_WINDOW_DAYS = 30;
const VAT_REQUEST_WINDOW_MS = VAT_REQUEST_WINDOW_DAYS * 86_400_000;
/** A PDF an admin uploads for a manual invoice (stored base64 in D1, whose rows are at most 2 MB). */
export const MANUAL_EINVOICE_PDF_MAX_BYTES = 1_000_000;

/**
 * Whether VAT invoices are issued automatically through Viettel S-Invoice: in sandbox mode, always (as before: an
 * invoice waits as pending until sandbox is configured); in live mode only with every required live secret set.
 * Otherwise (live, not set up) nothing is sent to Viettel: a buyer's VAT invoice is a request an admin issues by hand.
 */
export function einvoiceAutomatic(mode: ProviderMode, liveConfigured: boolean): boolean {
  return mode === 'sandbox' || liveConfigured;
}

/** "Name <a@b>" -> { name, email }. */
export function parseFrom(value: string | undefined): { email: string; name?: string } | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  const m = /^(.*)<([^<>@\s]+@[^<>\s]+)>$/.exec(v);
  if (m) return { email: m[2]!.trim(), ...(m[1]!.trim() ? { name: m[1]!.trim().replace(/^"|"$/g, '') } : {}) };
  return /^[^@\s]+@[^@\s]+$/.test(v) ? { email: v } : null;
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

export class BillingService {
  readonly store: D1BillingStore;
  private readonly now: () => number;

  constructor(readonly opts: BillingServiceOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
  }

  // ── settings ──────────────────────────────────────────────────────────────────────────────────────────

  async account(): Promise<BillingAccount | null> {
    return (await this.store.setting<BillingAccount>(SETTINGS.account))?.value ?? null;
  }

  async seller(): Promise<LegalSettings> {
    return (await this.store.setting<LegalSettings>(SETTINGS.legal))?.value ?? DEFAULT_SELLER;
  }

  async vat(): Promise<VatSettings> {
    return (await this.store.setting<VatSettings>(SETTINGS.vat))?.value ?? DEFAULT_VAT;
  }

  /** The VND rate set on the admin host (the one VAT invoices use), if any. */
  async exchangeRate(): Promise<ExchangeRateSetting | null> {
    return (await this.store.setting<ExchangeRateSetting>(SETTINGS.exchangeRate))?.value ?? null;
  }

  /** Is S-Invoice usable now (einvoiceAutomatic)? Live is configured when its provider exists (all live secrets set). */
  async einvoiceIsAutomatic(): Promise<boolean> {
    const mode = await getMode(this.store, 'sinvoice');
    return einvoiceAutomatic(mode, mode === 'live' && Boolean(this.opts.einvoice?.('live')));
  }

  /** PayPal as it is now: its mode (admin setting) and, for that mode, a client (null: secrets missing). */
  async paypalNow(): Promise<{ mode: ProviderMode; client: PayPalClient | null }> {
    const mode = await getMode(this.store, 'paypal');
    return { mode, client: this.opts.paypal?.(mode) ?? null };
  }

  /**
   * The ways this workspace can pay. PayPal in sandbox mode is only for the owner's workspaces: anyone can make a
   * PayPal sandbox account, and sandbox payments add (test) credit.
   */
  async methods(ws?: WorkspaceRecord): Promise<{ worldfirst: boolean; paypal: { enabled: boolean; env: ProviderMode | null }; sepay: SepayMethod }> {
    const { mode, client } = await this.paypalNow();
    const allowed = Boolean(client) && (mode === 'live' || (ws ? Boolean(this.opts.isAdminWorkspace?.(ws)) : true));
    return { worldfirst: Boolean(await this.account()), paypal: { enabled: allowed, env: client ? mode : null }, sepay: await this.sepayMethod() };
  }

  /** SePay is offered when its account is known, payments can be confirmed (webhook key or API token), and there's a rate. */
  async sepayMethod(): Promise<SepayMethod> {
    const off: SepayMethod = { enabled: false, vndPerUsd: null, rateDate: null, bankName: null, quoteMinutes: SEPAY_QUOTE_MS / 60_000 };
    const sepay = this.opts.sepay;
    if (!sepay?.canConfirm) return off;
    const account = await sepay.account();
    if (!account) return off;
    const rate = await this.rate();
    if (!rate) return { ...off, bankName: account.bankName };
    return { enabled: true, vndPerUsd: rate.vnd_per_usd, rateDate: rate.date, bankName: account.bankName, quoteMinutes: SEPAY_QUOTE_MS / 60_000 };
  }

  private async rate(): Promise<VndRate | null> {
    const r = await (this.opts.vndRate ?? publishedVndRate)().catch(() => null);
    return r && Number.isInteger(r.vnd_per_usd) && r.vnd_per_usd > 1000 && r.vnd_per_usd < 1_000_000 ? r : null;
  }

  /**
   * A VND quote for an order's total: ceil(totalCents / 100 x vnd_per_usd), in whole dong (integer arithmetic, so it
   * is exact), valid for SEPAY_QUOTE_MS.
   */
  private async sepayQuote(totalCents: number, reference: string): Promise<VndQuote> {
    const sepay = this.opts.sepay;
    const account = sepay?.canConfirm ? await sepay.account() : null;
    if (!sepay || !account) throw new BillingError('method_unavailable', 'Vietnamese bank transfer is not available right now.', 409);
    const rate = await this.rate();
    if (!rate) throw new BillingError('method_unavailable', "Vietnamese bank transfer is not available right now (no exchange rate); try again shortly.", 409);
    const vndAmount = Math.ceil((totalCents * rate.vnd_per_usd) / 100);
    if (!Number.isSafeInteger(vndAmount) || vndAmount <= 0) throw new BillingError('quote_failed', 'Could not price this order in VND.', 500);
    const transferContent = transferContentFor(reference);
    const quotedAt = this.now();
    return {
      currency: 'VND', vndAmount, vndPerUsd: rate.vnd_per_usd, rateDate: rate.date, rateSource: rate.source, quotedAt, expiresAt: quotedAt + SEPAY_QUOTE_MS,
      transferContent, bank: account, qrUrl: sepay.qrUrl(account, vndAmount, transferContent),
    };
  }

  // ── orders ────────────────────────────────────────────────────────────────────────────────────────────

  async saveProfile(ws: WorkspaceRecord, input: unknown): Promise<BuyerProfile> {
    const current = await this.store.profile(ws.id);
    const profile = cleanBuyerProfile(input, ws.email);
    const saved = { ...profile, ...(current?.vatInvoice ? { vatInvoice: current.vatInvoice } : {}) };
    await this.store.saveProfile(ws.id, saved);
    return saved;
  }

  /** The VAT invoice details a buyer in Vietnam saves for their invoices. */
  async saveVatInvoiceDetails(ws: WorkspaceRecord, input: unknown): Promise<VatInvoiceDetails> {
    const profile = await this.store.profile(ws.id);
    if (!profile) throw new BillingError('billing_profile_required', 'Add your billing details first.');
    if (profile.country !== 'VN') throw new BillingError('vat_invoice_vietnam_only', 'Vietnamese VAT invoices are for customers in Vietnam.');
    const details = cleanVatInvoiceDetails(input);
    await this.store.saveProfile(ws.id, { ...profile, vatInvoice: details });
    return details;
  }

  /**
   * An Add-credit order. The same idempotencyKey (one per click on the Billing page) returns the same order, so a
   * double click or a retry never makes two. PayPal orders come back with the address to approve them at.
   */
  async createOrder(ws: WorkspaceRecord, input: { amountCents: number; method: PaymentMethod; idempotencyKey: string; vatInvoice?: boolean }): Promise<{ order: BillingOrder; approveUrl?: string }> {
    validateCreditAmount(input.amountCents);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(input.idempotencyKey)) throw new BillingError('idempotency_key_required', 'Missing request id; reload the page and try again.');
    const profile = await this.store.profile(ws.id);
    if (!profile) throw new BillingError('billing_profile_required', 'Add your billing details first (they go on your receipt).');
    const { vatInvoice: savedVat, ...buyer } = profile;
    let einvoiceRequest: VatInvoiceDetails | null = null;
    if (input.vatInvoice) {
      if (buyer.country !== 'VN') throw new BillingError('vat_invoice_vietnam_only', 'Vietnamese VAT invoices are for customers in Vietnam.');
      if (!savedVat) throw new BillingError('vat_invoice_details_required', 'Enter the company details for your VAT invoice first.');
      einvoiceRequest = savedVat;
    }
    let account: BillingAccount | null = null;
    let mode: ProviderMode = 'live';
    if (input.method === 'worldfirst') {
      account = await this.account();
      if (!account) throw new BillingError('method_unavailable', 'Bank transfer is not available right now; use PayPal or try later.', 409);
    } else if (input.method === 'paypal') {
      const paypal = await this.paypalNow();
      if (!paypal.client || (paypal.mode === 'sandbox' && !this.opts.isAdminWorkspace?.(ws))) throw new BillingError('method_unavailable', 'PayPal is not available right now.', 409);
      mode = paypal.mode;
    } else if (input.method === 'sepay') {
      // A replayed click returns its order (and quote) as it was; a new one is quoted below.
      const replay = await this.store.orderByIdempotencyKey(ws.id, input.idempotencyKey);
      if (replay) return { order: replay };
    } else {
      throw new BillingError('method_unavailable', `${METHOD_LABELS[input.method] ?? 'This method'} is not available yet.`, 409);
    }
    const { vatRateBp, vatCents, totalCents } = vatFor(input.amountCents, buyer.country, await this.vat());
    const reference = createPaymentReference();
    const quote = input.method === 'sepay' ? await this.sepayQuote(totalCents, reference) : null;
    const draft: BillingOrder = {
      id: `ord_${randomUUID().replace(/-/g, '')}`,
      workspaceId: ws.id,
      method: input.method,
      mode,
      amountCents: input.amountCents,
      vatRateBp,
      vatCents,
      totalCents,
      currency: CURRENCY,
      reference,
      status: 'pending',
      buyer,
      einvoiceRequest,
      account,
      quote,
      createdAt: this.now(),
    };
    const { order, created } = await this.store.createOrder(draft, input.idempotencyKey);
    if (created) await this.store.audit({ type: 'billing.order_created', workspaceId: ws.id, meta: { orderId: order.id, method: order.method, amountCents: order.amountCents } });
    if (order.method === 'paypal' && order.status === 'pending') return { order, approveUrl: await this.paypalCheckout(order) };
    return { order };
  }

  private async paypalCheckout(order: BillingOrder): Promise<string> {
    const base = this.opts.dashboardUrl.replace(/\/+$/, '');
    // PayPal-Request-Id makes this the same PayPal order every time for our order.
    const client = this.opts.paypal?.(order.mode);
    if (!client) throw new BillingError('method_unavailable', 'PayPal is not available right now.', 409);
    const checkout = await client.createCheckout({
      order,
      returnUrl: `${base}/billing?paypal=return&order=${order.id}`,
      cancelUrl: `${base}/billing?paypal=cancel&order=${order.id}`,
    });
    await this.store.setProviderOrderId(order.id, checkout.providerOrderId);
    return checkout.redirectUrl;
  }

  /** Back from PayPal: capture the customer's approved order and credit it (once). */
  async capturePayPal(ws: WorkspaceRecord, orderId: string): Promise<BillingOrder> {
    const order = await this.store.order(orderId);
    if (!order || order.workspaceId !== ws.id || order.method !== 'paypal') throw new BillingError('order_not_found', 'Order not found.', 404);
    if (order.status === 'paid') return order;
    // Captured with the PayPal the order was made with (its mode), whatever the switch says now.
    const client = this.opts.paypal?.(order.mode);
    if (order.status !== 'pending' || !order.providerOrderId || !client) throw new BillingError('order_not_payable', 'This order can no longer be paid.', 409);
    let capture: PayPalCapture;
    try {
      capture = await client.capture(order.providerOrderId);
    } catch (err) {
      if (err instanceof PayPalError) throw new BillingError('paypal_error', err.message, err.status);
      throw err;
    }
    await this.applyCapture(capture, 'paypal-capture', order.mode);
    return (await this.store.order(orderId))!;
  }

  /**
   * A completed PayPal capture -> the order paid (idempotent by order and capture id). The amount and currency must
   * be exactly the order's total; anything else is logged and not credited.
   */
  async applyCapture(capture: PayPalCapture, source: string, mode: ProviderMode): Promise<{ credited: boolean; reason?: string }> {
    const order = (capture.customId ? await this.store.order(capture.customId) : null)
      ?? (capture.paypalOrderId ? await this.store.orderByProviderOrderId(capture.paypalOrderId) : null);
    const log = (reason: string) => console.log(JSON.stringify({ event: 'paypal_capture_ignored', reason, source, captureId: capture.captureId, orderId: order?.id ?? null }));
    if (!order || order.method !== 'paypal') { log('unknown_order'); return { credited: false, reason: 'unknown_order' }; }
    // A sandbox capture never pays a live order (and the other way round).
    if (order.mode !== mode) { log('mode_mismatch'); return { credited: false, reason: 'mode_mismatch' }; }
    if (capture.status !== 'COMPLETED') { log(`status_${capture.status}`); return { credited: false, reason: 'not_completed' }; }
    if (capture.currency !== CURRENCY || capture.amountCents !== order.totalCents) { log('amount_mismatch'); return { credited: false, reason: 'amount_mismatch' }; }
    if (order.providerOrderId && capture.paypalOrderId && order.providerOrderId !== capture.paypalOrderId) { log('order_mismatch'); return { credited: false, reason: 'order_mismatch' }; }
    if (order.providerCaptureId && order.providerCaptureId !== capture.captureId) { log('other_capture'); return { credited: false, reason: 'other_capture' }; }
    const { transitioned } = await this.markPaid(order.id, { by: source, captureId: capture.captureId });
    return { credited: transitioned };
  }

  /** PayPal webhook: verified with PayPal, then PAYMENT.CAPTURE.COMPLETED credits its order (once). */
  async handlePayPalWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<{ status: number; body: unknown }> {
    // Live and sandbox webhooks come to the same address: whichever mode's PayPal verifies it, that's its mode.
    const clients = (['live', 'sandbox'] as const).map((mode) => ({ mode, client: this.opts.paypal?.(mode) ?? null })).filter((c) => c.client);
    if (!clients.length) return { status: 404, body: { error: 'paypal_not_configured' } };
    let verified: ProviderMode | null = null;
    for (const c of clients) {
      if (await c.client!.verifyWebhook(headers, rawBody)) { verified = c.mode; break; }
    }
    if (!verified) {
      console.log(JSON.stringify({ event: 'paypal_webhook_rejected' }));
      return { status: 400, body: { error: 'invalid_signature' } };
    }
    const event = JSON.parse(rawBody) as Record<string, unknown>;
    if (event.event_type !== 'PAYMENT.CAPTURE.COMPLETED') return { status: 200, body: { ignored: event.event_type } };
    const capture = captureFromEvent(event);
    if (!capture) return { status: 200, body: { ignored: 'no_capture' } };
    const result = await this.applyCapture(capture, 'paypal-webhook', verified);
    return { status: 200, body: result };
  }

  // ── SePay ─────────────────────────────────────────────────────────────────────────────────────────────

  /** A pending SePay order whose quote ran out gets a new one (same order and reference; the rate of now). */
  async requoteSepay(ws: WorkspaceRecord, orderId: string): Promise<BillingOrder> {
    const order = await this.store.order(orderId);
    if (!order || order.workspaceId !== ws.id || order.method !== 'sepay') throw new BillingError('order_not_found', 'Order not found.', 404);
    if (order.status !== 'pending') return order;
    if (order.quote && this.now() < order.quote.expiresAt) return order;
    // Money already received toward it stays counted; the customer pays what's left at the new quote.
    await this.store.setQuote(order.id, await this.sepayQuote(order.totalCents, order.reference));
    return (await this.store.order(orderId))!;
  }

  private lastCheck = new Map<string, number>();

  /**
   * The customer's "I've paid, check now": polls SePay (at most every SEPAY_CHECK_INTERVAL_MS per workspace; sooner
   * just returns the order as it is) and applies what it finds. The webhook usually got there first.
   */
  async checkSepay(ws: WorkspaceRecord, orderId: string): Promise<{ order: BillingOrder; checked: boolean }> {
    const order = await this.store.order(orderId);
    if (!order || order.workspaceId !== ws.id || order.method !== 'sepay') throw new BillingError('order_not_found', 'Order not found.', 404);
    if (order.status !== 'pending') return { order, checked: false };
    const last = this.lastCheck.get(ws.id) ?? 0;
    if (this.now() - last < SEPAY_CHECK_INTERVAL_MS || !this.opts.sepay?.status.apiToken) return { order, checked: false };
    this.lastCheck.set(ws.id, this.now());
    if (this.lastCheck.size > 5000) this.lastCheck.clear();
    await this.pollSepay();
    return { order: (await this.store.order(orderId))!, checked: true };
  }

  /** Polling fallback (the 15-minute cron, "check now"): SePay's latest transactions, when SePay orders are pending. */
  async pollSepay(): Promise<{ credited: number; seen: number }> {
    const sepay = this.opts.sepay;
    if (!sepay?.status.apiToken) return { credited: 0, seen: 0 };
    const pending = await this.store.pendingOrders('sepay', this.now() - SEPAY_POLL_WINDOW_MS, 1);
    if (!pending.length) return { credited: 0, seen: 0 };
    let list: SePayTransaction[];
    try {
      list = await sepay.recentTransactions(50);
    } catch (err) {
      console.error('[sepay] polling failed', err instanceof Error ? err.message : err);
      return { credited: 0, seen: 0 };
    }
    let credited = 0;
    for (const tx of list) {
      if (tx.direction !== 'in') continue;
      if ((await this.applySepay(tx, 'poll')).credited) credited++;
    }
    if (credited) console.log(JSON.stringify({ event: 'sepay_poll_credited', credited }));
    return { credited, seen: list.length };
  }

  /**
   * SePay's webhook: `Authorization: Apikey <key>` (constant-time), or no key and the transaction confirmed by SePay's API, then it is applied. Every payload we
   * recognise gets 200 {success:true}, so SePay doesn't retry; a wrong key is 401; a failure on our side is 500 (SePay
   * retries, and the transaction id keeps a retry from counting twice).
   */
  async handleSepayWebhook(headers: Record<string, string | string[] | undefined>, body: unknown): Promise<{ status: number; body: unknown }> {
    const sepay = this.opts.sepay;
    if (!sepay) return { status: 404, body: { success: false, error: 'sepay_not_configured' } };
    const parsed = transactionFromWebhook(body);
    let tx: SePayTransaction | null = parsed;
    if (!sepay.verifyWebhook(headers.authorization)) {
      // Without our key the body is only a hint: the transaction is read back from SePay's API by its id (needs the
      // API token), and only SePay's own record is applied. Unknown to SePay: rejected, nothing recorded.
      const id = body && typeof body === 'object' ? (body as Record<string, unknown>).id : undefined;
      tx = sepay.status.apiToken && (typeof id === 'string' || typeof id === 'number') ? await sepay.transaction(String(id)) : null;
      if (!tx) {
        console.log(JSON.stringify({ event: 'sepay_webhook_rejected' }));
        return { status: 401, body: { success: false, error: 'invalid_api_key' } };
      }
    }
    if (!tx) {
      console.log(JSON.stringify({ event: 'sepay_webhook_unrecognised' }));
      return { status: 400, body: { success: false, error: 'not_a_transaction' } };
    }
    const result = await this.applySepay(tx, 'webhook');
    return { status: 200, body: { success: true, ...result } };
  }

  /**
   * One SePay transaction -> its order paid (once). Incoming only, into our account, carrying an order reference.
   * What an order received is the sum of its matched transactions (each SePay id counted once): at least the quoted
   * VND credits the order's USD amount (an excess is noted for a refund); less keeps it pending, noted "underpaid by".
   */
  async applySepay(incoming: SePayTransaction, source: 'webhook' | 'poll'): Promise<SepayOutcome> {
    const { created, row } = await this.store.recordSepayTransaction({ ...incoming, source, receivedAt: this.now() });
    // Already recorded (perhaps under another id for the same bank transaction): carry on as that record.
    const tx = created ? incoming : { ...incoming, id: row.id };
    const log = (outcome: string, orderId: string | null = null) => console.log(JSON.stringify({ event: 'sepay_transaction', outcome, source, id: tx.id, orderId }));
    // A replay of one already settled: nothing more to do (an order it counted toward is re-checked below).
    if (!created && row.outcome && row.outcome !== 'underpaid') return { outcome: row.outcome, orderId: row.orderId ?? null, duplicate: true };
    const done = async (outcome: string, orderId: string | null = null): Promise<SepayOutcome> => {
      await this.store.setSepayOutcome(tx.id, orderId, outcome);
      log(outcome, orderId);
      return { outcome, orderId };
    };
    if (tx.direction !== 'in') return done('outbound');
    // No account right now (SePay's API unreachable): fail, so the webhook is retried, rather than drop the payment.
    const ours = (await this.opts.sepay?.account())?.accountNumber;
    if (!ours) throw new SePayError('SePay bank account unknown; retry later', 503);
    if (tx.accountNumber !== ours) return done('wrong_account');
    let order: BillingOrder | null = row.orderId ? await this.store.order(row.orderId) : null;
    if (!order) {
      for (const ref of referencesIn(tx.content)) {
        order = await this.store.orderByReference(ref);
        if (order) break;
      }
    }
    if (!order) return done('unmatched');
    if (order.method !== 'sepay' || !order.quote) return done('not_sepay_order', order.id);
    if (order.quote.bank.accountNumber !== tx.accountNumber) return done('wrong_account', order.id);
    const note = (line: string) => this.store.addPaymentNote(order!.id, `${new Date(this.now()).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${line}`);
    // A replay of one already counted (a crash before it was settled): settle again, without a second note.
    const counted = !created && row.outcome === 'underpaid';
    if (!counted) {
      if (order.status === 'paid') {
        await note(`another transfer of ${vnd(tx.amountVnd)} (SePay ${tx.id}) arrived after the order was paid: refund it.`);
        return done('already_paid', order.id);
      }
      if (order.status === 'cancelled') {
        await note(`a transfer of ${vnd(tx.amountVnd)} (SePay ${tx.id}) arrived for this cancelled order: refund it or credit it by hand.`);
        return done('order_cancelled', order.id);
      }
      // Counted toward the order from here on.
      await this.store.setSepayOutcome(tx.id, order.id, 'underpaid');
    }
    return { ...(await this.settleSepay(order.id, tx, !counted)), ...(counted ? { duplicate: true } : {}) };
  }

  /** Credits a SePay order when what it received reaches its quote (idempotent: markPaid transitions once). */
  private async settleSepay(orderId: string, tx: SePayTransaction, fresh: boolean): Promise<SepayOutcome> {
    const order = (await this.store.order(orderId))!;
    const quote = order.quote!;
    const received = await this.store.sepayReceived(order.id);
    const at = this.now();
    const note = (line: string) => this.store.addPaymentNote(order.id, `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC: ${line}`);
    const result = (outcome: string, credited = false): SepayOutcome => {
      console.log(JSON.stringify({ event: 'sepay_transaction', outcome, id: tx.id, orderId: order.id, receivedVnd: received, quotedVnd: quote.vndAmount }));
      return { outcome, orderId: order.id, credited };
    };
    if (order.status === 'paid') {
      await this.store.setSepayOutcome(tx.id, order.id, 'credited');
      return { ...result('credited'), duplicate: true };
    }
    if (received < quote.vndAmount) {
      if (fresh) await note(`underpaid by ${vnd(quote.vndAmount - received)}: received ${vnd(received)} of ${vnd(quote.vndAmount)} (SePay ${tx.id}, ${vnd(tx.amountVnd)}). Waiting for the rest.`);
      return result('underpaid');
    }
    const { transitioned } = await this.markPaid(order.id, { by: 'sepay', captureId: `SEPAY-${tx.id}` });
    await this.store.setSepayOutcome(tx.id, order.id, 'credited');
    if (transitioned) {
      await note(`paid: received ${vnd(received)} for a quote of ${vnd(quote.vndAmount)} at ${quote.vndPerUsd} VND/USD (${quote.rateDate}); credited ${formatUsd(order.amountCents)} (SePay ${tx.id}${tx.referenceCode ? `, bank ref ${tx.referenceCode}` : ''}).`);
      if (received > quote.vndAmount) await note(`overpaid by ${vnd(received - quote.vndAmount)}: refund the excess.`);
      if (at > quote.expiresAt) await note(`paid ${Math.round((at - quote.expiresAt) / 60_000)} min after the quote expired; credited at the quoted amount.`);
    }
    return result('credited', transitioned);
  }

  /**
   * Marks an order paid: credit on the ledger, invoice and receipt issued, PDFs made, email sent: each exactly once,
   * however often this runs. `by` is the admin (WorldFirst) or the PayPal path.
   */
  async markPaid(orderId: string, input: { by: string; captureId?: string | null }): Promise<{ transitioned: boolean; order: BillingOrder }> {
    const order = await this.store.order(orderId);
    if (!order) throw new BillingError('order_not_found', 'Order not found.', 404);
    if (order.status === 'cancelled') throw new BillingError('order_cancelled', 'This order was cancelled.', 409);
    // A VAT invoice asked for at checkout: issued automatically while S-Invoice is usable, else recorded as a request.
    const einvoice = order.einvoiceRequest && !(await this.einvoiceIsAutomatic()) ? 'manual' : 'automatic';
    const { transitioned } = await this.store.markPaid(orderId, { at: this.now(), by: input.by, captureId: input.captureId ?? null, seller: await this.seller(), einvoice });
    if (transitioned) {
      console.log(JSON.stringify({ event: 'billing_paid', orderId, method: order.method, amountCents: order.amountCents, by: input.by }));
      await this.store.audit({ type: 'billing.paid', workspaceId: order.workspaceId, meta: { orderId, by: input.by } });
      if (order.einvoiceRequest && einvoice === 'manual') await this.store.audit({ type: 'billing.einvoice_requested', workspaceId: order.workspaceId, meta: { orderId, via: 'checkout', manual: true } });
      // The first top-up unlocks the rest of the free tokens (Steve, 2026-11-05).
      const f = this.opts.free;
      const unlocked = await this.store.unlockFreeBonus(order.workspaceId, { baseTokens: f.tokens, bonusTokens: f.bonusTokens ?? 0, now: this.now(), days: f.expiresAfterDays })
        .catch((err) => { console.error('[billing] free bonus unlock failed', orderId, err); return false; });
      if (unlocked) await this.store.audit({ type: 'free.bonus_unlocked', workspaceId: order.workspaceId, meta: { orderId, tokens: f.bonusTokens } });
    }
    // Also after a replay: finishes a receipt email or e-invoice a crashed earlier run left undone.
    await this.issueDocuments(orderId).catch((err) => console.error('[billing] documents failed', orderId, err));
    return { transitioned, order: (await this.store.order(orderId))! };
  }

  // ── receipts, e-invoices and email ────────────────────────────────────────────────────────────────

  /** A stored PDF: our receipt (made on first use), or the e-invoice PDF S-Invoice rendered. */
  async pdf(kind: 'receipt' | 'einvoice', id: string): Promise<Uint8Array | null> {
    const stored = await this.store.document(id);
    if (stored) return stored;
    if (kind === 'receipt') {
      const receipt = await this.store.receipt(id);
      if (!receipt) return null;
      const pdf = await receiptPdf(receipt, await this.opts.fonts());
      await this.store.saveDocument(id, 'receipt', pdf);
      return pdf;
    }
    const e = await this.store.einvoice(id);
    // Issued by hand: only the PDF the admin uploaded (if any), never asked of S-Invoice.
    if (e?.record?.provider === 'manual') return null;
    const provider = e?.record ? this.opts.einvoice?.(e.mode) : null;
    if (!e?.record || !provider) return null;
    const pdf = await provider.pdf(e.record);
    await this.store.saveDocument(id, 'einvoice', pdf);
    return pdf;
  }

  /** After a payment: the receipt's PDF and email (once), then its VAT e-invoice if one was asked for. */
  async issueDocuments(orderId: string): Promise<void> {
    const receipt = await this.store.receiptForOrder(orderId);
    if (!receipt) return;
    const bytes = await this.pdf('receipt', receipt.id);
    if (!receipt.emailStatus) await this.emailReceipt(receipt, bytes!);
    if (this.opts.onReceiptIssued) await this.opts.onReceiptIssued(receipt).catch((err) => console.error('[billing] receipt hook failed', err));
    const e = await this.store.einvoiceForOrder(orderId);
    if (e) await this.processEinvoice(e.id);
  }

  private fromAddress(): { email: string; name?: string } | null {
    return this.opts.sendEmail ? parseFrom(this.opts.billingFrom) : null;
  }

  /** Emails the receipt PDF, once per payment: whoever claims the receipt first sends it. */
  private async emailReceipt(receipt: Receipt, bytes: Uint8Array): Promise<void> {
    const from = this.fromAddress();
    if (!from || !(await this.store.claimEmail(receipt.id))) return;
    const base = this.opts.dashboardUrl.replace(/\/+$/, '');
    const { date } = vietnamDate(receipt.issuedAt);
    const rows: Array<[string, string]> = [
      ['Amount received', `${formatUsd(receipt.totalCents)} ${receipt.currency}`],
      ['Credit added', formatUsd(receipt.amountCents)],
      ...(receipt.vatCents ? [['VAT included', formatUsd(receipt.vatCents)] as [string, string]] : []),
      ['Date', date],
      ['Payment method', `${METHOD_LABELS[receipt.method]}${receipt.providerReference ? ` (${receipt.providerReference})` : ''}`],
      ['Receipt', receipt.number],
    ];
    const footer = `${receipt.seller.companyName}, ${receipt.seller.address}. Tax code ${receipt.seller.taxCode}.`;
    try {
      await this.opts.sendEmail!({
        from,
        to: receipt.buyer.email,
        subject: `${receipt.mode === 'sandbox' ? '[SANDBOX] ' : ''}Your Valefront receipt ${receipt.number}`,
        text: ['Thank you for your payment to Valefront.', '', ...rows.map(([k, v]) => `${k}: ${v}`), '', `Your balance and receipts: ${base}/billing`,
          `View this receipt: ${base}/dashboard/me/billing/receipts/${receipt.id}`, '', 'The receipt is attached as a PDF.', '', footer].join('\n'),
        html: emailHtml('Thank you for your payment to Valefront.', rows, `${base}/billing`, 'Your balance and receipts', 'The receipt is attached as a PDF.', footer),
        attachments: [{ filename: `${receipt.number}.pdf`, content: toArrayBuffer(bytes), type: 'application/pdf', disposition: 'attachment' }],
      });
      await this.store.setEmailStatus(receipt.id, 'sent');
      console.log(JSON.stringify({ event: 'billing_email_sent', receipt: receipt.number }));
    } catch (err) {
      await this.store.setEmailStatus(receipt.id, 'failed');
      console.error('[billing] receipt email failed', receipt.number, err instanceof Error ? err.message : err);
    }
  }

  /** Admin: send a receipt's email again (after a failure, or on request). */
  async resendEmail(orderId: string): Promise<boolean> {
    const receipt = await this.store.receiptForOrder(orderId);
    if (!receipt) return false;
    await this.store.setEmailStatus(receipt.id, null);
    await this.emailReceipt({ ...receipt, emailStatus: null }, (await this.pdf('receipt', receipt.id))!);
    return (await this.store.receipt(receipt.id))?.emailStatus === 'sent';
  }

  /**
   * Issues one VAT e-invoice through S-Invoice, or leaves it pending saying why (not configured yet, no exchange
   * rate, Viettel failed: the retry job tries again). Idempotent per payment: the e-invoice's id is the
   * transactionUuid, one attempt runs at a time, and a retry first asks Viettel whether the last attempt went through.
   */
  async processEinvoice(id: string): Promise<EInvoice | null> {
    let e = await this.store.einvoice(id);
    if (!e) return null;
    if (e.status === 'issued') {
      if (!e.emailStatus) await this.emailEinvoice(e);
      return this.store.einvoice(id);
    }
    if (e.status !== 'pending' && e.status !== 'issuing') return e;
    // Issued only through S-Invoice in the payment's own mode: a real payment never gets a test invoice, nor a test
    // payment a real one.
    const current = await getMode(this.store, 'sinvoice');
    if (current !== e.mode) {
      await this.store.einvoiceWaiting(id, `Viettel S-Invoice is in ${current} mode; this ${e.mode} payment's invoice waits for ${e.mode} mode`);
      return this.store.einvoice(id);
    }
    const provider = this.opts.einvoice?.(e.mode) ?? null;
    if (!provider && current === 'live') {
      // Live without its secrets (an invoice from before requests existed): not retried forever, an admin issues it.
      if (await this.store.einvoiceToManual(id, 'Viettel S-Invoice (live) is not set up: issue this one by hand')) {
        await this.store.audit({ type: 'billing.einvoice_requested', workspaceId: e.workspaceId, meta: { orderId: e.orderId, via: 'not_configured', manual: true } });
      }
      return this.store.einvoice(id);
    }
    if (!provider) {
      await this.store.einvoiceWaiting(id, `Viettel S-Invoice (${e.mode}) is not configured yet`);
      return this.store.einvoice(id);
    }
    const fx = (await this.store.setting<ExchangeRateSetting>(SETTINGS.exchangeRate))?.value;
    if (!fx || !(fx.vndPerUsd > 0)) {
      await this.store.einvoiceWaiting(id, 'The USD to VND exchange rate for e-invoices is not set (admin host)');
      return this.store.einvoice(id);
    }
    if (!(await this.store.claimEinvoice(id))) return this.store.einvoice(id);
    e = (await this.store.einvoice(id))!;
    try {
      // A retry: did the last attempt (a timeout, a crash) make the invoice after all?
      const record = (e.attempts > 1 ? await provider.findByTransactionUuid(e.id) : null)
        ?? await provider.issue(e, { seller: await this.seller(), exchangeRate: fx.vndPerUsd });
      await this.store.einvoiceIssued(id, record);
      console.log(JSON.stringify({ event: 'einvoice_issued', id, invoiceNo: record.invoiceNo, codeOfTax: record.codeOfTax ?? null }));
      await this.store.audit({ type: 'billing.einvoice_issued', workspaceId: e.workspaceId, meta: { orderId: e.orderId, invoiceNo: record.invoiceNo } });
      const issued = (await this.store.einvoice(id))!;
      await this.emailEinvoice(issued);
      return this.store.einvoice(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.store.einvoiceFailed(id, message);
      console.error('[billing] e-invoice attempt failed; it will be retried', id, message);
      return this.store.einvoice(id);
    }
  }

  /** The retry job (Worker cron, and after admin changes): every e-invoice still waiting. */
  async processPendingEinvoices(limit = 20): Promise<number> {
    let issued = 0;
    for (const e of await this.store.einvoicesToIssue(limit)) {
      if ((await this.processEinvoice(e.id))?.status === 'issued') issued++;
    }
    return issued;
  }

  /** Emails an issued e-invoice with Viettel's PDF, once. */
  private async emailEinvoice(e: EInvoice): Promise<void> {
    const from = this.fromAddress();
    if (!from || !e.record || !(await this.store.claimEinvoiceEmail(e.id))) return;
    const manual = e.record.provider === 'manual';
    try {
      const pdf = await this.pdf('einvoice', e.id);
      if (!pdf && !manual) throw new Error('no e-invoice PDF');
      const lookupUrl = e.record.lookupUrl || INVOICE_LOOKUP_URL;
      const note = pdf ? (manual ? 'The e-invoice (PDF) is attached.' : 'The e-invoice (PDF from Viettel S-Invoice) is attached.') : 'Look the e-invoice up with the code above.';
      const base = this.opts.dashboardUrl.replace(/\/+$/, '');
      const rows: Array<[string, string]> = [
        ['Số hóa đơn / Invoice no.', e.record.invoiceNo],
        ...(e.record.codeOfTax ? [['Mã cơ quan thuế / Tax authority code', e.record.codeOfTax] as [string, string]] : []),
        ...(e.record.reservationCode ? [['Mã tra cứu / Lookup code', e.record.reservationCode] as [string, string], ['Tra cứu tại / Look it up at', lookupUrl] as [string, string]] : []),
        ['Đơn vị mua / Buyer', `${e.details.companyName} (MST ${e.details.taxCode})`],
        ['Tổng tiền / Total', `${formatUsd(e.totalCents)} ${e.currency} (VAT ${formatUsd(e.vatCents)})`],
      ];
      const seller = await this.seller();
      const footer = `${seller.localName || seller.companyName}, MST ${seller.taxCode}, ${seller.address}.`;
      await this.opts.sendEmail!({
        from,
        to: e.details.email,
        subject: `${e.mode === 'sandbox' ? '[SANDBOX] ' : ''}Hóa đơn GTGT / Your Vietnamese VAT invoice ${e.record.invoiceNo}`,
        text: ['Hóa đơn GTGT điện tử của bạn đã được phát hành. Your Vietnamese VAT e-invoice has been issued.', '', ...rows.map(([k, v]) => `${k}: ${v}`), '',
          `Billing: ${base}/billing`, '', note, '', footer].join('\n'),
        html: emailHtml('Hóa đơn GTGT điện tử của bạn đã được phát hành. Your Vietnamese VAT e-invoice has been issued.', rows, `${base}/billing`, 'Billing', note, footer),
        attachments: pdf ? [{ filename: `${e.record.invoiceNo.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`, content: toArrayBuffer(pdf), type: 'application/pdf', disposition: 'attachment' }] : [],
      });
      await this.store.setEinvoiceEmailStatus(e.id, 'sent');
    } catch (err) {
      // Back to unsent: the next retry run sends it.
      await this.store.setEinvoiceEmailStatus(e.id, null);
      console.error('[billing] e-invoice email failed', e.id, err instanceof Error ? err.message : err);
    }
  }

  // ── VAT invoices on request ───────────────────────────────────────────────────────────────────────────

  /** Can this paid order still get a VAT invoice asked for (buyer in Vietnam, within the window, none or a rejected one)? */
  private requestable(order: BillingOrder, existing: EInvoice | null): boolean {
    return order.status === 'paid' && order.buyer.country === 'VN' && Boolean(order.paidAt) && this.now() - order.paidAt! <= VAT_REQUEST_WINDOW_MS
      && (!existing || existing.status === 'rejected');
  }

  /**
   * A buyer asks for a VAT invoice for one of their own paid orders, with their saved VAT invoice details: within
   * VAT_REQUEST_WINDOW_DAYS of paying, one per order (asking again returns the one there is; a rejected one may be
   * asked for again). While S-Invoice is usable it is issued automatically; otherwise it waits for an admin.
   */
  async requestVatInvoice(ws: WorkspaceRecord, orderId: string): Promise<EInvoice> {
    const order = await this.store.order(orderId);
    if (!order || order.workspaceId !== ws.id) throw new BillingError('order_not_found', 'Order not found.', 404);
    if (order.status !== 'paid' || !order.paidAt) throw new BillingError('order_not_paid', 'A VAT invoice can be asked for once the order is paid.', 409);
    const existing = await this.store.einvoiceForOrder(order.id);
    if (existing && existing.status !== 'rejected') return existing;
    if (order.buyer.country !== 'VN') throw new BillingError('vat_invoice_vietnam_only', 'Vietnamese VAT invoices are for customers in Vietnam.');
    if (!this.requestable(order, existing)) throw new BillingError('vat_invoice_window_closed', `A VAT invoice can be asked for up to ${VAT_REQUEST_WINDOW_DAYS} days after payment; for this order, write to support@valefront.com.`, 409);
    const details = (await this.store.profile(ws.id))?.vatInvoice;
    if (!details) throw new BillingError('vat_invoice_details_required', 'Enter the company details for your VAT invoice first.');
    const receipt = await this.store.receiptForOrder(order.id);
    if (!receipt) throw new BillingError('order_not_paid', 'The receipt for this order is still being made; try again in a minute.', 409);
    const manual = !(await this.einvoiceIsAutomatic());
    let e: EInvoice;
    let changed: boolean;
    if (existing) {
      changed = await this.store.reopenEinvoiceRequest(existing.id, details, manual);
      e = (await this.store.einvoice(existing.id))!;
    } else {
      const made = await this.store.createEinvoiceRequest(order, receipt.id, details, manual);
      changed = made.created;
      e = made.einvoice;
    }
    if (changed) {
      await this.store.audit({ type: 'billing.einvoice_requested', workspaceId: ws.id, meta: { orderId: order.id, via: 'customer', manual, ...(existing ? { again: true } : {}) } });
      if (!manual) e = (await this.processEinvoice(e.id)) ?? e;
    }
    return e;
  }

  /**
   * Admin: a requested VAT invoice was issued by hand (e.g. on S-Invoice's own portal). Its number, optionally the
   * lookup code (+ where to look it up), the tax authority code and the PDF. Requested -> issued once; then emailed.
   */
  async issueEinvoiceManually(id: string, input: { by: string; invoiceNo: unknown; lookupCode?: unknown; lookupUrl?: unknown; codeOfTax?: unknown; pdf?: Uint8Array | null }): Promise<{ einvoice: EInvoice; issued: boolean }> {
    const e = await this.store.einvoice(id);
    if (!e) throw new BillingError('einvoice_not_found', 'VAT invoice request not found.', 404);
    if (e.status === 'issued' && e.record?.provider === 'manual') return { einvoice: e, issued: false };
    if (e.status !== 'requested') throw new BillingError('not_requested', `This VAT invoice is ${e.status}, not waiting to be issued by hand.`, 409);
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');
    const invoiceNo = text(input.invoiceNo, 60);
    if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(invoiceNo)) throw new BillingError('invoice_no_required', 'Enter the invoice number (letters, digits, / _ . -).');
    const lookupUrl = text(input.lookupUrl, 300);
    if (lookupUrl && !/^https:\/\/[^\s]+$/.test(lookupUrl)) throw new BillingError('lookup_url_invalid', 'The lookup address must start with https://.');
    const pdf = input.pdf && input.pdf.byteLength ? input.pdf : null;
    if (pdf && (pdf.byteLength > MANUAL_EINVOICE_PDF_MAX_BYTES || Buffer.from(pdf.subarray(0, 5)).toString('latin1') !== '%PDF-')) {
      throw new BillingError('pdf_invalid', `The file must be a PDF of at most ${MANUAL_EINVOICE_PDF_MAX_BYTES / 1_000_000} MB.`);
    }
    const seller = await this.seller();
    const record: EInvoiceRecord = {
      provider: 'manual', invoiceNo, transactionUuid: e.id, transactionId: null, reservationCode: text(input.lookupCode, 100) || null, codeOfTax: text(input.codeOfTax, 100) || null,
      templateCode: '', series: '', supplierTaxCode: seller.taxCode, issuedAt: this.now(), lookupUrl: lookupUrl || null,
    };
    if (pdf) await this.store.saveDocument(e.id, 'einvoice', pdf);
    const issued = await this.store.einvoiceManualIssued(e.id, record, input.by);
    if (issued) {
      console.log(JSON.stringify({ event: 'einvoice_issued_manually', id: e.id, invoiceNo, pdf: Boolean(pdf) }));
      await this.store.audit({ type: 'billing.einvoice_issued', workspaceId: e.workspaceId, meta: { orderId: e.orderId, invoiceNo, manual: true, pdf: Boolean(pdf), by: input.by } });
      await this.emailEinvoice((await this.store.einvoice(e.id))!);
    }
    return { einvoice: (await this.store.einvoice(e.id))!, issued };
  }

  /** Admin: a requested VAT invoice won't be issued; the buyer sees why (and may ask again within the window). */
  async rejectEinvoiceRequest(id: string, input: { by: string; reason: unknown }): Promise<EInvoice> {
    const e = await this.store.einvoice(id);
    if (!e) throw new BillingError('einvoice_not_found', 'VAT invoice request not found.', 404);
    const reason = typeof input.reason === 'string' ? input.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500) : '';
    if (!reason) throw new BillingError('reason_required', 'Give the reason (the customer sees it).');
    if (!(await this.store.einvoiceRejected(id, reason, input.by))) throw new BillingError('not_requested', `This VAT invoice is ${e.status}, not waiting to be issued by hand.`, 409);
    await this.store.audit({ type: 'billing.einvoice_rejected', workspaceId: e.workspaceId, meta: { orderId: e.orderId, by: input.by, reason } });
    return (await this.store.einvoice(id))!;
  }

  // ── credit gate ───────────────────────────────────────────────────────────────────────────────────────

  isFreeModel(model: string): boolean {
    return this.opts.free.models.some((m) => m.toLowerCase() === model.toLowerCase());
  }

  /**
   * May this workspace make a request for `model` (already resolved from aliases; '' or 'auto' when the router
   * picks)? Free tokens cover the free-tier models while the grant lasts; everything else needs a balance above 0.
   * A key with PII protection on always needs a balance above 0: free tokens never cover the add-on's fee.
   */
  async admit(ws: WorkspaceRecord, model: string, opts: { piiProtection?: boolean } = {}): Promise<Admission> {
    if (ws.deletedAt) return { refusal: { status: 401, code: 'key_revoked', message: 'This API key has been revoked.' } };
    if (ws.suspendedAt) return { refusal: { status: 403, code: 'workspace_or_key_suspended', message: 'This workspace or API key is suspended.' } };
    const now = this.now();
    const [balance, grant] = await Promise.all([this.store.balance(ws.id), this.store.grant(ws.id)]);
    const paid = balance.availableMicros > 0;
    if (opts.piiProtection && !paid) {
      return { refusal: { status: 402, code: 'insufficient_credit', message: `PII protection is on for this key and needs credit: its fee is charged from your balance (free tokens don't cover it), and your balance is $0.00. Add credit at ${ADD_CREDIT_URL}, or turn PII protection off for this key.` } };
    }
    const routerPicks = isRouterPick(model);
    const freeLeft = grant && now < grant.expiresAt && grant.usedTokens < grant.tokens;
    if (freeLeft && (routerPicks || this.isFreeModel(model))) {
      const day = new Date(now).toISOString().slice(0, 10);
      const today = await this.store.freeTokensOn(ws.id, day);
      if (today.global >= this.opts.free.globalTokensPerDay) {
        if (paid) return { mode: 'paid' };
        return { refusal: { status: 429, code: 'global_free_budget_exhausted', message: `Today's free-tier capacity is used up; it resets at 00:00 UTC. Add credit at ${ADD_CREDIT_URL} to keep going now.` } };
      }
      if (today.workspace >= this.opts.free.tokensPerDay) {
        if (paid) return { mode: 'paid' };
        return { refusal: { status: 429, code: 'free_daily_token_cap', message: `This workspace has used its ${this.opts.free.tokensPerDay.toLocaleString('en-US')} free tokens for today; it resets at 00:00 UTC. Add credit at ${ADD_CREDIT_URL} to keep going now.` } };
      }
      return { mode: 'free', paid };
    }
    if (paid) return { mode: 'paid' };
    const why = freeLeft ? `Free tokens cover only ${this.opts.free.models.join(', ')}.` : grant ? 'Your free tokens are used up or expired.' : 'Your balance is $0.00.';
    return { refusal: { status: 402, code: 'insufficient_credit', message: `${why} Add credit at ${ADD_CREDIT_URL}` } };
  }

  /**
   * A request to one of the workspace's own providers (BYOK, src/core/workspace-providers.ts): billed by that provider,
   * so no model price and no credit is needed. The workspace must still be in good standing, and PII protection,
   * Valefront's add-on, still needs credit for its fee.
   */
  async admitByok(ws: WorkspaceRecord, opts: { piiProtection?: boolean } = {}): Promise<{ refusal?: { status: number; code: string; message: string } }> {
    if (ws.deletedAt) return { refusal: { status: 401, code: 'key_revoked', message: 'This API key has been revoked.' } };
    if (ws.suspendedAt) return { refusal: { status: 403, code: 'workspace_or_key_suspended', message: 'This workspace or API key is suspended.' } };
    if (opts.piiProtection && (await this.store.balance(ws.id)).availableMicros <= 0) {
      return { refusal: { status: 402, code: 'insufficient_credit', message: `PII protection is on for this key and needs credit: its fee is charged from your balance, also on your own providers, and your balance is $0.00. Add credit at ${ADD_CREDIT_URL}, or turn PII protection off for this key.` } };
    }
    return {};
  }

  /**
   * After a request: free tokens first (for a free-tier model, while the grant lasts), the rest from the balance.
   * usd is null when the model has no real price: nothing is charged (and it's logged), never the default price.
   * With `basis` (what the request was), a live campaign covering the model (automatic, or one this workspace
   * redeemed) lowers the charge to its promo price; the lowest one wins. Campaigns that can't be read are logged
   * and the official price is charged: a promotion is never applied by guesswork.
   */
  async charge(ws: WorkspaceRecord, input: { model: string; tokens: number; usd: number | null; basis?: ChargeBasis }): Promise<ChargeResult> {
    const tokens = Math.max(0, Math.round(input.tokens));
    const none = (freeTokens = 0): ChargeResult => ({ officialMicros: 0, chargedMicros: 0, discountMicros: 0, campaign: null, freeTokens });
    let payable = 1;
    let freeTokens = 0;
    if (this.isFreeModel(input.model) && tokens > 0) {
      const grant = await this.store.grant(ws.id);
      const now = this.now();
      if (grant && now < grant.expiresAt && grant.usedTokens < grant.tokens) {
        freeTokens = Math.min(tokens, grant.tokens - grant.usedTokens);
        await this.store.addFreeUsage(ws.id, new Date(now).toISOString().slice(0, 10), freeTokens);
        payable = (tokens - freeTokens) / tokens;
      }
    }
    if (payable <= 0) return none(freeTokens);
    if (input.usd === null) {
      console.log(JSON.stringify({ event: 'unpriced_customer_usage', workspaceId: ws.id, model: input.model, tokens }));
      return none(freeTokens);
    }
    const officialMicros = toMicros(input.usd * payable);
    let chargedMicros = officialMicros;
    let campaign: Campaign | null = null;
    if (input.basis && this.opts.campaigns && officialMicros > 0) {
      try {
        const best = bestCampaign(await this.opts.campaigns.applicable(ws.id, this.now()), input.model, input.basis, officialMicros, payable);
        if (best) { chargedMicros = best.micros; campaign = best.campaign; }
      } catch (err) {
        console.error(JSON.stringify({ event: 'campaign_lookup_failed', workspaceId: ws.id, model: input.model, error: err instanceof Error ? err.message : String(err) }));
      }
    }
    await this.store.chargeUsage(ws.id, chargedMicros);
    return { officialMicros, chargedMicros, discountMicros: officialMicros - chargedMicros, campaign: campaign ? { id: campaign.id, name: campaign.name } : null, freeTokens };
  }

  // ── promotions ────────────────────────────────────────────────────────────────────────────────────────

  /**
   * A promo code entered on dash Billing. Codes are case-insensitive; a workspace gets at most
   * PROMO_CODE_ATTEMPTS_PER_HOUR wrong ones an hour (guessing is slowed down, and every attempt is audited).
   */
  async redeemPromoCode(ws: WorkspaceRecord, rawCode: unknown): Promise<{ campaign: ReturnType<typeof publicCampaign>; already: boolean }> {
    const campaigns = this.opts.campaigns;
    if (!campaigns) throw new BillingError('promotions_unavailable', 'Promo codes are not available right now.', 503);
    if (ws.suspendedAt) throw new BillingError('workspace_suspended', 'This workspace is suspended.', 403);
    const code = String(rawCode ?? '').trim().toUpperCase().slice(0, 64);
    if (!code) throw new BillingError('invalid_code', 'Enter a promo code.');
    const now = this.now();
    if (await campaigns.rejectedSince(ws.id, now - 3_600_000) >= PROMO_CODE_ATTEMPTS_PER_HOUR) {
      throw new BillingError('too_many_attempts', 'Too many promo codes tried; try again in an hour.', 429);
    }
    const { outcome, campaign } = await campaigns.redeem(code, ws.id, now);
    const reject = async (status: number, message: string) => {
      await this.store.audit({ type: 'promo_code.rejected', workspaceId: ws.id, meta: { outcome, ...(campaign ? { campaignId: campaign.id } : {}) } });
      throw new BillingError(`promo_code_${outcome}`, message, status);
    };
    if (outcome === 'not_found') return reject(404, 'That promo code is not valid.');
    if (outcome === 'ended') return reject(410, 'That promotion has ended.');
    if (outcome === 'full') return reject(409, 'That promo code has been used the most times it can be.');
    if (outcome === 'already' && campaign!.oncePerWorkspace) throw new BillingError('promo_code_already', 'This workspace already redeemed that promo code; it applies until the promotion ends.', 409);
    if (outcome === 'redeemed') await this.store.audit({ type: 'promo_code.redeemed', workspaceId: ws.id, meta: { campaignId: campaign!.id } });
    return { campaign: publicCampaign(campaign!), already: outcome === 'already' };
  }

  /** Promotions this workspace has: live automatic ones, and active codes it redeemed (until they end; `live` once started). */
  async promotions(ws: WorkspaceRecord) {
    const campaigns = this.opts.campaigns;
    if (!campaigns) return { available: false, campaigns: [] };
    const now = this.now();
    try {
      const [redeemed, live] = await Promise.all([campaigns.redeemedBy(ws.id, now), campaigns.liveAutomatic(now)]);
      const shown = [...live, ...redeemed.filter((c) => c.status === 'active')];
      return { available: true, campaigns: shown.map((c) => ({ ...publicCampaign(c), live: c.startsAt <= now && now < c.endsAt })) };
    } catch (err) {
      console.error('[billing] promotions lookup failed', err);
      return { available: true, campaigns: [] };
    }
  }

  /**
   * After a request on a key with PII protection on: its fee (input tokens x PII_PRICE_PER_M_TOKENS per 1M) from the
   * balance, always (free tokens never cover it), as its own "PII protection" ledger line. Returns the US dollars
   * charged (exactly the micros accrued), for the spend line.
   */
  async chargePiiProtection(ws: WorkspaceRecord, inputTokens: number): Promise<{ usd: number; micros: number; tokens: number; pricePerM: number }> {
    const tokens = Math.max(0, Math.round(inputTokens));
    const pricePerM = piiPricePerMTokens();
    const micros = piiFeeMicros(tokens, pricePerM);
    if (tokens > 0 && micros <= 0) throw new Error(`PII protection fee came to 0 for ${tokens} tokens at ${pricePerM} USD/1M`);
    await this.store.chargeAddon(ws.id, PII_ADDON_ID, micros, PII_ADDON_NAME);
    return { usd: micros / 1_000_000, micros, tokens, pricePerM };
  }

  /** What the Billing page shows. */
  async overview(ws: WorkspaceRecord) {
    const [balance, ledger, orders, receipts, einvoices, profile, grant, methods, vat, automatic] = await Promise.all([
      this.store.balance(ws.id), this.store.ledger(ws.id, 200), this.store.orders(ws.id), this.store.receipts(ws.id), this.store.einvoices(ws.id),
      this.store.profile(ws.id), this.store.grant(ws.id), this.methods(ws), this.vat(), this.einvoiceIsAutomatic(),
    ]);
    const einvoiceOf = new Map(einvoices.map((e) => [e.orderId, e]));
    const manualFiles = new Set((await Promise.all(einvoices.filter((e) => e.status === 'issued' && e.record?.provider === 'manual')
      .map(async (e) => ((await this.store.hasDocument(e.id)) ? e.id : null)))).filter(Boolean));
    return {
      balanceCents: balance.cents,
      pendingUsageCents: balance.pendingMicros / MICROS_PER_CENT,
      availableCents: Math.floor(balance.availableMicros / MICROS_PER_CENT),
      currency: CURRENCY,
      minimumCents: 1000,
      ledger,
      orders: orders.map(({ buyer: _b, account: _a, ...o }) => ({ ...o, vatInvoice: Boolean(o.einvoiceRequest), einvoiceRequest: undefined,
        vatInvoiceRequestable: this.requestable({ ...o, buyer: _b, account: _a }, einvoiceOf.get(o.id) ?? null) })),
      receipts: receipts.map((r) => ({ id: r.id, orderId: r.orderId, mode: r.mode, number: r.number, issuedAt: r.issuedAt, totalCents: r.totalCents, amountCents: r.amountCents, emailStatus: r.emailStatus ?? null })),
      einvoices: einvoices.map((e) => ({
        id: e.id, orderId: e.orderId, mode: e.mode, status: e.status === 'issuing' || e.status === 'failed' ? 'pending' : e.status, invoiceNo: e.record?.invoiceNo ?? null,
        codeOfTax: e.record?.codeOfTax ?? null, reservationCode: e.record?.reservationCode ?? null, issuedAt: e.issuedAt ?? null, totalCents: e.totalCents, email: e.details.email,
        manual: Boolean(e.manual), rejectReason: e.status === 'rejected' ? e.rejectReason ?? null : null,
        lookupUrl: e.record ? e.record.lookupUrl || (e.record.reservationCode ? INVOICE_LOOKUP_URL : null) : null,
        file: e.status === 'issued' && Boolean(e.record) && (e.record!.provider !== 'manual' || manualFiles.has(e.id)),
      })),
      /** VAT invoices: issued automatically now, or on request (an admin issues them); asked for after payment within requestWindowDays. */
      vatInvoices: { automatic, requestWindowDays: VAT_REQUEST_WINDOW_DAYS },
      profile,
      free: grant ? { tokens: grant.tokens, usedTokens: grant.usedTokens, expiresAt: grant.expiresAt, models: this.opts.free.models,
        bonusTokens: this.opts.free.bonusTokens ?? 0, bonusUnlocked: grant.tokens >= this.opts.free.tokens + (this.opts.free.bonusTokens ?? 0) } : null,
      methods,
      vat,
      promotions: await this.promotions(ws),
    };
  }
}

function emailHtml(intro: string, rows: Array<[string, string]>, link: string, linkText: string, note: string, footer: string): string {
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<p>${esc(intro)}</p><table cellpadding="4">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td><strong>${esc(v)}</strong></td></tr>`).join('')}</table>
<p><a href="${esc(link)}">${esc(linkText)}</a></p><p>${esc(note)}</p><p style="color:#666;font-size:12px">${esc(footer)}</p>`;
}
