import request from 'supertest';
import { SEPAY_QUOTE_MS } from '../src/core/billing-service';
import { resetVndRateCache, type VndRate } from '../src/core/fx';
import { SePayClient, referencesIn, transactionFromApi, transactionFromWebhook, transferContentFor, type SePayConfig } from '../src/core/sepay';
import { BUYER, billingFixture, workspace } from './helpers/billing-fixture';
import { ORIGIN, cookieFor, hostedBilling } from './helpers/hosted-billing';

const ACCOUNT = '0071000123456';
const RATE: VndRate = { vnd_per_usd: 26_385, date: '2026-11-07', source: 'vietcombank' };

/** A fake SePay user API: bank accounts, and the transactions in `api.transactions` (rows as SePay returns them). */
function fakeSepay(over: Partial<SePayConfig> = {}) {
  const api = { transactions: [] as Array<Record<string, unknown>>, calls: [] as Array<{ url: string; auth: string }> };
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    api.calls.push({ url: url.toString(), auth: String((init.headers as Record<string, string>)?.Authorization ?? '') });
    if (url.pathname === '/userapi/bankaccounts/list') {
      return new Response(JSON.stringify({ status: 200, bankaccounts: [{ id: '1', account_holder_name: 'CONG TY TNHH CONG NGHE THE AI', account_number: ACCOUNT, bank_short_name: 'Vietcombank', bank_code: 'VCB', bank_bin: '970436' }] }));
    }
    if (url.pathname === '/userapi/transactions/list') return new Response(JSON.stringify({ status: 200, error: null, messages: { success: true }, transactions: api.transactions }));
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  const client = new SePayClient({ apiToken: 'sepay-token', accountNumber: ACCOUNT, bankId: '970436', bankName: 'Vietcombank', accountName: 'CONG TY TNHH CONG NGHE THE AI', webhookKey: 'wh-key-123', fetchImpl, ...over });
  return { api, client };
}

async function setup(opts: { country?: string; sepay?: Partial<SePayConfig>; rate?: VndRate | null } = {}) {
  const clock = { now: Date.UTC(2026, 10, 7, 3) };
  const s = fakeSepay({ now: () => clock.now, ...opts.sepay });
  const f = billingFixture({ sepay: s.client, vndRate: async () => (opts.rate === undefined ? RATE : opts.rate) }, clock);
  const ws = await workspace(f.store);
  await f.service.saveProfile(ws, { ...BUYER, country: opts.country ?? 'GB' });
  return { ...f, ...s, ws };
}

let txId = 9000;
const webhookBody = (content: string, amount: number, over: Record<string, unknown> = {}) => ({
  id: ++txId, gateway: 'Vietcombank', transactionDate: '2026-11-07 10:08:33', accountNumber: ACCOUNT, subAccount: null, code: null,
  content, transferType: 'in', description: `BankAPINotify ${content}`, transferAmount: amount, accumulated: 105_000_000, referenceCode: `FT2631${txId}`, ...over,
});
const tx = (content: string, amount: number, over: Record<string, unknown> = {}) => transactionFromWebhook(webhookBody(content, amount, over))!;

