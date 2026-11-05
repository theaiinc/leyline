import { createHash, timingSafeEqual } from 'crypto';
import type { VndBankAccount } from './billing';

/**
 * SePay (sepay.vn), the "bank account + transaction API" product: Valefront's Vietnamese bank account is linked to
 * SePay, a customer scans a VietQR for the exact VND amount with the order reference as the transfer content, and
 * SePay sees the incoming transaction. We hear about it two ways, both handled by BillingService.applySepay:
 *
 * - SePay's webhook (POST /webhooks/sepay), authenticated with `Authorization: Apikey <SEPAY_WEBHOOK_KEY>`.
 * - Polling SePay's user API (GET https://my.sepay.vn/userapi/transactions/list, `Authorization: Bearer
 *   <SEPAY_API_TOKEN>`): the 15-minute cron and the customer's "I've paid, check now" button.
 *
 * Env (Worker secrets/vars; none is ever logged or sent to the browser except the account shown for the transfer):
 *   SEPAY_API_TOKEN       user API token (my.sepay.vn > Cấu hình công ty > API Access)
 *   SEPAY_BANK_ACCOUNT    the receiving account number (else the first account on the SePay company, via the API)
 *   SEPAY_BANK_BIN | SEPAY_BANK_CODE   VietQR bank id, e.g. 970436 or VCB (else from the API)
 *   SEPAY_BANK_NAME       shown to the customer (else the API's bank_short_name, else the bank id)
 *   SEPAY_ACCOUNT_NAME    account holder, shown to the customer (else the API's account_holder_name)
 *   SEPAY_WEBHOOK_KEY     the API key set on SePay's webhook
 *
 * Field names are from SePay's docs (docs.sepay.vn: tich-hop-webhooks.html, api-giao-dich.html,
 * api-tai-khoan-ngan-hang.html, read 2026-11-06). They are mapped in one place each: transactionFromWebhook,
 * transactionFromApi, accountFromApi.
 */

export const SEPAY_API_BASE = 'https://my.sepay.vn/userapi';
export const SEPAY_QR_BASE = 'https://qr.sepay.vn/img';

