import request from 'supertest';
import { SETTINGS, einvoiceAutomatic, VAT_REQUEST_WINDOW_DAYS } from '../src/core/billing-service';
import { ViettelSInvoiceProvider } from '../src/core/einvoice-viettel';
import { setMode, type ProviderMode } from '../src/core/provider-modes';
import { BUYER, WORLDFIRST, billingFixture, workspace } from './helpers/billing-fixture';
import { ORIGIN, cookieFor, hostedBilling } from './helpers/hosted-billing';

const ADM = 'adm.valefront.com';
const VAT = { companyName: 'Công ty TNHH Khách Hàng', taxCode: '0312345678', address: '1 Lê Lợi, Quận 1, TP Hồ Chí Minh', email: 'ketoan@khachhang.vn' };
const LIVE_ENV = {
  VIETTEL_SINVOICE_LIVE_USERNAME: 'u', VIETTEL_SINVOICE_LIVE_PASSWORD: 'pw-secret', VIETTEL_SINVOICE_LIVE_TAX_CODE: '0402339145',
  VIETTEL_SINVOICE_LIVE_TEMPLATE_CODE: '1/0353', VIETTEL_SINVOICE_LIVE_SERIES: 'C26TAY',
};
const FAKE_PDF = new Uint8Array(Buffer.from('%PDF-1.4 issued by hand'));

