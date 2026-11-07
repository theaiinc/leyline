import { webcrypto } from 'node:crypto';
import request from 'supertest';
import { TERMS_VERSION } from '../src/core/self-serve-workspaces';
import { WaveSpeedProvider } from '../src/providers/wavespeed';
import { BytePlusProvider } from '../src/providers/byteplus';
import { BYOK_KINDS, D1WorkspaceProviderStore, WorkspaceByok, WorkspaceProviders, buildByokProvider } from '../src/core/workspace-providers';
import { WaveSpeedModelCache, isWaveSpeedModelId, parseWaveSpeedModels, wavespeedInput } from '../src/core/wavespeed-models';
import { ORIGIN, cookieFor, hostedBilling } from './helpers/hosted-billing';
import { sqliteD1 } from './helpers/sqlite-d1';

if (!globalThis.crypto) (globalThis as { crypto?: unknown }).crypto = webcrypto;

/**
 * A workspace's WaveSpeed provider (Your providers) serves every model the customer's WaveSpeed key can use, not
 * only Valefront's catalog. WaveSpeed is mocked throughout (no real key; nothing generated or paid for).
 */

const STORE_KEY = Buffer.alloc(32, 9).toString('base64');
const WS_KEY = 'ws-customer-wavespeed-key-0123';
const ENV_KEY = 'env-pool-wavespeed-key-should-not-be-used';
const ADMIN = { Authorization: 'Bearer admin-secret-token' };
const FLUX = 'wavespeed-ai/flux-dev';
const KLING = 'kwaivgi/kling-v2.1-i2v-pro';
const EDIT = 'wavespeed-ai/qwen-image/edit';
const AUDIO = 'wavespeed-ai/mmaudio-v2';
const SEEDREAM = 'seedream-4-0-250828';
const BASE = 'https://api.wavespeed.ai/api/v3';

/** WaveSpeed's GET /models answer (https://wavespeed.ai/docs/list-models), cut to four models. */
const MODELS = {
  code: 200, message: 'success',
  data: [
    { model_id: FLUX, name: 'FLUX.1 [dev]', base_price: 0.012, type: 'text-to-image', description: 'FLUX dev', api_schema: { api_schemas: [{ type: 'model_run', method: 'POST', api_path: `/api/v3/${FLUX}`, request_schema: { properties: { prompt: { type: 'string' }, size: { type: 'string', default: '1024*1024' }, num_images: { type: 'integer', minimum: 1, maximum: 4 }, seed: { type: 'integer' } }, required: ['prompt'] } }] } },
    { model_id: KLING, name: 'Kling 2.1 i2v Pro', base_price: 0.45, type: 'image-to-video', api_schema: { api_schemas: [{ type: 'model_run', method: 'POST', api_path: `/api/v3/${KLING}`, request_schema: { properties: { prompt: { type: 'string' }, image: { type: 'string' }, duration: { type: 'integer', enum: [5, 10], default: 5 }, negative_prompt: { type: 'string' }, guidance_scale: { type: 'number' }, aspect_ratio: { type: 'string', enum: ['16:9', '9:16'] } }, required: ['image', 'prompt'] } }] } },
    { model_id: EDIT, name: 'Qwen Image Edit', base_price: 0.02, type: 'image-to-image', api_schema: { api_schemas: [{ type: 'model_run', request_schema: { properties: { prompt: { type: 'string' }, images: { type: 'array', items: { type: 'string' } }, seed: { type: 'integer' } }, required: ['images'] } }] } },
    { model_id: AUDIO, name: 'MMAudio V2', base_price: 0.001, type: 'text-to-audio' },
    { model_id: SEEDREAM, name: 'not WaveSpeed-shaped, skipped', type: 'text-to-image' },
  ],
};

