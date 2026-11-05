import request from 'supertest';
import { createServer } from '../src/server';
import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { ModelRegistry } from '../src/core/model-registry';
import { DEFAULT_PRICE, IssuedKeys, MemoryDocStore, costUsd, update, type IssuedKey, type KeyUsage, type MonthSpend, type Price } from '../src/core/issued-keys';
import { MemorySecretStore } from '../src/core/secret-store';
import { priceRatio, repriceSpend, RepriceRefused } from '../src/core/spend-reprice';
import type { HostedOptions } from '../src/core/hosted';
import type { CompletionRequest, CompletionResponse, Provider, StreamChunk } from '../src/core/types';

const NOW = Date.parse('2026-11-05T09:00:00Z');
const FROM: Price = DEFAULT_PRICE; // { input: 10, output: 40 }: cached input defaults to 1
const TO: Price = { input: 0.2, output: 0.8 };

type Usage = { prompt_tokens: number; completion_tokens: number; cached_tokens?: number };
/** Requests the way hosted records them: [UTC time, provider, served model, usage, price it was costed at]. */
const REQUESTS: Array<[string, string, string, Usage, Price]> = [
  ['2026-11-02T08:00:00Z', 'LLM API', 'deepseek-v4-flash', { prompt_tokens: 1000, completion_tokens: 200, cached_tokens: 400 }, FROM],
  ['2026-11-02T09:00:00Z', 'LLM API', 'deepseek-v4-flash', { prompt_tokens: 12_345, completion_tokens: 678 }, FROM],
  ['2026-11-03T10:00:00Z', 'LLM API', 'deepseek-v4-flash', { prompt_tokens: 5000, completion_tokens: 1000, cached_tokens: 2500 }, FROM],
  ['2026-11-03T11:00:00Z', 'LLM API', 'deepseek-v4-flash-preview', { prompt_tokens: 300, completion_tokens: 90 }, FROM],
  ['2026-11-03T12:00:00Z', 'LLM API', 'deepseek-v4-pro', { prompt_tokens: 2000, completion_tokens: 500 }, FROM],
  ['2026-11-03T13:00:00Z', 'BytePlus', 'deepseek-v4-flash', { prompt_tokens: 4000, completion_tokens: 800 }, { input: 0.14, output: 0.28 }],
  ['2026-11-04T14:00:00Z', 'Anthropic', 'claude-sonnet-5-5', { prompt_tokens: 3000, completion_tokens: 400 }, { input: 3, output: 15 }],
];

/** A month recorded through IssuedKeys.record (the real write path), with one key's usage. */
async function seeded() {
  const store = new MemoryDocStore();
  let now = NOW;
  const keys = new IssuedKeys(store, { now: () => now });
  const key = (await keys.create({ name: 'agent', by: 'test' })).record;
  for (const [at, provider, model, usage, price] of REQUESTS) {
    now = Date.parse(at);
    await keys.record(key, 'auto', usage, costUsd(price, usage), { provider, model });
  }
  now = NOW;
  return { store, keys, key };
}

const month = async (store: MemoryDocStore) => (await store.get<MonthSpend>('spend/2026-11'))!.value;
/** What a set of requests should have cost at a price, computed request by request. */
const costAt = (price: Price, pick: (r: (typeof REQUESTS)[number]) => boolean) => REQUESTS.filter(pick).reduce((s, r) => s + costUsd(price, r[3]), 0);
const flash = (r: (typeof REQUESTS)[number]) => r[1] === 'LLM API' && r[2].startsWith('deepseek-v4-flash');
const body = (over: Record<string, unknown> = {}) => ({ month: '2026-11', provider: 'LLM API', model: 'deepseek-v4-flash*', from: FROM, to: TO, dryRun: false, ...over });