describe('SePay quote', () => {
  it('VND = ceil(total x the day rate), stored on the order with the QR, account and content, for 30 minutes', async () => {
    const f = await setup({ country: 'VN' });
    // $25 + 10% VAT = $27.50; 2750 x 26385 / 100 = 725587.5 -> 725588 VND (never less than the USD total).
    const { order } = await f.service.createOrder(f.ws, { amountCents: 2500, method: 'sepay', idempotencyKey: 'sepay-q-001' });
    const stored = (await f.store.order(order.id))!;
    expect(stored.totalCents).toBe(2750);
    expect(stored.quote).toMatchObject({
      currency: 'VND', vndAmount: 725_588, vndPerUsd: 26_385, rateDate: '2026-11-07', rateSource: 'vietcombank',
      transferContent: transferContentFor(order.reference), expiresAt: f.clock.now + SEPAY_QUOTE_MS,
      bank: { accountNumber: ACCOUNT, bankId: '970436', bankName: 'Vietcombank', accountName: 'CONG TY TNHH CONG NGHE THE AI' },
    });
    expect(stored.quote!.transferContent).toMatch(/^VF[0-9A-Z]{10}$/);
    expect(stored.quote!.qrUrl).toBe(`https://qr.sepay.vn/img?acc=${ACCOUNT}&bank=970436&amount=725588&des=${stored.quote!.transferContent}`);
    // The same click again: the same order and quote, even if the rate moved.
    const again = await f.service.createOrder(f.ws, { amountCents: 2500, method: 'sepay', idempotencyKey: 'sepay-q-001' });
    expect(again.order.id).toBe(order.id);
    expect(again.order.quote).toEqual(stored.quote);
  });

  it('uses the rate /v1/pricing publishes (one source)', async () => {
    resetVndRateCache();
    const xml = '<ExrateList><DateTime>11/7/2026 8:30:00 AM</DateTime><Exrate CurrencyCode="USD" CurrencyName="US DOLLAR" Buy="26,105.00" Transfer="26,135.00" Sell="26,385.00" /></ExrateList>';
    const spy = jest.spyOn(globalThis, 'fetch').mockImplementation((async (input: string | URL) => {
      if (String(input).includes('vietcombank')) return new Response(xml);
      return new Response('{}', { status: 404 });
    }) as typeof fetch);
    try {
      const s = fakeSepay();
      // No vndRate given: the service uses fx.ts, as /v1/pricing does.
      const h = hostedBilling({ billing: { sepay: s.client } });
      const pricing = await request(h.app).get('/v1/pricing');
      expect(pricing.body.exchange_rate).toEqual({ vnd_per_usd: 26_385, date: '2026-11-07', source: 'vietcombank' });
      const ws = await workspace(h.store);
      await h.service.saveProfile(ws, BUYER);
      const res = await request(h.app).post('/dashboard/me/billing/orders').set('Cookie', cookieFor(ws.ownerSub, ws.email)).set('Origin', ORIGIN)
        .send({ amountCents: 1000, method: 'sepay', idempotencyKey: 'sepay-pub-01', turnstileToken: 'ok-token' });
      expect(res.status).toBe(201);
      expect(res.body.sepay).toMatchObject({ amountVnd: 263_850, vndPerUsd: pricing.body.exchange_rate.vnd_per_usd, rateDate: '2026-11-07', accountNumber: ACCOUNT, bankName: 'Vietcombank', expired: false, receivedVnd: 0 });
      expect((await h.store.order(res.body.id))!.quote!.vndPerUsd).toBe(26_385);
    } finally {
      spy.mockRestore();
      resetVndRateCache();
    }
  });

  it('an expired quote is replaced by a new one at the rate of now; not before it expires', async () => {
    let rate = RATE;
    const s = fakeSepay();
    const f = billingFixture({ sepay: s.client, vndRate: async () => rate });
    const ws = await workspace(f.store);
    await f.service.saveProfile(ws, BUYER);
    const { order } = await f.service.createOrder(ws, { amountCents: 1000, method: 'sepay', idempotencyKey: 'sepay-exp-01' });
    rate = { ...RATE, vnd_per_usd: 26_500, date: '2026-11-08' };
    expect((await f.service.requoteSepay(ws, order.id)).quote!.vndAmount).toBe(263_850);
    f.clock.now += SEPAY_QUOTE_MS + 1;
    const requoted = await f.service.requoteSepay(ws, order.id);
    expect(requoted.quote).toMatchObject({ vndAmount: 265_000, vndPerUsd: 26_500, rateDate: '2026-11-08', expiresAt: f.clock.now + SEPAY_QUOTE_MS });
    expect(requoted.reference).toBe(order.reference);
    // Another workspace can't touch it.
    const other = await workspace(f.store);
    await expect(f.service.requoteSepay(other, order.id)).rejects.toThrow('Order not found');
  });

  it('a payment after the quote expired still credits at the quoted amount, noted', async () => {
    const f = await setup();
    const { order } = await f.service.createOrder(f.ws, { amountCents: 1000, method: 'sepay', idempotencyKey: 'sepay-late-1' });
    f.clock.now += SEPAY_QUOTE_MS + 10 * 60_000;
    expect(await f.service.applySepay(tx(order.quote!.transferContent, 263_850), 'webhook')).toMatchObject({ outcome: 'credited', credited: true });
    expect((await f.store.order(order.id))!.paymentNote).toContain('10 min after the quote expired');
  });
});