type H = ReturnType<typeof hostedBilling>;
type Call = { url: string; method: string; authorization: string; body: Record<string, unknown>; form?: boolean };
let calls: Call[] = [];
let modelsStatus = 200;
let results: Record<string, Array<Record<string, unknown>>> = {};
let submitted = 0;
const realFetch = globalThis.fetch;
const realEnvKey = process.env.WAVESPEED_API_KEY;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  modelsStatus = 200;
  results = {};
  submitted = 0;
  // Even with a key in env, a workspace's request must use the workspace's own key.
  process.env.WAVESPEED_API_KEY = ENV_KEY;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const form = init?.body instanceof FormData;
    calls.push({ url, method: init?.method ?? 'GET', authorization: headers.authorization ?? headers.Authorization ?? '', body: init?.body && !form ? JSON.parse(String(init.body)) : {}, ...(form ? { form } : {}) });
    if (url.startsWith('https://ark.')) {
      // BytePlus (the pool) for Seedream.
      return json({ model: SEEDREAM, data: [{ url: 'https://ark.example/1.jpeg' }] });
    }
    if (headers.authorization !== `Bearer ${WS_KEY}`) return json({ code: 401, message: 'unauthorized' }, 401);
    if (url === `${BASE}/balance`) return json({ code: 200, message: 'success', data: { balance: 12.5 } });
    if (url === `${BASE}/models`) return modelsStatus === 200 ? json(MODELS) : json({ code: modelsStatus }, modelsStatus);
    if (url === `${BASE}/media/upload/binary`) return json({ code: 200, data: { download_url: 'https://cdn.wavespeed.ai/uploads/input.png', type: 'image', filename: 'input.png', size: 3 } });
    const polled = /\/predictions\/([^/]+)\/result$/.exec(url);
    if (polled) {
      const queue = results[polled[1]!] ?? [];
      return json({ code: 200, data: queue.length > 1 ? queue.shift() : queue[0] ?? { id: polled[1], status: 'processing', outputs: [] } });
    }
    // A submit: images (sync mode) come back finished; anything else is a queued task.
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const id = `task${++submitted}`;
    return body.enable_sync_mode
      ? json({ code: 200, data: { id, status: 'completed', outputs: ['https://cdn.wavespeed.ai/out/1.png'] } })
      : json({ code: 200, data: { id, status: 'created', outputs: [], urls: { get: `${BASE}/predictions/${id}/result` } } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realEnvKey === undefined) delete process.env.WAVESPEED_API_KEY;
  else process.env.WAVESPEED_API_KEY = realEnvKey;
  jest.restoreAllMocks();
});

function setup() {
  const h = hostedBilling();
  const store = new D1WorkspaceProviderStore(h.db, STORE_KEY, () => h.clock.now);
  h.hosted.workspaceProviders = new WorkspaceProviders(store, 0, Date.now, new WaveSpeedModelCache());
  return { ...h, providerStore: store };
}

async function customer(h: H, sub: string, email: string, ip: string) {
  const cookie = cookieFor(sub, email);
  const signed = await request(h.app).post('/dashboard/me/workspace').set('Cookie', cookie).set('Origin', ORIGIN).set('CF-Connecting-IP', ip)
    .send({ acceptTerms: true, termsVersion: TERMS_VERSION, turnstileToken: 'ok-token' });
  const ws = (await h.store.workspaceBySub(sub))!;
  return { cookie, key: signed.body.key as string, ws };
}

const WAVESPEED = { kind: 'wavespeed', label: 'My WaveSpeed', apiKey: WS_KEY };
const addProvider = (h: H, cookie: string, body: Record<string, unknown>) =>
  request(h.app).post('/dashboard/me/providers').set('Cookie', cookie).set('Origin', ORIGIN).send(body);
const image = (h: H, key: string, model = FLUX, extra: Record<string, unknown> = {}) =>
  request(h.app).post('/v1/images/generations').set('Authorization', `Bearer ${key}`).send({ model, prompt: 'a leaf', size: '1024x1024', ...extra });
const video = (h: H, key: string, body: Record<string, unknown>) =>
  request(h.app).post('/v1/videos').set('Authorization', `Bearer ${key}`).send(body);
/** The calls that ran a model (not reading the model list, the balance or a result). */
const submits = () => calls.filter((c) => c.method === 'POST' && !c.url.endsWith('/media/upload/binary'));

