import { OpenAIProvider, upstreamBody } from './openai';
import type { CompletionRequest, ModelDetail } from '../core/types';
import { config } from '../config';

/**
 * BytePlus ModelArk's OpenAI-compatible provider for chat and embeddings.
 * Reasoning-only responses are promoted to content when the upstream omits content.
 */
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
  capabilities: import('../core/types').Capability[] = ['chat', 'embeddings'];

  constructor(
    apiKey: string = process.env.BYTEPLUS_ARK_API_KEY || '',
    model: string = config.DEFAULT_MODELS.BYTEPLUS_ARK,
    baseUrl: string = process.env.BYTEPLUS_ARK_BASE_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3',
  ) {
    super(apiKey, model, baseUrl);
  }

  servesModel(capability: 'chat' | 'embeddings' | 'transcription' | 'speech', model: string): boolean {
    if (capability === 'embeddings') return model === 'skylark-embedding-vision-251215';
    return capability === 'chat' && /^(doubao|seed|deepseek|kimi)-/i.test(model);
  }

  /**
   * ModelArk's OpenAI-compatible listing does not reliably include pricing.
   * Keep the customer-facing catalog here so public model and pricing routes
   * cannot depend on an upstream list that omits ModelArk prices.
   */
  async getModels(): Promise<ModelDetail[]> {
    return BYTEPLUS_CATALOG.map(({ pricing, ...model }) => ({ ...model, pricing }));
  }

  defaultModelFor(capability: 'chat' | 'embeddings' | 'transcription' | 'speech'): string | undefined {
    return capability === 'chat' ? this.defaultModel : undefined;
  }

  /** ModelArk reasoning is opt-in; keep private reasoning out of ordinary agent responses. */
  protected upstreamBody(request: CompletionRequest, model: string, stream: boolean): Record<string, unknown> {
    const requested = request as CompletionRequest & {
      thinking?: unknown;
      reasoning?: unknown;
      reasoning_effort?: 'low' | 'medium' | 'high' | string;
    };
    const thinkingModel = /-thinking$/i.test(model);
    const upstreamModel = model.replace(/-thinking$/i, '');
    const explicitlyRequested = requested.thinking !== undefined
      || requested.reasoning !== undefined
      || requested.reasoning_effort !== undefined;
    const enabled = thinkingModel || explicitlyRequested;
    const body = upstreamBody(request, upstreamModel, stream);
    body.thinking = { type: enabled ? 'enabled' : 'disabled' };
    delete body.reasoning;
    return body;
  }
}