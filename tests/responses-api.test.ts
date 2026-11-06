import request from 'supertest';
import { TERMS_VERSION } from '../src/core/self-serve-workspaces';
import { chatToolName, responsesToChat, ResponsesRequestError } from '../src/core/responses';
import type { CompletionRequest, StreamChunk } from '../src/core/types';
import { createServer } from '../src/server';
import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { ORIGIN, cookieFor, hostedBilling } from './helpers/hosted-billing';
import { LEYLINE_CLIENT_AUTH_HEADER } from './client-auth-header';

type H = ReturnType<typeof hostedBilling>;

async function ownerKey(h: H): Promise<string> {
  const made = await request(h.app).post('/admin/api/keys').set('Authorization', 'Bearer admin-secret-token').send({ name: 'codex' });
  return made.body.key as string;
}

async function customer(h: H) {
  const cookie = cookieFor('sub-codex', 'codex@example.com');
  const signed = await request(h.app).post('/dashboard/me/workspace').set('Cookie', cookie).set('Origin', ORIGIN).set('CF-Connecting-IP', '203.0.113.7')
    .send({ acceptTerms: true, termsVersion: TERMS_VERSION, turnstileToken: 'ok-token' });
  const ws = (await h.store.workspaceBySub('sub-codex'))!;
  return { key: signed.body.key as string, ws };
}

const responses = (h: H, key: string, body: Record<string, unknown>) =>
  request(h.app).post('/v1/responses').set('Authorization', `Bearer ${key}`).send(body);

/** The SSE body as its events (the data of each, which carries its type), checking each event line matches. */
function events(text: string): Array<Record<string, any>> {
  return text.split('\n\n').filter((b) => b.trim()).map((block) => {
    const name = /^event: (.+)$/m.exec(block)?.[1];
    const data = JSON.parse(/^data: (.+)$/m.exec(block)![1]);
    expect(name).toBe(data.type);
    return data;
  });
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: StreamChunk['usage']): StreamChunk =>
  ({ id: 's', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: delta as StreamChunk['choices'][0]['delta'], finish_reason: finish }], ...(usage ? { usage } : {}) });

function streams(h: H, chunks: StreamChunk[]) {
  h.upstream.completeStream = async function* (req: CompletionRequest) {
    h.upstream.seen.push(req);
    for (const c of chunks) yield c;
  };
}

/** The tools Codex sends (captured from codex-cli 0.140.0), trimmed: a function, a namespace, a hosted tool. */
const CODEX_TOOLS = [
  { type: 'function', name: 'exec_command', description: 'Runs a command', strict: false, parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } },
  { type: 'namespace', name: 'multi_agent_v1', description: 'Sub-agents', tools: [{ type: 'function', name: 'close_agent', description: 'Close an agent', strict: false, parameters: { type: 'object', properties: { target: { type: 'string' } } } }] },
  { type: 'web_search', external_web_access: false },
];

