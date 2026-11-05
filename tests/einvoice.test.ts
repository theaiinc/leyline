import { SETTINGS } from '../src/core/billing-service';
import { EINVOICE_ISSUING_STALE_MS } from '../src/core/billing-store';
import { INVOICE_LOOKUP_URL, ViettelSInvoiceProvider, sInvoicePayload, viettelConfigFor } from '../src/core/einvoice-viettel';
import { setMode } from '../src/core/provider-modes';
import { BUYER, WORLDFIRST, billingFixture, workspace } from './helpers/billing-fixture';

const FAKE_PDF = Buffer.from('%PDF-1.4 viettel invoice').toString('base64');
const VAT = { companyName: 'Công ty TNHH Khách Hàng', taxCode: '0312345678', address: '1 Lê Lợi, Quận 1, TP Hồ Chí Minh', email: 'ketoan@khachhang.vn' };

type Call = { path: string; headers: Record<string, string>; body: string };

/** Viettel S-Invoice as verified against its sandbox: Basic auth, 400 {code, message, data} errors. */
function fakeViettel(opts: { templates?: Array<{ templateCode: string; invoiceSeri: string }> } = {}) {
  const calls: Call[] = [];
  const state = { createFails: 0, createHangs: false, made: new Map<string, string>(), n: 50 };
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call: Call = { path: url.pathname, headers: (init.headers ?? {}) as Record<string, string>, body: String(init.body ?? '') };
    calls.push(call);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    if (call.headers.Authorization !== `Basic ${Buffer.from('0100109106-505:pw').toString('base64')}`) return json(401, { code: 401, message: 'UNAUTHORIZED' });
    const p = url.pathname.replace('/services/einvoiceapplication/api/', '');
    if (p === 'InvoiceAPI/InvoiceUtilsWS/getAllInvoiceTemplates') return json(200, { template: opts.templates ?? [{ templateCode: '1/0353', invoiceSeri: 'C26TAY' }, { templateCode: '1/0354', invoiceSeri: 'C26TAI' }] });
    if (p.startsWith('InvoiceAPI/InvoiceWS/createInvoice/')) {
      const uuid = JSON.parse(call.body).generalInvoiceInfo.transactionUuid as string;
      if (state.createFails > 0) { state.createFails--; return json(400, { code: 400, message: 'INVOICE_SERIAL_NOT_FOUND', data: 'Ký hiệu hóa đơn không tồn tại' }); }
      const no = `C26TAY${state.n++}`;
      state.made.set(uuid, no);
      if (state.createHangs) throw new Error('socket hang up');
      return json(200, { result: { invoiceNo: no, transactionID: `T${no}`, reservationCode: '3M9E3EHAYCQBSF0', codeOfTax: 'M1-26-ABCDE-00000000543' } });
    }
    if (p === 'InvoiceAPI/InvoiceWS/searchInvoiceByTransactionUuid') {
      const uuid = new URLSearchParams(call.body).get('transactionUuid')!;
      const no = state.made.get(uuid);
      return no ? json(200, { result: [{ invoiceNo: no, transactionID: `T${no}`, reservationCode: '3M9E3EHAYCQBSF0', codeOfTax: 'M1-26-ABCDE-00000000543' }] }) : json(200, { result: [] });
    }
    if (p === 'InvoiceAPI/InvoiceUtilsWS/getInvoiceRepresentationFile') return json(200, { fileToBytes: FAKE_PDF, fileName: 'x.pdf' });
    if (p === 'InvoiceAPI/InvoiceWS/cancelTransactionInvoice') return json(200, { errorCode: null, description: 'CANCEL TRANSACTION INVOICE SUCCESS' });
    return json(404, { code: 404, message: 'NOT_FOUND' });
  }) as typeof fetch;
  return { calls, state, fetchImpl, creates: () => calls.filter((c) => c.path.includes('/createInvoice/')) };
}

const SANDBOX_ENV = {
  VIETTEL_SINVOICE_SANDBOX_USERNAME: '0100109106-505', VIETTEL_SINVOICE_SANDBOX_PASSWORD: 'pw', VIETTEL_SINVOICE_SANDBOX_TAX_CODE: '0100109106-505',
  VIETTEL_SINVOICE_SANDBOX_TEMPLATE_CODE: '1/0353', VIETTEL_SINVOICE_SANDBOX_SERIES: 'C26TAY',
};