describe('spend reprice', () => {
  it('rescales the matching lines to what the requests cost at the right price, and takes the exact difference off', async () => {
    const { store } = await seeded();
    const before = await month(store);
    const r = await repriceSpend(store, body(), { by: 'token', now: NOW });
    const after = await month(store);

    expect(r.ratio).toBeCloseTo(0.02, 15);
    const wrong = costAt(FROM, flash);
    const right = costAt(TO, flash);
    expect(r.usdDelta).toBeCloseTo(wrong - right, 12);
    // Each served-model line is what its requests cost at the right price, request by request.
    expect(after.byModel!['LLM API/deepseek-v4-flash'].usd).toBeCloseTo(costAt(TO, (x) => x[1] === 'LLM API' && x[2] === 'deepseek-v4-flash'), 12);
    expect(after.byModel!['LLM API/deepseek-v4-flash-preview'].usd).toBeCloseTo(costAt(TO, (x) => x[2] === 'deepseek-v4-flash-preview'), 12);
    // Requests and tokens stay.
    expect(after.byModel!['LLM API/deepseek-v4-flash']).toMatchObject({ requests: 3, tokens: before.byModel!['LLM API/deepseek-v4-flash'].tokens, cachedTokens: 2900, provider: 'LLM API', model: 'deepseek-v4-flash' });
    // byProvider is a SpendLine: its usd drops by the difference, the rest stays.
    expect(after.byProvider!['LLM API'].usd).toBeCloseTo(before.byProvider!['LLM API'].usd - (wrong - right), 12);
    expect(after.byProvider!['LLM API'].requests).toBe(before.byProvider!['LLM API'].requests);
    expect(after.usd).toBeCloseTo(before.usd - (wrong - right), 12);
    expect(after.requests).toBe(before.requests);
    // byDay, keyed by provider/model (no provider/model fields on the line).
    expect(after.byDay!['2026-11-02']['LLM API/deepseek-v4-flash'].usd).toBeCloseTo(costAt(TO, (x) => flash(x) && x[0].startsWith('2026-11-02')), 12);
    expect(after.byDay!['2026-11-03']['LLM API/deepseek-v4-flash'].usd).toBeCloseTo(costAt(TO, (x) => x[2] === 'deepseek-v4-flash' && x[1] === 'LLM API' && x[0].startsWith('2026-11-03')), 12);
    // Everything else is untouched: another LLM API model, the same model at another provider, other providers.
    for (const k of ['LLM API/deepseek-v4-pro', 'BytePlus/deepseek-v4-flash', 'Anthropic/claude-sonnet-5-5']) expect(after.byModel![k]).toEqual(before.byModel![k]);
    expect(after.byDay!['2026-11-03']['LLM API/deepseek-v4-pro']).toEqual(before.byDay!['2026-11-03']['LLM API/deepseek-v4-pro']);
    expect(after.byProvider!.BytePlus).toEqual(before.byProvider!.BytePlus);
    expect(after.adjustments).toEqual([expect.objectContaining({ id: r.adjustmentId, by: 'token', lines: ['LLM API/deepseek-v4-flash', 'LLM API/deepseek-v4-flash-preview'], usdDelta: r.usdDelta })]);
  });

  it('matches an exact model only when no * is given', async () => {
    const { store } = await seeded();
    const before = await month(store);
    await repriceSpend(store, body({ model: 'deepseek-v4-flash' }), { by: 'token', now: NOW });
    const after = await month(store);
    expect(after.byModel!['LLM API/deepseek-v4-flash-preview']).toEqual(before.byModel!['LLM API/deepseek-v4-flash-preview']);
    expect(after.byModel!['LLM API/deepseek-v4-flash'].usd).toBeCloseTo(before.byModel!['LLM API/deepseek-v4-flash'].usd * 0.02, 12);
  });

  it('a dry run returns before and after per line and writes nothing', async () => {
    const { store } = await seeded();
    const raw = await store.get<MonthSpend>('spend/2026-11');
    const r = await repriceSpend(store, body({ dryRun: true }), { by: 'token', now: NOW });
    expect(r.dryRun).toBe(true);
    expect(await store.get<MonthSpend>('spend/2026-11')).toEqual(raw); // same value, same generation
    const line = r.lines.find((l) => l.line === 'byModel/LLM API/deepseek-v4-flash')!;
    expect(line.after).toBeCloseTo(line.before * 0.02, 15);
    expect(r.lines.map((l) => l.line)).toEqual([
      'byDay/2026-11-02/LLM API/deepseek-v4-flash', 'byDay/2026-11-03/LLM API/deepseek-v4-flash', 'byModel/LLM API/deepseek-v4-flash',
      'byDay/2026-11-03/LLM API/deepseek-v4-flash-preview', 'byModel/LLM API/deepseek-v4-flash-preview',
      'byProvider/LLM API', 'total',
    ]);
    // Leaving dryRun out is a dry run too.
    const { dryRun: _d, ...noFlag } = body();
    expect((await repriceSpend(store, noFlag, { by: 'token', now: NOW })).dryRun).toBe(true);
    expect(await store.get<MonthSpend>('spend/2026-11')).toEqual(raw);
  });

  it('is applied once: running it again changes nothing, and the record survives later requests', async () => {
    const { store, keys, key } = await seeded();
    const first = await repriceSpend(store, body(), { by: 'token', now: NOW });
    const once = await month(store);
    const second = await repriceSpend(store, body(), { by: 'token', now: NOW });
    expect(second).toMatchObject({ adjustmentId: first.adjustmentId, alreadyApplied: true, usdDelta: 0, lines: [] });
    expect(await month(store)).toEqual(once);
    // A request recorded afterwards keeps the adjustment, so a third run is still a no-op.
    await keys.record(key, 'auto', { prompt_tokens: 10, completion_tokens: 1 }, 0.001, { provider: 'Anthropic', model: 'claude-sonnet-5-5' });
    expect((await month(store)).adjustments?.map((a) => a.id)).toEqual([first.adjustmentId]);
    expect((await repriceSpend(store, body(), { by: 'token', now: NOW })).alreadyApplied).toBe(true);
  });

  it('refuses a different correction of lines already corrected (it would apply twice)', async () => {
    const { store } = await seeded();
    await repriceSpend(store, body(), { by: 'token', now: NOW });
    await expect(repriceSpend(store, body({ model: 'deepseek-v4-flash', to: { input: 0.1, output: 0.4 } }), { by: 'token', now: NOW })).rejects.toMatchObject({ status: 409 });
  });

  it('can correct only some days (when the price was fixed mid-month)', async () => {
    const { store } = await seeded();
    const before = await month(store);
    const r = await repriceSpend(store, body({ model: 'deepseek-v4-flash', days: ['2026-11-02'] }), { by: 'token', now: NOW });
    const after = await month(store);
    const day2 = before.byDay!['2026-11-02']['LLM API/deepseek-v4-flash'].usd;
    expect(r.usdDelta).toBeCloseTo(day2 * 0.98, 12);
    expect(after.byDay!['2026-11-03']['LLM API/deepseek-v4-flash']).toEqual(before.byDay!['2026-11-03']['LLM API/deepseek-v4-flash']);
    expect(after.byModel!['LLM API/deepseek-v4-flash'].usd).toBeCloseTo(before.byModel!['LLM API/deepseek-v4-flash'].usd - day2 * 0.98, 12);
    expect(after.usd).toBeCloseTo(before.usd - day2 * 0.98, 12);
  });

  it('refuses prices that differ by different factors for input, output or cached input', () => {
    expect(() => priceRatio(FROM, { input: 0.2, output: 1 })).toThrow(RepriceRefused);
    expect(() => priceRatio(FROM, { input: 0.2, output: 0.8, cachedInput: 0.05 })).toThrow(/proportional/);
    expect(() => priceRatio({ input: 10, output: 40, cachedInput: 5 }, TO)).toThrow(/proportional/);
    expect(() => priceRatio({ input: 0, output: 40 }, { input: 1, output: 0.8 })).toThrow(RepriceRefused);
    expect(priceRatio(FROM, { input: 0.2, output: 0.8, cachedInput: 0.02 })).toBeCloseTo(0.02, 15);
  });

  it('refuses non-proportional prices and months other than this one and last, writing nothing', async () => {
    const { store } = await seeded();
    const raw = await store.get<MonthSpend>('spend/2026-11');
    await expect(repriceSpend(store, body({ to: { input: 0.2, output: 1.2 } }), { by: 'token', now: NOW })).rejects.toMatchObject({ status: 400 });
    await expect(repriceSpend(store, body({ month: '2026-09' }), { by: 'token', now: NOW })).rejects.toThrow(/Only this month/);
    await expect(repriceSpend(store, body({ month: '2026-12' }), { by: 'token', now: NOW })).rejects.toThrow(/Only this month/);
    await expect(repriceSpend(store, body({ model: 'deep*seek' }), { by: 'token', now: NOW })).rejects.toMatchObject({ status: 400 });
    await expect(repriceSpend(store, body({ model: 'nothing-like-this' }), { by: 'token', now: NOW })).rejects.toMatchObject({ status: 404 });
    expect(await store.get<MonthSpend>('spend/2026-11')).toEqual(raw);
    // Last month is allowed (from December, November is).
    await expect(repriceSpend(store, body({ dryRun: true }), { by: 'token', now: Date.parse('2026-12-01T00:00:00Z') })).resolves.toMatchObject({ month: '2026-11' });
  });

  it('leaves per-key usage unchanged and says it is not split by served model', async () => {
    const { store, key } = await seeded();
    const usage = (await store.get<KeyUsage>(`usage/${key.id}/2026-11`))!.value;
    const r = await repriceSpend(store, body(), { by: 'token', now: NOW });
    expect(r.keyUsage).toEqual([{ keyId: key.id, usd: usage.usd, note: 'not split by served model' }]);
    expect((await store.get<KeyUsage>(`usage/${key.id}/2026-11`))!.value).toEqual(usage);
  });
});

