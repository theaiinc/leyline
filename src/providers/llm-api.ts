import axios from 'axios';
import { OpenAIProvider } from './openai';
import { config } from '../config';
import type { Capability, ModelDetail } from '../core/types';

/**
 * OpenAI-compatible LLM API provider.
 *
 * This is separate from the direct OpenAI provider because its endpoint and
 * credential belong to the user's LLM API account (for example, Arion).
 */
export class LlmApiProvider extends OpenAIProvider {
  name = 'LLM API';
  // A gateway: model support comes from its published model list; it never claims `auto`.
  // The gateway may expose multimodal models; Router filters these against the listed model metadata.
  capabilities: Capability[] = ['chat', 'embeddings', 'vision', 'audio'];

  servesModel(): boolean {
    return false;
  }

  servesListedModels(capability: Capability): boolean {
    // Gateway chat models may advertise vision/audio per model in /models.
    // Embeddings remain a listed-model capability as well.
    return capability === 'chat' || capability === 'embeddings' || capability === 'vision' || capability === 'audio';
  }

  async getModels(): Promise<ModelDetail[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/models`, { headers: this.headers() });
      return (response.data?.data ?? []).map((model: any) => ({
        id: model.id,
        name: model.name,
        description: model.description,
        ...(Array.isArray(model.capabilities) ? { capabilities: model.capabilities } : {}),
      }));
    } catch (error) {
      console.error('[LLM API] Failed to list models:', error);
      return [];
    }
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
