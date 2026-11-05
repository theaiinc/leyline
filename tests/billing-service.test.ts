import { SETTINGS } from '../src/core/billing-service';
import { PayPalClient } from '../src/core/paypal';
import { setMode } from '../src/core/provider-modes';
import { BUYER, WORLDFIRST, billingFixture, pdfText, workspace } from './helpers/billing-fixture';

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

/** A fake PayPal API: records calls, answers from handlers keyed by path. */
function fakePayPal(handlers: Record<string, (call: Call) => { status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const call: Call = { url, method: init.method ?? 'GET', headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)), body: String(init.body ?? '') };
    calls.push(call);
    const path = new URL(url).pathname;
    if (path === '/v1/oauth2/token') return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    const key = Object.keys(handlers).find((k) => new RegExp(`^${k}$`).test(`${call.method} ${path}`));
    if (!key) return new Response('{}', { status: 404 });
    const out = handlers[key]!(call);
    return new Response(JSON.stringify(out.body), { status: out.status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const capturedBody = (orderId: string, paypalOrderId: string, value: string, captureId = 'CAP-1') => ({
  id: paypalOrderId, status: 'COMPLETED',
  purchase_units: [{ payments: { captures: [{ id: captureId, status: 'COMPLETED', amount: { currency_code: 'USD', value }, custom_id: orderId }] } }],
});

async function paypalSetup(opts: { admin?: boolean; mode?: 'sandbox' | 'live' } = {}) {
  let created = 0;
  const pp = fakePayPal({
    'POST /v2/checkout/orders': (c) => {
      created++;
      const body = JSON.parse(c.body);
      return { status: 201, body: { id: `PP-${body.purchase_units[0].custom_id.slice(-6)}`, links: [{ rel: 'payer-action', href: 'https://www.sandbox.paypal.com/checkoutnow?token=x' }] } };
    },
    'POST /v2/checkout/orders/[^/]+/capture': (c) => {
      const id = c.url.split('/').slice(-2)[0]!;
      return { status: 201, body: capturedBody(String(pp.lastOrder), id, pp.value) };
    },
    'POST /v1/notifications/verify-webhook-signature': () => ({ status: 200, body: { verification_status: pp.verify ? 'SUCCESS' : 'FAILURE' } }),
  }) as ReturnType<typeof fakePayPal> & { lastOrder?: string; value: string; verify: boolean };
  pp.value = '25.00';
  pp.verify = true;
  const clients = {
    live: new PayPalClient({ env: 'live', clientId: 'id', clientSecret: 'secret', webhookId: 'WH-LIVE', fetchImpl: pp.fetchImpl }),
    sandbox: new PayPalClient({ env: 'sandbox', clientId: 'sid', clientSecret: 'ssecret', webhookId: 'WH-SBX', fetchImpl: pp.fetchImpl }),
  };
  const f = billingFixture({ paypal: (mode) => clients[mode], isAdminWorkspace: (w) => w.email === 'owner@valefront.com' });
  if ((opts.mode ?? 'live') === 'live') await setMode(f.store, 'paypal', 'live', { by: 'owner@valefront.com', confirm: 'LIVE' });
  const ws = await workspace(f.store, opts.admin ? { email: 'owner@valefront.com' } : {});
  await f.service.saveProfile(ws, BUYER);
  return { ...f, ws, pp, clients, created: () => created };
}

describe('receipts: PDF, email once', () => {
  it('the receipt PDF carries the seller, buyer, amounts, VAT, method and references', async () => {
    const f = billingFixture();
    await f.store.saveSetting(SETTINGS.account, WORLDFIRST, 'a');
    const ws = await workspace(f.store);
    await f.service.saveProfile(ws, { ...BUYER, country: 'VN' });
    const { order } = await f.service.createOrder(ws, { amountCents: 1050, method: 'worldfirst', idempotencyKey: 'pdf-00001' });
    await f.service.markPaid(order.id, { by: 'admin@x', captureId: 'WF-TXN-77' });
    const receipt = (await f.store.receiptForOrder(order.id))!;
    const text = await pdfText((await f.service.pdf('receipt', receipt.id))!);
    for (const want of ['RECEIPT', 'Receipt number: VF-RCT-2026-000001', 'Date: 2026-11-07', 'THE AI TECHNOLOGY COMPANY LIMITED', 'CÔNG TY TNHH CÔNG NGHỆ THE AI',
      'Enterprise / tax code (MST): 0402339145', '35 Thai Phien Street, Hai Chau Ward, Da Nang City, Vietnam', 'info@valefront.com', 'Acme Ltd', 'Tax ID: GB123456789',
      'Valefront prepaid API credit', '$10.50', 'VAT (10%)', '$1.05', '$11.55 USD', 'Bank transfer (WorldFirst)', `Order reference: ${order.reference}`, 'Payment reference: WF-TXN-77']) {
      expect(text).toContain(want);
    }
    expect(text).not.toContain('SANDBOX');
  });

  it('emails the receipt once per payment, even with replays running at the same time', async () => {
    const f = billingFixture();
    await f.store.saveSetting(SETTINGS.account, WORLDFIRST, 'a');
    const ws = await workspace(f.store);
    await f.service.saveProfile(ws, BUYER);
    const { order } = await f.service.createOrder(ws, { amountCents: 2000, method: 'worldfirst', idempotencyKey: 'mail-0001' });
    await Promise.all([1, 2, 3, 4].map(() => f.service.markPaid(order.id, { by: 'admin' })));
    await f.service.markPaid(order.id, { by: 'admin' });
    expect(f.emails).toHaveLength(1);
    const mail = f.emails[0]!;
    expect(mail).toMatchObject({ to: 'ann@example.com', from: { email: 'billing@valefront.com', name: 'Valefront Billing' }, subject: 'Your Valefront receipt VF-RCT-2026-000001' });
    expect(mail.text).toContain('Amount received: $20.00 USD');
    expect(mail.text).toContain('https://dash.valefront.com/billing');
    expect(mail.attachments.map((a) => [a.filename, a.type])).toEqual([['VF-RCT-2026-000001.pdf', 'application/pdf']]);
    expect(await pdfText(mail.attachments[0]!.content)).toContain('VF-RCT-2026-000001');
    expect((await f.store.receiptForOrder(order.id))!.emailStatus).toBe('sent');
  });

  it('a failed email is marked failed and can be resent once', async () => {
    let fail = true;
    const sent: string[] = [];
    const f = billingFixture({ sendEmail: async (m) => { if (fail) throw new Error('smtp down'); sent.push(m.subject); } });
    await f.store.saveSetting(SETTINGS.account, WORLDFIRST, 'a');
    const ws = await workspace(f.store);
    await f.service.saveProfile(ws, BUYER);
    const { order } = await f.service.createOrder(ws, { amountCents: 1000, method: 'worldfirst', idempotencyKey: 'mail-0002' });
    await f.service.markPaid(order.id, { by: 'admin' });
    expect((await f.store.receiptForOrder(order.id))!.emailStatus).toBe('failed');
    await f.service.markPaid(order.id, { by: 'admin' });
    expect(sent).toHaveLength(0);
    fail = false;
    expect(await f.service.resendEmail(order.id)).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

describe('PayPal (mocked API)', () => {
  it('creates the PayPal order for the total with VAT, idempotently, then captures and credits once', async () => {
    const f = await paypalSetup();
    await f.service.saveProfile(f.ws, { ...BUYER, country: 'VN' });
    const a = await f.service.createOrder(f.ws, { amountCents: 2500, method: 'paypal', idempotencyKey: 'pp-000001' });
    expect(a.approveUrl).toContain('paypal.com');
    const create = f.pp.calls.find((c) => c.url.endsWith('/v2/checkout/orders'))!;
    expect(create.url.startsWith('https://api-m.paypal.com/')).toBe(true);
    expect(create.headers['PayPal-Request-Id']).toBe(`create-${a.order.id}`);
    const body = JSON.parse(create.body);
    expect(body.intent).toBe('CAPTURE');
    expect(body.purchase_units[0]).toMatchObject({ custom_id: a.order.id, invoice_id: a.order.reference, amount: { currency_code: 'USD', value: '27.50', breakdown: { item_total: { value: '25.00' }, tax_total: { value: '2.50' } } } });
    expect(body.payment_source.paypal.experience_context.return_url).toBe(`https://dash.valefront.com/billing?paypal=return&order=${a.order.id}`);
    // A double click: the same order back.
    const b = await f.service.createOrder(f.ws, { amountCents: 2500, method: 'paypal', idempotencyKey: 'pp-000001' });
    expect(b.order.id).toBe(a.order.id);

    f.pp.lastOrder = a.order.id;
    f.pp.value = '27.50';
    const paid = await f.service.capturePayPal(f.ws, a.order.id);
    expect(paid.status).toBe('paid');
    await f.service.capturePayPal(f.ws, a.order.id);
    expect((await f.store.balance(f.ws.id)).cents).toBe(2500);
    expect((await f.store.receiptForOrder(a.order.id))).toMatchObject({ providerReference: 'CAP-1', totalCents: 2750, mode: 'live' });
  });

  it('never credits a capture for a different amount', async () => {
    const f = await paypalSetup();
    const { order } = await f.service.createOrder(f.ws, { amountCents: 2500, method: 'paypal', idempotencyKey: 'pp-000002' });
    f.pp.lastOrder = order.id;
    f.pp.value = '2.50';
    await f.service.capturePayPal(f.ws, order.id);
    expect((await f.store.order(order.id))!.status).toBe('pending');
    expect((await f.store.balance(f.ws.id)).cents).toBe(0);
  });

  it('webhook: a bad signature is refused; PAYMENT.CAPTURE.COMPLETED credits once however often it is replayed', async () => {
    const f = await paypalSetup();
    const { order } = await f.service.createOrder(f.ws, { amountCents: 2500, method: 'paypal', idempotencyKey: 'pp-000003' });
    const event = JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-9', status: 'COMPLETED', amount: { currency_code: 'USD', value: '25.00' }, custom_id: order.id, supplementary_data: { related_ids: { order_id: (await f.store.order(order.id))!.providerOrderId } } } });
    const headers = { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.paypal.com/cert', 'paypal-transmission-id': 't1', 'paypal-transmission-sig': 'sig', 'paypal-transmission-time': '2026-11-07T00:00:00Z' };
    f.pp.verify = false;
    expect((await f.service.handlePayPalWebhook(headers, event)).status).toBe(400);
    expect((await f.service.handlePayPalWebhook({}, event)).status).toBe(400);
    expect((await f.store.balance(f.ws.id)).cents).toBe(0);
    f.pp.verify = true;
    const results = await Promise.all([1, 2, 3].map(() => f.service.handlePayPalWebhook(headers, event)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    await f.service.handlePayPalWebhook(headers, event);
    expect((await f.store.balance(f.ws.id)).cents).toBe(2500);
    expect(f.emails).toHaveLength(1);
    // The raw event went to PayPal as it arrived, with our webhook id.
    const verify = f.pp.calls.find((c) => c.url.endsWith('/v1/notifications/verify-webhook-signature'))!;
    expect(verify.body).toContain(`"webhook_event":${event}`);
    expect(JSON.parse(verify.body)).toMatchObject({ webhook_id: 'WH-LIVE', transmission_id: 't1' });
  });

  it('sandbox: only for admin workspaces; receipts marked SANDBOX and numbered apart from real ones', async () => {
    const customer = await paypalSetup({ mode: 'sandbox' });
    expect((await customer.service.methods(customer.ws)).paypal.enabled).toBe(false);
    await expect(customer.service.createOrder(customer.ws, { amountCents: 1000, method: 'paypal', idempotencyKey: 'sbx-00001' })).rejects.toThrow('PayPal is not available');

    const f = await paypalSetup({ mode: 'sandbox', admin: true });
    await f.store.saveSetting(SETTINGS.account, WORLDFIRST, 'a');
    const { order } = await f.service.createOrder(f.ws, { amountCents: 1000, method: 'paypal', idempotencyKey: 'sbx-00002' });
    expect(order.mode).toBe('sandbox');
    expect(f.pp.calls.find((c) => c.url.endsWith('/v2/checkout/orders'))!.url.startsWith('https://api-m.sandbox.paypal.com/')).toBe(true);
    f.pp.lastOrder = order.id;
    f.pp.value = '10.00';
    await f.service.capturePayPal(f.ws, order.id);
    const sbx = (await f.store.receiptForOrder(order.id))!;
    expect(sbx.number).toBe('VF-RCT-SANDBOX-2026-000001');
    expect(await pdfText((await f.service.pdf('receipt', sbx.id))!)).toContain('SANDBOX');
    expect(f.emails[0]!.subject).toBe('[SANDBOX] Your Valefront receipt VF-RCT-SANDBOX-2026-000001');
    // A real payment afterwards still gets the first real number.
    const real = (await f.service.createOrder(f.ws, { amountCents: 1000, method: 'worldfirst', idempotencyKey: 'sbx-00003' })).order;
    await f.service.markPaid(real.id, { by: 'admin' });
    expect((await f.store.receiptForOrder(real.id))!.number).toBe('VF-RCT-2026-000001');
  });

  it('a sandbox-verified webhook never pays a live order', async () => {
    const f = await paypalSetup();
    const { order } = await f.service.createOrder(f.ws, { amountCents: 2500, method: 'paypal', idempotencyKey: 'pp-000004' });
    // Only the sandbox client's verification passes.
    const live = f.clients.live as unknown as { verifyWebhook: () => Promise<boolean> };
    live.verifyWebhook = async () => false;
    const event = JSON.stringify({ event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-X', status: 'COMPLETED', amount: { currency_code: 'USD', value: '25.00' }, custom_id: order.id } });
    const out = await f.service.handlePayPalWebhook({ 'paypal-auth-algo': 'a', 'paypal-cert-url': 'b', 'paypal-transmission-id': 'c', 'paypal-transmission-sig': 'd', 'paypal-transmission-time': 'e' }, event);
    expect(out.body).toMatchObject({ credited: false, reason: 'mode_mismatch' });
    expect((await f.store.balance(f.ws.id)).cents).toBe(0);
  });
});

describe('credit gate', () => {
  it('free tokens on free-tier models; otherwise a balance above zero; 402 with where to add credit', async () => {
    const f = billingFixture();
    const ws = await workspace(f.store);
    expect(await f.service.admit(ws, 'seed-2-0-lite-260428')).toEqual({ mode: 'free' });
    expect(await f.service.admit(ws, 'auto')).toEqual({ mode: 'free' });
    const refused = await f.service.admit(ws, 'gpt-5.5');
    expect(refused).toMatchObject({ refusal: { status: 402, code: 'insufficient_credit' } });
    expect((refused as { refusal: { message: string } }).refusal.message).toContain('Add credit at https://dash.valefront.com/billing');
    await f.store.addAdjustment(ws.id, 500, 'test', 'test:gate');
    expect(await f.service.admit(ws, 'gpt-5.5')).toEqual({ mode: 'paid' });
    await f.store.chargeUsage(ws.id, 5_000_000);
    expect(await f.service.admit(ws, 'gpt-5.5')).toMatchObject({ refusal: { status: 402 } });
  });

  it('free-tier limits: the daily cap and the global budget answer 429; an expired grant needs credit', async () => {
    const f = billingFixture();
    const ws = await workspace(f.store);
    await f.store.addFreeUsage(ws.id, '2026-11-07', 50_000);
    expect(await f.service.admit(ws, 'seed-2-0-lite-260428')).toMatchObject({ refusal: { status: 429, code: 'free_daily_token_cap' } });
    const other = await workspace(f.store);
    await f.store.addFreeUsage(other.id, '2026-11-07', 10_000_000);
    const third = await workspace(f.store);
    expect(await f.service.admit(third, 'seed-2-0-lite-260428')).toMatchObject({ refusal: { status: 429, code: 'global_free_budget_exhausted' } });
    f.clock.now += 31 * 86_400_000;
    const late = (await f.service.admit(third, 'seed-2-0-lite-260428')) as { refusal: { status: number; message: string } };
    expect(late.refusal.status).toBe(402);
    expect(late.refusal.message).toContain('used up or expired');
  });

  it('suspended and deleted workspaces are refused', async () => {
    const f = billingFixture();
    const ws = await workspace(f.store);
    expect(await f.service.admit({ ...ws, suspendedAt: 1 }, 'auto')).toMatchObject({ refusal: { status: 403 } });
    expect(await f.service.admit({ ...ws, deletedAt: 1 }, 'auto')).toMatchObject({ refusal: { status: 401 } });
  });

  it('charges: free tokens first, the overflow at its real price; no price, no charge', async () => {
    const f = billingFixture();
    const ws = await workspace(f.store);
    await f.store.addAdjustment(ws.id, 1000, 'test', 'test:charge');
    const grant = (await f.store.grant(ws.id))!;
    await f.store.addFreeUsage(ws.id, '2026-11-06', grant.tokens - 1000);
    // 4000 tokens costing $0.04: 1000 free, 3000 paid -> $0.03.
    await f.service.charge(ws, { model: 'seed-2-0-lite-260428', tokens: 4000, usd: 0.04 });
    expect((await f.store.grant(ws.id))!.usedTokens).toBe(grant.tokens);
    expect((await f.store.balance(ws.id)).cents).toBe(997);
    await f.service.charge(ws, { model: 'gpt-5.5', tokens: 100, usd: 0.25 });
    expect((await f.store.balance(ws.id)).cents).toBe(972);
    await f.service.charge(ws, { model: 'mystery', tokens: 100_000, usd: null });
    expect((await f.store.balance(ws.id)).cents).toBe(972);
  });
});
