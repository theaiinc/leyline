import { webcrypto } from 'node:crypto';
import axios from 'axios';
import request from 'supertest';
import { TERMS_VERSION } from '../src/core/self-serve-workspaces';
import { D1WorkspaceProviderStore, WorkspaceProviders } from '../src/core/workspace-providers';
import { ORIGIN, cookieFor, hostedBilling } from './helpers/hosted-billing';
import { workspace } from './helpers/billing-fixture';

if (!globalThis.crypto) (globalThis as { crypto?: unknown }).crypto = webcrypto;

/**
 * The dash Playground's Chat (POST /dashboard/me/playground/chat): a signed-in customer picks one of their keys by
 * id and the chat runs exactly as that key calling /v1/chat/completions (same handler, same admission, price, credit,
 * caps and spend lines); the answer also says what it was charged.
 */

const STORE_KEY = Buffer.alloc(32, 9).toString('base64');
const PATH = '/dashboard/me/playground/chat';
const HI = { messages: [{ role: 'user', content: 'hi' }] };
type Over = Parameters<typeof hostedBilling>[0];

async function setup(over?: Over) {
  const h = hostedBilling(over);
  const ws = await workspace(h.store);
  const { key, record } = await h.keys.create({ name: 'Laptop', by: ws.email, workspaceId: ws.id });
  const session = { Cookie: cookieFor(ws.ownerSub, ws.email), Origin: ORIGIN };
  const play = (body: Record<string, unknown>, headers: Record<string, string> = session) => request(h.app).post(PATH).set(headers).send({ ...HI, keyId: record.id, ...body });
  const api = (body: Record<string, unknown>) => request(h.app).post('/v1/chat/completions').set('Authorization', `Bearer ${key}`).send({ ...HI, ...body });
  return { ...h, ws, key, keyId: record.id, session, play, api };
}

afterEach(() => jest.restoreAllMocks());

