import { randomUUID } from 'crypto';
import type { D1Database, D1PreparedStatement, D1Result } from './d1-stores';
import {
  vietnamDate,
  type BillingAccount,
  type BillingOrder,
  type BuyerProfile,
  type EInvoice,
  type EInvoiceRecord,
  type EInvoiceStatus,
  type LedgerEntry,
  type LegalSettings,
  type PaymentMethod,
  type Receipt,
  type VatInvoiceDetails,
  type VndQuote,
} from './billing';

/**
 * D1 storage for self-serve workspaces and billing (worker/migrations/0002_workspaces_billing.sql). Every write that
 * moves money is one D1 batch (a transaction), guarded so that running it twice changes nothing: the ledger's
 * source_key, an order's status transition, and UNIQUE order ids on invoices and receipts.
 */
export interface D1BatchDatabase extends D1Database {
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export type WorkspaceRecord = {
  id: string;
  ownerSub: string;
  email: string;
  emailHash: string;
  name?: string | null;
  termsVersion: string;
  termsAcceptedAt: number;
  createdAt: number;
  suspendedAt?: number | null;
  deletedAt?: number | null;
};

export type FreeGrant = {
  workspaceId: string;
  tokens: number;
  usedTokens: number;
  grantedAt: number;
  expiresAt: number;
};

export type AuditEvent = { type: string; workspaceId?: string | null; ipHash?: string | null; meta?: Record<string, unknown> };

/** Usage is accrued in millionths of a dollar and moved to the ledger in whole cents. */
export const MICROS_PER_CENT = 10_000;

type Row = Record<string, unknown>;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

function workspaceFrom(r: Row): WorkspaceRecord {
  return {
    id: String(r.id), ownerSub: String(r.owner_sub), email: String(r.email), emailHash: String(r.email_hash), name: str(r.name),
    termsVersion: String(r.terms_version), termsAcceptedAt: Number(r.terms_accepted_at), createdAt: Number(r.created_at),
    suspendedAt: num(r.suspended_at), deletedAt: num(r.deleted_at),
  };
}

function orderFrom(r: Row): BillingOrder {
  return {
    id: String(r.id), workspaceId: String(r.workspace_id), method: String(r.method) as PaymentMethod, mode: String(r.mode) === 'sandbox' ? 'sandbox' : 'live',
    amountCents: Number(r.amount_cents), vatRateBp: Number(r.vat_rate_bp), vatCents: Number(r.vat_cents), totalCents: Number(r.total_cents),
    currency: 'USD', reference: String(r.reference), status: String(r.status) as BillingOrder['status'],
    buyer: JSON.parse(String(r.buyer)) as BuyerProfile, einvoiceRequest: r.einvoice_request ? (JSON.parse(String(r.einvoice_request)) as VatInvoiceDetails) : null,
    account: r.account ? (JSON.parse(String(r.account)) as BillingAccount) : null,
    quote: r.quote ? (JSON.parse(String(r.quote)) as VndQuote) : null, paymentNote: str(r.payment_note),
    providerOrderId: str(r.provider_order_id), providerCaptureId: str(r.provider_capture_id),
    createdAt: Number(r.created_at), paidAt: num(r.paid_at), paidBy: str(r.paid_by),
  };
}

function receiptFrom(r: Row): Receipt {
  return {
    id: String(r.id), orderId: String(r.order_id), workspaceId: String(r.workspace_id), mode: String(r.mode) === 'sandbox' ? 'sandbox' : 'live', number: String(r.number), issuedAt: Number(r.issued_at),
    seller: JSON.parse(String(r.seller)) as LegalSettings, buyer: JSON.parse(String(r.buyer)) as BuyerProfile,
    amountCents: Number(r.amount_cents), vatRateBp: Number(r.vat_rate_bp), vatCents: Number(r.vat_cents), totalCents: Number(r.total_cents),
    currency: 'USD', method: String(r.method) as PaymentMethod, reference: String(r.reference), providerReference: str(r.provider_reference),
    emailStatus: (str(r.email_status) as Receipt['emailStatus']) ?? null, emailAt: num(r.email_at),
  };
}

function einvoiceFrom(r: Row): EInvoice {
  return {
    id: String(r.id), orderId: String(r.order_id), receiptId: String(r.receipt_id), workspaceId: String(r.workspace_id), mode: String(r.mode) === 'sandbox' ? 'sandbox' : 'live', status: String(r.status) as EInvoiceStatus,
    details: JSON.parse(String(r.details)) as VatInvoiceDetails, amountCents: Number(r.amount_cents), vatRateBp: Number(r.vat_rate_bp), vatCents: Number(r.vat_cents),
    totalCents: Number(r.total_cents), currency: 'USD', paidAt: Number(r.paid_at), attempts: Number(r.attempts), lastError: str(r.last_error),
    record: r.record ? (JSON.parse(String(r.record)) as EInvoiceRecord) : null, issuedAt: num(r.issued_at),
    emailStatus: (str(r.email_status) as EInvoice['emailStatus']) ?? null, createdAt: Number(r.created_at),
  };
}

function ledgerFrom(r: Row): LedgerEntry {
  return {
    id: String(r.id), workspaceId: String(r.workspace_id), amountCents: Number(r.amount_cents), kind: String(r.kind) as LedgerEntry['kind'],
    description: String(r.description), orderId: str(r.order_id), createdAt: Number(r.created_at),
  };
}

/** One SePay transaction as stored (sepay_transactions). */
export type SepayTransactionRow = {
  id: string;
  source: 'webhook' | 'poll';
  accountNumber: string;
  direction: 'in' | 'out';
  amountVnd: number;
  content: string;
  referenceCode?: string | null;
  transactionDate?: string | null;
  gateway?: string | null;
  orderId?: string | null;
  outcome?: string | null;
  receivedAt: number;
};

function sepayFrom(r: Row): SepayTransactionRow {
  return {
    id: String(r.id), source: String(r.source) === 'poll' ? 'poll' : 'webhook', accountNumber: String(r.account_number), direction: String(r.direction) === 'out' ? 'out' : 'in',
    amountVnd: Number(r.amount_vnd), content: String(r.content), referenceCode: str(r.reference_code), transactionDate: str(r.transaction_date), gateway: str(r.gateway),
    orderId: str(r.order_id), outcome: str(r.outcome), receivedAt: Number(r.received_at),
  };
}

/** After this long an e-invoice still "issuing" is taken to have timed out (Viettel: wait at least 90 s). */
export const EINVOICE_ISSUING_STALE_MS = 5 * 60_000;
/** Attempts after which a pending e-invoice is marked failed for an admin to look at (still retried by hand). */
export const EINVOICE_MAX_ATTEMPTS = 30;

export class D1BillingStore {
  constructor(private readonly db: D1BatchDatabase, private readonly now: () => number = Date.now) {}

