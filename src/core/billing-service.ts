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
  type LegalSettings,
  type PaymentMethod,
  type Receipt,
  type VatInvoiceDetails,
  type VatSettings,
} from './billing';
import { MICROS_PER_CENT, type D1BillingStore, type WorkspaceRecord } from './billing-store';
import { receiptPdf, type DocumentFonts } from './billing-documents';
import { captureFromEvent, PayPalError, type PayPalCapture, type PayPalClient } from './paypal';
import { getMode, type ProviderMode } from './provider-modes';
import { INVOICE_LOOKUP_URL } from './einvoice-viettel';
import type { FreeTierConfig } from './self-serve-workspaces';

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
  /** Hook for the Bookkeeper service, which will later take over rendering and sharing receipts. */
  onReceiptIssued?: (receipt: Receipt) => Promise<void>;
  now?: () => number;
};

export const SETTINGS = { account: 'worldfirst_account', legal: 'legal', vat: 'vat', exchangeRate: 'einvoice_exchange_rate' } as const;

/** VND per USD for e-invoices in USD (Vietnamese law wants the rate on the invoice); set on the admin host. */
export type ExchangeRateSetting = { vndPerUsd: number; date: string };

export type Admission = { mode: 'free' | 'paid' } | { refusal: { status: number; code: string; message: string } };

