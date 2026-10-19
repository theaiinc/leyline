import { GoogleGenerativeAI, type Part } from '@google/generative-ai';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail, Capability, EmbeddingRequest, EmbeddingResult, ChatMessage } from '../core/types';
import { isTextPart, parseDataUrl } from '../core/content';
import { openAIEmbeddings } from '../core/media';
import axios from 'axios';
import { config } from '../config';

export class GeminiProvider implements Provider {
  name = 'Gemini';
  capabilities: Capability[] = ['chat', 'embeddings'];
  defaultModel: string;
  private apiKey: string;
  private client: GoogleGenerativeAI;
  private model: string;

  constructor(apiKey: string = process.env.GEMINI_API_KEY || '', model: string = config.DEFAULT_MODELS.GEMINI) {
    this.apiKey = apiKey;
    this.client = new GoogleGenerativeAI(apiKey);
    this.model = model;
    this.defaultModel = model;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
    this.client = new GoogleGenerativeAI(apiKey);
  }

  hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  servesModel(capability: Capability, model: string): boolean {
    return capability === 'embeddings' && /^(gemini-embedding-|text-embedding-00|embedding-00)/.test(model);
  }

  defaultModelFor(capability: Capability): string | undefined {
    if (capability === 'chat') return this.defaultModel;
    return capability === 'embeddings' ? 'gemini-embedding-001' : undefined;
  }

  /** Through Gemini's OpenAI-compatible endpoint (same request and response as OpenAI's). */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResult> {
    return openAIEmbeddings(this.name, 'https://generativelanguage.googleapis.com/v1beta/openai/embeddings', { Authorization: `Bearer ${this.apiKey}` }, request);
  }

  /** Images, audio and files it can inline (data: URLs, base64 audio); a remote image URL it can't fetch. */
  acceptsNonTextContent(request: CompletionRequest): boolean {
    return request.messages.every(m => !Array.isArray(m.content) || m.content.every(p => isTextPart(p) || inlinePart(p) !== null));
  }

  async getModels(): Promise<ModelDetail[]> {
      const apiKey = this.apiKey;
      if (!apiKey) return [];
      try {
          const response = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
          return response.data.models
              .filter((m: any) => m.supportedGenerationMethods.includes('generateContent') || m.supportedGenerationMethods.includes('embedContent'))
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
    const prompt = geminiPrompt(request.messages);

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
    const prompt = geminiPrompt(request.messages);

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

/** A non-text content part as Gemini inline data, or null when it can't be (a remote URL, an unknown part type). */
function inlinePart(part: unknown): Part | null {
  const p = part as { type?: string; image_url?: { url?: string }; input_audio?: { data?: string; format?: string }; file?: { file_data?: string } };
  if (p?.type === 'image_url' || p?.type === 'file') {
    const parsed = parseDataUrl(String(p.type === 'image_url' ? p.image_url?.url ?? '' : p.file?.file_data ?? ''));
    return parsed ? { inlineData: { mimeType: parsed.mimeType, data: parsed.data } } : null;
  }
  if (p?.type === 'input_audio' && p.input_audio?.data) {
    return { inlineData: { mimeType: `audio/${p.input_audio.format || 'wav'}`, data: p.input_audio.data } };
  }
  return null;
}

/**
 * The conversation as one Gemini prompt: "role: text" lines, with images, audio and files inlined where they
 * appear. A text-only conversation stays a plain string.
 */
export function geminiPrompt(messages: ChatMessage[]): string | Array<string | Part> {
  const parts: Part[] = [];
  let text: string[] = [];
  const flush = () => {
    if (text.length) parts.push({ text: text.join('\n') });
    text = [];
  };
  for (const m of messages) {
    if (!Array.isArray(m.content)) {
      text.push(`${m.role}: ${m.content ?? ''}`);
      continue;
    }
    let line = `${m.role}:`;
    for (const part of m.content) {
      if (isTextPart(part)) {
        line += ` ${part.text}`;
        continue;
      }
      const inline = inlinePart(part);
      if (!inline) throw Object.assign(new Error(`Gemini can't take a ${part.type} part that isn't inline data`), { status: 400 });
      text.push(line);
      line = '';
      flush();
      parts.push(inline);
    }
    if (line) text.push(line);
  }
  flush();
  return parts.length === 1 && 'text' in parts[0] ? String(parts[0].text) : parts;
}
