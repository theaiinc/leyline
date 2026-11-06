import request from 'supertest';
import { SETTINGS } from '../src/core/billing-service';
import { TERMS_VERSION } from '../src/core/self-serve-workspaces';
import { BUYER, WORLDFIRST } from './helpers/billing-fixture';
import { ORIGIN, cookieFor, hostedBilling } from './helpers/hosted-billing';

type App = ReturnType<typeof hostedBilling>['app'];

async function signUp(app: App, cookie: string, ip = '203.0.113.1', body: Record<string, unknown> = {}) {
  return request(app).post('/dashboard/me/workspace').set('Cookie', cookie).set('Origin', ORIGIN).set('CF-Connecting-IP', ip)
    .send({ acceptTerms: true, termsVersion: TERMS_VERSION, turnstileToken: 'ok-token', ...body });
}

const chat = (app: App, key: string, model: string) => request(app).post('/v1/chat/completions').set('Authorization', `Bearer ${key}`).send({ model, messages: [{ role: 'user', content: 'hi' }] });

describe('self-serve sign-up', () => {
  it('Terms -> verified email -> Turnstile -> workspace with free grant and the first key, shown once', async () => {
    const h = hostedBilling();
    const ann = cookieFor('sub-ann', 'ann@example.com');
    expect((await request(h.app).get('/dashboard/me').set('Cookie', ann)).body).toMatchObject({ onboarding: 'terms', workspace: null, turnstileSiteKey: 'site-key', freeTier: { tokens: 1_000_000, expiresAfterDays: 30 } });
    expect((await signUp(h.app, cookieFor('sub-x', 'x@example.com', false))).body.error.code).toBe('email_verification_required');
    expect((await signUp(h.app, ann, undefined, { acceptTerms: false })).body.error.code).toBe('terms_required');
    expect((await signUp(h.app, ann, undefined, { termsVersion: '2020-01-01' })).body.error.code).toBe('terms_required');
    expect((await signUp(h.app, ann, undefined, { turnstileToken: 'bad' })).status).toBe(403);
    expect((await signUp(h.app, cookieFor('sub-d', 'd@mailinator.com'))).body.error.code).toBe('disposable_email_not_allowed');
    const ok = await signUp(h.app, ann);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ created: true, freeGrant: true });
    expect(ok.body.key).toMatch(/^ll_/);
    const me = await request(h.app).get('/dashboard/me').set('Cookie', ann);
    expect(me.body).toMatchObject({ onboarding: 'complete', freeTier: { granted: { tokens: 1_000_000, usedTokens: 0 } } });
    // Again: the same workspace, no second key.
    expect((await signUp(h.app, ann)).body).toMatchObject({ created: false, key: null });
    expect((await request(h.app).get('/dashboard/me/keys').set('Cookie', ann)).body.keys).toHaveLength(1);
  });

  it('one free grant per email: another Aegis account with the same email gets a workspace but no grant', async () => {
    const h = hostedBilling();
    expect((await signUp(h.app, cookieFor('sub-1', 'same@example.com'))).body.freeGrant).toBe(true);
    const second = await signUp(h.app, cookieFor('sub-2', 'Same@Example.com'), '203.0.113.2');
    expect(second.body).toMatchObject({ created: true, freeGrant: false });
  });

  it('at most three sign-ups a day from one network', async () => {
    const h = hostedBilling();
    for (let i = 0; i < 3; i++) expect((await signUp(h.app, cookieFor(`s${i}`, `u${i}@example.com`))).status).toBe(201);
    const fourth = await signUp(h.app, cookieFor('s9', 'u9@example.com'));
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe('workspace_creation_rate_limited');
  });

  it('writes need the dashboard origin; nothing without a session', async () => {
    const h = hostedBilling();
    expect((await request(h.app).get('/dashboard/me')).status).toBe(401);
    const res = await request(h.app).post('/dashboard/me/workspace').set('Cookie', cookieFor('s', 'a@example.com')).set('Origin', 'https://evil.example').send({});
    expect(res.status).toBe(403);
  });
});

