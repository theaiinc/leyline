import { createHash, randomBytes } from 'crypto';
import type { ChatMessage, CompletionRequest, CompletionResponse, StreamChunk } from './types';
import type { ContentPart } from './content';

/**
 * OpenAI's Responses API (POST /v1/responses) on top of Valefront's chat routing, so OpenAI Codex CLI (which speaks
 * only the Responses API: `wire_api = "chat"` was removed from Codex) and other Responses clients can point at
 * Valefront. Mirrors /v1/messages (anthropic.ts): the request is translated to a chat completion, routed, billed and
 * recorded like /v1/chat/completions, and the result (or stream) translated back.
 *
 * Stateless: nothing is stored, so `previous_response_id`, `conversation` and `item_reference` inputs are refused
 * with a 400 that says to send the whole conversation in `input` (what Codex does: it sends `store: false` and the
 * full history every turn). Covered: instructions, input messages (text, images, files), function tools, custom
 * (freeform) tools, namespaced tools, function_call / function_call_output round trips, tool_choice, text.format,
 * max_output_tokens, reasoning effort, streaming events and usage. Hosted tools (web_search, file_search, …) are not
 * offered here and are left out of what the model sees.
 */

export type ResponsesRequest = {
  model?: unknown;
  input?: unknown;
  instructions?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  parallel_tool_calls?: unknown;
  stream?: unknown;
  store?: unknown;
  previous_response_id?: unknown;
  conversation?: unknown;
  background?: unknown;
  max_output_tokens?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  reasoning?: unknown;
  text?: unknown;
  user?: unknown;
  safety_identifier?: unknown;
  metadata?: unknown;
  [k: string]: unknown;
};

/** A request Valefront can't serve as sent (a 400 with an OpenAI error code and the offending parameter). */
export class ResponsesRequestError extends Error {
  constructor(message: string, readonly code = 'invalid_request_error', readonly param: string | null = null) {
    super(message);
  }
}

/** A chat function exposed to the model, and what it stands for in the Responses API. */
type ToolInfo = { kind: 'function' | 'custom'; name: string; namespace?: string };
export type ToolMap = Map<string, ToolInfo>;

type Item = Record<string, unknown>;
const isObj = (v: unknown): v is Item => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const FUNCTION_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * The chat function name for a Responses tool. Namespaced tools (Codex's multi_agent_v1, MCP servers) become
 * `namespace__name`; anything that isn't a valid chat function name (64 characters of [a-zA-Z0-9_-]) gets a stable,
 * hash-suffixed name, so the same tool maps to the same name in tools and in the conversation history.
 */
export function chatToolName(name: string, namespace?: string): string {
  const plain = namespace ? `${namespace}__${name}` : name;
  if (FUNCTION_NAME.test(plain)) return plain;
  const hash = createHash('sha256').update(plain).digest('hex').slice(0, 8);
  return `${plain.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 55)}_${hash}`;
}

const id = (prefix: string) => `${prefix}_${randomBytes(12).toString('hex')}`;

/** A content list's text (input_text, output_text, text, refusal parts). */
function partsText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(isObj).map((p) => str(p.text) || str(p.refusal)).filter(Boolean).join('\n');
}

/** Responses content parts as chat content: a string when it's all text, else chat parts (images, files). */
function chatContent(content: unknown, param: string): string | ContentPart[] {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: ContentPart[] = [];
  for (const p of content.filter(isObj)) {
    const type = str(p.type);
    if (type === 'input_text' || type === 'output_text' || type === 'text') parts.push({ type: 'text', text: str(p.text) });
    else if (type === 'refusal') parts.push({ type: 'text', text: str(p.refusal) });
    else if (type === 'input_image') {
      const url = typeof p.image_url === 'string' ? p.image_url : isObj(p.image_url) ? str(p.image_url.url) : '';
      if (!url) throw new ResponsesRequestError('Images must be sent as image_url (a URL or a data: URL); Valefront has no Files API for file_id.', 'unsupported_parameter', param);
      parts.push({ type: 'image_url', image_url: { url, ...(typeof p.detail === 'string' ? { detail: p.detail } : {}) } });
    } else if (type === 'input_file') {
      if (typeof p.file_data !== 'string') throw new ResponsesRequestError('Files must be sent inline as file_data; Valefront has no Files API for file_id or file_url.', 'unsupported_parameter', param);
      parts.push({ type: 'file', file: { file_data: p.file_data, ...(typeof p.filename === 'string' ? { filename: p.filename } : {}) } });
    }
    // Other parts (audio, unknown types) have no chat equivalent every provider takes: left out.
  }
  return parts.every((p) => p.type === 'text') ? parts.map((p) => (p as { text: string }).text).join('\n') : parts;
}