describe('POST /v1/responses (OpenAI Responses API, for Codex)', () => {
  it('answers text: instructions and input become the chat messages, the reply a Response with usage', async () => {
    const h = hostedBilling();
    const key = await ownerKey(h);
    const res = await responses(h, key, {
      model: 'seed-2-0-lite-260428',
      instructions: 'Be brief.',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Sandbox: read-only.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'say hi' }] },
      ],
      store: false,
      max_output_tokens: 50,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: 'response',
      status: 'completed',
      model: 'seed-2-0-lite-260428',
      store: false,
      output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hi' }] }],
      usage: { input_tokens: 1000, output_tokens: 1000, total_tokens: 2000, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    });
    expect(res.body.id).toMatch(/^resp_/);
    expect(h.upstream.seen[0]).toMatchObject({
      model: 'seed-2-0-lite-260428',
      max_tokens: 50,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'system', content: 'Sandbox: read-only.' },
        { role: 'user', content: 'say hi' },
      ],
    });
    // A plain string input is one user message.
    expect((await responses(h, key, { model: 'seed-2-0-lite-260428', input: 'hello' })).status).toBe(200);
    expect(h.upstream.seen[1].messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('streams the event sequence Codex consumes, ending in response.completed with usage', async () => {
    const h = hostedBilling();
    const key = await ownerKey(h);
    streams(h, [chunk({ role: 'assistant', content: 'Hel' }), chunk({ content: 'lo' }), chunk({}, 'stop'), { ...chunk({}), choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }]);
    const res = await responses(h, key, { model: 'seed-2-0-lite-260428', input: 'hi', stream: true, store: false });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const evs = events(res.text);
    expect(evs.map((e) => e.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(evs.map((e) => e.sequence_number)).toEqual(evs.map((_, i) => i));
    expect(evs[0].response).toMatchObject({ object: 'response', status: 'in_progress', output: [] });
    const deltas = evs.filter((e) => e.type === 'response.output_text.delta');
    expect(deltas.map((e) => e.delta).join('')).toBe('Hello');
    const added = evs[2];
    expect(deltas.every((e) => e.item_id === added.item.id && e.output_index === 0)).toBe(true);
    expect(evs[8].item).toEqual({ id: added.item.id, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] });
    const done = evs[9].response;
    expect(done).toMatchObject({ id: evs[0].response.id, status: 'completed', output: [evs[8].item] });
    expect(done.usage).toEqual({ input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 3, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 });
    expect(h.upstream.seen[0].stream).toBe(true);
  });

  it('round-trips function calls: tools go out as chat functions, calls come back with call_id, outputs go back as tool messages', async () => {
    const h = hostedBilling();
    const key = await ownerKey(h);
    streams(h, [
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'exec_command', arguments: '' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }),
      chunk({ tool_calls: [{ index: 1, id: 'call_def', type: 'function', function: { name: 'multi_agent_v1__close_agent', arguments: '{"target":"a1"}' } }] }),
      chunk({}, 'tool_calls', { prompt_tokens: 40, completion_tokens: 9, total_tokens: 49 }),
    ]);
    const first = await responses(h, key, { model: 'seed-2-0-lite-260428', input: 'list files', tools: CODEX_TOOLS, tool_choice: 'auto', parallel_tool_calls: false, stream: true, store: false });
    expect(first.status).toBe(200);
    // Tools: functions (namespaced ones flattened), hosted tools left out.
    expect(h.upstream.seen[0]).toMatchObject({
      tool_choice: 'auto',
      parallel_tool_calls: false,
      tools: [
        { type: 'function', function: { name: 'exec_command', description: 'Runs a command', parameters: CODEX_TOOLS[0].parameters } },
        { type: 'function', function: { name: 'multi_agent_v1__close_agent', description: 'Close an agent' } },
      ],
    });
    expect((h.upstream.seen[0].tools as unknown[]).length).toBe(2);
    const evs = events(first.text);
    expect(evs.map((e) => e.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(evs[2].item).toMatchObject({ type: 'function_call', status: 'in_progress', call_id: 'call_abc', name: 'exec_command', arguments: '' });
    const calls = evs.filter((e) => e.type === 'response.output_item.done').map((e) => e.item);
    expect(calls).toEqual([
      { id: 'fc_abc', type: 'function_call', status: 'completed', call_id: 'call_abc', name: 'exec_command', arguments: '{"cmd":"ls"}' },
      { id: 'fc_def', type: 'function_call', status: 'completed', call_id: 'call_def', name: 'close_agent', namespace: 'multi_agent_v1', arguments: '{"target":"a1"}' },
    ]);
    const completed = evs[evs.length - 1].response;
    expect(completed.output).toEqual(calls);
    expect(completed.usage).toMatchObject({ input_tokens: 40, output_tokens: 9, total_tokens: 49 });

    // The next turn, as Codex sends it: the whole history, the calls and their outputs.
    const second = await responses(h, key, {
      model: 'seed-2-0-lite-260428',
      tools: CODEX_TOOLS,
      stream: false,
      store: false,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
        ...calls,
        { type: 'function_call_output', call_id: 'call_abc', output: 'a.txt\nb.txt' },
        { type: 'function_call_output', call_id: 'call_def', output: [{ type: 'input_text', text: 'closed' }] },
      ],
    });
    expect(second.status).toBe(200);
    expect(h.upstream.seen[1].messages).toEqual([
      { role: 'user', content: 'list files' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call_abc', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } },
        { id: 'call_def', type: 'function', function: { name: 'multi_agent_v1__close_agent', arguments: '{"target":"a1"}' } },
      ] },
      { role: 'tool', tool_call_id: 'call_abc', content: 'a.txt\nb.txt' },
      { role: 'tool', tool_call_id: 'call_def', content: 'closed' },
    ]);
    expect(second.body.output[0]).toMatchObject({ type: 'message', content: [{ type: 'output_text', text: 'Hi' }] });
  });

  it('a non-streamed tool call comes back as a function_call item', async () => {
    const h = hostedBilling();
    const key = await ownerKey(h);
    h.upstream.complete = async (req: CompletionRequest) => {
      h.upstream.seen.push(req);
      return { id: 'c', object: 'chat.completion', created: 1, model: req.model, choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_x', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"pwd"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } };
    };
    const res = await responses(h, key, { model: 'seed-2-0-lite-260428', input: 'where am I', tools: CODEX_TOOLS, tool_choice: { type: 'function', name: 'exec_command' } });
    expect(res.status).toBe(200);
    expect(h.upstream.seen[0].tool_choice).toEqual({ type: 'function', function: { name: 'exec_command' } });
    expect(res.body).toMatchObject({ status: 'completed', output: [{ type: 'function_call', call_id: 'call_x', name: 'exec_command', arguments: '{"cmd":"pwd"}' }], usage: { input_tokens: 5, output_tokens: 2 } });
  });

  it('charges the customer at the model\'s price and records the spend, streamed or not', async () => {
    const h = hostedBilling();
    const { key, ws } = await customer(h);
    await h.store.addAdjustment(ws.id, 1000, 'test credit', 'test:1');
    // 1000 in x $5/M + 1000 out x $15/M = $0.02.
    expect((await responses(h, key, { model: 'gpt-5.5', input: 'hi' })).status).toBe(200);
    await h.settle();
    expect((await h.store.balance(ws.id)).cents).toBe(998);
    streams(h, [chunk({ content: 'ok' }, 'stop'), { ...chunk({}), choices: [], usage: { prompt_tokens: 2000, completion_tokens: 2000, total_tokens: 4000 } }]);
    // 2000 x $5/M + 2000 x $15/M = $0.04.
    expect((await responses(h, key, { model: 'gpt-5.5', input: 'hi', stream: true })).status).toBe(200);
    await h.settle();
    expect((await h.store.balance(ws.id)).cents).toBe(994);
    const spend = await h.keys.spend();
    expect(spend.requests).toBe(2);
    expect(spend.usd).toBeCloseTo(0.06, 10);
    expect(spend.byModel?.['Fake/gpt-5.5']).toMatchObject({ requests: 2, tokens: 6000 });
  });

  it('PII protection masks the input like chat, unmasks the output, and charges its fee', async () => {
    const h = hostedBilling();
    const { key, ws } = await customer(h);
    await h.store.addAdjustment(ws.id, 1000, 'test credit', 'test:pii');
    const cookie = cookieFor('sub-codex', 'codex@example.com');
    const keyId = (await request(h.app).get('/dashboard/me/keys').set('Cookie', cookie)).body.keys[0].id as string;
    expect((await request(h.app).put(`/dashboard/me/keys/${keyId}/pii`).set('Cookie', cookie).set('Origin', ORIGIN).send({ enabled: true })).status).toBe(200);
    // The model repeats what it was sent (masked), so the reply shows whether it was unmasked.
    h.upstream.complete = async (req: CompletionRequest) => {
      h.upstream.seen.push(req);
      const said = String(req.messages[req.messages.length - 1].content);
      return { id: 'c', object: 'chat.completion', created: 1, model: req.model, choices: [{ index: 0, message: { role: 'assistant', content: `You said: ${said}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 1000, total_tokens: 2000 } };
    };
    const res = await responses(h, key, { model: 'gpt-5.5', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Email me at ann@example.com' }] }] });
    expect(res.status).toBe(200);
    expect(JSON.stringify(h.upstream.seen[0].messages)).not.toContain('ann@example.com');
    expect(res.body.output[0].content[0].text).toBe('You said: Email me at ann@example.com');
    await h.settle();
    const bal = await h.store.balance(ws.id);
    expect(bal.cents).toBe(998);
    expect(bal.pendingMicros).toBe(200);
  });

  it('a customer with no credit gets 429 insufficient_quota (Codex stops at once) before anything reaches the provider', async () => {
    const h = hostedBilling();
    const { key } = await customer(h);
    for (const stream of [false, true]) {
      const res = await responses(h, key, { model: 'gpt-5.5', input: 'hi', stream });
      expect(res.status).toBe(429);
      expect(res.body.error).toMatchObject({ code: 'insufficient_quota', type: 'insufficient_quota' });
      expect(res.body.error.message).toMatch(/Add credit/);
    }
    expect(h.upstream.seen.some((r) => r.model === 'gpt-5.5')).toBe(false);
  });

  it('refuses what a stateless API can\'t honor, and missing keys, in the OpenAI error shape', async () => {
    const h = hostedBilling();
    const key = await ownerKey(h);
    const prev = await responses(h, key, { model: 'seed-2-0-lite-260428', input: 'hi', previous_response_id: 'resp_123' });
    expect(prev.status).toBe(400);
    expect(prev.body.error).toMatchObject({ type: 'invalid_request_error', code: 'previous_response_not_supported', param: 'previous_response_id' });
    expect(prev.body.error.message).toMatch(/send the whole conversation in input/);
    const ref = await responses(h, key, { model: 'seed-2-0-lite-260428', input: [{ type: 'item_reference', id: 'msg_1' }] });
    expect(ref.status).toBe(400);
    expect((await responses(h, key, { model: 'seed-2-0-lite-260428', input: [] })).status).toBe(400);
    expect(h.upstream.seen).toHaveLength(0);
    const anon = await request(h.app).post('/v1/responses').send({ model: 'seed-2-0-lite-260428', input: 'hi' });
    expect(anon.status).toBe(401);
    expect(anon.body.error.code).toBe('missing_api_key');
  });

  it('a provider failure before the first chunk is a JSON error; partway through, response.failed', async () => {
    const h = hostedBilling();
    const key = await ownerKey(h);
    h.upstream.completeStream = async function* () {
      yield chunk({ content: 'par' });
      throw new Error('upstream dropped');
    };
    const res = await responses(h, key, { model: 'seed-2-0-lite-260428', input: 'hi', stream: true });
    const evs = events(res.text);
    expect(evs.map((e) => e.type)).toContain('response.output_text.delta');
    expect(evs[evs.length - 1]).toMatchObject({ type: 'response.failed', response: { status: 'failed', error: { code: 'server_error' } } });
    h.upstream.completeStream = async function* () {
      throw new Error('upstream down');
    };
    const before = await responses(h, key, { model: 'seed-2-0-lite-260428', input: 'hi', stream: true });
    expect(before.status).toBeGreaterThanOrEqual(500);
    expect(before.headers['content-type']).toMatch(/application\/json/);
    expect(before.body.error.message).toBeTruthy();
  });

  it('is on the external API surface (not refused through the public proxy)', async () => {
    const app = createServer(new Router(new QuotaManager()), new QuotaManager());
    const res = await request(app).post('/v1/responses').set('x-forwarded-for', '203.0.113.10').set(LEYLINE_CLIENT_AUTH_HEADER).send({ model: 'm', input: 'hi' });
    expect(res.body?.error?.code).not.toBe('external_endpoint_not_exposed');
    const hidden = await request(app).post('/v1/not-a-route').set('x-forwarded-for', '203.0.113.10').send({});
    expect(hidden.body.error.code).toBe('external_endpoint_not_exposed');
  });
});

describe('responsesToChat', () => {
  it('custom (freeform) tools become one-string-argument functions, and their calls round-trip', () => {
    const { request: chat, tools } = responsesToChat({
      model: 'm',
      tools: [{ type: 'custom', name: 'apply_patch', description: 'Patch files', format: { type: 'grammar', syntax: 'lark', definition: 'start: "x"' } }],
      input: [
        { type: 'custom_tool_call', call_id: 'call_p', name: 'apply_patch', input: '*** Begin Patch' },
        { type: 'custom_tool_call_output', call_id: 'call_p', output: 'Done' },
      ],
    });
    expect(chat.tools).toEqual([{ type: 'function', function: { name: 'apply_patch', description: 'Patch files', parameters: expect.objectContaining({ required: ['input'] }) } }]);
    expect(JSON.stringify(chat.tools)).toContain('start: \\"x\\"');
    expect(tools.get('apply_patch')).toEqual({ kind: 'custom', name: 'apply_patch' });
    expect(chat.messages).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_p', type: 'function', function: { name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' } }] },
      { role: 'tool', tool_call_id: 'call_p', content: 'Done' },
    ]);
  });

  it('assistant text and its calls are one message; images a tool returned follow the tool messages; orphan outputs stay as context', () => {
    const { request: chat } = responsesToChat({
      model: 'm',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:image/png;base64,AAA' }] },
        { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'thinking' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] },
        { type: 'function_call', call_id: 'c1', name: 'view_image', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_image', image_url: 'data:image/png;base64,BBB' }] },
        { type: 'function_call_output', call_id: 'missing', output: 'late' },
      ],
    });
    expect(chat.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] },
      { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'view_image', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '' },
      { role: 'user', content: 'Output of tool call missing:\nlate' },
      { role: 'user', content: [{ type: 'text', text: 'The images the tool calls above returned:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } }] },
    ]);
  });

  it('maps text.format, reasoning effort and sampling settings; refuses conversation and background', () => {
    const { request: chat } = responsesToChat({ model: 'm', input: 'x', temperature: 0.2, top_p: 0.9, reasoning: { effort: 'high' }, text: { format: { type: 'json_schema', name: 'out', schema: { type: 'object' }, strict: true } } });
    expect(chat).toMatchObject({ temperature: 0.2, top_p: 0.9, reasoning_effort: 'high', response_format: { type: 'json_schema', json_schema: { name: 'out', schema: { type: 'object' }, strict: true } } });
    expect(() => responsesToChat({ model: 'm', input: 'x', conversation: 'conv_1' })).toThrow(ResponsesRequestError);
    expect(() => responsesToChat({ model: 'm', input: 'x', background: true })).toThrow(ResponsesRequestError);
    expect(() => responsesToChat({ input: 'x' })).toThrow(/model is required/);
  });

  it('long or unusual tool names get stable, valid chat names', () => {
    const name = chatToolName('a'.repeat(40), 'mcp.server-with.dots');
    expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(chatToolName('a'.repeat(40), 'mcp.server-with.dots')).toBe(name);
    expect(chatToolName('read', 'fs')).toBe('fs__read');
  });
});
