import axios from 'axios';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../core/types';
import { config } from '../config';
import { ModelRegistry } from '../core/model-registry';

export class OllamaProvider implements Provider {
  name = 'Ollama';
  defaultModel: string;
  private baseUrl: string;
  private model: string;
  private registry: ModelRegistry;

  constructor(
    baseUrl: string = process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    model: string = config.DEFAULT_MODELS.OLLAMA,
    registry: ModelRegistry = new ModelRegistry(),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.defaultModel = model;
    this.registry = registry;
  }

  async isAvailable(): Promise<boolean> {
    try {
      if (!(await this.isServerAvailable())) return false;
      return Boolean(await this.resolveInstalledModel(this.model));
    } catch {
      return false;
    }
  }

  async canHandle(request: CompletionRequest): Promise<boolean> {
    try {
      if (!(await this.isServerAvailable())) return false;
      const requested = request.model === 'auto' ? this.model : request.model;
      const variant = this.registry.lookupVariant(null, requested);
      if (variant && variant.provider !== 'ollama') {
        return false;
      }
      return Boolean(await this.resolveInstalledModel(requested));
    } catch {
      return false;
    }
  }

  async getModels(): Promise<ModelDetail[]> {
      try {
          const response = await axios.get(`${this.baseUrl}/api/tags`, { timeout: 5000 });
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
    const model = await this.requireInstalledModel(request.model === 'auto' ? this.model : request.model);
    const response = await axios.post(`${this.baseUrl}/api/chat`, {
        model,
        messages: request.messages,
        stream: false
    });

    return {
        id: 'ollama-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
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
    const model = await this.requireInstalledModel(request.model === 'auto' ? this.model : request.model);
    const response = await axios.post(`${this.baseUrl}/api/chat`, {
        model,
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
                    model,
                    choices: [{
                        index: 0,
                        delta: { content: data.message?.content },
                        finish_reason: data.done ? 'stop' : null
                    }]
                };
             } catch {
                 // ignore partial chunks
             }
        }
    }
  }

  private async isServerAvailable(): Promise<boolean> {
    try {
      await axios.get(`${this.baseUrl}/api/tags`, { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  private async resolveInstalledModel(requested: string): Promise<string | undefined> {
    const response = await axios.get(`${this.baseUrl}/api/tags`, { timeout: 5000 });
    const models = Array.isArray(response.data?.models) ? response.data.models : [];
    const normalized = requested.toLowerCase();

    const match = models.find((entry: { name?: string }) => {
      const name = String(entry.name || '').toLowerCase();
      return name === normalized || name.startsWith(`${normalized}:`);
    });

    return match?.name;
  }

  private async requireInstalledModel(requested: string): Promise<string> {
    const model = await this.resolveInstalledModel(requested);
    if (!model) {
      throw new Error(`Ollama model not found: ${requested}`);
    }
    return model;
  }
}