describe('the wavespeed BYOK kind', () => {
  it('defaults to all models (stored "*"), takes any WaveSpeed id as a restricting list, refuses ids that are not WaveSpeed ids', async () => {
    expect(BYOK_KINDS).toContain('wavespeed');
    const db = sqliteD1();
    const store = new D1WorkspaceProviderStore(db, STORE_KEY);
    const p = await store.add('ws', WAVESPEED, 'x');
    expect(p).toMatchObject({ kind: 'wavespeed', baseUrl: BASE, models: [], allModels: true, deployment: null, apiVersion: null });
    expect(db.sqlite.prepare('SELECT models FROM workspace_providers WHERE id = ?').get(p.id)).toEqual({ models: '["*"]' });
    // Any WaveSpeed id, catalog or not.
    const listed = await store.add('ws', { ...WAVESPEED, label: 'B', models: [KLING, EDIT] }, 'x');
    expect(listed).toMatchObject({ models: [KLING, EDIT], allModels: false });
    // Back to all, and to a list again.
    expect(await store.update('ws', listed.id, { models: 'all' })).toMatchObject({ models: [], allModels: true });
    expect(await store.update('ws', listed.id, { models: [EDIT] })).toMatchObject({ models: [EDIT], allModels: false });
    expect(await store.update('ws', listed.id, { label: 'B2' })).toMatchObject({ models: [EDIT], allModels: false });
    // Never a BytePlus id (Valefront's pool), a chat model, or a malformed id.
    await expect(store.add('ws', { ...WAVESPEED, label: 'C', models: [SEEDREAM] }, 'x')).rejects.toThrow('not a WaveSpeed model id');
    await expect(store.add('ws', { ...WAVESPEED, label: 'D', models: ['gpt-5.5'] }, 'x')).rejects.toThrow('not a WaveSpeed model id');
    await expect(store.add('ws', { ...WAVESPEED, label: 'E', models: ['a b/c'] }, 'x')).rejects.toThrow('model id');
    await expect(store.add('ws', { ...WAVESPEED, label: 'F', apiKey: '' }, 'x')).rejects.toThrow('API key');
    await expect(store.add('ws', { ...WAVESPEED, label: 'G', baseUrl: 'http://api.wavespeed.ai' }, 'x')).rejects.toThrow('https');
    expect(await store.add('ws', { ...WAVESPEED, label: 'H', deployment: 'x', apiVersion: 'y' }, 'x')).toMatchObject({ deployment: null, apiVersion: null });
  });

  it("reads a provider PR #128 saved with its default (['wavespeed-ai/flux-dev']) as all models", async () => {
    const db = sqliteD1();
    const store = new D1WorkspaceProviderStore(db, STORE_KEY);
    const p = await store.add('ws', WAVESPEED, 'x');
    db.sqlite.prepare('UPDATE workspace_providers SET models = ? WHERE id = ?').run(JSON.stringify([FLUX]), p.id);
    expect(await store.get('ws', p.id)).toMatchObject({ models: [], allModels: true });
  });

  it('seals the key with AES-GCM (round-trip, never in the clear, never in a view) and builds a WaveSpeed provider from it', async () => {
    const db = sqliteD1();
    const store = new D1WorkspaceProviderStore(db, STORE_KEY);
    const view = await store.add('ws_a', WAVESPEED, 'a@example.com');
    const [sealed] = await store.listSealed('ws_a');
    await expect(store.apiKey(sealed!)).resolves.toBe(WS_KEY);
    expect(JSON.stringify(db.sqlite.prepare('SELECT * FROM workspace_providers').all())).not.toContain(WS_KEY);
    expect(JSON.stringify(view)).not.toContain(WS_KEY);
    const built = buildByokProvider(view, WS_KEY, FLUX);
    expect(built).toBeInstanceOf(WaveSpeedProvider);
    expect(built.name).toBe('BYOK:My WaveSpeed');
  });

  it('"all" matches WaveSpeed ids only: never a model Valefront sells from the pool (BytePlus), never chat', async () => {
    const store = new D1WorkspaceProviderStore(sqliteD1(), STORE_KEY);
    await store.add('ws', WAVESPEED, 'x');
    const byok = new WorkspaceByok('ws', await store.listSealed('ws'), (p) => store.apiKey(p), new WaveSpeedModelCache());
    expect(byok.size).toBeGreaterThan(0);
    for (const id of [FLUX, KLING, EDIT, 'anyone/new-model-2027']) expect(byok.mediaMatch(id)).toBe(id);
    for (const id of [SEEDREAM, 'dreamina-seedance-2-0-260128', 'dola-seedream-5-0-pro-260628', 'gpt-5.5', 'auto', '']) expect(byok.mediaMatch(id)).toBeNull();
    expect(byok.hasChat(FLUX)).toBe(false);
    expect(isWaveSpeedModelId('owner/name')).toBe(true);
    expect(isWaveSpeedModelId('/name')).toBe(false);
    expect(isWaveSpeedModelId('owner/')).toBe(false);
  });
});

