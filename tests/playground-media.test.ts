import request from 'supertest';
import { ORIGIN, cookieFor, hostedBilling } from './helpers/hosted-billing';
import { workspace } from './helpers/billing-fixture';
import { BytePlusProvider } from '../src/providers/byteplus';

/**
 * The dash Playground (POST /dashboard/me/playground/…): a signed-in customer picks one of their keys by id; the
 * request runs exactly as that key would (price, credit, caps, spend lines). No key secret leaves the server.
 */

function fakeArk() {
  const calls: Array<{ method: string; url: string; body: any }> = [];
  const tasks = new Map<string, any>();
  const impl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? 'GET', url, body });
    if (url.endsWith('/images/generations')) return new Response(JSON.stringify({ model: body.model, data: [{ url: `https://ark.example/${calls.length}.jpeg` }] }));
    if (url.endsWith('/contents/generations/tasks') && init.method === 'POST') {
      const id = `cgt-${tasks.size + 1}`;
      tasks.set(id, { id, model: body.model, status: 'queued', resolution: body.resolution, duration: body.duration });
      return new Response(JSON.stringify({ id }));
    }
    const m = /\/contents\/generations\/tasks\/([^/]+)$/.exec(url);
    if (m) return new Response(JSON.stringify(tasks.get(m[1]!) ?? {}), { status: tasks.has(m[1]!) ? 200 : 404 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { calls, tasks, impl };
}

async function setup() {
  const up = fakeArk();
  jest.spyOn(global, 'fetch').mockImplementation(up.impl);
  const h = hostedBilling();
  h.router.addProvider(new BytePlusProvider('ark-key'));
  const ws = await workspace(h.store);
  const { record } = await h.keys.create({ name: 'Laptop', by: ws.email, workspaceId: ws.id });
  const session = { Cookie: cookieFor(ws.ownerSub, ws.email), Origin: ORIGIN };
  return { ...h, up, ws, keyId: record.id, session };
}

const IMAGE = { model: 'seedream-4-0-250828', prompt: 'a leaf' };

afterEach(() => jest.restoreAllMocks());

describe('dash Playground: images', () => {
  it('as the chosen key: 200, one BytePlus call, charged once at the catalog price, spend under that key', async () => {
    const h = await setup();
    await h.store.addAdjustment(h.ws.id, 1000, 'test credit', 'test:pg1');
    const res = await request(h.app).post('/dashboard/me/playground/images').set(h.session).send({ ...IMAGE, keyId: h.keyId });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ model: 'seedream-4-0-250828', provider: 'BytePlus', cost: 0.03 });
    expect(h.up.calls.filter((c) => c.url.endsWith('/images/generations'))).toHaveLength(1);
    // The key id is ours, never sent upstream.
    expect(h.up.calls[0]!.body.keyId).toBeUndefined();
    await h.settle();
    expect((await h.store.balance(h.ws.id)).availableMicros).toBe(10_000_000 - 30_000);
    const usage = await h.keys.usage(h.keyId);
    expect(usage.requests).toBe(1);
    expect(usage.byModel['seedream-4-0-250828']).toMatchObject({ requests: 1, usd: 0.03 });
    // Spending (GET /dashboard/me/usage) shows it under the key's name.
    const spending = await request(h.app).get('/dashboard/me/usage').set(h.session);
    expect(spending.body.keys.find((k: { id: string }) => k.id === h.keyId)).toMatchObject({ name: 'Laptop', usage: { requests: 1 } });
  });

  it('no credit: 402 with the API\'s refusal (add credit link), no provider call (media is never free)', async () => {
    const h = await setup();
    const res = await request(h.app).post('/dashboard/me/playground/images').set(h.session).send({ ...IMAGE, keyId: h.keyId });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatchObject({ code: 'insufficient_credit' });
    expect(res.body.error.message).toContain('https://dash.valefront.com/billing');
    expect(h.up.calls).toHaveLength(0);
  });

  it('a key of another workspace is not found; a revoked key is refused; no key is 400', async () => {
    const h = await setup();
    await h.store.addAdjustment(h.ws.id, 1000, 'test credit', 'test:pg2');
    const other = await workspace(h.store);
    await h.store.addAdjustment(other.id, 1000, 'test credit', 'test:pg3');
    const theirs = await h.keys.create({ name: 'theirs', by: other.email, workspaceId: other.id });
    const owner = await h.keys.create({ name: 'owner key', by: 'owner@valefront.com' });
    expect((await request(h.app).post('/dashboard/me/playground/images').set(h.session).send({ ...IMAGE, keyId: theirs.record.id })).status).toBe(404);
    expect((await request(h.app).post('/dashboard/me/playground/images').set(h.session).send({ ...IMAGE, keyId: owner.record.id })).status).toBe(404);
    expect((await request(h.app).post('/dashboard/me/playground/images').set(h.session).send({ ...IMAGE, keyId: 'nope' })).status).toBe(404);
    expect((await request(h.app).post('/dashboard/me/playground/images').set(h.session).send(IMAGE)).status).toBe(400);
    await h.keys.revoke(h.keyId);
    const revoked = await request(h.app).post('/dashboard/me/playground/images').set(h.session).send({ ...IMAGE, keyId: h.keyId });
    expect(revoked.status).toBe(409);
    expect(revoked.body.error.code).toBe('key_revoked');
    expect(h.up.calls).toHaveLength(0);
    await h.settle();
    expect((await h.store.balance(other.id)).availableMicros).toBe(10_000_000);
  });

  it('the key\'s caps apply (its model list); a suspended workspace is refused', async () => {
    const h = await setup();
    await h.store.addAdjustment(h.ws.id, 1000, 'test credit', 'test:pg4');
    await h.keys.setCaps(h.keyId, { models: ['seed-2-0-lite-260428'] });
    expect((await request(h.app).post('/dashboard/me/playground/images').set(h.session).send({ ...IMAGE, keyId: h.keyId })).status).toBe(403);
    await h.keys.setCaps(h.keyId, {});
    await h.store.setSuspended(h.ws.id, true);
    const res = await request(h.app).post('/dashboard/me/playground/images').set(h.session).send({ ...IMAGE, keyId: h.keyId });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('workspace_or_key_suspended');
    expect(h.up.calls).toHaveLength(0);
  });

  it('signed out: 401; cross-origin POST: 403; a form post: 415; none calls a provider', async () => {
    const h = await setup();
    await h.store.addAdjustment(h.ws.id, 1000, 'test credit', 'test:pg5');
    const out = await request(h.app).post('/dashboard/me/playground/images').set('Origin', ORIGIN).send({ ...IMAGE, keyId: h.keyId });
    expect(out.status).toBe(401);
    const cross = await request(h.app).post('/dashboard/me/playground/images').set({ ...h.session, Origin: 'https://evil.example' }).send({ ...IMAGE, keyId: h.keyId });
    expect(cross.status).toBe(403);
    expect(cross.body.error.code).toBe('forbidden');
    // A cross-site HTML form (no Origin from an old browser, form-encoded): refused before anything runs.
    const form = await request(h.app).post('/dashboard/me/playground/images').set('Cookie', h.session.Cookie).type('form').send({ ...IMAGE, keyId: h.keyId });
    expect(form.status).toBe(415);
    expect(h.up.calls).toHaveLength(0);
  });
});

