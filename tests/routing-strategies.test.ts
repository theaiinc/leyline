import request from 'supertest';
import { createServer } from '../src/server';
import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { ModelRegistry } from '../src/core/model-registry';
import { IssuedKeys, MemoryDocStore, cleanCaps } from '../src/core/issued-keys';
import { MemorySecretStore } from '../src/core/secret-store';
import { clearStrategyCaches, type HostedOptions } from '../src/core/hosted';
import type { BenchmarkSnapshot } from '../src/core/benchmarks';
import type { LogEntry } from '../src/core/logger';
import type { CompletionRequest, CompletionResponse, Provider, StreamChunk } from '../src/core/types';
import {
  UnknownStrategyError, blendedPrice, isRouterPick, medianLatencies, planStrategy, qualityScores, rankModels, routeHeader,
  strategyFor, type Price, type StrategyEnv,
} from '../src/core/routing-strategies';
import { ORIGIN, cookieFor, hostedBilling } from './helpers/hosted-billing';
import { BYTEPLUS_BENCHMARK_ALIASES } from '../src/providers/byteplus';
import { TERMS_VERSION } from '../src/core/self-serve-workspaces';

// Today's BytePlus catalog (src/providers/byteplus.ts), US$ per million tokens.
const LITE = 'seed-2-0-lite-260428';
const MINI = 'seed-2-0-mini-260428';
const FLASH = 'deepseek-v4-flash-ga-260731';
const PRICES: Record<string, Price> = { [LITE]: { input: 0.25, output: 2 }, [MINI]: { input: 0.1, output: 0.4 }, [FLASH]: { input: 0.14, output: 0.28 } };
const priceMap = (ids = Object.keys(PRICES)) => new Map(ids.map((id) => [id, PRICES[id]!]));

/** A benchmark snapshot: LITE scores highest, MINI next, FLASH unscored. */
const BENCH: BenchmarkSnapshot = {
  fetchedAt: 1,
  benchmarks: [
    { id: 'gpqa-diamond', name: 'GPQA Diamond', scores: [
      { model: 'frontier-x', score: 90, source: 's', asOf: 'd' },
      { model: LITE, leylineModel: LITE, score: 70, source: 's', asOf: 'd' },
      { model: MINI, leylineModel: MINI, score: 50, source: 's', asOf: 'd' },
      { model: 'old-y', score: 10, source: 's', asOf: 'd' },
    ] },
    { id: 'lmarena-text-elo', name: 'LMArena', scores: [
      { model: 'frontier-x', score: 1500, source: 's', asOf: 'd' },
      { model: LITE, leylineModel: LITE, score: 1400, source: 's', asOf: 'd' },
      { model: 'old-y', score: 1000, source: 's', asOf: 'd' },
    ] },
  ],
};

const log = (model: string, duration: number, status: LogEntry['status'] = 'success'): LogEntry =>
  ({ id: 'x', requestId: 'r', timestamp: '', provider: 'Fake', model, status, duration });

