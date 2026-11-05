import { randomBytes } from 'crypto';

/**
 * Valefront billing domain: prepaid US-dollar credit on a workspace.
 *
 * - All money is integer US cents. A customer buys credit (at least $10); VAT, when it applies, is added on top, so
 *   the credit is what lands on the balance and the total is what they pay.
 * - The ledger (billing-store.ts) is the only source of a balance: payments add to it, usage takes from it.
 * - Every payment issues a receipt (VF-RCT-2026-000001), numbered without gaps per seller and year, emailed as a PDF.
 *   A buyer in Vietnam who asks for one also gets a Vietnamese VAT e-invoice through Viettel S-Invoice
 *   (einvoice-viettel.ts), queued until S-Invoice is configured and retried until it's issued.
 * - Payment methods: WorldFirst bank transfer (manual: an admin marks the order paid), PayPal (Orders API v2,
 *   paypal.ts), SePay (a VietQR bank transfer in VND for the order's exact quoted amount, sepay.ts: SePay tells us
 *   by webhook, or we find it by polling, and the order credits itself).
 */

export type PaymentMethod = 'worldfirst' | 'paypal' | 'sepay';

export const MIN_CREDIT_CENTS = 1_000;
export const MAX_CREDIT_CENTS = 1_000_000;
export const CURRENCY = 'USD' as const;

/** WorldFirst USD receiving account, set on the admin host and shown with bank-transfer orders. */
export type BillingAccount = {
  accountName: string;
  accountNumber: string;
  bankName: string;
  bankAddress?: string;
  swiftCode: string;
  routingNumber?: string;
  currency: 'USD';
  /** Extra instructions shown with the account (optional). */
  instructions?: string;
};

/** The seller on invoices and receipts. */
export type LegalSettings = {
  companyName: string;
  /** The company's name in Vietnamese, as registered. */
  localName?: string;
  taxCode: string;
  address: string;
  email: string;
};

export const DEFAULT_SELLER: LegalSettings = {
  companyName: 'THE AI TECHNOLOGY COMPANY LIMITED',
  localName: 'CÔNG TY TNHH CÔNG NGHỆ THE AI',
  taxCode: '0402339145',
  address: '35 Thai Phien Street, Hai Chau Ward, Da Nang City, Vietnam',
  email: 'info@valefront.com',
};

/**
 * VAT in basis points (1000 = 10%) by the buyer's country (ISO 3166-1 alpha-2). Selling to customers outside
 * Vietnam is an export of services (0%); customers in Vietnam pay 10% unless an admin sets another rate.
 */
export type VatSettings = { defaultBp: number; byCountry: Record<string, number> };
export const DEFAULT_VAT: VatSettings = { defaultBp: 0, byCountry: { VN: 1000 } };

/** Who the invoice is for (the customer's billing details on the Billing page). */
export type BuyerProfile = {
  name: string;
  email: string;
  company?: string;
  taxId?: string;
  address?: string;
  /** ISO 3166-1 alpha-2, upper case. */
  country: string;
  /** Saved VAT invoice details (buyers in Vietnam), for the next order. Not part of an order's buyer snapshot. */
  vatInvoice?: VatInvoiceDetails;
};

export type OrderStatus = 'pending' | 'paid' | 'cancelled';

export type BillingOrder = {
  id: string;
  workspaceId: string;
  method: PaymentMethod;
  /** live, or sandbox: a test payment (PayPal sandbox), marked SANDBOX everywhere and numbered apart. */
  mode: 'live' | 'sandbox';
  /** Credit bought. */
  amountCents: number;
  vatRateBp: number;
  vatCents: number;
  /** What the customer pays: amount + VAT. */
  totalCents: number;
  currency: 'USD';
  reference: string;
  status: OrderStatus;
  buyer: BuyerProfile;
  /** The Vietnamese VAT invoice asked for with this order (buyers in Vietnam only). */
  einvoiceRequest?: VatInvoiceDetails | null;
  /** The WorldFirst account shown with a bank-transfer order (as it was when the order was made). */
  account?: BillingAccount | null;
  /** SePay orders: the VND amount the customer was asked to pay, at which rate, until when (sepay.ts). */
  quote?: VndQuote | null;
  /** What an admin should know about how it was paid (underpaid by, overpaid: refund, paid late...). */
  paymentNote?: string | null;
  providerOrderId?: string | null;
  providerCaptureId?: string | null;
  createdAt: number;
  paidAt?: number | null;
  paidBy?: string | null;
};

