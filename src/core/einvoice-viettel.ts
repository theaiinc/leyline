import type { EInvoice, EInvoiceProvider, EInvoiceRecord, LegalSettings } from './billing';
import { secretsFor, type ProviderMode } from './provider-modes';

/**
 * Viettel S-Invoice (vinvoice.viettel.vn): the licensed provider that issues Valefront's Vietnamese VAT e-invoices
 * (hóa đơn GTGT) to the tax authority. Shapes as verified against Viettel's sandbox (demo account) on 2026-11-05:
 *
 * - One service for sandbox and production: https://api-vinvoice.viettel.vn/services/einvoiceapplication/api; only
 *   the account differs. HTTP Basic auth (the account's username, e.g. its tax code, and password).
 * - Templates: POST InvoiceAPI/InvoiceUtilsWS/getAllInvoiceTemplates {taxCode, invoiceType: "all"} ->
 *   { template: [{ templateCode: "1/0353", invoiceSeri: "C26TAY", … }] }. The configured template + series must be
 *   one of these pairs (checkSettings), or every invoice fails with INVOICE_SERIAL_NOT_FOUND.
 * - Issue: POST InvoiceAPI/InvoiceWS/createInvoice/{taxCode} with generalInvoiceInfo, buyerInfo, payments, itemInfo,
 *   taxBreakdowns, summarizeInfo -> { result: { invoiceNo, transactionID, reservationCode, codeOfTax } }. Errors:
 *   400 { code, message: "INVOICE_SERIAL_NOT_FOUND", data: "Ký hiệu hóa đơn không tồn tại" } (older answers:
 *   { errorCode, description }).
 * - Idempotency: generalInvoiceInfo.transactionUuid is the e-invoice's own id; one request at a time, and after a
 *   timeout InvoiceAPI/InvoiceWS/searchInvoiceByTransactionUuid before sending again.
 * - PDF: POST InvoiceAPI/InvoiceUtilsWS/getInvoiceRepresentationFile {supplierTaxCode, invoiceNo, templateCode,
 *   fileType: "PDF"} -> { fileToBytes } (base64). The buyer looks it up at INVOICE_LOOKUP_URL with reservationCode.
 * - Cancel: InvoiceAPI/InvoiceWS/cancelTransactionInvoice (form). Replace: createInvoice with adjustmentType "3"
 *   and the original's number, date and template.
 * - USD amounts are sent with cents (10.5); Viettel's PDF prints whole dollars without decimals.
 *
 * Sandbox | Live is switched on the admin host (provider-modes.ts). Worker secrets per mode,
 * VIETTEL_SINVOICE_{SANDBOX,LIVE}_: USERNAME, PASSWORD, TAX_CODE, TEMPLATE_CODE (a VAT template, one rate),
 * SERIES (its series; the year is in it: change it each year), optionally BASE_URL.
 */
export const INVOICE_LOOKUP_URL = 'https://vinvoice.viettel.vn/utilities/invoice-search';

export type ViettelSInvoiceConfig = {
  env: 'sandbox' | 'production';
  /** API root that /InvoiceAPI/... hangs off. */
  apiBase: string;
  username: string;
  password: string;
  /** Seller tax code (MST): 0402339145. */
  taxCode: string;
  /** Invoice template code registered on S-Invoice, e.g. 1/001 (VAT invoice). */
  templateCode: string;
  /** Invoice series (ký hiệu), e.g. C26TAA. */
  series: string;
  fetchImpl?: typeof fetch;
  /** Request timeout; Viettel asks integrators to wait at least 90 s before retrying. */
  timeoutMs?: number;
};

/** The same service for sandbox and production: only the account (and its templates) differ. */
export const SINVOICE_API = 'https://api-vinvoice.viettel.vn/services/einvoiceapplication/api';