describe('methods()', () => {
  it('SePay is offered when its account, a way to confirm and a rate are there', async () => {
    expect((await billingFixture().service.methods()).sepay.enabled).toBe(false);
    expect((await (await setup()).service.methods()).sepay).toEqual({ enabled: true, vndPerUsd: 26_385, rateDate: '2026-11-07', bankName: 'Vietcombank', quoteMinutes: 30 });
    // No rate: off, and ordering says why.
    const noRate = await setup({ rate: null });
    expect((await noRate.service.methods()).sepay.enabled).toBe(false);
    await expect(noRate.service.createOrder(noRate.ws, { amountCents: 1000, method: 'sepay', idempotencyKey: 'sepay-nor-1' })).rejects.toThrow('no exchange rate');
    // Neither webhook key nor API token: nothing could confirm a payment.
    expect((await (await setup({ sepay: { apiToken: undefined, webhookKey: undefined } })).service.methods()).sepay.enabled).toBe(false);
    // No account and no token to look one up: off.
    expect((await (await setup({ sepay: { accountNumber: undefined, bankId: undefined, apiToken: undefined } })).service.methods()).sepay.enabled).toBe(false);
  });

  it('without SEPAY_BANK_ACCOUNT the first account on SePay is used (looked up once)', async () => {
    const f = await setup({ sepay: { accountNumber: undefined, bankId: undefined, bankName: undefined, accountName: undefined } });
    expect((await f.service.methods()).sepay.enabled).toBe(true);
    const { order } = await f.service.createOrder(f.ws, { amountCents: 1000, method: 'sepay', idempotencyKey: 'sepay-acc-01' });
    expect(order.quote!.bank).toEqual({ accountNumber: ACCOUNT, bankId: '970436', bankName: 'Vietcombank', accountName: 'CONG TY TNHH CONG NGHE THE AI' });
    expect(f.api.calls.filter((c) => c.url.includes('bankaccounts'))).toHaveLength(1);
    expect(f.api.calls[0]!.auth).toBe('Bearer sepay-token');
  });
});

