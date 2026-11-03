import { OpenAIProvider } from './openai';
import type { ModelDetail } from '../core/types';
import { config } from '../config';

/**
 * BytePlus ModelArk's OpenAI-compatible provider for chat and embeddings.
 * Reasoning-only responses are promoted to content when the upstream omits content.
 */
const BYTEPLUS_PRICING_SOURCE = 'https://www.byteplus.com/en/product/modelark/pricing';

const BYTEPLUS_CATALOG: Array<ModelDetail & { pricing: { input: number; output: number; cached_input?: number } }> = [
  { id: 'seed-2-0-lite-260428', name: 'Seed 2.0 Lite', pricing: { input: 0.4, output: 1.6 } },
  { id: 'seed-2-0-mini-260428', name: 'Seed 2.0 Mini', pricing: { input: 0.4, output: 1.6 } },
  { id: 'deepseek-v4-1-flash-261017', name: 'DeepSeek V4.1 Flash', pricing: { input: 0.14, output: 0.28, cached_input: 0.028 } },
  { id: 'deepseek-v4-flash-ga-260731', name: 'DeepSeek V4 Flash', pricing: { input: 0.14, output: 0.28, cached_input: 0.028 } },
  { id: 'glm-5-3-flash-260828', name: 'GLM-5.3 Flash', pricing: { input: 0.2, output: 1.1 } },
].map((model) => ({ ...model, source: BYTEPLUS_PRICING_SOURCE }));

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

  defaultModelFor(capability: 'chat' | 'embeddings' | 'transcription' | 'speech'): string | undefined {
    return capability === 'chat' ? this.defaultModel : undefined;
  }
}