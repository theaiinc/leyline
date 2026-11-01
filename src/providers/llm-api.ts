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
const AUDIO_MODEL_OVERRIDES = new Set([
  'gpt-audio',
  'gpt-audio-mini',
  'openai/gpt-audio',
  'openai/gpt-audio-mini',
]);

function modelCapabilities(model: any): Capability[] | undefined {
  const capabilities = Array.isArray(model.capabilities) ? [...model.capabilities] as Capability[] : [];
  const modalities = Array.isArray(model.input_modalities) ? model.input_modalities : [];
  if (modalities.includes('audio') || AUDIO_MODEL_OVERRIDES.has(String(model.id))) {
    if (!capabilities.includes('audio')) capabilities.push('audio');
  }
  return capabilities.length ? capabilities : undefined;
}

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
  private modelsLoadedAt = 0;
  private ensureModelsPromise?: Promise<void>;
  private static readonly MODELS_CACHE_TTL_MS = 5 * 60_000;

  servesListedModels(capability: Capability): boolean {
    return this.cachedModels.some(model => {
      if (capability === 'chat' || capability === 'embeddings') return true;
      return model.capabilities?.includes(capability) ?? false;
    });
  }

  async ensureModelsLoaded(): Promise<void> {
    const fresh = this.modelsLoadedAt > 0 && Date.now() - this.modelsLoadedAt < LlmApiProvider.MODELS_CACHE_TTL_MS;
    if (fresh) return;
    if (!this.ensureModelsPromise) {
      this.ensureModelsPromise = this.getModels()
        .then(models => {
          // Keep the shared loader authoritative even when getModels is mocked
          // or supplied by a subclass: callers must observe the same snapshot.
          this.cachedModels = models;
          this.modelsLoadedAt = Date.now();
        })
        .catch(error => {
          this.ensureModelsPromise = undefined;
          throw error;
        });
    }
    await this.ensureModelsPromise;
  }

  getCachedModels(): ModelDetail[] {
    return this.cachedModels;
  }

  servesListedModel(capability: Capability, model: string): boolean {
    if (capability === 'chat' || capability === 'embeddings') {
      return this.cachedModels.some(entry => entry.id === model);
    }
    return this.cachedModels.some(entry => entry.id === model && entry.capabilities?.includes(capability));
  }

  async getModels(): Promise<ModelDetail[]> {
    if (this.modelsLoadedAt > 0 && Date.now() - this.modelsLoadedAt < LlmApiProvider.MODELS_CACHE_TTL_MS) return this.cachedModels;
    if (this.modelsLoaded) return this.modelsLoaded;

    this.modelsLoaded = (async () => {
      try {
        const response = await axios.get(`${this.baseUrl}/models`, { headers: this.headers() });
        const models = (response.data?.data ?? []).map((model: any) => ({
          id: model.id,
          name: model.name,
          description: model.description,
          ...(modelCapabilities(model) ? { capabilities: modelCapabilities(model) } : {}),
        }));
        this.cachedModels = models;
        this.modelsLoadedAt = Date.now();
        return models;
      } catch (error) {
        console.error('[LLM API] Failed to list models:', error);
        this.modelsLoaded = undefined;
        this.ensureModelsPromise = undefined;
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
