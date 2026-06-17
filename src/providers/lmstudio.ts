import axios from 'axios';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../core/types';

/**
 * LM Studio / any OpenAI-compatible local endpoint.
 *
 * Connects to any server that serves an OpenAI-compatible `/v1/chat/completions`
 * API, including LM Studio, Ollama (OpenAI mode), vLLM, etc.
 */
export class LMStudioProvider implements Provider {
  name = 'LMStudio';
  defaultModel: string;
  private baseUrl: string;
  private model: string;

  constructor(baseUrl?: string, model?: string) {
    this.baseUrl = (baseUrl || process.env.LMSTUDIO_BASE_URL || 'http://localhost:1234/v1').replace(/\/+$/, '');
    this.model = model || process.env.LMSTUDIO_MODEL || '';
    this.defaultModel = this.model;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await axios.get(`${this.baseUrl}/models`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async getModels(): Promise<ModelDetail[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/models`, { timeout: 5000 });
      return (response.data?.data || []).map((m: any) => ({
        id: m.id,
        name: m.id,
      }));
    } catch (error) {
      console.error('[LMStudio] Failed to list models:', error);
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
        headers: { 'Content-Type': 'application/json' },
        timeout: 300000, // 5 min for local models
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
        headers: { 'Content-Type': 'application/json' },
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
}
