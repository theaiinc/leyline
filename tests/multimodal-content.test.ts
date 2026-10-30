import http from 'http';
import type { AddressInfo } from 'net';
import request from 'supertest';
import { createServer } from '../src/server';
import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { ModelRegistry } from '../src/core/model-registry';
import { IssuedKeys, MemoryDocStore } from '../src/core/issued-keys';
import { MemorySecretStore } from '../src/core/secret-store';
import { ensureMessageArray, normalizeCompletionRequest } from '../src/core/normalize-request';
import { estimateTokens } from '../src/core/anthropic';
import { estimateBodyTokens, estimateMessageTokens, IMAGE_TOKEN_ESTIMATE } from '../src/core/content';
import { Classifier } from '../src/core/classifier';
import { config } from '../src/config';
import { maybeCompress } from '../src/core/compress';
import { sanitizeAzureMessages } from '../src/providers/azure-request';
import { geminiPrompt, GeminiProvider } from '../src/providers/gemini';
import { toOllamaMessages } from '../src/providers/ollama';
import { LlmApiProvider } from '../src/providers/llm-api';
import { WorkersAiProvider } from '../src/providers/workers-ai';
import { HuggingFaceProvider } from '../src/providers/huggingface';
import type { HostedOptions } from '../src/core/hosted';
import type { CompletionRequest, CompletionResponse, Provider, StreamChunk } from '../src/core/types';
import { LEYLINE_CLIENT_AUTH_HEADER } from './client-auth-header';

jest.mock('child_process', () => ({ spawn: jest.fn(() => { throw new Error('headroom must not run'); }) }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { spawn } = require('child_process') as { spawn: jest.Mock };

const PNG = `data:image/png;base64,${'iVBORw0KGgo'.repeat(200)}`;
const IMAGE_CONTENT = [
  { type: 'text', text: 'What colour is this square?' },
  { type: 'image_url', image_url: { url: PNG, detail: 'high' } },
];

// ── a mock OpenAI-compatible upstream (api.llmapi.ai stand-in) ────────────────────────────────────────────

type Upstream = { url: string; bodies: Array<Record<string, any>>; close: () => Promise<void> };

async function startUpstream(models: Array<string | { id: string; capabilities?: string[] }> = ['gemini-3.8-flash']): Promise<Upstream> {
  const bodies: Array<Record<string, any>> = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: models.map(model => typeof model === 'string' ? { id: model } : model) }));
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      if (body.stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        const base = { id: 's1', object: 'chat.completion.chunk', created: 1, model: body.model };
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Red.' }, finish_reason: 'stop' }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 1098, completion_tokens: 2, total_tokens: 1100 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        id: 'c1', object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'Red.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1098, completion_tokens: 2, total_tokens: 1100 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, bodies, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** A provider that records what it gets; `vision: false` makes it one that can't read images. */
class Recorder implements Provider {
  seen: CompletionRequest[] = [];
  defaultModel: string;
  constructor(public name: string, private readonly models: string[], private readonly vision = true) {
    this.defaultModel = models[0];
  }
  async isAvailable() { return true; }
  async getModels() { return this.models.map(id => ({ id })); }
  acceptsNonTextContent() { return this.vision; }
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.seen.push(req);
    return { id: 'r', object: 'chat.completion', created: 1, model: req.model, choices: [{ index: 0, message: { role: 'assistant', content: this.name }, finish_reason: 'stop' }] };
  }
  async *completeStream(req: CompletionRequest): AsyncGenerator<StreamChunk> {
    this.seen.push(req);
    yield { id: 'r', object: 'chat.completion.chunk', created: 1, model: req.model, choices: [{ index: 0, delta: { content: this.name }, finish_reason: 'stop' }] };
  }
}

function app(router: Router, hosted?: HostedOptions) {
  return createServer(router, new QuotaManager(), { enforceExternalSurface: false, apiKeyStore: new MemorySecretStore(), ...(hosted ? { hosted } : {}) });
}