/** A function_call_output's output: text for the tool message, and any images to show the model after it. */
function toolOutput(output: unknown): { text: string; images: ContentPart[] } {
  if (typeof output === 'string') return { text: output, images: [] };
  if (!Array.isArray(output)) return { text: output === undefined || output === null ? '' : JSON.stringify(output), images: [] };
  const texts: string[] = [];
  const images: ContentPart[] = [];
  for (const p of output.filter(isObj)) {
    if (typeof p.text === 'string') texts.push(p.text);
    else if (p.type === 'input_image') {
      const url = typeof p.image_url === 'string' ? p.image_url : '';
      if (url) images.push({ type: 'image_url', image_url: { url, ...(typeof p.detail === 'string' ? { detail: p.detail } : {}) } });
      else texts.push('[image]');
    }
  }
  return { text: texts.join('\n'), images };
}

function chatTool(tool: Item, namespace: string | undefined, map: ToolMap, out: unknown[]): void {
  const type = str(tool.type);
  const name = str(tool.name);
  if (!name) return;
  const chatName = chatToolName(name, namespace);
  const description = str(tool.description);
  if (type === 'function') {
    map.set(chatName, { kind: 'function', name, ...(namespace ? { namespace } : {}) });
    out.push({ type: 'function', function: { name: chatName, ...(description ? { description } : {}), parameters: isObj(tool.parameters) ? tool.parameters : { type: 'object', properties: {} }, ...(tool.strict === true ? { strict: true } : {}) } });
  } else if (type === 'custom') {
    // A freeform tool (raw text input, e.g. a patch): a function taking that text as its one argument.
    const format = isObj(tool.format) ? tool.format : null;
    const grammar = format && format.type === 'grammar' && typeof format.definition === 'string'
      ? `\nThe input must follow this ${str(format.syntax) || 'grammar'} grammar:\n${format.definition}` : '';
    map.set(chatName, { kind: 'custom', name, ...(namespace ? { namespace } : {}) });
    out.push({ type: 'function', function: {
      name: chatName,
      ...(description ? { description } : {}),
      parameters: { type: 'object', properties: { input: { type: 'string', description: `The raw input for this tool, as text.${grammar}` } }, required: ['input'], additionalProperties: false },
    } });
  }
  // Hosted tools (web_search, file_search, code_interpreter, image_generation, mcp, …) aren't offered here.
}

function chatToolChoice(choice: unknown, map: ToolMap): unknown {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
  if (isObj(choice) && (choice.type === 'function' || choice.type === 'custom') && typeof choice.name === 'string') {
    const name = chatToolName(choice.name, typeof choice.namespace === 'string' ? choice.namespace : undefined);
    if (!map.has(name)) throw new ResponsesRequestError(`tool_choice names "${choice.name}", which is not in tools.`, 'invalid_value', 'tool_choice');
    return { type: 'function', function: { name } };
  }
  // allowed_tools, hosted tools: let the model choose.
  return undefined;
}