class Upstream implements Provider {
  name = 'Fake';
  defaultModel = 'gemini-2.5-pro';
  async isAvailable() { return true; }
  async getModels() { return [{ id: 'gemini-2.5-pro' }]; }
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    return { id: 'c', object: 'chat.completion', created: 1, model: req.model, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } };
  }
  async *completeStream(req: CompletionRequest): AsyncGenerator<StreamChunk> {
    yield { id: 's', object: 'chat.completion.chunk', created: 1, model: req.model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] };
  }
}

function app(over: Partial<HostedOptions> = {}) {
  const quotaManager = new QuotaManager();
  const router = new Router({ quotaManager, modelRegistry: new ModelRegistry() });
  router.addProvider(new Upstream());
  const store = new MemoryDocStore();
  const keys = new IssuedKeys(store);
  const { AegisAuth } = require('../src/core/admin-login') as typeof import('../src/core/admin-login');
  const login = new AegisAuth({ issuer: 'https://id.example', clientId: 'c', clientSecret: 's', redirectUri: 'https://leyline.test/auth/callback', sessionSecret: 'test-session-secret' });
  const hosted: HostedOptions = { keys, models: ['gemini-2.5-pro'], aliases: {}, login, adminEmails: ['owner@example.com'], adminToken: 'admin-secret-token', publicUrl: 'https://leyline.test', ...over };
  return { app: createServer(router, quotaManager, { hosted, enforceExternalSurface: false, apiKeyStore: new MemorySecretStore() }), keys, store };
}
const ADMIN = { Authorization: 'Bearer admin-secret-token' };
const cookieFor = (email: string) => {
  const { sign } = require('../src/core/admin-login') as typeof import('../src/core/admin-login');
  return `leyline_session=${sign({ sub: 'u1', email, exp: Math.floor(Date.now() / 1000) + 3600 }, 'test-session-secret')}`;
};

