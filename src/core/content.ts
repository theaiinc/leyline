/**
 * OpenAI chat content parts. A message's content is a string or a list of parts: text, images (`image_url`, a
 * URL or a `data:` URL), audio (`input_audio`) and files (`file`). Leyline passes parts through untouched,
 * including types it doesn't know; only providers that can't take them turn them into text (and the router keeps
 * requests with images away from those, so a model never answers about an image it didn't get).
 */

export interface TextPart { type: 'text'; text: string }
export interface ImageUrlPart { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' | string } }
export interface InputAudioPart { type: 'input_audio'; input_audio: { data: string; format: string } }
export interface FilePart { type: 'file'; file: { file_data?: string; file_id?: string; filename?: string } }
/** A part type Leyline doesn't know: passed through as the client sent it. */
export interface OtherPart { type: string; [key: string]: unknown }

export type ContentPart = TextPart | ImageUrlPart | InputAudioPart | FilePart | OtherPart;
export type MessageContent = string | ContentPart[] | null | undefined;

/** Rough prompt tokens for one image (OpenAI counts 765 for a 1024×1024 image at high detail). */
export const IMAGE_TOKEN_ESTIMATE = 765;

function isPart(value: unknown): value is ContentPart {
  return Boolean(value) && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';
}

export function isTextPart(part: unknown): part is TextPart {
  return isPart(part) && part.type === 'text' && typeof (part as { text?: unknown }).text === 'string';
}

/** The text of a message's content: the string, or its text parts joined by newlines (other parts left out). */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(isTextPart).map(p => p.text).join('\n');
}

/** Whether a content list has anything besides text (an image, audio, a file, or a part type Leyline doesn't know). */
export function hasNonTextParts(content: unknown): boolean {
  return Array.isArray(content) && content.some(part => !isTextPart(part));
}

/** Whether any message carries non-text content. */
export function requestHasNonTextContent(messages: ReadonlyArray<{ content?: unknown }> | undefined): boolean {
  return Array.isArray(messages) && messages.some(m => hasNonTextParts(m?.content));
}

/** How many image parts the messages carry. */
export function countImageParts(messages: ReadonlyArray<{ content?: unknown }> | undefined): number {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) {
    if (Array.isArray(m?.content)) n += m.content.filter((p: unknown) => isPart(p) && p.type === 'image_url').length;
  }
  return n;
}

/**
 * Rough prompt tokens for a list of messages: four characters a token for text (and tool calls), a fixed
 * IMAGE_TOKEN_ESTIMATE per image. Base64 payloads are never counted as text.
 */
export function estimateMessageTokens(messages: ReadonlyArray<{ content?: unknown; tool_calls?: unknown }> | undefined): number {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    chars += contentText(m?.content).length;
    if (m?.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 4) + countImageParts(messages) * IMAGE_TOKEN_ESTIMATE;
}

/**
 * Rough prompt tokens for a raw request body (OpenAI or Anthropic shape): its JSON at four characters a token,
 * with inline media (data: URLs, base64 image/audio/document payloads) counted as IMAGE_TOKEN_ESTIMATE each
 * instead of by their (huge) length.
 */
export function estimateBodyTokens(body: unknown, charsPerToken = 4): number {
  let media = 0;
  const json = JSON.stringify(body ?? {}, function (this: Record<string, unknown>, key, value) {
    if (typeof value !== 'string' || value.length < 256) return value;
    const inlineMedia = value.startsWith('data:')
      || (key === 'data' && (this?.type === 'base64' || typeof this?.format === 'string' || typeof this?.media_type === 'string'))
      || key === 'file_data';
    if (!inlineMedia) return value;
    media++;
    return '';
  });
  return Math.ceil((json?.length ?? 0) / charsPerToken) + media * IMAGE_TOKEN_ESTIMATE;
}

/** A `data:` URL's media type and base64 payload, or null for anything else (an https URL). */
export function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+)?((?:;[^;,]*)*?);base64,(.*)$/s.exec(url);
  if (!match) return null;
  return { mimeType: match[1] || 'application/octet-stream', data: match[3] };
}
