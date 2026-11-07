import type { Capability, CompletionRequest, CompletionResponse, ImageGenerationRequest, ImageGenerationResult, ModelDetail, Provider, StreamChunk, VideoGenerationRequest, VideoGenerationResult } from '../core/types';
import { upstreamError } from '../core/media';
import { MEDIA_PRICING_SOURCES, mediaModel, mediaModelsOf } from '../core/media-catalog';

/**
 * WaveSpeed (wavespeed.ai) for images. Its API: POST {base}/{model path} (e.g. /wavespeed-ai/flux-dev) with the
 * model's own fields, `size` as "width*height"; the task is in `data` ({id, status, outputs}); the result is read
 * from GET {base}/predictions/{id}/result. We ask with enable_sync_mode so the answer carries the image, and poll
 * the result only if it comes back unfinished. A submit is never retried (each one is a billed task).
 *
 * Models and prices: src/core/media-catalog.ts (the pool). A workspace's own WaveSpeed key (Your providers) runs any
 * model WaveSpeed has: `request.input` is then the model's own fields, sent as given (src/core/wavespeed-models.ts),
 * and videos are async jobs (submit, then GET …/result on each poll).
 */
export class WaveSpeedProvider implements Provider {
  name = 'WaveSpeed';
  family = 'WaveSpeed';
  label = 'WaveSpeed';
  defaultModel = 'wavespeed-ai/flux-dev';
  capabilities: Capability[] = ['image'];
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    apiKey = process.env.WAVESPEED_API_KEY || '',
    baseUrl = process.env.WAVESPEED_BASE_URL || 'https://api.wavespeed.ai/api/v3',
    opts: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  servesModel(capability: Capability, model: string): boolean {
    return Boolean(this.apiKey) && capability === 'image' && mediaModel(model, 'image')?.provider === 'WaveSpeed';
  }

  defaultModelFor(capability: Capability): string | undefined {
    return capability === 'image' && this.apiKey ? this.defaultModel : undefined;
  }

  async complete(_request: CompletionRequest): Promise<CompletionResponse> {
    throw new Error('WaveSpeed does not serve chat completions');
  }

  // eslint-disable-next-line require-yield
  async *completeStream(_request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    throw new Error('WaveSpeed does not serve chat completions');
  }

