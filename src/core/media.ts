import { modelAllowed } from './issued-keys';
import type { EmbeddingRequest, EmbeddingResult, TranscriptionResult, TranscriptSegment } from './types';

/**
 * Embeddings, speech-to-text and text-to-speech (POST /v1/embeddings, /v1/audio/transcriptions, /v1/audio/speech):
 * the OpenAI-shaped pieces the server needs whatever provider answered, and what audio costs.
 */

/** A refusal Leyline makes itself (no provider for a model, a bad request), with the HTTP status to answer with. */
export class CapabilityError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** An upstream's HTTP error in the shape the rest of Leyline reads (axios-like `response.status/data`). */
export async function upstreamError(provider: string, res: Response): Promise<Error> {
  const text = (await res.text().catch(() => '')).slice(0, 2000);
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: { message: text || res.statusText } };
  }
  const error = new Error(`${provider} failed with HTTP ${res.status}`) as Error & { status?: number; response?: { status: number; data: unknown } };
  error.status = res.status;
  error.response = { status: res.status, data };
  return error;
}

/** The HTTP status of an error from a provider (or Leyline), if it has one. */
export function errorStatus(error: unknown): number | undefined {
  const e = error as { status?: number; response?: { status?: number } };
  return e instanceof CapabilityError ? e.status : e?.response?.status ?? e?.status;
}

// ── embeddings ─────────────────────────────────────────────────────────────────────────────────────────

/** A float vector as OpenAI's base64 encoding_format: little-endian float32s. */
export function embeddingToBase64(vector: number[]): string {
  const buf = Buffer.alloc(vector.length * 4);
  vector.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf.toString('base64');
}

/** POST an OpenAI-shaped embeddings request (OpenAI, OpenRouter, Gemini's and Workers AI's OpenAI endpoints). */
export async function openAIEmbeddings(provider: string, url: string, headers: Record<string, string>, request: EmbeddingRequest): Promise<EmbeddingResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: request.model,
      input: request.input,
      encoding_format: 'float',
      ...(request.dimensions ? { dimensions: request.dimensions } : {}),
      ...(request.user ? { user: request.user } : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw await upstreamError(provider, res);
  const body = await res.json() as { data?: Array<{ index?: number; embedding: number[] }>; model?: string; usage?: { prompt_tokens?: number; total_tokens?: number } };
  const data = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (data.length !== request.input.length) throw new Error(`${provider} returned ${data.length} embeddings for ${request.input.length} inputs`);
  return {
    embeddings: data.map(d => d.embedding),
    model: body.model || request.model,
    ...(body.usage?.prompt_tokens ? { usage: { prompt_tokens: body.usage.prompt_tokens, total_tokens: body.usage.total_tokens ?? body.usage.prompt_tokens } } : {}),
  };
}

/** Four characters a token, for providers that report no usage. */
export function estimateTextTokens(texts: string[]): number {
  return texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
}

// ── transcription output ───────────────────────────────────────────────────────────────────────────────

export const TRANSCRIPTION_FORMATS = ['json', 'text', 'srt', 'verbose_json', 'vtt'] as const;
export type TranscriptionFormat = typeof TRANSCRIPTION_FORMATS[number];

function segmentsOf(result: TranscriptionResult): TranscriptSegment[] {
  if (result.segments?.length) return result.segments;
  if (!result.text) return [];
  const end = result.duration ?? result.words?.[result.words.length - 1]?.end ?? 0;
  return [{ id: 0, start: 0, end, text: result.text }];
}

