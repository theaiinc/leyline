import axios from 'axios';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../core/types';
import { config } from '../config';

export class OllamaProvider implements Provider {
  name = 'Ollama';
  defaultModel: string;
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string = 'http://localhost:11434', model: string = config.DEFAULT_MODELS.OLLAMA) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.defaultModel = model;
  }

  async isAvailable(): Promise<boolean> {
    try {
        await axios.get('http://localhost:11434/api/tags');
        return true;
    } catch {
        return false;
    }
  }

  async getModels(): Promise<ModelDetail[]> {
      try {
          const response = await axios.get('http://localhost:11434/api/tags');
          return response.data.models.map((m: any) => ({
              id: m.name,
              name: m.name,
              description: m.details ? `${m.details.parameter_size} parameters, ${m.details.quantization_level} quant` : 'Local Ollama Model'
          }));
      } catch (error) {
           console.error('[Ollama] Failed to list models:', error);
           return [];
      }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await axios.post(`${this.baseUrl}/api/chat`, {
        model: request.model || this.model,
        messages: request.messages,
        stream: false
    });

    return {
        id: 'ollama-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: this.model,
        choices: [{
            index: 0,
            message: response.data.message,
            finish_reason: 'stop'
        }],
        usage: {
            prompt_tokens: response.data.prompt_eval_count,
            completion_tokens: response.data.eval_count,
            total_tokens: (response.data.prompt_eval_count || 0) + (response.data.eval_count || 0)
        }
    };
  }

   async *completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const response = await axios.post(`${this.baseUrl}/api/chat`, {
        model: request.model || this.model,
        messages: request.messages,
        stream: true
    }, {
        responseType: 'stream'
    });

    const stream: any = response.data;
    for await (const chunk of stream) {
        const lines = chunk.toString().split('\n').filter((line: string) => line.trim() !== '');
        for (const line of lines) {
             try {
                const data = JSON.parse(line);
                yield {
                    id: 'ollama-' + Date.now(),
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: this.model,
                    choices: [{
                        index: 0,
                        delta: { content: data.message?.content },
                        finish_reason: data.done ? 'stop' : null
                    }]
                };
             } catch (e) {
                 // ignore
             }
        }
    }
  }
}