describe('credit gates customer requests', () => {
  async function customer(h = hostedBilling()) {
    const cookie = cookieFor('sub-c', 'cus@example.com');
    const key = (await signUp(h.app, cookie)).body.key as string;
    const ws = (await h.store.workspaceBySub('sub-c'))!;
    return { h, cookie, key, ws };
  }

  it('free tokens cover free-tier models; a paid model with no credit is 402 insufficient_credit', async () => {
    const { h, key, ws } = await customer();
    expect((await chat(h.app, key, 'seed-2-0-lite-260428')).status).toBe(200);
    await h.settle();
    expect((await h.store.grant(ws.id))!.usedTokens).toBe(2000);
    expect((await h.store.balance(ws.id)).cents).toBe(0);
    const paid = await chat(h.app, key, 'gpt-5.5');
    expect(paid.status).toBe(402);
    expect(paid.body.error).toMatchObject({ code: 'insufficient_credit', type: 'insufficient_credit' });
    expect(paid.body.error.message).toContain('Add credit at https://dash.valefront.com/billing');
    const anthropic = await request(h.app).post('/v1/messages').set('x-api-key', key).send({ model: 'gpt-5.5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect(anthropic.status).toBe(402);
    expect(anthropic.body.error.type).toBe('billing_error');
  });

  it('with credit, each request is charged at its real price; unpriced models are refused, never charged the default', async () => {
    const { h, key, ws } = await customer();
    await h.store.addAdjustment(ws.id, 1000, 'test credit', 'test:1');
    expect((await chat(h.app, key, 'gpt-5.5')).status).toBe(200);
    await h.settle();
    // 1000 in x $5/M + 1000 out x $15/M = $0.02.
    expect((await h.store.balance(ws.id)).cents).toBe(998);
    const unpriced = await chat(h.app, key, 'unpriced-model');
    expect(unpriced.status).toBe(403);
    expect(unpriced.body.error.code).toBe('model_not_priced');
    expect(h.upstream.seen.some((r) => r.model === 'unpriced-model')).toBe(false);
  });

  it('shared-pool keys (no workspace) are never gated; an admin\'s dash workspace is a customer like any other', async () => {
    const h = hostedBilling();
    const made = await request(h.app).post('/admin/api/keys').set('Authorization', 'Bearer admin-secret-token').send({ name: 'internal' });
    expect((await chat(h.app, made.body.key, 'unpriced-model')).status).toBe(200);
    expect((await chat(h.app, made.body.key, 'gpt-5.5')).status).toBe(200);
    // adm and dash are separate accounts under one email: the admin's dash workspace pays from its own credit.
    const owner = cookieFor('sub-owner', 'owner@valefront.com');
    const key = (await signUp(h.app, owner)).body.key as string;
    expect((await chat(h.app, key, 'gpt-5.5')).status).toBe(402);
    expect((await chat(h.app, key, 'unpriced-model')).status).toBe(403);
  });
});

describe('billing over HTTP', () => {
  it('Add credit: billing details, Turnstile, one order per click, bank details with the reference', async () => {
    const h = hostedBilling();
    await h.store.saveSetting(SETTINGS.account, WORLDFIRST, 'admin');
    const cookie = cookieFor('sub-b', 'buyer@example.com');
    await signUp(h.app, cookie);
    const put = (path: string, body: object) => request(h.app).put(path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);
    const post = (path: string, body: object) => request(h.app).post(path).set('Cookie', cookie).set('Origin', ORIGIN).send(body);
    expect((await post('/dashboard/me/billing/orders', { amountCents: 2000, method: 'worldfirst', idempotencyKey: 'click-0001', turnstileToken: 'ok-token' })).body.error.code).toBe('billing_profile_required');
    expect((await put('/dashboard/me/billing/profile', BUYER)).status).toBe(200);
    expect((await post('/dashboard/me/billing/orders', { amountCents: 999, method: 'worldfirst', idempotencyKey: 'click-0002', turnstileToken: 'ok-token' })).body.error.code).toBe('amount_too_small');
    expect((await post('/dashboard/me/billing/orders', { amountCents: 2000, method: 'worldfirst', idempotencyKey: 'click-0003' })).status).toBe(403);
    const order = await post('/dashboard/me/billing/orders', { amountCents: 2000, method: 'worldfirst', idempotencyKey: 'click-0004', turnstileToken: 'ok-token' });
    expect(order.status).toBe(201);
    expect(order.body.bankTransfer).toMatchObject({ amount: 2000, reference: order.body.reference, account: { swiftCode: 'CMFGUS33' } });
    expect(order.body.bankTransfer.instructions.join(' ')).toContain(order.body.reference);
    // The same click again (no new Turnstile token): the same order.
    const again = await post('/dashboard/me/billing/orders', { amountCents: 2000, method: 'worldfirst', idempotencyKey: 'click-0004' });
    expect(again.body.id).toBe(order.body.id);
    const billing = await request(h.app).get('/dashboard/me/billing').set('Cookie', cookie);
    expect(billing.body).toMatchObject({ balanceCents: 0, minimumCents: 1000, methods: { worldfirst: true } });
    expect(billing.body.orders).toHaveLength(1);
  });

  it('a workspace sees only its own orders, receipts and keys', async () => {
    const h = hostedBilling();
    await h.store.saveSetting(SETTINGS.account, WORLDFIRST, 'admin');
    const a = cookieFor('sub-a', 'a@example.com');
    const b = cookieFor('sub-bb', 'b@example.com');
    await signUp(h.app, a);
    await signUp(h.app, b, '203.0.113.9');
    await request(h.app).put('/dashboard/me/billing/profile').set('Cookie', a).set('Origin', ORIGIN).send(BUYER);
    const order = (await request(h.app).post('/dashboard/me/billing/orders').set('Cookie', a).set('Origin', ORIGIN).send({ amountCents: 1000, method: 'worldfirst', idempotencyKey: 'iso-00001', turnstileToken: 'ok-token' })).body;
    await h.service.markPaid(order.id, { by: 'admin' });
    const receipt = (await h.store.receiptForOrder(order.id))!;
    const aKey = (await request(h.app).get('/dashboard/me/keys').set('Cookie', a)).body.keys[0];
    expect((await request(h.app).get(`/dashboard/me/billing/orders/${order.id}`).set('Cookie', b)).status).toBe(404);
    expect((await request(h.app).get(`/dashboard/me/billing/receipts/${receipt.id}`).set('Cookie', b)).status).toBe(404);
    expect((await request(h.app).get(`/dashboard/me/billing/receipts/${receipt.id}.pdf`).set('Cookie', b)).status).toBe(404);
    expect((await request(h.app).delete(`/dashboard/me/keys/${aKey.id}`).set('Cookie', b).set('Origin', ORIGIN)).status).toBe(404);
    expect((await request(h.app).post(`/dashboard/me/billing/orders/${order.id}/cancel`).set('Cookie', b).set('Origin', ORIGIN)).status).toBe(409);
    expect((await request(h.app).get('/dashboard/me/billing').set('Cookie', b)).body.orders).toHaveLength(0);
    // The owner sees theirs: HTML view and PDF.
    const html = await request(h.app).get(`/dashboard/me/billing/receipts/${receipt.id}`).set('Cookie', a);
    expect(html.status).toBe(200);
    expect(html.text).toContain(receipt.number);
    const pdf = await request(h.app).get(`/dashboard/me/billing/receipts/${receipt.id}.pdf`).set('Cookie', a).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('the PayPal webhook gets the raw body', async () => {
    let seen = '';
    const h = hostedBilling({ billing: { paypal: () => ({ verifyWebhook: async (_h: unknown, raw: string) => { seen = raw; return false; } }) as never } });
    const raw = '{"event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"amount":{"value":"10.00"}}}';
    const res = await request(h.app).post('/webhooks/paypal').set('Content-Type', 'application/json').send(raw);
    expect(res.status).toBe(400);
    expect(seen).toBe(raw);
  });
});

describe('your data', () => {
  it('export has the account, keys without secrets, usage, ledger and receipts; delete revokes keys and keeps accounting records', async () => {
    const h = hostedBilling();
    await h.store.saveSetting(SETTINGS.account, WORLDFIRST, 'admin');
    const cookie = cookieFor('sub-g', 'gdpr@example.com');
    const key = (await signUp(h.app, cookie)).body.key as string;
    await request(h.app).put('/dashboard/me/billing/profile').set('Cookie', cookie).set('Origin', ORIGIN).send(BUYER);
    const order = (await request(h.app).post('/dashboard/me/billing/orders').set('Cookie', cookie).set('Origin', ORIGIN).send({ amountCents: 1000, method: 'worldfirst', idempotencyKey: 'gdpr-0001', turnstileToken: 'ok-token' })).body;
    await h.service.markPaid(order.id, { by: 'admin' });
    expect((await chat(h.app, key, 'seed-2-0-lite-260428')).status).toBe(200);
    await h.settle();

    const exp = await request(h.app).get('/dashboard/me/export').set('Cookie', cookie);
    expect(exp.status).toBe(200);
    const data = JSON.parse(exp.text);
    expect(data.profile).toMatchObject({ email: 'gdpr@example.com', aegisSubject: 'sub-g' });
    expect(data.keys).toHaveLength(1);
    expect(exp.text).not.toContain(key);
    expect(exp.text).not.toMatch(/"hash"/);
    expect(data.usage[0].months[0].requests).toBe(1);
    expect(data.receipts).toHaveLength(1);
    expect(data.ledger.some((l: { kind: string }) => l.kind === 'payment')).toBe(true);
    expect(data.controller).toContain('privacy@valefront.com');

    expect((await request(h.app).delete('/dashboard/me').set('Cookie', cookie).set('Origin', ORIGIN).send({ confirm: 'wrong@example.com' })).status).toBe(400);
    const del = await request(h.app).delete('/dashboard/me').set('Cookie', cookie).set('Origin', ORIGIN).send({ confirm: 'gdpr@example.com' });
    expect(del.status).toBe(200);
    expect(del.body.kept).toContain('10 years');
    expect((await chat(h.app, key, 'seed-2-0-lite-260428')).status).toBe(401);
    expect((await request(h.app).get('/dashboard/me').set('Cookie', cookie)).body.workspace).toBeNull();
    const ws = h.db.sqlite.prepare("SELECT email, deleted_at FROM workspaces WHERE owner_sub = 'deleted:' || id").get() as { email: string; deleted_at: number };
    expect(ws.email).toBe('');
    expect((h.db.sqlite.prepare('SELECT count(*) AS n FROM receipts').get() as { n: number }).n).toBe(1);
    // Signing up again: a workspace, but not a second free grant.
    expect((await signUp(h.app, cookie)).body).toMatchObject({ created: true, freeGrant: false });
  });
});
