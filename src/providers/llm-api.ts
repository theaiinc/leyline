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
type CapabilityResolution = { capabilities?: Capability[]; capabilitySource?: 'metadata' | 'family-fallback' | 'metadata+family-fallback' };

/**
 * LLM API normally returns OpenAI-compatible model records, but gateways differ
 * in where they put modality metadata. Keep this resolver in one place so the
 * public model list and auto-router cannot disagree.
 *
 * `capabilitySource` is intentionally exposed on each model: it tells clients
 * whether the gateway supplied modality metadata or Leyline used this documented
 * compatibility table because the gateway omitted it.
 */
function modelCapabilities(model: any): CapabilityResolution {
  const id = String(model.id ?? '').toLowerCase();
  const declared = Array.isArray(model.capabilities) ? model.capabilities : [];
  const metadata = [
    model.input_modalities,
    model.architecture?.input_modalities,
    model.modalities,
    model.architecture?.modalities,
    model.input?.modalities,
    model.architecture?.input?.modalities,
  ].find(value => Array.isArray(value));

  const modalities = Array.isArray(metadata)
    ? metadata.map(value => typeof value === 'string' ? value : value?.type ?? value?.modality)
      .filter((value): value is string => Boolean(value))
      .map(value => value.toLowerCase())
    : [];
  const capabilities = new Set<Capability>(declared.filter((value: unknown): value is Capability =>
    ['chat', 'vision', 'audio', 'embeddings', 'transcription', 'speech'].includes(String(value)),
  ));
  if (modalities.some(value => ['image', 'vision', 'image_url'].includes(value))) capabilities.add('vision');
  if (modalities.some(value => ['audio', 'input_audio', 'audio_url'].includes(value))) capabilities.add('audio');

  // Keep the family defaults even when a gateway supplies incomplete modality
  // metadata. The two sources are additive so a text-only listing cannot hide
  // known image/audio support.
  const metadataContributed = modalities.length > 0;
  const beforeFamily = new Set(capabilities);
  if (/gemini-/.test(id)) { capabilities.add('vision'); capabilities.add('audio'); }
  else if (/^(openai\/)?(gpt-4o|gpt-5)/.test(id)) capabilities.add('vision');
  else if (/^(anthropic\/)?claude-/.test(id)) capabilities.add('vision');
  else if (/(whisper|stt|transcri)/.test(id)) capabilities.add('audio');
  const familyContributed = [...capabilities].some(capability => !beforeFamily.has(capability));
  const capabilitySource = metadataContributed && familyContributed
    ? 'metadata+family-fallback'
    : familyContributed ? 'family-fallback' : metadataContributed ? 'metadata' : undefined;
  return { capabilities: capabilities.size ? [...capabilities] : undefined, capabilitySource };
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
          ...modelCapabilities(model),
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
