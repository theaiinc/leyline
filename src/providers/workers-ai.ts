import { randomBytes } from 'crypto';
import type {
  Capability, ChatMessage, CompletionRequest, CompletionResponse, EmbeddingRequest, EmbeddingResult, ModelDetail, Provider,
  SpeechRequest, SpeechResult, StreamChunk, TranscriptionRequest, TranscriptionResult,
} from '../core/types';
import { estimateTextTokens, upstreamError } from '../core/media';
import { contentText, estimateMessageTokens } from '../core/content';

/** The Workers AI binding (`env.AI` with `"ai": {"binding": "AI"}` in wrangler.jsonc). */
export interface WorkersAiBinding {
  run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

/** The models Leyline offers from Workers AI, with Cloudflare's list prices (US$ per million tokens, 2026-10). */
const CATALOG: Array<ModelDetail & { capability: Capability }> = [
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B (fp8, fast)', capability: 'chat', pricing: { input: 0.293, output: 2.253 } },
  { id: '@cf/meta/llama-3.1-8b-instruct-fp8', name: 'Llama 3.1 8B (fp8)', capability: 'chat', pricing: { input: 0.152, output: 0.287 } },
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B', capability: 'chat', pricing: { input: 0.27, output: 0.85 } },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', name: 'Mistral Small 3.1 24B', capability: 'chat', pricing: { input: 0.351, output: 0.555 } },
  { id: '@cf/qwen/qwen3-30b-a3b-fp8', name: 'Qwen3 30B A3B (fp8)', capability: 'chat', pricing: { input: 0.0509, output: 0.335 } },
  { id: '@cf/baai/bge-m3', name: 'BGE M3 (multilingual embeddings, 1024)', capability: 'embeddings', pricing: { input: 0.012, output: 0 } },
  { id: '@cf/baai/bge-small-en-v1.5', name: 'BGE small EN (embeddings, 384)', capability: 'embeddings', pricing: { input: 0.0202, output: 0 } },
  { id: '@cf/baai/bge-base-en-v1.5', name: 'BGE base EN (embeddings, 768)', capability: 'embeddings', pricing: { input: 0.067, output: 0 } },
  { id: '@cf/baai/bge-large-en-v1.5', name: 'BGE large EN (embeddings, 1024)', capability: 'embeddings', pricing: { input: 0.204, output: 0 } },
  { id: '@cf/openai/whisper-large-v3-turbo', name: 'Whisper large v3 turbo (speech-to-text)', capability: 'transcription' },
  { id: '@cf/openai/whisper', name: 'Whisper (speech-to-text)', capability: 'transcription' },
  { id: '@cf/openai/whisper-tiny-en', name: 'Whisper tiny EN (speech-to-text)', capability: 'transcription' },
  { id: '@cf/myshell-ai/melotts', name: 'MeloTTS (text-to-speech, MP3)', capability: 'speech' },
];

const DEFAULTS: Partial<Record<Capability, string>> = {
  chat: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  embeddings: '@cf/baai/bge-m3',
  transcription: '@cf/openai/whisper-large-v3-turbo',
  speech: '@cf/myshell-ai/melotts',
  vision: 'gemini-2.5-flash-lite',
  audio: 'gemini-2.5-flash-lite',
};

const PATTERNS: Partial<Record<Exclude<Capability, 'chat'>, RegExp>> = {
  embeddings: /^@cf\/[\w.-]+\/[\w.-]*(bge|embed)[\w.-]*$/i,
  transcription: /^@cf\/openai\/whisper[\w.-]*$/,
  speech: /^@cf\/myshell-ai\/melotts$/,
  vision: /^$a/,
  audio: /^$a/,
};
/** MeloTTS's languages (OpenAI's `voice` picks one; anything else is English). */
const MELO_LANGS = new Set(['en', 'es', 'fr', 'zh', 'jp', 'kr']);
/** Workers AI caps a generation at 256 tokens unless told otherwise; clients that don't say expect more. */
const DEFAULT_MAX_TOKENS = 2048;

