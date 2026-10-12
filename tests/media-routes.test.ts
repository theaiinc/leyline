import request from 'supertest';
import { createServer } from '../src/server';
import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { ModelRegistry } from '../src/core/model-registry';
import { IssuedKeys, MemoryDocStore } from '../src/core/issued-keys';
import { MemorySecretStore } from '../src/core/secret-store';
import { logger } from '../src/core/logger';
import { OpenAIProvider } from '../src/providers/openai';
import { LlmApiProvider } from '../src/providers/llm-api';
import { DeepgramProvider } from '../src/providers/deepgram';
import { WorkersAiProvider, type WorkersAiBinding } from '../src/providers/workers-ai';
import { GeminiProvider } from '../src/providers/gemini';
import { OpenRouterProvider } from '../src/providers/openrouter';
import { AzureOpenAIProvider } from '../src/providers/azure-openai';
import { formatTranscription, speechCostUsd, transcriptionCostUsd, estimateAudioSeconds } from '../src/core/media';
import type { HostedOptions } from '../src/core/hosted';
import type { Provider } from '../src/core/types';
import { LEYLINE_CLIENT_AUTH_HEADER } from './client-auth-header';

type Call = { url: string; init: RequestInit };

/** Mocks global fetch: each handler answers URLs that contain its key. */
function mockFetch(handlers: Record<string, (call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const spy = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call = { url, init: init ?? {} };
    calls.push(call);
    for (const [key, handler] of Object.entries(handlers)) if (url.includes(key)) return handler(call);
    return new Response(JSON.stringify({ error: { message: `unmocked ${url}` } }), { status: 500 });
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { calls, spy };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ADMIN = { Authorization: 'Bearer admin-secret-token' };

function hostedApp(providers: Provider[], over: Partial<HostedOptions> = {}) {
  const quotaManager = new QuotaManager();
  const router = new Router({ quotaManager, modelRegistry: new ModelRegistry() });
  for (const p of providers) router.addProvider(p);
  const keys = new IssuedKeys(new MemoryDocStore());
  const hosted: HostedOptions = {
    keys, models: [], aliases: { 'embed-default': 'text-embedding-3-small' }, login: null, adminEmails: [],
    adminToken: 'admin-secret-token', publicUrl: 'https://leyline.test', ...over,
  };
  const app = createServer(router, quotaManager, { hosted, enforceExternalSurface: false, apiKeyStore: new MemorySecretStore() });
  return { app, keys, router };
}

async function issue(app: ReturnType<typeof hostedApp>['app'], caps: Record<string, unknown> = {}) {
  return (await request(app).post('/admin/api/keys').set(ADMIN).send({ name: 'svc', caps })).body.key as string;
}

const settle = () => new Promise((r) => setTimeout(r, 15));

/** A 1-second 16 kHz 16-bit mono WAV (silence). */
function wav(seconds = 1): Buffer {
  const data = Buffer.alloc(32_000 * seconds);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16_000, 24);
  h.writeUInt32LE(32_000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  jest.restoreAllMocks();
  logger.clear();
});

describe('POST /v1/embeddings', () => {
  it('routes an OpenAI model with an issued key, answers OpenAI-shaped, counts tokens at the list price', async () => {
    const { calls } = mockFetch({
      'api.openai.com/v1/embeddings': () => json({ object: 'list', model: 'text-embedding-3-small', data: [{ index: 1, embedding: [0.3, 0.4] }, { index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 8, total_tokens: 8 } }),
      'api.openai.com/v1/models': () => json({ data: [] }),
    });
    const { app, keys } = hostedApp([new OpenAIProvider('sk-test')]);
    const key = await issue(app);

    expect((await request(app).post('/v1/embeddings').send({ model: 'text-embedding-3-small', input: 'x' })).status).toBe(401);
    const r = await request(app).post('/v1/embeddings').set({ Authorization: `Bearer ${key}` }).send({ model: 'embed-default', input: ['a', 'b'], dimensions: 2 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }, { object: 'embedding', index: 1, embedding: [0.3, 0.4] }],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 8, total_tokens: 8 },
    });
    const sent = calls.find(c => c.url.endsWith('/embeddings'))!;
    expect(JSON.parse(String(sent.init.body))).toEqual({ model: 'text-embedding-3-small', input: ['a', 'b'], encoding_format: 'float', dimensions: 2 });
    expect((sent.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');

    await settle();
    const spend = await keys.spend();
    expect(spend.byModel?.['OpenAI/text-embedding-3-small']).toMatchObject({ requests: 1, tokens: 8 });
    expect(spend.usd).toBeCloseTo((8 * 0.02) / 1e6, 12);
  });

  it('base64 encoding_format packs little-endian float32s', async () => {
    mockFetch({ '/embeddings': () => json({ data: [{ index: 0, embedding: [1, -2] }], usage: { prompt_tokens: 1 } }), '/models': () => json({ data: [] }) });
    const { app } = hostedApp([new OpenAIProvider('sk-test')]);
    const r = await request(app).post('/v1/embeddings').set({ Authorization: `Bearer ${await issue(app)}` }).send({ model: 'text-embedding-3-small', input: 'x', encoding_format: 'base64' });
    const buf = Buffer.from(r.body.data[0].embedding, 'base64');
    expect([buf.readFloatLE(0), buf.readFloatLE(4)]).toEqual([1, -2]);
  });

  it('auto picks the first configured provider in preference order; Workers AI through its binding', async () => {
    const binding: WorkersAiBinding = { run: jest.fn(async () => ({ shape: [2, 3], data: [[1, 2, 3], [4, 5, 6]] })) };
    const { app } = hostedApp([new OpenAIProvider(''), new WorkersAiProvider({ binding })]);
    const r = await request(app).post('/v1/embeddings').set({ Authorization: `Bearer ${await issue(app)}` }).send({ input: ['xin chào', 'hello'] });
    expect(r.status).toBe(200);
    expect(r.body.model).toBe('@cf/baai/bge-m3');
    expect(r.body.data.map((d: { embedding: number[] }) => d.embedding)).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(binding.run).toHaveBeenCalledWith('@cf/baai/bge-m3', { text: ['xin chào', 'hello'] });
    expect(r.body.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it('bge-m3 answers under `response`; inputs over 100 go in batches', async () => {
    const binding: WorkersAiBinding = { run: jest.fn(async (_m: string, inputs: Record<string, unknown>) => ({ response: (inputs.text as string[]).map(() => [0.5]) })) };
    const provider = new WorkersAiProvider({ binding });
    const out = await provider.embed({ model: '@cf/baai/bge-m3', input: Array.from({ length: 150 }, (_, i) => `t${i}`) });
    expect(out.embeddings).toHaveLength(150);
    expect(binding.run).toHaveBeenCalledTimes(2);
  });

  it('never fails over to a different embedding model; a model nobody serves is 404', async () => {
    mockFetch({ '/embeddings': () => json({ error: { message: 'down' } }, 503), '/models': () => json({ data: [] }) });
    const binding: WorkersAiBinding = { run: jest.fn() };
    const { app } = hostedApp([new OpenAIProvider('sk-test'), new WorkersAiProvider({ binding })]);
    const key = await issue(app);
    const down = await request(app).post('/v1/embeddings').set({ Authorization: `Bearer ${key}` }).send({ model: 'text-embedding-3-small', input: 'x' });
    expect(down.status).toBe(503);
    expect(binding.run).not.toHaveBeenCalled();
    const none = await request(app).post('/v1/embeddings').set({ Authorization: `Bearer ${key}` }).send({ model: 'nomic-embed-text', input: 'x' });
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe('model_not_found');
  });

  it('hosted rules apply: offered models, turned-off models, a key\'s model list', async () => {
    mockFetch({ '/models': () => json({ data: [] }) });
    const { app } = hostedApp([new OpenAIProvider('sk-test')], { models: ['gpt-5.5'], blockedModels: [] });
    const key = await issue(app);
    expect((await request(app).post('/v1/embeddings').set({ Authorization: `Bearer ${key}` }).send({ model: 'text-embedding-3-large', input: 'x' })).status).toBe(404);
    const blocked = hostedApp([new OpenAIProvider('sk-test')], { blockedModels: ['text-embedding-*'] });
    const k2 = await issue(blocked.app);
    expect((await request(blocked.app).post('/v1/embeddings').set({ Authorization: `Bearer ${k2}` }).send({ model: 'text-embedding-3-small', input: 'x' })).body.error.code).toBe('model_disabled');
    const narrowed = hostedApp([new OpenAIProvider('sk-test')]);
    const k3 = await issue(narrowed.app, { models: ['gpt-*'] });
    expect((await request(narrowed.app).post('/v1/embeddings').set({ Authorization: `Bearer ${k3}` }).send({ model: 'text-embedding-3-small', input: 'x' })).body.error.code).toBe('model_not_allowed');
  });

  it('rejects token arrays and empty input', async () => {
    const { app } = hostedApp([new OpenAIProvider('sk-test')]);
    const key = await issue(app);
    expect((await request(app).post('/v1/embeddings').set({ Authorization: `Bearer ${key}` }).send({ model: 'text-embedding-3-small', input: [[1, 2]] })).status).toBe(400);
    expect((await request(app).post('/v1/embeddings').set({ Authorization: `Bearer ${key}` }).send({ model: 'text-embedding-3-small', input: [] })).status).toBe(400);
  });

  it('the LLM API gateway serves only the embedding models it lists', async () => {
    const { calls } = mockFetch({
      'llm.test/v1/embeddings': () => json({ data: [{ index: 0, embedding: [9] }], usage: { prompt_tokens: 2 } }),
    });
    const llm = new LlmApiProvider('k', 'gpt-5.5', 'https://llm.test/v1');
    jest.spyOn(llm, 'getModels').mockResolvedValue([{ id: 'gpt-5.5' }, { id: 'text-embedding-3-large', pricing: { input: 0.13, output: 0 } }]);
    const { app } = hostedApp([llm]);
    const key = await issue(app);
    expect((await request(app).post('/v1/embeddings').set({ Authorization: `Bearer ${key}` }).send({ model: 'text-embedding-3-large', input: 'x' })).body.data[0].embedding).toEqual([9]);
    expect((await request(app).post('/v1/embeddings').set({ Authorization: `Bearer ${key}` }).send({ model: 'text-embedding-3-small', input: 'x' })).status).toBe(404);
    // Not part of auto: it doesn't say which embedding model it would use.
    expect((await request(app).post('/v1/embeddings').set({ Authorization: `Bearer ${key}` }).send({ input: 'x' })).status).toBe(503);
    expect(calls.filter(c => c.url.endsWith('/embeddings'))).toHaveLength(1);
  });
});

describe('embedding providers', () => {
  const answer = () => json({ data: [{ index: 0, embedding: [1] }], usage: { prompt_tokens: 3, total_tokens: 3 } });

  it('Gemini (OpenAI-compatible endpoint) and OpenRouter (vendor/model ids)', async () => {
    const { calls } = mockFetch({ 'generativelanguage.googleapis.com': answer, 'openrouter.ai/api/v1/embeddings': answer });
    const gemini = new GeminiProvider('g-key');
    expect(gemini.servesModel('embeddings', 'gemini-embedding-001')).toBe(true);
    await gemini.embed({ model: 'gemini-embedding-001', input: ['x'], dimensions: 768 });
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/embeddings');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ model: 'gemini-embedding-001', dimensions: 768 });

    const openrouter = new OpenRouterProvider('or-key');
    expect(openrouter.servesModel('embeddings', 'qwen/qwen3-embedding-8b')).toBe(true);
    expect(openrouter.servesModel('embeddings', 'text-embedding-3-small')).toBe(false);
    await openrouter.embed({ model: 'openai/text-embedding-3-small', input: ['x'] });
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer or-key');
  });

  it('Azure serves its embeddings deployment (AZURE_OPENAI_EMBEDDING_DEPLOYMENT), v1 and legacy URLs', async () => {
    const { calls } = mockFetch({ '/embeddings': answer });
    const v1 = new AzureOpenAIProvider('az-key', 'https://res.openai.azure.com/openai/v1', 'gpt-5.5');
    expect(v1.servesModel('embeddings', 'text-embedding-3-small')).toBe(false);
    v1.embeddingDeployment = 'emb-small';
    expect(v1.servesModel('embeddings', 'emb-small')).toBe(true);
    expect(v1.defaultModelFor('embeddings')).toBe('emb-small');
    expect((await v1.embed({ model: 'emb-small', input: ['x'] })).embeddings).toEqual([[1]]);
    expect(calls[0].url).toBe('https://res.openai.azure.com/openai/v1/embeddings');

    const legacy = new AzureOpenAIProvider('az-key', 'https://res.openai.azure.com', 'gpt-5.5', '2024-10-21');
    legacy.embeddingDeployment = 'emb-small';
    await legacy.embed({ model: 'emb-small', input: ['x'] });
    expect(calls[1].url).toMatch(/^https:\/\/res\.openai\.azure\.com\/openai\/deployments\/emb-small\/embeddings\?api-version=2024-10-21/);
  });
});

describe('POST /v1/audio/transcriptions', () => {
  it('OpenAI whisper-1: asks for verbose_json, answers in the requested format (srt), priced by the minute', async () => {
    let form: FormData | undefined;
    mockFetch({
      'api.openai.com/v1/audio/transcriptions': async (call) => {
        form = call.init.body as FormData;
        return json({ text: 'Hello there.', language: 'english', duration: 90, segments: [{ id: 0, start: 0, end: 1.5, text: 'Hello' }, { id: 1, start: 1.5, end: 3.25, text: ' there.' }] });
      },
      '/models': () => json({ data: [] }),
    });
    const { app, keys } = hostedApp([new OpenAIProvider('sk-test')]);
    const key = await issue(app);
    const r = await request(app).post('/v1/audio/transcriptions').set({ Authorization: `Bearer ${key}` })
      .field('model', 'whisper-1').field('response_format', 'srt').field('language', 'en')
      .attach('file', wav(), { filename: 'a.wav', contentType: 'audio/wav' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/plain/);
    expect(r.text).toBe('1\n00:00:00,000 --> 00:00:01,500\nHello\n\n2\n00:00:01,500 --> 00:00:03,250\nthere.\n');
    expect(form!.get('response_format')).toBe('verbose_json');
    expect(form!.get('language')).toBe('en');
    expect((form!.get('file') as Blob).size).toBe(wav().length);
    await settle();
    expect((await keys.spend()).usd).toBeCloseTo(transcriptionCostUsd('whisper-1', 90), 10);
  });

  it('Deepgram nova-3: prerecorded API, mapped to verbose_json', async () => {
    const { calls } = mockFetch({
      'api.deepgram.com/v1/listen': () => json({
        metadata: { duration: 2.5 },
        results: {
          channels: [{ detected_language: 'vi', alternatives: [{ transcript: 'Xin chào bạn', words: [{ word: 'xin', punctuated_word: 'Xin', start: 0.1, end: 0.4 }, { word: 'chào', start: 0.4, end: 0.8 }, { word: 'bạn', start: 0.8, end: 1.2 }] }] }],
          utterances: [{ start: 0.1, end: 1.2, transcript: 'Xin chào bạn' }],
        },
      }),
    });
    const { app } = hostedApp([new DeepgramProvider('dg-key')]);
    const r = await request(app).post('/v1/audio/transcriptions').set({ Authorization: `Bearer ${await issue(app)}` })
      .field('model', 'nova-3').field('response_format', 'verbose_json').field('timestamp_granularities[]', 'word').field('timestamp_granularities[]', 'segment')
      .attach('file', Buffer.from('fake-mp3'), { filename: 'a.mp3', contentType: 'audio/mpeg' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      task: 'transcribe', language: 'vi', duration: 2.5, text: 'Xin chào bạn',
      segments: [{ id: 0, start: 0.1, end: 1.2, text: 'Xin chào bạn' }],
      words: [{ word: 'Xin', start: 0.1, end: 0.4 }, { word: 'chào', start: 0.4, end: 0.8 }, { word: 'bạn', start: 0.8, end: 1.2 }],
    });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('detect_language')).toBe('true');
    expect(url.searchParams.get('utterances')).toBe('true');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Token dg-key');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('audio/mpeg');
  });

  it('auto prefers OpenAI, then Deepgram; plain json includes the audio seconds', async () => {
    mockFetch({ 'api.deepgram.com': () => json({ metadata: { duration: 4 }, results: { channels: [{ alternatives: [{ transcript: 'hi' }] }] } }) });
    const { app } = hostedApp([new OpenAIProvider(''), new DeepgramProvider('dg')]);
    const r = await request(app).post('/v1/audio/transcriptions').set({ Authorization: `Bearer ${await issue(app)}` })
      .attach('file', Buffer.from('x'), { filename: 'a.ogg', contentType: 'audio/ogg' });
    expect(r.body).toEqual({ text: 'hi', usage: { type: 'duration', seconds: 4 } });
  });

  it('Workers AI whisper-large-v3-turbo through the binding (base64 audio); text format', async () => {
    const binding: WorkersAiBinding = { run: jest.fn(async () => ({ text: ' Hello. ', transcription_info: { language: 'en', duration: 1 }, segments: [{ start: 0, end: 1, text: 'Hello.' }] })) };
    const { app } = hostedApp([new WorkersAiProvider({ binding })]);
    const r = await request(app).post('/v1/audio/transcriptions').set({ Authorization: `Bearer ${await issue(app)}` })
      .field('model', '@cf/openai/whisper-large-v3-turbo').field('response_format', 'text').field('prompt', 'greeting')
      .attach('file', Buffer.from([1, 2, 3]), { filename: 'a.wav', contentType: 'audio/wav' });
    expect(r.text).toBe('Hello.');
    expect(binding.run).toHaveBeenCalledWith('@cf/openai/whisper-large-v3-turbo', { audio: Buffer.from([1, 2, 3]).toString('base64'), initial_prompt: 'greeting' });
  });

  it('wants a multipart file and a known response_format', async () => {
    const { app } = hostedApp([new DeepgramProvider('dg')]);
    const key = await issue(app);
    expect((await request(app).post('/v1/audio/transcriptions').set({ Authorization: `Bearer ${key}` }).send({ model: 'nova-3' })).status).toBe(400);
    expect((await request(app).post('/v1/audio/transcriptions').set({ Authorization: `Bearer ${key}` }).field('model', 'nova-3')).body.error.code).toBe('missing_file');
    expect((await request(app).post('/v1/audio/transcriptions').set({ Authorization: `Bearer ${key}` }).field('response_format', 'xml').attach('file', Buffer.from('x'), 'a.mp3')).body.error.code).toBe('invalid_response_format');
    expect((await request(app).post('/v1/audio/transcriptions').field('model', 'nova-3').attach('file', Buffer.from('x'), 'a.mp3')).status).toBe(401);
  });
});

describe('POST /v1/audio/speech', () => {
  it('OpenAI tts-1: audio bytes back, priced by the character', async () => {
    const { calls } = mockFetch({ 'api.openai.com/v1/audio/speech': () => new Response(new Uint8Array([73, 68, 51]), { headers: { 'content-type': 'audio/mpeg' } }), '/models': () => json({ data: [] }) });
    const { app, keys } = hostedApp([new OpenAIProvider('sk-test')]);
    const r = await request(app).post('/v1/audio/speech').set({ Authorization: `Bearer ${await issue(app)}` })
      .send({ model: 'tts-1', input: 'Hello world', voice: 'nova' }).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('audio/mpeg');
    expect([...(r.body as Buffer)]).toEqual([73, 68, 51]);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: 'tts-1', input: 'Hello world', voice: 'nova', response_format: 'mp3' });
    await settle();
    expect((await keys.spend()).usd).toBeCloseTo(speechCostUsd('tts-1', 11), 12);
  });

  it('Workers AI MeloTTS through the binding (base64 MP3); other formats are refused', async () => {
    const binding: WorkersAiBinding = { run: jest.fn(async () => ({ audio: Buffer.from('mp3!').toString('base64') })) };
    const { app } = hostedApp([new WorkersAiProvider({ binding })]);
    const key = await issue(app);
    const r = await request(app).post('/v1/audio/speech').set({ Authorization: `Bearer ${key}` }).send({ model: '@cf/myshell-ai/melotts', input: 'Bonjour', voice: 'fr' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('audio/mpeg');
    expect(binding.run).toHaveBeenCalledWith('@cf/myshell-ai/melotts', { prompt: 'Bonjour', lang: 'fr' });
    const wavAsked = await request(app).post('/v1/audio/speech').set({ Authorization: `Bearer ${key}` }).send({ model: '@cf/myshell-ai/melotts', input: 'x', response_format: 'wav' });
    expect(wavAsked.status).toBe(400);
  });
});

describe('Workers AI chat', () => {
  it('maps a binding answer (text, tool calls, usage) to a chat completion', async () => {
    const binding: WorkersAiBinding = { run: jest.fn(async () => ({ response: 'Done.', tool_calls: [{ name: 'ls', arguments: { dir: '.' } }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })) };
    const p = new WorkersAiProvider({ binding });
    const out = await p.complete({ model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2 });
    expect(binding.run).toHaveBeenCalledWith('@cf/meta/llama-3.3-70b-instruct-fp8-fast', { messages: [{ role: 'user', content: 'hi' }], max_tokens: 2048, temperature: 0.2 });
    expect(out.choices[0].message).toMatchObject({ role: 'assistant', content: 'Done.', tool_calls: [{ type: 'function', function: { name: 'ls', arguments: '{"dir":"."}' } }] });
    expect(out.choices[0].finish_reason).toBe('tool_calls');
    expect(out.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
  });

  it('streams OpenAI chunks from Workers AI SSE (split across reads), usage last', async () => {
    const enc = new TextEncoder();
    const parts = ['data: {"response":"Hel', 'lo"}\n\ndata: {"response":" there"}\n\n', 'data: {"response":"","usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\ndata: [DONE]\n\n'];
    const binding: WorkersAiBinding = { run: jest.fn(async () => new ReadableStream({ start(c) { for (const p of parts) c.enqueue(enc.encode(p)); c.close(); } })) };
    const { app } = hostedApp([new WorkersAiProvider({ binding })]);
    const r = await request(app).post('/v1/chat/completions').set({ Authorization: `Bearer ${await issue(app)}` })
      .send({ model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    const events = r.text.split('\n\n').filter(Boolean).map(e => e.slice(6));
    expect(events[events.length - 1]).toBe('[DONE]');
    const chunks = events.slice(0, -1).map(e => JSON.parse(e));
    expect(chunks.map(c => c.choices[0]?.delta?.content ?? '').join('')).toBe('Hello there');
    expect(chunks[chunks.length - 1].usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  it('without a binding: the REST API with the account id and token, results unwrapped', async () => {
    const { calls } = mockFetch({ 'api.cloudflare.com': () => json({ success: true, result: { response: 'ok', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } }) });
    const p = new WorkersAiProvider({ accountId: 'acc123', apiToken: 'cf-token' });
    expect(await p.isAvailable()).toBe(true);
    expect(await new WorkersAiProvider({ accountId: '', apiToken: '' }).isAvailable()).toBe(false);
    const out = await p.complete({ model: '@cf/meta/llama-3.1-8b-instruct-fp8', messages: [{ role: 'user', content: 'hi' }] });
    expect(out.choices[0].message.content).toBe('ok');
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/ai/run/@cf/meta/llama-3.1-8b-instruct-fp8');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer cf-token');
  });

  it('chat never routes to a speech-only provider; Workers AI takes only @cf/ chat models', async () => {
    const binding: WorkersAiBinding = { run: jest.fn(async () => ({ response: 'from workers' })) };
    const deepgram = new DeepgramProvider('dg');
    const complete = jest.spyOn(deepgram, 'complete');
    const { app } = hostedApp([deepgram, new WorkersAiProvider({ binding })]);
    const key = await issue(app);
    const r = await request(app).post('/v1/chat/completions').set({ Authorization: `Bearer ${key}` }).send({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.body.choices[0].message.content).toBe('from workers');
    expect(complete).not.toHaveBeenCalled();
    expect((await request(app).post('/v1/chat/completions').set({ Authorization: `Bearer ${key}` }).send({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] })).status).not.toBe(200);
  });
});

describe('surface and dashboard', () => {
  it('the new routes are reachable through a public proxy (client key auth)', async () => {
    const binding: WorkersAiBinding = { run: jest.fn(async () => ({ data: [[1]] })) };
    const router = new Router(new QuotaManager());
    router.addProvider(new WorkersAiProvider({ binding }));
    const app = createServer(router, new QuotaManager(), { apiKeyStore: new MemorySecretStore() });
    const r = await request(app).post('/v1/embeddings').set('cf-connecting-ip', '203.0.113.10').set(LEYLINE_CLIENT_AUTH_HEADER).send({ model: '@cf/baai/bge-base-en-v1.5', input: 'x' });
    expect(r.status).toBe(200);
    for (const path of ['/v1/audio/transcriptions', '/v1/audio/speech']) {
      const res = await request(app).post(path).set('cf-connecting-ip', '203.0.113.10').send({});
      expect(res.body.error?.code).not.toBe('external_endpoint_not_exposed');
    }
  });

  it('the dashboard lists each provider\'s capabilities; the AI binding counts as ready without a key', async () => {
    const router = new Router(new QuotaManager());
    router.addProvider(new OpenAIProvider(''));
    router.addProvider(new DeepgramProvider(''));
    router.addProvider(new WorkersAiProvider({ binding: { run: jest.fn() } }));
    const app = createServer(router, new QuotaManager(), { apiKeyStore: new MemorySecretStore() });
    const r = await request(app).get('/dashboard/api-keys');
    const byName = Object.fromEntries(r.body.providers.map((p: { name: string }) => [p.name, p]));
    expect(byName.OpenAI.capabilities).toEqual(['chat', 'embeddings', 'transcription', 'speech']);
    expect(byName.Deepgram).toMatchObject({ capabilities: ['transcription'], configured: false });
    expect(byName.WorkersAI).toMatchObject({ runtimeReady: true, runtimeConfig: { binding: true }, configured: false });
  });
});

describe('media helpers', () => {
  it('WAV length comes from its header; other audio is estimated from its size', () => {
    expect(estimateAudioSeconds(wav(2))).toBeCloseTo(2, 5);
    expect(estimateAudioSeconds(new Uint8Array(160_000))).toBe(10);
  });

  it('vtt and verbose_json from a transcript without segments', () => {
    const r = { text: 'One two.', duration: 61.5 };
    expect(formatTranscription(r, 'vtt').body).toBe('WEBVTT\n\n00:00:00.000 --> 00:01:01.500\nOne two.\n');
    expect(formatTranscription(r, 'verbose_json').body).toMatchObject({ duration: 61.5, segments: [{ id: 0, start: 0, end: 61.5, text: 'One two.' }] });
  });

  it('unknown audio models cost the deliberately high default', () => {
    expect(transcriptionCostUsd('nova-3-medical', 60)).toBeCloseTo(0.0052, 8);
    expect(transcriptionCostUsd('mystery', 60)).toBe(0.02);
    expect(speechCostUsd('mystery', 1_000_000)).toBe(30);
  });
});
