import axios from 'axios';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../core/types';

/**
 * LiteLLM proxy provider.
 *
 * Leyline delegates OpenAI/Azure compatibility details to LiteLLM and forwards
 * OpenAI-compatible payloads without Azure-specific parameter shims.
 */
export class LiteLLMProvider implements Provider {
  name = 'LiteLLM';
  defaultModel: string;
  private baseUrl: string;
  private model: string;
  private apiKey: string;

  constructor(
    baseUrl: string = process.env.LITELLM_BASE_URL || 'http://127.0.0.1:4000/v1',
    model: string = process.env.LITELLM_MODEL || process.env.AZURE_OPENAI_DEFAULT_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.5',
    apiKey: string = process.env.LITELLM_API_KEY || 'not-needed',
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.defaultModel = model;
    this.apiKey = apiKey;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await axios.get(`${this.baseUrl}/models`, {
        headers: this.headers(),
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async getModels(): Promise<ModelDetail[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/models`, {
        headers: this.headers(),
        timeout: 30000,
      });
      return (response.data?.data || []).map((m: any) => ({
        id: m.id,
        name: m.id,
      }));
    } catch (error) {
      console.error('[LiteLLM] Failed to list models:', error);
      return this.defaultModel ? [{ id: this.defaultModel, name: this.defaultModel }] : [];
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await axios.post(
      `${this.baseUrl}/chat/completions`,
      this.payload(request, false),
      {
        headers: this.headers(),
        timeout: 300000,
      },
    );

    return response.data;
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const response = await axios.post(
      `${this.baseUrl}/chat/completions`,
      this.payload(request, true),
      {
        headers: this.headers(),
        responseType: 'stream',
        timeout: 300000,
      },
    );

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
            yield JSON.parse(line.replace('data: ', ''));
          } catch {
            // skip partial chunks
          }
        }
      }
    }
  }

  private payload(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const { model: requestedModel, stream: _stream, ...rest } = request;
    return {
      ...rest,
      model: requestedModel === 'auto' ? this.model : requestedModel || this.model,
      stream,
    };
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }
}