/**
 * Cloudflare Workers AI: chat (OpenAI-shaped in and out, streaming too), embeddings (@cf/baai/bge-*),
 * speech-to-text (@cf/openai/whisper*) and text-to-speech (@cf/myshell-ai/melotts).
 *
 * On the hosted Worker it uses the `AI` binding (no key: billed to the Worker's account). Elsewhere it uses the
 * REST API, https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/run/{model}, with
 * CLOUDFLARE_API_TOKEN (a token with Workers AI read/edit) — set on the dashboard, in env, or as an Arcana reference.
 */
export class WorkersAiProvider implements Provider {
  name = 'WorkersAI';
  label = 'Cloudflare Workers AI';
  capabilities: Capability[] = ['chat', 'embeddings', 'transcription', 'speech'];
  defaultModel: string = DEFAULTS.chat!;
  private apiToken: string;
  private accountId: string;
  private readonly binding?: WorkersAiBinding;
  private readonly apiBase: string;

  constructor(opts: { binding?: WorkersAiBinding; accountId?: string; apiToken?: string; apiBase?: string } = {}) {
    this.binding = opts.binding;
    this.accountId = opts.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
    this.apiToken = opts.apiToken ?? process.env.CLOUDFLARE_API_TOKEN ?? '';
    this.apiBase = (opts.apiBase ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.binding || (this.accountId && this.apiToken));
  }

  setApiKey(apiKey: string): void {
    this.apiToken = apiKey;
  }

  hasApiKey(): boolean {
    return Boolean(this.apiToken);
  }

  /** The dashboard's runtime card: the account id (as "base URL"), and whether the AI binding serves instead. */
  getRuntimeConfig(): Record<string, string | boolean | undefined> {
    return { baseUrl: this.accountId, model: this.defaultModel, baseUrlConfigured: Boolean(this.binding || this.accountId), binding: Boolean(this.binding) };
  }

  setRuntimeConfig(runtime: Record<string, string | undefined>): void {
    if (typeof runtime.baseUrl === 'string') {
      // An account id, or a URL with /accounts/<id>/ in it.
      const v = runtime.baseUrl.trim();
      this.accountId = /\/accounts\/([0-9a-f]+)/i.exec(v)?.[1] ?? v;
    }
    if (typeof runtime.model === 'string' && runtime.model.trim()) this.defaultModel = runtime.model.trim();
  }

  async getModels(): Promise<ModelDetail[]> {
    return CATALOG.map(({ capability: _c, ...m }) => m);
  }

  servesModel(capability: Capability, model: string): boolean {
    if (capability === 'chat') return CATALOG.some((entry) => entry.capability === 'chat' && entry.id === model);
    return Boolean(PATTERNS[capability]?.test(model));
  }

  defaultModelFor(capability: Capability): string | undefined {
    return capability === 'chat' ? this.defaultModel : DEFAULTS[capability];
  }

  /**
   * Its chat input here is text only (messages with string content), so requests with images, audio or files go
   * to a provider that reads them.
   */
  acceptsNonTextContent(): boolean {
    return false;
  }

  /** Chat requests for @cf/ models only (an unknown model id never lands here by accident). */
  async canHandle(request: CompletionRequest): Promise<boolean> {
    return request.model.startsWith('@cf/') && !Object.values(PATTERNS).some(p => p.test(request.model));
  }

  // ── running a model: the binding, else the REST API ───────────────────────────────────────────────────

  private async run(model: string, inputs: Record<string, unknown>): Promise<unknown> {
    if (this.binding) {
      try {
        return await this.binding.run(model, inputs);
      } catch (error) {
        throw bindingError(error);
      }
    }
    const res = await this.post(model, JSON.stringify(inputs), 'application/json');
    return unwrap(res);
  }

  private async post(model: string, body: BodyInit, contentType: string): Promise<Response> {
    if (!this.accountId || !this.apiToken) throw new Error('Workers AI needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (or the AI binding)');
    const res = await fetch(`${this.apiBase}/accounts/${this.accountId}/ai/run/${model}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiToken}`, 'Content-Type': contentType },
      body,
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw await upstreamError(this.name, res);
    return res;
  }

  // ── chat ──────────────────────────────────────────────────────────────────────────────────────────────

