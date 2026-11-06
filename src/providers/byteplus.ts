import { OpenAIProvider } from './openai';
import type {
  CompletionRequest,
  ImageGenerationRequest,
  TokenPricing,
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
// Official ModelArk prices: the Pricing page (Large language models, Standard online inference) of the ModelArk docs,
// read 2026-11-06 (page updated 2026-10-23); ids, modalities and limits from its Model list page. Media requests must
// use an explicit entry (src/core/media-catalog.ts) and never fall back to a default price.
export const BYTEPLUS_PRICING_SOURCE = 'https://docs.byteplus.com/en/docs/ModelArk/1544106';
export const BYTEPLUS_MODEL_LIST_SOURCE = 'https://docs.byteplus.com/en/docs/ModelArk/1330310';

type CatalogEntry = ModelDetail & { pricing: TokenPricing };

/**
 * BytePlus bills a Seed 2.0 request whole by its prompt length: one price for [0, 128]K prompt tokens, another for
 * (128, 256]K. The docs don't say whether K is 1,000 or 1,024 tokens: the boundary is put at 128,000 so a prompt in
 * between is never charged less than BytePlus charges Valefront.
 */
const SEED_TIER_ABOVE = 128_000;
const tierAbove128k = (input: number, output: number, cachedInput: number) => [{ aboveTokens: SEED_TIER_ABOVE, input, output, cachedInput }];
/** DeepSeek V4.1 Flash series: off-peak is the base price; peak hours are Mon-Fri 09:00-12:00 and 14:00-18:00 (UTC+8). */
const peak = (input: number, output: number, cachedInput: number) => ({ schedule: 'byteplus-utc8-workday' as const, input, output, cachedInput });

/**
 * Every chat model ModelArk lists with a Standard online-inference price (US$ per 1M tokens: input, output, cached
 * input), ids exactly as BytePlus spells them. Left out: models retiring on 2026-11-11 (Seed 1.6/1.8, DeepSeek V3.2,
 * GLM-4.7, seed-2-0-lite-260228, seed-2-0-mini-260215). Not represented: the audio-input prices of Seed 2.0 Lite/Mini
 * (audio input is refused, see complete()) and explicit-cache storage (Valefront only uses implicit caching, free).
 * capabilities: 'vision' where the Model list says "Visual understanding: Yes". Routing strategies
 * (src/core/routing-strategies.ts) send a request with images only to models listing 'vision'.
 */
const BYTEPLUS_CATALOG: CatalogEntry[] = ([
  // ByteDance. Dola Seed 2.1 Turbo: one tier, [0, 256]K (the pricing table lists it as dola-seed-2-1-turbo; the
  // Model list's only version is dola-seed-2-1-turbo-260628).
  { id: 'dola-seed-2-1-turbo-260628', name: 'Dola Seed 2.1 Turbo', capabilities: ['chat', 'vision'], pricing: { input: 0.5, output: 2.5, cachedInput: 0.1 } },
  { id: 'seed-2-0-lite-260428', name: 'Dola Seed 2.0 Lite', capabilities: ['chat', 'vision'], pricing: { input: 0.25, output: 2.0, cachedInput: 0.05, promptTiers: tierAbove128k(0.5, 4.0, 0.1) } },
  { id: 'seed-2-0-mini-260428', name: 'Dola Seed 2.0 Mini', capabilities: ['chat', 'vision'], pricing: { input: 0.1, output: 0.4, cachedInput: 0.02, promptTiers: tierAbove128k(0.2, 0.8, 0.04) } },
  { id: 'seed-2-0-pro-260328', name: 'Dola Seed 2.0 Pro', capabilities: ['chat', 'vision'], pricing: { input: 0.5, output: 3.0, cachedInput: 0.1, promptTiers: tierAbove128k(1.0, 6.0, 0.2) } },
  { id: 'seed-2-0-code-preview-260328', name: 'Dola Seed 2.0 Code', capabilities: ['chat', 'vision'], pricing: { input: 0.5, output: 3.0, cachedInput: 0.1, promptTiers: tierAbove128k(1.0, 6.0, 0.2) } },
  // DeepSeek. V4.1 Flash: off-peak / peak. V4 Pro and V4 Flash: one price ("Not applicable" prompt length).
  { id: 'deepseek-v4-1-flash-economy-261017', name: 'DeepSeek V4.1 Flash Economy', capabilities: ['chat', 'vision'], pricing: { input: 0.12, output: 0.48, cachedInput: 0.002, peak: peak(0.24, 0.96, 0.005) } },
  { id: 'deepseek-v4-1-flash-261017', name: 'DeepSeek V4.1 Flash', capabilities: ['chat', 'vision'], pricing: { input: 0.15, output: 0.6, cachedInput: 0.003, peak: peak(0.3, 1.2, 0.006) } },
  { id: 'deepseek-v4-1-flash-260910', name: 'DeepSeek V4.1 Flash (260910)', capabilities: ['chat', 'vision'], pricing: { input: 0.15, output: 0.6, cachedInput: 0.003, peak: peak(0.3, 1.2, 0.006) } },
  { id: 'deepseek-v4-pro-ga-260813', name: 'DeepSeek V4 Pro', capabilities: ['chat'], pricing: { input: 1.32, output: 3.96, cachedInput: 0.044 } },
  { id: 'deepseek-v4-flash-ga-260731', name: 'DeepSeek V4 Flash', capabilities: ['chat'], pricing: { input: 0.44, output: 1.32, cachedInput: 0.014 } },
  { id: 'deepseek-v4-pro-260425', name: 'DeepSeek V4 Pro (260425)', capabilities: ['chat'], pricing: { input: 1.32, output: 3.96, cachedInput: 0.044 } },
  { id: 'deepseek-v4-flash-260425', name: 'DeepSeek V4 Flash (260425)', capabilities: ['chat'], pricing: { input: 0.44, output: 1.32, cachedInput: 0.014 } },
  // Z.ai.
  { id: 'glm-5-3-flash-260828', name: 'GLM-5.3 Flash', capabilities: ['chat', 'vision'], pricing: { input: 0.15, output: 0.5, cachedInput: 0.03 } },
  { id: 'glm-5-2-260617', name: 'GLM-5.2', capabilities: ['chat'], pricing: { input: 1.4, output: 4.4, cachedInput: 0.26 } },
] as CatalogEntry[]).map((model) => ({ ...model, source: BYTEPLUS_PRICING_SOURCE }));

/** The ids of every BytePlus chat model Valefront prices (the default offered list, src/config.ts, matches it). */
export const BYTEPLUS_CHAT_MODEL_IDS = BYTEPLUS_CATALOG.map((m) => m.id);

export const BYTEPLUS_CATALOG_PRICING = Object.fromEntries(
  BYTEPLUS_CATALOG.map(({ id, pricing }) => [id, pricing]),
);

/**
 * Names benchmark sources list BytePlus chat models under (Epoch AI: "doubao-seed-2.0-lite-260428",
 * "deepseek-v4-flash-0731"), for the best and balanced routing strategies.
 */
export const BYTEPLUS_BENCHMARK_ALIASES: Record<string, string[]> = {
  'seed-2-0-lite-260428': ['doubao-seed-2.0-lite-260428', 'seed-2.0-lite'],
  'seed-2-0-mini-260428': ['doubao-seed-2.0-mini-260428', 'seed-2.0-mini'],
  'deepseek-v4-flash-ga-260731': ['deepseek-v4-flash-0731', 'deepseek-v4-flash'],
  'deepseek-v4-pro-ga-260813': ['deepseek-v4-pro-0813', 'deepseek-v4-pro'],
  'deepseek-v4-1-flash-261017': ['deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash'],
  'dola-seed-2-1-turbo-260628': ['doubao-seed-2.1-turbo-260628'],
  'glm-5-3-flash-260828': ['glm-5.3-flash'],
  'glm-5-2-260617': ['glm-5.2'],
};

/** Whether a BytePlus chat model reads images (its catalog entry lists 'vision'); unknown models: no. */
export function byteplusChatModelReadsImages(model: string): boolean {
  return BYTEPLUS_CATALOG.some((m) => m.id === model && (m.capabilities ?? []).includes('vision'));
}

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
    return capability === 'chat' && /^(doubao|seed|deepseek|kimi|glm)-|^dola-seed-/i.test(model);
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

  /**
   * Audio input is refused: BytePlus prices audio input tokens (Seed 2.0 Lite/Mini) at 15 times text input, and its
   * usage doesn't tell Valefront how many prompt tokens were audio, so it would be charged at the text price. Images,
   * video and files go as sent (priced as non-audio input).
   */
  acceptsNonTextContent(request: CompletionRequest): boolean {
    return !request.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => (p as { type?: unknown } | null)?.type === 'input_audio'));
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