function clock(seconds: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function toSrt(result: TranscriptionResult): string {
  return segmentsOf(result).map((seg, i) => `${i + 1}\n${clock(seg.start, ',')} --> ${clock(seg.end, ',')}\n${seg.text.trim()}\n`).join('\n');
}

export function toVtt(result: TranscriptionResult): string {
  return `WEBVTT\n\n${segmentsOf(result).map((seg) => `${clock(seg.start, '.')} --> ${clock(seg.end, '.')}\n${seg.text.trim()}\n`).join('\n')}`;
}

/** The response body OpenAI gives for each response_format. */
export function formatTranscription(result: TranscriptionResult, format: TranscriptionFormat, granularities: string[] = []): { contentType: string; body: string | Record<string, unknown> } {
  if (format === 'text') return { contentType: 'text/plain; charset=utf-8', body: result.text };
  if (format === 'srt') return { contentType: 'text/plain; charset=utf-8', body: toSrt(result) };
  if (format === 'vtt') return { contentType: 'text/vtt; charset=utf-8', body: toVtt(result) };
  if (format === 'verbose_json') {
    const wantWords = granularities.includes('word');
    const wantSegments = !granularities.length || granularities.includes('segment');
    return {
      contentType: 'application/json',
      body: {
        task: 'transcribe',
        language: result.language ?? 'unknown',
        duration: result.duration ?? 0,
        text: result.text,
        ...(wantSegments ? { segments: segmentsOf(result) } : {}),
        ...(wantWords ? { words: result.words ?? [] } : {}),
      },
    };
  }
  return { contentType: 'application/json', body: { text: result.text } };
}

// ── audio length and price ─────────────────────────────────────────────────────────────────────────────

/**
 * Seconds of audio when the provider doesn't say: exact for WAV (from its header), else the size at 128 kbit/s
 * (MP3, M4A and Opus speech is usually smaller, so this errs towards more seconds, i.e. a higher cost).
 */
export function estimateAudioSeconds(data: Uint8Array): number {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length > 44 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') {
    const byteRate = b.readUInt32LE(28);
    if (byteRate > 0) return Math.max(0, (b.length - 44) / byteRate);
  }
  return b.length / 16_000;
}

/**
 * What audio costs, in US dollars: transcription by the minute of audio, speech by the million characters of
 * text. Keys are model ids or patterns with *; the first match wins. List prices as of 2026-10 (Deepgram's
 * pay-as-you-go multilingual rate, Workers AI's per-minute prices).
 */
export const TRANSCRIPTION_USD_PER_MINUTE: Record<string, number> = {
  'whisper-1': 0.006,
  'gpt-4o-transcribe': 0.006,
  'gpt-4o-mini-transcribe': 0.003,
  'nova-3*': 0.0052,
  'deepgram/nova-3*': 0.0052,
  'nova-2*': 0.0043,
  'deepgram/nova-2*': 0.0043,
  '@cf/openai/whisper*': 0.00052,
};
/** Deliberately high, like the token default price: an unpriced model errs on the safe side of a limit. */
export const DEFAULT_TRANSCRIPTION_USD_PER_MINUTE = 0.02;

export const SPEECH_USD_PER_MILLION_CHARS: Record<string, number> = {
  'tts-1': 15,
  'tts-1-hd': 30,
  'gpt-4o-mini-tts': 20,
  '@cf/myshell-ai/melotts': 0.25,
};
export const DEFAULT_SPEECH_USD_PER_MILLION_CHARS = 30;

function lookup(table: Record<string, number>, model: string): number | undefined {
  if (table[model] !== undefined) return table[model];
  for (const [pattern, price] of Object.entries(table)) {
    if (pattern.includes('*') && modelAllowed({ models: [pattern] }, model)) return price;
  }
  return undefined;
}

export function transcriptionCostUsd(model: string, seconds: number): number {
  return ((lookup(TRANSCRIPTION_USD_PER_MINUTE, model) ?? DEFAULT_TRANSCRIPTION_USD_PER_MINUTE) * Math.max(0, seconds)) / 60;
}

export function speechCostUsd(model: string, characters: number): number {
  return ((lookup(SPEECH_USD_PER_MILLION_CHARS, model) ?? DEFAULT_SPEECH_USD_PER_MILLION_CHARS) * Math.max(0, characters)) / 1_000_000;
}

/** Content types for OpenAI's speech response_format values. */
export const SPEECH_CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
};
