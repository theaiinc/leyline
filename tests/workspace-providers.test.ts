import { webcrypto } from 'node:crypto';
import axios from 'axios';
import request from 'supertest';
import { TERMS_VERSION } from '../src/core/self-serve-workspaces';
import { AzureOpenAIProvider } from '../src/providers/azure-openai';
import { D1WorkspaceProviderStore, WorkspaceProviders, buildByokProvider, cleanBaseUrl } from '../src/core/workspace-providers';
import { planStrategy } from '../src/core/routing-strategies';
import { strategyEnv } from '../src/core/hosted';
import { ORIGIN, cookieFor, hostedBilling } from './helpers/hosted-billing';
import { sqliteD1 } from './helpers/sqlite-d1';

if (!globalThis.crypto) (globalThis as { crypto?: unknown }).crypto = webcrypto;

const STORE_KEY = Buffer.alloc(32, 9).toString('base64');
const SECRET = 'sk-customer-secret-0123456789';
const POOL_SECRET = 'pool-azure-secret-abcdef';
const ADMIN = { Authorization: 'Bearer admin-secret-token' };

type H = ReturnType<typeof hostedBilling>;

/** Upstream calls the workspace providers made (fetch and axios), answered like OpenAI / Anthropic. */
type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

function headersOf(h: unknown): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries([...h.entries()].map(([k, v]) => [k.toLowerCase(), v]));
  return Object.fromEntries(Object.entries(h as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

const completion = (model: string) => ({ id: 'up1', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: 'From your own provider' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 } });

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, headers: headersOf(init?.headers ?? (input instanceof Request ? input.headers : undefined)), body });
    if (url.endsWith('/messages')) {
      return new Response(JSON.stringify({ id: 'msg1', model: body.model, content: [{ type: 'text', text: 'From your own Anthropic' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (body.stream) {
      const sse = `data: ${JSON.stringify({ id: 's1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content: 'streamed' }, finish_reason: null }] })}\n\n`
        + `data: ${JSON.stringify({ id: 's1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\ndata: [DONE]\n\n`;
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify(completion(String(body.model))), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  jest.spyOn(axios, 'post').mockImplementation(async (url: string, body: unknown, config?: { headers?: unknown }) => {
    calls.push({ url, headers: headersOf(config?.headers), body: body as Record<string, unknown> });
    return { data: completion(String((body as { model?: string }).model)), status: 200 };
  });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  jest.restoreAllMocks();
});

function setup() {
  const h = hostedBilling();
  const store = new D1WorkspaceProviderStore(h.db, STORE_KEY, () => h.clock.now);
  h.hosted.workspaceProviders = new WorkspaceProviders(store, 0);
  return { ...h, providers: h.hosted.workspaceProviders, providerStore: store };
}

async function customer(h: H, sub: string, email: string, ip: string) {
  const cookie = cookieFor(sub, email);
  const signed = await request(h.app).post('/dashboard/me/workspace').set('Cookie', cookie).set('Origin', ORIGIN).set('CF-Connecting-IP', ip)
    .send({ acceptTerms: true, termsVersion: TERMS_VERSION, turnstileToken: 'ok-token' });
  const ws = (await h.store.workspaceBySub(sub))!;
  return { cookie, key: signed.body.key as string, ws };
}

const addProvider = (h: H, cookie: string, body: Record<string, unknown>) =>
  request(h.app).post('/dashboard/me/providers').set('Cookie', cookie).set('Origin', ORIGIN).send(body);

const GATEWAY = { kind: 'openai-compatible', label: 'My gateway', baseUrl: 'https://gateway.example.com/v1', models: ['my-gpt', 'my-mini'], apiKey: SECRET };

const chat = (h: H, key: string, model: string, extra: Record<string, unknown> = {}) =>
  request(h.app).post('/v1/chat/completions').set('Authorization', `Bearer ${key}`).send({ model, messages: [{ role: 'user', content: 'hi' }], ...extra });

describe('workspace provider keys are sealed', () => {
  it('round-trips through AES-GCM, is not stored in the clear, and is bound to its workspace and provider', async () => {
    const db = sqliteD1();
    const store = new D1WorkspaceProviderStore(db, STORE_KEY);
    const a = await store.add('ws_a', GATEWAY, 'a@example.com');
    const b = await store.add('ws_b', { ...GATEWAY, apiKey: 'sk-other-workspace' }, 'b@example.com');
    const [sealedA] = await store.listSealed('ws_a');
    await expect(store.apiKey(sealedA!)).resolves.toBe(SECRET);
    expect(JSON.stringify(db.sqlite.prepare('SELECT * FROM workspace_providers').all())).not.toContain(SECRET);
    // The public view has no key at all.
    expect(Object.keys(a)).not.toEqual(expect.arrayContaining(['keyIv', 'keyData', 'apiKey']));
    expect(JSON.stringify(await store.list('ws_a'))).not.toContain(SECRET);

    // A's sealed key moved onto B's row does not open (the additional data names the workspace and provider).
    db.sqlite.prepare('UPDATE workspace_providers SET key_iv = ?, key_data = ? WHERE id = ?').run(sealedA!.keyIv, sealedA!.keyData, b.id);
    const [moved] = await store.listSealed('ws_b');
    await expect(store.apiKey(moved!)).rejects.toThrow();
    // Another store key doesn't open it either.
    await expect(new D1WorkspaceProviderStore(db, Buffer.alloc(32, 1).toString('base64')).apiKey(sealedA!)).rejects.toThrow();
  });

  it('refuses private or plain-http base URLs and reserved model ids', async () => {
    expect(() => cleanBaseUrl('http://gateway.example.com')).toThrow('https');
    for (const bad of ['https://localhost/v1', 'https://127.0.0.1/v1', 'https://10.0.0.5/v1', 'https://[::1]/v1', 'https://me:pw@x.example.com']) expect(() => cleanBaseUrl(bad)).toThrow();
    expect(cleanBaseUrl('https://x.openai.azure.com/openai/v1/')).toBe('https://x.openai.azure.com/openai/v1');
    const store = new D1WorkspaceProviderStore(sqliteD1(), STORE_KEY);
    await expect(store.add('ws', { ...GATEWAY, models: ['auto:cheapest'] }, 'x')).rejects.toThrow('reserved');
    await expect(store.add('ws', { ...GATEWAY, models: ['gpt-*'] }, 'x')).rejects.toThrow('not a model id');
    await expect(store.add('ws', { ...GATEWAY, apiKey: '' }, 'x')).rejects.toThrow('API key');
  });
});

describe('Your providers on dash', () => {
  it('adds, lists, updates, tests and removes; the key is never returned, and another workspace sees none of it', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    const b = await customer(h, 'sub-b', 'b@example.com', '203.0.113.2');
    const added = await addProvider(h, a.cookie, GATEWAY);
    expect(added.status).toBe(201);
    expect(added.body.provider).toMatchObject({ kind: 'openai-compatible', label: 'My gateway', models: ['my-gpt', 'my-mini'], enabled: true, spendLine: 'BYOK:My gateway' });
    const id = added.body.provider.id as string;
    const listed = await request(h.app).get('/dashboard/me/providers').set('Cookie', a.cookie);
    expect(listed.body.providers.map((p: { id: string }) => p.id)).toEqual([id]);
    const updated = await request(h.app).patch(`/dashboard/me/providers/${id}`).set('Cookie', a.cookie).set('Origin', ORIGIN).send({ models: ['my-gpt'], apiKey: 'sk-replaced-key-999' });
    expect(updated.status).toBe(200);
    expect(updated.body.provider.models).toEqual(['my-gpt']);
    const tested = await request(h.app).post(`/dashboard/me/providers/${id}/test`).set('Cookie', a.cookie).set('Origin', ORIGIN).send({});
    expect(tested.body).toMatchObject({ ok: true, model: 'my-gpt', status: 200 });
    expect(calls[calls.length - 1]!.headers.authorization).toBe('Bearer sk-replaced-key-999');
    const exported = await request(h.app).get('/dashboard/me/export').set('Cookie', a.cookie);
    expect(JSON.parse(exported.text).providers.map((p: { id: string }) => p.id)).toEqual([id]);
    for (const body of [added.body, listed.body, updated.body, tested.body, JSON.parse(exported.text)]) {
      expect(JSON.stringify(body)).not.toContain(SECRET);
      expect(JSON.stringify(body)).not.toContain('sk-replaced-key-999');
    }

    // Workspace B: nothing listed, and A's provider is "not found" for every write.
    expect((await request(h.app).get('/dashboard/me/providers').set('Cookie', b.cookie)).body.providers).toEqual([]);
    expect((await request(h.app).patch(`/dashboard/me/providers/${id}`).set('Cookie', b.cookie).set('Origin', ORIGIN).send({ label: 'mine now' })).status).toBe(404);
    expect((await request(h.app).post(`/dashboard/me/providers/${id}/test`).set('Cookie', b.cookie).set('Origin', ORIGIN).send({})).status).toBe(404);
    expect((await request(h.app).delete(`/dashboard/me/providers/${id}`).set('Cookie', b.cookie).set('Origin', ORIGIN)).status).toBe(404);
    // Writes need the dashboard's origin; nothing without a session.
    expect((await addProvider(h, a.cookie, GATEWAY).set('Origin', 'https://evil.example')).status).toBe(403);
    expect((await request(h.app).get('/dashboard/me/providers')).status).toBe(401);

    expect((await request(h.app).delete(`/dashboard/me/providers/${id}`).set('Cookie', a.cookie).set('Origin', ORIGIN)).body).toEqual({ removed: true });
    expect((await request(h.app).get('/dashboard/me/providers').set('Cookie', a.cookie)).body.providers).toEqual([]);
  });

  it('a failing test reports the upstream status only, not its error text', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    const id = (await addProvider(h, a.cookie, GATEWAY)).body.provider.id as string;
    (axios.post as jest.Mock).mockRejectedValueOnce(Object.assign(new Error(`bad key ${SECRET}`), { response: { status: 401, data: { error: `bad key ${SECRET}` } } }));
    const tested = await request(h.app).post(`/dashboard/me/providers/${id}/test`).set('Cookie', a.cookie).set('Origin', ORIGIN).send({});
    expect(tested.body).toMatchObject({ ok: false, status: 401 });
    expect(JSON.stringify(tested.body)).not.toContain(SECRET);
  });
});

describe('requests to a BYOK model', () => {
  it('go to the workspace own provider with its key, for its keys only; another workspace cannot use the model', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    const b = await customer(h, 'sub-b', 'b@example.com', '203.0.113.2');
    await addProvider(h, a.cookie, GATEWAY);
    const res = await chat(h, a.key, 'my-gpt');
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe('From your own provider');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://gateway.example.com/v1/chat/completions', headers: { authorization: `Bearer ${SECRET}` } });
    expect(h.upstream.seen).toHaveLength(0);

    const other = await chat(h, b.key, 'my-gpt');
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe('model_not_found');
    expect(calls).toHaveLength(1);
    // A pool model still goes to the pool for A.
    await h.store.addAdjustment(a.ws.id, 1000, 'test credit', 'test:byok1');
    expect((await chat(h, a.key, 'gpt-5.5')).status).toBe(200);
    expect(h.upstream.seen.map((r) => r.model)).toEqual(['gpt-5.5']);
  });

  it('are counted on a $0 BYOK:<label> spend line and never charged, without credit or free tokens', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, GATEWAY);
    const before = await h.store.balance(a.ws.id);
    // A paid pool model without credit is refused, as before; the BYOK model is not.
    expect((await chat(h, a.key, 'gpt-5.5')).status).toBe(402);
    const res = await chat(h, a.key, 'my-gpt');
    expect(res.status).toBe(200);
    await h.settle();
    expect(await h.store.balance(a.ws.id)).toEqual(before);
    expect((await h.store.grant(a.ws.id))!.usedTokens).toBe(0);
    const spend = await h.keys.spend();
    expect(spend.byProvider?.['BYOK:My gateway']).toEqual({ usd: 0, requests: 1, tokens: 2000 });
    expect(spend.usd).toBe(0);
  });

  it('a BYOK model wins over the pool and over an alias for that workspace', async () => {
    const h = setup();
    h.hosted.aliases = { 'my-gpt': 'gpt-5.5', 'claude-*': 'gpt-5.5' };
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, { ...GATEWAY, models: ['gpt-5.5', 'my-gpt'] });
    expect((await chat(h, a.key, 'gpt-5.5')).status).toBe(200);
    expect((await chat(h, a.key, 'my-gpt')).status).toBe(200);
    expect(calls.map((c) => c.body.model)).toEqual(['gpt-5.5', 'my-gpt']);
    expect(h.upstream.seen).toHaveLength(0);
  });

  it('streams, and works on /v1/messages and /v1/responses', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, GATEWAY);
    const streamed = await chat(h, a.key, 'my-gpt', { stream: true });
    expect(streamed.status).toBe(200);
    expect(streamed.text).toContain('streamed');
    expect(streamed.text).toContain('[DONE]');

    const messages = await request(h.app).post('/v1/messages').set('x-api-key', a.key).send({ model: 'my-gpt', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
    expect(messages.status).toBe(200);
    expect(messages.body.content[0].text).toBe('From your own provider');

    const responses = await request(h.app).post('/v1/responses').set('Authorization', `Bearer ${a.key}`).send({ model: 'my-gpt', input: 'hi' });
    expect(responses.status).toBe(200);
    expect(JSON.stringify(responses.body)).toContain('From your own provider');
    const responsesStream = await request(h.app).post('/v1/responses').set('Authorization', `Bearer ${a.key}`).send({ model: 'my-gpt', input: 'hi', stream: true });
    expect(responsesStream.status).toBe(200);
    expect(responsesStream.text).toContain('streamed');
    expect(calls.every((c) => c.url.startsWith('https://gateway.example.com/v1/') && c.headers.authorization === `Bearer ${SECRET}`)).toBe(true);
    expect(h.upstream.seen).toHaveLength(0);
    await h.settle();
    expect((await h.keys.spend()).byProvider?.['BYOK:My gateway']?.requests).toBe(4);
  });

  it('an Anthropic provider takes /v1/messages (and chat) with its own key and base URL', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, { kind: 'anthropic', label: 'Claude', models: ['claude-opus-5'], apiKey: SECRET });
    const res = await request(h.app).post('/v1/messages').set('x-api-key', a.key).send({ model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect(res.body.content[0].text).toBe('From your own Anthropic');
    expect(calls[0]).toMatchObject({ url: 'https://api.anthropic.com/v1/messages', headers: { 'x-api-key': SECRET } });
    expect(calls[0]!.body.model).toBe('claude-opus-5');
  });

  it('PII protection still needs credit for its fee on a BYOK model', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, GATEWAY);
    const keyId = (await request(h.app).get('/dashboard/me/keys').set('Cookie', a.cookie)).body.keys[0].id as string;
    await request(h.app).put(`/dashboard/me/keys/${keyId}/pii`).set('Cookie', a.cookie).set('Origin', ORIGIN).send({ enabled: true });
    const refused = await chat(h, a.key, 'my-gpt');
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('insufficient_credit');
    await h.store.addAdjustment(a.ws.id, 1000, 'test credit', 'test:byok-pii');
    expect((await chat(h, a.key, 'my-gpt')).status).toBe(200);
    await h.settle();
    const spend = await h.keys.spend();
    expect(spend.byProvider?.['BYOK:My gateway']?.usd).toBe(0);
    expect(spend.byProvider?.Valefront?.usd).toBeGreaterThan(0);
  });

  it('a disabled provider is not used', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    const id = (await addProvider(h, a.cookie, GATEWAY)).body.provider.id as string;
    await request(h.app).patch(`/dashboard/me/providers/${id}`).set('Cookie', a.cookie).set('Origin', ORIGIN).send({ enabled: false });
    expect((await chat(h, a.key, 'my-gpt')).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('/v1/models and routing strategies', () => {
  it('a workspace key lists the offered models plus its own; another workspace does not see them', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    const b = await customer(h, 'sub-b', 'b@example.com', '203.0.113.2');
    await addProvider(h, a.cookie, GATEWAY);
    const mine = (await request(h.app).get('/v1/models').set('Authorization', `Bearer ${a.key}`)).body.data as Array<{ id: string; owned_by: string }>;
    expect(mine.map((m) => m.id)).toEqual(expect.arrayContaining(['seed-2-0-lite-260428', 'my-gpt', 'my-mini']));
    expect(mine.find((m) => m.id === 'my-gpt')!.owned_by).toBe('byok');
    const theirs = (await request(h.app).get('/v1/models').set('Authorization', `Bearer ${b.key}`)).body.data as Array<{ id: string }>;
    expect(theirs.map((m) => m.id)).not.toContain('my-gpt');
  });

  it('strategies may pick the workspace BYOK chat models; cheapest only priced ones, best and fastest unpriced ones too', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, { ...GATEWAY, models: ['my-gpt', 'gpt-5.5-mini-byok'] });
    jest.spyOn(h.router, 'anyPublishedPrice').mockImplementation((m) => (m === 'gpt-5.5-mini-byok' ? { input: 0.01, output: 0.02 } : undefined));
    const byok = await h.providers.forWorkspace(a.ws.id);
    const key = (await h.keys.listForWorkspace(a.ws.id))[0]!;
    const env = strategyEnv(h.router, h.hosted, key, [], false, byok);
    const offered = await env.offered();
    expect(offered).toEqual(expect.arrayContaining(['my-gpt', 'gpt-5.5-mini-byok']));
    const req = { model: 'auto:cheapest', messages: [{ role: 'user' as const, content: 'hi' }] };
    const cheapest = await planStrategy('cheapest', req, env);
    expect(cheapest.models[0]).toBe('gpt-5.5-mini-byok');
    expect(cheapest.models).not.toContain('my-gpt');
    const best = await planStrategy('best', req, env);
    expect(best.models).toEqual(expect.arrayContaining(['my-gpt', 'gpt-5.5-mini-byok']));
    // Another workspace's env has none of them.
    const other = strategyEnv(h.router, h.hosted, key, [], false, null);
    expect(await other.offered()).not.toContain('my-gpt');
  });

  it('without credit, auto:cheapest still answers from the workspace own models (and charges nothing)', async () => {
    const h = setup();
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    // Free tokens used up: the pool would be 402.
    h.db.sqlite.prepare('UPDATE free_grants SET used_tokens = tokens').run();
    await addProvider(h, a.cookie, { ...GATEWAY, models: ['gpt-5.5-mini-byok'] });
    jest.spyOn(h.router, 'anyPublishedPrice').mockImplementation((m) => (m === 'gpt-5.5-mini-byok' ? { input: 0.01, output: 0.02 } : undefined));
    expect((await chat(h, a.key, 'auto')).status).toBe(402);
    const res = await chat(h, a.key, 'auto:cheapest');
    expect(res.status).toBe(200);
    expect(res.headers['x-valefront-route']).toContain('model=gpt-5.5-mini-byok');
    expect(calls[0]!.body.model).toBe('gpt-5.5-mini-byok');
    await h.settle();
    expect((await h.store.balance(a.ws.id)).availableMicros).toBe(0);
  });
});