export type LedgerEntry = {
  id: string;
  workspaceId: string;
  amountCents: number;
  kind: 'payment' | 'usage' | 'adjustment';
  description: string;
  orderId?: string | null;
  createdAt: number;
};

/** The Vietnamese bank account a SePay order is paid into (VietQR). */
export type VndBankAccount = {
  accountNumber: string;
  /** VietQR bank id: BIN (970436) or short code (VCB), as qr.sepay.vn takes it. */
  bankId: string;
  bankName: string;
  accountName: string;
};

/**
 * A SePay order's price in VND: totalCents at the day's rate (the one /v1/pricing publishes), rounded up to a whole
 * dong, and the transfer content (the order reference without symbols: Vietnamese banks strip them).
 */
export type VndQuote = {
  currency: 'VND';
  vndAmount: number;
  vndPerUsd: number;
  rateDate: string;
  rateSource: string;
  quotedAt: number;
  expiresAt: number;
  transferContent: string;
  bank: VndBankAccount;
  qrUrl: string;
};

/** A receipt: one per payment (VF-RCT-2026-000001), emailed as a PDF. */
export type Receipt = {
  id: string;
  orderId: string;
  workspaceId: string;
  mode: 'live' | 'sandbox';
  number: string;
  issuedAt: number;
  seller: LegalSettings;
  buyer: BuyerProfile;
  /** Credit added. */
  amountCents: number;
  vatRateBp: number;
  vatCents: number;
  /** Amount received. */
  totalCents: number;
  currency: 'USD';
  method: PaymentMethod;
  reference: string;
  providerReference?: string | null;
  emailStatus?: 'sending' | 'sent' | 'failed' | null;
  emailAt?: number | null;
};

/** What a customer in Vietnam puts on their VAT invoice (hóa đơn GTGT), saved for next time. */
export type VatInvoiceDetails = {
  companyName: string;
  /** Mã số thuế: 10 digits, or 13 (a branch: 10 digits, "-", 3 digits). */
  taxCode: string;
  address: string;
  /** Where the e-invoice is sent. */
  email: string;
};

export type EInvoiceStatus = 'pending' | 'issuing' | 'issued' | 'failed' | 'cancelled' | 'replaced';

/** What the e-invoice provider returned (Viettel S-Invoice: invoiceNo, transactionID, reservationCode, codeOfTax). */
export type EInvoiceRecord = {
  provider: string;
  /** The e-invoice number, e.g. "C26TAA0000001" (series + number). */
  invoiceNo: string;
  /** Our idempotency key sent with it (Viettel: transactionUuid): the e-invoice's id. */
  transactionUuid: string;
  transactionId?: string | null;
  /** Secret code the buyer looks the invoice up with. */
  reservationCode?: string | null;
  /** The tax authority's (CQT) code; null until it has given one. */
  codeOfTax?: string | null;
  templateCode: string;
  series: string;
  supplierTaxCode: string;
  issuedAt: number;
};

/** A Vietnamese VAT e-invoice for one payment, issued through the provider (pending until it is). */
export type EInvoice = {
  id: string;
  orderId: string;
  receiptId: string;
  workspaceId: string;
  mode: 'live' | 'sandbox';
  status: EInvoiceStatus;
  details: VatInvoiceDetails;
  amountCents: number;
  vatRateBp: number;
  vatCents: number;
  totalCents: number;
  currency: 'USD';
  paidAt: number;
  attempts: number;
  lastError?: string | null;
  record?: EInvoiceRecord | null;
  issuedAt?: number | null;
  emailStatus?: 'sending' | 'sent' | 'failed' | null;
  createdAt: number;
};

/**
 * A redirect checkout (PayPal, paypal.ts). WorldFirst needs no gateway (manual); SePay (sepay.ts) is a bank QR, not
 * a redirect: its quote is made with the order and its payments arrive by webhook or polling.
 */