describe('content parts survive normalization', () => {
  it('keeps image_url (with detail), audio, file and unknown parts as sent', () => {
    const parts = [
      ...IMAGE_CONTENT,
      { type: 'input_audio', input_audio: { data: 'UklGR', format: 'wav' } },
      { type: 'file', file: { file_data: 'data:application/pdf;base64,JVBER', filename: 'a.pdf' } },
      { type: 'future_part', future: { x: 1 } },
    ];
    const req = normalizeCompletionRequest({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: parts }] });
    expect(req.messages[0].content).toEqual(parts);
    // The router normalizes again; that must not change anything.
    expect(ensureMessageArray(req.messages)).toEqual(req.messages);
  });

  it('still collapses an all-text list to a string', () => {
    const req = normalizeCompletionRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, 'b'] }] });
    expect(req.messages[0].content).toBe('a\nb');
  });
});

describe('/v1/chat/completions with images reaches an OpenAI-format upstream intact', () => {
  let upstream: Upstream;
  beforeEach(async () => { upstream = await startUpstream(); });
  afterEach(async () => { await upstream.close(); });

  function llmApiRouter() {
    const router = new Router({ quotaManager: new QuotaManager(), modelRegistry: new ModelRegistry() });
    router.addProvider(new LlmApiProvider('key', 'gemini-3.8-flash', upstream.url));
    return router;
  }

  it('non-streaming', async () => {
    const r = await request(app(llmApiRouter())).post('/v1/chat/completions').set(LEYLINE_CLIENT_AUTH_HEADER)
      .send({ model: 'gemini-3.8-flash', messages: [{ role: 'user', content: IMAGE_CONTENT }] });
    expect(r.status).toBe(200);
    expect(r.body.usage.prompt_tokens).toBe(1098);
    expect(upstream.bodies[0].messages).toEqual([{ role: 'user', content: IMAGE_CONTENT }]);
  });

  it('streaming', async () => {
    const r = await request(app(llmApiRouter())).post('/v1/chat/completions').set(LEYLINE_CLIENT_AUTH_HEADER)
      .send({ model: 'gemini-3.8-flash', stream: true, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: IMAGE_CONTENT }] });
    expect(r.status).toBe(200);
    expect(r.text).toContain('Red.');
    expect(upstream.bodies[0].messages).toEqual([{ role: 'system', content: 'Be brief.' }, { role: 'user', content: IMAGE_CONTENT }]);
  });
});

describe('/v1/messages images reach the upstream as image_url parts', () => {
  let upstream: Upstream;
  beforeEach(async () => { upstream = await startUpstream(); });
  afterEach(async () => { await upstream.close(); });

  it('non-streaming and streaming', async () => {
    const router = new Router({ quotaManager: new QuotaManager(), modelRegistry: new ModelRegistry() });
    router.addProvider(new LlmApiProvider('key', 'gemini-3.8-flash', upstream.url));
    const keys = new IssuedKeys(new MemoryDocStore());
    const hosted: HostedOptions = {
      keys, models: ['gemini-3.8-flash'], aliases: { 'claude-*': 'gemini-3.8-flash' },
      login: null, adminEmails: [], adminToken: 'admin-secret-token', publicUrl: 'https://leyline.test',
    };
    const server = app(router, hosted);
    const { key } = (await request(server).post('/admin/api/keys').set({ Authorization: 'Bearer admin-secret-token' }).send({ name: 'cc' })).body;
    const data = 'iVBORw0KGgo'.repeat(200);
    const body = {
      model: 'claude-sonnet-4-5', max_tokens: 100,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }, { type: 'text', text: 'What colour?' }] }],
    };
    const expected = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } }, { type: 'text', text: 'What colour?' }] }];

    const r = await request(server).post('/v1/messages').set({ 'x-api-key': key }).send(body);
    expect(r.status).toBe(200);
    expect(r.body.content).toEqual([{ type: 'text', text: 'Red.' }]);
    expect(upstream.bodies[0].messages).toEqual(expected);

    const s = await request(server).post('/v1/messages').set({ 'x-api-key': key }).send({ ...body, stream: true });
    expect(s.status).toBe(200);
    expect(upstream.bodies[1].messages).toEqual(expected);
  });
});