describe('the WaveSpeed model list (GET /models)', () => {
  it('parses id, type, kind, price and the request fields; skips ids that are not WaveSpeed ids', () => {
    const models = parseWaveSpeedModels(MODELS);
    expect(models.map((m) => [m.id, m.kind])).toEqual([[FLUX, 'image'], [KLING, 'video'], [EDIT, 'image'], [AUDIO, 'audio']]);
    expect(models[1]).toMatchObject({ type: 'image-to-video', basePrice: 0.45, schema: { required: ['image', 'prompt'], properties: { duration: { type: 'integer', enum: [5, 10], default: 5 } } } });
    expect(models[3]!.schema).toBeUndefined();
  });

  it('is cached a few minutes; a failed read keeps the last list (and waits before trying again); none read yet: null', async () => {
    let t = 0;
    const cache = new WaveSpeedModelCache(5 * 60_000, 30_000, () => t);
    let loads = 0;
    let fail = false;
    const load = async () => {
      loads++;
      if (fail) throw new Error('down');
      return parseWaveSpeedModels(MODELS);
    };
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cache.get('p', load)).toMatchObject({ live: true, fetchedAt: 0 });
    t = 60_000;
    expect((await cache.get('p', load)).models).toHaveLength(4);
    expect(loads).toBe(1);
    t = 6 * 60_000;
    fail = true;
    expect(await cache.get('p', load)).toMatchObject({ live: false, fetchedAt: 0, models: expect.arrayContaining([expect.objectContaining({ id: FLUX })]) });
    t += 10_000;
    await cache.get('p', load);
    expect(loads).toBe(2);
    t += 30_000;
    fail = false;
    expect(await cache.get('p', load)).toMatchObject({ live: true });
    expect(loads).toBe(3);
    // Another provider, WaveSpeed down from the start: no list, any id is still accepted (WaveSpeed decides).
    fail = true;
    expect(await cache.get('q', load)).toEqual({ models: null, live: false, fetchedAt: null });
  });

  it('dash: the providers list says "all", and wavespeed-models gives the live list (count, kinds) and one model with its fields', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, WAVESPEED);
    const listed = await request(h.app).get('/dashboard/me/providers').set('Cookie', a.cookie);
    expect(listed.body.providers[0]).toMatchObject({ kind: 'wavespeed', allModels: true, models: [] });
    const out = await request(h.app).get('/dashboard/me/providers/wavespeed-models').set('Cookie', a.cookie);
    expect(out.status).toBe(200);
    expect(out.body.providers).toEqual([expect.objectContaining({ label: 'My WaveSpeed', allModels: true, live: true, count: 4 })]);
    expect(out.body.models.map((m: { id: string; kind: string }) => [m.id, m.kind])).toEqual([[FLUX, 'image'], [KLING, 'video'], [EDIT, 'image'], [AUDIO, 'audio']]);
    expect(out.body.models[0]).toMatchObject({ provider: 'BYOK:My WaveSpeed', byok: true });
    expect(out.body.models[0].schema).toBeUndefined();
    const one = await request(h.app).get('/dashboard/me/providers/wavespeed-models').query({ model: KLING }).set('Cookie', a.cookie);
    expect(one.body.model).toMatchObject({ id: KLING, type: 'image-to-video', schema: { required: ['image', 'prompt'] } });
    expect(JSON.stringify(out.body)).not.toContain(WS_KEY);
    // Read once with the workspace's key, then from the cache.
    expect(calls.filter((c) => c.url === `${BASE}/models`)).toEqual([expect.objectContaining({ authorization: `Bearer ${WS_KEY}` })]);
  });

  it('a restricted provider lists only its models, and serves only those', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, { ...WAVESPEED, models: [EDIT] });
    const out = await request(h.app).get('/dashboard/me/providers/wavespeed-models').set('Cookie', a.cookie);
    expect(out.body.providers[0]).toMatchObject({ allModels: false, count: 1 });
    expect(out.body.models.map((m: { id: string }) => m.id)).toEqual([EDIT]);
    expect((await image(h, a.key, FLUX)).status).toBe(404);
    expect(submits()).toEqual([]);
    expect((await image(h, a.key, EDIT, { images: ['https://example.com/a.png'] })).status).toBe(200);
  });

  it('WaveSpeed down: the list is unknown (count null), and any WaveSpeed id is still sent on the customer key', async () => {
    const h = setup();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    modelsStatus = 503;
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, WAVESPEED);
    const out = await request(h.app).get('/dashboard/me/providers/wavespeed-models').set('Cookie', a.cookie);
    expect(out.body.providers[0]).toMatchObject({ live: false, count: null });
    const res = await image(h, a.key, 'someone/brand-new-model');
    expect(res.status).toBe(200);
    expect(submits()).toEqual([expect.objectContaining({ url: `${BASE}/someone/brand-new-model`, authorization: `Bearer ${WS_KEY}` })]);
  });
});