  private async first<T>(sql: string, ...args: unknown[]): Promise<T | null> {
    return (await this.db.prepare(sql).bind(...args).first<T>()) ?? null;
  }

  private async all<T>(sql: string, ...args: unknown[]): Promise<T[]> {
    return (await this.db.prepare(sql).bind(...args).all<T>()).results ?? [];
  }

  // ── workspaces ────────────────────────────────────────────────────────────────────────────────────────

  async workspace(id: string): Promise<WorkspaceRecord | null> {
    const r = await this.first<Row>('SELECT * FROM workspaces WHERE id = ?', id);
    return r ? workspaceFrom(r) : null;
  }

  async workspaceBySub(sub: string): Promise<WorkspaceRecord | null> {
    const r = await this.first<Row>('SELECT * FROM workspaces WHERE owner_sub = ? AND deleted_at IS NULL', sub);
    return r ? workspaceFrom(r) : null;
  }

  /** Whether a free grant was ever given to this email or Aegis account (hashes). */
  async grantUsed(emailHash: string, subHash: string): Promise<boolean> {
    return Boolean(await this.first('SELECT 1 AS x FROM free_grants WHERE email_hash = ? OR sub_hash = ?', emailHash, subHash));
  }

  async countSignups(ipHash: string, since: number): Promise<number> {
    const r = await this.first<{ n: number }>("SELECT count(*) AS n FROM audit_events WHERE type = 'workspace.signup' AND ip_hash = ? AND at >= ?", ipHash, since);
    return Number(r?.n ?? 0);
  }

  /**
   * Creates the workspace, and its free grant when `grant` is given and neither identity had one. Returns whether the
   * grant was given. Throws 'workspace_exists' when the account already has a workspace.
   */
  async createWorkspace(ws: WorkspaceRecord, grant: { emailHash: string; subHash: string; tokens: number; expiresAt: number } | null, audit: AuditEvent): Promise<{ granted: boolean }> {
    const statements = [
      this.db.prepare('INSERT INTO workspaces (id, owner_sub, email, email_hash, name, terms_version, terms_accepted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_sub) DO NOTHING')
        .bind(ws.id, ws.ownerSub, ws.email, ws.emailHash, ws.name ?? null, ws.termsVersion, ws.termsAcceptedAt, ws.createdAt),
      ...(grant ? [this.db.prepare('INSERT OR IGNORE INTO free_grants (workspace_id, email_hash, sub_hash, tokens, used_tokens, granted_at, expires_at) SELECT ?, ?, ?, ?, 0, ?, ? WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ?)')
        .bind(ws.id, grant.emailHash, grant.subHash, grant.tokens, ws.createdAt, grant.expiresAt, ws.id)] : []),
    ];
    const results = await this.db.batch(statements);
    if (!results[0]?.meta.changes) throw new Error('workspace_exists');
    await this.auditStatement({ ...audit, workspaceId: ws.id }, ws.createdAt).run();
    return { granted: Boolean(grant && results[1]?.meta.changes) };
  }

