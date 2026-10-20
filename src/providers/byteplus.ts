import { OpenAIProvider } from './openai';
import { config } from '../config';

/**
 * BytePlus ModelArk's OpenAI-compatible chat provider.
 * Model and pricing references: BytePlus ModelArk documentation
 * (https://docs.byteplus.com/en/docs/ModelArk/Overview), checked 2026-10-20.
 */
export class BytePlusProvider extends OpenAIProvider {
  name = 'BytePlus';
  family = 'BytePlus';
  capabilities: import('../core/types').Capability[] = ['chat'];

  constructor(
    apiKey: string = process.env.BYTEPLUS_ARK_API_KEY || '',
    model: string = config.DEFAULT_MODELS.BYTEPLUS_ARK,
    baseUrl: string = process.env.BYTEPLUS_ARK_BASE_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3',
  ) {
    super(apiKey, model, baseUrl);
  }

  servesModel(capability: 'chat' | 'embeddings' | 'transcription' | 'speech', model: string): boolean {
    return capability === 'chat' && /^(?:doubao|seed|deepseek|kimi)-/i.test(model);
  }

  defaultModelFor(capability: 'chat' | 'embeddings' | 'transcription' | 'speech'): string | undefined {
    return capability === 'chat' ? this.defaultModel : undefined;
  }
}