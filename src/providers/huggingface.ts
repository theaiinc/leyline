import { HfInference } from '@huggingface/inference';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../core/types';
import dotenv from 'dotenv';
import { config } from '../config';

dotenv.config();

export class HuggingFaceProvider implements Provider {
  name = 'HuggingFace';
  defaultModel: string;
  private client: HfInference;
  private model: string; 

  constructor(apiKey: string = process.env.HF_API_KEY || '', model: string = config.DEFAULT_MODELS.HF) {
    this.client = new HfInference(apiKey);
    this.model = model;
    this.defaultModel = model;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getModels(): Promise<ModelDetail[]> {
      return [
          { id: 'microsoft/Phi-3-mini-4k-instruct', name: 'Phi-3 Mini', description: 'Lightweight, state-of-the-art open model by Microsoft' },
          { id: 'mistralai/Mistral-7B-Instruct-v0.3', name: 'Mistral 7B v0.3', description: 'Powerful 7B model for chat and code' },
          { id: 'HuggingFaceH4/zephyr-7b-beta', name: 'Zephyr 7B Beta', description: 'Fine-tuned version of Mistral 7B, great for chat' },
          { id: 'google/gemma-7b-it', name: 'Gemma 7B IT', description: 'Google open model, instruction tuned' },
          { id: 'meta-llama/Meta-Llama-3-8B-Instruct', name: 'Llama 3 8B', description: 'Meta latest 8B model, high performance' }
      ];
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    // HF Inference often prefers 'text-generation' or 'chat-completion' depending on the task
    // Using chatCompletion if available or textGeneration with formatting
    const result = await this.client.chatCompletion({
        model: request.model || this.model,
        messages: request.messages,
        max_tokens: 1024
    });

    return {
        id: 'hf-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: result.model || this.model,
        choices: result.choices.map(c => ({
            index: c.index,
            message: { ...c.message, content: c.message.content || '' },
            finish_reason: c.finish_reason || 'stop'
        })),
        usage: result.usage
    };
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const stream = this.client.chatCompletionStream({
        model: request.model || this.model,
        messages: request.messages,
        max_tokens: 1024
    });

    for await (const chunk of stream) {
        yield {
            id: 'hf-' + Date.now(),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: chunk.model || this.model,
            choices: chunk.choices.map(c => ({
                index: c.index,
                delta: { ...c.delta, content: c.delta.content || undefined },
                finish_reason: c.finish_reason || null
            }))
        };
    }
  }
}
