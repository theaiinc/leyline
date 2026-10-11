import request from 'supertest';
import { createServer } from '../src/server';
import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { ModelRegistry } from '../src/core/model-registry';
import { IssuedKeys, MemoryDocStore } from '../src/core/issued-keys';
import { MemorySecretStore } from '../src/core/secret-store';
import { AnthropicStream, anthropicToOpenAI, openAIToAnthropic } from '../src/core/anthropic';
import type { CompletionRequest, CompletionResponse, Provider, StreamChunk } from '../src/core/types';
import type { HostedOptions } from '../src/core/hosted';

/** An upstream that answers with a tool call, and records what it was sent. */
class FakeUpstream implements Provider {
  name = 'Fake';
  defaultModel = 'gemini-2.5-pro';
  seen: CompletionRequest[] = [];
  async isAvailable() { return true; }
  async getModels() { return [{ id: 'gemini-2.5-pro' }, { id: 'gpt-5.5' }]; }
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.seen.push(req);
    return {
      id: 'c1', object: 'chat.completion', created: 1, model: req.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'Reading it.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] } as never, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    };
  }
  async *completeStream(req: CompletionRequest): AsyncGenerator<StreamChunk> {
    this.seen.push(req);
    const base = { id: 's1', object: 'chat.completion.chunk', created: 1, model: req.model };
    yield { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi' }, finish_reason: null }] };
    yield { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'ls', arguments: '{"di' } }] } as never, finish_reason: null }] };
    yield { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'r":"."}' } }] } as never, finish_reason: 'tool_calls' }] };
    yield { ...base, choices: [], usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 } };
  }
}

function setup(over: Partial<HostedOptions> = {}) {
  const quotaManager = new QuotaManager();
  const router = new Router({ quotaManager, modelRegistry: new ModelRegistry() });
  const upstream = new FakeUpstream();
  router.addProvider(upstream);
  const keys = new IssuedKeys(new MemoryDocStore());
  const hosted: HostedOptions = {
    keys, models: ['gemini-2.5-pro', 'gpt-5.5'], aliases: { 'claude-*': 'gemini-2.5-pro' },
    login: null, adminEmails: [], adminToken: 'admin-secret-token', publicUrl: 'https://leyline.test', ...over,
  };
  const app = createServer(router, quotaManager, { hosted, enforceExternalSurface: false, apiKeyStore: new MemorySecretStore() });
  return { app, keys, upstream };
}

const ADMIN = { Authorization: 'Bearer admin-secret-token' };

