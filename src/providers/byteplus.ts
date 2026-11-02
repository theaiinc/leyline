import { OpenAIProvider } from './openai';
import { config } from '../config';

/** ModelArk model IDs served by this provider. Extend via BYTEPLUS_ARK_MODEL_IDS. */
export const BYTEPLUS_MODEL_IDS = (process.env.BYTEPLUS_ARK_MODEL_IDS || 'deepseek-v4-1-flash-261017')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

/** BytePlus ModelArk's OpenAI-compatible chat provider. */
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
    return capability === 'chat' && BYTEPLUS_MODEL_IDS.includes(model);
  }

  defaultModelFor(capability: 'chat' | 'embeddings' | 'transcription' | 'speech'): string | undefined {
    return capability === 'chat' ? this.defaultModel : undefined;
  }
}