/** S-Invoice for a mode, from its secrets (VIETTEL_SINVOICE_SANDBOX_* or _LIVE_*), or null when they're missing. */
export function viettelConfigFor(env: Record<string, string | undefined>, mode: ProviderMode): ViettelSInvoiceConfig | null {
  const s = secretsFor(env, 'sinvoice', mode);
  if (!s) return null;
  return {
    env: mode === 'live' ? 'production' : 'sandbox',
    apiBase: (s.BASE_URL || SINVOICE_API).replace(/\/+$/, ''),
    username: s.USERNAME!,
    password: s.PASSWORD!,
    taxCode: s.TAX_CODE!,
    templateCode: s.TEMPLATE_CODE!,
    series: s.SERIES!,
  };
}

export const LINE_NAME = 'Tín dụng trả trước dịch vụ API Valefront (Valefront prepaid API credit)';

/** Viettel's yyyyMMddHHmmss, in Vietnam time. */
export function viettelDate(at: number): string {
  return new Date(at + 7 * 3_600_000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** The createInvoice body for one payment (USD with cents, and the VND exchange rate the law asks for). */
export function sInvoicePayload(e: EInvoice, ctx: { exchangeRate: number; templateCode: string; series: string; transactionUuid: string }) {
  const usd = (cents: number) => Math.round(cents) / 100;
  const vatPercent = e.vatRateBp / 100;
  return {
    generalInvoiceInfo: {
      invoiceType: ctx.templateCode.split('/')[0],
      templateCode: ctx.templateCode,
      invoiceSeries: ctx.series,
      currencyCode: e.currency,
      exchangeRate: ctx.exchangeRate,
      adjustmentType: '1',
      paymentStatus: true,
      cusGetInvoiceRight: true,
      transactionUuid: ctx.transactionUuid,
    },
    buyerInfo: {
      buyerName: e.details.companyName,
      buyerLegalName: e.details.companyName,
      buyerTaxCode: e.details.taxCode,
      buyerAddressLine: e.details.address,
      buyerEmail: e.details.email,
      buyerNotGetInvoice: '0',
    },
    // 2 / CK: bank transfer (PayPal and WorldFirst both reach us as transfers).
    payments: [{ paymentMethod: '2', paymentMethodName: 'CK' }],
    itemInfo: [{
      lineNumber: 1,
      selection: 1,
      itemCode: 'VF-CREDIT',
      itemName: LINE_NAME,
      unitName: 'Gói',
      quantity: 1,
      unitPrice: usd(e.amountCents),
      itemTotalAmountWithoutTax: usd(e.amountCents),
      itemTotalAmountAfterDiscount: usd(e.amountCents),
      itemTotalAmountWithTax: usd(e.totalCents),
      taxPercentage: vatPercent,
      taxAmount: usd(e.vatCents),
    }],
    taxBreakdowns: [{ taxPercentage: vatPercent, taxableAmount: usd(e.amountCents), taxAmount: usd(e.vatCents) }],
    summarizeInfo: {
      sumOfTotalLineAmountWithoutTax: usd(e.amountCents),
      totalAmountAfterDiscount: usd(e.amountCents),
      totalAmountWithoutTax: usd(e.amountCents),
      totalTaxAmount: usd(e.vatCents),
      totalAmountWithTax: usd(e.totalCents),
      discountAmount: 0,
    },
  };
}

/** A Viettel error answer (errorCode set), or a transport failure (code "network"/"timeout"/"http_<n>"). */
export class SInvoiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(`S-Invoice ${code}: ${message}`);
  }
}

type Answer = { errorCode?: string | null; description?: string | null; result?: unknown; [k: string]: unknown };

function recordFrom(result: Record<string, unknown>, cfg: ViettelSInvoiceConfig, transactionUuid: string, issuedAt: number): EInvoiceRecord {
  const s = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
  return {
    provider: 'viettel-sinvoice',
    invoiceNo: String(result.invoiceNo),
    transactionUuid,
    transactionId: s(result.transactionID ?? result.transactionId),
    reservationCode: s(result.reservationCode),
    codeOfTax: s(result.codeOfTax),
    templateCode: s(result.templateCode) ?? cfg.templateCode,
    series: s(result.invoiceSeries) ?? cfg.series,
    supplierTaxCode: s(result.supplierTaxCode) ?? cfg.taxCode,
    issuedAt,
  };
}

