import axios from 'axios';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../core/types';
import { config } from '../config';

export class OpenAIProvider implements Provider {
  name = 'OpenAI';
  defaultModel: string;
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(
    apiKey: string = process.env.OPENAI_API_KEY || '',
    model: string = config.DEFAULT_MODELS.OPENAI,
    baseUrl: string = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.defaultModel = model;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  async getModels(): Promise<ModelDetail[]> {
    if (!this.apiKey) return [];

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
      console.error('[OpenAI] Failed to list models:', error);
      return this.defaultModel ? [{ id: this.defaultModel, name: this.defaultModel }] : [];
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await axios.post(
      `${this.baseUrl}/chat/completions`,
      {
        model: request.model || this.model,
        messages: request.messages,
        stream: false,
      },
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
      {
        model: request.model || this.model,
        messages: request.messages,
        stream: true,
      },
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
            const data = JSON.parse(line.replace('data: ', ''));
            yield data;
          } catch {
            // skip partial chunks
          }
        }
      }
    }
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }
}