/** The Responses request as a chat completion request, and the map of chat function names back to its tools. */
export function responsesToChat(req: ResponsesRequest): { request: CompletionRequest; tools: ToolMap } {
  if (!isObj(req)) throw new ResponsesRequestError('The request body must be a JSON object.');
  if (typeof req.model !== 'string' || !req.model) throw new ResponsesRequestError('model is required.', 'missing_required_parameter', 'model');
  if (req.previous_response_id !== undefined && req.previous_response_id !== null) {
    throw new ResponsesRequestError(
      'Valefront does not store responses, so previous_response_id can\'t be used: send the whole conversation in input (with store: false, as Codex does).',
      'previous_response_not_supported', 'previous_response_id');
  }
  if (req.conversation !== undefined && req.conversation !== null) {
    throw new ResponsesRequestError('Valefront does not store conversations: send the whole conversation in input.', 'conversation_not_supported', 'conversation');
  }
  if (req.background === true) throw new ResponsesRequestError('Background responses are not supported; send the request without background.', 'unsupported_parameter', 'background');

  const tools: ToolMap = new Map();
  const chatTools: unknown[] = [];
  if (req.tools !== undefined && req.tools !== null && !Array.isArray(req.tools)) throw new ResponsesRequestError('tools must be a list.', 'invalid_type', 'tools');
  for (const tool of (Array.isArray(req.tools) ? req.tools : []).filter(isObj)) {
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
      for (const inner of tool.tools.filter(isObj)) chatTool(inner, str(tool.name) || undefined, tools, chatTools);
    } else chatTool(tool, undefined, tools, chatTools);
  }

  const messages: ChatMessage[] = [];
  const instructions = typeof req.instructions === 'string' ? req.instructions : partsText(req.instructions);
  if (instructions) messages.push({ role: 'system', content: instructions });

  const input = typeof req.input === 'string' ? [{ type: 'message', role: 'user', content: req.input }] : req.input;
  if (input !== undefined && !Array.isArray(input)) throw new ResponsesRequestError('input must be a string or a list of items.', 'invalid_type', 'input');
  const calls = new Set<string>();
  // Images a tool returned: shown to the model as a user message once the run of tool messages ends.
  let pendingImages: ContentPart[] = [];
  const flushImages = () => {
    if (!pendingImages.length) return;
    messages.push({ role: 'user', content: [{ type: 'text', text: 'The images the tool calls above returned:' }, ...pendingImages] });
    pendingImages = [];
  };
  const addCall = (call: { id: string; name: string; arguments: string }) => {
    flushImages();
    calls.add(call.id);
    const last = messages[messages.length - 1];
    const toolCall = { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } };
    if (last?.role === 'assistant') last.tool_calls = [...(last.tool_calls ?? []), toolCall];
    else messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] });
  };
  const addOutput = (callId: string, output: unknown) => {
    const { text, images } = toolOutput(output);
    if (calls.has(callId)) messages.push({ role: 'tool', tool_call_id: callId, content: text });
    // An output with no call before it (the call was dropped or never sent): context for the model, not a tool message.
    else messages.push({ role: 'user', content: `Output of tool call ${callId}:\n${text}` });
    pendingImages.push(...images);
  };

  for (const [i, raw] of (input ?? []).entries()) {
    if (typeof raw === 'string') {
      flushImages();
      messages.push({ role: 'user', content: raw });
      continue;
    }
    if (!isObj(raw)) continue;
    const type = str(raw.type) || (typeof raw.role === 'string' ? 'message' : '');
    const param = `input[${i}]`;
    switch (type) {
      case 'message': {
        flushImages();
        const role = raw.role === 'developer' || raw.role === 'system' ? 'system' : raw.role === 'assistant' ? 'assistant' : 'user';
        const content = chatContent(raw.content, `${param}.content`);
        if (role === 'assistant') {
          const text = typeof content === 'string' ? content : partsText(raw.content);
          messages.push({ role: 'assistant', content: text });
        } else messages.push({ role, content });
        break;
      }
      case 'function_call': {
        const callId = str(raw.call_id) || str(raw.id);
        addCall({ id: callId, name: chatToolName(str(raw.name), typeof raw.namespace === 'string' ? raw.namespace : undefined), arguments: typeof raw.arguments === 'string' ? raw.arguments : JSON.stringify(raw.arguments ?? {}) });
        break;
      }
      case 'custom_tool_call': {
        addCall({ id: str(raw.call_id) || str(raw.id), name: chatToolName(str(raw.name), typeof raw.namespace === 'string' ? raw.namespace : undefined), arguments: JSON.stringify({ input: str(raw.input) }) });
        break;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
        addOutput(str(raw.call_id), raw.output);
        break;
      case 'item_reference':
        throw new ResponsesRequestError('Valefront does not store responses, so item_reference inputs can\'t be used: send the items themselves.', 'item_reference_not_supported', param);
      default:
        // Reasoning, compaction and hosted-tool items (web_search_call, …) carry nothing a chat model can take.
        break;
    }
  }
  flushImages();

  const out: CompletionRequest = { model: req.model, messages, stream: req.stream === true };
  if (chatTools.length) {
    out.tools = chatTools;
    const choice = chatToolChoice(req.tool_choice, tools);
    if (choice !== undefined) out.tool_choice = choice;
    if (typeof req.parallel_tool_calls === 'boolean') out.parallel_tool_calls = req.parallel_tool_calls;
  }
  if (typeof req.max_output_tokens === 'number' && req.max_output_tokens > 0) out.max_tokens = req.max_output_tokens;
  if (typeof req.temperature === 'number') out.temperature = req.temperature;
  if (typeof req.top_p === 'number') out.top_p = req.top_p;
  const user = typeof req.safety_identifier === 'string' ? req.safety_identifier : typeof req.user === 'string' ? req.user : '';
  if (user) out.user = user;
  const effort = isObj(req.reasoning) ? req.reasoning.effort : undefined;
  if (effort === 'low' || effort === 'medium' || effort === 'high') out.reasoning_effort = effort;
  const format = isObj(req.text) && isObj(req.text.format) ? req.text.format : null;
  if (format?.type === 'json_schema') {
    out.response_format = { type: 'json_schema', json_schema: { name: str(format.name) || 'response', schema: format.schema ?? {}, ...(typeof format.strict === 'boolean' ? { strict: format.strict } : {}), ...(typeof format.description === 'string' ? { description: format.description } : {}) } };
  } else if (format?.type === 'json_object') out.response_format = { type: 'json_object' };
  return { request: out, tools };
}