describe('SePay webhook', () => {
  async function http() {
    const s = fakeSepay();
    const h = hostedBilling({ billing: { sepay: s.client, vndRate: async () => RATE } });
    const ws = await workspace(h.store);
    await h.service.saveProfile(ws, BUYER);
    const { order } = await h.service.createOrder(ws, { amountCents: 2500, method: 'sepay', idempotencyKey: 'sepay-wh-001' });
    const post = (body: unknown, key = 'wh-key-123') => request(h.app).post('/webhooks/sepay').set('Authorization', `Apikey ${key}`).send(body as object);
    return { ...h, ws, order, post };
  }

  it('a wrong or missing key is 401 and changes nothing', async () => {
    const h = await http();
    const body = webhookBody(h.order.quote!.transferContent, 659_625);
    expect((await h.post(body, 'wrong')).status).toBe(401);
    expect((await request(h.app).post('/webhooks/sepay').send(body)).status).toBe(401);
    expect((await request(h.app).post('/webhooks/sepay').set('Authorization', 'Bearer wh-key-123').send(body)).status).toBe(401);
    expect((await h.store.order(h.order.id))!.status).toBe('pending');
    expect(await h.store.sepayTransaction(String(body.id))).toBeNull();
  });

  it('the matching payment credits once; a replay (same SePay id) credits nothing more', async () => {
    const h = await http();
    const body = webhookBody(`${h.order.quote!.transferContent} chuyen tien`, 659_625);
    const first = await h.post(body);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ success: true, outcome: 'credited', credited: true, orderId: h.order.id });
    for (let i = 0; i < 3; i++) {
      const again = await h.post(body);
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ success: true, duplicate: true });
    }
    const paid = (await h.store.order(h.order.id))!;
    expect(paid).toMatchObject({ status: 'paid', paidBy: 'sepay', providerCaptureId: `SEPAY-${body.id}` });
    expect((await h.store.balance(h.ws.id)).cents).toBe(2500);
    expect((await h.store.ledger(h.ws.id)).filter((l) => l.kind === 'payment')).toHaveLength(1);
    expect((await h.store.receiptForOrder(h.order.id))!).toMatchObject({ method: 'sepay', providerReference: `SEPAY-${body.id}` });
    expect(await h.store.lastSepayWebhookAt()).toBe(h.clock.now);
  });

  it('a payment into another account, or an outgoing one, is ignored (200, so SePay stops)', async () => {
    const h = await http();
    const content = h.order.quote!.transferContent;
    expect((await h.post(webhookBody(content, 659_625, { accountNumber: '999999999' }))).body).toMatchObject({ success: true, outcome: 'wrong_account' });
    expect((await h.post(webhookBody(content, 659_625, { transferType: 'out' }))).body).toMatchObject({ success: true, outcome: 'outbound' });
    expect((await h.post(webhookBody('tien an trua', 659_625))).body).toMatchObject({ success: true, outcome: 'unmatched' });
    expect((await h.store.order(h.order.id))!.status).toBe('pending');
    expect((await h.store.balance(h.ws.id)).cents).toBe(0);
    // Not a transaction at all: 400.
    expect((await h.post({ hello: 'world' })).status).toBe(400);
  });

  it('an underpayment keeps the order pending, noted; the rest completes it', async () => {
    const h = await http();
    const content = h.order.quote!.transferContent;
    expect((await h.post(webhookBody(content, 600_000))).body).toMatchObject({ outcome: 'underpaid' });
    let o = (await h.store.order(h.order.id))!;
    expect(o.status).toBe('pending');
    expect(o.paymentNote).toContain('underpaid by 59,625 VND: received 600,000 VND of 659,625 VND');
    expect((await h.store.balance(h.ws.id)).cents).toBe(0);
    // The customer sees what's left, and the QR asks for it.
    const view = await request(h.app).get(`/dashboard/me/billing/orders/${h.order.id}`).set('Cookie', cookieFor(h.ws.ownerSub, h.ws.email));
    expect(view.body.sepay).toMatchObject({ amountVnd: 659_625, receivedVnd: 600_000, leftVnd: 59_625 });
    expect(view.body.sepay.qrUrl).toContain('amount=59625');
    expect((await h.post(webhookBody(content, 59_625))).body).toMatchObject({ outcome: 'credited', credited: true });
    o = (await h.store.order(h.order.id))!;
    expect(o.status).toBe('paid');
    expect((await h.store.balance(h.ws.id)).cents).toBe(2500);
  });

  it('an overpayment credits the order amount and notes the excess for a refund', async () => {
    const h = await http();
    expect((await h.post(webhookBody(h.order.quote!.transferContent, 700_000))).body).toMatchObject({ outcome: 'credited', credited: true });
    const o = (await h.store.order(h.order.id))!;
    expect(o.status).toBe('paid');
    expect((await h.store.balance(h.ws.id)).cents).toBe(2500);
    expect(o.paymentNote).toContain('overpaid by 40,375 VND: refund the excess.');
    // A second transfer after it was paid: not credited, noted for a refund.
    expect((await h.post(webhookBody(h.order.quote!.transferContent, 659_625))).body).toMatchObject({ outcome: 'already_paid' });
    expect((await h.store.balance(h.ws.id)).cents).toBe(2500);
    expect((await h.store.order(h.order.id))!.paymentNote).toContain('arrived after the order was paid: refund it.');
  });

  it('finds the reference with spaces, dashes, lowercase and text around it', async () => {
    const h = await http();
    const ref = h.order.reference; // VF-XXXXXXXXXX
    const body = ref.slice(3);
    const spaced = `MBVCB.1234567.ck ${`vf ${body.slice(0, 4)} ${body.slice(4, 7)}-${body.slice(7)}`.toLowerCase()}.CT tu 0123 NGUYEN VAN A`;
    expect((await h.post(webhookBody(spaced, 659_625))).body).toMatchObject({ outcome: 'credited', orderId: h.order.id });
  });
});