describe('hosted keys', () => {
  it('the owner makes a key (shown once), people use it, usage counts against it', async () => {
    const { app, keys, upstream } = setup();
    const made = await request(app).post('/admin/api/keys').set(ADMIN).send({ name: 'Minh', caps: { tokensPerMonth: 1000 } });
    expect(made.status).toBe(201);
    expect(made.body.key).toMatch(/^ll_[A-Za-z0-9_-]{32}$/);
    expect(made.body.record.hash).toBeUndefined();
    const key = made.body.key as string;

    expect((await request(app).post('/v1/chat/completions').send({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] })).status).toBe(401);
    expect((await request(app).post('/v1/chat/completions').set({ Authorization: 'Bearer ll_wrong' }).send({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] })).status).toBe(401);

    const ok = await request(app).post('/v1/chat/completions').set({ Authorization: `Bearer ${key}` })
      .send({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'read a.ts' }], tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }], tool_choice: 'auto', max_tokens: 500 });
    expect(ok.status).toBe(200);
    expect(ok.body.choices[0].message.tool_calls[0].function.name).toBe('read_file');
    expect(upstream.seen[0]).toMatchObject({ tools: [{ type: 'function' }], tool_choice: 'auto', max_tokens: 500 });

    await new Promise((r) => setTimeout(r, 10));
    const list = await request(app).get('/admin/api/keys').set(ADMIN);
    expect(list.body.keys[0]).toMatchObject({ name: 'Minh', prefix: key.slice(0, 7), usage: { requests: 1, promptTokens: 100, completionTokens: 20 } });
    expect(list.body.keys[0].usage.byModel['gpt-5.5']).toMatchObject({ requests: 1, tokens: 120 });
    expect((await keys.list())[0].lastUsedAt).toBeGreaterThan(0);
  });

  it('caps: the monthly tokens, a model list, requests a minute; revoking stops it at once', async () => {
    const { app } = setup();
    const { key, record } = (await request(app).post('/admin/api/keys').set(ADMIN).send({ name: 'Lan', caps: { tokensPerMonth: 100, models: ['gemini-*'], requestsPerMinute: 2 } })).body;
    const call = (model: string) => request(app).post('/v1/chat/completions').set({ Authorization: `Bearer ${key}` }).send({ model, messages: [{ role: 'user', content: 'hi' }] });
    expect((await call('gpt-5.5')).body.error.code).toBe('model_not_allowed');
    expect((await call('gemini-2.5-pro')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 10));
    expect((await call('gemini-2.5-pro')).body.error.code).toBe('monthly_tokens_exhausted'); // 120 of 100 used
    await request(app).patch(`/admin/api/keys/${record.id}`).set(ADMIN).send({ caps: { requestsPerMinute: 1 } });
    expect((await call('gemini-2.5-pro')).body.error.code).toBe('rate_limited'); // the minute window still holds the earlier calls
    await request(app).delete(`/admin/api/keys/${record.id}`).set(ADMIN);
    expect((await call('gemini-2.5-pro')).body.error.code).toBe('key_revoked');
  });

  it('models nobody offers are refused; /v1/models lists what this key may use', async () => {
    const { app } = setup();
    const { key } = (await request(app).post('/admin/api/keys').set(ADMIN).send({ name: 'x', caps: { models: ['gemini-*'] } })).body;
    const r = await request(app).post('/v1/chat/completions').set({ Authorization: `Bearer ${key}` }).send({ model: 'llama-9000', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(404);
    const models = await request(app).get('/v1/models').set({ Authorization: `Bearer ${key}` });
    expect(models.body.data.map((m: { id: string }) => m.id)).toEqual(['gemini-2.5-pro']);
  });

  it('Claude Code: /v1/messages with x-api-key, a claude-* alias, tool use; usage counted', async () => {
    const { app, upstream, keys } = setup();
    const { key } = (await request(app).post('/admin/api/keys').set(ADMIN).send({ name: 'cc' })).body;
    const r = await request(app).post('/v1/messages').set({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }).send({
      model: 'claude-sonnet-4-5', max_tokens: 1024, system: 'You are a coding agent.',
      tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
      messages: [
        { role: 'user', content: 'open a.ts' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export const a = 1;' }, { type: 'text', text: 'and now?' }] },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20 } });
    expect(r.body.content).toEqual([{ type: 'text', text: 'Reading it.' }, { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }]);
    const sent = upstream.seen[0]!;
    expect(sent.model).toBe('gemini-2.5-pro');
    expect(sent.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(sent.messages[3]).toEqual({ role: 'tool', tool_call_id: 'toolu_1', content: 'export const a = 1;' });
    await new Promise((res) => setTimeout(res, 10));
    expect((await keys.list())[0].usage.requests).toBe(1);
  });

  it('Claude Code streaming: text and a tool call arrive as Anthropic events', async () => {
    const { app } = setup();
    const { key } = (await request(app).post('/admin/api/keys').set(ADMIN).send({ name: 'cc' })).body;
    const r = await request(app).post('/v1/messages').set({ Authorization: `Bearer ${key}` }).send({ model: 'claude-haiku-4-5', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'list files' }] });
    const events = r.text.split('\n\n').filter(Boolean).map((b) => ({ event: b.match(/^event: (.+)$/m)?.[1], data: JSON.parse(b.match(/^data: (.+)$/m)![1]!) }));
    expect(events.map((e) => e.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(events[4]!.data.content_block).toMatchObject({ type: 'tool_use', id: 'call_9', name: 'ls' });
    expect(events.filter((e) => e.data.delta?.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('')).toBe('{"dir":"."}');
    expect(events[8]!.data).toMatchObject({ delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } });
  });

  it('the admin API wants the owner', async () => {
    const { app } = setup();
    expect((await request(app).get('/admin/api/keys')).status).toBe(401);
    expect((await request(app).get('/admin/api/keys').set({ Authorization: 'Bearer nope' })).status).toBe(401);
    expect((await request(app).get('/admin')).status).toBe(302);
    expect((await request(app).post('/admin/api/keys').set(ADMIN).send({ name: '' })).status).toBe(400);
  });
});

describe('anthropic translation', () => {
  it('maps tool choice, stop sequences and images', () => {
    const r = anthropicToOpenAI({
      model: 'm', stop_sequences: ['END'], tool_choice: { type: 'tool', name: 'x' }, tools: [{ name: 'x', input_schema: { type: 'object' } }],
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }, { type: 'text', text: 'what is this' }] }],
    });
    expect(r.stop).toEqual(['END']);
    expect(r.tool_choice).toEqual({ type: 'function', function: { name: 'x' } });
    expect(r.messages[0]!.content).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }, { type: 'text', text: 'what is this' }]);
  });

  it('a plain answer stops with end_turn; a cut-off one with max_tokens', () => {
    const res = (finish: string) => openAIToAnthropic({ id: '1', object: 'x', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: finish }] }, 'claude-x');
    expect(res('stop').stop_reason).toBe('end_turn');
    expect(res('length').stop_reason).toBe('max_tokens');
    const s = new AnthropicStream('m');
    expect(s.end().map((e) => e.event)).toEqual(['message_start', 'message_delta', 'message_stop']);
  });
});

