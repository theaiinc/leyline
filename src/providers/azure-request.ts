import type { ChatMessage, CompletionRequest } from '../core/types';
import { ensureMessageArray } from '../core/normalize-request';

const AZURE_CHAT_COMPLETION_FIELDS = new Set([
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'presence_penalty',
  'frequency_penalty',
  'response_format',
  'seed',
  'stop',
  'user',
  'reasoning_effort',
  'logprobs',
  'top_logprobs',
  'n',
  'stream_options',
]);

/** Responses API / Cursor-only fields that Azure Chat Completions rejects. */
const CURSOR_RESPONSES_ONLY_FIELDS = new Set([
  'include',
  'input',
  'instructions',
  'previous_response_id',
  'truncation',
  'reasoning',
  'modalities',
  'audio',
  'text',
  'metadata',
  'store',
  'prompt',
  'prompt_cache_key',
]);

const AZURE_ALLOWED_FIELDS = AZURE_CHAT_COMPLETION_FIELDS;

export function sanitizeAzureMessages(messages: ChatMessage[] | unknown): ChatMessage[] {
  const source = ensureMessageArray(messages);
  const sanitized = source
    .map((message) => {
      const sanitizedMessage: ChatMessage = { role: message.role };

      if (message.tool_calls?.length) {
        sanitizedMessage.tool_calls = message.tool_calls;
        sanitizedMessage.content = message.content ?? null;
      } else if (message.role === 'tool') {
        if (!message.tool_call_id) return null;
        sanitizedMessage.tool_call_id = message.tool_call_id;
        sanitizedMessage.content = message.content ?? '';
        if (message.name) sanitizedMessage.name = message.name;
      } else if (typeof message.content === 'string') {
        sanitizedMessage.content = message.content.length > 0 ? message.content : ' ';
      } else if (message.content === null && message.role === 'assistant') {
        sanitizedMessage.content = '';
      } else {
        sanitizedMessage.content = typeof message.content === 'string'
          ? message.content
          : message.content == null
            ? ' '
            : JSON.stringify(message.content);
      }

      return sanitizedMessage;
    })
    .filter((message): message is ChatMessage => message !== null);

  if (sanitized.length === 0 && source.length > 0) {
    return source.map((message) => ({
      role: message.role,
      content: message.content ?? ' ',
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.name ? { name: message.name } : {}),
    }));
  }

  return sanitized;
}

type ToolRecord = Record<string, unknown>;

function isNonEmptyObject(value: unknown): value is ToolRecord {
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0;
}

function sanitizeAzureCustomFormat(format: unknown): ToolRecord | undefined {
  if (!format || typeof format !== 'object') return undefined;
  const record = format as ToolRecord;

  if (record.type === 'text') {
    return { type: 'text' };
  }

  if (record.type === 'grammar') {
    if (isNonEmptyObject(record.grammar)) {
      return { type: 'grammar', grammar: record.grammar };
    }
    // Cursor often sends { type: "grammar" } without grammar.syntax/definition.
    // Azure rejects that; text format keeps the custom tool usable.
    return { type: 'text' };
  }

  return record;
}

function sanitizeAzureCustomTool(record: ToolRecord): ToolRecord | null {
  const nested = record.custom;
  if (nested && typeof nested === 'object') {
    const custom = nested as ToolRecord;
    if (typeof custom.name !== 'string' || !custom.name) return null;
    const format = sanitizeAzureCustomFormat(custom.format);
    return {
      type: 'custom',
      custom: {
        name: custom.name,
        ...(typeof custom.description === 'string' ? { description: custom.description } : {}),
        ...(format ? { format } : {}),
      },
    };
  }

  // Cursor flat custom shape: { type: "custom", name: "apply_patch", description: "...", format: {...} }
  if (typeof record.name !== 'string' || !record.name) return null;
  const format = sanitizeAzureCustomFormat(record.format);
  return {
    type: 'custom',
    custom: {
      name: record.name,
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      ...(format ? { format } : {}),
    },
  };
}

function sanitizeAzureTool(tool: unknown): ToolRecord | null {
  if (!tool || typeof tool !== 'object') return null;
  const record = tool as ToolRecord;

  if (record.type === 'custom') {
    return sanitizeAzureCustomTool(record);
  }

  if (record.type !== 'function') return null;

  const nested = record.function;
  if (nested && typeof nested === 'object') {
    const fn = nested as ToolRecord;
    if (typeof fn.name !== 'string' || !fn.name) return null;
    return {
      type: 'function',
      function: {
        name: fn.name,
        ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
        ...(fn.parameters !== undefined
          ? { parameters: fn.parameters }
          : { parameters: { type: 'object', properties: {} } }),
        ...(fn.strict !== undefined ? { strict: fn.strict } : {}),
      },
    };
  }

  // Cursor / Responses API flat shape: { type, name, description, parameters }
  if (typeof record.name !== 'string' || !record.name) return null;
  return {
    type: 'function',
    function: {
      name: record.name,
      ...(typeof record.description === 'string' ? { description: record.description } : {}),
      ...(record.parameters !== undefined
        ? { parameters: record.parameters }
        : { parameters: { type: 'object', properties: {} } }),
      ...(record.strict !== undefined ? { strict: record.strict } : {}),
    },
  };
}

export function sanitizeAzureTools(tools: unknown): ToolRecord[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const sanitized = tools
    .map(sanitizeAzureTool)
    .filter((tool): tool is ToolRecord => tool !== null);
  return sanitized.length > 0 ? sanitized : undefined;
}

export function prepareAzureChatParams(
  request: CompletionRequest,
  stream: boolean,
  model: string,
  useOpenAICompatibleEndpoint: boolean,
): Record<string, unknown> {
  const { model: _model, messages, stream: _stream, tools, input: _input, ...rest } = request;

  const params: Record<string, unknown> = { stream };
  params.messages = sanitizeAzureMessages(messages);

  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    if (CURSOR_RESPONSES_ONLY_FIELDS.has(key)) continue;
    if (!AZURE_CHAT_COMPLETION_FIELDS.has(key)) continue;
    params[key] = value;
  }

  if (tools !== undefined) {
    params.tools = sanitizeAzureTools(tools);
    if (!params.tools) {
      delete params.tool_choice;
      delete params.parallel_tool_calls;
    }
  }

  if (useOpenAICompatibleEndpoint) {
    params.model = model;
  }

  return params;
}

/** @deprecated Use prepareAzureChatParams — kept for tests migrating off field whitelists. */
export function sanitizeAzureRequestFields(request: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(request)) {
    if (value === undefined) continue;
    if (key === 'model' || key === 'messages' || key === 'stream') continue;
    if (!AZURE_ALLOWED_FIELDS.has(key)) continue;
    sanitized[key] = key === 'tools' ? sanitizeAzureTools(value) : value;
  }

  if (sanitized.tools === undefined) {
    delete sanitized.tool_choice;
    delete sanitized.parallel_tool_calls;
  }

  return sanitized;
}
