import type { ChatMessage, CompletionRequest } from './types';

type MessageInput = {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
};

const RESERVED_REQUEST_KEYS = new Set(['model', 'messages', 'stream', 'input']);

function extractRawMessages(raw: Record<string, unknown>): unknown {
  if (raw.messages != null) return raw.messages;
  if (raw.input == null) return null;

  if (typeof raw.input === 'string') {
    return [{ role: 'user', content: raw.input }];
  }

  return raw.input;
}

function normalizeRole(role: unknown): string {
  if (role === 'developer') return 'system';
  return typeof role === 'string' ? role : 'user';
}

function normalizeMessageContent(content: unknown): string | null {
  if (content === null) return null;
  if (typeof content === 'string') return content;
  if (content == null) return '';

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const record = part as Record<string, unknown>;
          if (typeof record.text === 'string') return record.text;
          if (typeof record.content === 'string') return record.content;
        }
        return JSON.stringify(part);
      })
      .filter(Boolean)
      .join('\n');
  }

  if (typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    return JSON.stringify(content);
  }

  return String(content);
}

function normalizeMessage(message: unknown): ChatMessage {
  if (typeof message === 'string') {
    return { role: 'user', content: message };
  }

  const input = (message && typeof message === 'object' ? message : {}) as MessageInput;
  const toolCalls = Array.isArray(input.tool_calls) ? input.tool_calls : undefined;
  const hasToolCalls = Boolean(toolCalls?.length);
  const normalizedContent = input.content === null && hasToolCalls
    ? null
    : normalizeMessageContent(input.content);

  const normalized: ChatMessage = {
    role: normalizeRole(input.role),
    content: normalizedContent,
  };

  if (toolCalls) normalized.tool_calls = toolCalls;
  if (typeof input.tool_call_id === 'string') normalized.tool_call_id = input.tool_call_id;
  if (typeof input.name === 'string') normalized.name = input.name;

  return normalized;
}

export function normalizeCompletionRequest(body: unknown): CompletionRequest {
  const raw = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const rawMessages = extractRawMessages(raw);
  const messages = Array.isArray(rawMessages)
    ? rawMessages.map(normalizeMessage)
    : rawMessages != null
      ? [normalizeMessage(rawMessages)]
      : [];

  const request: CompletionRequest = {
    model: typeof raw.model === 'string' ? raw.model : 'auto',
    messages,
    stream: Boolean(raw.stream),
  };

  for (const [key, value] of Object.entries(raw)) {
    if (!RESERVED_REQUEST_KEYS.has(key) && value !== undefined) {
      request[key] = value;
    }
  }

  return request;
}

export function ensureMessageArray(messages: unknown): ChatMessage[] {
  if (Array.isArray(messages)) {
    return messages.map(normalizeMessage);
  }
  if (messages != null) {
    return [normalizeMessage(messages)];
  }
  return [];
}
