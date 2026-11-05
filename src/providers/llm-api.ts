import axios from 'axios';
import { OpenAIProvider } from './openai';
import { config } from '../config';
import type { Capability, ModelDetail } from '../core/types';

type CachedModels = { expiresAt: number; models: ModelDetail[] };
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const modelCache = new Map<string, CachedModels>();

/**\n * OpenAI-compatible LLM API provider.\n *\n * This is separate from the direct OpenAI provider because its endpoint and\n * credential belong to the user's LLM API account (for example, Arion).\n */
export class LlmApiProvider extends OpenAIProvider {
  name = 'LLM API';
  capabilities: Capability[] = ['chat', 'embeddings', 'vision', 'audio'];

  servesModel(): boolean {
    return false;
  }

  servesListedModels(capability: Capability): boolean {
    return capability === 'chat' || capability === 'embeddings' || capability === 'vision' || capability === 'audio';
  }

  async getModels(): Promise<ModelDetail[]> {
    const cacheKey = this.baseUrl;
    const cached = modelCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.models;
    try {
      const response = await axios.get(`${this.baseUrl}/models`, { headers: this.headers() });
      const models = (response.data?.data ?? []).map((model: any) => ({
        id: model.id,
        name: model.name,
        description: model.description,
        ...(Array.isArray(model.capabilities) ? { capabilities: model.capabilities } : {}),
        ...(model.pricing !== undefined ? { pricing: model.pricing } : {}),
        ...(model.input_price !== undefined ? { input_price: model.input_price } : {}),
        ...(model.output_price !== undefined ? { output_price: model.output_price } : {}),
      }));
      modelCache.set(cacheKey, { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, models });
      return models;
    } catch (error) {
      console.error('[LLM API] Failed to list models:', error);
      return cached?.models ?? [];
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
