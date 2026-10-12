import type { ChatMessage, CompletionRequest } from './types';
import { isTextPart, type ContentPart } from './content';

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

/** A content-list entry as an OpenAI part: bare strings become text parts; any other part is kept as sent. */
function normalizePart(part: unknown): ContentPart {
  if (typeof part === 'string') return { type: 'text', text: part };
  if (part && typeof part === 'object') {
    const record = part as Record<string, unknown>;
    if (typeof record.type === 'string') return record as ContentPart;
    if (typeof record.text === 'string') return { type: 'text', text: record.text };
    if (typeof record.content === 'string') return { type: 'text', text: record.content };
  }
  return { type: 'text', text: JSON.stringify(part) };
}

/**
 * A message's content as a string or OpenAI content parts. A list that is all text collapses to one string (what
 * every provider takes); a list with images, audio, files or unknown part types stays a list, untouched, so those
 * parts reach the upstream model.
 */
function normalizeMessageContent(content: unknown): string | ContentPart[] | null {
  if (content === null) return null;
  if (typeof content === 'string') return content;
  if (content == null) return '';

  if (Array.isArray(content)) {
    const parts = content.map(normalizePart);
    if (parts.every(isTextPart)) {
      return parts.map((part) => (part as { text: string }).text).filter(Boolean).join('\n');
    }
    return parts;
  }

  if (typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (typeof record.type === 'string' && !isTextPart(record)) return [record as ContentPart];
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
