import { OpenAIProvider } from './openai';
import type {
  ImageGenerationRequest,
  ImageGenerationResult,
  ModelDetail,
  VideoGenerationRequest,
  VideoGenerationResult,
} from '../core/types';
import { config } from '../config';

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
    if (capability === 'image') return this.mediaModels.image.has(model);
    if (capability === 'video') return this.mediaModels.video.has(model);
    return capability === 'chat' && /^(doubao|seed|deepseek|kimi)-/i.test(model);
  }

  private mediaModels: { image: Set<string>; video: Set<string> } = { image: new Set(), video: new Set() };

  /**
   * ModelArk's model list is account-scoped. Discover media ids from it rather
   * than advertising a guessed model id; pricing remains explicit in the shared
   * price table and is never inferred from the upstream response.
   */
  private async discoverMediaModels(): Promise<void> {
    if (!this.apiKey) return;
    const body = await this.ark('/models', { method: 'GET' });
    const models = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
    for (const entry of models) {
      const id = typeof entry === 'string' ? entry : entry?.id;
      if (typeof id !== 'string') continue;
      if (/seedream|image/i.test(id)) this.mediaModels.image.add(id);
      if (/seedance|video/i.test(id)) this.mediaModels.video.add(id);
    }
  }

  /**
   * ModelArk's OpenAI-compatible listing does not reliably include pricing.
   * Keep the customer-facing catalog here so public model and pricing routes
   * cannot depend on an upstream list that omits ModelArk prices.
   */
  async getModels(): Promise<ModelDetail[]> {
    await this.discoverMediaModels();
    return BYTEPLUS_CATALOG
      .filter((model) => !/seedream|seedance/i.test(model.id) || this.mediaModels.image.has(model.id) || this.mediaModels.video.has(model.id))
      .map(({ pricing, ...model }) => ({ ...model, pricing }));
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
        ...(request.size ? { size: request.size } : {}),
        ...(request.n ? { n: request.n } : {}),
      }),
    });
    return { data: body.data ?? [], model: body.model ?? request.model };
  }

  async generateVideo(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
    const created = await this.ark('/contents/generations/tasks', {
      method: 'POST',
      body: JSON.stringify({
        model: request.model,
        content: [{ type: 'text', text: request.prompt }],
        ...(request.duration ? { duration: request.duration } : {}),
        ...(request.size ? { ratio: request.size } : {}),
      }),
    });
    const id = created.id ?? created.task_id;
    if (!id) throw new Error('BytePlus video response did not include a task id.');
    let task = created;
    for (let attempt = 0; attempt < 60 && !['succeeded', 'failed', 'cancelled'].includes(String(task.status).toLowerCase()); attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000));
      task = await this.ark(`/contents/generations/tasks/${encodeURIComponent(id)}`, { method: 'GET' });
    }
    const output = task.content ?? task.output ?? {};
    return {
      id: String(id),
      status: String(task.status ?? 'unknown'),
      url: output.video_url ?? output.url ?? task.video_url,
      error: task.error?.message ?? task.error,
      model: request.model,
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