describe('providers that cannot read images are not used for them', () => {
  const imageRequest = (model: string) => ({ model, messages: [{ role: 'user', content: IMAGE_CONTENT }] });

  it('auto skips a text-only provider and uses one that reads images; text-only requests are unaffected', async () => {
    const router = new Router({ quotaManager: new QuotaManager(), modelRegistry: new ModelRegistry() });
    const blind = new Recorder('Blind', ['text-model'], false);
    const sighted = new Recorder('Sighted', ['vision-model']);
    router.addProvider(blind);
    router.addProvider(sighted);

    const r = await router.route(normalizeCompletionRequest(imageRequest('auto')));
    expect(r.choices[0].message.content).toBe('Sighted');
    expect(blind.seen).toHaveLength(0);
    expect(sighted.seen[0].messages[0].content).toEqual(IMAGE_CONTENT);

    const chunks: StreamChunk[] = [];
    for await (const c of router.routeStream(normalizeCompletionRequest({ ...imageRequest('auto'), stream: true }))) chunks.push(c);
    expect(chunks[0].choices[0].delta.content).toBe('Sighted');

    const text = await router.route(normalizeCompletionRequest({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }));
    expect(text.choices[0].message.content).toBe('Blind');
  });

  it('an explicit model only a text-only provider serves is a clear 400, streaming or not', async () => {
    const router = new Router({ quotaManager: new QuotaManager(), modelRegistry: new ModelRegistry() });
    const run = jest.fn();
    router.addProvider(new WorkersAiProvider({ binding: { run } }));
    const server = app(router);

    for (const stream of [false, true]) {
      const r = await request(server).post('/v1/chat/completions').set(LEYLINE_CLIENT_AUTH_HEADER)
        .send({ ...imageRequest('@cf/meta/llama-3.3-70b-instruct-fp8-fast'), stream });
      expect(r.status).toBe(400);
      expect(r.body.error.type).toBe('invalid_request_error');
      expect(r.body.error.message).toMatch(/WorkersAI can't read them/);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('/v1/messages answers an Anthropic 400 for images only a text-only provider would get', async () => {
    const router = new Router({ quotaManager: new QuotaManager(), modelRegistry: new ModelRegistry() });
    router.addProvider(new Recorder('Blind', ['text-model'], false));
    const hosted: HostedOptions = {
      keys: new IssuedKeys(new MemoryDocStore()), models: ['text-model'], aliases: {},
      login: null, adminEmails: [], adminToken: 'admin-secret-token', publicUrl: 'https://leyline.test',
    };
    const server = app(router, hosted);
    const { key } = (await request(server).post('/admin/api/keys').set({ Authorization: 'Bearer admin-secret-token' }).send({ name: 'cc' })).body;
    for (const stream of [false, true]) {
      const r = await request(server).post('/v1/messages').set({ 'x-api-key': key }).send({
        model: 'text-model', max_tokens: 10, stream,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }, { type: 'text', text: 'what?' }] }],
      });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
    }
  });

  it('a forced or fixed text-only provider refuses rather than answering blind', async () => {
    const router = new Router({ quotaManager: new QuotaManager(), modelRegistry: new ModelRegistry() });
    router.addProvider(new Recorder('Blind', ['text-model'], false));
    await expect(router.route(normalizeCompletionRequest(imageRequest('text-model')), { forceProvider: 'Blind' })).rejects.toMatchObject({ status: 400 });

    router.setSingleModel({ enabled: true, provider: 'Blind', model: 'text-model' });
    await expect(router.route(normalizeCompletionRequest(imageRequest('text-model')))).rejects.toMatchObject({ status: 400 });
  });

  it('HuggingFace and Workers AI say they cannot; Gemini can for inline data but not remote URLs', () => {
    const req = (url: string) => normalizeCompletionRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url } }] }] });
    expect(new HuggingFaceProvider('k').acceptsNonTextContent()).toBe(false);
    expect(new WorkersAiProvider({}).acceptsNonTextContent()).toBe(false);
    expect(new GeminiProvider('k').acceptsNonTextContent(req(PNG))).toBe(true);
    expect(new GeminiProvider('k').acceptsNonTextContent(req('https://example.com/a.png'))).toBe(false);
  });
});

