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
  private modelsLoaded?: Promise<ModelDetail[]>;
  private ensureModelsPromise?: Promise<void>;
  private modelsLoadSucceeded = false;

  servesListedModels(capability: Capability): boolean {
    return capability === 'chat' || capability === 'embeddings' || capability === 'vision' || capability === 'audio';
  }

  async ensureModelsLoaded(): Promise<void> {
    if (this.modelsLoadSucceeded) return;
    if (!this.ensureModelsPromise) {
      this.ensureModelsPromise = this.getModels()
        .then(models => {
          this.cachedModels = models;
          this.modelsLoadSucceeded = true;
        })
        .catch(error => {
          this.ensureModelsPromise = undefined;
          this.modelsLoaded = undefined;
          this.modelsLoadSucceeded = false;
          throw error;
        });
    }
    await this.ensureModelsPromise;
  }

  getCachedModels(): ModelDetail[] {
    return this.cachedModels;
  }

  async getModels(): Promise<ModelDetail[]> {
    if (this.modelsLoadSucceeded) return this.cachedModels;
    if (this.modelsLoaded) return this.modelsLoaded;

    this.modelsLoaded = (async () => {
      try {
        const response = await axios.get(`${this.baseUrl}/models`, { headers: this.headers() });
        const models = (response.data?.data ?? []).map((model: any) => ({
          id: model.id,
          name: model.name,
          description: model.description,
          ...(Array.isArray(model.capabilities) ? { capabilities: model.capabilities } : {}),
        }));
        this.cachedModels = models;
        this.modelsLoadSucceeded = true;
        return models;
      } catch (error) {
        console.error('[LLM API] Failed to list models:', error);
        this.modelsLoaded = undefined;
        this.ensureModelsPromise = undefined;
        this.modelsLoadSucceeded = false;
        throw error;
      }
    })();

    return this.modelsLoaded;
  }

  defaultModelFor(capability: Capability): string | undefined {
    if (capability === 'chat') return this.defaultModel;
    return this.cachedModels.find(model => model.capabilities?.includes(capability))?.id;
  }

  constructor(
    apiKey: string = process.env.LLM_API_KEY || '',
    model: string = process.env.LLM_API_DEFAULT_MODEL || config.DEFAULT_MODELS.OPENAI,
    baseUrl: string = process.env.LLM_API_BASE_URL || '',
  ) {
    super(apiKey, model, baseUrl);
  }
}