describe('hosted dashboard', () => {
  const cookieFor = (email: string) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { sign } = require('../src/core/admin-login') as typeof import('../src/core/admin-login');
    return `leyline_session=${sign({ sub: 'u1', email, exp: Math.floor(Date.now() / 1000) + 3600 }, 'test-session-secret')}`;
  };
  const withLogin = () => {
    const { AegisAuth } = require('../src/core/admin-login') as typeof import('../src/core/admin-login');
    const login = new AegisAuth({ issuer: 'https://id.example', clientId: 'c', clientSecret: 's', redirectUri: 'https://leyline.test/auth/callback', sessionSecret: 'test-session-secret' });
    return setup({ login, adminEmails: ['owner@example.com'] });
  };

  it('is for the signed-in owner only; strangers are sent to sign in', async () => {
    const { app } = withLogin();
    const page = await request(app).get('/dashboard/');
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/auth/login?next=/dashboard/');
    expect((await request(app).get('/dashboard/api-keys')).status).toBe(401);
    expect((await request(app).get('/dashboard/api-keys').set('Cookie', cookieFor('someone@else.com'))).status).toBe(401);
    const me = await request(app).get('/dashboard/session').set('Cookie', cookieFor('owner@example.com'));
    expect(me.body).toEqual({ hosted: true, email: 'owner@example.com', publicUrl: 'https://leyline.test', signIn: true });
    expect((await request(app).get('/dashboard/api-keys').set('Cookie', cookieFor('owner@example.com'))).status).toBe(200);
  });

  it('refuses changes from another site', async () => {
    const { app } = withLogin();
    const cookie = cookieFor('owner@example.com');
    expect((await request(app).post('/dashboard/routing').set('Cookie', cookie).set('Origin', 'https://evil.example').send({ mode: 'auto' })).status).toBe(403);
    expect((await request(app).post('/dashboard/routing').set('Cookie', cookie).set('Origin', 'https://leyline.test').send({ mode: 'auto' })).status).toBe(200);
  });

  it('the playground works with the owner session and no key, and is not counted', async () => {
    const { app, keys } = withLogin();
    const r = await request(app).post('/v1/chat/completions').set('Cookie', cookieFor('owner@example.com')).set('Origin', 'https://leyline.test')
      .send({ model: 'anything-at-all', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(200);
    expect(await keys.list()).toEqual([]);
    expect((await request(app).post('/v1/chat/completions').set('Cookie', cookieFor('owner@example.com')).set('Origin', 'https://evil.example')
      .send({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] })).status).toBe(401);
  });

  it('offered models and aliases are set on the dashboard and take effect', async () => {
    const { app } = setup({ models: ['gpt-5.5'], aliases: {} });
    const before = await request(app).get('/admin/api/settings').set(ADMIN);
    expect(before.body).toMatchObject({ models: ['gpt-5.5'], aliases: {}, saved: null });
    const saved = await request(app).put('/admin/api/settings').set(ADMIN).send({ models: ['gemini-2.5-pro', ' ', 'gemini-2.5-pro'], aliases: { 'claude-*': 'gemini-2.5-pro', bad: '' } });
    expect(saved.body).toMatchObject({ models: ['gemini-2.5-pro'], aliases: { 'claude-*': 'gemini-2.5-pro' }, saved: { by: 'token' } });
    const { key } = (await request(app).post('/admin/api/keys').set(ADMIN).send({ name: 'x' })).body;
    const models = await request(app).get('/v1/models').set({ Authorization: `Bearer ${key}` });
    expect(models.body.data.map((m: { id: string }) => m.id)).toEqual(['gemini-2.5-pro']);
    expect((await request(app).post('/v1/chat/completions').set({ Authorization: `Bearer ${key}` }).send({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] })).status).toBe(404);
  });
});