describe('content matching', () => {
  it('reads references out of what banks deliver', () => {
    expect(referencesIn('VF7KQ2MA9BCD chuyen tien')).toEqual(['VF-7KQ2MA9BCD']);
    expect(referencesIn('vf-7kq2-ma9b-cd')).toEqual(['VF-7KQ2MA9BCD']);
    expect(referencesIn('IBFT VF7KQ2MA9BCDNGUYEN VAN A')).toEqual(['VF-7KQ2MA9BCD']);
    // An extra "VF" glued in front doesn't hide it.
    expect(referencesIn('CTVFVF7KQ2MA9BCD')).toContain('VF-7KQ2MA9BCD');
    // Letters people confuse with Crockford digits.
    expect(referencesIn('VF7KQ2MA9BCO')).toEqual(['VF-7KQ2MA9BC0']);
    expect(referencesIn('no reference here')).toEqual([]);
    expect(referencesIn('VF12345')).toEqual([]);
    expect(transferContentFor('VF-7KQ2MA9BCD')).toBe('VF7KQ2MA9BCD');
  });

  it('maps SePay API rows (string amounts) and webhook bodies', () => {
    expect(transactionFromApi({ id: '92704', bank_brand_name: 'Vietcombank', account_number: ACCOUNT, transaction_date: '2026-11-07 11:08:33', amount_out: '0.00', amount_in: '2277000.00', accumulated: '19077000.00', transaction_content: 'VF7KQ2MA9BCD', reference_number: 'FT1', code: null, sub_account: null, bank_account_id: '19' }))
      .toEqual({ id: '92704', direction: 'in', amountVnd: 2_277_000, accountNumber: ACCOUNT, content: 'VF7KQ2MA9BCD', referenceCode: 'FT1', transactionDate: '2026-11-07 11:08:33', gateway: 'Vietcombank' });
    expect(transactionFromApi({ id: '1', amount_in: '0.00', amount_out: '50000.00', account_number: ACCOUNT })).toMatchObject({ direction: 'out', amountVnd: 50_000 });
    // Fractions of a dong aren't an amount we accept.
    expect(transactionFromApi({ id: '1', amount_in: '10.50', amount_out: '0' })).toBeNull();
    expect(transactionFromWebhook({ id: 5, transferType: 'in', transferAmount: 100, accountNumber: ACCOUNT, content: 'x' })).toMatchObject({ id: '5', amountVnd: 100 });
    expect(transactionFromWebhook({ id: 5, transferType: 'sideways', transferAmount: 100 })).toBeNull();
  });
});