describe('POST /admin/api/spend/reprice', () => {
  const thisMonth = new Date().toISOString().slice(0, 7);
  const seed = async (keys: IssuedKeys) => {
    const usage = { prompt_tokens: 10_000, completion_tokens: 2000, cached_tokens: 1000 };
    await keys.record(null, 'auto', usage, costUsd(FROM, usage), { provider: 'LLM API', model: 'deepseek-v4-flash' });
    return costUsd(FROM, usage);
  };
  const reprice = (over: Record<string, unknown> = {}) => ({ month: thisMonth, provider: 'LLM API', model: 'deepseek-v4-flash*', from: FROM, to: TO, ...over });

  it('admins only: no credentials 401, a signed-in non-owner 401, an issued key 401, an owner from another origin 403', async () => {
    const { app: a, keys } = app();
    await seed(keys);
    const { key } = await keys.create({ name: 'k', by: 'test' });
    expect((await request(a).post('/admin/api/spend/reprice').send(reprice({ dryRun: false }))).status).toBe(401);
    expect((await request(a).post('/admin/api/spend/reprice').set('Cookie', cookieFor('someone@example.com')).send(reprice({ dryRun: false }))).status).toBe(401);
    expect((await request(a).post('/admin/api/spend/reprice').set({ Authorization: `Bearer ${key}` }).send(reprice({ dryRun: false }))).status).toBe(401);
    expect((await request(a).post('/admin/api/spend/reprice').set('Cookie', cookieFor('owner@example.com')).set('Origin', 'https://evil.example').send(reprice({ dryRun: false }))).status).toBe(403);
    expect((await keys.spend()).adjustments).toBeUndefined();
    // The owner on the dashboard's own origin may.
    expect((await request(a).post('/admin/api/spend/reprice').set('Cookie', cookieFor('owner@example.com')).set('Origin', 'https://leyline.test').send(reprice())).status).toBe(200);
  });

  it('dry run, then the real run, then a no-op; refusals are 400 with the reason', async () => {
    const { app: a, keys } = app();
    const wrong = await seed(keys);
    const dry = await request(a).post('/admin/api/spend/reprice').set(ADMIN).send(reprice({ dryRun: true }));
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, alreadyApplied: false });
    expect((await keys.spend()).usd).toBe(wrong);
    const run = await request(a).post('/admin/api/spend/reprice').set(ADMIN).send(reprice({ dryRun: false }));
    expect(run.body).toMatchObject({ dryRun: false, alreadyApplied: false, adjustmentId: dry.body.adjustmentId });
    expect((await keys.spend()).usd).toBeCloseTo(wrong * 0.02, 15);
    const again = await request(a).post('/admin/api/spend/reprice').set(ADMIN).send(reprice({ dryRun: false }));
    expect(again.body).toMatchObject({ alreadyApplied: true, usdDelta: 0 });
    expect((await keys.spend()).usd).toBeCloseTo(wrong * 0.02, 15);
    const bad = await request(a).post('/admin/api/spend/reprice').set(ADMIN).send(reprice({ to: { input: 0.2, output: 2 }, dryRun: false }));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/proportional/);
    // The dashboard's spend view shows the corrected month.
    expect((await request(a).get('/admin/api/spend').set(ADMIN)).body.spend.usd).toBeCloseTo(wrong * 0.02, 15);
  });
});