/** S-Invoice's API, counting every call: none may happen while S-Invoice isn't usable. */
function viettel() {
  const calls: string[] = [];
  let n = 1;
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    calls.push(path);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (path.endsWith('getAllInvoiceTemplates')) return json({ template: [{ templateCode: '1/0353', invoiceSeri: 'C26TAY' }] });
    if (path.includes('/createInvoice/')) return json({ result: { invoiceNo: `C26TAY${n++}`, reservationCode: 'CODE', codeOfTax: null, transactionUuid: JSON.parse(String(init.body)).generalInvoiceInfo.transactionUuid } });
    if (path.endsWith('getInvoiceRepresentationFile')) return json({ fileToBytes: Buffer.from('%PDF-viettel').toString('base64') });
    return json({ result: [] });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** The einvoice factory as the Worker makes it, over an env the test can change. */
function sinvoice(env: Record<string, string | undefined>, fetchImpl: typeof fetch) {
  return (mode: ProviderMode) => ViettelSInvoiceProvider.forMode(env, mode, fetchImpl);
}

async function vnBuyer(f: { store: ReturnType<typeof billingFixture>['store']; service: ReturnType<typeof billingFixture>['service'] }, opts: { details?: boolean } = {}) {
  await f.store.saveSetting(SETTINGS.account, WORLDFIRST, 'a');
  await f.store.saveSetting(SETTINGS.exchangeRate, { vndPerUsd: 25500, date: '2026-11-07' }, 'a');
  const ws = await workspace(f.store);
  await f.service.saveProfile(ws, { ...BUYER, name: 'Nguyễn Văn A', country: 'VN' });
  if (opts.details !== false) await f.service.saveVatInvoiceDetails(ws, VAT);
  return ws;
}

const key = () => `k-${Math.random().toString(36).slice(2, 12)}`;
const audits = (f: { db: ReturnType<typeof billingFixture>['db'] }, type: string) =>
  (f.db.sqlite.prepare('SELECT meta FROM audit_events WHERE type = ?').all(type) as Array<{ meta: string }>).map((r) => JSON.parse(r.meta));

describe('is S-Invoice usable (automatic VAT invoices)?', () => {
  it('sandbox: always automatic, as before; live: only with every required live secret', () => {
    expect(einvoiceAutomatic('sandbox', false)).toBe(true);
    expect(einvoiceAutomatic('sandbox', true)).toBe(true);
    expect(einvoiceAutomatic('live', true)).toBe(true);
    expect(einvoiceAutomatic('live', false)).toBe(false);
  });

  it('follows the admin switch and the live secrets (BASE_URL is optional)', async () => {
    const v = viettel();
    const env: Record<string, string | undefined> = { ...LIVE_ENV, VIETTEL_SINVOICE_LIVE_PASSWORD: undefined };
    const f = billingFixture({ einvoice: (m) => sinvoice(env, v.fetchImpl)(m) });
    expect(await f.service.einvoiceIsAutomatic()).toBe(true);
    await setMode(f.store, 'sinvoice', 'live', { by: 'owner', confirm: 'LIVE' });
    expect(await f.service.einvoiceIsAutomatic()).toBe(false);
    env.VIETTEL_SINVOICE_LIVE_PASSWORD = 'pw-secret';
    expect(await f.service.einvoiceIsAutomatic()).toBe(true);
    expect(v.calls).toHaveLength(0);
  });
});

describe('VAT invoices while S-Invoice is live but not set up', () => {
  async function liveUnconfigured() {
    const v = viettel();
    const env: Record<string, string | undefined> = { ...LIVE_ENV, VIETTEL_SINVOICE_LIVE_SERIES: '' };
    const f = billingFixture({ einvoice: (m) => sinvoice(env, v.fetchImpl)(m) });
    await setMode(f.store, 'sinvoice', 'live', { by: 'owner', confirm: 'LIVE' });
    const ws = await vnBuyer(f);
    return { ...f, v, env, ws };
  }

  it('a paid order with "I need a VAT invoice" records a request: no call to Viettel, nothing retried, the receipt as usual', async () => {
    const f = await liveUnconfigured();
    const { order } = await f.service.createOrder(f.ws, { amountCents: 1000, method: 'worldfirst', idempotencyKey: key(), vatInvoice: true });
    await f.service.markPaid(order.id, { by: 'admin' });
    const e = (await f.store.einvoiceForOrder(order.id))!;
    expect(e).toMatchObject({ status: 'requested', manual: true, details: VAT, totalCents: 1100 });
    expect(f.v.calls).toHaveLength(0);
    expect(f.emails.map((m) => m.subject)).toEqual([expect.stringContaining('Your Valefront receipt')]);
    expect(await f.service.processPendingEinvoices()).toBe(0);
    await f.service.markPaid(order.id, { by: 'admin' });
    expect((await f.store.einvoice(e.id))!.status).toBe('requested');
    expect(audits(f, 'billing.einvoice_requested')).toEqual([{ orderId: order.id, via: 'checkout', manual: true }]);
    expect((await f.service.overview(f.ws)).einvoices[0]).toMatchObject({ status: 'requested', manual: true, file: false });
    expect((await f.service.overview(f.ws)).vatInvoices).toEqual({ automatic: false, requestWindowDays: 30 });

    // Set up later: new orders are automatic again; the request stays manual.
    f.env.VIETTEL_SINVOICE_LIVE_SERIES = 'C26TAY';
    expect(await f.service.processPendingEinvoices()).toBe(0);
    expect((await f.store.einvoice(e.id))!.status).toBe('requested');
    expect(f.v.calls.filter((c) => c.includes('createInvoice'))).toHaveLength(0);
    const next = (await f.service.createOrder(f.ws, { amountCents: 2000, method: 'worldfirst', idempotencyKey: key(), vatInvoice: true })).order;
    await f.service.markPaid(next.id, { by: 'admin' });
    expect((await f.store.einvoiceForOrder(next.id))!).toMatchObject({ status: 'issued', manual: false });
    expect(f.v.calls.filter((c) => c.includes('createInvoice'))).toHaveLength(1);
  });

  it('a pending one from before (live, not set up) becomes a request instead of waiting forever', async () => {
    const f = await liveUnconfigured();
    const { order } = await f.service.createOrder(f.ws, { amountCents: 1000, method: 'worldfirst', idempotencyKey: key(), vatInvoice: true });
    await f.store.markPaid(order.id, { at: f.clock.now, by: 'old-code', seller: await f.service.seller() });
    expect((await f.store.einvoiceForOrder(order.id))!.status).toBe('pending');
    await f.service.processPendingEinvoices();
    expect((await f.store.einvoiceForOrder(order.id))!).toMatchObject({ status: 'requested', manual: true });
    expect(f.v.calls).toHaveLength(0);
  });

  it('sandbox mode is unchanged: not configured, it waits as pending (automatic)', async () => {
    const f = billingFixture({ einvoice: () => null });
    const ws = await vnBuyer(f);
    const { order } = await f.service.createOrder(ws, { amountCents: 1000, method: 'worldfirst', idempotencyKey: key(), vatInvoice: true });
    f.db.sqlite.prepare("UPDATE billing_orders SET mode = 'sandbox' WHERE id = ?").run(order.id);
    await f.service.markPaid(order.id, { by: 'a' });
    expect((await f.store.einvoiceForOrder(order.id))!).toMatchObject({ status: 'pending', manual: false });
  });
});

describe('asking for a VAT invoice after payment (dash) and issuing it by hand (adm)', () => {
  async function setup() {
    const v = viettel();
    const env: Record<string, string | undefined> = {};
    const h = hostedBilling({ billing: { einvoice: (m) => sinvoice(env, v.fetchImpl)(m) } });
    await setMode(h.store, 'sinvoice', 'live', { by: 'owner', confirm: 'LIVE' });
    const ws = await vnBuyer(h);
    const cookie = cookieFor(ws.ownerSub, ws.email);
    const paid = async (vatInvoice = false) => {
      const { order } = await h.service.createOrder(ws, { amountCents: 1000, method: 'worldfirst', idempotencyKey: key(), vatInvoice });
      await h.service.markPaid(order.id, { by: 'admin' });
      return order;
    };
    const ask = (orderId: string, c = cookie) => request(h.app).post(`/dashboard/me/billing/orders/${orderId}/vat-invoice`).set('Cookie', c).set('Origin', ORIGIN).send({});
    const jwt = h.access.token({ email: 'owner@valefront.com' });
    const adm = (path: string, body: Record<string, string>) => request(h.app).post(`/billing${path}`).set('Host', ADM).set('Origin', `https://${ADM}`).set('Cf-Access-Jwt-Assertion', jwt).type('form').send(body);
    return { ...h, v, env, ws, cookie, paid, ask, adm, jwt };
  }

  it('only the workspace\'s own paid orders, once per order, within 30 days; needs the saved details', async () => {
    const h = await setup();
    const order = await h.paid();
    // Another workspace's order: not found.
    const other = await workspace(h.store);
    expect((await h.ask(order.id, cookieFor(other.ownerSub, other.email))).status).toBe(404);
    expect((await h.ask('ord_nope')).status).toBe(404);
    // Not paid yet.
    const pending = (await h.service.createOrder(h.ws, { amountCents: 1000, method: 'worldfirst', idempotencyKey: key() })).order;
    expect((await h.ask(pending.id)).body.error.code).toBe('order_not_paid');
    const first = await h.ask(order.id);
    expect(first.status).toBe(200);
    expect(first.body.einvoice).toMatchObject({ orderId: order.id, status: 'requested', manual: true });
    const again = await h.ask(order.id);
    expect(again.body.einvoice.id).toBe(first.body.einvoice.id);
    expect(audits(h, 'billing.einvoice_requested')).toEqual([{ orderId: order.id, via: 'customer', manual: true }]);
    expect(h.v.calls).toHaveLength(0);
    const billing = (await request(h.app).get('/dashboard/me/billing').set('Cookie', h.cookie)).body;
    expect(billing.orders.find((o: { id: string }) => o.id === order.id)).toMatchObject({ vatInvoice: true, vatInvoiceRequestable: false });
    expect(billing.einvoices[0]).toMatchObject({ orderId: order.id, status: 'requested' });
    // Past the window.
    const late = await h.paid();
    h.clock.now += (VAT_REQUEST_WINDOW_DAYS + 1) * 86_400_000;
    expect((await h.ask(late.id)).body.error.code).toBe('vat_invoice_window_closed');
  });

  it('asks for the VAT details first when none are saved', async () => {
    const v = viettel();
    const h = hostedBilling({ billing: { einvoice: (m) => sinvoice({}, v.fetchImpl)(m) } });
    await setMode(h.store, 'sinvoice', 'live', { by: 'owner', confirm: 'LIVE' });
    const ws = await vnBuyer(h, { details: false });
    const { order } = await h.service.createOrder(ws, { amountCents: 1000, method: 'worldfirst', idempotencyKey: key() });
    await h.service.markPaid(order.id, { by: 'admin' });
    const cookie = cookieFor(ws.ownerSub, ws.email);
    const res = await request(h.app).post(`/dashboard/me/billing/orders/${order.id}/vat-invoice`).set('Cookie', cookie).set('Origin', ORIGIN).send({});
    expect(res.body.error.code).toBe('vat_invoice_details_required');
    expect((await request(h.app).get('/dashboard/me/billing').set('Cookie', cookie)).body.orders[0].vatInvoiceRequestable).toBe(true);
  });

  it('admin: listed with the buyer\'s details and VND; marked issued with a PDF, emailed, downloadable', async () => {
    const h = await setup();
    const order = await h.paid(true);
    const e = (await h.store.einvoiceForOrder(order.id))!;
    const page = await request(h.app).get('/billing/').set('Host', ADM).set('Cf-Access-Jwt-Assertion', h.jwt);
    expect(page.text).toContain('VAT invoice requests (issued by hand) (1)');
    expect(page.text).toContain('MST 0312345678');
    expect(page.text).toContain('280,500 VND at 25500');
    expect(page.text).toContain(`/billing/einvoices/${e.id}/issue-manually`);
    const api = await request(h.app).get('/billing/api/einvoice-requests').set('Host', ADM).set('Cf-Access-Jwt-Assertion', h.jwt);
    expect(api.body.requests[0]).toMatchObject({ id: e.id, reference: order.reference, totalCents: 1100, totalVnd: 280500, details: VAT });

    expect(decodeURIComponent((await h.adm(`/einvoices/${e.id}/issue-manually`, { invoiceNo: '' })).headers.location)).toContain('invoice number');
    expect(decodeURIComponent((await h.adm(`/einvoices/${e.id}/issue-manually`, { invoiceNo: 'C26TAA12', pdfBase64: Buffer.from('not a pdf').toString('base64') })).headers.location)).toContain('must be a PDF');
    const ok = await h.adm(`/einvoices/${e.id}/issue-manually`, { invoiceNo: 'C26TAA12', lookupCode: 'LOOK123', codeOfTax: 'M1-26', lookupUrl: 'https://vinvoice.viettel.vn/utilities/invoice-search', pdfBase64: Buffer.from(FAKE_PDF).toString('base64') });
    expect(decodeURIComponent(ok.headers.location)).toContain('C26TAA12 recorded');
    const issued = (await h.store.einvoice(e.id))!;
    expect(issued).toMatchObject({ status: 'issued', manual: true, resolvedBy: 'owner@valefront.com', emailStatus: 'sent', record: { provider: 'manual', invoiceNo: 'C26TAA12', reservationCode: 'LOOK123' } });
    const mail = h.emails.find((m) => m.subject.includes('C26TAA12'))!;
    expect(mail.to).toBe(VAT.email);
    expect(mail.text).toContain('LOOK123');
    expect(Buffer.from(mail.attachments[0]!.content).toString()).toContain('issued by hand');
    expect(audits(h, 'billing.einvoice_issued')).toEqual([{ orderId: order.id, invoiceNo: 'C26TAA12', manual: true, pdf: true, by: 'owner@valefront.com' }]);
    // Twice: nothing changes, no second email.
    expect(decodeURIComponent((await h.adm(`/einvoices/${e.id}/issue-manually`, { invoiceNo: 'C26TAA13' })).headers.location)).toContain('Already issued as C26TAA12');
    expect(h.emails.filter((m) => m.subject.includes('VAT invoice'))).toHaveLength(1);
    // Customer: the file.
    const billing = (await request(h.app).get('/dashboard/me/billing').set('Cookie', h.cookie)).body;
    expect(billing.einvoices[0]).toMatchObject({ status: 'issued', invoiceNo: 'C26TAA12', reservationCode: 'LOOK123', file: true });
    const pdf = await request(h.app).get(`/dashboard/me/billing/einvoices/${e.id}.pdf`).set('Cookie', h.cookie).buffer(true).parse((res, cb) => { const b: Buffer[] = []; res.on('data', (c: Buffer) => b.push(c)); res.on('end', () => cb(null, Buffer.concat(b))); });
    expect(pdf.status).toBe(200);
    expect(Buffer.from(pdf.body).toString()).toContain('issued by hand');
    // Never sent to Viettel, and Viettel can't cancel one issued by hand.
    expect(h.v.calls).toHaveLength(0);
    expect(decodeURIComponent((await h.adm(`/einvoices/${e.id}/cancel`, { description: 'x' })).headers.location)).toContain('issued by hand');
  });

  it('admin: issued without a PDF shows the number and lookup code; reject shows why, and the buyer may ask again', async () => {
    const h = await setup();
    const a = await h.paid();
    const ea = (await h.ask(a.id)).body.einvoice.id as string;
    await h.adm(`/einvoices/${ea}/issue-manually`, { invoiceNo: 'C26TAA20', lookupCode: 'XYZ' });
    let billing = (await request(h.app).get('/dashboard/me/billing').set('Cookie', h.cookie)).body;
    expect(billing.einvoices.find((i: { id: string }) => i.id === ea)).toMatchObject({ status: 'issued', invoiceNo: 'C26TAA20', reservationCode: 'XYZ', file: false, lookupUrl: 'https://vinvoice.viettel.vn/utilities/invoice-search' });
    const noFile = await request(h.app).get(`/dashboard/me/billing/einvoices/${ea}.pdf`).set('Cookie', h.cookie);
    expect(noFile.status).toBe(404);
    expect(noFile.body.error.code).toBe('einvoice_no_file');
    expect(h.emails.find((m) => m.subject.includes('C26TAA20'))!.attachments).toHaveLength(0);

    const b = await h.paid();
    const eb = (await h.ask(b.id)).body.einvoice.id as string;
    expect(decodeURIComponent((await h.adm(`/einvoices/${eb}/reject`, { reason: '' })).headers.location)).toContain('reason');
    await h.adm(`/einvoices/${eb}/reject`, { reason: 'Tax code does not match the company name' });
    expect(audits(h, 'billing.einvoice_rejected')).toEqual([{ orderId: b.id, by: 'owner@valefront.com', reason: 'Tax code does not match the company name' }]);
    expect(decodeURIComponent((await h.adm(`/einvoices/${eb}/issue-manually`, { invoiceNo: 'C1' })).headers.location)).toContain('not waiting');
    billing = (await request(h.app).get('/dashboard/me/billing').set('Cookie', h.cookie)).body;
    expect(billing.einvoices.find((i: { id: string }) => i.id === eb)).toMatchObject({ status: 'rejected', rejectReason: 'Tax code does not match the company name' });
    expect(billing.orders.find((o: { id: string }) => o.id === b.id).vatInvoiceRequestable).toBe(true);
    expect((await h.ask(b.id)).body.einvoice).toMatchObject({ id: eb, status: 'requested' });
    expect(h.v.calls).toHaveLength(0);
  });
});