// ── results ───────────────────────────────────────────────────────────────────────────────────────────

type ChatUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cached_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } };

/** Usage in the Responses shape (every field Codex requires present). */
export function responsesUsage(usage: ChatUsage | undefined) {
  const input = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.cached_tokens ?? 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0 },
    total_tokens: input + output,
  };
}

/** The request settings a Response echoes back. */
export type ResponseEcho = { model: string; request: ResponsesRequest; id?: string; createdAt?: number };

function baseResponse(echo: ResponseEcho, id: string, createdAt: number) {
  const r = echo.request;
  return {
    id,
    object: 'response',
    created_at: createdAt,
    model: echo.model,
    instructions: typeof r.instructions === 'string' ? r.instructions : null,
    max_output_tokens: typeof r.max_output_tokens === 'number' ? r.max_output_tokens : null,
    parallel_tool_calls: r.parallel_tool_calls !== false,
    previous_response_id: null,
    reasoning: { effort: isObj(r.reasoning) && typeof r.reasoning.effort === 'string' ? r.reasoning.effort : null, summary: null },
    store: false,
    temperature: typeof r.temperature === 'number' ? r.temperature : null,
    text: { format: isObj(r.text) && isObj(r.text.format) ? r.text.format : { type: 'text' } },
    tool_choice: r.tool_choice ?? 'auto',
    tools: Array.isArray(r.tools) ? r.tools : [],
    top_p: typeof r.top_p === 'number' ? r.top_p : null,
    truncation: 'disabled',
    user: typeof r.user === 'string' ? r.user : null,
    metadata: isObj(r.metadata) ? r.metadata : {},
  };
}

/** How a finished chat completion ended, as a Response status. */
function statusOf(finish: string | null | undefined): { status: 'completed' | 'incomplete'; incomplete_details: { reason: string } | null } {
  if (finish === 'length') return { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } };
  if (finish === 'content_filter') return { status: 'incomplete', incomplete_details: { reason: 'content_filter' } };
  return { status: 'completed', incomplete_details: null };
}

type ChatToolCall = { id?: string; function?: { name?: string; arguments?: string } };

function callItem(call: { id: string; name: string; arguments: string }, tools: ToolMap, status: 'completed' | 'in_progress' = 'completed'): Item {
  const tool = tools.get(call.name);
  const name = tool?.name ?? call.name;
  const namespace = tool?.namespace ? { namespace: tool.namespace } : {};
  if (tool?.kind === 'custom') {
    let input = call.arguments;
    try {
      const parsed = JSON.parse(call.arguments || '{}');
      if (isObj(parsed) && typeof parsed.input === 'string') input = parsed.input;
    } catch {
      // Not the JSON wrapper: the model sent the raw input itself.
    }
    return { id: `ctc_${call.id.replace(/^call_/, '')}`, type: 'custom_tool_call', status, call_id: call.id, name, ...namespace, input };
  }
  return { id: `fc_${call.id.replace(/^call_/, '')}`, type: 'function_call', status, call_id: call.id, name, ...namespace, arguments: call.arguments };
}

