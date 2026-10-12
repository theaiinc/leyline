import { OpenAIProvider } from './openai';
import { config } from '../config';
import type { Capability } from '../core/types';

/**
 * OpenAI-compatible LLM API provider.
 *
 * This is separate from the direct OpenAI provider because its endpoint and
 * credential belong to the user's LLM API account (for example, Arion).
 */
export class LlmApiProvider extends OpenAIProvider {
  name = 'LLM API';
  // A gateway: it serves the embedding models it lists (GET /models), if any; never audio, never `auto`.
  capabilities: Capability[] = ['chat', 'embeddings'];

  servesModel(): boolean {
    return false;
  }

  servesListedModels(capability: Capability): boolean {
    return capability === 'embeddings';
  }

  defaultModelFor(capability: Capability): string | undefined {
    return capability === 'chat' ? this.defaultModel : undefined;
  }

  constructor(
    apiKey: string = process.env.LLM_API_KEY || '',
    model: string = process.env.LLM_API_DEFAULT_MODEL || config.DEFAULT_MODELS.OPENAI,
    baseUrl: string = process.env.LLM_API_BASE_URL || '',
  ) {
    super(apiKey, model, baseUrl);
  }
}