export class ViettelSInvoiceProvider implements EInvoiceProvider {
  readonly name = 'viettel-sinvoice';
  private readonly fetchImpl: typeof fetch;

  constructor(readonly cfg: ViettelSInvoiceConfig) {
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** Null until that mode's VIETTEL_SINVOICE_{SANDBOX,LIVE}_* secrets exist. */
  static forMode(env: Record<string, string | undefined>, mode: ProviderMode, fetchImpl?: typeof fetch): ViettelSInvoiceProvider | null {
    const cfg = viettelConfigFor(env, mode);
    return cfg ? new ViettelSInvoiceProvider({ ...cfg, ...(fetchImpl ? { fetchImpl } : {}) }) : null;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 100_000);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      throw new SInvoiceError(controller.signal.aborted ? 'timeout' : 'network', err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /** One API call with Basic auth. Viettel's errors (either shape) become an SInvoiceError with its code. */
  private async call(path: string, body: { json?: unknown; form?: Record<string, string> }): Promise<Answer> {
    const res = await this.send(`${this.cfg.apiBase}/${path.replace(/^\/+/, '')}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString('base64')}`,
        Accept: 'application/json',
        'Content-Type': body.form ? 'application/x-www-form-urlencoded' : 'application/json',
      },
      body: body.form ? new URLSearchParams(body.form).toString() : JSON.stringify(body.json ?? {}),
    });
    const answer = (await res.json().catch(() => null)) as Answer | null;
    if (res.status === 401 || res.status === 403) throw new SInvoiceError('auth_failed', `Viettel refused the account (${res.status})`);
    if (!answer) throw new SInvoiceError(`http_${res.status}`, 'no JSON answer');
    if (answer.errorCode) throw new SInvoiceError(String(answer.errorCode), String(answer.description ?? ''));
    if (!res.ok || (typeof answer.code === 'number' && answer.code >= 400)) {
      throw new SInvoiceError(String(answer.message ?? `http_${res.status}`), String(answer.data ?? answer.description ?? ''));
    }
    return answer;
  }

  /** The template/series pairs this account may issue with. */
  async templates(): Promise<Array<{ templateCode: string; series: string }>> {
    const answer = await this.call('InvoiceAPI/InvoiceUtilsWS/getAllInvoiceTemplates', { json: { taxCode: this.cfg.taxCode, invoiceType: 'all' } });
    const list = (Array.isArray(answer.template) ? answer.template : []) as Array<Record<string, unknown>>;
    return list.map((t) => ({ templateCode: String(t.templateCode ?? ''), series: String(t.invoiceSeri ?? t.invoiceSeries ?? '') })).filter((t) => t.templateCode && t.series);
  }

  /** Whether the configured template + series exist on the account (checked once per instance, then on demand). */
  async checkSettings(force = false): Promise<{ ok: boolean; message: string; available: Array<{ templateCode: string; series: string }> }> {
    if (this.checked && !force) return this.checked;
    const available = await this.templates();
    const ok = available.some((t) => t.templateCode === this.cfg.templateCode && t.series === this.cfg.series);
    const result = {
      ok,
      message: ok
        ? `Template ${this.cfg.templateCode} with series ${this.cfg.series} is on the account.`
        : `Template ${this.cfg.templateCode} with series ${this.cfg.series} is not on this S-Invoice account. It has: ${available.map((t) => `${t.templateCode} + ${t.series}`).join(', ') || 'no templates'}.`,
      available,
    };
    if (ok) this.checked = result;
    return result;
  }

  private checked: { ok: boolean; message: string; available: Array<{ templateCode: string; series: string }> } | null = null;

  async issue(e: EInvoice, ctx: { seller: LegalSettings; exchangeRate: number }): Promise<EInvoiceRecord> {
    const check = await this.checkSettings();
    if (!check.ok) throw new SInvoiceError('template_not_found', check.message);
    const issuedAt = Date.now();
    const answer = await this.call(`InvoiceAPI/InvoiceWS/createInvoice/${encodeURIComponent(this.cfg.taxCode)}`, {
      json: sInvoicePayload(e, { exchangeRate: ctx.exchangeRate, templateCode: this.cfg.templateCode, series: this.cfg.series, transactionUuid: e.id }),
    });
    const result = answer.result as Record<string, unknown> | undefined;
    if (!result || typeof result.invoiceNo !== 'string' || !result.invoiceNo) throw new SInvoiceError('no_result', 'createInvoice returned no invoice number');
    return recordFrom(result, this.cfg, e.id, issuedAt);
  }