async function setup(opts: { configured?: boolean; env?: Record<string, string>; templates?: Array<{ templateCode: string; invoiceSeri: string }>; liveOrder?: boolean } = {}) {
  const v = fakeViettel({ templates: opts.templates });
  const env = opts.env ?? SANDBOX_ENV;
  const providers = new Map<string, ViettelSInvoiceProvider | null>();
  const f = billingFixture({ einvoice: (mode) => {
    if (opts.configured === false) return null;
    if (!providers.has(mode)) providers.set(mode, ViettelSInvoiceProvider.forMode(env, mode, v.fetchImpl));
    return providers.get(mode)!;
  } });
  await f.store.saveSetting(SETTINGS.account, WORLDFIRST, 'a');
  await f.store.saveSetting(SETTINGS.exchangeRate, { vndPerUsd: 25500, date: '2026-11-07' }, 'a');
  const ws = await workspace(f.store);
  await f.service.saveProfile(ws, { ...BUYER, name: 'Nguyễn Văn A', country: 'VN' });
  await f.service.saveVatInvoiceDetails(ws, VAT);
  // Bank transfers are live payments; to test against Viettel's sandbox, the order is marked a sandbox one.
  const { order } = await f.service.createOrder(ws, { amountCents: 1050, method: 'worldfirst', idempotencyKey: `vat-${Math.random().toString(36).slice(2, 10)}`, vatInvoice: true });
  if (!opts.liveOrder) f.db.sqlite.prepare("UPDATE billing_orders SET mode = 'sandbox' WHERE id = ?").run(order.id);
  return { ...f, v, ws, order };
}

