import axios from 'axios';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../core/types';
import { config } from '../config';
import { hydrateAxiosError } from '../core/api-errors';
import { sanitizeAzureMessages, sanitizeAzureRequestFields } from './azure-request';

/**
 * Azure OpenAI chat completions provider.
 *
 * Supports both Azure URL shapes:
 *   - OpenAI-compatible v1: https://...services.ai.azure.com/openai/v1
 *   - Legacy deployment path: https://...openai.azure.com
 */
export class AzureOpenAIProvider implements Provider {
  name = 'AzureOpenAI';
  defaultModel: string;
  private apiKey: string;
  private endpoint: string;
  private apiVersion: string;
  private deployment: string;
  private useOpenAICompatibleEndpoint: boolean;

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

  setRuntimeConfig(config: Record<string, string | undefined>): void {
    if (typeof config.baseUrl === 'string') {
      this.endpoint = config.baseUrl.trim().replace(/\/+$/, '');
      this.useOpenAICompatibleEndpoint = /\/openai\/v1\/?$/.test(this.endpoint);
    }
    if (typeof config.model === 'string') {
      this.deployment = config.model.trim();
      this.defaultModel = this.deployment;
    }
  }

  async getModels(): Promise<ModelDetail[]> {
    return this.defaultModel
      ? [{ id: this.defaultModel, name: this.defaultModel, description: 'Azure OpenAI deployment' }]
      : [];
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    try {
      const response = await axios.post(
        this.chatCompletionsUrl(request.model),
        this.payload(request, false),
        {
          headers: this.headers(),
          timeout: 300000,
        },
      );

      return response.data;
    } catch (error) {
      throw await hydrateAxiosError(error);
    }
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    let response;
    try {
      response = await axios.post(
        this.chatCompletionsUrl(request.model),
        this.payload(request, true),
        {
          headers: this.headers(),
          responseType: 'stream',
          timeout: 300000,
          validateStatus: (status) => status < 500,
        },
      );
    } catch (error) {
      throw await hydrateAxiosError(error);
    }

    if (response.status >= 400) {
      const hydrated = await hydrateAxiosError({
        isAxiosError: true,
        message: `Request failed with status code ${response.status}`,
        response: {
          status: response.status,
          statusText: response.statusText,
          data: response.data,
          headers: response.headers,
        },
      });
      throw hydrated;
    }

    const stream: any = response.data;
    for await (const chunk of stream) {
      const lines = chunk
        .toString()
        .split('\n')
        .filter((line: string) => line.trim() !== '');

      for (const line of lines) {
        if (line.includes('[DONE]')) return;
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.replace('data: ', ''));
            yield data;
          } catch {
            // skip partial chunks
          }
        }
      }
    }
  }

  private chatCompletionsUrl(model?: string): string {
    if (this.useOpenAICompatibleEndpoint) {
      return `${this.endpoint}/chat/completions`;
    }

    const deployment = encodeURIComponent(model || this.deployment);
    const apiVersion = encodeURIComponent(this.apiVersion);
    return `${this.endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  }

  private payload(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const deploymentModel = this.deployment || request.model;
    const payload: Record<string, unknown> = {
      messages: sanitizeAzureMessages(request.messages),
      stream,
      ...sanitizeAzureRequestFields(request),
    };

    if (this.useOpenAICompatibleEndpoint) {
      payload.model = deploymentModel;
    }

    return payload;
  }

  private headers(): Record<string, string> {
    if (this.useOpenAICompatibleEndpoint) {
      return {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      };
    }

    return {
      'api-key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }
}
