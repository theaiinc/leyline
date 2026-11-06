import { createHash, createHmac } from 'crypto';
import type { Capability, CompletionRequest, CompletionResponse, ModelDetail, Provider, StreamChunk, VideoGenerationRequest, VideoGenerationResult } from '../core/types';
import { CapabilityError } from '../core/media';
import { MEDIA_PRICING_SOURCES, mediaModel, mediaModelsOf } from '../core/media-catalog';

/**
 * BytePlus Vision AI (a separate BytePlus product from ModelArk, with its own Access Key) for OmniHuman talking
 * avatars: one image + an audio track -> a lip-synced video. Official docs (read 2026-11-06):
 *
 * - API: https://docs.byteplus.com/docs/en/byteplus-vision/omnihuman-2-0-video-generation.md
 *   POST https://cv.byteplusapi.com/?Action=CVSync2AsyncSubmitTask&Version=2024-06-06
 *        {req_key: "realman_avatar_picture_omni20_cv", image_urls: [url], audio_url, prompt?, enable_watermark}
 *        -> {code: 10000, data: {task_id}}
 *   POST https://cv.byteplusapi.com/?Action=CVSync2AsyncGetResult&Version=2024-06-06 {req_key, task_id}
 *        -> {code, message, data: {status: in_queue | generating | done | not_found | expired | canceled, video_url}}
 *   "done" is success or failure "judged by the outer code & message": code 10000 is success. video_url lasts 1 hour.
 * - Signature (Service=cv, Region=ap-singapore-1): https://docs.byteplus.com/en/docs/byteplus-vision/http_request_sample
 *   and https://docs.byteplus.com/en/docs/byteplus-platform/reference-common-parameters (HMAC-SHA256 over a canonical
 *   request, signed headers content-type;host;x-content-sha256;x-date, key derived date -> region -> service -> "request").
 *
 * The response carries no duration, and BytePlus bills by the duration of the generated video, so a finished
 * video's seconds are read from the MP4 itself (its movie header), with ranged reads (a few small requests).
 *
 * A submit is never retried (each one is a billed task). Registered only when both
 * BYTEPLUS_VISION_ACCESS_KEY_ID and BYTEPLUS_VISION_SECRET_ACCESS_KEY are set.
 */

export const VISION_HOST = 'cv.byteplusapi.com';
export const VISION_REGION = 'ap-singapore-1';
export const VISION_SERVICE = 'cv';
export const VISION_VERSION = '2024-06-06';

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s, 'utf8').digest();

/** 2026-11-06T10:15:00.123Z -> 20261106T101500Z */
export function xDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** The query string as BytePlus signs it: keys sorted, RFC 3986 escaped. */
export function canonicalQuery(query: Record<string, string>): string {
  const esc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return Object.keys(query).sort().map((k) => `${esc(k)}=${esc(query[k]!)}`).join('&');
}

