import type { ChatMessage } from '../core/types';
import { ensureMessageArray } from '../core/normalize-request';

const AZURE_ALLOWED_FIELDS = new Set([
  'tools',
  'tool_choice',
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
]);

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

function sanitizeAzureTool(tool: unknown): ToolRecord | null {
  if (!tool || typeof tool !== 'object') return null;
  const record = tool as ToolRecord;

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