describe('dash Playground: chat', () => {
  it('as the chosen key: 200, the answer with its usage and charge, spend and credit under that key', async () => {
    const h = await setup();
    await h.store.addAdjustment(h.ws.id, 1000, 'test credit', 'test:pgc1');
    const res = await h.play({ model: 'gpt-5.5', max_tokens: 50 });
    expect(res.status).toBe(200);
    // 1000 input at $5/1M + 1000 output at $15/1M.
    expect(res.body).toMatchObject({ object: 'chat.completion', model: 'gpt-5.5', choices: [{ message: { content: 'Hi' } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 }, cost: 0.02 });
    expect(h.upstream.seen).toHaveLength(1);
    expect(h.upstream.seen[0]!.max_tokens).toBe(50);
    expect((h.upstream.seen[0] as unknown as Record<string, unknown>).keyId).toBeUndefined();
    await h.settle();
    expect((await h.store.balance(h.ws.id)).availableMicros).toBe(10_000_000 - 20_000);
    const usage = await h.keys.usage(h.keyId);
    expect(usage.requests).toBe(1);
    expect(usage.byModel['gpt-5.5']).toMatchObject({ requests: 1, usd: 0.02 });
    // The API's answer is unchanged (no `cost`).
    const direct = await h.api({ model: 'gpt-5.5' });
    expect(direct.status).toBe(200);
    expect(direct.body.cost).toBeUndefined();
  });

  it('plain auto and a strategy route as the key would (to a model Valefront sells, charged)', async () => {
    const h = await setup();
    await h.store.addAdjustment(h.ws.id, 1000, 'test credit', 'test:pgc2');
    for (const model of ['auto', 'auto:cheapest']) {
      const res = await h.play({ model });
      expect(res.status).toBe(200);
      expect(['seed-2-0-lite-260428', 'gpt-5.5']).toContain(res.body.model);
      expect(typeof res.body.cost).toBe('number');
    }
    expect((await h.play({ model: 'auto:nope' })).body.error.code).toBe('unknown_routing_strategy');
  });

  it('streams like the API when asked', async () => {
    const h = await setup();
    await h.store.addAdjustment(h.ws.id, 1000, 'test credit', 'test:pgc3');
    const res = await h.play({ model: 'gpt-5.5', stream: true });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.text).toContain('data: [DONE]');
    await h.settle();
    expect((await h.keys.usage(h.keyId)).requests).toBe(1);
  });

  it('refuses exactly as the API does: turned off, not offered, not sold, unpriced, no credit; nothing upstream', async () => {
    const h = await setup({ hosted: { blockedModels: ['gpt-*'] } });
    const cases: Array<[string, number, string]> = [
      ['gpt-5.5', 403, 'model_disabled'],
      ['no-such-model', 404, 'model_not_found'],
      ['unpriced-model', 403, 'model_not_priced'],
    ];
    for (const [model, status, code] of cases) {
      const play = await h.play({ model });
      const api = await h.api({ model });
      expect([play.status, play.body.error?.code]).toEqual([status, code]);
      expect(play.body).toEqual(api.body);
    }
    // Not sold to workspace keys (the test catalog): the same "add your own provider" refusal.
    const h2 = await setup({ hosted: { soldModel: (m) => m === 'seed-2-0-lite-260428' } });
    const notSold = await h2.play({ model: 'gpt-5.5' });
    expect(notSold.status).toBe(404);
    expect(notSold.body).toEqual((await h2.api({ model: 'gpt-5.5' })).body);
    expect(notSold.body.error.code).toBe('model_not_offered');
    // No credit: the free-tier model runs on free tokens; a paid one is 402 with the API's body.
    expect((await h2.play({ model: 'seed-2-0-lite-260428' })).status).toBe(200);
    const h3 = await setup();
    const paid = await h3.play({ model: 'gpt-5.5' });
    expect(paid.status).toBe(402);
    expect(paid.body).toEqual((await h3.api({ model: 'gpt-5.5' })).body);
    expect(h.upstream.seen).toHaveLength(0);
    expect(h3.upstream.seen).toHaveLength(0);
  });

  it('the key\'s caps apply (its model list); a suspended workspace is refused', async () => {
    const h = await setup();
    await h.store.addAdjustment(h.ws.id, 1000, 'test credit', 'test:pgc4');
    await h.keys.setCaps(h.keyId, { models: ['seed-2-0-lite-260428'] });
    const capped = await h.play({ model: 'gpt-5.5' });
    expect(capped.status).toBe(403);
    expect(capped.body).toEqual((await h.api({ model: 'gpt-5.5' })).body);
    await h.keys.setCaps(h.keyId, {});
    await h.store.setSuspended(h.ws.id, true);
    const res = await h.play({ model: 'gpt-5.5' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('workspace_or_key_suspended');
    expect(h.upstream.seen).toHaveLength(0);
  });

  it('signed out 401; another workspace\'s or the owner\'s key 404; revoked 409; no key 400; cross-site 403; form 415', async () => {
    const h = await setup();
    await h.store.addAdjustment(h.ws.id, 1000, 'test credit', 'test:pgc5');
    const other = await workspace(h.store);
    await h.store.addAdjustment(other.id, 1000, 'test credit', 'test:pgc6');
    const theirs = await h.keys.create({ name: 'theirs', by: other.email, workspaceId: other.id });
    const owner = await h.keys.create({ name: 'owner key', by: 'owner@valefront.com' });
    const body = { ...HI, model: 'gpt-5.5' };
    expect((await request(h.app).post(PATH).set('Origin', ORIGIN).send({ ...body, keyId: h.keyId })).status).toBe(401);
    // Signed in as a key's own user, but with a key secret instead of a session: still 401 (the route takes no key).
    expect((await request(h.app).post(PATH).set({ Origin: ORIGIN, Authorization: `Bearer ${h.key}` }).send({ ...body, keyId: h.keyId })).status).toBe(401);
    expect((await h.play({ model: 'gpt-5.5', keyId: theirs.record.id })).status).toBe(404);
    expect((await h.play({ model: 'gpt-5.5', keyId: owner.record.id })).status).toBe(404);
    expect((await h.play({ model: 'gpt-5.5', keyId: 'nope' })).body.error.code).toBe('key_not_found');
    expect((await request(h.app).post(PATH).set(h.session).send(body)).status).toBe(400);
    const cross = await h.play({ model: 'gpt-5.5' }, { ...h.session, Origin: 'https://evil.example' });
    expect([cross.status, cross.body.error.code]).toEqual([403, 'forbidden']);
    expect((await request(h.app).post(PATH).set('Cookie', h.session.Cookie).type('form').send({ model: 'gpt-5.5', keyId: h.keyId })).status).toBe(415);
    await h.keys.revoke(h.keyId);
    expect((await h.play({ model: 'gpt-5.5' })).body.error.code).toBe('key_revoked');
    expect(h.upstream.seen).toHaveLength(0);
    await h.settle();
    expect((await h.store.balance(other.id)).availableMicros).toBe(10_000_000);
    expect((await h.keys.usage(theirs.record.id)).requests).toBe(0);
  });
});

describe('dash Playground: chat on the workspace\'s own provider', () => {
  const calls: Array<{ url: string; auth?: string; model?: string }> = [];
  const completion = (model: string) => ({ id: 'up1', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: 'From your own provider' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 } });
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    calls.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const h = new Headers(init?.headers);
      calls.push({ url, auth: h.get('authorization') ?? undefined, model: body.model });
      return new Response(JSON.stringify(completion(String(body.model))), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    jest.spyOn(axios, 'post').mockImplementation(async (url: string, body: unknown, config?: { headers?: unknown }) => {
      const headers = (config?.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: headers.Authorization ?? headers.authorization, model: (body as { model?: string }).model });
      return { data: completion(String((body as { model?: string }).model)), status: 200 };
    });
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('runs on the workspace provider, without credit, charged $0 and counted on its BYOK spend line', async () => {
    const h = hostedBilling();
    h.hosted.workspaceProviders = new WorkspaceProviders(new D1WorkspaceProviderStore(h.db, STORE_KEY, () => h.clock.now), 0);
    const cookie = cookieFor('sub-own', 'own@example.com');
    const signed = await request(h.app).post('/dashboard/me/workspace').set('Cookie', cookie).set('Origin', ORIGIN).set('CF-Connecting-IP', '203.0.113.9')
      .send({ acceptTerms: true, termsVersion: TERMS_VERSION, turnstileToken: 'ok-token' });
    expect(signed.status).toBeLessThan(300);
    const ws = (await h.store.workspaceBySub('sub-own'))!;
    const added = await request(h.app).post('/dashboard/me/providers').set('Cookie', cookie).set('Origin', ORIGIN)
      .send({ kind: 'openai-compatible', label: 'My gateway', baseUrl: 'https://gateway.example.com/v1', models: ['my-gpt'], apiKey: 'sk-customer-secret-0123456789' });
    expect(added.status).toBe(201);
    // The Playground lists it for Chat.
    const listed = await request(h.app).get('/dashboard/me/providers').set('Cookie', cookie);
    expect(listed.body.chatModels).toEqual([{ id: 'my-gpt', provider: 'BYOK:My gateway', byok: true }]);
    const keyId = (await h.keys.listForWorkspace(ws.id))[0]!.id;
    const before = await h.store.balance(ws.id);
    const res = await request(h.app).post(PATH).set({ Cookie: cookie, Origin: ORIGIN }).send({ ...HI, keyId, model: 'my-gpt' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ choices: [{ message: { content: 'From your own provider' } }], cost: 0 });
    expect(calls.map((c) => [c.url.startsWith('https://gateway.example.com/v1'), c.auth, c.model])).toEqual([[true, 'Bearer sk-customer-secret-0123456789', 'my-gpt']]);
    expect(h.upstream.seen).toHaveLength(0);
    await h.settle();
    expect(await h.store.balance(ws.id)).toEqual(before);
    expect((await h.keys.spend()).byProvider?.['BYOK:My gateway']).toEqual({ usd: 0, requests: 1, tokens: 2000 });
    expect((await h.keys.usage(keyId)).requests).toBe(1);
  });
});
