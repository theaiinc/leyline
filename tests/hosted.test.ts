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
    expect(list.body.keys[0].usage.byModel['gpt-5.5']).toEqual({ requests: 1, tokens: 120 });
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