  private chatInputs(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const inputs: Record<string, unknown> = {
      messages: request.messages.map(toWorkersMessage),
      max_tokens: request.max_completion_tokens ?? request.max_tokens ?? DEFAULT_MAX_TOKENS,
      ...(stream ? { stream: true } : {}),
    };
    for (const key of ['temperature', 'top_p', 'seed', 'presence_penalty', 'frequency_penalty', 'response_format'] as const) {
      if (request[key] !== undefined && request[key] !== null) inputs[key] = request[key];
    }
    if (Array.isArray(request.tools) && request.tools.length) inputs.tools = request.tools;
    return inputs;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = request.model || this.defaultModel;
    const out = await this.run(model, this.chatInputs({ ...request, model }, false)) as {
      response?: unknown; tool_calls?: Array<{ name?: string; arguments?: unknown; id?: string; function?: { name?: string; arguments?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const text = typeof out?.response === 'string' ? out.response : out?.response === undefined || out?.response === null ? '' : JSON.stringify(out.response);
    const calls = (out?.tool_calls ?? []).map((c, i) => {
      const name = c.function?.name ?? c.name ?? '';
      const args = c.function?.arguments ?? c.arguments ?? {};
      return { id: c.id ?? `call_${i}_${randomBytes(4).toString('hex')}`, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
    });
    const prompt = out?.usage?.prompt_tokens ?? estimateMessageTokens(request.messages);
    const completion = out?.usage?.completion_tokens ?? Math.ceil(text.length / 4);
    return {
      id: `chatcmpl-${randomBytes(12).toString('hex')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) } as never,
        finish_reason: calls.length ? 'tool_calls' : 'stop',
      }],
      usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: out?.usage?.total_tokens ?? prompt + completion },
    };
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const model = request.model || this.defaultModel;
    const inputs = this.chatInputs({ ...request, model }, true);
    let body: ReadableStream<Uint8Array>;
    if (this.binding) {
      try {
        body = await this.binding.run(model, inputs) as ReadableStream<Uint8Array>;
      } catch (error) {
        throw bindingError(error);
      }
    } else {
      const res = await this.post(model, JSON.stringify(inputs), 'application/json');
      if (!res.body) throw new Error('Workers AI returned no stream');
      body = res.body;
    }
    const id = `chatcmpl-${randomBytes(12).toString('hex')}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta: StreamChunk['choices'][0]['delta'], finish: string | null, usage?: StreamChunk['usage']): StreamChunk => ({
      id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}),
    });

    yield chunk({ role: 'assistant', content: '' }, null);
    let usage: StreamChunk['usage'];
    for await (const event of sseData(body)) {
      if (event === '[DONE]') break;
      let data: { response?: string; usage?: StreamChunk['usage'] };
      try {
        data = JSON.parse(event);
      } catch {
        continue;
      }
      if (data.usage) usage = data.usage;
      if (data.response) yield chunk({ content: data.response }, null);
    }
    yield chunk({}, 'stop');
    if (usage) yield { id, object: 'chat.completion.chunk', created, model, choices: [], usage };
  }

  // ── embeddings, transcription, speech ─────────────────────────────────────────────────────────────────

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    const embeddings: number[][] = [];
    // bge models take at most 100 texts a call.
    for (let i = 0; i < request.input.length; i += 100) {
      const out = await this.run(request.model, { text: request.input.slice(i, i + 100) }) as { data?: number[][]; response?: number[][] };
      const vectors = out?.data ?? out?.response;
      if (!Array.isArray(vectors)) throw new Error(`Workers AI ${request.model} returned no embeddings`);
      embeddings.push(...vectors);
    }
    if (embeddings.length !== request.input.length) throw new Error(`Workers AI returned ${embeddings.length} embeddings for ${request.input.length} inputs`);
    const tokens = estimateTextTokens(request.input);
    return { embeddings, model: request.model, usage: { prompt_tokens: tokens, total_tokens: tokens } };
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    let out: WhisperOutput;
    if (request.model === '@cf/openai/whisper-large-v3-turbo') {
      out = await this.run(request.model, {
        audio: Buffer.from(request.file.data).toString('base64'),
        ...(request.language ? { language: request.language } : {}),
        ...(request.prompt ? { initial_prompt: request.prompt } : {}),
      }) as WhisperOutput;
    } else if (this.binding) {
      out = await this.run(request.model, { audio: Array.from(request.file.data) }) as WhisperOutput;
    } else {
      // The older whisper models take the audio itself as the body.
      out = await unwrap(await this.post(request.model, request.file.data as BodyInit, 'application/octet-stream')) as WhisperOutput;
    }
    return fromWhisper(out);
  }

  async speak(request: SpeechRequest): Promise<SpeechResult> {
    const format = request.response_format || 'mp3';
    if (format !== 'mp3') {
      throw Object.assign(new Error(`${request.model} only makes mp3`), { status: 400, response: { status: 400, data: { error: { message: `${request.model} only makes mp3 (response_format "${format}" isn't available)` } } } });
    }
    const voice = (request.voice || '').toLowerCase();
    const inputs = { prompt: request.input, lang: MELO_LANGS.has(voice) ? voice : 'en' };
    let audio: Uint8Array;
    if (this.binding) {
      audio = await audioBytes(await this.run(request.model, inputs));
    } else {
      const res = await this.post(request.model, JSON.stringify(inputs), 'application/json');
      audio = (res.headers.get('content-type') ?? '').includes('json')
        ? await audioBytes((await res.json() as { result?: unknown }).result)
        : new Uint8Array(await res.arrayBuffer());
    }
    return { audio, contentType: 'audio/mpeg' };
  }
}

type WhisperOutput = {
  text?: string;
  words?: Array<{ word: string; start: number; end: number }>;
  segments?: Array<{ start: number; end: number; text: string; words?: Array<{ word: string; start: number; end: number }> }>;
  transcription_info?: { language?: string; duration?: number };
};

/** A Workers AI Whisper answer as a transcript. */
export function fromWhisper(out: WhisperOutput): TranscriptionResult {
  const words = out.words ?? out.segments?.flatMap(s => s.words ?? []);
  const duration = out.transcription_info?.duration ?? (words?.length ? words[words.length - 1].end : undefined);
  return {
    text: (out.text ?? '').trim(),
    ...(out.transcription_info?.language ? { language: out.transcription_info.language } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(out.segments?.length ? { segments: out.segments.map((s, id) => ({ id, start: s.start, end: s.end, text: s.text })) } : {}),
    ...(words?.length ? { words: words.map(w => ({ word: w.word, start: w.start, end: w.end })) } : {}),
  };
}

/**
 * Workers AI takes string contents; a multimodal content list keeps its text parts. The router never sends it
 * images (acceptsNonTextContent), so dropping them here can't make a model answer blind.
 */
function toWorkersMessage(m: ChatMessage): Record<string, unknown> {
  const content = contentText(m.content);
  return { role: m.role, content, ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}), ...(m.name ? { name: m.name } : {}) };
}