  async setSuspended(id: string, suspended: boolean): Promise<void> {
    await this.db.prepare('UPDATE workspaces SET suspended_at = ? WHERE id = ?').bind(suspended ? this.now() : null, id).run();
  }

  /**
   * Deletes a workspace's personal data. Its ledger, orders, invoices and receipts stay (accounting records, kept 10
   * years); the free-grant hashes stay so the same person can't claim another grant.
   */
  async deleteWorkspace(id: string): Promise<void> {
    const at = this.now();
    await this.db.batch([
      this.db.prepare("UPDATE workspaces SET email = '', name = NULL, owner_sub = 'deleted:' || id, deleted_at = ? WHERE id = ? AND deleted_at IS NULL").bind(at, id),
      this.db.prepare('DELETE FROM billing_profiles WHERE workspace_id = ?').bind(id),
      this.db.prepare('DELETE FROM free_usage_days WHERE workspace_id = ?').bind(id),
      this.db.prepare("DELETE FROM audit_events WHERE workspace_id = ? AND type <> 'workspace.deleted'").bind(id),
      this.auditStatement({ type: 'workspace.deleted', workspaceId: id }, at),
    ]);
  }

  private auditStatement(e: AuditEvent, at: number): D1PreparedStatement {
    return this.db.prepare('INSERT INTO audit_events (id, workspace_id, type, at, ip_hash, meta) VALUES (?, ?, ?, ?, ?, ?)').bind(randomUUID(), e.workspaceId ?? null, e.type, at, e.ipHash ?? null, e.meta ? JSON.stringify(e.meta) : null);
  }

  async audit(e: AuditEvent): Promise<void> {
    await this.auditStatement(e, this.now()).run();
  }

  async auditEvents(workspaceId: string): Promise<Array<{ type: string; at: number; meta: unknown }>> {
    const rows = await this.all<Row>('SELECT type, at, meta FROM audit_events WHERE workspace_id = ? ORDER BY at', workspaceId);
    return rows.map((r) => ({ type: String(r.type), at: Number(r.at), meta: r.meta ? JSON.parse(String(r.meta)) : null }));
  }

  // ── free tier ─────────────────────────────────────────────────────────────────────────────────────────

  async grant(workspaceId: string): Promise<FreeGrant | null> {
    const r = await this.first<Row>('SELECT * FROM free_grants WHERE workspace_id = ?', workspaceId);
    return r ? { workspaceId, tokens: Number(r.tokens), usedTokens: Number(r.used_tokens), grantedAt: Number(r.granted_at), expiresAt: Number(r.expires_at) } : null;
  }

  /**
   * The first paid top-up unlocks the bonus free tokens: once (a grant already at base + bonus or more is left
   * alone), and the grant runs at least `days` more days from now, so a late top-up still has time to use them.
   */
  async unlockFreeBonus(workspaceId: string, input: { baseTokens: number; bonusTokens: number; now: number; days: number }): Promise<boolean> {
    if (input.bonusTokens <= 0) return false;
    const r = await this.db.prepare('UPDATE free_grants SET tokens = tokens + ?, expires_at = MAX(expires_at, ?) WHERE workspace_id = ? AND tokens < ?')
      .bind(input.bonusTokens, input.now + input.days * 86_400_000, workspaceId, input.baseTokens + input.bonusTokens).run();
    return Boolean(r.meta?.changes);
  }

  async freeTokensOn(workspaceId: string, day: string): Promise<{ workspace: number; global: number }> {
    const [w, g] = await Promise.all([
      this.first<{ tokens: number }>('SELECT tokens FROM free_usage_days WHERE workspace_id = ? AND day = ?', workspaceId, day),
      this.first<{ tokens: number }>('SELECT tokens FROM free_budget_days WHERE day = ?', day),
    ]);
    return { workspace: Number(w?.tokens ?? 0), global: Number(g?.tokens ?? 0) };
  }

  async addFreeUsage(workspaceId: string, day: string, tokens: number): Promise<void> {
    const t = Math.max(0, Math.round(tokens));
    if (!t) return;
    await this.db.batch([
      this.db.prepare('UPDATE free_grants SET used_tokens = used_tokens + ? WHERE workspace_id = ?').bind(t, workspaceId),
      this.db.prepare('INSERT INTO free_usage_days (workspace_id, day, tokens) VALUES (?, ?, ?) ON CONFLICT(workspace_id, day) DO UPDATE SET tokens = tokens + excluded.tokens').bind(workspaceId, day, t),
      this.db.prepare('INSERT INTO free_budget_days (day, tokens) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET tokens = tokens + excluded.tokens').bind(day, t),
    ]);
  }

