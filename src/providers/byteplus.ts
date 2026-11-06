import { OpenAIProvider } from './openai';
import type {
  ImageGenerationRequest,
  ImageGenerationResult,
  ModelDetail,
  VideoGenerationRequest,
  VideoGenerationResult,
} from '../core/types';
import { config } from '../config';
import { MEDIA_PRICING_SOURCES, mediaModel, mediaModelsOf, videoDuration, videoResolution } from '../core/media-catalog';

/**
 * BytePlus ModelArk's OpenAI-compatible provider for chat and embeddings.
 * Reasoning-only responses are promoted to content when the upstream omits content.
 */
// Official ModelArk pricing source; media requests must use an explicit entry and never fall back to a default price.
const BYTEPLUS_PRICING_SOURCE = 'https://www.byteplus.com/en/product/modelark/pricing';

const BYTEPLUS_CATALOG: Array<ModelDetail & { pricing: { input: number; output: number } }> = [
  { id: 'seed-2-0-lite-260428', name: 'Seed 2.0 Lite', pricing: { input: 0.25, output: 2.0 } },
  { id: 'seed-2-0-mini-260428', name: 'Dola Seed 2.0 Mini', pricing: { input: 0.1, output: 0.4 } },
  { id: 'deepseek-v4-flash-ga-260731', name: 'DeepSeek V4 Flash', pricing: { input: 0.14, output: 0.28 } },
  // TODO: confirm official prices for DeepSeek V4.1 Flash and GLM-5.3 Flash from BytePlus console/docs.
].map((model) => ({ ...model, source: BYTEPLUS_PRICING_SOURCE }));

export const BYTEPLUS_CATALOG_PRICING = Object.fromEntries(
  BYTEPLUS_CATALOG.map(({ id, pricing }) => [id, pricing]),
);

export class BytePlusProvider extends OpenAIProvider {
  name = 'BytePlus';
  family = 'BytePlus';
  capabilities: import('../core/types').Capability[] = ['chat', 'embeddings', 'image', 'video'];

  constructor(
    apiKey: string = process.env.BYTEPLUS_ARK_API_KEY || '',
    model: string = config.DEFAULT_MODELS.BYTEPLUS_ARK,
    baseUrl: string = process.env.BYTEPLUS_ARK_BASE_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3',
  ) {
    super(apiKey, model, baseUrl);
  }

  servesModel(capability: 'chat' | 'embeddings' | 'transcription' | 'speech' | 'image' | 'video', model: string): boolean {
    if (capability === 'embeddings') return model === 'skylark-embedding-vision-251215';
    // Image and video models: the ones Valefront prices (src/core/media-catalog.ts), never a guessed id.
    if (capability === 'image' || capability === 'video') return Boolean(this.apiKey) && mediaModel(model, capability)?.provider === 'BytePlus';
    return capability === 'chat' && /^(doubao|seed|deepseek|kimi)-/i.test(model);
  }

  /**
   * ModelArk's OpenAI-compatible listing does not reliably include pricing.
   * Keep the customer-facing catalog here so public model and pricing routes
   * cannot depend on an upstream list that omits ModelArk prices.
   */
  async getModels(): Promise<ModelDetail[]> {
    const media = mediaModelsOf('BytePlus').map((m) => ({ id: m.id, name: m.name, source: MEDIA_PRICING_SOURCES.BytePlus }));
    return [...BYTEPLUS_CATALOG.map(({ pricing, ...model }) => ({ ...model, pricing })), ...media];
  }

  async complete(request: Parameters<OpenAIProvider['complete']>[0]) {
    const response = await super.complete(request);
    const choices = (response as {
      choices?: Array<{
        message?: {
          content?: unknown;
          reasoning_content?: unknown;
          reasoning?: unknown;
        };
      }>;
    }).choices;

    for (const choice of choices ?? []) {
      const message = choice.message;
      if (!message || (typeof message.content === 'string' && message.content.trim() !== '')) continue;
      const reasoning = message.reasoning_content ?? message.reasoning;
      if (typeof reasoning === 'string' && reasoning.trim() !== '') {
        message.content = reasoning;
      }
    }
    return response;
  }

  defaultModelFor(capability: 'chat' | 'embeddings' | 'transcription' | 'speech' | 'image' | 'video'): string | undefined {
    return capability === 'chat' ? this.defaultModel : undefined;
  }

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const body = await this.ark('/images/generations', {
      method: 'POST',
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        size: request.size ?? '2K',
        response_format: request.response_format === 'b64_json' ? 'b64_json' : 'url',
        watermark: false,
        // One image per call for Seedream (several come back as a group only with sequential generation).
        sequential_image_generation: 'disabled',
      }),
    });
    const data = (Array.isArray(body.data) ? body.data : []).filter((d: { url?: string; b64_json?: string }) => d && (d.url || d.b64_json));
    return { data: data.map((d: { url?: string; b64_json?: string }) => (d.url ? { url: d.url } : { b64_json: d.b64_json })), model: body.model ?? request.model };
  }

  /** Starts a Seedance task; the video is fetched with getVideo (BytePlus keeps the task, so any instance can). */
  async generateVideo(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
    const m = mediaModel(request.model, 'video');
    if (!m) throw new Error(`BytePlus: ${request.model} is not a priced video model`);
    const duration = videoDuration(m, request.duration);
    const resolution = videoResolution(m, request.resolution);
    const created = await this.ark('/contents/generations/tasks', {
      method: 'POST',
      body: JSON.stringify({
        model: request.model,
        content: [{ type: 'text', text: request.prompt }],
        duration,
        resolution,
        ratio: typeof request.ratio === 'string' ? request.ratio : '16:9',
        watermark: false,
        generate_audio: false,
      }),
    });
    const id = created.id ?? created.task_id;
    if (!id) throw new Error('BytePlus video response did not include a task id.');
    return { id: String(id), status: 'queued', model: request.model, duration, resolution };
  }

  async getVideo(id: string): Promise<VideoGenerationResult> {
    const task = await this.ark(`/contents/generations/tasks/${encodeURIComponent(id)}`, { method: 'GET' });
    const content = task.content ?? {};
    const usage = task.usage ?? {};
    const tokens = Number(usage.completion_tokens ?? usage.total_tokens);
    return {
      id: String(task.id ?? id),
      status: String(task.status ?? 'unknown').toLowerCase(),
      model: String(task.model ?? ''),
      ...(content.video_url ? { url: String(content.video_url) } : {}),
      ...(task.error ? { error: String(task.error.message ?? task.error.code ?? task.error) } : {}),
      ...(Number.isFinite(tokens) && tokens > 0 ? { tokens } : {}),
      ...(task.resolution ? { resolution: String(task.resolution) } : {}),
      ...(task.duration ? { duration: Number(task.duration) } : {}),
    };
  }

  private async ark(path: string, init: RequestInit): Promise<any> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`BytePlus ${response.status}: ${JSON.stringify(body)}`);
    return body;
  }
}