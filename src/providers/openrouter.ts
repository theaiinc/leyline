import axios from 'axios';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../core/types';
import dotenv from 'dotenv';
import { config } from '../config';

dotenv.config();

export class OpenRouterProvider implements Provider {
  name = 'OpenRouter';
  defaultModel: string;
  private apiKey: string;
  private model: string;

  constructor(apiKey: string = process.env.OPENROUTER_API_KEY || '', model: string = config.DEFAULT_MODELS.OPENROUTER) {
    this.apiKey = apiKey;
    this.model = model;
    this.defaultModel = model;
  }

  async isAvailable(): Promise<boolean> {
     return !!process.env.OPENROUTER_API_KEY;
  }

  async getModels(): Promise<ModelDetail[]> {
      try {
          const response = await axios.get('https://openrouter.ai/api/v1/models');
          return response.data.data.map((m: any) => ({
              id: m.id,
              name: m.name,
              description: m.description
          }));
      } catch (error) {
          console.error('[OpenRouter] Failed to list models:', error);
          return [{ id: this.defaultModel, name: 'Default OpenRouter Model' }];
      }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: request.model || this.model,
        messages: request.messages,
      },
      {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/stevetran/ai-router', // Required by OpenRouter
        },
      }
    );

    return response.data;
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const response = await axios.post(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          model: request.model || this.model,
          messages: request.messages,
          stream: true
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://github.com/stevetran/ai-router',
          },
          responseType: 'stream'
        }
      );

      const stream: any = response.data;

      for await (const chunk of stream) {
        const lines = chunk.toString().split('\n').filter((line: string) => line.trim() !== '');
        for (const line of lines) {
            if (line.includes('[DONE]')) return;
            if (line.startsWith('data: ')) {
                try {
                const data = JSON.parse(line.replace('data: ', ''));
                yield data;
                } catch (e) {
                    // ignore parse errors for partial chunks
                }
            }
        }
      }
  }
}