  // ── billing profile and settings ──────────────────────────────────────────────────────────────────────

  async profile(workspaceId: string): Promise<BuyerProfile | null> {
    const r = await this.first<{ profile: string }>('SELECT profile FROM billing_profiles WHERE workspace_id = ?', workspaceId);
    return r ? (JSON.parse(r.profile) as BuyerProfile) : null;
  }

  async saveProfile(workspaceId: string, profile: BuyerProfile): Promise<void> {
    await this.db.prepare('INSERT INTO billing_profiles (workspace_id, profile, updated_at) VALUES (?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at')
      .bind(workspaceId, JSON.stringify(profile), this.now()).run();
  }

  async setting<T>(key: string): Promise<{ value: T; updatedAt: number; updatedBy: string } | null> {
    const r = await this.first<Row>('SELECT value, updated_at, updated_by FROM billing_settings WHERE key = ?', key);
    return r ? { value: JSON.parse(String(r.value)) as T, updatedAt: Number(r.updated_at), updatedBy: String(r.updated_by) } : null;
  }

  async saveSetting(key: string, value: unknown, by: string): Promise<void> {
    await this.db.prepare('INSERT INTO billing_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
      .bind(key, JSON.stringify(value), this.now(), by).run();
  }

  // ── orders ────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Saves a new order, or returns the one this workspace already made with the same idempotency key (a double click
   * or a retried request makes one order, not two).
   */
  async createOrder(order: BillingOrder, idempotencyKey: string): Promise<{ order: BillingOrder; created: boolean }> {
    const r = await this.db.prepare(`INSERT INTO billing_orders (id, workspace_id, method, mode, amount_cents, vat_rate_bp, vat_cents, total_cents, currency, reference, status, idempotency_key, buyer, einvoice_request, account, quote, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, idempotency_key) DO NOTHING`)
      .bind(order.id, order.workspaceId, order.method, order.mode, order.amountCents, order.vatRateBp, order.vatCents, order.totalCents, order.currency, order.reference,
        idempotencyKey, JSON.stringify(order.buyer), order.einvoiceRequest ? JSON.stringify(order.einvoiceRequest) : null, order.account ? JSON.stringify(order.account) : null,
        order.quote ? JSON.stringify(order.quote) : null, order.createdAt).run();
    const saved = await this.first<Row>('SELECT * FROM billing_orders WHERE workspace_id = ? AND idempotency_key = ?', order.workspaceId, idempotencyKey);
    if (!saved) throw new Error('order not saved');
    return { order: orderFrom(saved), created: Boolean(r.meta.changes) };
  }

  async order(id: string): Promise<BillingOrder | null> {
    const r = await this.first<Row>('SELECT * FROM billing_orders WHERE id = ?', id);
    return r ? orderFrom(r) : null;
  }

  async orderByProviderOrderId(providerOrderId: string): Promise<BillingOrder | null> {
    const r = await this.first<Row>('SELECT * FROM billing_orders WHERE provider_order_id = ?', providerOrderId);
    return r ? orderFrom(r) : null;
  }

  async orderByIdempotencyKey(workspaceId: string, idempotencyKey: string): Promise<BillingOrder | null> {
    const r = await this.first<Row>('SELECT * FROM billing_orders WHERE workspace_id = ? AND idempotency_key = ?', workspaceId, idempotencyKey);
    return r ? orderFrom(r) : null;
  }

  async orderByReference(reference: string): Promise<BillingOrder | null> {
    const r = await this.first<Row>('SELECT * FROM billing_orders WHERE reference = ?', reference);
    return r ? orderFrom(r) : null;
  }

  async orders(workspaceId: string): Promise<BillingOrder[]> {
    return (await this.all<Row>('SELECT * FROM billing_orders WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200', workspaceId)).map(orderFrom);
  }

  async allOrders(status?: string, limit = 200): Promise<BillingOrder[]> {
    const rows = status
      ? await this.all<Row>('SELECT * FROM billing_orders WHERE status = ? ORDER BY created_at DESC LIMIT ?', status, limit)
      : await this.all<Row>('SELECT * FROM billing_orders ORDER BY created_at DESC LIMIT ?', limit);
    return rows.map(orderFrom);
  }

  /** Remembers the PayPal order made for this order (once: a second checkout reuses it). */
  async setProviderOrderId(id: string, providerOrderId: string): Promise<void> {
    await this.db.prepare('UPDATE billing_orders SET provider_order_id = ? WHERE id = ? AND provider_order_id IS NULL').bind(providerOrderId, id).run();
  }

  /** A new VND quote for a pending order (the last one expired). */
  async setQuote(id: string, quote: VndQuote): Promise<boolean> {
    const r = await this.db.prepare("UPDATE billing_orders SET quote = ? WHERE id = ? AND status = 'pending'").bind(JSON.stringify(quote), id).run();
    return Boolean(r.meta.changes);
  }

