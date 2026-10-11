import { randomBytes } from 'crypto';
import type { ChatMessage, CompletionRequest, CompletionResponse, StreamChunk } from './types';

/**
 * Anthropic's Messages API (POST /v1/messages) on top of Leyline's OpenAI-style routing, so Claude Code (and
 * other Anthropic clients) can point ANTHROPIC_BASE_URL at Leyline. Requests are translated to OpenAI chat
 * completions; responses and stream events back. Covers what coding agents use: system prompts, text, images,
 * tool definitions, tool_use / tool_result, tool_choice, stop sequences, streaming. Thinking blocks and cache
 * hints are dropped (the upstream model may not be Claude).
 */

type Block = { type: string; [k: string]: unknown };
type AnthropicMessage = { role: 'user' | 'assistant'; content: string | Block[] };
export type AnthropicRequest = {
  model: string;
  messages: AnthropicMessage[];
  system?: string | Block[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Array<{ name: string; description?: string; input_schema?: unknown; type?: string }>;
  tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none'; name?: string };
  [k: string]: unknown;
};

const text = (blocks: string | Block[] | undefined): string =>
  typeof blocks === 'string' ? blocks : (blocks ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n');

/** A tool_result's content as text (it may be a string or blocks). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b: Block) => (b.type === 'text' ? String(b.text ?? '') : b.type === 'image' ? '[image]' : '')).join('\n');
  return content === undefined ? '' : JSON.stringify(content);
}

export function anthropicToOpenAI(req: AnthropicRequest): CompletionRequest {
  if (!req || typeof req.model !== 'string' || !Array.isArray(req.messages)) throw new Error('model and messages are required');
  const messages: ChatMessage[] = [];
  const system = text(req.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({
        id: String(b.id),
        type: 'function',
        function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
      }));
      const t = text(m.content);
      messages.push({ role: 'assistant', content: t || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn: tool results become tool messages (in order, before the rest of the turn).
    for (const b of m.content.filter((x) => x.type === 'tool_result')) {
      messages.push({ role: 'tool', tool_call_id: String(b.tool_use_id), content: (b.is_error ? 'Error: ' : '') + resultText(b.content) });
    }
    const parts = m.content.filter((b) => b.type === 'text' || b.type === 'image').map((b) => {
      if (b.type === 'text') return { type: 'text', text: String(b.text ?? '') };
      const src = b.source as { type?: string; media_type?: string; data?: string; url?: string } | undefined;
      const url = src?.type === 'base64' ? `data:${src.media_type};base64,${src.data}` : String(src?.url ?? '');
      return { type: 'image_url', image_url: { url } };
    });
    if (parts.length === 0) continue;
    const onlyText = parts.every((p) => p.type === 'text');
    messages.push({ role: 'user', content: onlyText ? parts.map((p) => (p as { text: string }).text).join('\n') : (parts as unknown as string) });
  }
  const out: CompletionRequest = { model: req.model, messages, stream: req.stream === true };
  if (req.max_tokens) out.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.stop_sequences?.length) out.stop = req.stop_sequences;
  const tools = (req.tools ?? []).filter((t) => t.name && (!t.type || t.type === 'custom'));
  if (tools.length) {
    out.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.input_schema ?? { type: 'object', properties: {} } } }));
    const c = req.tool_choice;
    if (c?.type === 'any') out.tool_choice = 'required';
    else if (c?.type === 'tool' && c.name) out.tool_choice = { type: 'function', function: { name: c.name } };
    else if (c?.type === 'none') out.tool_choice = 'none';
  }
  return out;
}

const STOP: Record<string, string> = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'end_turn' };

function parseArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args ?? {};
  try {
    return JSON.parse(args || '{}');
  } catch {
    return { _raw: args };
  }
}

export function openAIToAnthropic(res: CompletionResponse, model: string): Record<string, unknown> {
  const choice = (res.choices?.[0] ?? {}) as { message?: { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string };
  const content: Block[] = [];
  if (choice.message?.content) content.push({ type: 'text', text: choice.message.content });
  for (const c of choice.message?.tool_calls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) });
  return {
    id: `msg_${randomBytes(12).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: (choice.message?.tool_calls?.length ? 'tool_use' : STOP[choice.finish_reason ?? 'stop']) ?? 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: res.usage?.prompt_tokens ?? 0, output_tokens: res.usage?.completion_tokens ?? 0 },
  };
}

type Event = { event: string; data: Record<string, unknown> };

/**
 * OpenAI stream chunks in, Anthropic stream events out: message_start, then for each text run or tool call a
 * content block (start, deltas, stop), then message_delta (stop reason, usage) and message_stop.
 */
export class AnthropicStream {
  private started = false;
  private block = -1;
  private open: { kind: 'text' } | { kind: 'tool'; index: number } | null = null;
  private readonly toolBlocks = new Map<number, number>();
  private finish: string | null = null;
  private usage = { input_tokens: 0, output_tokens: 0 };
  private sawTool = false;
  /** Characters of text and tool input streamed, to estimate output tokens when the provider sends no usage. */
  chars = 0;

  constructor(private readonly model: string, private readonly id = `msg_${randomBytes(12).toString('hex')}`) {}

  private start(): Event[] {
    if (this.started) return [];
    this.started = true;
    return [{ event: 'message_start', data: { type: 'message_start', message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } } }];
  }

  private close(): Event[] {
    if (!this.open) return [];
    this.open = null;
    return [{ event: 'content_block_stop', data: { type: 'content_block_stop', index: this.block } }];
  }

  push(chunk: StreamChunk): Event[] {
    const out: Event[] = this.start();
    if (chunk.usage) this.usage = { input_tokens: chunk.usage.prompt_tokens ?? 0, output_tokens: chunk.usage.completion_tokens ?? 0 };
    const choice = (chunk.choices?.[0] ?? {}) as { delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null };
    const delta = choice.delta ?? {};
    if (delta.content) {
      this.chars += delta.content.length;
      if (this.open?.kind !== 'text') {
        out.push(...this.close());
        this.block++;
        this.open = { kind: 'text' };
        out.push({ event: 'content_block_start', data: { type: 'content_block_start', index: this.block, content_block: { type: 'text', text: '' } } });
      }
      out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: this.block, delta: { type: 'text_delta', text: delta.content } } });
    }
    for (const call of delta.tool_calls ?? []) {
      const i = call.index ?? 0;
      if (!this.toolBlocks.has(i)) {
        out.push(...this.close());
        this.block++;
        this.toolBlocks.set(i, this.block);
        this.open = { kind: 'tool', index: i };
        this.sawTool = true;
        out.push({ event: 'content_block_start', data: { type: 'content_block_start', index: this.block, content_block: { type: 'tool_use', id: call.id ?? `toolu_${randomBytes(8).toString('hex')}`, name: call.function?.name ?? '', input: {} } } });
      }
      if (call.function?.arguments) {
        this.chars += call.function.arguments.length;
        out.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: this.toolBlocks.get(i)!, delta: { type: 'input_json_delta', partial_json: call.function.arguments } } });
      }
    }
    if (choice.finish_reason) this.finish = choice.finish_reason;
    return out;
  }

  end(): Event[] {
    const out: Event[] = [...this.start(), ...this.close()];
    const stop = this.sawTool ? 'tool_use' : STOP[this.finish ?? 'stop'] ?? 'end_turn';
    out.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: this.usage.output_tokens } } });
    out.push({ event: 'message_stop', data: { type: 'message_stop' } });
    return out;
  }

  get tokens(): { prompt_tokens: number; completion_tokens: number } {
    return { prompt_tokens: this.usage.input_tokens, completion_tokens: this.usage.output_tokens };
  }
}

/** A rough token count (four characters a token) for /v1/messages/count_tokens. */
export function estimateTokens(req: AnthropicRequest): number {
  const chars = JSON.stringify({ s: req.system ?? '', m: req.messages ?? [], t: req.tools ?? [] }).length;
  return Math.ceil(chars / 4);
}

/** An Anthropic-shaped error body. */
export function anthropicError(status: number, message: string): { type: 'error'; error: { type: string; message: string } } {
  const type = status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 429 ? 'rate_limit_error' : status === 404 ? 'not_found_error' : status >= 500 ? 'api_error' : 'invalid_request_error';
  return { type: 'error', error: { type, message } };
}