describe('Vietnamese VAT e-invoice through Viettel S-Invoice (mocked)', () => {
  it('only a buyer in Vietnam who asked gets one; others get just the receipt', async () => {
    const f = billingFixture();
    await f.store.saveSetting(SETTINGS.account, WORLDFIRST, 'a');
    const ws = await workspace(f.store);
    await f.service.saveProfile(ws, BUYER);
    await expect(f.service.saveVatInvoiceDetails(ws, VAT)).rejects.toThrow('customers in Vietnam');
    await expect(f.service.createOrder(ws, { amountCents: 1000, method: 'worldfirst', idempotencyKey: 'novat-0001', vatInvoice: true })).rejects.toThrow('customers in Vietnam');
    const { order } = await f.service.createOrder(ws, { amountCents: 1000, method: 'worldfirst', idempotencyKey: 'novat-0002' });
    await f.service.markPaid(order.id, { by: 'a' });
    expect(await f.store.einvoiceForOrder(order.id)).toBeNull();
    expect(await f.store.receiptForOrder(order.id)).not.toBeNull();
  });

  it('issues it with the right request: Basic auth, template + series, USD with cents and the exchange rate, the buyer, VAT 10%', async () => {
    const f = await setup();
    await setMode(f.store, 'sinvoice', 'sandbox', { by: 'owner' });
    await f.service.markPaid(f.order.id, { by: 'a' });
    const e = (await f.store.einvoiceForOrder(f.order.id))!;
    expect(e.status).toBe('issued');
    expect(e.record).toMatchObject({ invoiceNo: 'C26TAY50', reservationCode: '3M9E3EHAYCQBSF0', codeOfTax: 'M1-26-ABCDE-00000000543', transactionUuid: e.id, templateCode: '1/0353', series: 'C26TAY', supplierTaxCode: '0100109106-505' });
    const create = f.v.creates()[0]!;
    expect(create.path).toBe('/services/einvoiceapplication/api/InvoiceAPI/InvoiceWS/createInvoice/0100109106-505');
    const body = JSON.parse(create.body);
    expect(body.generalInvoiceInfo).toEqual({ invoiceType: '1', templateCode: '1/0353', invoiceSeries: 'C26TAY', currencyCode: 'USD', exchangeRate: 25500, adjustmentType: '1', paymentStatus: true, cusGetInvoiceRight: true, transactionUuid: e.id });
    expect(body.buyerInfo).toEqual({ buyerName: VAT.companyName, buyerLegalName: VAT.companyName, buyerTaxCode: '0312345678', buyerAddressLine: VAT.address, buyerEmail: VAT.email, buyerNotGetInvoice: '0' });
    expect(body.payments).toEqual([{ paymentMethod: '2', paymentMethodName: 'CK' }]);
    // $10.50 credit + 10% VAT: cents survive the trip.
    expect(body.itemInfo[0]).toMatchObject({ quantity: 1, unitPrice: 10.5, itemTotalAmountWithoutTax: 10.5, itemTotalAmountAfterDiscount: 10.5, taxPercentage: 10, taxAmount: 1.05, itemTotalAmountWithTax: 11.55 });
    expect(body.summarizeInfo).toEqual({ sumOfTotalLineAmountWithoutTax: 10.5, totalAmountAfterDiscount: 10.5, totalAmountWithoutTax: 10.5, totalTaxAmount: 1.05, totalAmountWithTax: 11.55, discountAmount: 0 });
    expect(body.taxBreakdowns).toEqual([{ taxPercentage: 10, taxableAmount: 10.5, taxAmount: 1.05 }]);
    expect(Math.round(body.summarizeInfo.totalAmountWithTax * 100)).toBe(e.totalCents);
    // Emailed once, with Viettel's PDF and the lookup code.
    const mail = f.emails.find((m) => m.subject.includes('VAT invoice'))!;
    expect(mail).toMatchObject({ to: 'ketoan@khachhang.vn', subject: '[SANDBOX] Hóa đơn GTGT / Your Vietnamese VAT invoice C26TAY50' });
    expect(mail.text).toContain('3M9E3EHAYCQBSF0');
    expect(mail.text).toContain(INVOICE_LOOKUP_URL);
    expect(Buffer.from(mail.attachments[0]!.content).toString()).toContain('viettel invoice');
    await f.service.processPendingEinvoices();
    await f.service.processEinvoice(e.id);
    expect(f.emails.filter((m) => m.subject.includes('VAT invoice'))).toHaveLength(1);
    expect(f.v.creates()).toHaveLength(1);
  });

  it('waits as pending until S-Invoice is configured, then the retry job issues it', async () => {
    const f = await setup({ configured: false });
    await f.service.markPaid(f.order.id, { by: 'a' });
    let e = (await f.store.einvoiceForOrder(f.order.id))!;
    expect(e.status).toBe('pending');
    expect(e.lastError).toContain('not configured');
    const billing = await f.service.overview(f.ws);
    expect(billing.einvoices[0]).toMatchObject({ status: 'pending', invoiceNo: null });
    // Configured now (secrets set): the job picks it up.
    (f.service.opts as { einvoice: unknown }).einvoice = (mode: 'sandbox' | 'live') => ViettelSInvoiceProvider.forMode(SANDBOX_ENV, mode, f.v.fetchImpl);
    expect(await f.service.processPendingEinvoices()).toBe(1);
    e = (await f.store.einvoiceForOrder(f.order.id))!;
    expect(e.status).toBe('issued');
  });

  it('a real (live) payment never gets a sandbox e-invoice: it waits for live mode', async () => {
    const f = await setup({ liveOrder: true });
    await f.service.markPaid(f.order.id, { by: 'a' });
    const e = (await f.store.einvoiceForOrder(f.order.id))!;
    expect(e.status).toBe('pending');
    expect(e.lastError).toContain('sandbox mode');
    expect(f.v.creates()).toHaveLength(0);
  });

  it('a Viettel error leaves it pending with the reason; the next run issues it', async () => {
    const f = await setup();
    f.v.state.createFails = 1;
    await f.service.markPaid(f.order.id, { by: 'a' });
    let e = (await f.store.einvoiceForOrder(f.order.id))!;
    expect(e.status).toBe('pending');
    expect(e.lastError).toBe('S-Invoice INVOICE_SERIAL_NOT_FOUND: Ký hiệu hóa đơn không tồn tại');
    expect(e.attempts).toBe(1);
    await f.service.processPendingEinvoices();
    e = (await f.store.einvoiceForOrder(f.order.id))!;
    expect(e.status).toBe('issued');
    expect(e.attempts).toBe(2);
  });

  it('idempotent per payment: after a timeout the retry finds the invoice by transactionUuid instead of making a second', async () => {
    const f = await setup();
    f.v.state.createHangs = true;
    await f.service.markPaid(f.order.id, { by: 'a' });
    let e = (await f.store.einvoiceForOrder(f.order.id))!;
    expect(e.status).toBe('pending');
    expect(e.lastError).toContain('network');
    f.v.state.createHangs = false;
    await f.service.processPendingEinvoices();
    e = (await f.store.einvoiceForOrder(f.order.id))!;
    expect(e.status).toBe('issued');
    expect(f.v.creates()).toHaveLength(1);
    expect(f.v.calls.some((c) => c.path.endsWith('/searchInvoiceByTransactionUuid') && new URLSearchParams(c.body).get('transactionUuid') === e.id)).toBe(true);
    expect(e.record!.invoiceNo).toBe('C26TAY50');
  });

  it('never sends two requests for one e-invoice at once; a stuck attempt is retried after it times out', async () => {
    const f = await setup({ configured: false });
    await f.service.markPaid(f.order.id, { by: 'a' });
    const e = (await f.store.einvoiceForOrder(f.order.id))!;
    expect(await f.store.claimEinvoice(e.id)).toBe(true);
    expect(await f.store.claimEinvoice(e.id)).toBe(false);
    expect(await f.store.einvoicesToIssue()).toHaveLength(0);
    f.clock.now += EINVOICE_ISSUING_STALE_MS + 1;
    expect((await f.store.einvoicesToIssue()).map((x) => x.id)).toEqual([e.id]);
  });

  it('checks the configured template + series against the account and says what it has', async () => {
    const f = await setup({ env: { ...SANDBOX_ENV, VIETTEL_SINVOICE_SANDBOX_SERIES: 'C26TAI' } });
    await f.service.markPaid(f.order.id, { by: 'a' });
    const e = (await f.store.einvoiceForOrder(f.order.id))!;
    expect(e.status).toBe('pending');
    expect(e.lastError).toContain('Template 1/0353 with series C26TAI is not on this S-Invoice account. It has: 1/0353 + C26TAY, 1/0354 + C26TAI.');
    expect(f.v.creates()).toHaveLength(0);
  });

  it('cancel and replace use the documented calls', async () => {
    const v = fakeViettel();
    const p = ViettelSInvoiceProvider.forMode(SANDBOX_ENV, 'sandbox', v.fetchImpl)!;
    const record = { provider: 'viettel-sinvoice', invoiceNo: 'C26TAY50', transactionUuid: 'u1', templateCode: '1/0353', series: 'C26TAY', supplierTaxCode: '0100109106-505', issuedAt: Date.UTC(2026, 10, 7, 3) };
    await p.cancel(record, { description: 'Biên bản hủy 01', at: Date.UTC(2026, 10, 8, 3) });
    const cancel = new URLSearchParams(v.calls[v.calls.length - 1]!.body);
    expect(Object.fromEntries(cancel)).toEqual({ supplierTaxCode: '0100109106-505', templateCode: '1/0353', invoiceNo: 'C26TAY50', strIssueDate: '20261107100000', additionalReferenceDesc: 'Biên bản hủy 01', additionalReferenceDate: '20261108100000' });
    const e = { id: 'u2', orderId: 'o', receiptId: 'r', workspaceId: 'w', mode: 'sandbox' as const, status: 'issued' as const, details: VAT, amountCents: 1000, vatRateBp: 1000, vatCents: 100, totalCents: 1100, currency: 'USD' as const, paidAt: 1, attempts: 1, createdAt: 1 };
    const next = await p.replace(record, e, { seller: { companyName: 'X', taxCode: '1', address: 'a', email: 'e' }, exchangeRate: 25500, reason: 'Sai MST', transactionUuid: 'u3' });
    expect(next.transactionUuid).toBe('u3');
    const general = JSON.parse(v.creates()[v.creates().length - 1]!.body).generalInvoiceInfo;
    expect(general).toMatchObject({ adjustmentType: '3', originalInvoiceId: 'C26TAY50', originalTemplateCode: '1/0353', transactionUuid: 'u3' });
  });

  it('per-mode secrets; nothing without all of them', () => {
    expect(viettelConfigFor(SANDBOX_ENV, 'sandbox')).toMatchObject({ apiBase: 'https://api-vinvoice.viettel.vn/services/einvoiceapplication/api', templateCode: '1/0353' });
    expect(viettelConfigFor(SANDBOX_ENV, 'live')).toBeNull();
    const { VIETTEL_SINVOICE_SANDBOX_SERIES: _s, ...missing } = SANDBOX_ENV;
    expect(viettelConfigFor(missing, 'sandbox')).toBeNull();
    const payload = sInvoicePayload({ id: 'x', orderId: 'o', receiptId: 'r', workspaceId: 'w', mode: 'live', status: 'pending', details: VAT, amountCents: 1000, vatRateBp: 0, vatCents: 0, totalCents: 1000, currency: 'USD', paidAt: 1, attempts: 0, createdAt: 1 }, { exchangeRate: 25500, templateCode: '1/0353', series: 'C26TAY', transactionUuid: 'x' });
    expect(payload.itemInfo[0]!.unitPrice).toBe(10);
  });
});