export const ADD_CREDIT_URL = 'https://dash.valefront.com/billing';

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

  /** PayPal as it is now: its mode (admin setting) and, for that mode, a client (null: secrets missing). */
  async paypalNow(): Promise<{ mode: ProviderMode; client: PayPalClient | null }> {
    const mode = await getMode(this.store, 'paypal');
    return { mode, client: this.opts.paypal?.(mode) ?? null };
  }

  /**
   * The ways this workspace can pay. PayPal in sandbox mode is only for the owner's workspaces: anyone can make a
   * PayPal sandbox account, and sandbox payments add (test) credit.
   */
  async methods(ws?: WorkspaceRecord): Promise<{ worldfirst: boolean; paypal: { enabled: boolean; env: ProviderMode | null }; sepay: false }> {
    const { mode, client } = await this.paypalNow();
    const allowed = Boolean(client) && (mode === 'live' || (ws ? Boolean(this.opts.isAdminWorkspace?.(ws)) : true));
    return { worldfirst: Boolean(await this.account()), paypal: { enabled: allowed, env: client ? mode : null }, sepay: false };
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
    } else {
      throw new BillingError('method_unavailable', `${METHOD_LABELS[input.method] ?? 'This method'} is not available yet.`, 409);
    }
    const { vatRateBp, vatCents, totalCents } = vatFor(input.amountCents, buyer.country, await this.vat());
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
      reference: createPaymentReference(),
      status: 'pending',
      buyer,
      einvoiceRequest,
      account,
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

  /**
   * Marks an order paid: credit on the ledger, invoice and receipt issued, PDFs made, email sent: each exactly once,
   * however often this runs. `by` is the admin (WorldFirst) or the PayPal path.
   */
  async markPaid(orderId: string, input: { by: string; captureId?: string | null }): Promise<{ transitioned: boolean; order: BillingOrder }> {
    const order = await this.store.order(orderId);
    if (!order) throw new BillingError('order_not_found', 'Order not found.', 404);
    if (order.status === 'cancelled') throw new BillingError('order_cancelled', 'This order was cancelled.', 409);
    const { transitioned } = await this.store.markPaid(orderId, { at: this.now(), by: input.by, captureId: input.captureId ?? null, seller: await this.seller() });
    if (transitioned) {
      console.log(JSON.stringify({ event: 'billing_paid', orderId, method: order.method, amountCents: order.amountCents, by: input.by }));
      await this.store.audit({ type: 'billing.paid', workspaceId: order.workspaceId, meta: { orderId, by: input.by } });
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
    try {
      const pdf = await this.pdf('einvoice', e.id);
      if (!pdf) throw new Error('no e-invoice PDF');
      const base = this.opts.dashboardUrl.replace(/\/+$/, '');
      const rows: Array<[string, string]> = [
        ['Số hóa đơn / Invoice no.', e.record.invoiceNo],
        ...(e.record.codeOfTax ? [['Mã cơ quan thuế / Tax authority code', e.record.codeOfTax] as [string, string]] : []),
        ...(e.record.reservationCode ? [['Mã tra cứu / Lookup code', e.record.reservationCode] as [string, string], ['Tra cứu tại / Look it up at', INVOICE_LOOKUP_URL] as [string, string]] : []),
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
          `Billing: ${base}/billing`, '', 'The e-invoice (PDF from Viettel S-Invoice) is attached.', '', footer].join('\n'),
        html: emailHtml('Hóa đơn GTGT điện tử của bạn đã được phát hành. Your Vietnamese VAT e-invoice has been issued.', rows, `${base}/billing`, 'Billing', 'The e-invoice (PDF from Viettel S-Invoice) is attached.', footer),
        attachments: [{ filename: `${e.record.invoiceNo.replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`, content: toArrayBuffer(pdf), type: 'application/pdf', disposition: 'attachment' }],
      });
      await this.store.setEinvoiceEmailStatus(e.id, 'sent');
    } catch (err) {
      // Back to unsent: the next retry run sends it.
      await this.store.setEinvoiceEmailStatus(e.id, null);
      console.error('[billing] e-invoice email failed', e.id, err instanceof Error ? err.message : err);
    }
  }

  // ── credit gate ───────────────────────────────────────────────────────────────────────────────────────

  isFreeModel(model: string): boolean {
    return this.opts.free.models.some((m) => m.toLowerCase() === model.toLowerCase());
  }

  /**
   * May this workspace make a request for `model` (already resolved from aliases; '' or 'auto' when the router
   * picks)? Free tokens cover the free-tier models while the grant lasts; everything else needs a balance above 0.
   */
  async admit(ws: WorkspaceRecord, model: string): Promise<Admission> {
    if (ws.deletedAt) return { refusal: { status: 401, code: 'key_revoked', message: 'This API key has been revoked.' } };
    if (ws.suspendedAt) return { refusal: { status: 403, code: 'workspace_or_key_suspended', message: 'This workspace or API key is suspended.' } };
    const now = this.now();
    const [balance, grant] = await Promise.all([this.store.balance(ws.id), this.store.grant(ws.id)]);
    const paid = balance.availableMicros > 0;
    const routerPicks = !model || model === 'auto' || model === 'auto-vision';
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
      return { mode: 'free' };
    }
    if (paid) return { mode: 'paid' };
    const why = freeLeft ? `Free tokens cover only ${this.opts.free.models.join(', ')}.` : grant ? 'Your free tokens are used up or expired.' : 'Your balance is $0.00.';
    return { refusal: { status: 402, code: 'insufficient_credit', message: `${why} Add credit at ${ADD_CREDIT_URL}` } };
  }

  /**
   * After a request: free tokens first (for a free-tier model, while the grant lasts), the rest from the balance.
   * usd is null when the model has no real price: nothing is charged (and it's logged), never the default price.
   */
  async charge(ws: WorkspaceRecord, input: { model: string; tokens: number; usd: number | null }): Promise<void> {
    const tokens = Math.max(0, Math.round(input.tokens));
    let payable = 1;
    if (this.isFreeModel(input.model) && tokens > 0) {
      const grant = await this.store.grant(ws.id);
      const now = this.now();
      if (grant && now < grant.expiresAt && grant.usedTokens < grant.tokens) {
        const free = Math.min(tokens, grant.tokens - grant.usedTokens);
        await this.store.addFreeUsage(ws.id, new Date(now).toISOString().slice(0, 10), free);
        payable = (tokens - free) / tokens;
      }
    }
    if (payable <= 0) return;
    if (input.usd === null) {
      console.log(JSON.stringify({ event: 'unpriced_customer_usage', workspaceId: ws.id, model: input.model, tokens }));
      return;
    }
    await this.store.chargeUsage(ws.id, Math.ceil(input.usd * payable * 1_000_000));
  }

  /** What the Billing page shows. */
  async overview(ws: WorkspaceRecord) {
    const [balance, ledger, orders, receipts, einvoices, profile, grant, methods, vat] = await Promise.all([
      this.store.balance(ws.id), this.store.ledger(ws.id, 200), this.store.orders(ws.id), this.store.receipts(ws.id), this.store.einvoices(ws.id),
      this.store.profile(ws.id), this.store.grant(ws.id), this.methods(ws), this.vat(),
    ]);
    return {
      balanceCents: balance.cents,
      pendingUsageCents: balance.pendingMicros / MICROS_PER_CENT,
      availableCents: Math.floor(balance.availableMicros / MICROS_PER_CENT),
      currency: CURRENCY,
      minimumCents: 1000,
      ledger,
      orders: orders.map(({ buyer: _b, account: _a, ...o }) => ({ ...o, vatInvoice: Boolean(o.einvoiceRequest), einvoiceRequest: undefined })),
      receipts: receipts.map((r) => ({ id: r.id, orderId: r.orderId, mode: r.mode, number: r.number, issuedAt: r.issuedAt, totalCents: r.totalCents, amountCents: r.amountCents, emailStatus: r.emailStatus ?? null })),
      einvoices: einvoices.map((e) => ({
        id: e.id, orderId: e.orderId, mode: e.mode, status: e.status === 'issuing' || e.status === 'failed' ? 'pending' : e.status, invoiceNo: e.record?.invoiceNo ?? null,
        codeOfTax: e.record?.codeOfTax ?? null, reservationCode: e.record?.reservationCode ?? null, issuedAt: e.issuedAt ?? null, totalCents: e.totalCents, email: e.details.email,
      })),
      profile,
      free: grant ? { tokens: grant.tokens, usedTokens: grant.usedTokens, expiresAt: grant.expiresAt, models: this.opts.free.models } : null,
      methods,
      vat,
    };
  }
}

function emailHtml(intro: string, rows: Array<[string, string]>, link: string, linkText: string, note: string, footer: string): string {
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<p>${esc(intro)}</p><table cellpadding="4">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td><strong>${esc(v)}</strong></td></tr>`).join('')}</table>
<p><a href="${esc(link)}">${esc(linkText)}</a></p><p>${esc(note)}</p><p style="color:#666;font-size:12px">${esc(footer)}</p>`;
}