describe('WaveSpeed image requests through the workspace provider', () => {
  it('without a WaveSpeed provider, a WaveSpeed model stays unavailable (no pool WaveSpeed), and nothing is called', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    const res = await image(h, a.key);
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("runs on the workspace's own key (not env), counted on a $0 BYOK:<label> line and never charged", async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    expect((await addProvider(h, a.cookie, WAVESPEED)).status).toBe(201);
    const before = await h.store.balance(a.ws.id);
    const res = await image(h, a.key);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ model: FLUX, provider: 'BYOK:My WaveSpeed', cost: 0, data: [{ url: 'https://cdn.wavespeed.ai/out/1.png' }] });
    expect(submits()).toHaveLength(1);
    expect(submits()[0]).toMatchObject({ url: `${BASE}/${FLUX}`, method: 'POST', authorization: `Bearer ${WS_KEY}`, body: { prompt: 'a leaf', size: '1024*1024', enable_sync_mode: true } });
    expect(calls.some((c) => c.authorization.includes(ENV_KEY))).toBe(false);
    await h.settle();
    expect(await h.store.balance(a.ws.id)).toEqual(before);
    const spend = await h.keys.spend();
    expect(spend.byProvider?.['BYOK:My WaveSpeed']).toMatchObject({ usd: 0, requests: 1 });
    expect(spend.usd).toBe(0);

    // Another workspace's key does not get it.
    const b = await customer(h, 'sub-b', 'b@example.com', '203.0.113.2');
    calls = [];
    expect((await image(h, b.key)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('any WaveSpeed model, not only the catalog: its own fields reach WaveSpeed unchanged; inline images are uploaded first', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, WAVESPEED);
    const before = await h.store.balance(a.ws.id);
    const res = await image(h, a.key, EDIT, {
      size: undefined, prompt: 'make it autumn', n: 2,
      images: ['https://example.com/leaf.png', 'data:image/png;base64,iVBO'], seed: 42, negative_prompt: 'blurry', guidance_scale: 3.5,
      enable_safety_checker: false, input: { output_format: 'webp' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ model: EDIT, provider: 'BYOK:My WaveSpeed', cost: 0 });
    const upload = calls.find((c) => c.url === `${BASE}/media/upload/binary`);
    expect(upload).toMatchObject({ method: 'POST', authorization: `Bearer ${WS_KEY}`, form: true });
    expect(submits()).toHaveLength(1);
    // n -> num_images only where the model has it (Qwen Image Edit doesn't).
    expect(submits()[0]!.body).toEqual({
      prompt: 'make it autumn', images: ['https://example.com/leaf.png', 'https://cdn.wavespeed.ai/uploads/input.png'], seed: 42, negative_prompt: 'blurry',
      guidance_scale: 3.5, enable_safety_checker: false, output_format: 'webp', enable_sync_mode: true, enable_base64_output: false,
    });
    await h.settle();
    expect(await h.store.balance(a.ws.id)).toEqual(before);
    expect((await h.keys.spend()).byProvider?.['BYOK:My WaveSpeed']).toMatchObject({ usd: 0, requests: 1 });
  });

  it('a video model is refused on the images endpoint (and an image model on videos), before anything runs', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, WAVESPEED);
    const wrong = await image(h, a.key, KLING);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('wrong_endpoint');
    expect((await video(h, a.key, { model: FLUX, prompt: 'x' })).body.error.code).toBe('wrong_endpoint');
    expect(submits()).toEqual([]);
  });

  it("the pool's BytePlus models are not hijacked by an all-models WaveSpeed provider", async () => {
    const h = setup();
    h.router.addProvider(new BytePlusProvider('ark-key'));
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, WAVESPEED);
    await h.store.addAdjustment(a.ws.id, 1000, 'test credit', 'test:ws1');
    const res = await image(h, a.key, SEEDREAM);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ model: SEEDREAM, provider: 'BytePlus', cost: 0.03 });
    expect(calls.filter((c) => c.url.includes('wavespeed.ai'))).toEqual([]);
  });

  it('runs from the dash Playground as one of the keys', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, WAVESPEED);
    const [k] = await h.keys.listForWorkspace(a.ws.id);
    const res = await request(h.app).post('/dashboard/me/playground/images').set('Cookie', a.cookie).set('Origin', ORIGIN)
      .send({ keyId: k!.id, model: EDIT, prompt: 'a leaf', images: ['https://example.com/a.png'] });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('BYOK:My WaveSpeed');
    expect(submits()[0]).toMatchObject({ authorization: `Bearer ${WS_KEY}`, body: { images: ['https://example.com/a.png'] } });
    expect(submits()[0]!.body.keyId).toBeUndefined();
  });

  it('a disabled WaveSpeed provider is not used, and a WaveSpeed model never goes to chat', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    const added = await addProvider(h, a.cookie, WAVESPEED);
    const chat = await request(h.app).post('/v1/chat/completions').set('Authorization', `Bearer ${a.key}`).send({ model: FLUX, messages: [{ role: 'user', content: 'hi' }] });
    expect(chat.status).toBe(404);
    await request(h.app).patch(`/dashboard/me/providers/${added.body.provider.id}`).set('Cookie', a.cookie).set('Origin', ORIGIN).send({ enabled: false });
    expect((await image(h, a.key)).status).toBe(404);
    expect((await image(h, a.key, EDIT)).status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe('WaveSpeed videos through the workspace provider', () => {
  it('an async job: submitted once without sync mode, its fields as sent; polled until done; counted once at $0, even without credit', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, WAVESPEED);
    const started = await video(h, a.key, { model: KLING, prompt: 'the leaf falls', image: 'https://example.com/leaf.png', duration: 10, ratio: '9:16', negative_prompt: 'text' });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ object: 'video', model: KLING, status: 'queued' });
    expect(submits()).toEqual([expect.objectContaining({ url: `${BASE}/${KLING}`, authorization: `Bearer ${WS_KEY}` })]);
    // ratio -> aspect_ratio (Kling has aspect_ratio, not ratio); never sync mode for a job.
    expect(submits()[0]!.body).toEqual({ prompt: 'the leaf falls', image: 'https://example.com/leaf.png', duration: 10, aspect_ratio: '9:16', negative_prompt: 'text' });

    const b = await customer(h, 'sub-b', 'b@example.com', '203.0.113.2');
    // A month later: the free tokens are gone and there's no credit, but reading a job of their own WaveSpeed works.
    h.clock.now += 40 * 86_400_000;
    const id = started.body.id as string;
    const poll = () => request(h.app).get(`/v1/videos/${id}`).set('Authorization', `Bearer ${a.key}`);
    results.task1 = [
      { id: 'task1', status: 'processing', outputs: [] },
      { id: 'task1', status: 'completed', outputs: ['https://cdn.wavespeed.ai/out/v.mp4'] },
    ];
    expect((await poll()).body).toMatchObject({ id, status: 'running' });
    const done = await poll();
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ id, status: 'succeeded', url: 'https://cdn.wavespeed.ai/out/v.mp4', cost: 0, outputs: ['https://cdn.wavespeed.ai/out/v.mp4'] });
    await poll();
    expect(calls.filter((c) => c.url === `${BASE}/predictions/task1/result`).every((c) => c.authorization === `Bearer ${WS_KEY}`)).toBe(true);
    await h.settle();
    expect((await h.keys.spend()).byProvider?.['BYOK:My WaveSpeed']).toMatchObject({ usd: 0, requests: 1 });
    // Only the key that started it reads it (another workspace's, with its own WaveSpeed, doesn't).
    await addProvider(h, b.cookie, { ...WAVESPEED, label: 'B WaveSpeed' });
    expect((await request(h.app).get(`/v1/videos/${id}`).set('Authorization', `Bearer ${b.key}`)).status).toBe(404);
  });

  it('a failed WaveSpeed task reads as failed with its error', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, WAVESPEED);
    const started = await video(h, a.key, { model: KLING, prompt: 'x', image: 'https://example.com/leaf.png' });
    results.task1 = [{ id: 'task1', status: 'failed', outputs: [], error: 'nsfw' }];
    const read = await request(h.app).get(`/v1/videos/${started.body.id}`).set('Authorization', `Bearer ${a.key}`);
    expect(read.body).toMatchObject({ status: 'failed', error: 'nsfw' });
  });

  it('from the dash Playground, and a model WaveSpeed lists as audio goes on the videos endpoint too', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, WAVESPEED);
    const [k] = await h.keys.listForWorkspace(a.ws.id);
    const started = await request(h.app).post('/dashboard/me/playground/videos').set('Cookie', a.cookie).set('Origin', ORIGIN).send({ keyId: k!.id, model: AUDIO, prompt: 'rain' });
    expect(started.status).toBe(202);
    results.task1 = [{ id: 'task1', status: 'completed', outputs: ['https://cdn.wavespeed.ai/out/a.wav'] }];
    const done = await request(h.app).get(`/dashboard/me/playground/videos/${started.body.id}`).query({ keyId: k!.id }).set('Cookie', a.cookie);
    expect(done.body).toMatchObject({ status: 'succeeded', url: 'https://cdn.wavespeed.ai/out/a.wav', cost: 0 });
  });
});