describe('routing strategies: ranking', () => {
  it('cheapest: blended price, input and output weighed 3:1; a tie goes to the lower output price', () => {
    expect(blendedPrice(PRICES[LITE]!)).toBeCloseTo(0.6875);
    expect(blendedPrice(PRICES[MINI]!)).toBeCloseTo(0.175);
    expect(blendedPrice(PRICES[FLASH]!)).toBeCloseTo(0.175);
    expect(rankModels('cheapest', { prices: priceMap() })).toEqual({ models: [FLASH, MINI, LITE], reason: 'lowest-blended-price' });
    const prices = new Map([['a', { input: 1, output: 1 }], ['b', { input: 0.1, output: 10 }], ['c', { input: 3, output: 0 }]]);
    // a: 1, b: 2.575, c: 2.25
    expect(rankModels('cheapest', { prices }).models).toEqual(['a', 'c', 'b']);
  });

  it('best: highest quality (benchmarks rescaled 0-1, averaged); unscored models after, cheapest first; none: price order', () => {
    const q = qualityScores([LITE, MINI, FLASH], BENCH);
    expect(q.get(LITE)).toBeCloseTo(((70 - 10) / 80 + (1400 - 1000) / 500) / 2);
    expect(q.get(MINI)).toBeCloseTo(40 / 80);
    expect(q.has(FLASH)).toBe(false);
    expect(rankModels('best', { prices: priceMap(), benchmarks: BENCH })).toEqual({ models: [LITE, MINI, FLASH], reason: 'top-benchmark-score' });
    expect(rankModels('best', { prices: priceMap(), benchmarks: null })).toEqual({ models: [FLASH, MINI, LITE], reason: 'no-benchmarks-cheapest' });
  });

  it('best: a model is found under the names benchmarks list it by (doubao-seed-2.0-lite-260428)', () => {
    const snapshot: BenchmarkSnapshot = { fetchedAt: 1, benchmarks: [{ id: 'aime', name: 'AIME', scores: [
      { model: 'doubao-seed-2.0-lite-260428', score: 0.91, source: 's', asOf: 'd' },
      { model: 'deepseek-v4-flash-0731', score: 0.94, source: 's', asOf: 'd' },
      { model: 'old', score: 0.5, source: 's', asOf: 'd' },
    ] }] };
    expect(rankModels('best', { prices: priceMap(), benchmarks: snapshot }).reason).toBe('no-benchmarks-cheapest');
    expect(rankModels('best', { prices: priceMap(), benchmarks: snapshot, benchmarkAliases: BYTEPLUS_BENCHMARK_ALIASES }).models).toEqual([FLASH, LITE, MINI]);
  });

  it('fastest: lowest median latency of recent successes (3+ samples); others after, cheapest first; no data: cheapest', () => {
    const logs = [
      log(LITE, 900), log(LITE, 1000), log(LITE, 1100),
      log(MINI, 300), log(MINI, 400), log(MINI, 500), log(MINI, 20, 'error'), log(MINI, 50_000),
      log(FLASH, 10), log(FLASH, 10), // too few samples to count
    ];
    expect(medianLatencies(logs, [LITE, MINI, FLASH])).toEqual(new Map([[LITE, 1000], [MINI, 450]]));
    expect(rankModels('fastest', { prices: priceMap(), logs })).toEqual({ models: [MINI, LITE, FLASH], reason: 'lowest-median-latency' });
    expect(rankModels('fastest', { prices: priceMap(), logs: [] })).toEqual({ models: [FLASH, MINI, LITE], reason: 'no-latency-data-cheapest' });
  });

  it('balanced: half price score, half quality score', () => {
    const prices = new Map([[LITE, { input: 0.2, output: 0.6 }], [MINI, PRICES[MINI]!], [FLASH, PRICES[FLASH]!]]);
    // Price score (1 = cheapest): LITE (blended 0.3) 0, MINI and FLASH (0.175) 1. Quality score: LITE 1, MINI 0,
    // FLASH 0 (unscored). All three 0.5: ties go by price (FLASH: lower output price), then LITE last.
    expect(rankModels('balanced', { prices, benchmarks: BENCH }).models).toEqual([FLASH, MINI, LITE]);
    // A model both cheap and good wins.
    const cheapGood = new Map([[LITE, { input: 0.1, output: 0.2 }], [MINI, PRICES[MINI]!], [FLASH, PRICES[FLASH]!]]);
    expect(rankModels('balanced', { prices: cheapGood, benchmarks: BENCH })).toEqual({ models: [LITE, FLASH, MINI], reason: 'best-price-quality-mix' });
    expect(rankModels('balanced', { prices: priceMap(), benchmarks: null }).reason).toBe('no-benchmarks-cheapest');
  });

  it('strategy names: auto:<strategy>, a key default for plain auto, the alias wins; unknown is a 400', () => {
    expect(strategyFor('auto:best')).toBe('best');
    expect(strategyFor('auto:FASTEST')).toBe('fastest');
    expect(strategyFor('auto', 'balanced')).toBe('balanced');
    expect(strategyFor('auto:cheapest', 'best')).toBe('cheapest');
    expect(strategyFor('auto')).toBeNull();
    expect(strategyFor(LITE, 'best')).toBeNull();
    expect(() => strategyFor('auto:fanciest')).toThrow(UnknownStrategyError);
    expect(isRouterPick('auto:best')).toBe(true);
    expect(isRouterPick(LITE)).toBe(false);
    expect(routeHeader({ strategy: 'cheapest', models: [FLASH, MINI], reason: 'lowest-blended-price' }, FLASH)).toBe(`cheapest; model=${FLASH}; reason=lowest-blended-price`);
    expect(routeHeader({ strategy: 'cheapest', models: [FLASH, MINI], reason: 'lowest-blended-price' }, MINI)).toBe(`cheapest; model=${MINI}; reason=fallback`);
  });

  it('key caps keep only a known routing strategy', () => {
    expect(cleanCaps({ routingStrategy: 'fastest' }).routingStrategy).toBe('fastest');
    expect('routingStrategy' in cleanCaps({ routingStrategy: 'fanciest' as never })).toBe(false);
    expect('routingStrategy' in cleanCaps({})).toBe(false);
  });
});

