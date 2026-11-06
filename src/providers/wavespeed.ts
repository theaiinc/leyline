import type { Capability, CompletionRequest, CompletionResponse, ImageGenerationRequest, ImageGenerationResult, ModelDetail, Provider, StreamChunk } from '../core/types';
import { upstreamError } from '../core/media';
import { MEDIA_PRICING_SOURCES, mediaModel, mediaModelsOf } from '../core/media-catalog';

/**
 * WaveSpeed (wavespeed.ai) for images. Its API: POST {base}/{model path} (e.g. /wavespeed-ai/flux-dev) with the
 * model's own fields, `size` as "width*height"; the task is in `data` ({id, status, outputs}); the result is read
 * from GET {base}/predictions/{id}/result. We ask with enable_sync_mode so the answer carries the image, and poll
 * the result only if it comes back unfinished. A submit is never retried (each one is a billed task).
 *
 * Models and prices: src/core/media-catalog.ts.
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
    const size = (request.size ?? '1024x1024').replace(/x/i, '*');
    const n = Math.min(4, Math.max(1, Math.floor(Number(request.n ?? 1)) || 1));
    const submitted = await this.fetchImpl(`${this.baseUrl}/${request.model}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ prompt: request.prompt, size, num_images: n, enable_sync_mode: true, enable_base64_output: request.response_format === 'b64_json' }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!submitted.ok) throw await upstreamError(this.name, submitted);
    let task = taskOf(await submitted.json());
    for (let i = 0; i < 60 && !isDone(task.status); i++) {
      await this.sleep(2_000);
      const polled = await this.fetchImpl(`${this.baseUrl}/predictions/${encodeURIComponent(task.id)}/result`, { headers: this.headers(), signal: AbortSignal.timeout(30_000) });
      if (!polled.ok) {
        if (polled.status === 429 || polled.status >= 500) continue;
        throw await upstreamError(this.name, polled);
      }
      task = taskOf(await polled.json());
    }
    if (task.status !== 'completed') throw new Error(`WaveSpeed image ${task.id || ''} ${task.status || 'unknown'}${task.error ? `: ${task.error}` : ''}`);
    const b64 = request.response_format === 'b64_json';
    return {
      model: request.model,
      data: task.outputs.map((o) => (b64 && !/^https?:/.test(o) ? { b64_json: o.replace(/^data:[^,]*,/, '') } : { url: o })),
    };
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' };
  }
}

type Task = { id: string; status: string; outputs: string[]; error?: string };

function taskOf(body: unknown): Task {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const d = (b.data && typeof b.data === 'object' ? b.data : b) as Record<string, unknown>;
  return {
    id: typeof d.id === 'string' ? d.id : '',
    status: typeof d.status === 'string' ? d.status : '',
    outputs: Array.isArray(d.outputs) ? d.outputs.filter((o): o is string => typeof o === 'string') : [],
    ...(typeof d.error === 'string' && d.error ? { error: d.error } : {}),
  };
}

function isDone(status: string): boolean {
  return ['completed', 'failed', 'cancelled', 'timeout', 'deleted'].includes(status);
}
