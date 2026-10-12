import express from 'express';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import type { Router } from './router';
import type { AudioFile, EmbeddingResult, SpeechResult, TranscriptionResult } from './types';
import { resolveModel, servedBy, type HostedOptions } from './hosted';
import { chatCompletionErrorResponse, formatProviderError } from './api-errors';
import {
  CapabilityError, TRANSCRIPTION_FORMATS, embeddingToBase64, estimateAudioSeconds, estimateTextTokens, formatTranscription,
  speechCostUsd, transcriptionCostUsd, type TranscriptionFormat,
} from './media';

/**
 * OpenAI's embeddings and audio endpoints on top of Leyline's providers:
 *
 * - POST /v1/embeddings            {model, input: string | string[], dimensions?, encoding_format?: float | base64}
 * - POST /v1/audio/transcriptions  multipart: file, model, language?, prompt?, response_format?, temperature?,
 *                                  timestamp_granularities[]?
 * - POST /v1/audio/speech          {model, input, voice?, response_format?, speed?, instructions?} -> audio bytes
 *
 * Same auth as chat (hosted: an issued key, its caps, the offered/turned-off models, the monthly budget), the
 * same model aliases, `auto` for the first configured provider's default, and `x-leyline-force-provider`.
 * Usage counts as tokens for embeddings; audio is priced by the minute (transcription) or the character (speech).
 */

export type MediaRouteOptions = {
  auth: RequestHandler;
  hosted?: HostedOptions;
  /** Startup (provider keys) finished. */
  ready: Promise<unknown>;
  /** Count a finished request (hosted keys, tenant logs). */
  record: (req: Request, model: string, usage: { prompt_tokens?: number; completion_tokens?: number }, usd?: number) => void;
  bodyLimit: string;
};

type WithAudio = Request & { audioFile?: AudioFile };

function fail(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ error: { message, type: status === 404 ? 'not_found_error' : 'invalid_request_error', code } });
}

function sendError(res: Response, route: string, error: unknown) {
  console.error(`${route} error:`, formatProviderError(error));
  if (res.headersSent) return void res.end();
  if (error instanceof CapabilityError) return void fail(res, error.status, error.code, error.message);
  const { status, body } = chatCompletionErrorResponse(error);
  res.status(status).json(body);
}

/** The provider the client forces (x-leyline-force-provider), or undefined. */
function forced(req: Request): string | undefined {
  const h = req.headers['x-leyline-force-provider'];
  return typeof h === 'string' && h.trim() ? h.trim() : undefined;
}

/**
 * Multipart audio upload -> req.body (the text fields, so the key check sees `model`) and req.audioFile. Parsed with
 * the platform's own FormData (Node and Workers alike), no extra dependency.
 */
function audioForm(limit: string): RequestHandler[] {
  return [
    express.raw({ type: 'multipart/form-data', limit }),
    async (req: Request, res: Response, next: NextFunction) => {
      const type = req.headers['content-type'] ?? '';
      if (!type.startsWith('multipart/form-data') || !Buffer.isBuffer(req.body)) {
        return fail(res, 400, 'invalid_content_type', 'Send the audio as multipart/form-data with a "file" field.');
      }
      let form: FormData;
      try {
        form = await new Response(new Uint8Array(req.body), { headers: { 'content-type': type } }).formData();
      } catch {
        return fail(res, 400, 'invalid_multipart', 'The multipart body could not be read.');
      }
      const fields: Record<string, unknown> = {};
      const granularities: string[] = [];
      let file: AudioFile | undefined;
      for (const [key, value] of form.entries()) {
        if (typeof value === 'string') {
          if (key === 'timestamp_granularities[]' || key === 'timestamp_granularities') granularities.push(...value.split(',').map(v => v.trim()).filter(Boolean));
          else fields[key] = value;
        } else if (key === 'file') {
          const blob = value as Blob & { name?: string };
          file = { data: new Uint8Array(await blob.arrayBuffer()), filename: blob.name || 'audio', contentType: blob.type || 'application/octet-stream' };
        }
      }
      if (!file || file.data.length === 0) return fail(res, 400, 'missing_file', 'The "file" field (the audio) is required.');
      req.body = { ...fields, timestamp_granularities: granularities };
      (req as WithAudio).audioFile = file;
      next();
    },
  ];
}

