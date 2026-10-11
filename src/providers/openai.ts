import axios from 'axios';
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
    const response = await axios.post(
      `${this.baseUrl}/chat/completions`,
      // Ask for the token usage at the end of the stream (per-key metering needs it).
      { ...upstreamBody(request, request.model || this.model, true), stream_options: { include_usage: true } },
      {
        headers: this.headers(),
        responseType: 'stream',
        timeout: 300000,
      },
    );

    // An SSE line can be split across network chunks (tool-call arguments stream in pieces):
    // keep the unfinished tail and parse it with the next chunk.
    const stream: any = response.data;
    let pending = '';
    for await (const chunk of stream) {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data);
        } catch {
          // not JSON (a comment or keep-alive)
        }
      }
    }
    const tail = pending.trim();
    if (tail.startsWith('data:') && tail.slice(5).trim() !== '[DONE]') {
      try {
        yield JSON.parse(tail.slice(5).trim());
      } catch {
        // incomplete last line
      }
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
  // OpenAI's reasoning models reject max_tokens and take max_completion_tokens instead; other models (Claude,
  // DeepSeek … behind a gateway) keep max_tokens.
  if (body.max_tokens !== undefined && REASONING_MODEL.test(model.split('/').pop() ?? model)) {
    body.max_completion_tokens ??= body.max_tokens;
    delete body.max_tokens;
  }
  return body;
}

const REASONING_MODEL = /^(gpt-5|gpt-6|o\d)/i;