describe('dash Playground: videos', () => {
  it('started and polled as the chosen key; charged once when finished; another key or workspace can\'t poll it', async () => {
    const h = await setup();
    await h.store.addAdjustment(h.ws.id, 1000, 'test credit', 'test:pg6');
    const created = await request(h.app).post('/dashboard/me/playground/videos').set(h.session).send({ model: 'seedance-1-0-pro-fast-251015', prompt: 'waves', keyId: h.keyId });
    expect(created.status).toBe(202);
    const id = created.body.id as string;
    Object.assign(h.up.tasks.get('cgt-1'), { status: 'succeeded', content: { video_url: 'https://ark.example/v.mp4' }, usage: { completion_tokens: 246_000, total_tokens: 246_000 } });

    // Another workspace's session, with its own key: not found.
    const other = await workspace(h.store);
    const theirs = await h.keys.create({ name: 'theirs', by: other.email, workspaceId: other.id });
    const otherSession = { Cookie: cookieFor(other.ownerSub, other.email), Origin: ORIGIN };
    expect((await request(h.app).get(`/dashboard/me/playground/videos/${id}`).query({ keyId: theirs.record.id }).set(otherSession)).status).toBe(404);
    // ... nor with this workspace's key id.
    expect((await request(h.app).get(`/dashboard/me/playground/videos/${id}`).query({ keyId: h.keyId }).set(otherSession)).status).toBe(404);
    // Another key of the same workspace: not found either (a job belongs to the key that started it).
    const second = await h.keys.create({ name: 'second', by: h.ws.email, workspaceId: h.ws.id });
    expect((await request(h.app).get(`/dashboard/me/playground/videos/${id}`).query({ keyId: second.record.id }).set(h.session)).status).toBe(404);
    expect((await request(h.app).get(`/dashboard/me/playground/videos/${id}`).query({ keyId: h.keyId })).status).toBe(401);

    const done = await request(h.app).get(`/dashboard/me/playground/videos/${id}`).query({ keyId: h.keyId }).set(h.session);
    expect(done.body).toMatchObject({ status: 'succeeded', url: 'https://ark.example/v.mp4', cost: 0.246 });
    await request(h.app).get(`/dashboard/me/playground/videos/${id}`).query({ keyId: h.keyId }).set(h.session);
    await h.settle();
    expect((await h.store.balance(h.ws.id)).availableMicros).toBe(10_000_000 - 246_000);
    expect((await h.keys.usage(h.keyId)).byModel['seedance-1-0-pro-fast-251015']).toMatchObject({ requests: 1, usd: 0.246 });
    expect((await h.store.balance(other.id)).availableMicros).toBe(0);
  });
});
