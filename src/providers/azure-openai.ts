import OpenAI from 'openai';
import { AzureOpenAI } from 'openai/azure';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail, Capability, EmbeddingRequest, EmbeddingResult } from '../core/types';
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
/**
 * Deployments that refused reasoning together with function tools on /chat/completions (gpt-5.6-luna: "Function
 * tools with reasoning_effort are not supported … set reasoning_effort to 'none'"). Coding agents send both.
 */
const NO_REASONING_WITH_TOOLS = new Set<string>();

/** Run a chat call; if the deployment refuses reasoning with tools, remember it and retry once with reasoning off. */
export async function withToolReasoningFallback<T>(params: Record<string, unknown>, call: () => Promise<T>, deployment = String(params.model ?? '')): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const refused = (error as { status?: number }).status === 400 && /reasoning_effort/i.test(message) && /tool/i.test(message);
    if (!refused || !params.tools || params.reasoning_effort === 'none') throw error;
    NO_REASONING_WITH_TOOLS.add(deployment);
    params.reasoning_effort = 'none';
    return call();
  }
}

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
  /** An embeddings deployment on the same resource (AZURE_OPENAI_EMBEDDING_DEPLOYMENT); unset: no embeddings. */
  embeddingDeployment = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || '';
  capabilities: Capability[] = ['chat', 'embeddings'];

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
    return [
      ...(this.defaultModel ? [{ id: this.defaultModel, name: this.defaultModel, description: 'Azure OpenAI deployment' }] : []),
      ...(this.embeddingDeployment ? [{ id: this.embeddingDeployment, name: this.embeddingDeployment, description: 'Azure OpenAI embeddings deployment' }] : []),
    ];
  }

  /** Embeddings are served by the embeddings deployment, asked for by its name. */
  servesModel(capability: Capability, model: string): boolean {
    return capability === 'embeddings' && Boolean(this.embeddingDeployment) && model === this.embeddingDeployment;
  }

  defaultModelFor(capability: Capability): string | undefined {
    if (capability === 'chat') return this.defaultModel;
    return capability === 'embeddings' ? this.embeddingDeployment || undefined : undefined;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    try {
      // No fixed deployment on this client: the legacy API takes the deployment from `model`.
      const client = this.useOpenAICompatibleEndpoint
        ? new OpenAI({ baseURL: this.endpoint, apiKey: this.apiKey })
        : new AzureOpenAI({ baseURL: `${this.endpoint}/openai`, apiKey: this.apiKey, apiVersion: this.apiVersion });
      const response = await client.embeddings.create({
        model: request.model,
        input: request.input,
        encoding_format: 'float',
        ...(request.dimensions ? { dimensions: request.dimensions } : {}),
      });
      const data = [...response.data].sort((a, b) => a.index - b.index);
      return {
        embeddings: data.map(d => d.embedding as number[]),
        model: response.model || request.model,
        ...(response.usage?.prompt_tokens ? { usage: { prompt_tokens: response.usage.prompt_tokens, total_tokens: response.usage.total_tokens } } : {}),
      };
    } catch (error) {
      throw toProviderError(error);
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    try {
      const client = this.getClient();
      const params = this.chatParams(request, false);
      const response = await withToolReasoningFallback(params, () => client.chat.completions.create(
        params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      ), this.deploymentFor(request));
      return response as unknown as CompletionResponse;
    } catch (error) {
      throw toProviderError(error);
    }
  }

  private deploymentFor(request: CompletionRequest): string {
    return this.deployment || request.model;
  }

  /** The chat params for this deployment; reasoning off up front for models known to reject it with tools. */
  private chatParams(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const params = prepareAzureChatParams(request, stream, this.deployment || request.model, this.useOpenAICompatibleEndpoint);
    if (params.tools && params.reasoning_effort && NO_REASONING_WITH_TOOLS.has(this.deploymentFor(request))) {
      params.reasoning_effort = 'none';
    }
    return params;
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    try {
      const client = this.getClient();
      const params = this.chatParams(request, true);
      const stream = await withToolReasoningFallback(params, () => client.chat.completions.create(
        params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      ), this.deploymentFor(request));

      for await (const chunk of stream) {
        const normalized = chunk as unknown as StreamChunk & {
          usage?: StreamChunk['usage'] & {
            prompt_tokens_details?: { cached_tokens?: number };
            cached_tokens?: number;
          };
        };
        const cachedTokens = normalized.usage?.cached_tokens
          ?? normalized.usage?.prompt_tokens_details?.cached_tokens;
        if (normalized.usage && cachedTokens !== undefined) {
          const { prompt_tokens_details: _promptTokensDetails, ...usage } = normalized.usage;
          normalized.usage = {
            ...usage,
            cached_tokens: cachedTokens,
          };
        }
        yield normalized;
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