describe('adm: a pool provider copied into a workspace', () => {
  it('finds the workspace by email, copies key, URL and deployment server-side without returning the key, and the copy serves its keys', async () => {
    const h = setup();
    const pool = AzureOpenAIProvider.forInstance({ id: 'otlrs-test', endpoint: 'https://otlrs.openai.azure.com/openai/v1', deployment: 'gpt-5.6-luna', apiKey: POOL_SECRET });
    h.router.addProvider(pool);
    const a = await customer(h, 'sub-a', 'Steve@Example.com', '203.0.113.1');

    const found = await request(h.app).get('/admin/api/workspaces').query({ email: 'steve@example.com' }).set(ADMIN);
    expect(found.status).toBe(200);
    expect(found.body.workspaces.map((w: { id: string }) => w.id)).toEqual([a.ws.id]);
    expect((await request(h.app).get('/admin/api/workspaces').query({ email: 'steve@example.com' })).status).toBe(401);

    const copied = await request(h.app).post(`/admin/api/workspaces/${a.ws.id}/providers/from-pool`).set(ADMIN).send({ provider: 'AzureOpenAI:otlrs-test' });
    expect(copied.status).toBe(201);
    expect(copied.body.provider).toMatchObject({ kind: 'azure-openai', label: 'AzureOpenAI:otlrs-test', baseUrl: 'https://otlrs.openai.azure.com/openai/v1', deployment: 'gpt-5.6-luna', models: ['gpt-5.6-luna'] });
    expect(JSON.stringify(copied.body)).not.toContain(POOL_SECRET);
    const [sealed] = await h.providerStore.listSealed(a.ws.id);
    await expect(h.providerStore.apiKey(sealed!)).resolves.toBe(POOL_SECRET);
    expect(JSON.stringify((await request(h.app).get(`/admin/api/workspaces/${a.ws.id}/providers`).set(ADMIN)).body)).not.toContain(POOL_SECRET);

    // The workspace's key now gets gpt-5.6-luna from its own (copied) Azure, at no charge.
    const res = await chat(h, a.key, 'gpt-5.6-luna');
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe('https://otlrs.openai.azure.com/openai/v1/chat/completions');
    expect(calls[0]!.body.model).toBe('gpt-5.6-luna');
    expect(calls[0]!.headers.authorization).toBe(`Bearer ${POOL_SECRET}`);

    // Unknown pool provider, unknown workspace, the pool itself (BytePlus kinds) are refused.
    expect((await request(h.app).post(`/admin/api/workspaces/${a.ws.id}/providers/from-pool`).set(ADMIN).send({ provider: 'Nope' })).status).toBe(404);
    expect((await request(h.app).post('/admin/api/workspaces/ws_missing/providers/from-pool').set(ADMIN).send({ provider: 'AzureOpenAI:otlrs-test' })).status).toBe(404);
    expect((await request(h.app).post(`/admin/api/workspaces/${a.ws.id}/providers/from-pool`).send({ provider: 'AzureOpenAI:otlrs-test' })).status).toBe(401);
    // Copying it again under the same name is refused (labels are unique per workspace).
    expect((await request(h.app).post(`/admin/api/workspaces/${a.ws.id}/providers/from-pool`).set(ADMIN).send({ provider: 'AzureOpenAI:otlrs-test' })).status).toBe(409);
  });

  it('a v1 Azure endpoint keeps v1 even when its URL does not say so', () => {
    const p = buildByokProvider({ id: 'p', workspaceId: 'w', kind: 'azure-openai', label: 'A', baseUrl: 'https://x.openai.azure.com', deployment: 'd', apiVersion: 'v1', models: ['d'], enabled: true, createdAt: 0, createdBy: 'x', updatedAt: 0 }, 'k', 'd');
    expect((p as AzureOpenAIProvider).getRuntimeConfig()).toMatchObject({ openAICompatible: true, model: 'd' });
    const legacy = buildByokProvider({ id: 'p', workspaceId: 'w', kind: 'azure-openai', label: 'A', baseUrl: 'https://x.openai.azure.com', deployment: 'd', apiVersion: null, models: ['d'], enabled: true, createdAt: 0, createdBy: 'x', updatedAt: 0 }, 'k', 'd');
    expect((legacy as AzureOpenAIProvider).getRuntimeConfig()).toMatchObject({ openAICompatible: false });
    expect(p.name).toBe('BYOK:A');
  });
});