  /** Adds a line to an order's payment note (kept to the last 2000 characters). */
  async addPaymentNote(id: string, line: string): Promise<void> {
    await this.db.prepare("UPDATE billing_orders SET payment_note = substr(CASE WHEN payment_note IS NULL OR payment_note = '' THEN ? ELSE payment_note || char(10) || ? END, -2000) WHERE id = ?")
      .bind(line, line, id).run();
  }

  /** Pending orders of a method made since `since` (SePay polling). */
  async pendingOrders(method: PaymentMethod, since: number, limit = 100): Promise<BillingOrder[]> {
    return (await this.all<Row>("SELECT * FROM billing_orders WHERE method = ? AND status = 'pending' AND created_at >= ? ORDER BY created_at DESC LIMIT ?", method, since, limit)).map(orderFrom);
  }

  // ── SePay transactions ────────────────────────────────────────────────────────────────────────────────

  /**
   * Records a SePay transaction once per SePay id. Returns the stored row: `created` false when it was already
   * there (a webhook replay, or polling finding one the webhook already brought).
   */
  async recordSepayTransaction(tx: SepayTransactionRow): Promise<{ created: boolean; row: SepayTransactionRow }> {
    // The same bank transaction under another SePay id (should the webhook's and the API's ids ever differ): the bank's
    // reference code, account, direction and amount identify it, so it is never counted twice.
    if (tx.referenceCode) {
      const same = await this.first<Row>('SELECT * FROM sepay_transactions WHERE reference_code = ? AND account_number = ? AND direction = ? AND amount_vnd = ? AND id <> ?',
        tx.referenceCode, tx.accountNumber, tx.direction, tx.amountVnd, tx.id);
      if (same) return { created: false, row: sepayFrom(same) };
    }
    const r = await this.db.prepare(`INSERT OR IGNORE INTO sepay_transactions (id, source, account_number, direction, amount_vnd, content, reference_code, transaction_date, gateway, order_id, outcome, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`)
      .bind(tx.id, tx.source, tx.accountNumber, tx.direction, tx.amountVnd, tx.content.slice(0, 1000), tx.referenceCode ?? null, tx.transactionDate ?? null, tx.gateway ?? null, tx.receivedAt).run();
    return { created: Boolean(r.meta.changes), row: (await this.sepayTransaction(tx.id))! };
  }

  async sepayTransaction(id: string): Promise<SepayTransactionRow | null> {
    const r = await this.first<Row>('SELECT * FROM sepay_transactions WHERE id = ?', id);
    return r ? sepayFrom(r) : null;
  }

  async setSepayOutcome(id: string, orderId: string | null, outcome: string): Promise<void> {
    await this.db.prepare('UPDATE sepay_transactions SET order_id = ?, outcome = ? WHERE id = ?').bind(orderId, outcome, id).run();
  }

  /** VND received for an order: its matched incoming transactions that count toward paying it. */
  async sepayReceived(orderId: string): Promise<number> {
    const r = await this.first<{ vnd: number }>("SELECT COALESCE(SUM(amount_vnd), 0) AS vnd FROM sepay_transactions WHERE order_id = ? AND direction = 'in' AND outcome IN ('underpaid', 'credited')", orderId);
    return Number(r?.vnd ?? 0);
  }

  async sepayTransactionsFor(orderId: string): Promise<SepayTransactionRow[]> {
    return (await this.all<Row>('SELECT * FROM sepay_transactions WHERE order_id = ? ORDER BY received_at', orderId)).map(sepayFrom);
  }

  /** When SePay's webhook last reached us (any transaction), for the admin page. */
  async lastSepayWebhookAt(): Promise<number | null> {
    const r = await this.first<{ at: number | null }>("SELECT MAX(received_at) AS at FROM sepay_transactions WHERE source = 'webhook'");
    return r?.at === null || r?.at === undefined ? null : Number(r.at);
  }

  async cancelOrder(id: string, workspaceId: string): Promise<boolean> {
    const r = await this.db.prepare("UPDATE billing_orders SET status = 'cancelled' WHERE id = ? AND workspace_id = ? AND status = 'pending'").bind(id, workspaceId).run();
    return Boolean(r.meta.changes);
  }

