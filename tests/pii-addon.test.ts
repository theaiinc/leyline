import request from 'supertest';
import { TERMS_VERSION } from '../src/core/self-serve-workspaces';
import { DEFAULT_PII_PRICE_PER_M_TOKENS, piiFeeMicros, piiPricePerMTokens, publicAddons } from '../src/core/addons';
import { ORIGIN, cookieFor, hostedBilling } from './helpers/hosted-billing';

type H = ReturnType<typeof hostedBilling>;

async function signUp(h: H, cookie: string, ip = '203.0.113.1') {
  return request(h.app).post('/dashboard/me/workspace').set('Cookie', cookie).set('Origin', ORIGIN).set('CF-Connecting-IP', ip)
    .send({ acceptTerms: true, termsVersion: TERMS_VERSION, turnstileToken: 'ok-token' });
}

/** A signed-up customer: their first key and its id. */
async function customer(h: H, sub = 'sub-p', email = 'pii@example.com', ip = '203.0.113.1') {
  const cookie = cookieFor(sub, email);
  const key = (await signUp(h, cookie, ip)).body.key as string;
  const ws = (await h.store.workspaceBySub(sub))!;
  const keyId = (await request(h.app).get('/dashboard/me/keys').set('Cookie', cookie)).body.keys[0].id as string;
  return { cookie, key, ws, keyId };
}

const togglePii = (h: H, cookie: string, keyId: string, body: Record<string, unknown>, origin = ORIGIN) =>
  request(h.app).put(`/dashboard/me/keys/${keyId}/pii`).set('Cookie', cookie).set('Origin', origin).send(body);

const chat = (h: H, key: string, model: string, content = 'Email me at ann@example.com') =>
  request(h.app).post('/v1/chat/completions').set('Authorization', `Bearer ${key}`).send({ model, messages: [{ role: 'user', content }] });

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return fn().finally(() => {
    for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

describe('PII protection price', () => {
  it('is $0.20 per 1M input tokens by default; PII_PRICE_PER_M_TOKENS changes it; a bad value never makes it free', () => {
    expect(DEFAULT_PII_PRICE_PER_M_TOKENS).toBe(0.2);
    expect(piiPricePerMTokens({})).toBe(0.2);
    expect(piiPricePerMTokens({ PII_PRICE_PER_M_TOKENS: '0.35' })).toBe(0.35);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const bad of ['0', '-1', 'abc', 'NaN']) expect(piiPricePerMTokens({ PII_PRICE_PER_M_TOKENS: bad })).toBe(0.2);
    warn.mockRestore();
  });

  it('the fee is exact, in micro-dollars, rounded up', () => {
    expect(piiFeeMicros(1000, 0.2)).toBe(200);
    expect(piiFeeMicros(1_000_000, 0.2)).toBe(200_000);
    expect(piiFeeMicros(1, 0.2)).toBe(1);
    expect(piiFeeMicros(3, 0.2)).toBe(1);
    expect(piiFeeMicros(7_654_321, 0.2)).toBe(1_530_865);
    expect(piiFeeMicros(3, 0.1)).toBe(1);
    expect(piiFeeMicros(0, 0.2)).toBe(0);
  });
});

describe('customer PII protection toggle', () => {
  it('turns PII protection on and off for your own key only; other caps stay', async () => {
    const h = hostedBilling();
    const a = await customer(h);
    const b = await customer(h, 'sub-other', 'other@example.com', '203.0.113.7');
    const listed = (await request(h.app).get('/dashboard/me/keys').set('Cookie', a.cookie)).body;
    expect(listed.keys[0].piiProtection).toBe('off');
    expect(listed.addons.piiProtection).toMatchObject({ id: 'pii-protection', name: 'PII protection', unit: 'per 1M input tokens', price: 0.2, modes: ['regex'] });

    const on = await togglePii(h, a.cookie, a.keyId, { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.piiProtection).toBe('regex');
    const rec = (await h.keys.get(a.keyId))!;
    expect(rec.caps).toMatchObject({ piiRedaction: 'regex', requestsPerMinute: 60 });
    expect((await request(h.app).get('/dashboard/me/keys').set('Cookie', a.cookie)).body.keys[0].piiProtection).toBe('regex');

    // Another workspace's key: not found, and unchanged.
    const other = await togglePii(h, b.cookie, a.keyId, { enabled: false });
    expect(other.status).toBe(404);
    expect((await h.keys.get(a.keyId))!.caps.piiRedaction).toBe('regex');
    expect((await togglePii(h, a.cookie, b.keyId, { enabled: true })).status).toBe(404);
    expect((await h.keys.get(b.keyId))!.caps.piiRedaction).toBeUndefined();
    expect((await togglePii(h, a.cookie, 'key_doesnotexist', { enabled: true })).status).toBe(404);

    // Cross-site, signed out, or a malformed body: refused.
    expect((await togglePii(h, a.cookie, a.keyId, { enabled: false }, 'https://evil.example')).status).toBe(403);
    expect((await request(h.app).put(`/dashboard/me/keys/${a.keyId}/pii`).set('Origin', ORIGIN).send({ enabled: false })).status).toBe(401);
    expect((await togglePii(h, a.cookie, a.keyId, { enabled: 'yes' })).status).toBe(400);
    expect((await h.keys.get(a.keyId))!.caps.piiRedaction).toBe('regex');

    const off = await togglePii(h, a.cookie, a.keyId, { enabled: false });
    expect(off.body.piiProtection).toBe('off');
    expect((await h.keys.get(a.keyId))!.caps).toMatchObject({ piiRedaction: 'off', requestsPerMinute: 60 });
    const events = await h.store.auditEvents(a.ws.id);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['api_key.pii_protection_on', 'api_key.pii_protection_off']));
  });

  it('Presidio only where PRESIDIO_ANALYZER_URL is configured', async () => {
    const h = hostedBilling();
    const a = await customer(h);
    await withEnv({ PRESIDIO_ANALYZER_URL: undefined }, async () => {
      const r = await togglePii(h, a.cookie, a.keyId, { enabled: true, mode: 'presidio' });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('pii_mode_unavailable');
    });
    await withEnv({ PRESIDIO_ANALYZER_URL: 'http://presidio.internal:3000' }, async () => {
      expect((await request(h.app).get('/dashboard/me/keys').set('Cookie', a.cookie)).body.addons.piiProtection.modes).toEqual(['regex', 'presidio']);
      expect((await togglePii(h, a.cookie, a.keyId, { enabled: true, mode: 'presidio' })).body.piiProtection).toBe('presidio');
    });
  });

  it('the create-key form can turn it on', async () => {
    const h = hostedBilling();
    const a = await customer(h);
    const made = await request(h.app).post('/dashboard/me/keys').set('Cookie', a.cookie).set('Origin', ORIGIN).send({ name: 'protected', turnstileToken: 'ok-token', piiProtection: true });
    expect(made.status).toBe(201);
    expect(made.body.record.piiProtection).toBe('regex');
    expect((await h.keys.get(made.body.record.id))!.caps).toMatchObject({ piiRedaction: 'regex', requestsPerMinute: 60 });
    const plain = await request(h.app).post('/dashboard/me/keys').set('Cookie', a.cookie).set('Origin', ORIGIN).send({ name: 'plain', turnstileToken: 'ok-token' });
    expect(plain.body.record.piiProtection).toBe('off');
  });
});

