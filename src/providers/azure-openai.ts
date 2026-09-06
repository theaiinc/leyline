import OpenAI from 'openai';
import { AzureOpenAI } from 'openai/azure';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../core/types';
import { config } from '../config';
import { prepareAzureChatParams } from './azure-request';
import type { InstanceFamilyDefinition } from '../core/provider-instances';

function toProviderError(error: unknown): unknown {
  const candidate = error as {
    status?: number;
    message?: string;
    error?: unknown;
  };

  if (typeof candidate?.status === 'number') {
    return {
      message: candidate.message || 'Request failed',
      response: {
        status: candidate.status,
        data: candidate.error ?? { error: { message: candidate.message } },
      },
    };
  }

  return error;
}

/**
 * Azure OpenAI chat completions provider.
 *
 * Uses the official `openai` SDK (`OpenAI` for v1-compatible endpoints,
 * `AzureOpenAI` for legacy deployment URLs) so streaming, tool calls,
 * and Cursor passthrough fields are handled by the library — not raw axios.
 */
export class AzureOpenAIProvider implements Provider {
  name = 'AzureOpenAI';
  family = 'AzureOpenAI' as const;
  label = 'AzureOpenAI';
  defaultModel: string;
  private apiKey: string;
  private endpoint: string;
  private apiVersion: string;
  private deployment: string;
  private useOpenAICompatibleEndpoint: boolean;
  private client: OpenAI | null = null;

  constructor(
    apiKey: string = process.env.AZURE_OPENAI_API_KEY || '',
    endpoint: string = process.env.AZURE_OPENAI_BASE_URL || process.env.AZURE_OPENAI_ENDPOINT || '',
    deployment: string = process.env.AZURE_OPENAI_DEPLOYMENT || config.DEFAULT_MODELS.AZURE_OPENAI,
    apiVersion: string = process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
  ) {
    this.apiKey = apiKey;
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.deployment = deployment;
    this.apiVersion = apiVersion;
    this.defaultModel = deployment;
    this.useOpenAICompatibleEndpoint = Boolean(process.env.AZURE_OPENAI_BASE_URL)
      || /\/openai\/v1\/?$/.test(endpoint);
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey && this.endpoint && this.deployment);
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
    this.client = null;
  }

  hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  getRuntimeConfig(): Record<string, string | boolean | undefined> {
    return {
      baseUrl: this.endpoint,
      model: this.deployment,
      baseUrlConfigured: Boolean(this.endpoint),
      openAICompatible: this.useOpenAICompatibleEndpoint,
    };
  }

  setRuntimeConfig(runtime: Record<string, string | undefined>): void {
    if (typeof runtime.baseUrl === 'string') {
      this.endpoint = runtime.baseUrl.trim().replace(/\/+$/, '');
      this.useOpenAICompatibleEndpoint = /\/openai\/v1\/?$/.test(this.endpoint);
    }
    if (typeof runtime.model === 'string') {
      this.deployment = runtime.model.trim();
      this.defaultModel = this.deployment;
    }
    this.client = null;
  }

  async getModels(): Promise<ModelDetail[]> {
    return this.defaultModel
      ? [{ id: this.defaultModel, name: this.defaultModel, description: 'Azure OpenAI deployment' }]
      : [];
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    try {
      const client = this.getClient();
      const params = prepareAzureChatParams(
        request,
        false,
        this.deployment || request.model,
        this.useOpenAICompatibleEndpoint,
      );
      const response = await client.chat.completions.create(
        params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      );
      return response as unknown as CompletionResponse;
    } catch (error) {
      throw toProviderError(error);
    }
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      const client = this.getClient();
      const params = prepareAzureChatParams(
        request,
        true,
        this.deployment || request.model,
        this.useOpenAICompatibleEndpoint,
      );
      const stream = await client.chat.completions.create(
        params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      );

      for await (const chunk of stream) {
        yield chunk as unknown as StreamChunk;
      }
    } catch (error) {
      throw toProviderError(error);
    }
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = this.createClient();
    }
    return this.client;
  }

  private createClient(): OpenAI {
    if (this.useOpenAICompatibleEndpoint) {
      return new OpenAI({
        baseURL: this.endpoint,
        apiKey: this.apiKey,
      });
    }

    // Pass `baseURL` (computed ourselves) instead of `endpoint`: the SDK's `AzureOpenAI`
    // constructor defaults `baseURL` from the global `OPENAI_BASE_URL` env var, and throws
    // "baseURL and endpoint are mutually exclusive" if that env var is set (e.g. for an
    // unrelated OpenAI-compatible provider) while `endpoint` is also passed explicitly.
    return new AzureOpenAI({
      baseURL: `${this.endpoint}/openai`,
      apiKey: this.apiKey,
      deployment: this.deployment,
      apiVersion: this.apiVersion,
    });
  }

  /**
   * Builds an additional named Azure instance (distinct endpoint/key/deployment).
   * When `id` is set, `name`/`label` are suffixed so this instance coexists
   * with the env-configured default (whose `name` stays the bare `'AzureOpenAI'`).
   */
  static forInstance(cfg: {
    id?: string;
    label?: string;
    endpoint?: string;
    deployment?: string;
    apiKey?: string;
    apiVersion?: string;
  }): AzureOpenAIProvider {
    const provider = new AzureOpenAIProvider(
      cfg.apiKey ?? '',
      cfg.endpoint ?? '',
      cfg.deployment ?? '',
      cfg.apiVersion || '2024-10-21',
    );
    if (cfg.id) {
      provider.name = `AzureOpenAI:${cfg.id}`;
      provider.label = cfg.label || cfg.id;
    }
    return provider;
  }
}

export const azureOpenAIInstanceFamily: InstanceFamilyDefinition = {
  family: 'AzureOpenAI',
  baseName: 'AzureOpenAI',
  displayName: 'Azure OpenAI',
  fields: [
    { key: 'endpoint', label: 'Endpoint', role: 'runtimeBaseUrl', required: true },
    { key: 'deployment', label: 'Deployment', role: 'runtimeModel', required: true },
    { key: 'apiKey', label: 'API key', role: 'secret', required: true },
    { key: 'apiVersion', label: 'API version', role: 'extra', placeholder: '2024-10-21' },
  ],
  namingHint: cfg => ({ endpoint: cfg.endpoint || '', deployment: cfg.deployment || '' }),
  create: cfg => AzureOpenAIProvider.forInstance(cfg),
};