/** A chat completion as a Response object (non-streaming). */
export function chatToResponse(res: CompletionResponse, echo: ResponseEcho, tools: ToolMap, usage?: ChatUsage): Record<string, unknown> {
  const choice = (res.choices?.[0] ?? {}) as { message?: { content?: string | null; reasoning_content?: unknown; tool_calls?: ChatToolCall[] }; finish_reason?: string };
  const output: Item[] = [];
  const text = typeof choice.message?.content === 'string' ? choice.message.content : '';
  const reasoning = typeof choice.message?.reasoning_content === 'string' ? choice.message.reasoning_content : '';
  // BytePlus promotes reasoning to content when a model answers with reasoning only: don't show it twice.
  if (reasoning && reasoning !== text) output.push({ id: id('rs'), type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: reasoning }] });
  if (text) output.push({ id: id('msg'), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });
  for (const call of choice.message?.tool_calls ?? []) {
    output.push(callItem({ id: call.id || id('call'), name: call.function?.name ?? '', arguments: call.function?.arguments ?? '' }, tools));
  }
  return {
    ...baseResponse(echo, echo.id ?? id('resp'), echo.createdAt ?? Math.floor(Date.now() / 1000)),
    ...statusOf(choice.finish_reason),
    error: null,
    output,
    usage: responsesUsage(usage ?? res.usage),
  };
}

export type ResponsesEvent = { type: string; [k: string]: unknown };

type Open =
  | { kind: 'message'; index: number; id: string; text: string }
  | { kind: 'reasoning'; index: number; id: string; text: string };

/**
 * Chat stream chunks in, Responses stream events out: response.created and response.in_progress; for each run of
 * reasoning or text an output item (added, deltas, done); each tool call an output item (added, argument deltas,
 * done at the end of the stream); then response.completed (or response.incomplete) with the whole response and its
 * usage. response.failed when the provider fails partway.
 */
export class ResponsesStream {
  readonly id: string;
  private readonly createdAt = Math.floor(Date.now() / 1000);
  private seq = 0;
  private started = false;
  private nextIndex = 0;
  private open: Open | null = null;
  private readonly output: Array<{ index: number; item: Item }> = [];
  private readonly calls = new Map<number, { index: number; id: string; itemId: string; name: string; arguments: string }>();
  private finish: string | null = null;
  private usage: ChatUsage | undefined;
  /** Characters of text and tool arguments streamed, to estimate output tokens when the provider sends no usage. */
  chars = 0;

  constructor(private readonly echo: ResponseEcho, private readonly tools: ToolMap) {
    this.id = echo.id ?? id('resp');
  }

  private ev(type: string, body: Record<string, unknown>): ResponsesEvent {
    return { type, sequence_number: this.seq++, ...body };
  }

  private snapshot(extra: Record<string, unknown>): Record<string, unknown> {
    return { ...baseResponse(this.echo, this.id, this.createdAt), ...extra };
  }

  /** response.created and response.in_progress (once). */
  start(): ResponsesEvent[] {
    if (this.started) return [];
    this.started = true;
    const response = this.snapshot({ status: 'in_progress', incomplete_details: null, error: null, output: [], usage: null });
    return [this.ev('response.created', { response }), this.ev('response.in_progress', { response })];
  }