export interface PaymentGateway {
  readonly method: PaymentMethod;
  createCheckout(input: { order: BillingOrder; returnUrl: string; cancelUrl: string }): Promise<{ providerOrderId: string; redirectUrl: string }>;
}

/**
 * Vietnam e-invoice (hóa đơn điện tử) provider: Viettel S-Invoice (einvoice-viettel.ts). A Vietnamese seller issues
 * each VAT invoice through a licensed provider registered with the tax authority; Valefront issues one when a buyer
 * in Vietnam asks for it. Shaped on S-Invoice's webservice: create with a transactionUuid (idempotency), look it up
 * by transactionUuid after a timeout, get the PDF, cancel, replace.
 */
export interface EInvoiceProvider {
  readonly name: string;
  issue(invoice: EInvoice, ctx: { seller: LegalSettings; exchangeRate: number }): Promise<EInvoiceRecord>;
  /** After a timeout: the e-invoice this transactionUuid made, if it was made. */
  findByTransactionUuid(transactionUuid: string): Promise<EInvoiceRecord | null>;
  /** The e-invoice PDF, as the provider renders it. */
  pdf(record: EInvoiceRecord): Promise<Uint8Array>;
  cancel(record: EInvoiceRecord, reason: { description: string; at: number }): Promise<void>;
  /** Whether the configured template/series exist on the account (a clear message for the admin when not). */
  checkSettings?(force?: boolean): Promise<{ ok: boolean; message: string }>;
  /** A replacement invoice (thay thế) for an issued one, e.g. after a wrong tax code. */
  replace(original: EInvoiceRecord, invoice: EInvoice, ctx: { seller: LegalSettings; exchangeRate: number; reason: string; transactionUuid: string }): Promise<EInvoiceRecord>;
}

export class BillingError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export function validateCreditAmount(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents < MIN_CREDIT_CENTS) {
    throw new BillingError('amount_too_small', 'Credit amount must be at least $10.00');
  }
  if (amountCents > MAX_CREDIT_CENTS) {
    throw new BillingError('amount_too_large', `Credit amount can be at most ${formatUsd(MAX_CREDIT_CENTS)} at a time`);
  }
}