describe('routing strategies: eligible models', () => {
  const env = (over: Partial<StrategyEnv> = {}): StrategyEnv => ({
    offered: async () => [LITE, MINI, FLASH, 'unpriced', 'unserved'],
    price: (m) => PRICES[m] ?? (m === 'unserved' ? { input: 0, output: 0 } : undefined),
    served: async (m) => m !== 'unserved',
    readsImages: (m) => m === LITE || m === MINI,
    ...over,
  });
  const text: CompletionRequest = { model: 'auto:cheapest', messages: [{ role: 'user', content: 'hi' }] };
  const image: CompletionRequest = { model: 'auto:cheapest', messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] as never }] };

  it('only offered, priced, served models; a request with images only vision-capable ones', async () => {
    expect((await planStrategy('cheapest', text, env())).models).toEqual([FLASH, MINI, LITE]);
    expect((await planStrategy('cheapest', image, env())).models).toEqual([MINI, LITE]);
  });

  it('nothing eligible: 503 (400 for images no available model can read)', async () => {
    await expect(planStrategy('best', text, env({ served: async () => false }))).rejects.toMatchObject({ status: 503, code: 'no_model_available' });
    await expect(planStrategy('best', image, env({ readsImages: () => false }))).rejects.toMatchObject({ status: 400, code: 'unsupported_content' });
  });
});

// ── through the API ────────────────────────────────────────────────────────────────────────────────────

