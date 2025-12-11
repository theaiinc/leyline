import { GoogleGenerativeAI } from '@google/generative-ai';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../core/types';
import axios from 'axios';
import dotenv from 'dotenv';
import { config } from '../config';

dotenv.config();

export class GeminiProvider implements Provider {
  name = 'Gemini';
  defaultModel: string;
  private client: GoogleGenerativeAI;
  private model: string;

  constructor(apiKey: string = process.env.GEMINI_API_KEY || '', model: string = config.DEFAULT_MODELS.GEMINI) {
    this.client = new GoogleGenerativeAI(apiKey);
    this.model = model;
    this.defaultModel = model;
  }

  async isAvailable(): Promise<boolean> {
    return true; // Simplified check
  }

  async getModels(): Promise<ModelDetail[]> {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return [];
      try {
          const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
          return response.data.models
              .filter((m: any) => m.supportedGenerationMethods.includes('generateContent'))
              .map((m: any) => ({
                  id: m.name.replace('models/', ''),
                  name: m.displayName,
                  description: m.description
              }));
      } catch (error) {
          console.error('[Gemini] Failed to list models:', error);
          return [{ id: this.defaultModel, name: 'Default Gemini Model' }];
      }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = this.client.getGenerativeModel({ model: request.model || this.model });
    const prompt = request.messages.map(m => `${m.role}: ${m.content}`).join('\n'); // Simple truncation for now, better chat history handling could be added

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    return {
      id: 'gemini-' + Date.now(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 0, // Gemini SDK doesn't always return this easily without extra calls
        completion_tokens: 0,
        total_tokens: 0
      }
    };
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const model = this.client.getGenerativeModel({ model: request.model || this.model });
    const prompt = request.messages.map(m => `${m.role}: ${m.content}`).join('\n');

    const result = await model.generateContentStream(prompt);
    
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      yield {
        id: 'gemini-' + Date.now(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: this.model,
        choices: [{
            index: 0,
            delta: { content: chunkText },
            finish_reason: null
        }]
      };
    }
     yield {
        id: 'gemini-' + Date.now(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: this.model,
        choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop'
        }]
      };
  }
}