describe('PII protection is charged separately', () => {
  it('a request on a protected key pays input tokens x $0.20/1M on top of usage, as its own spend line', async () => {
    const h = hostedBilling();
    const a = await customer(h);
    await h.store.addAdjustment(a.ws.id, 1000, 'test credit', 'test:pii1');
    await togglePii(h, a.cookie, a.keyId, { enabled: true });
    const res = await chat(h, a.key, 'gpt-5.5');
    expect(res.status).toBe(200);
    await h.settle();
    // The prompt left Valefront masked.
    expect(JSON.stringify(h.upstream.seen[h.upstream.seen.length - 1]!.messages)).not.toContain('ann@example.com');
    // Usage: 1000 in x $5/M + 1000 out x $15/M = $0.02 (2 cents to the ledger). PII: 1000 in x $0.20/M = 200 micros.
    const bal = await h.store.balance(a.ws.id);
    expect(bal.cents).toBe(998);
    expect(bal.pendingMicros).toBe(200);
    expect(bal.availableMicros).toBe(998 * 10_000 - 200);

    const spend = await h.keys.spend();
    expect(spend.byModel?.['Valefront/pii-protection']).toEqual({ provider: 'Valefront', model: 'pii-protection', usd: 0.0002, requests: 1, tokens: 1000 });
    expect(spend.byProvider?.Valefront).toEqual({ usd: 0.0002, requests: 1, tokens: 1000 });
    // One request, counted once; the month's dollars include the fee.
    expect(spend.requests).toBe(1);
    expect(spend.tokens).toBe(2000);
    expect(spend.usd).toBeCloseTo(0.02 + 0.0002, 10);

    const usage = await request(h.app).get('/dashboard/me/usage').set('Cookie', a.cookie);
    expect(usage.body.keys[0].usage.addons['pii-protection']).toEqual({ requests: 1, tokens: 1000, usd: 0.0002 });
    expect(usage.body.addons.piiProtection.price).toBe(0.2);
  });

  it('whole cents of the fee go to the ledger as "PII protection", apart from API usage', async () => {
    await withEnv({ PII_PRICE_PER_M_TOKENS: '10' }, async () => {
      const h = hostedBilling();
      const a = await customer(h);
      await h.store.addAdjustment(a.ws.id, 1000, 'test credit', 'test:pii2');
      await togglePii(h, a.cookie, a.keyId, { enabled: true });
      expect((await chat(h, a.key, 'gpt-5.5')).status).toBe(200);
      await h.settle();
      // 1000 input tokens x $10/1M = exactly 1 cent.
      const ledger = await h.store.ledger(a.ws.id);
      expect(ledger.filter((l) => l.description === 'PII protection').map((l) => [l.kind, l.amountCents])).toEqual([['usage', -1]]);
      expect(ledger.filter((l) => l.description === 'API usage').map((l) => l.amountCents)).toEqual([-2]);
      expect((await h.store.balance(a.ws.id)).availableMicros).toBe(997 * 10_000);
      const billing = await request(h.app).get('/dashboard/me/billing').set('Cookie', a.cookie);
      expect(billing.body.ledger.some((l: { description: string }) => l.description === 'PII protection')).toBe(true);
      expect((await h.keys.spend()).byModel?.['Valefront/pii-protection']?.usd).toBe(0.01);
    });
  });

  it('free tokens cover the model but never the PII fee', async () => {
    const h = hostedBilling();
    const a = await customer(h);
    await h.store.addAdjustment(a.ws.id, 1000, 'test credit', 'test:pii3');
    await togglePii(h, a.cookie, a.keyId, { enabled: true });
    expect((await chat(h, a.key, 'seed-2-0-lite-260428')).status).toBe(200);
    await h.settle();
    expect((await h.store.grant(a.ws.id))!.usedTokens).toBe(2000);
    const bal = await h.store.balance(a.ws.id);
    expect(bal.cents).toBe(1000);
    expect(bal.pendingMicros).toBe(200);
  });

  it('without credit a protected key is refused with 402 insufficient_credit, even on free tokens', async () => {
    const h = hostedBilling();
    const a = await customer(h);
    await togglePii(h, a.cookie, a.keyId, { enabled: true });
    const seen = h.upstream.seen.length;
    const res = await chat(h, a.key, 'seed-2-0-lite-260428');
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ code: 'insufficient_credit', type: 'insufficient_credit' });
    expect(res.body.error.message).toContain('PII protection');
    expect(res.body.error.message).toContain('needs credit');
    expect(res.body.error.message).toContain('https://dash.valefront.com/billing');
    const anthropic = await request(h.app).post('/v1/messages').set('x-api-key', a.key).send({ model: 'seed-2-0-lite-260428', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect(anthropic.status).toBe(402);
    expect(h.upstream.seen.length).toBe(seen);
    // Off again: the free tokens work, and nothing is charged for PII.
    await togglePii(h, a.cookie, a.keyId, { enabled: false });
    expect((await chat(h, a.key, 'seed-2-0-lite-260428')).status).toBe(200);
    await h.settle();
    expect((await h.store.balance(a.ws.id)).pendingMicros).toBe(0);
    expect((await h.keys.spend()).byProvider?.Valefront).toBeUndefined();
  });

  it('keys without PII protection pay no fee; owner keys are never charged it', async () => {
    const h = hostedBilling();
    const a = await customer(h);
    await h.store.addAdjustment(a.ws.id, 1000, 'test credit', 'test:pii4');
    expect((await chat(h, a.key, 'gpt-5.5')).status).toBe(200);
    const made = await request(h.app).post('/admin/api/keys').set('Authorization', 'Bearer admin-secret-token').send({ name: 'internal', caps: { piiRedaction: 'regex' } });
    expect((await chat(h, made.body.key, 'gpt-5.5')).status).toBe(200);
    await h.settle();
    expect((await h.store.balance(a.ws.id)).availableMicros).toBe(998 * 10_000);
    expect((await h.keys.spend()).byProvider?.Valefront).toBeUndefined();
  });
});

describe('/v1/pricing', () => {
  it('publishes the PII protection add-on', async () => {
    const h = hostedBilling();
    const res = await request(h.app).get('/v1/pricing');
    expect(res.status).toBe(200);
    expect(res.body.addons).toEqual([expect.objectContaining({ id: 'pii-protection', name: 'PII protection', unit: 'per 1M input tokens', price: 0.2 })]);
    expect(publicAddons({ PII_PRICE_PER_M_TOKENS: '0.5' })[0]!.price).toBe(0.5);
  });
});
