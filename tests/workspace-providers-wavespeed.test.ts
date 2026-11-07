import { webcrypto } from 'node:crypto';
import request from 'supertest';
import { TERMS_VERSION } from '../src/core/self-serve-workspaces';
import { WaveSpeedProvider } from '../src/providers/wavespeed';
import { BYOK_KINDS, D1WorkspaceProviderStore, WorkspaceProviders, buildByokProvider } from '../src/core/workspace-providers';
import { ORIGIN, cookieFor, hostedBilling } from './helpers/hosted-billing';
import { sqliteD1 } from './helpers/sqlite-d1';

if (!globalThis.crypto) (globalThis as { crypto?: unknown }).crypto = webcrypto;

const STORE_KEY = Buffer.alloc(32, 9).toString('base64');
const WS_KEY = 'ws-customer-wavespeed-key-0123';
const ENV_KEY = 'env-pool-wavespeed-key-should-not-be-used';
const ADMIN = { Authorization: 'Bearer admin-secret-token' };
const FLUX = 'wavespeed-ai/flux-dev';

type H = ReturnType<typeof hostedBilling>;
type Call = { url: string; method: string; authorization: string; body: Record<string, unknown> };
let calls: Call[] = [];
const realFetch = globalThis.fetch;
const realEnvKey = process.env.WAVESPEED_API_KEY;

beforeEach(() => {
  calls = [];
  // Even with a key in env, a workspace's request must use the workspace's own key.
  process.env.WAVESPEED_API_KEY = ENV_KEY;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? 'GET', authorization: headers.authorization ?? headers.Authorization ?? '', body: init?.body ? JSON.parse(String(init.body)) : {} });
    if (url.endsWith('/balance')) {
      if (headers.authorization !== `Bearer ${WS_KEY}`) return new Response(JSON.stringify({ code: 401, message: 'unauthorized' }), { status: 401 });
      return new Response(JSON.stringify({ code: 200, message: 'success', data: { balance: 12.5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ code: 200, data: { id: 'task1', status: 'completed', outputs: ['https://cdn.wavespeed.ai/out/1.png'] } }), { status: 200, headers: { 'content-type': 'application/json' } });
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
  h.hosted.workspaceProviders = new WorkspaceProviders(store, 0);
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
const image = (h: H, key: string, model = FLUX) =>
  request(h.app).post('/v1/images/generations').set('Authorization', `Bearer ${key}`).send({ model, prompt: 'a leaf', size: '1024x1024' });

describe('the wavespeed BYOK kind', () => {
  it('is a kind; defaults its base URL and models to the WaveSpeed catalog; refuses non-WaveSpeed models and a missing key', async () => {
    expect(BYOK_KINDS).toContain('wavespeed');
    const store = new D1WorkspaceProviderStore(sqliteD1(), STORE_KEY);
    const p = await store.add('ws', WAVESPEED, 'x');
    expect(p).toMatchObject({ kind: 'wavespeed', baseUrl: 'https://api.wavespeed.ai/api/v3', models: [FLUX], deployment: null, apiVersion: null });
    await expect(store.add('ws', { ...WAVESPEED, label: 'B', models: ['seedream-4-0-250828'] }, 'x')).rejects.toThrow('not a WaveSpeed model');
    await expect(store.add('ws', { ...WAVESPEED, label: 'C', models: ['gpt-5.5'] }, 'x')).rejects.toThrow('not a WaveSpeed model');
    await expect(store.add('ws', { ...WAVESPEED, label: 'D', apiKey: '' }, 'x')).rejects.toThrow('API key');
    await expect(store.add('ws', { ...WAVESPEED, label: 'E', baseUrl: 'http://api.wavespeed.ai' }, 'x')).rejects.toThrow('https');
    // Deployment / API version are ignored for this kind.
    expect(await store.add('ws', { ...WAVESPEED, label: 'F', deployment: 'x', apiVersion: 'y' }, 'x')).toMatchObject({ deployment: null, apiVersion: null });
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
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: `https://api.wavespeed.ai/api/v3/${FLUX}`, method: 'POST', authorization: `Bearer ${WS_KEY}` });
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

  it('runs from the dash Playground as one of the keys, and the providers list offers the WaveSpeed models', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, WAVESPEED);
    const listed = await request(h.app).get('/dashboard/me/providers').set('Cookie', a.cookie);
    expect(listed.body.kinds).toContain('wavespeed');
    expect(listed.body.mediaModels).toEqual([expect.objectContaining({ id: FLUX, kind: 'image', provider: 'BYOK:My WaveSpeed', byok: true })]);
    expect(JSON.stringify(listed.body)).not.toContain(WS_KEY);
    const [k] = await h.keys.listForWorkspace(a.ws.id);
    const res = await request(h.app).post('/dashboard/me/playground/images').set('Cookie', a.cookie).set('Origin', ORIGIN)
      .send({ keyId: k!.id, model: FLUX, prompt: 'a leaf' });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('BYOK:My WaveSpeed');
    expect(calls[0]!.authorization).toBe(`Bearer ${WS_KEY}`);
  });

  it('a disabled WaveSpeed provider is not used, and a WaveSpeed model never goes to chat', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    const added = await addProvider(h, a.cookie, WAVESPEED);
    const chat = await request(h.app).post('/v1/chat/completions').set('Authorization', `Bearer ${a.key}`).send({ model: FLUX, messages: [{ role: 'user', content: 'hi' }] });
    expect(chat.status).toBe(404);
    await request(h.app).patch(`/dashboard/me/providers/${added.body.provider.id}`).set('Cookie', a.cookie).set('Origin', ORIGIN).send({ enabled: false });
    expect((await image(h, a.key)).status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe('Test for a WaveSpeed provider', () => {
  it('reads the balance (GET /balance) with the workspace key, generating nothing; a bad key reports its status', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    const id = (await addProvider(h, a.cookie, WAVESPEED)).body.provider.id as string;
    const tested = await request(h.app).post(`/dashboard/me/providers/${id}/test`).set('Cookie', a.cookie).set('Origin', ORIGIN).send({});
    expect(tested.body).toMatchObject({ ok: true, model: FLUX, status: 200 });
    expect(calls).toEqual([expect.objectContaining({ url: 'https://api.wavespeed.ai/api/v3/balance', method: 'GET', authorization: `Bearer ${WS_KEY}` })]);
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
    expect(added.body.provider).toMatchObject({ kind: 'wavespeed', label: 'My WaveSpeed', models: [FLUX] });
    expect(JSON.stringify(added.body)).not.toContain(WS_KEY);
    const [sealed] = await h.providerStore.listSealed(a.ws.id);
    await expect(h.providerStore.apiKey(sealed!)).resolves.toBe(WS_KEY);

    // The workspace's key now gets WaveSpeed images on that key.
    const res = await image(h, a.key);
    expect(res.status).toBe(200);
    expect(calls[0]!.authorization).toBe(`Bearer ${WS_KEY}`);

    expect((await request(h.app).post('/admin/api/workspaces/ws_missing/providers').set(ADMIN).send(WAVESPEED)).status).toBe(404);
    expect((await request(h.app).post(`/admin/api/workspaces/${a.ws.id}/providers`).set(ADMIN).send({ ...WAVESPEED, kind: 'nope', label: 'X' })).body.code).toBe('invalid_kind');
    expect((await request(h.app).post(`/admin/api/workspaces/${a.ws.id}/providers`).set(ADMIN).send(WAVESPEED)).status).toBe(409);
    expect(logs.join('\n')).not.toContain(WS_KEY);
  });
});