  /**
   * Pending -> paid, in one transaction: the credit on the ledger, the receipt, and (when the buyer asked for one) a
   * pending VAT e-invoice. Running it again (a webhook replay, a double click on "Mark paid") changes nothing:
   * `transitioned` is false and no second credit, receipt or e-invoice is made. Receipt numbers are the next of the
   * year with no gaps.
   */
  async markPaid(orderId: string, input: { at: number; by: string; captureId?: string | null; seller: LegalSettings }): Promise<{ transitioned: boolean }> {
    const { year } = vietnamDate(input.at);
    // Real and sandbox receipts are numbered apart: a test payment never takes a real number.
    const nextReceipt = '(SELECT COALESCE(MAX(seq), 0) + 1 FROM receipts WHERE mode = o.mode AND year = ?)';
    const results = await this.db.batch([
      this.db.prepare("UPDATE billing_orders SET status = 'paid', paid_at = ?, paid_by = ?, provider_capture_id = COALESCE(?, provider_capture_id) WHERE id = ? AND status = 'pending'")
        .bind(input.at, input.by, input.captureId ?? null, orderId),
      this.db.prepare("INSERT OR IGNORE INTO ledger (id, workspace_id, amount_cents, kind, source_key, order_id, description, created_at) SELECT ?, workspace_id, amount_cents, 'payment', 'order:' || id, id, 'Prepaid credit ' || reference, ? FROM billing_orders WHERE id = ? AND status = 'paid'")
        .bind(`led_${randomUUID()}`, input.at, orderId),
      this.db.prepare(`INSERT OR IGNORE INTO receipts (id, order_id, workspace_id, mode, year, seq, number, issued_at, seller, buyer, amount_cents, vat_rate_bp, vat_cents, total_cents, currency, method, reference, provider_reference)
        SELECT ?, o.id, o.workspace_id, o.mode, ?, ${nextReceipt}, printf(CASE WHEN o.mode = 'sandbox' THEN 'VF-RCT-SANDBOX-%d-%06d' ELSE 'VF-RCT-%d-%06d' END, ?, ${nextReceipt}), ?, ?, o.buyer, o.amount_cents, o.vat_rate_bp, o.vat_cents, o.total_cents, o.currency, o.method, o.reference, o.provider_capture_id
        FROM billing_orders o WHERE o.id = ? AND o.status = 'paid' AND NOT EXISTS (SELECT 1 FROM receipts WHERE order_id = ?)`)
        .bind(`rct_${randomUUID()}`, year, year, year, year, input.at, JSON.stringify(input.seller), orderId, orderId),
      this.db.prepare(`INSERT OR IGNORE INTO einvoices (id, order_id, receipt_id, workspace_id, mode, status, details, amount_cents, vat_rate_bp, vat_cents, total_cents, currency, paid_at, created_at)
        SELECT ?, o.id, r.id, o.workspace_id, o.mode, 'pending', o.einvoice_request, o.amount_cents, o.vat_rate_bp, o.vat_cents, o.total_cents, o.currency, o.paid_at, ?
        FROM billing_orders o JOIN receipts r ON r.order_id = o.id WHERE o.id = ? AND o.status = 'paid' AND o.einvoice_request IS NOT NULL`)
        .bind(randomUUID(), input.at, orderId),
    ]);
    return { transitioned: Boolean(results[0]?.meta.changes) };
  }

  // ── ledger and usage ──────────────────────────────────────────────────────────────────────────────────

  /** The balance: the ledger's sum in cents, less usage and add-on fees not yet moved to it (micros, < 1 cent each). */
  async balance(workspaceId: string): Promise<{ cents: number; pendingMicros: number; availableMicros: number }> {
    const [sum, accrual, addons] = await Promise.all([
      this.first<{ cents: number }>('SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM ledger WHERE workspace_id = ?', workspaceId),
      this.first<{ micros: number }>('SELECT micros FROM usage_accrual WHERE workspace_id = ?', workspaceId),
      this.first<{ micros: number }>('SELECT COALESCE(SUM(micros), 0) AS micros FROM addon_accrual WHERE workspace_id = ?', workspaceId),
    ]);
    const cents = Number(sum?.cents ?? 0);
    const pendingMicros = Number(accrual?.micros ?? 0) + Number(addons?.micros ?? 0);
    return { cents, pendingMicros, availableMicros: cents * MICROS_PER_CENT - pendingMicros };
  }

  async ledger(workspaceId: string, limit = 500): Promise<LedgerEntry[]> {
    return (await this.all<Row>('SELECT * FROM ledger WHERE workspace_id = ? ORDER BY created_at DESC, id LIMIT ?', workspaceId, limit)).map(ledgerFrom);
  }

  /** Takes a request's cost from the balance: accrued, and every whole cent moved to the ledger as a usage entry. */
  async chargeUsage(workspaceId: string, micros: number): Promise<void> {
    const m = Math.max(0, Math.round(micros));
    if (!m) return;
    const at = this.now();
    await this.db.batch([
      this.db.prepare('INSERT INTO usage_accrual (workspace_id, micros, flushes) VALUES (?, ?, 0) ON CONFLICT(workspace_id) DO UPDATE SET micros = micros + excluded.micros').bind(workspaceId, m),
      this.db.prepare(`INSERT INTO ledger (id, workspace_id, amount_cents, kind, source_key, description, created_at)
        SELECT ?, workspace_id, -(micros / ${MICROS_PER_CENT}), 'usage', 'usage:' || workspace_id || ':' || (flushes + 1), 'API usage', ? FROM usage_accrual WHERE workspace_id = ? AND micros >= ${MICROS_PER_CENT}`)
        .bind(`led_${randomUUID()}`, at, workspaceId),
      this.db.prepare(`UPDATE usage_accrual SET micros = micros % ${MICROS_PER_CENT}, flushes = flushes + 1 WHERE workspace_id = ? AND micros >= ${MICROS_PER_CENT}`).bind(workspaceId),
    ]);
  }