describe('the monthly limit is the owner\'s, not customers\'', () => {
  const chat = (a: ReturnType<typeof app>['app'], key: string) =>
    request(a).post('/v1/chat/completions').set({ Authorization: `Bearer ${key}` }).send({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }] });
  /** A month already over a $1 limit. */
  const overLimit = async (keys: IssuedKeys) => keys.record(null, 'x', { prompt_tokens: 1, completion_tokens: 1 }, 5, { provider: 'Fake', model: 'x' });
  const inWorkspace = async (keys: IssuedKeys, workspaceId: string) => {
    const { key, record } = await keys.create({ name: workspaceId, by: 'test' });
    await update<IssuedKey>(keys.docs, `keys/${record.id}`, (cur) => ({ ...cur!, workspaceId }));
    return key;
  };
  /** The shape of self-serve billing (#75): a workspace store, credit admission, charging. */
  const billing = (emails: Record<string, string>) => ({
    store: { workspace: async (id: string) => (emails[id] !== undefined ? { id, email: emails[id], deletedAt: null, suspendedAt: null } : null) },
    admit: async () => ({ ok: true }),
    charge: async () => undefined,
  });
  const prices = { 'gemini-*': { input: 1, output: 1 } };

  it('keys without a workspace (every key, before self-serve) are refused at the limit, as before', async () => {
    const { app: a, keys } = app({ monthlyBudgetUsd: 1, prices });
    const { key } = await keys.create({ name: 'owner agent', by: 'test' });
    await overLimit(keys);
    const r = await chat(a, key);
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('budget_exhausted');
  });

  it('a customer workspace key is never refused because of the owner\'s spend; an admin\'s own workspace is', async () => {
    const over = { monthlyBudgetUsd: 1, prices, billing: billing({ ws_customer: 'buyer@example.org', ws_owner: 'Owner@Example.com' }) } as unknown as Partial<HostedOptions>;
    const { app: a, keys } = app(over);
    await overLimit(keys);
    expect((await chat(a, await inWorkspace(keys, 'ws_customer'))).status).toBe(200);
    const owner = await chat(a, await inWorkspace(keys, 'ws_owner'));
    expect(owner.status).toBe(429);
    expect(owner.body.error.code).toBe('budget_exhausted');
    // And plain owner keys still are.
    expect((await chat(a, (await keys.create({ name: 'internal', by: 'test' })).key)).status).toBe(429);
  });

  it('a workspace key whose workspace can\'t be read is not refused by the owner\'s limit', async () => {
    const failing = { store: { workspace: async () => { throw new Error('d1 down'); } }, admit: async () => ({ ok: true }), charge: async () => undefined };
    const { ownerLimitFor } = require('../src/core/hosted') as typeof import('../src/core/hosted');
    const { keys } = app();
    const record = { ...(await keys.create({ name: 'c', by: 'test' })).record, workspaceId: 'ws_x' };
    const base = { keys, models: [], aliases: {}, login: null, adminEmails: ['owner@example.com'], publicUrl: 'https://leyline.test', monthlyBudgetUsd: 1 } as HostedOptions;
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await ownerLimitFor({ ...base, billing: failing } as unknown as HostedOptions, record)).toBeNull();
    spy.mockRestore();
    expect(await ownerLimitFor(base, record)).toBeNull(); // no billing configured: billing's own check refuses it
    expect(await ownerLimitFor(base, { ...record, workspaceId: undefined })).toBe(1);
    expect(await ownerLimitFor({ ...base, monthlyBudgetUsd: null }, { ...record, workspaceId: undefined })).toBeNull();
  });
});