describe('SePay polling', () => {
  it('credits the same way, and a later webhook for the same transaction does nothing more', async () => {
    const f = await setup();
    const { order } = await f.service.createOrder(f.ws, { amountCents: 1000, method: 'sepay', idempotencyKey: 'sepay-poll-1' });
    f.api.transactions = [
      { id: '777001', bank_brand_name: 'Vietcombank', account_number: ACCOUNT, transaction_date: '2026-11-07 10:00:00', amount_out: '0.00', amount_in: '263850.00', transaction_content: `${order.quote!.transferContent} thanh toan`, reference_number: 'FT9' },
      { id: '777002', account_number: ACCOUNT, amount_out: '263850.00', amount_in: '0.00', transaction_content: order.quote!.transferContent },
      { id: '777003', account_number: ACCOUNT, amount_out: '0.00', amount_in: '50000.00', transaction_content: 'unrelated' },
    ];
    expect(await f.service.pollSepay()).toEqual({ credited: 1, seen: 3 });
    expect((await f.store.order(order.id))!).toMatchObject({ status: 'paid', providerCaptureId: 'SEPAY-777001' });
    expect(f.api.calls.some((c) => c.url.includes(`/transactions/list?account_number=${ACCOUNT}&limit=50`) && c.auth === 'Bearer sepay-token')).toBe(true);
    // The webhook for the same SePay transaction, late: no second credit.
    expect(await f.service.applySepay(tx(order.quote!.transferContent, 263_850, { id: 777001 }), 'webhook')).toMatchObject({ duplicate: true });
    expect((await f.store.balance(f.ws.id)).cents).toBe(1000);
    // Nothing pending: polling doesn't call SePay.
    const before = f.api.calls.length;
    f.clock.now += 60_000;
    expect(await f.service.pollSepay()).toEqual({ credited: 0, seen: 0 });
    expect(f.api.calls.length).toBe(before);
  });

  it('"check now": the owner only, at most every 15 s per workspace', async () => {
    const f = await setup();
    const { order } = await f.service.createOrder(f.ws, { amountCents: 1000, method: 'sepay', idempotencyKey: 'sepay-chk-01' });
    expect((await f.service.checkSepay(f.ws, order.id)).checked).toBe(true);
    expect((await f.service.checkSepay(f.ws, order.id)).checked).toBe(false);
    f.api.transactions = [{ id: '888001', account_number: ACCOUNT, amount_in: '263850', amount_out: '0', transaction_content: order.quote!.transferContent }];
    f.clock.now += 16_000;
    const later = await f.service.checkSepay(f.ws, order.id);
    expect(later).toMatchObject({ checked: true, order: { status: 'paid' } });
    await expect(f.service.checkSepay(await workspace(f.store), order.id)).rejects.toThrow('Order not found');
  });

  it('a crash after counting but before crediting is finished by the replay', async () => {
    const f = await setup();
    const { order } = await f.service.createOrder(f.ws, { amountCents: 1000, method: 'sepay', idempotencyKey: 'sepay-crash1' });
    const t = tx(order.quote!.transferContent, 263_850);
    // As if the first run stopped right after counting the transaction toward the order.
    await f.store.recordSepayTransaction({ ...t, source: 'webhook', receivedAt: f.clock.now });
    await f.store.setSepayOutcome(t.id, order.id, 'underpaid');
    expect(await f.service.applySepay(t, 'webhook')).toMatchObject({ outcome: 'credited', credited: true, duplicate: true });
    expect((await f.store.balance(f.ws.id)).cents).toBe(1000);
    expect(await f.service.applySepay(t, 'poll')).toMatchObject({ duplicate: true });
    expect((await f.store.balance(f.ws.id)).cents).toBe(1000);
  });
});

describe('SePay on the admin host', () => {
  it('shows SePay status, last webhook, quotes and notes; never the token or key', async () => {
    const s = fakeSepay();
    const h = hostedBilling({ billing: { sepay: s.client, vndRate: async () => RATE } });
    const ws = await workspace(h.store);
    await h.service.saveProfile(ws, BUYER);
    const { order } = await h.service.createOrder(ws, { amountCents: 1000, method: 'sepay', idempotencyKey: 'sepay-adm-01' });
    await request(h.app).post('/webhooks/sepay').set('Authorization', 'Apikey wh-key-123').send(webhookBody(order.quote!.transferContent, 200_000));
    const page = await request(h.app).get('/billing/').set('Host', 'adm.valefront.com').set('Cf-Access-Jwt-Assertion', h.access.token({ email: 'owner@valefront.com' }));
    expect(page.status).toBe(200);
    for (const want of ['SePay (Vietnamese bank QR, VND)', `Vietcombank ${ACCOUNT}`, 'webhook key: <strong style="color:#147a3d">yes</strong>', '26385 VND/USD (2026-11-07)',
      'https://llm.valefront.com/webhooks/sepay', '263,850 VND at 26385', 'underpaid by 63,850 VND', `/billing/orders/${order.id}/mark-paid`]) {
      expect(page.text).toContain(want);
    }
    expect(page.text).not.toContain('last webhook seen: <strong>never');
    expect(page.text).not.toContain('sepay-token');
    expect(page.text).not.toContain('wh-key-123');
  });
});