  private close(): ResponsesEvent[] {
    const open = this.open;
    if (!open) return [];
    this.open = null;
    if (open.kind === 'message') {
      const part = { type: 'output_text', text: open.text, annotations: [] };
      const item = { id: open.id, type: 'message', status: 'completed', role: 'assistant', content: [part] };
      this.output.push({ index: open.index, item });
      return [
        this.ev('response.output_text.done', { item_id: open.id, output_index: open.index, content_index: 0, text: open.text }),
        this.ev('response.content_part.done', { item_id: open.id, output_index: open.index, content_index: 0, part }),
        this.ev('response.output_item.done', { output_index: open.index, item }),
      ];
    }
    const item = { id: open.id, type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: open.text }] };
    this.output.push({ index: open.index, item });
    return [
      this.ev('response.reasoning_text.done', { item_id: open.id, output_index: open.index, content_index: 0, text: open.text }),
      this.ev('response.output_item.done', { output_index: open.index, item }),
    ];
  }

  private openItem(kind: Open['kind']): ResponsesEvent[] {
    if (this.open?.kind === kind) return [];
    const out = this.close();
    const index = this.nextIndex++;
    if (kind === 'message') {
      const itemId = id('msg');
      this.open = { kind, index, id: itemId, text: '' };
      out.push(this.ev('response.output_item.added', { output_index: index, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } }));
      out.push(this.ev('response.content_part.added', { item_id: itemId, output_index: index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }));
    } else {
      const itemId = id('rs');
      this.open = { kind, index, id: itemId, text: '' };
      out.push(this.ev('response.output_item.added', { output_index: index, item: { id: itemId, type: 'reasoning', summary: [] } }));
    }
    return out;
  }

  push(chunk: StreamChunk): ResponsesEvent[] {
    const out: ResponsesEvent[] = this.start();
    if (chunk.usage) this.usage = chunk.usage as ChatUsage;
    const choice = (chunk.choices?.[0] ?? {}) as { delta?: { content?: string | null; reasoning_content?: unknown; reasoning?: unknown; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null };
    const delta = choice.delta ?? {};
    const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
    if (reasoning) {
      out.push(...this.openItem('reasoning'));
      const open = this.open as Open;
      open.text += reasoning;
      out.push(this.ev('response.reasoning_text.delta', { item_id: open.id, output_index: open.index, content_index: 0, delta: reasoning }));
    }
    if (delta.content) {
      this.chars += delta.content.length;
      out.push(...this.openItem('message'));
      const open = this.open as Open;
      open.text += delta.content;
      out.push(this.ev('response.output_text.delta', { item_id: open.id, output_index: open.index, content_index: 0, delta: delta.content }));
    }
    for (const call of delta.tool_calls ?? []) {
      const i = call.index ?? 0;
      let state = this.calls.get(i);
      if (!state) {
        out.push(...this.close());
        const callId = call.id || id('call');
        state = { index: this.nextIndex++, id: callId, itemId: '', name: call.function?.name ?? '', arguments: '' };
        const item = callItem({ id: callId, name: state.name, arguments: '' }, this.tools, 'in_progress');
        state.itemId = String(item.id);
        if (item.type === 'custom_tool_call') item.input = '';
        this.calls.set(i, state);
        out.push(this.ev('response.output_item.added', { output_index: state.index, item }));
      } else if (call.function?.name && !state.name) state.name = call.function.name;
      const args = call.function?.arguments;
      if (args) {
        this.chars += args.length;
        state.arguments += args;
        // A custom tool's input is the "input" field of the JSON the model writes: sent whole when the call is done.
        if (this.tools.get(state.name)?.kind !== 'custom') {
          out.push(this.ev('response.function_call_arguments.delta', { item_id: state.itemId, output_index: state.index, delta: args }));
        }
      }
    }
    if (choice.finish_reason) this.finish = choice.finish_reason;
    return out;
  }

  /** The usage the stream reported (prompt/completion tokens), if any. */
  get reportedUsage(): ChatUsage | undefined {
    return this.usage;
  }

  /** Closes every open item and finishes the response; `usage` overrides what the stream reported (an estimate). */
  end(usage?: ChatUsage): ResponsesEvent[] {
    const out: ResponsesEvent[] = [...this.start(), ...this.close()];
    for (const state of [...this.calls.values()].sort((a, b) => a.index - b.index)) {
      const item = callItem({ id: state.id, name: state.name, arguments: state.arguments }, this.tools);
      if (item.type === 'function_call') {
        out.push(this.ev('response.function_call_arguments.done', { item_id: state.itemId, output_index: state.index, arguments: state.arguments }));
      } else {
        out.push(this.ev('response.custom_tool_call_input.delta', { item_id: state.itemId, output_index: state.index, call_id: state.id, delta: item.input }));
        out.push(this.ev('response.custom_tool_call_input.done', { item_id: state.itemId, output_index: state.index, call_id: state.id, input: item.input }));
      }
      out.push(this.ev('response.output_item.done', { output_index: state.index, item }));
      this.output.push({ index: state.index, item });
    }
    const { status, incomplete_details } = statusOf(this.finish);
    const response = this.snapshot({
      status,
      incomplete_details,
      error: null,
      output: this.output.sort((a, b) => a.index - b.index).map((o) => o.item),
      usage: responsesUsage(usage ?? this.usage),
    });
    out.push(this.ev(status === 'completed' ? 'response.completed' : 'response.incomplete', { response }));
    return out;
  }

  /** The provider failed partway: close nothing more, report the failure. */
  fail(message: string, code = 'server_error'): ResponsesEvent[] {
    const out: ResponsesEvent[] = this.start();
    out.push(this.ev('response.failed', { response: this.snapshot({ status: 'failed', incomplete_details: null, error: { code, message }, output: this.output.map((o) => o.item), usage: null }) }));
    return out;
  }
}

/** One event as SSE (the event name and its JSON). */
export function sse(event: ResponsesEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