/** VAT for a purchase of `amountCents` credit by a buyer in `country`. */
export function vatFor(amountCents: number, country: string, vat: VatSettings = DEFAULT_VAT): { vatRateBp: number; vatCents: number; totalCents: number } {
  const code = country.trim().toUpperCase();
  const rate = vat.byCountry[code] ?? vat.defaultBp;
  const vatRateBp = Number.isInteger(rate) && rate >= 0 && rate <= 10_000 ? rate : 0;
  const vatCents = Math.round((amountCents * vatRateBp) / 10_000);
  return { vatRateBp, vatCents, totalCents: amountCents + vatCents };
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A bank-transfer reference people can type: VF- and 10 characters (no I, L, O, U). Unique in the store. */
export function createPaymentReference(bytes: Buffer = randomBytes(10)): string {
  let out = '';
  for (let i = 0; i < 10; i++) out += CROCKFORD[bytes[i]! % 32];
  return `VF-${out}`;
}

export function formatUsd(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

/** "10.00" for PayPal and forms. */
export function centsToDecimal(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** "10.00" or "10" -> 1000; null when it isn't a plain positive amount with at most two decimals. */
export function decimalToCents(value: string): number | null {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** The seller is in Vietnam: documents are dated in Vietnam time (UTC+7, no daylight saving). */
export function vietnamDate(at: number): { year: number; date: string } {
  const d = new Date(at + 7 * 3_600_000);
  return { year: d.getUTCFullYear(), date: d.toISOString().slice(0, 10) };
}

export function documentNumber(kind: 'RCT', year: number, seq: number): string {
  return `VF-${kind}-${year}-${String(seq).padStart(6, '0')}`;
}

export function vatLabel(rateBp: number): string {
  return `${(rateBp / 100).toFixed(rateBp % 100 ? 2 : 0)}%`;
}

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  worldfirst: 'Bank transfer (WorldFirst)',
  paypal: 'PayPal',
  sepay: 'SePay bank QR',
};

/** Cleans a billing profile from the Billing page (throws a BillingError when something required is missing). */
export function cleanBuyerProfile(input: unknown, fallbackEmail: string): BuyerProfile {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
  const name = text(o.name, 120);
  const email = text(o.email, 254).toLowerCase() || fallbackEmail;
  const country = text(o.country, 3).toUpperCase();
  if (!name) throw new BillingError('billing_name_required', 'Enter the name to put on your invoices.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BillingError('billing_email_invalid', 'Enter a valid billing email.');
  if (!/^[A-Z]{2}$/.test(country)) throw new BillingError('billing_country_required', 'Choose your country (it sets the VAT on your invoices).');
  const company = text(o.company, 160);
  const taxId = text(o.taxId, 40);
  const address = text(o.address, 300);
  return { name, email, country, ...(company ? { company } : {}), ...(taxId ? { taxId } : {}), ...(address ? { address } : {}) };
}

/** A Vietnamese tax code (MST): 10 digits, or a branch's 13 (written 0123456789-001 or 0123456789001). */
export function normalizeTaxCode(value: string): string | null {
  const v = value.replace(/\s+/g, '');
  if (/^\d{10}$/.test(v)) return v;
  const m = /^(\d{10})-?(\d{3})$/.exec(v);
  return m ? `${m[1]}-${m[2]}` : null;
}

export function cleanVatInvoiceDetails(input: unknown): VatInvoiceDetails {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
  const companyName = text(o.companyName, 400);
  const taxCode = normalizeTaxCode(text(o.taxCode, 20));
  const address = text(o.address, 400);
  const email = text(o.email, 254).toLowerCase();
  if (!companyName) throw new BillingError('vat_company_required', 'Enter the company name for the VAT invoice.');
  if (!taxCode) throw new BillingError('vat_tax_code_invalid', 'The tax code (MST) must be 10 digits, or 13 for a branch.');
  if (!address) throw new BillingError('vat_address_required', 'Enter the company address for the VAT invoice.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new BillingError('vat_email_invalid', 'Enter the email to receive the VAT invoice.');
  return { companyName, taxCode, address, email };
}

export function cleanAccount(input: unknown): BillingAccount {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const text = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const account: BillingAccount = {
    accountName: text(o.accountName),
    accountNumber: text(o.accountNumber, 64),
    bankName: text(o.bankName),
    swiftCode: text(o.swiftCode, 16).toUpperCase(),
    currency: 'USD',
  };
  if (!account.accountName || !account.accountNumber || !account.bankName || !account.swiftCode) {
    throw new BillingError('account_incomplete', 'Account name, account number, bank name and SWIFT code are required.');
  }
  const bankAddress = text(o.bankAddress, 300);
  const routingNumber = text(o.routingNumber, 32);
  const instructions = text(o.instructions, 1000);
  return { ...account, ...(bankAddress ? { bankAddress } : {}), ...(routingNumber ? { routingNumber } : {}), ...(instructions ? { instructions } : {}) };
}

export function cleanLegal(input: unknown): LegalSettings {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const text = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const legal: LegalSettings = { companyName: text(o.companyName), taxCode: text(o.taxCode, 40), address: text(o.address), email: text(o.email, 254) };
  if (!legal.companyName || !legal.taxCode || !legal.address || !legal.email) {
    throw new BillingError('legal_incomplete', 'Company name, tax code, address and email are required.');
  }
  const localName = text(o.localName);
  return { ...legal, ...(localName ? { localName } : {}) };
}

export function cleanVat(input: unknown): VatSettings {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const bp = (v: unknown) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new BillingError('vat_invalid', 'VAT rates are whole basis points from 0 to 10000 (1000 = 10%).');
    return n;
  };
  const byCountry: Record<string, number> = {};
  for (const [country, rate] of Object.entries(o.byCountry && typeof o.byCountry === 'object' ? (o.byCountry as Record<string, unknown>) : {})) {
    const code = country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) throw new BillingError('vat_invalid', `"${country}" is not a two-letter country code.`);
    byCountry[code] = bp(rate);
  }
  return { defaultBp: bp(o.defaultBp ?? 0), byCountry };
}
