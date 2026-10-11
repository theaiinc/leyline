import axios from 'axios';
import { sanitizeToolSchemas } from './tool-schema';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../core/types';
import { config } from '../config';

export class OpenAIProvider implements Provider {
  name = 'OpenAI';
  defaultModel: string;
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(
    apiKey: string = process.env.OPENAI_API_KEY || '',
    model: string = config.DEFAULT_MODELS.OPENAI,
    baseUrl: string = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.defaultModel = model;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  async getModels(): Promise<ModelDetail[]> {
    if (!this.apiKey) return [];

    try {
      const response = await axios.get(`${this.baseUrl}/models`, {
        headers: this.headers(),
        timeout: 30000,
      });
      return (response.data?.data || []).map((m: any) => ({
        id: m.id,
        name: m.id,
      }));
    } catch (error) {
      console.error('[OpenAI] Failed to list models:', error);
      return this.defaultModel ? [{ id: this.defaultModel, name: this.defaultModel }] : [];
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await axios.post(
      `${this.baseUrl}/chat/completions`,
      upstreamBody(request, request.model || this.model, false),
      {
        headers: this.headers(),
        timeout: 300000,
      },
    );

    return response.data;
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    // fetch, not axios: axios's stream responses don't exist on Cloudflare Workers (hosted Leyline), fetch's
    // streams work there and in Node alike.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300000);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        // Ask for the token usage at the end of the stream (per-key metering needs it).
        body: JSON.stringify({ ...upstreamBody(request, request.model || this.model, true), stream_options: { include_usage: true } }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const detail = (await response.text().catch(() => '')).slice(0, 500);
        const error = new Error(`${this.name} stream failed with HTTP ${response.status}: ${detail}`) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }

      // An SSE line can be split across network chunks (tool-call arguments stream in pieces):
      // keep the unfinished tail and parse it with the next chunk.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            await reader.cancel().catch(() => undefined);
            return;
          }
          try {
            yield JSON.parse(data);
          } catch {
            // not JSON (a comment or keep-alive)
          }
        }
      }
      const tail = (pending + decoder.decode()).trim();
      if (tail.startsWith('data:') && tail.slice(5).trim() !== '[DONE]') {
        try {
          yield JSON.parse(tail.slice(5).trim());
        } catch {
          // incomplete last line
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }
}

/** Fields of an OpenAI chat request passed through upstream as the client sent them. */
const PASSTHROUGH = [
  'tools', 'tool_choice', 'parallel_tool_calls', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens',
  'presence_penalty', 'frequency_penalty', 'response_format', 'seed', 'stop', 'user', 'reasoning_effort', 'n',
] as const;

/**
 * The upstream body: the model and messages, plus every generation and tool field the client set. Coding agents
 * depend on tools and tool_choice reaching the model; dropping them silently turns tool calls into plain text.
 */
export function upstreamBody(request: CompletionRequest, model: string, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages: request.messages, stream };
  for (const key of PASSTHROUGH) {
    if (request[key] !== undefined && request[key] !== null) body[key] = request[key];
  }
  if (body.tools) body.tools = sanitizeToolSchemas(body.tools);
  // OpenAI's reasoning models reject max_tokens and take max_completion_tokens instead; other models (Claude,
  // DeepSeek … behind a gateway) keep max_tokens.
  if (body.max_tokens !== undefined && REASONING_MODEL.test(model.split('/').pop() ?? model)) {
    body.max_completion_tokens ??= body.max_tokens;
    delete body.max_tokens;
  }
  return body;
}

const REASONING_MODEL = /^(gpt-5|gpt-6|o\d)/i;