/** The headers for one signed POST to the Vision API (BytePlus's HMAC-SHA256 signature, as in its HTTP sample). */
export function signVisionRequest(input: { accessKeyId: string; secretAccessKey: string; query: Record<string, string>; body: string; now: Date; host?: string }): Record<string, string> {
  const host = input.host ?? VISION_HOST;
  const date = xDate(input.now);
  const shortDate = date.slice(0, 8);
  const payloadHash = sha256Hex(input.body);
  const contentType = 'application/json';
  const signedHeaders = 'content-type;host;x-content-sha256;x-date';
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-content-sha256:${payloadHash}\nx-date:${date}\n`;
  const canonicalRequest = ['POST', '/', canonicalQuery(input.query), canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${shortDate}/${VISION_REGION}/${VISION_SERVICE}/request`;
  const stringToSign = ['HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(input.secretAccessKey, shortDate), VISION_REGION), VISION_SERVICE), 'request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    'Content-Type': contentType,
    'X-Date': date,
    'X-Content-Sha256': payloadHash,
    Authorization: `HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ── MP4 duration ──────────────────────────────────────────────────────────────────────────────────────────

const MAX_BOXES = 64;
const MOOV_READ = 64 * 1024;
/** When a host ignores Range and sends the whole file: read it only up to this size. */
const MAX_WHOLE_FILE = 64 * 1024 * 1024;

function boxAt(buf: Uint8Array, at: number): { size: number; type: string; header: number } | null {
  if (at + 8 > buf.length) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let size = dv.getUint32(at);
  const type = String.fromCharCode(buf[at + 4]!, buf[at + 5]!, buf[at + 6]!, buf[at + 7]!);
  let header = 8;
  if (size === 1) {
    if (at + 16 > buf.length) return null;
    size = Number(dv.getBigUint64(at + 8));
    header = 16;
  }
  return { size, type, header };
}

/** Seconds from an mvhd box's payload (after its 8/16-byte header), or null. */
function mvhdSeconds(buf: Uint8Array, at: number): number | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (at + 1 > buf.length) return null;
  const version = buf[at]!;
  const need = version === 1 ? 32 : 20;
  if (at + need > buf.length) return null;
  const timescale = version === 1 ? dv.getUint32(at + 20) : dv.getUint32(at + 12);
  const duration = version === 1 ? Number(dv.getBigUint64(at + 24)) : dv.getUint32(at + 16);
  if (!timescale || !Number.isFinite(duration) || duration <= 0) return null;
  return duration / timescale;
}

/** The movie's seconds from a moov box held in buf (from its start), or null. */
function moovSeconds(buf: Uint8Array, moovAt: number, moov: { size: number; header: number }): number | null {
  const end = Math.min(buf.length, moovAt + moov.size);
  for (let at = moovAt + moov.header; at < end;) {
    const child = boxAt(buf, at);
    if (!child || child.size < 8) return null;
    if (child.type === 'mvhd') return mvhdSeconds(buf, at + child.header);
    at += child.size;
  }
  return null;
}

/** The MP4 at `url`'s duration in seconds (its mvhd), read with ranged GETs; throws when it can't be read. */
export async function mp4DurationSeconds(url: string, fetchImpl: typeof fetch): Promise<number> {
  const range = async (from: number, length: number): Promise<{ partial: boolean; bytes: Uint8Array }> => {
    const res = await fetchImpl(url, { headers: { Range: `bytes=${from}-${from + length - 1}` } });
    if (res.status === 206) return { partial: true, bytes: new Uint8Array(await res.arrayBuffer()) };
    if (res.status === 200) {
      const len = Number(res.headers.get('content-length') ?? NaN);
      if (Number.isFinite(len) && len > MAX_WHOLE_FILE) { await res.body?.cancel(); throw new Error(`video is ${len} bytes and the host ignores Range`); }
      return { partial: false, bytes: new Uint8Array(await res.arrayBuffer()) };
    }
    if (res.status === 416) return { partial: true, bytes: new Uint8Array() };
    throw new Error(`reading the video failed: HTTP ${res.status}`);
  };
  let offset = 0;
  for (let i = 0; i < MAX_BOXES; i++) {
    const head = await range(offset, 16);
    if (!head.partial) {
      // The whole file came back: walk it in memory.
      const buf = head.bytes;
      for (let at = 0, n = 0; at < buf.length && n < MAX_BOXES * 4; n++) {
        const box = boxAt(buf, at);
        if (!box || box.size < 8) break;
        if (box.type === 'moov') { const s = moovSeconds(buf, at, box); if (s) return s; break; }
        at += box.size;
      }
      throw new Error('no movie header (moov/mvhd) in the video');
    }
    const box = boxAt(head.bytes, 0);
    if (!box) break;
    if (box.size === 0) {
      // "Extends to the end of the file": only a moov is worth reading.
      if (box.type !== 'moov') break;
    }
    if (box.type === 'moov') {
      const moov = await range(offset, Math.min(box.size || MOOV_READ, MOOV_READ));
      const s = moovSeconds(moov.bytes, 0, { size: box.size || moov.bytes.length, header: box.header });
      if (s) return s;
      break;
    }
    if (box.size < 8) break;
    offset += box.size;
  }
  throw new Error('no movie header (moov/mvhd) in the video');
}

// ── provider ──────────────────────────────────────────────────────────────────────────────────────────────

type VisionResponse = {
  code?: number;
  message?: string;
  request_id?: string;
  data?: { task_id?: string; status?: string; video_url?: string } | null;
  ResponseMetadata?: { Error?: { Code?: string; Message?: string } | null } | null;
};

/** Query states -> Valefront's video states. */
const STATES: Record<string, string> = { in_queue: 'queued', generating: 'running', not_found: 'expired', expired: 'expired', canceled: 'cancelled' };
/** Codes BytePlus marks retryable (rate, concurrency, internal): the request failed, not the task. */
const RETRYABLE = new Set([50429, 50430, 50500, 50501]);

export class BytePlusVisionProvider implements Provider {
  name = 'BytePlusVision';
  family = 'BytePlusVision';
  label = 'BytePlus Vision AI';
  defaultModel = 'omnihuman-2.0';
  capabilities: Capability[] = ['video'];
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(
    accessKeyId = process.env.BYTEPLUS_VISION_ACCESS_KEY_ID || '',
    secretAccessKey = process.env.BYTEPLUS_VISION_SECRET_ACCESS_KEY || '',
    opts: { fetchImpl?: typeof fetch; now?: () => Date; baseUrl?: string } = {},
  ) {
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.baseUrl = (opts.baseUrl ?? `https://${VISION_HOST}`).replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => new Date());
  }

  private configured(): boolean {
    return Boolean(this.accessKeyId && this.secretAccessKey);
  }

  async isAvailable(): Promise<boolean> {
    return this.configured();
  }

  servesModel(capability: Capability, model: string): boolean {
    return this.configured() && capability === 'video' && mediaModel(model, 'video')?.provider === 'BytePlusVision';
  }

  defaultModelFor(_capability: Capability): string | undefined {
    return undefined;
  }

  async complete(_request: CompletionRequest): Promise<CompletionResponse> {
    throw new Error('BytePlus Vision does not serve chat completions');
  }

  // eslint-disable-next-line require-yield
  async *completeStream(_request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    throw new Error('BytePlus Vision does not serve chat completions');
  }

  async getModels(): Promise<ModelDetail[]> {
    return mediaModelsOf('BytePlusVision').map((m) => ({ id: m.id, name: m.name, source: MEDIA_PRICING_SOURCES.BytePlusVision }));
  }

  /** Starts an OmniHuman task (request.image, request.audio: URLs; request.prompt optional). */
  async generateVideo(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
    const m = mediaModel(request.model, 'video');
    if (!m?.avatar) throw new Error(`BytePlus Vision: ${request.model} is not a priced avatar model`);
    const body: Record<string, unknown> = {
      req_key: m.avatar.reqKey,
      image_urls: [String(request.image)],
      audio_url: String(request.audio),
      enable_watermark: false,
      ...(typeof request.prompt === 'string' && request.prompt.trim() ? { prompt: request.prompt.trim() } : {}),
    };
    const out = await this.call('CVSync2AsyncSubmitTask', body);
    if (out.code !== 10000 || !out.data?.task_id) {
      // A bad input (a URL BytePlus can't fetch, an image or audio outside its limits) is the caller's to fix.
      if (typeof out.code === 'number' && out.code >= 50200 && out.code < 50300) {
        throw new CapabilityError(400, 'invalid_media_input', `BytePlus refused the image or audio: ${out.message ?? out.code}`);
      }
      throw new Error(`BytePlus Vision submit failed: ${out.code ?? '?'} ${out.message ?? ''} (request ${out.request_id ?? '?'})`);
    }
    return { id: `${m.avatar.reqKey}:${out.data.task_id}`, status: 'queued', model: request.model };
  }

  /** The task's state; a finished one carries its URL and its seconds (read from the video). */
  async getVideo(id: string): Promise<VideoGenerationResult> {
    const sep = id.lastIndexOf(':');
    const reqKey = sep > 0 ? id.slice(0, sep) : '';
    const taskId = sep > 0 ? id.slice(sep + 1) : id;
    const model = mediaModelsOf('BytePlusVision').find((x) => x.avatar?.reqKey === reqKey)?.id ?? '';
    if (!reqKey || !model) throw new Error(`BytePlus Vision: unknown task id ${id}`);
    const out = await this.call('CVSync2AsyncGetResult', { req_key: reqKey, task_id: taskId });
    const state = out.data?.status;
    if (out.code !== 10000) {
      // A finished task that failed ("done" with an error code): costs nothing. Anything else is this request
      // failing (rate limit, auth, internal), not the task: ask again later.
      if (state === 'done') return { id, status: 'failed', model, error: out.message ?? `BytePlus error ${out.code}` };
      if (state && STATES[state]) return { id, status: STATES[state]!, model };
      throw new Error(`BytePlus Vision query failed: ${out.code ?? '?'} ${out.message ?? ''}${RETRYABLE.has(out.code ?? 0) ? ' (retryable)' : ''} (request ${out.request_id ?? '?'})`);
    }
    if (state !== 'done') return { id, status: (state && STATES[state]) || 'running', model };
    const url = out.data?.video_url;
    if (!url) return { id, status: 'failed', model, error: 'BytePlus reported the task done without a video.' };
    let seconds: number | undefined;
    try {
      seconds = await mp4DurationSeconds(url, this.fetchImpl);
    } catch (err) {
      console.error(JSON.stringify({ event: 'avatar_duration_unreadable', id, error: err instanceof Error ? err.message : String(err) }));
    }
    return { id, status: 'succeeded', model, url, ...(seconds ? { seconds } : {}) };
  }

  private async call(action: string, payload: Record<string, unknown>): Promise<VisionResponse> {
    const query = { Action: action, Version: VISION_VERSION };
    const body = JSON.stringify(payload);
    const headers = signVisionRequest({ accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey, query, body, now: this.now(), host: new URL(this.baseUrl).host });
    const res = await this.fetchImpl(`${this.baseUrl}/?${canonicalQuery(query)}`, { method: 'POST', headers, body });
    const text = await res.text();
    let out: VisionResponse;
    try {
      out = JSON.parse(text) as VisionResponse;
    } catch {
      throw new Error(`BytePlus Vision ${action}: HTTP ${res.status}, not JSON`);
    }
    // The gateway's own errors (signature, permission, a service not activated) come as ResponseMetadata.Error.
    const gw = out.ResponseMetadata?.Error;
    if (gw && (gw.Code || gw.Message)) throw new Error(`BytePlus Vision ${action}: ${gw.Code ?? ''} ${gw.Message ?? ''} (HTTP ${res.status})`);
    return out;
  }
}