describe('wavespeedInput', () => {
  it('passes fields through, translating only size, n and ratio', () => {
    expect(wavespeedInput({ model: FLUX, prompt: 'p', size: '1024x768', n: 2, keyId: 'k', response_format: 'url', seed: 1 })).toEqual({ prompt: 'p', size: '1024*768', num_images: 2, seed: 1 });
    // Without the model's schema, ratio stays ratio; a customer's own enable_sync_mode is ours to set.
    expect(wavespeedInput({ ratio: '16:9', enable_sync_mode: false })).toEqual({ ratio: '16:9' });
  });
});

describe('Test for a WaveSpeed provider', () => {
  it('reads the balance (GET /balance) with the workspace key, generating nothing; a bad key reports its status', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    const id = (await addProvider(h, a.cookie, WAVESPEED)).body.provider.id as string;
    const tested = await request(h.app).post(`/dashboard/me/providers/${id}/test`).set('Cookie', a.cookie).set('Origin', ORIGIN).send({});
    expect(tested.body).toMatchObject({ ok: true, model: FLUX, status: 200 });
    expect(calls).toEqual([expect.objectContaining({ url: `${BASE}/balance`, method: 'GET', authorization: `Bearer ${WS_KEY}` })]);
    expect(JSON.stringify(tested.body)).not.toContain(WS_KEY);

    await request(h.app).patch(`/dashboard/me/providers/${id}`).set('Cookie', a.cookie).set('Origin', ORIGIN).send({ apiKey: 'wrong-key' });
    const bad = await request(h.app).post(`/dashboard/me/providers/${id}/test`).set('Cookie', a.cookie).set('Origin', ORIGIN).send({});
    expect(bad.body).toMatchObject({ ok: false, status: 401 });
  });
});