  async findByTransactionUuid(transactionUuid: string): Promise<EInvoiceRecord | null> {
    let answer: Answer;
    try {
      answer = await this.call('InvoiceAPI/InvoiceWS/searchInvoiceByTransactionUuid', { form: { supplierTaxCode: this.cfg.taxCode, transactionUuid } });
    } catch (err) {
      // "Not found" is an answer, not a failure: the earlier attempt never made it.
      if (err instanceof SInvoiceError && /NOT_FOUND|KHONG_TON_TAI|NOT_EXIST/i.test(err.code)) return null;
      throw err;
    }
    const raw = answer.result;
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Array<Record<string, unknown>>;
    const found = list.find((r) => typeof r.invoiceNo === 'string' && r.invoiceNo);
    if (!found) return null;
    const issued = Number(found.issueDate ?? found.invoiceIssuedDate);
    return recordFrom(found, this.cfg, transactionUuid, Number.isFinite(issued) && issued > 0 ? issued : Date.now());
  }

  async pdf(record: EInvoiceRecord): Promise<Uint8Array> {
    const answer = await this.call('InvoiceAPI/InvoiceUtilsWS/getInvoiceRepresentationFile', {
      json: { supplierTaxCode: record.supplierTaxCode, invoiceNo: record.invoiceNo, templateCode: record.templateCode, fileType: 'PDF' },
    });
    const bytes = typeof answer.fileToBytes === 'string' ? answer.fileToBytes : (answer.result as { fileToBytes?: string } | undefined)?.fileToBytes;
    if (!bytes) throw new SInvoiceError('no_file', 'getInvoiceRepresentationFile returned no file');
    return new Uint8Array(Buffer.from(bytes, 'base64'));
  }

  async cancel(record: EInvoiceRecord, reason: { description: string; at: number }): Promise<void> {
    await this.call('InvoiceAPI/InvoiceWS/cancelTransactionInvoice', {
      form: {
        supplierTaxCode: record.supplierTaxCode,
        templateCode: record.templateCode,
        invoiceNo: record.invoiceNo,
        strIssueDate: viettelDate(record.issuedAt),
        additionalReferenceDesc: reason.description.slice(0, 100),
        additionalReferenceDate: viettelDate(reason.at),
      },
    });
  }

  async replace(original: EInvoiceRecord, e: EInvoice, ctx: { seller: LegalSettings; exchangeRate: number; reason: string; transactionUuid: string }): Promise<EInvoiceRecord> {
    const issuedAt = Date.now();
    const body = sInvoicePayload(e, { exchangeRate: ctx.exchangeRate, templateCode: this.cfg.templateCode, series: this.cfg.series, transactionUuid: ctx.transactionUuid });
    const general = {
      ...body.generalInvoiceInfo,
      adjustmentType: '3',
      originalInvoiceId: original.invoiceNo,
      originalInvoiceIssueDate: original.issuedAt,
      originalTemplateCode: original.templateCode,
      additionalReferenceDesc: ctx.reason.slice(0, 100),
      additionalReferenceDate: issuedAt,
      invoiceNote: `Thay thế cho hóa đơn ${original.invoiceNo}: ${ctx.reason}`.slice(0, 500),
    };
    const answer = await this.call(`InvoiceAPI/InvoiceWS/createInvoice/${encodeURIComponent(this.cfg.taxCode)}`, { json: { ...body, generalInvoiceInfo: general } });
    const result = answer.result as Record<string, unknown> | undefined;
    if (!result || typeof result.invoiceNo !== 'string') throw new SInvoiceError('no_result', 'replacement returned no invoice number');
    return recordFrom(result, this.cfg, ctx.transactionUuid, issuedAt);
  }
}
