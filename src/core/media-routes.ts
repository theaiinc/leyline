import express from 'express';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import type { Router } from './router';
import type { AudioFile, EmbeddingResult, ImageGenerationResult, Provider, SpeechResult, TranscriptionResult, VideoGenerationResult } from './types';
import { randomBytes } from 'crypto';
import type { DocStore } from './issued-keys';
import { imageCostUsd, mediaModel, videoCostUsd, type MediaKind } from './media-catalog';
import { byokMediaProviderNamed, byokMediaProviders, poolRefusal, resolveModel, servedBy, servedByByok, type HostedOptions, type MediaChargeBasis } from './hosted';
import type { WorkspaceByok } from './workspace-providers';
import { wavespeedInput, type WaveSpeedModelInfo } from './wavespeed-models';
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
 * - POST /v1/images/generations    {model, prompt, n?, size?, response_format?: url | b64_json} -> {created, data, cost}
 * - POST /v1/videos                {model, prompt, duration?, resolution?, ratio?} -> 202 {id, status: queued}
 * - GET  /v1/videos/:id            -> {id, status, url?, cost?}; a finished video is charged once, here
 *
 * Hosted, the dash Playground runs the same image and video handlers for a signed-in customer, as one of their keys
 * they pick by id (no secret in the browser): POST /dashboard/me/playground/images, POST …/videos,
 * GET …/videos/:id?keyId=… (opts.playgroundAuth).
 *
 * A workspace key's image or video request for a model one of its own media providers serves (WaveSpeed, "Your
 * providers"; hosted.ts admitKey) runs on that provider, built from the workspace's key, never on the pool: counted on
 * a $0 spend line BYOK:<label>, billed by the customer's WaveSpeed account. Any WaveSpeed model the key can use, not
 * only the ones Valefront sells, with the model's own fields passed through unchanged (image, images, seed,
 * negative_prompt, aspect_ratio, …; src/core/wavespeed-models.ts): images (and anything else) on
 * /v1/images/generations, which waits for the result; videos (and anything else) on /v1/videos, an async job. A model
 * WaveSpeed lists as a video model is refused on the images endpoint and vice versa; one it doesn't list goes either way.
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
  /** `media`: an image or video generation (what was made), so a promotion can price it. */
  record: (req: Request, model: string, usage: { prompt_tokens?: number; completion_tokens?: number }, usd?: number, media?: MediaChargeBasis) => void;
  bodyLimit: string;
  /** Where video jobs and their one-time charges are kept (hosted: the key store); unset: this process only. */
  jobs?: DocStore;
  /**
   * Hosted: the dash Playground's session check (requirePlaygroundKey), which admits the request as one of the
   * signed-in customer's own keys. Mounts the same image and video handlers at /dashboard/me/playground/….
   */
  playgroundAuth?: RequestHandler;
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

  // ── images and videos ──────────────────────────────────────────────────────────────────────────────────
  // Priced before any provider is called (src/core/media-catalog.ts): a model without a price is refused, so we
  // never pay a provider for something we can't charge. Never failed over: each provider submit is a billed task.

  const MEDIA_DEFAULT: Record<MediaKind, string> = { image: 'seedream-4-0-250828', video: 'seedance-1-0-pro-fast-251015' };
  const mediaTarget = (req: Request, kind: MediaKind) => {
    const asked = model(req);
    const id = !asked || asked === 'auto' ? MEDIA_DEFAULT[kind] : asked;
    return mediaModel(id, kind);
  };
  const keyIdOf = (req: Request) => (req as Request & { issuedKey?: { id: string } }).issuedKey?.id ?? '';
  const asRequested = (req: Request, id: string) => { (req as Request & { requestedModel?: string }).requestedModel = id; };

  /** The model the client named, as sent (BYOK media is matched on it exactly; hosted.ts admitKey). */
  const askedModel = (req: Request) => (typeof req.body?.model === 'string' ? req.body.model.trim() : '');
  const byokOf = (req: Request) => (req as Request & { byok?: WorkspaceByok | null }).byok ?? null;
  /** What WaveSpeed lists about a BYOK model (kind, fields); null when not known (any endpoint, fields as sent). */
  const ownModelInfo = async (req: Request, id: string): Promise<WaveSpeedModelInfo | null> => {
    try {
      return (await byokOf(req)?.mediaModelInfo(id)) ?? null;
    } catch {
      return null;
    }
  };

  /** A workspace's own WaveSpeed: any model its key can use, the client's fields sent through, $0 to Valefront. */
  const ownImage = async (req: Request, res: Response, own: Provider, id: string) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const info = await ownModelInfo(req, id);
    if (info?.kind === 'video') return fail(res, 400, 'wrong_endpoint', `"${id}" is a video model (${info.type}); use POST /v1/videos.`);
    const n = body.n === undefined ? undefined : Number(body.n);
    if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 10)) return fail(res, 400, 'invalid_n', 'n must be 1 to 10.');
    const result = await own.generateImage!({
      model: id, prompt: typeof body.prompt === 'string' ? body.prompt : '', input: wavespeedInput(body, info?.schema),
      ...(body.response_format ? { response_format: String(body.response_format) } : {}),
    });
    servedBy(req)(own.name, id);
    asRequested(req, id);
    const catalog = mediaModel(id, 'image');
    const size = typeof body.size === 'string' ? body.size : undefined;
    opts.record(req, id, { prompt_tokens: 0, completion_tokens: 0 }, 0, catalog ? { kind: 'image', model: catalog, count: result.data.length, ...(size ? { size } : {}) } : undefined);
    return res.json({
      created: Math.floor(Date.now() / 1000), model: id, provider: own.name, data: result.data, cost: 0, usage: { images: result.data.length },
      ...(result.outputs ? { outputs: result.outputs } : {}), ...(result.taskId ? { task_id: result.taskId } : {}),
    });
  };

  const generateImage: RequestHandler = async (req, res) => {
    try {
      const body = req.body ?? {};
      if (body.response_format !== undefined && body.response_format !== 'url' && body.response_format !== 'b64_json') {
        return fail(res, 400, 'invalid_response_format', 'response_format must be url or b64_json.');
      }
      // The workspace's own provider for this model (BYOK): the first one only (a submit is a billed task). Its
      // models have their own fields (an upscaler or background remover takes no prompt), so none is required here.
      const asked = askedModel(req);
      const [own] = asked ? await byokMediaProviders(req, asked) : [];
      if (own) return await ownImage(req, res, own, asked);
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) return fail(res, 400, 'invalid_prompt', 'prompt is required.');
      const m = mediaTarget(req, 'image');
      if (!m) return fail(res, 404, 'model_not_found', `"${body.model}" is not an image model offered here; see /v1/models.`);
      const n = body.n === undefined ? 1 : Number(body.n);
      if (!Number.isInteger(n) || n < 1 || n > 4) return fail(res, 400, 'invalid_n', 'n must be 1 to 4.');
      const size = typeof body.size === 'string' ? body.size : undefined;
      // Seedream makes one image per call: n calls; WaveSpeed takes num_images.
      const calls = m.provider === 'BytePlus' ? n : 1;
      const data: ImageGenerationResult['data'] = [];
      let provider = '';
      for (let i = 0; i < calls; i++) {
        const { result, provider: p } = await router.routeCapability<ImageGenerationResult>('image', m.id, (prov, selected) => prov.generateImage!({
          model: selected, prompt: body.prompt, n: m.provider === 'BytePlus' ? 1 : n, ...(size ? { size } : {}), ...(body.response_format ? { response_format: body.response_format } : {}),
        }), { forceProvider: m.provider, onServed: servedBy(req) });
        provider = p;
        data.push(...result.data);
      }
      if (data.length === 0) return fail(res, 502, 'no_image', 'The provider returned no image; nothing was charged.');
      const cost = servedByByok(provider) ? 0 : imageCostUsd(m, data.length, size);
      asRequested(req, m.id);
      opts.record(req, m.id, { prompt_tokens: 0, completion_tokens: 0 }, cost, { kind: 'image', model: m, count: data.length, ...(size ? { size } : {}) });
      return res.json({ created: Math.floor(Date.now() / 1000), model: m.id, provider, data, cost, usage: { images: data.length } });
    } catch (error) {
      sendError(res, '/v1/images/generations', error);
    }
  };
  app.post('/v1/images/generations', opts.auth, generateImage);

  // Video jobs: kept by id so any instance can answer the poll; charged once when first seen finished.
  const memoryJobs = new Map<string, { value: unknown; gen: string }>();
  const jobs: Pick<DocStore, 'get' | 'put'> = opts.jobs ?? {
    async get<T>(key: string) { return (memoryJobs.get(key) as { value: T; gen: string } | undefined) ?? null; },
    async put(key: string, value: unknown, ifGen?: string) {
      if (ifGen === '0' && memoryJobs.has(key)) throw new Error('exists');
      memoryJobs.set(key, { value, gen: '1' });
      return '1';
    },
  };
  type VideoJob = { id: string; provider: string; task: string; model: string; keyId: string; createdAt: number; duration?: number; resolution?: string };
  const videoView = (job: VideoJob, v: Partial<VideoGenerationResult>, cost?: number) => ({
    id: job.id, object: 'video', model: job.model, status: v.status ?? 'queued', created_at: Math.floor(job.createdAt / 1000),
    ...(job.duration ? { duration: job.duration } : {}), ...(job.resolution ? { resolution: job.resolution } : {}),
    ...(v.url ? { url: v.url } : {}), ...(v.error ? { error: v.error } : {}), ...(cost !== undefined ? { cost } : {}),
  });

  const startVideo: RequestHandler = async (req, res) => {
    try {
      const body = req.body ?? {};
      const asked = askedModel(req);
      const [own] = asked ? await byokMediaProviders(req, asked) : [];
      if (!own && (typeof body.prompt !== 'string' || !body.prompt.trim())) return fail(res, 400, 'invalid_prompt', 'prompt is required.');
      const m = own ? null : mediaTarget(req, 'video');
      if (!own && !m) return fail(res, 404, 'model_not_found', `"${body.model}" is not a video model offered here; see /v1/models.`);
      if (own && !own.generateVideo) return fail(res, 400, 'unsupported_model', `Your provider "${own.label ?? own.name}" does not make videos.`);
      const id = own ? asked : m!.id;
      let result: VideoGenerationResult;
      let provider: string;
      if (own) {
        // The workspace's own WaveSpeed: the model's own fields as sent (input images as URLs or data: URIs).
        const info = await ownModelInfo(req, id);
        if (info?.kind === 'image') return fail(res, 400, 'wrong_endpoint', `"${id}" is an image model (${info.type}); use POST /v1/images/generations.`);
        result = await own.generateVideo!({ model: id, prompt: typeof body.prompt === 'string' ? body.prompt : '', input: wavespeedInput(body as Record<string, unknown>, info?.schema) });
        provider = own.name;
        servedBy(req)(own.name, id);
      } else {
        ({ result, provider } = await router.routeCapability<VideoGenerationResult>('video', id, (prov: Provider, selected: string) => prov.generateVideo!({
          model: selected, prompt: body.prompt,
          ...(body.duration !== undefined ? { duration: Number(body.duration) } : {}),
          ...(typeof body.resolution === 'string' ? { resolution: body.resolution } : {}),
          ...(typeof body.ratio === 'string' ? { ratio: body.ratio } : {}),
        }), { forceProvider: m!.provider, onServed: servedBy(req) }));
      }
      const job: VideoJob = {
        id: `video_${randomBytes(12).toString('hex')}`, provider, task: result.id, model: id, keyId: keyIdOf(req), createdAt: Date.now(),
        ...(result.duration ? { duration: result.duration } : {}), ...(result.resolution ? { resolution: result.resolution } : {}),
      };
      await jobs.put(`media-jobs/${job.id}`, job, '0');
      return res.status(202).json(videoView(job, { status: 'queued' }));
    } catch (error) {
      sendError(res, '/v1/videos', error);
    }
  };
  app.post('/v1/videos', opts.auth, startVideo);

  const readVideo: RequestHandler = async (req, res) => {
    try {
      const job = (await jobs.get<VideoJob>(`media-jobs/${String(req.params.id)}`))?.value;
      // Only the key that started it may read it (the owner's dashboard session, without a key, reads its own; the dash
      // Playground, as the customer's chosen key, only that key's).
      if (!job || job.keyId !== keyIdOf(req)) return fail(res, 404, 'video_not_found', 'Video not found.');
      // Admitted without credit for the workspace's own provider's jobs only (hosted.ts admitKey): a pool job needs it.
      const refusal = poolRefusal(req);
      if (refusal && !servedByByok(job.provider)) return fail(res, refusal.status, refusal.code, refusal.message);
      const prov = (await byokMediaProviderNamed(req, job.provider, job.model)) ?? router.getProviders().find((p: Provider) => p.name === job.provider);
      if (!prov?.getVideo) return fail(res, 503, 'provider_unavailable', `${job.provider} is not available to read this video right now.`);
      const v = await prov.getVideo(job.task);
      if (v.status !== 'succeeded') return res.json(videoView(job, v));
      if (servedByByok(job.provider)) {
        // The customer's own WaveSpeed bills it: counted once on its $0 spend line, never charged.
        let first = true;
        try {
          await jobs.put(`media-charges/${job.id}`, { cost: 0, at: Date.now() }, '0');
        } catch {
          first = false;
        }
        if (first) {
          servedBy(req)(job.provider, job.model);
          asRequested(req, job.model);
          opts.record(req, job.model, { prompt_tokens: 0, completion_tokens: v.tokens ?? 0 }, 0);
        }
        return res.json({ ...videoView(job, v, 0), ...(v.outputs ? { outputs: v.outputs } : {}) });
      }
      const m = mediaModel(job.model, 'video');
      if (!m || !v.tokens) {
        console.error(JSON.stringify({ event: 'video_unpriced', id: job.id, model: job.model, tokens: v.tokens ?? null }));
        return res.json(videoView(job, v));
      }
      const cost = videoCostUsd(m, v.tokens, v.resolution ?? job.resolution);
      let first = true;
      try {
        await jobs.put(`media-charges/${job.id}`, { cost, tokens: v.tokens, at: Date.now() }, '0');
      } catch {
        first = false;
      }
      if (first) {
        servedBy(req)(job.provider, job.model);
        asRequested(req, job.model);
        const resolution = v.resolution ?? job.resolution;
        opts.record(req, job.model, { prompt_tokens: 0, completion_tokens: v.tokens }, cost, { kind: 'video', model: m, tokens: v.tokens, ...(resolution ? { resolution } : {}) });
      }
      return res.json(videoView(job, v, cost));
    } catch (error) {
      sendError(res, '/v1/videos/:id', error);
    }
  };
  app.get('/v1/videos/:id', opts.auth, readVideo);

  if (opts.playgroundAuth) {
    // Same handlers, admitted as the customer's chosen key: same price, credit check, caps and spend lines. A video
    // job belongs to the key that started it, so polling needs that key (of the same workspace) too.
    app.post('/dashboard/me/playground/images', opts.playgroundAuth, generateImage);
    app.post('/dashboard/me/playground/videos', opts.playgroundAuth, startVideo);
    app.get('/dashboard/me/playground/videos/:id', opts.playgroundAuth, readVideo);
  }
}