export type SePayConfig = {
  apiToken?: string;
  accountNumber?: string;
  bankId?: string;
  bankName?: string;
  accountName?: string;
  webhookKey?: string;
  base?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/** An incoming or outgoing transaction on the linked account, in whole VND. */
export type SePayTransaction = {
  /** SePay's transaction id: what makes a payment unique. */
  id: string;
  accountNumber: string;
  direction: 'in' | 'out';
  amountVnd: number;
  content: string;
  referenceCode: string | null;
  transactionDate: string | null;
  gateway: string | null;
};

export function sepayConfigFromEnv(env: Record<string, string | undefined>, fetchImpl?: typeof fetch): SePayConfig | null {
  const v = (name: string) => env[name]?.trim() || undefined;
  const cfg: SePayConfig = {
    apiToken: v('SEPAY_API_TOKEN'),
    accountNumber: v('SEPAY_BANK_ACCOUNT'),
    bankId: v('SEPAY_BANK_BIN') ?? v('SEPAY_BANK_CODE'),
    bankName: v('SEPAY_BANK_NAME'),
    accountName: v('SEPAY_ACCOUNT_NAME'),
    webhookKey: v('SEPAY_WEBHOOK_KEY'),
    ...(fetchImpl ? { fetchImpl } : {}),
  };
  return cfg.apiToken || cfg.accountNumber || cfg.webhookKey ? cfg : null;
}

/** A whole, non-negative VND amount from SePay (a number, or a string like "2277000.00"); null otherwise. */
export function vndAmount(value: unknown): number | null {
  const s = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().replace(/,/g, '') : '';
  const m = /^(\d{1,15})(?:\.(0+))?$/.exec(s);
  return m ? Number(m[1]) : null;
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

/** SePay's webhook body -> a transaction; null when it isn't one (missing id, type or amount). */
export function transactionFromWebhook(body: unknown): SePayTransaction | null {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const id = text(b.id);
  const type = text(b.transferType);
  const amount = vndAmount(b.transferAmount);
  if (!id || (type !== 'in' && type !== 'out') || amount === null) return null;
  return {
    id, direction: type, amountVnd: amount,
    accountNumber: text(b.accountNumber) ?? '',
    content: text(b.content) ?? text(b.description) ?? '',
    referenceCode: text(b.referenceCode),
    transactionDate: text(b.transactionDate),
    gateway: text(b.gateway),
  };
}

/** One row of GET /transactions/list -> a transaction (amount_in > 0: incoming; amount_out > 0: outgoing). */
export function transactionFromApi(row: unknown): SePayTransaction | null {
  const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  const id = text(r.id);
  const amountIn = vndAmount(r.amount_in ?? 0);
  const amountOut = vndAmount(r.amount_out ?? 0);
  if (!id || amountIn === null || amountOut === null) return null;
  const incoming = amountIn > 0;
  return {
    id, direction: incoming ? 'in' : 'out', amountVnd: incoming ? amountIn : amountOut,
    accountNumber: text(r.account_number) ?? '',
    content: text(r.transaction_content) ?? '',
    referenceCode: text(r.reference_number),
    transactionDate: text(r.transaction_date),
    gateway: text(r.bank_brand_name),
  };
}

/** One row of GET /bankaccounts/list -> the account to receive into. */
export function accountFromApi(row: unknown): Partial<VndBankAccount> {
  const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  return {
    accountNumber: text(r.account_number) ?? undefined,
    bankId: text(r.bank_bin) ?? text(r.bank_code) ?? undefined,
    bankName: text(r.bank_short_name) ?? text(r.bank_full_name) ?? undefined,
    accountName: text(r.account_holder_name) ?? undefined,
  };
}

/** The order reference as a transfer content: letters and digits only (VF-7KQ2MA… -> VF7KQ2MA…). */
export function transferContentFor(reference: string): string {
  return reference.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Order references a transfer content may carry, as stored (VF-XXXXXXXXXX). Case, spaces, dashes and other symbols
 * are ignored (banks and people add and drop them), and the letters people confuse with Crockford digits are read as
 * those digits (O -> 0, I/L -> 1). Every "VF" is a candidate start, so text glued on either side doesn't hide it.
 */
export function referencesIn(content: string): string[] {
  const flat = content.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const out: string[] = [];
  for (let i = flat.indexOf('VF'); i >= 0 && out.length < 10; i = flat.indexOf('VF', i + 1)) {
    const body = flat.slice(i + 2, i + 12);
    if (body.length < 10) break;
    const ref = `VF-${body.replace(/O/g, '0').replace(/[IL]/g, '1')}`;
    if (/^VF-[0-9A-HJKMNP-TV-Z]{10}$/.test(ref) && !out.includes(ref)) out.push(ref);
  }
  return out;
}

export class SePayError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

export class SePayClient {
  readonly method = 'sepay' as const;
  private readonly fetchImpl: typeof fetch;
  private resolved: { account: VndBankAccount | null; until: number } | null = null;
  private recent: { at: number; list: SePayTransaction[] } | null = null;
  private readonly now: () => number;

  constructor(private readonly cfg: SePayConfig) {
    // Through a wrapper: Workers throws "Illegal invocation" for a bare fetch called as a method.
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = cfg.now ?? Date.now;
  }

  get base(): string {
    return (this.cfg.base ?? SEPAY_API_BASE).replace(/\/+$/, '');
  }

  /** What the admin page shows (never a secret's value). */
  get status(): { apiToken: boolean; webhookKey: boolean; accountFromEnv: boolean } {
    return { apiToken: Boolean(this.cfg.apiToken), webhookKey: Boolean(this.cfg.webhookKey), accountFromEnv: Boolean(this.cfg.accountNumber && this.cfg.bankId) };
  }

  /** Payments can be confirmed: by webhook (key set) or by polling (token set). */
  get canConfirm(): boolean {
    return Boolean(this.cfg.webhookKey || this.cfg.apiToken);
  }

  private async get(path: string): Promise<Record<string, unknown>> {
    if (!this.cfg.apiToken) throw new SePayError('SePay API token is not set', 503);
    const res = await this.fetchImpl(`${this.base}${path}`, { headers: { Authorization: `Bearer ${this.cfg.apiToken}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new SePayError(`SePay API ${path.split('?')[0]} failed (${res.status})`);
    return (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }

  /**
   * The account customers pay into: from env when SEPAY_BANK_ACCOUNT and the bank id are set (the API fills in a
   * missing name), else the matching (or first) account on the SePay company. Cached; a failed lookup is retried
   * after 5 minutes. null: SePay can't be offered.
   */
  async account(): Promise<VndBankAccount | null> {
    const now = this.now();
    if (this.resolved && now < this.resolved.until) return this.resolved.account;
    const env: Partial<VndBankAccount> = { accountNumber: this.cfg.accountNumber, bankId: this.cfg.bankId, bankName: this.cfg.bankName, accountName: this.cfg.accountName };
    let api: Partial<VndBankAccount> = {};
    const complete = env.accountNumber && env.bankId && env.accountName;
    if (!complete && this.cfg.apiToken) {
      try {
        const body = await this.get('/bankaccounts/list');
        const rows = (Array.isArray(body.bankaccounts) ? body.bankaccounts : []).map(accountFromApi);
        api = (env.accountNumber ? rows.find((r) => r.accountNumber === env.accountNumber) : rows[0]) ?? {};
      } catch (err) {
        console.error('[sepay] bank account lookup failed', err instanceof Error ? err.message : err);
      }
    }
    const accountNumber = env.accountNumber ?? api.accountNumber;
    const bankId = env.bankId ?? api.bankId;
    const account = accountNumber && bankId
      ? { accountNumber, bankId, bankName: env.bankName ?? api.bankName ?? bankId, accountName: env.accountName ?? api.accountName ?? '' }
      : null;
    this.resolved = { account, until: account ? Number.POSITIVE_INFINITY : now + 5 * 60_000 };
    return account;
  }

  /** The VietQR image for an exact amount and content (qr.sepay.vn renders it; the app opens with it filled in). */
  qrUrl(account: VndBankAccount, amountVnd: number, content: string): string {
    const q = new URLSearchParams({ acc: account.accountNumber, bank: account.bankId, amount: String(amountVnd), des: content });
    return `${SEPAY_QR_BASE}?${q.toString()}`;
  }

  /** Whether a webhook carries our key: `Authorization: Apikey <key>`, compared in constant time. */
  verifyWebhook(authorization: string | string[] | undefined): boolean {
    const key = this.cfg.webhookKey;
    const header = Array.isArray(authorization) ? authorization[0] : authorization;
    if (!key || !header) return false;
    const m = /^\s*Apikey\s+(.+?)\s*$/i.exec(header);
    if (!m) return false;
    const a = createHash('sha256').update(m[1]!).digest();
    const b = createHash('sha256').update(key).digest();
    return timingSafeEqual(a, b);
  }

  /**
   * The latest transactions on our account (newest first). Shared by every caller for a few seconds, so many
   * customers pressing "check now" make one SePay call (its API allows about 2 a second).
   */
  async recentTransactions(limit = 50): Promise<SePayTransaction[]> {
    if (this.recent && this.now() - this.recent.at < 5_000) return this.recent.list;
    const account = await this.account();
    if (!account) throw new SePayError('SePay has no bank account to read', 503);
    const body = await this.get(`/transactions/list?account_number=${encodeURIComponent(account.accountNumber)}&limit=${limit}`);
    const list = (Array.isArray(body.transactions) ? body.transactions : []).map(transactionFromApi).filter((t): t is SePayTransaction => Boolean(t));
    this.recent = { at: this.now(), list };
    return list;
  }
}
