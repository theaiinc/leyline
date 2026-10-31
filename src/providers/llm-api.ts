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
  // The gateway's model list is authoritative for media capabilities. It still
  // advertises chat/embeddings at provider level so ordinary gateway models work,
  // but media must be selected only when the model itself lists the capability.
  capabilities: Capability[] = ['chat', 'embeddings'];

  servesModel(capability: Capability, model: string): boolean {
    return this.cachedModels.some(entry => entry.id === model && entry.capabilities?.includes(capability));
  }

  private cachedModels: ModelDetail[] = [];

  servesListedModels(capability: Capability): boolean {
    return capability === 'chat' || capability === 'embeddings';
  }

  async getModels(): Promise<ModelDetail[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/models`, { headers: this.headers() });
      const models = (response.data?.data ?? []).map((model: any) => ({
        id: model.id,
        name: model.name,
        description: model.description,
        ...(Array.isArray(model.capabilities) ? { capabilities: model.capabilities } : {}),
      }));
      this.cachedModels = models;
      return models;
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