/** One provider serving the three catalog models at their published prices; models in `failing` throw. */
class CatalogUpstream implements Provider {
  name = 'Fake';
  defaultModel = LITE;
  failing = new Set<string>();
  seen: string[] = [];
  async isAvailable() { return true; }
  async getModels() { return Object.entries(PRICES).map(([id, pricing]) => ({ id, pricing })); }
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.seen.push(req.model);
    if (this.failing.has(req.model)) throw new Error(`${req.model} is down`);
    return { id: 'c1', object: 'chat.completion', created: 1, model: req.model, choices: [{ index: 0, message: { role: 'assistant', content: `from ${req.model}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 100_000, completion_tokens: 20_000, total_tokens: 120_000 } };
  }
  async *completeStream(req: CompletionRequest): AsyncGenerator<StreamChunk> {
    this.seen.push(req.model);
    if (this.failing.has(req.model)) throw new Error(`${req.model} is down`);
    const base = { id: 's1', object: 'chat.completion.chunk', created: 1, model: req.model };
    yield { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: `from ${req.model}` }, finish_reason: 'stop' }] };
    yield { ...base, choices: [], usage: { prompt_tokens: 100_000, completion_tokens: 20_000, total_tokens: 120_000 } };
  }
}

const ADMIN = { Authorization: 'Bearer admin-secret-token' };

function setup(over: Partial<HostedOptions> = {}) {
  clearStrategyCaches();
  const quotaManager = new QuotaManager();
  const router = new Router({ quotaManager, modelRegistry: new ModelRegistry() });
  const upstream = new CatalogUpstream();
  router.addProvider(upstream);
  const keys = new IssuedKeys(new MemoryDocStore());
  const hosted: HostedOptions = {
    keys, models: [LITE, MINI, FLASH], aliases: {}, login: null, adminEmails: [], adminToken: 'admin-secret-token',
    publicUrl: 'https://llm.valefront.test', benchmarks: async () => BENCH, ...over,
  };
  const app = createServer(router, quotaManager, { hosted, enforceExternalSurface: false, apiKeyStore: new MemorySecretStore() });
  const makeKey = async (caps: Record<string, unknown> = {}) => (await request(app).post('/admin/api/keys').set(ADMIN).send({ name: 'k', caps })).body.key as string;
  return { app, keys, upstream, makeKey };
}

const chat = (app: Parameters<typeof request>[0], key: string, model: string, extra: Record<string, unknown> = {}) =>
  request(app).post('/v1/chat/completions').set({ Authorization: `Bearer ${key}` }).send({ model, messages: [{ role: 'user', content: 'hi' }], ...extra });
const settle = () => new Promise((r) => setTimeout(r, 10));
/** US$ for the fake upstream's usage (100k in, 20k out) at a model's price. */
const usd = (m: string) => (100_000 * PRICES[m]!.input + 20_000 * PRICES[m]!.output) / 1_000_000;

describe('routing strategies: only what Valefront sells, plus the owner\'s own providers', () => {
  it('a customer key never gets a model outside the public catalog; a shared-pool key may use its owner\'s providers', async () => {
    const OTHER = 'gpt-5.6-luna';
    PRICES[OTHER] = { input: 0.001, output: 0.001 };
    try {
      const { app, upstream, makeKey } = setup({ models: [LITE, MINI, FLASH, OTHER] });
      // Shared-pool key (no workspace): the owner's own provider (BYOK) is a candidate, and here the cheapest.
      const pool = await makeKey();
      expect((await chat(app, pool, 'auto:cheapest')).headers['x-valefront-route']).toContain(`model=${OTHER}`);
      expect(upstream.seen).toContain(OTHER);
      // A customer's key never gets it: see 'a customer on free tokens alone…' below (gpt-5.5, not sold, never picked).
    } finally {
      delete PRICES[OTHER];
    }
  });
});

describe('routing strategies: chat API', () => {
  it('auto:<strategy> sends the top-ranked model, says so in X-Valefront-Route, and is priced by that model', async () => {
    const { app, keys, upstream, makeKey } = setup();
    const key = await makeKey();
    const cheap = await chat(app, key, 'auto:cheapest');
    expect(cheap.status).toBe(200);
    expect(cheap.headers['x-valefront-route']).toBe(`cheapest; model=${FLASH}; reason=lowest-blended-price`);
    const best = await chat(app, key, 'auto:best');
    expect(best.headers['x-valefront-route']).toBe(`best; model=${LITE}; reason=top-benchmark-score`);
    expect(upstream.seen).toEqual([FLASH, LITE]);
    await settle();
    const spend = await keys.spend();
    expect(spend.byModel?.[`Fake/${FLASH}`]?.usd).toBeCloseTo(usd(FLASH), 10);
    expect(spend.byModel?.[`Fake/${LITE}`]?.usd).toBeCloseTo(usd(LITE), 10);
    // Plain auto with no key default routes as before: no route header.
    const plain = await chat(app, key, 'auto');
    expect(plain.status).toBe(200);
    expect(plain.headers['x-valefront-route']).toBeUndefined();
  });

  it('falls back to the next model when every provider of the first fails; spend at the answering model\'s price', async () => {
    const { app, keys, upstream, makeKey } = setup();
    upstream.failing.add(FLASH);
    const key = await makeKey();
    const r = await chat(app, key, 'auto:cheapest');
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content).toBe(`from ${MINI}`);
    expect(r.headers['x-valefront-route']).toBe(`cheapest; model=${MINI}; reason=fallback`);
    await settle();
    const spend = await keys.spend();
    expect(spend.byModel?.[`Fake/${MINI}`]?.usd).toBeCloseTo(usd(MINI), 10);
    expect(spend.byModel?.[`Fake/${FLASH}`]).toBeUndefined();
    expect(spend.usd).toBeCloseTo(usd(MINI), 10);
  });

  it('streams: header before the first chunk, fallback before any chunk', async () => {
    const { app, upstream, makeKey } = setup();
    upstream.failing.add(FLASH);
    const key = await makeKey();
    const r = await chat(app, key, 'auto:cheapest', { stream: true });
    expect(r.status).toBe(200);
    expect(r.headers['x-valefront-route']).toBe(`cheapest; model=${MINI}; reason=fallback`);
    expect(r.text).toContain(`from ${MINI}`);
    expect(r.text).toContain('[DONE]');
  });

  it('a key\'s default strategy applies to auto; an explicit alias wins', async () => {
    const { app, upstream, makeKey } = setup();
    const key = await makeKey({ routingStrategy: 'best' });
    expect((await chat(app, key, 'auto')).headers['x-valefront-route']).toBe(`best; model=${LITE}; reason=top-benchmark-score`);
    expect((await chat(app, key, 'auto:cheapest')).headers['x-valefront-route']).toBe(`cheapest; model=${FLASH}; reason=lowest-blended-price`);
    // A named model is never re-routed.
    const named = await chat(app, key, MINI);
    expect(named.headers['x-valefront-route']).toBeUndefined();
    expect(upstream.seen).toEqual([LITE, FLASH, MINI]);
  });

  it('a request with images skips models that can\'t read them', async () => {
    const { app, upstream, makeKey } = setup();
    const key = await makeKey();
    const r = await request(app).post('/v1/chat/completions').set({ Authorization: `Bearer ${key}` }).send({
      model: 'auto:cheapest',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] }],
    });
    expect(r.status).toBe(200);
    expect(r.headers['x-valefront-route']).toBe(`cheapest; model=${MINI}; reason=lowest-blended-price`);
    expect(upstream.seen).toEqual([MINI]);
  });

  it('keeps to the key\'s models', async () => {
    const { app, makeKey } = setup();
    const key = await makeKey({ models: ['seed-*'] });
    expect((await chat(app, key, 'auto:cheapest')).headers['x-valefront-route']).toBe(`cheapest; model=${MINI}; reason=lowest-blended-price`);
  });

  it('an unknown strategy is a 400 on chat completions, messages and responses', async () => {
    const { app, upstream, makeKey } = setup();
    const key = await makeKey();
    const r = await chat(app, key, 'auto:fanciest');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('unknown_routing_strategy');
    const m = await request(app).post('/v1/messages').set({ 'x-api-key': key }).send({ model: 'auto:fanciest', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect(m.status).toBe(400);
    expect(m.body.type).toBe('error');
    const resp = await request(app).post('/v1/responses').set({ Authorization: `Bearer ${key}` }).send({ model: 'auto:fanciest', input: 'hi' });
    expect(resp.status).toBe(400);
    expect(upstream.seen).toEqual([]);
  });

  it('/v1/messages and /v1/responses route by strategy too, with the header', async () => {
    const { app, upstream, makeKey } = setup();
    const key = await makeKey();
    const m = await request(app).post('/v1/messages').set({ 'x-api-key': key }).send({ model: 'auto:best', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect(m.status).toBe(200);
    expect(m.headers['x-valefront-route']).toBe(`best; model=${LITE}; reason=top-benchmark-score`);
    const ms = await request(app).post('/v1/messages').set({ 'x-api-key': key }).send({ model: 'auto:cheapest', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(ms.headers['x-valefront-route']).toBe(`cheapest; model=${FLASH}; reason=lowest-blended-price`);
    const r = await request(app).post('/v1/responses').set({ Authorization: `Bearer ${key}` }).send({ model: 'auto:cheapest', input: 'hi' });
    expect(r.status).toBe(200);
    expect(r.headers['x-valefront-route']).toBe(`cheapest; model=${FLASH}; reason=lowest-blended-price`);
    const rs = await request(app).post('/v1/responses').set({ Authorization: `Bearer ${key}` }).send({ model: 'auto:best', input: 'hi', stream: true });
    expect(rs.headers['x-valefront-route']).toBe(`best; model=${LITE}; reason=top-benchmark-score`);
    expect(upstream.seen).toEqual([LITE, FLASH, FLASH, LITE]);
  });

  it('the owner sets a key\'s default on adm (Access keys)', async () => {
    const { app, makeKey } = setup();
    await makeKey();
    const list = (await request(app).get('/admin/api/keys').set(ADMIN)).body.keys;
    const id = list[0].id as string;
    const saved = await request(app).patch(`/admin/api/keys/${id}`).set(ADMIN).send({ caps: { routingStrategy: 'fastest' } });
    expect(saved.body.record.caps.routingStrategy).toBe('fastest');
    const bad = await request(app).patch(`/admin/api/keys/${id}`).set(ADMIN).send({ caps: { routingStrategy: 'fanciest' } });
    expect(bad.body.record.caps.routingStrategy).toBeUndefined();
  });
});

describe('routing strategies: customer key default (dash Keys)', () => {
  it('sets and clears the strategy on your own key; an unknown one is a 400', async () => {
    const h = hostedBilling();
    const cookie = cookieFor('sub-r', 'route@example.com');
    await request(h.app).post('/dashboard/me/workspace').set('Cookie', cookie).set('Origin', ORIGIN).set('CF-Connecting-IP', '203.0.113.9')
      .send({ acceptTerms: true, termsVersion: TERMS_VERSION, turnstileToken: 'ok-token' });
    const keyId = (await request(h.app).get('/dashboard/me/keys').set('Cookie', cookie)).body.keys[0].id as string;
    const put = (body: unknown) => request(h.app).put(`/dashboard/me/keys/${keyId}/routing`).set('Cookie', cookie).set('Origin', ORIGIN).send(body as object);
    expect((await put({ strategy: 'balanced' })).body).toEqual({ id: keyId, routingStrategy: 'balanced' });
    expect((await request(h.app).get('/dashboard/me/keys').set('Cookie', cookie)).body.keys[0].routingStrategy).toBe('balanced');
    expect((await h.keys.get(keyId))?.caps.routingStrategy).toBe('balanced');
    expect((await put({ strategy: 'fanciest' })).status).toBe(400);
    expect((await put({ strategy: null })).body.routingStrategy).toBeNull();
    expect((await h.keys.get(keyId))?.caps.routingStrategy).toBeUndefined();
    // Another customer can't touch it.
    const other = cookieFor('sub-o', 'other@example.com');
    await request(h.app).post('/dashboard/me/workspace').set('Cookie', other).set('Origin', ORIGIN).set('CF-Connecting-IP', '203.0.113.10')
      .send({ acceptTerms: true, termsVersion: TERMS_VERSION, turnstileToken: 'ok-token' });
    expect((await request(h.app).put(`/dashboard/me/keys/${keyId}/routing`).set('Cookie', other).set('Origin', ORIGIN).send({ strategy: 'best' })).status).toBe(404);
  });
});

describe('routing strategies: free tokens', () => {
  it('a customer on free tokens alone gets only free-tier models; with credit, every sold model', async () => {
    clearStrategyCaches();
    // gpt-5.5 priced below the free-tier model, so cheapest would pick it for a paying customer.
    const h = hostedBilling({ hosted: { prices: { 'seed-2-0-lite-260428': { input: 5, output: 15 }, 'gpt-5.5': { input: 1, output: 2 } } } });
    const cookie = cookieFor('sub-f', 'free@example.com');
    const key = (await request(h.app).post('/dashboard/me/workspace').set('Cookie', cookie).set('Origin', ORIGIN).set('CF-Connecting-IP', '203.0.113.11')
      .send({ acceptTerms: true, termsVersion: TERMS_VERSION, turnstileToken: 'ok-token' })).body.key as string;
    const free = await chat(h.app, key, 'auto:cheapest');
    expect(free.status).toBe(200);
    expect(free.headers['x-valefront-route']).toBe('cheapest; model=seed-2-0-lite-260428; reason=lowest-blended-price');
    const ws = (await h.store.workspaceBySub('sub-f'))!;
    await h.store.addAdjustment(ws.id, 1000, 'test credit', 'test:route1');
    // With credit the free-tier limit is gone, but gpt-5.5 still isn't picked: Valefront doesn't sell it.
    const paid = await chat(h.app, key, 'auto:cheapest');
    expect(paid.status).toBe(200);
    expect(paid.headers['x-valefront-route']).toBe('cheapest; model=seed-2-0-lite-260428; reason=lowest-blended-price');
  });

  it('plain auto on a customer key with no default uses Balanced: only what Valefront sells, never the pool\'s auto list', async () => {
    clearStrategyCaches();
    const h = hostedBilling({ hosted: { prices: { 'seed-2-0-lite-260428': { input: 5, output: 15 }, 'gpt-5.5': { input: 1, output: 2 } } } });
    const cookie = cookieFor('sub-a', 'auto@example.com');
    const key = (await request(h.app).post('/dashboard/me/workspace').set('Cookie', cookie).set('Origin', ORIGIN).set('CF-Connecting-IP', '203.0.113.12')
      .send({ acceptTerms: true, termsVersion: TERMS_VERSION, turnstileToken: 'ok-token' })).body.key as string;
    const ws = (await h.store.workspaceBySub('sub-a'))!;
    await h.store.addAdjustment(ws.id, 1000, 'test credit', 'test:route-auto');
    for (const model of ['auto', 'auto-vision']) {
      const res = await chat(h.app, key, model);
      expect(res.status).toBe(200);
      expect(res.headers['x-valefront-route']).toMatch(/^balanced; model=seed-2-0-lite-260428;/);
    }
  });
});