export function mountMediaRoutes(app: Express, router: Router, opts: MediaRouteOptions): void {
  const model = (req: Request) => {
    const asked = typeof req.body?.model === 'string' && req.body.model.trim() ? req.body.model.trim() : 'auto';
    return opts.hosted ? resolveModel(opts.hosted.aliases, asked) : asked;
  };

  // ── embeddings ─────────────────────────────────────────────────────────────────────────────────────────
  app.post('/v1/embeddings', opts.auth, async (req, res) => {
    await opts.ready;
    const body = req.body ?? {};
    const input: unknown = body.input;
    const texts = typeof input === 'string' ? [input] : Array.isArray(input) && input.every(t => typeof t === 'string') ? input as string[] : null;
    if (!texts || texts.length === 0) {
      return fail(res, 400, 'invalid_input', '"input" must be a string or a list of strings (token arrays are not supported).');
    }
    if (texts.length > 2048) return fail(res, 400, 'too_many_inputs', 'At most 2048 inputs per request.');
    if (texts.some(t => t.length === 0)) return fail(res, 400, 'invalid_input', 'Inputs must not be empty strings.');
    const dimensions = body.dimensions === undefined || body.dimensions === null ? undefined : Number(body.dimensions);
    if (dimensions !== undefined && (!Number.isInteger(dimensions) || dimensions <= 0)) return fail(res, 400, 'invalid_dimensions', '"dimensions" must be a positive integer.');
    const encoding = body.encoding_format ?? 'float';
    if (encoding !== 'float' && encoding !== 'base64') return fail(res, 400, 'invalid_encoding_format', '"encoding_format" must be float or base64.');

    try {
      const { result, model: used } = await router.routeCapability<EmbeddingResult>('embeddings', model(req), (provider, m) => provider.embed!({
        model: m, input: texts, ...(dimensions ? { dimensions } : {}), ...(typeof body.user === 'string' ? { user: body.user } : {}),
      }), { forceProvider: forced(req), onServed: servedBy(req), usageOf: r => r.usage });
      const promptTokens = result.usage?.prompt_tokens || estimateTextTokens(texts);
      res.json({
        object: 'list',
        data: result.embeddings.map((embedding, index) => ({ object: 'embedding', index, embedding: encoding === 'base64' ? embeddingToBase64(embedding) : embedding })),
        model: result.model || used,
        usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
      });
      opts.record(req, used, { prompt_tokens: promptTokens, completion_tokens: 0 });
    } catch (error) {
      sendError(res, '/v1/embeddings', error);
    }
  });

  // ── speech-to-text ─────────────────────────────────────────────────────────────────────────────────────
  app.post('/v1/audio/transcriptions', ...audioForm(opts.bodyLimit), opts.auth, async (req, res) => {
    await opts.ready;
    const body = req.body as Record<string, unknown> & { timestamp_granularities: string[] };
    const file = (req as WithAudio).audioFile!;
    const format = (typeof body.response_format === 'string' && body.response_format ? body.response_format : 'json') as TranscriptionFormat;
    if (!TRANSCRIPTION_FORMATS.includes(format)) return fail(res, 400, 'invalid_response_format', `"response_format" must be one of ${TRANSCRIPTION_FORMATS.join(', ')}.`);
    const granularities = body.timestamp_granularities.filter(g => g === 'word' || g === 'segment');
    const temperature = body.temperature === undefined || body.temperature === '' ? undefined : Number(body.temperature);
    if (temperature !== undefined && !Number.isFinite(temperature)) return fail(res, 400, 'invalid_temperature', '"temperature" must be a number.');
    const timed = format === 'verbose_json' || format === 'srt' || format === 'vtt';

    try {
      const { result, model: used } = await router.routeCapability<TranscriptionResult>('transcription', model(req), (provider, m) => provider.transcribe!({
        model: m,
        file,
        ...(typeof body.language === 'string' && body.language ? { language: body.language } : {}),
        ...(typeof body.prompt === 'string' && body.prompt ? { prompt: body.prompt } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        timestamps: { segment: timed, word: granularities.includes('word') },
      }), { forceProvider: forced(req), onServed: servedBy(req), usageOf: r => ({ completion_tokens: Math.ceil(r.text.length / 4) }) });
      const seconds = result.duration ?? estimateAudioSeconds(file.data);
      const out = formatTranscription({ ...result, duration: result.duration ?? seconds }, format, granularities);
      res.type(out.contentType);
      if (typeof out.body === 'string') res.send(out.body);
      else res.json(format === 'json' ? { ...out.body, usage: { type: 'duration', seconds: Math.ceil(seconds) } } : out.body);
      opts.record(req, used, {
        prompt_tokens: result.usage?.prompt_tokens ?? 0,
        completion_tokens: result.usage?.completion_tokens ?? Math.ceil(result.text.length / 4),
      }, transcriptionCostUsd(used, seconds));
    } catch (error) {
      sendError(res, '/v1/audio/transcriptions', error);
    }
  });

  // ── text-to-speech ─────────────────────────────────────────────────────────────────────────────────────
  app.post('/v1/audio/speech', opts.auth, async (req, res) => {
    await opts.ready;
    const body = req.body ?? {};
    if (typeof body.input !== 'string' || !body.input.trim()) return fail(res, 400, 'invalid_input', '"input" (the text to speak) is required.');
    if (body.input.length > 4096) return fail(res, 400, 'input_too_long', '"input" may be at most 4096 characters.');
    const speed = body.speed === undefined ? undefined : Number(body.speed);
    if (speed !== undefined && (!Number.isFinite(speed) || speed < 0.25 || speed > 4)) return fail(res, 400, 'invalid_speed', '"speed" must be between 0.25 and 4.');

    try {
      const { result, model: used } = await router.routeCapability<SpeechResult>('speech', model(req), (provider, m) => provider.speak!({
        model: m,
        input: body.input,
        ...(typeof body.voice === 'string' ? { voice: body.voice } : {}),
        ...(typeof body.response_format === 'string' ? { response_format: body.response_format } : {}),
        ...(speed !== undefined ? { speed } : {}),
        ...(typeof body.instructions === 'string' ? { instructions: body.instructions } : {}),
      }), { forceProvider: forced(req), onServed: servedBy(req), usageOf: () => ({ prompt_tokens: Math.ceil(body.input.length / 4) }) });
      res.setHeader('Content-Type', result.contentType);
      res.send(Buffer.from(result.audio));
      opts.record(req, used, { prompt_tokens: Math.ceil(body.input.length / 4), completion_tokens: 0 }, speechCostUsd(used, body.input.length));
    } catch (error) {
      sendError(res, '/v1/audio/speech', error);
    }
  });
}
