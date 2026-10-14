import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail, Capability, ChatMessage } from '../core/types';
import { config } from '../config';

/**
 * Anthropic's Messages API (api.anthropic.com) behind Leyline's OpenAI-compatible surface: requests are
 * translated to Messages (system prompt, content parts, tools, tool results) and answers back to chat
 * completions, streaming included. Key: ANTHROPIC_API_KEY, the dashboard, or an Arcana reference
 * (LEYLINE_ARCANA_ANTHROPIC_REF / LEYLINE_ARCANA_CLOUD_ANTHROPIC_REF).
 */

const API = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';
/** Messages requires max_tokens; used when the client didn't send one. */
const DEFAULT_MAX_TOKENS = 4096;

type AnthropicBlock = Record<string, unknown>;
type AnthropicMessage = { role: 'user' | 'assistant'; content: AnthropicBlock[] };

function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(p => (p.type === 'text' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('');
}

/** OpenAI content (string or parts) as Messages blocks: text, and images (data URLs inline, others by URL). */
function blocksOf(content: ChatMessage['content']): AnthropicBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: AnthropicBlock[] = [];
  for (const part of content) {
    if (part.type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
      out.push({ type: 'text', text: (part as { text: string }).text });
    } else if (part.type === 'image_url') {
      const url = String((part as { image_url?: { url?: string } }).image_url?.url || '');
      const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
      if (data) out.push({ type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } });
      else if (url) out.push({ type: 'image', source: { type: 'url', url } });
    }
  }
  return out;
}

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

/** A chat completions request as a Messages request. */
export function toAnthropicRequest(request: CompletionRequest, model: string): Record<string, unknown> {
  const system: string[] = [];
  const messages: AnthropicMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    // Messages wants alternating turns: consecutive same-role messages (several tool results) merge.
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const message of request.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = textOf(message.content);
      if (text) system.push(text);
    } else if (message.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: textOf(message.content) }]);
    } else if (message.role === 'assistant') {
      const calls = (Array.isArray(message.tool_calls) ? message.tool_calls : []) as Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
      push('assistant', [
        ...blocksOf(message.content),
        ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.function?.name, input: parseArguments(call.function?.arguments) })),
      ]);
    } else {
      push('user', blocksOf(message.content));
    }
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: request.max_completion_tokens ?? request.max_tokens ?? DEFAULT_MAX_TOKENS,
  };
  if (system.length) body.system = system.join('\n\n');
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  if (typeof request.top_p === 'number') body.top_p = request.top_p;
  if (request.stop) body.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  if (Array.isArray(request.tools) && request.tools.length) {
    body.tools = (request.tools as Array<{ function?: { name?: string; description?: string; parameters?: unknown } }>)
      .filter(t => t.function?.name)
      .map(t => ({ name: t.function!.name, description: t.function!.description, input_schema: t.function!.parameters ?? { type: 'object', properties: {} } }));
    const choice = request.tool_choice as string | { function?: { name?: string } } | undefined;
    if (choice === 'required') body.tool_choice = { type: 'any' };
    else if (choice === 'none') body.tool_choice = { type: 'none' };
    else if (choice && typeof choice === 'object' && choice.function?.name) body.tool_choice = { type: 'tool', name: choice.function.name };
  }
  return body;
}

const FINISH: Record<string, string> = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter' };

/** A Messages answer as a chat completion (text, tool calls, usage). */
export function fromAnthropicResponse(data: any): CompletionResponse {
  const blocks: any[] = Array.isArray(data?.content) ? data.content : [];
  const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
  const toolCalls = blocks
    .filter(b => b.type === 'tool_use')
    .map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const input = data?.usage?.input_tokens ?? 0;
  const output = data?.usage?.output_tokens ?? 0;
  const message: CompletionResponse['choices'][number]['message'] & { tool_calls?: unknown[] } = { role: 'assistant', content: text };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: data?.id || `msg_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: data?.model || '',
    choices: [{ index: 0, message, finish_reason: FINISH[data?.stop_reason] || 'stop' }],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  };
}

export class AnthropicProvider implements Provider {
  name = 'Anthropic';
  capabilities: Capability[] = ['chat'];
  defaultModel: string;
  private apiKey: string;

  constructor(apiKey: string = process.env.ANTHROPIC_API_KEY || '', model: string = config.DEFAULT_MODELS.ANTHROPIC) {
    this.apiKey = apiKey;
    this.defaultModel = model;
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

  private headers(): Record<string, string> {
    return { 'x-api-key': this.apiKey, 'anthropic-version': VERSION, 'content-type': 'application/json' };
  }

  async getModels(): Promise<ModelDetail[]> {
    if (!this.apiKey) return [];
    try {
      const response = await fetch(`${API}/models?limit=100`, { headers: this.headers() });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { data?: Array<{ id: string; display_name?: string }> };
      return (body.data ?? []).map(m => ({ id: m.id, name: m.display_name || m.id }));
    } catch (error) {
      console.error('[Anthropic] Failed to list models:', error instanceof Error ? error.message : error);
      return [{ id: this.defaultModel, name: this.defaultModel }];
    }
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    const response = await fetch(`${API}/messages`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body) });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const error = new Error(`Anthropic ${response.status}: ${detail.slice(0, 300)}`) as Error & { status?: number; response?: { status: number } };
      // The router reads status / response.status to tell client errors from provider failures.
      error.status = response.status;
      error.response = { status: response.status };
      throw error;
    }
    return response;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = request.model && request.model !== 'auto' ? request.model : this.defaultModel;
    const response = await this.post(toAnthropicRequest(request, model));
    return fromAnthropicResponse(await response.json());
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const model = request.model && request.model !== 'auto' ? request.model : this.defaultModel;
    const response = await this.post({ ...toAnthropicRequest(request, model), stream: true });
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    const created = Math.floor(Date.now() / 1000);
    let id = `msg_${Date.now()}`;
    let inputTokens = 0;
    /** Content block index → tool call index, for streamed tool arguments. */
    const toolIndex = new Map<number, number>();
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: StreamChunk['usage']): StreamChunk => ({
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: delta as StreamChunk['choices'][number]['delta'], finish_reason: finish }],
      ...(usage ? { usage } : {}),
    });

    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        let event: any;
        try {
          event = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (event.type === 'message_start') {
          id = event.message?.id || id;
          inputTokens = event.message?.usage?.input_tokens ?? 0;
          yield chunk({ role: 'assistant', content: '' });
        } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          const index = toolIndex.size;
          toolIndex.set(event.index, index);
          yield chunk({ tool_calls: [{ index, id: event.content_block.id, type: 'function', function: { name: event.content_block.name, arguments: '' } }] });
        } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          yield chunk({ content: event.delta.text });
        } else if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
          const index = toolIndex.get(event.index);
          if (index !== undefined) yield chunk({ tool_calls: [{ index, function: { arguments: event.delta.partial_json } }] });
        } else if (event.type === 'message_delta') {
          const output = event.usage?.output_tokens ?? 0;
          yield chunk({}, FINISH[event.delta?.stop_reason] || 'stop', { prompt_tokens: inputTokens, completion_tokens: output, total_tokens: inputTokens + output });
        } else if (event.type === 'error') {
          throw new Error(`Anthropic stream error: ${event.error?.message || 'unknown'}`);
        }
      }
    }
  }
}