describe('adm: a provider with its key in the request body', () => {
  it('adds a WaveSpeed provider to a workspace without the pool having one; key never returned or logged; behind admin auth', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    const logs: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });

    expect((await request(h.app).post(`/admin/api/workspaces/${a.ws.id}/providers`).send(WAVESPEED)).status).toBe(401);
    const added = await request(h.app).post(`/admin/api/workspaces/${a.ws.id}/providers`).set(ADMIN).send(WAVESPEED);
    expect(added.status).toBe(201);
    expect(added.body.provider).toMatchObject({ kind: 'wavespeed', label: 'My WaveSpeed', models: [], allModels: true });
    expect(JSON.stringify(added.body)).not.toContain(WS_KEY);
    const [sealed] = await h.providerStore.listSealed(a.ws.id);
    await expect(h.providerStore.apiKey(sealed!)).resolves.toBe(WS_KEY);

    // The workspace's key now gets WaveSpeed images on that key.
    const res = await image(h, a.key);
    expect(res.status).toBe(200);
    expect(submits()[0]!.authorization).toBe(`Bearer ${WS_KEY}`);

    expect((await request(h.app).post('/admin/api/workspaces/ws_missing/providers').set(ADMIN).send(WAVESPEED)).status).toBe(404);
    expect((await request(h.app).post(`/admin/api/workspaces/${a.ws.id}/providers`).set(ADMIN).send({ ...WAVESPEED, kind: 'nope', label: 'X' })).body.code).toBe('invalid_kind');
    expect((await request(h.app).post(`/admin/api/workspaces/${a.ws.id}/providers`).set(ADMIN).send(WAVESPEED)).status).toBe(409);
    expect(logs.join('\n')).not.toContain(WS_KEY);
  });
});