  /**
   * Takes a paid add-on's fee (e.g. PII protection) from the balance, like chargeUsage but accrued on its own and
   * moved to the ledger as its own usage line (`description`, e.g. "PII protection"), one D1 batch.
   */
  async chargeAddon(workspaceId: string, addon: string, micros: number, description: string): Promise<void> {
    const m = Math.max(0, Math.round(micros));
    if (!m) return;
    const at = this.now();
    await this.db.batch([
      this.db.prepare('INSERT INTO addon_accrual (workspace_id, addon, micros, flushes) VALUES (?, ?, ?, 0) ON CONFLICT(workspace_id, addon) DO UPDATE SET micros = micros + excluded.micros').bind(workspaceId, addon, m),
      this.db.prepare(`INSERT INTO ledger (id, workspace_id, amount_cents, kind, source_key, description, created_at)
        SELECT ?, workspace_id, -(micros / ${MICROS_PER_CENT}), 'usage', 'addon:' || addon || ':' || workspace_id || ':' || (flushes + 1), ?, ? FROM addon_accrual WHERE workspace_id = ? AND addon = ? AND micros >= ${MICROS_PER_CENT}`)
        .bind(`led_${randomUUID()}`, description.slice(0, 200), at, workspaceId, addon),
      this.db.prepare(`UPDATE addon_accrual SET micros = micros % ${MICROS_PER_CENT}, flushes = flushes + 1 WHERE workspace_id = ? AND addon = ? AND micros >= ${MICROS_PER_CENT}`).bind(workspaceId, addon),
    ]);
  }

  async addAdjustment(workspaceId: string, cents: number, description: string, sourceKey: string): Promise<boolean> {
    const r = await this.db.prepare("INSERT OR IGNORE INTO ledger (id, workspace_id, amount_cents, kind, source_key, description, created_at) VALUES (?, ?, ?, 'adjustment', ?, ?, ?)")
      .bind(`led_${randomUUID()}`, workspaceId, Math.trunc(cents), sourceKey, description.slice(0, 200), this.now()).run();
    return Boolean(r.meta.changes);
  }

  // ── receipts, e-invoices and PDFs ─────────────────────────────────────────────────────────────────────

  async receiptForOrder(orderId: string): Promise<Receipt | null> {
    const r = await this.first<Row>('SELECT * FROM receipts WHERE order_id = ?', orderId);
    return r ? receiptFrom(r) : null;
  }

  async receipt(id: string): Promise<Receipt | null> {
    const r = await this.first<Row>('SELECT * FROM receipts WHERE id = ?', id);
    return r ? receiptFrom(r) : null;
  }

  async receipts(workspaceId: string): Promise<Receipt[]> {
    return (await this.all<Row>('SELECT * FROM receipts WHERE workspace_id = ? ORDER BY issued_at DESC', workspaceId)).map(receiptFrom);
  }

  /** Claims the right to email this receipt: true for exactly one caller (unless reset after a failure). */
  async claimEmail(receiptId: string): Promise<boolean> {
    const r = await this.db.prepare("UPDATE receipts SET email_status = 'sending', email_at = ? WHERE id = ? AND email_status IS NULL").bind(this.now(), receiptId).run();
    return Boolean(r.meta.changes);
  }

  async setEmailStatus(receiptId: string, status: 'sent' | 'failed' | null): Promise<void> {
    await this.db.prepare('UPDATE receipts SET email_status = ?, email_at = ? WHERE id = ?').bind(status, this.now(), receiptId).run();
  }

  async einvoice(id: string): Promise<EInvoice | null> {
    const r = await this.first<Row>('SELECT * FROM einvoices WHERE id = ?', id);
    return r ? einvoiceFrom(r) : null;
  }

  async einvoiceForOrder(orderId: string): Promise<EInvoice | null> {
    const r = await this.first<Row>('SELECT * FROM einvoices WHERE order_id = ?', orderId);
    return r ? einvoiceFrom(r) : null;
  }

  async einvoices(workspaceId: string): Promise<EInvoice[]> {
    return (await this.all<Row>('SELECT * FROM einvoices WHERE workspace_id = ? ORDER BY created_at DESC', workspaceId)).map(einvoiceFrom);
  }