describe('SecretManagerSecretStore', () => {
  it('reads, writes (a new version, older ones destroyed) and deletes through the Secret Manager API', async () => {
    const { SecretManagerSecretStore } = require('../src/core/secret-manager-store') as typeof import('../src/core/secret-manager-store');
    const secrets = new Map<string, string[]>();
    const calls: string[] = [];
    const fake = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${url.replace('https://secretmanager.googleapis.com/v1/projects/p/secrets', '')}`);
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
      if (url.includes('metadata.google.internal')) return json(200, { access_token: 't', expires_in: 3600 });
      const m = url.match(/secrets\/([^/:?]+)/);
      const id = m?.[1] ?? new URL(url).searchParams.get('secretId')!;
      if (method === 'POST' && url.includes('?secretId=')) {
        if (secrets.has(id)) return json(409, {});
        secrets.set(id, []);
        return json(200, {});
      }
      if (url.endsWith(':addVersion')) {
        const v = secrets.get(id)!;
        v.push(JSON.parse(String(init!.body)).payload.data);
        return json(200, { name: `projects/p/secrets/${id}/versions/${v.length}` });
      }
      if (url.endsWith('/versions/latest:access')) {
        const v = secrets.get(id);
        return v?.length ? json(200, { payload: { data: v[v.length - 1] } }) : json(404, {});
      }
      if (url.includes('/versions?')) return json(200, { versions: (secrets.get(id) ?? []).map((_, i) => ({ name: `projects/p/secrets/${id}/versions/${i + 1}` })) });
      if (url.endsWith(':destroy')) return json(200, {});
      if (method === 'DELETE') return secrets.delete(id) ? json(200, {}) : json(404, {});
      return json(500, {});
    }) as typeof fetch;

    const store = new SecretManagerSecretStore('p', 'leyline-', fake);
    expect(store.secretId('api-key:Azure OpenAI')).toBe('leyline-api-key_3aAzure_20OpenAI');
    expect(await store.get('api-key:Gemini')).toBeUndefined();
    await store.set('api-key:Gemini', 'first');
    await store.set('api-key:Gemini', 'second');
    await new Promise((r) => setTimeout(r, 10));
    expect(await new SecretManagerSecretStore('p', 'leyline-', fake).get('api-key:Gemini')).toBe('second');
    expect(calls.filter((c) => c.endsWith(':destroy'))).toEqual(['POST /leyline-api-key_3aGemini/versions/1:destroy']);
    await store.delete('api-key:Gemini');
    expect(await store.get('api-key:Gemini')).toBeUndefined();
    expect(store.status()).toMatchObject({ mode: 'keychain', label: 'Google Secret Manager' });
  });
});

describe('spending limit', () => {
  const chat = (app: ReturnType<typeof setup>['app'], key: string, model = 'gemini-2.5-pro') =>
    request(app).post('/v1/chat/completions').set({ Authorization: `Bearer ${key}` }).send({ model, messages: [{ role: 'user', content: 'hi' }] });
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it('stops every key once the month\'s spend reaches the limit, at the prices set', async () => {
    // 100 prompt tokens at $10,000 per million = $1 a request (the fake upstream reports 100 + 20 tokens).
    const { app } = setup({ monthlyBudgetUsd: 1.5, prices: { 'gemini-*': { input: 10_000, output: 0 } } });
    const a = (await request(app).post('/admin/api/keys').set(ADMIN).send({ name: 'a' })).body.key;
    const b = (await request(app).post('/admin/api/keys').set(ADMIN).send({ name: 'b' })).body.key;
    expect((await chat(app, a)).status).toBe(200);
    await settle();
    expect((await chat(app, b)).status).toBe(200);
    await settle();
    const r = await chat(app, a);
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('budget_exhausted');
    const s = await request(app).get('/admin/api/settings').set(ADMIN);
    expect(s.body.spend.usd).toBeCloseTo(2);
    expect(s.body.monthlyBudgetUsd).toBe(1.5);
    // Raising the limit lets requests through again; saving only the models keeps the limit.
    await request(app).put('/admin/api/settings').set(ADMIN).send({ monthlyBudgetUsd: 10 });
    await request(app).put('/admin/api/settings').set(ADMIN).send({ models: ['gemini-2.5-pro'] });
    expect((await request(app).get('/admin/api/settings').set(ADMIN)).body.monthlyBudgetUsd).toBe(10);
    expect((await chat(app, a)).status).toBe(200);
  });

  it('a key can have its own dollars a month; unpriced models cost the default price', async () => {
    const { app, keys } = setup({ prices: {}, defaultPrice: { input: 100, output: 400 } });
    const { key } = (await request(app).post('/admin/api/keys').set(ADMIN).send({ name: 'c', caps: { usdPerMonth: 0.01 } })).body;
    expect((await chat(app, key)).status).toBe(200);
    await settle();
    // $100 / $400 per million: 100 * 100 + 20 * 400 = 18,000 / 1e6 = $0.018.
    expect((await keys.list())[0].usage.usd).toBeCloseTo(0.018);
    expect((await chat(app, key)).body.error.code).toBe('monthly_spend_exhausted');
  });
});