describe('workspace keys get only what Valefront sells from the pool (PR B)', () => {
  function sellsOnly(h: H, sold: string[]) {
    h.hosted.soldModel = (m) => sold.includes(m);
  }

  it('a model Valefront does not sell is 404 model_not_offered for a workspace key, pointing to Your providers', async () => {
    const h = setup();
    sellsOnly(h, ['seed-2-0-lite-260428']);
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await h.store.addAdjustment(a.ws.id, 1000, 'test credit', 'test:enforce1');
    const res = await chat(h, a.key, 'gpt-5.5');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('model_not_offered');
    expect(res.body.error.message).toContain('Your providers');
    const messages = await request(h.app).post('/v1/messages').set('x-api-key', a.key).send({ model: 'gpt-5.5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    expect(messages.status).toBe(404);
    expect((await request(h.app).post('/v1/responses').set('Authorization', `Bearer ${a.key}`).send({ model: 'gpt-5.5', input: 'hi' })).status).toBe(404);
    expect(h.upstream.seen).toHaveLength(0);
    // A sold model still works, and so does routing.
    expect((await chat(h, a.key, 'seed-2-0-lite-260428')).status).toBe(200);
    // An alias to a model Valefront doesn't sell is refused too.
    h.hosted.aliases = { 'claude-*': 'gpt-5.5' };
    expect((await chat(h, a.key, 'claude-sonnet-5')).body.error.code).toBe('model_not_offered');
  });

  it('the same model through the workspace own provider works, and /v1/models lists sold plus own models only', async () => {
    const h = setup();
    sellsOnly(h, ['seed-2-0-lite-260428']);
    const a = await customer(h, 'sub-a', 'a@example.com', '203.0.113.1');
    await addProvider(h, a.cookie, { ...GATEWAY, models: ['gpt-5.5'] });
    expect((await chat(h, a.key, 'gpt-5.5')).status).toBe(200);
    expect(calls[0]!.url).toBe('https://gateway.example.com/v1/chat/completions');
    const ids = (await request(h.app).get('/v1/models').set('Authorization', `Bearer ${a.key}`)).body.data.map((m: { id: string }) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['seed-2-0-lite-260428', 'gpt-5.5']));
    expect(ids).not.toContain('unpriced-model');
  });

  it('shared-pool keys (no workspace) keep every pool model', async () => {
    const h = setup();
    sellsOnly(h, ['seed-2-0-lite-260428']);
    const { key } = await h.keys.create({ name: 'pool', by: 'token' });
    expect((await chat(h, key, 'gpt-5.5')).status).toBe(200);
    const ids = (await request(h.app).get('/v1/models').set('Authorization', `Bearer ${key}`)).body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain('gpt-5.5');
  });

  it("the owner's own workspace is held to it too, so its keys use the copied BYOK provider", async () => {
    const h = setup();
    sellsOnly(h, ['seed-2-0-lite-260428']);
    const own = await customer(h, 'sub-o', 'owner@valefront.com', '203.0.113.9');
    expect((await chat(h, own.key, 'gpt-5.5')).body.error.code).toBe('model_not_offered');
    h.router.addProvider(AzureOpenAIProvider.forInstance({ id: 'pool-az', endpoint: 'https://pool.openai.azure.com/openai/v1', deployment: 'gpt-5.5', apiKey: POOL_SECRET }));
    expect((await request(h.app).post(`/admin/api/workspaces/${own.ws.id}/providers/from-pool`).set(ADMIN).send({ provider: 'AzureOpenAI:pool-az' })).status).toBe(201);
    expect((await chat(h, own.key, 'gpt-5.5')).status).toBe(200);
    expect(calls[0]!.url).toBe('https://pool.openai.azure.com/openai/v1/chat/completions');
  });
});