  /** E-invoices to (re)try: pending, or "issuing" for so long that the attempt must have died. */
  async einvoicesToIssue(limit = 20): Promise<EInvoice[]> {
    const stale = this.now() - EINVOICE_ISSUING_STALE_MS;
    return (await this.all<Row>("SELECT * FROM einvoices WHERE status = 'pending' OR (status = 'issuing' AND attempt_at < ?) ORDER BY created_at LIMIT ?", stale, limit)).map(einvoiceFrom);
  }

  async allEinvoices(limit = 200): Promise<EInvoice[]> {
    return (await this.all<Row>('SELECT * FROM einvoices ORDER BY created_at DESC LIMIT ?', limit)).map(einvoiceFrom);
  }

  /**
   * Claims an e-invoice to send to the provider: true for one caller at a time. Viettel must never get two requests
   * with one transactionUuid at once; a claim older than EINVOICE_ISSUING_STALE_MS has timed out and may be retaken.
   */
  async claimEinvoice(id: string): Promise<boolean> {
    const now = this.now();
    const r = await this.db.prepare("UPDATE einvoices SET status = 'issuing', attempt_at = ?, attempts = attempts + 1 WHERE id = ? AND (status = 'pending' OR (status = 'issuing' AND attempt_at < ?))")
      .bind(now, id, now - EINVOICE_ISSUING_STALE_MS).run();
    return Boolean(r.meta.changes);
  }

  async einvoiceIssued(id: string, record: EInvoiceRecord): Promise<void> {
    await this.db.prepare("UPDATE einvoices SET status = 'issued', record = ?, issued_at = ?, last_error = NULL WHERE id = ? AND status IN ('issuing', 'pending')")
      .bind(JSON.stringify(record), record.issuedAt, id).run();
  }

  /** The attempt failed: back to pending (retried), or failed after too many attempts. */
  async einvoiceFailed(id: string, error: string): Promise<void> {
    await this.db.prepare(`UPDATE einvoices SET status = CASE WHEN attempts >= ${EINVOICE_MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END, last_error = ? WHERE id = ? AND status = 'issuing'`)
      .bind(error.slice(0, 500), id).run();
  }

  /** Not tried (S-Invoice not configured yet, no exchange rate): stays pending, with why. */
  async einvoiceWaiting(id: string, why: string): Promise<void> {
    await this.db.prepare("UPDATE einvoices SET last_error = ? WHERE id = ? AND status = 'pending'").bind(why.slice(0, 500), id).run();
  }

  /** An admin retries a failed one. */
  async einvoiceRetry(id: string): Promise<boolean> {
    const r = await this.db.prepare("UPDATE einvoices SET status = 'pending', attempts = 0 WHERE id = ? AND status = 'failed'").bind(id).run();
    return Boolean(r.meta.changes);
  }

  /** After a replacement e-invoice: the corrected details and the new record (the old one is in the audit log). */
  async replaceEinvoice(id: string, details: VatInvoiceDetails, record: EInvoiceRecord): Promise<void> {
    await this.db.prepare("UPDATE einvoices SET details = ?, record = ?, issued_at = ?, email_status = NULL, status = 'issued' WHERE id = ?")
      .bind(JSON.stringify(details), JSON.stringify(record), record.issuedAt, id).run();
    await this.db.prepare('DELETE FROM billing_documents WHERE id = ?').bind(id).run();
  }

  async einvoiceSetStatus(id: string, status: EInvoiceStatus): Promise<void> {
    await this.db.prepare('UPDATE einvoices SET status = ? WHERE id = ?').bind(status, id).run();
  }

  async claimEinvoiceEmail(id: string): Promise<boolean> {
    const r = await this.db.prepare("UPDATE einvoices SET email_status = 'sending', email_at = ? WHERE id = ? AND status = 'issued' AND email_status IS NULL").bind(this.now(), id).run();
    return Boolean(r.meta.changes);
  }

  async setEinvoiceEmailStatus(id: string, status: 'sent' | 'failed' | null): Promise<void> {
    await this.db.prepare('UPDATE einvoices SET email_status = ?, email_at = ? WHERE id = ?').bind(status, this.now(), id).run();
  }

  async document(id: string): Promise<Uint8Array | null> {
    const r = await this.first<{ pdf: string }>('SELECT pdf FROM billing_documents WHERE id = ?', id);
    return r ? new Uint8Array(Buffer.from(r.pdf, 'base64')) : null;
  }

  async saveDocument(id: string, kind: 'einvoice' | 'receipt', pdf: Uint8Array): Promise<void> {
    await this.db.prepare('INSERT OR IGNORE INTO billing_documents (id, kind, pdf, created_at) VALUES (?, ?, ?, ?)').bind(id, kind, Buffer.from(pdf).toString('base64'), this.now()).run();
  }
}