describe('gateway model capabilities', () => {
  it('routes auto image and audio requests through a gateway with declared vision and audio model capabilities', async () => {
    const upstream = await startUpstream([
      { id: 'text-only-model', capabilities: ['chat'] },
      { id: 'gemini-2.5-flash-lite', capabilities: ['chat'] },
    ]);
    try {
      const router = new Router({ quotaManager: new QuotaManager(), modelRegistry: new ModelRegistry() });
      router.addProvider(new LlmApiProvider('key', 'text-only-model', upstream.url));
      const image = await router.route(normalizeCompletionRequest({
        model: 'auto',
        messages: [{ role: 'user', content: IMAGE_CONTENT }],
      }));
      expect(image.choices[0].message.content).toBe('Red.');
      expect(upstream.bodies[0].model).toBe('gemini-2.5-flash-lite');

      const audio = await router.route(normalizeCompletionRequest({
        model: 'auto',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'transcribe this' },
          { type: 'input_audio', input_audio: { data: 'UklGR', format: 'wav' } },
        ] }],
      }));
      expect(audio.choices[0].message.content).toBe('Red.');
      expect(upstream.bodies[1].model).toBe('gemini-2.5-flash-lite');
      expect(upstream.bodies[1].messages).toEqual([{
        role: 'user',
        content: [
          { type: 'text', text: 'transcribe this' },
          { type: 'input_audio', input_audio: { data: 'UklGR', format: 'wav' } },
        ],
      }]);
    } finally {
      await upstream.close();
    }
  });
});

describe('provider conversions', () => {
  it('Gemini inlines data: URL images where they appear', () => {
    const prompt = geminiPrompt([{ role: 'system', content: 'Be brief.' }, { role: 'user', content: IMAGE_CONTENT as never }]);
    expect(prompt).toEqual([
      { text: 'system: Be brief.\nuser: What colour is this square?' },
      { inlineData: { mimeType: 'image/png', data: PNG.split(',')[1] } },
    ]);
    expect(geminiPrompt([{ role: 'user', content: 'hi' }])).toBe('user: hi');
  });

  it('Ollama gets string content with images as base64', () => {
    expect(toOllamaMessages([{ role: 'user', content: IMAGE_CONTENT as never }])).toEqual([
      { role: 'user', content: 'What colour is this square?', images: [PNG.split(',')[1]] },
    ]);
  });

  it('Azure keeps content parts', () => {
    expect(sanitizeAzureMessages([{ role: 'user', content: IMAGE_CONTENT }])).toEqual([{ role: 'user', content: IMAGE_CONTENT }]);
  });
});

describe('compression, estimates and the classifier handle content parts', () => {
  const original = config.compression.enabled;
  afterEach(() => { config.compression.enabled = original; });

  it('compression leaves requests with images alone (headroom is never called)', async () => {
    config.compression.enabled = true;
    const req = normalizeCompletionRequest({ model: 'gpt-5.5', messages: [{ role: 'user', content: IMAGE_CONTENT }] });
    await expect(maybeCompress(req)).resolves.toBe(req);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('token estimates count text and a fixed amount per image, not base64 length', () => {
    const messages = [{ role: 'user', content: IMAGE_CONTENT }];
    expect(estimateMessageTokens(messages)).toBe(Math.ceil('What colour is this square?'.length / 4) + IMAGE_TOKEN_ESTIMATE);
    expect(estimateBodyTokens({ messages })).toBeLessThan(IMAGE_TOKEN_ESTIMATE + 100);
    const anthropic = estimateTokens({ model: 'm', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(100_000) } }] }] });
    expect(anthropic).toBeLessThan(IMAGE_TOKEN_ESTIMATE + 100);
  });

  it('the classifier sees the text of content parts', async () => {
    const fn = jest.fn(async () => 'COMPLEXITY: simple\nDOMAIN: chat\nREASONING: false');
    await new Classifier(fn).classifyRequest({ userMessage: 'q', chatHistory: [{ role: 'user', content: IMAGE_CONTENT as never }] });
    expect(fn.mock.calls[0]).toEqual([expect.any(String), 'q\n\nUSER: What colour is this square? [1 image]']);
  });
});