/** REST answers are {result, success, errors}. */
async function unwrap(res: Response): Promise<unknown> {
  const body = await res.json() as { result?: unknown; success?: boolean; errors?: Array<{ message?: string }> };
  if (body.success === false) throw new Error(`Workers AI: ${body.errors?.map(e => e.message).join('; ') || 'failed'}`);
  return body.result ?? body;
}

/** A binding error, with an HTTP status where Workers AI gave one (bad input: 400, so it isn't retried). */
function bindingError(error: unknown): Error {
  const e = error instanceof Error ? error : new Error(String(error));
  const status = /\b(InvalidInput|invalid input|5006|8001)\b/i.test(e.message) ? 400 : 502;
  return Object.assign(e, { status, response: { status, data: { error: { message: e.message } } } });
}

/** The `data:` payloads of a server-sent-events stream (lines may be split across chunks). */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith('data:')) yield t.slice(5).trim();
      }
    }
    const tail = (pending + decoder.decode()).trim();
    if (tail.startsWith('data:')) yield tail.slice(5).trim();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** MeloTTS answers base64 MP3 in JSON ({audio}), or the bytes / a stream of them. */
async function audioBytes(out: unknown): Promise<Uint8Array> {
  if (out && typeof out === 'object' && typeof (out as { audio?: unknown }).audio === 'string') {
    return new Uint8Array(Buffer.from((out as { audio: string }).audio, 'base64'));
  }
  if (out instanceof Uint8Array) return out;
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (out && typeof (out as ReadableStream).getReader === 'function') return new Uint8Array(await new Response(out as ReadableStream).arrayBuffer());
  throw new Error('Workers AI returned no audio');
}