  async getModels(): Promise<ModelDetail[]> {
    return mediaModelsOf('WaveSpeed').map((m) => ({ id: m.id, name: m.name, source: MEDIA_PRICING_SOURCES.WaveSpeed }));
  }

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const b64 = request.response_format === 'b64_json';
    const input = request.input && typeof request.input === 'object'
      ? request.input as Record<string, unknown>
      : {
        prompt: request.prompt,
        size: (request.size ?? '1024x1024').replace(/x/i, '*'),
        num_images: Math.min(4, Math.max(1, Math.floor(Number(request.n ?? 1)) || 1)),
      };
    let task = await this.submit(request.model, input, { sync: true, base64: b64 });
    for (let i = 0; i < 60 && !isDone(task.status); i++) {
      await this.sleep(2_000);
      task = (await this.result(task.id, true)) ?? task;
    }
    if (task.status !== 'completed') throw new Error(`WaveSpeed image ${task.id || ''} ${task.status || 'unknown'}${task.error ? `: ${task.error}` : ''}`);
    return {
      model: request.model,
      data: task.outputs.map((o) => (b64 && !/^https?:/.test(o) ? { b64_json: o.replace(/^data:[^,]*,/, '') } : { url: o })),
      ...(task.raw.length !== task.outputs.length ? { outputs: task.raw } : {}),
      ...(task.id ? { taskId: task.id } : {}),
    };
  }

  /** Starts any WaveSpeed model as an async job (no sync mode): the task, to read with getVideo. */
  async generateVideo(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
    const input = request.input && typeof request.input === 'object'
      ? request.input as Record<string, unknown>
      : {
        prompt: request.prompt,
        ...(request.duration !== undefined ? { duration: request.duration } : {}),
        ...(typeof request.resolution === 'string' ? { resolution: request.resolution } : {}),
        ...(typeof request.ratio === 'string' ? { aspect_ratio: request.ratio } : {}),
      };
    const task = await this.submit(request.model, input, { sync: false, base64: false });
    if (!task.id) throw new Error('WaveSpeed returned no task id');
    return videoOf(task, request.model);
  }

  /** One read of a task's result (GET {base}/predictions/{id}/result). */
  async getVideo(id: string): Promise<VideoGenerationResult> {
    const task = await this.result(id, false);
    return task ? videoOf(task, '') : { id, status: 'running', model: '' };
  }

  /** POST {base}/{model} once (never retried: each submit is a billed task); inline files are uploaded first. */
  private async submit(model: string, input: Record<string, unknown>, opts: { sync: boolean; base64: boolean }): Promise<Task> {
    const body = { ...(await this.uploadInline(input)), ...(opts.sync ? { enable_sync_mode: true } : {}), ...(opts.base64 ? { enable_base64_output: true } : opts.sync ? { enable_base64_output: false } : {}) };
    const submitted = await this.fetchImpl(`${this.baseUrl}/${model}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!submitted.ok) throw await upstreamError(this.name, submitted);
    return taskOf(await submitted.json());
  }

  /** The task now; null when WaveSpeed is busy (429/5xx: read again later). Other errors throw. */
  private async result(id: string, tolerant: boolean): Promise<Task | null> {
    const polled = await this.fetchImpl(`${this.baseUrl}/predictions/${encodeURIComponent(id)}/result`, { headers: this.headers(), signal: AbortSignal.timeout(30_000) });
    if (!polled.ok) {
      if (polled.status === 429 || polled.status >= 500) {
        if (tolerant) return null;
        return { id, status: 'processing', outputs: [], raw: [] };
      }
      throw await upstreamError(this.name, polled);
    }
    return taskOf(await polled.json());
  }

  /**
   * A model's image (or video, audio) inputs may be sent inline as data: URIs: each is uploaded to WaveSpeed first
   * (POST {base}/media/upload/binary, https://wavespeed.ai/docs/upload-files-api, free) and replaced by its
   * download_url, the documented way to pass a file. URLs are passed as they are.
   */
  private async uploadInline(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    let uploads = 0;
    const one = async (v: unknown): Promise<unknown> => {
      if (typeof v !== 'string' || !v.startsWith('data:')) return v;
      if (++uploads > 16) throw Object.assign(new Error('At most 16 inline files per request; pass URLs instead.'), { status: 400 });
      const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(v);
      if (!m) throw Object.assign(new Error('An inline file is not a valid data: URI.'), { status: 400 });
      const type = m[1] || 'application/octet-stream';
      const bytes = m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!));
      const ext = (type.split('/')[1] ?? 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(bytes)], { type }), `input.${ext}`);
      const res = await this.fetchImpl(`${this.baseUrl}/media/upload/binary`, { method: 'POST', headers: { authorization: `Bearer ${this.apiKey}` }, body: form, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw await upstreamError(this.name, res);
      const url = ((await res.json().catch(() => ({}))) as { data?: { download_url?: unknown } })?.data?.download_url;
      if (typeof url !== 'string' || !url) throw new Error('WaveSpeed upload returned no download_url');
      return url;
    };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) out[k] = Array.isArray(v) ? await Promise.all(v.map(one)) : await one(v);
    return out;
  }

  /**
   * The account's balance (GET {base}/balance, https://wavespeed.ai/docs/check-balance): an authenticated read that
   * creates no task, so it checks the key without generating (or paying for) anything. Throws with the HTTP status.
   */
  async balance(): Promise<number | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/balance`, { headers: this.headers(), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw Object.assign(new Error(`WaveSpeed balance check failed (HTTP ${res.status})`), { status: res.status });
    const body = (await res.json().catch(() => ({}))) as { data?: { balance?: unknown } };
    return typeof body?.data?.balance === 'number' ? body.data.balance : null;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' };
  }
}

type Task = { id: string; status: string; outputs: string[]; raw: unknown[]; error?: string };

function taskOf(body: unknown): Task {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const d = (b.data && typeof b.data === 'object' ? b.data : b) as Record<string, unknown>;
  const raw = Array.isArray(d.outputs) ? d.outputs : [];
  return {
    id: typeof d.id === 'string' ? d.id : '',
    status: typeof d.status === 'string' ? d.status : '',
    outputs: raw.filter((o): o is string => typeof o === 'string'),
    raw,
    ...(typeof d.error === 'string' && d.error ? { error: d.error } : {}),
  };
}

/** WaveSpeed's task states -> the video job states Valefront answers with (queued, running, succeeded, failed, …). */
function videoOf(task: Task, model: string): VideoGenerationResult {
  const status = task.status === 'completed' ? 'succeeded'
    : task.status === 'created' ? 'queued'
      : task.status === 'failed' || task.status === 'deleted' ? 'failed'
        : task.status === 'cancelled' ? 'cancelled'
          : task.status === 'timeout' ? 'expired'
            : 'running';
  return {
    id: task.id, status, model,
    ...(status === 'succeeded' && task.outputs[0] ? { url: task.outputs[0] } : {}),
    ...(status === 'succeeded' && task.raw.length ? { outputs: task.raw } : {}),
    ...(task.error ? { error: task.error } : {}),
  };
}

function isDone(status: string): boolean {
  return ['completed', 'failed', 'cancelled', 'timeout', 'deleted'].includes(status);
}
