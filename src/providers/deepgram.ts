import type {
  Capability, CompletionRequest, CompletionResponse, ModelDetail, Provider, StreamChunk,
  TranscriptionRequest, TranscriptionResult,
} from '../core/types';
import { upstreamError } from '../core/media';

const MODELS: ModelDetail[] = [
  { id: 'nova-3', name: 'Deepgram Nova-3', description: 'Speech-to-text (prerecorded)' },
  { id: 'nova-2', name: 'Deepgram Nova-2', description: 'Speech-to-text (prerecorded)' },
];

/**
 * Deepgram speech-to-text (prerecorded API, https://api.deepgram.com/v1/listen), answered in OpenAI's
 * transcription shape. Models: nova-3, nova-2 (and their variants such as nova-3-medical), also asked for as
 * deepgram/<model>. Key: DEEPGRAM_API_KEY, the dashboard, or an Arcana reference. No chat.
 */
export class DeepgramProvider implements Provider {
  name = 'Deepgram';
  capabilities: Capability[] = ['transcription'];
  defaultModel = 'nova-3';
  private apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string = process.env.DEEPGRAM_API_KEY || '', baseUrl: string = process.env.DEEPGRAM_BASE_URL || 'https://api.deepgram.com/v1') {
    this.apiKey = apiKey;
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
    return MODELS;
  }

  servesModel(capability: Capability, model: string): boolean {
    return capability === 'transcription' && /^(deepgram\/[\w.-]+|nova-[\w.-]+)$/.test(model);
  }

  defaultModelFor(capability: Capability): string | undefined {
    return capability === 'transcription' ? this.defaultModel : undefined;
  }

  async complete(_request: CompletionRequest): Promise<CompletionResponse> {
    throw new Error('Deepgram serves speech-to-text only');
  }

  // eslint-disable-next-line require-yield
  async *completeStream(_request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    throw new Error('Deepgram serves speech-to-text only');
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const model = request.model.replace(/^deepgram\//, '');
    const q = new URLSearchParams({ model, smart_format: 'true', punctuate: 'true' });
    if (request.language) q.set('language', request.language);
    else q.set('detect_language', 'true');
    // Utterances become the segments of verbose_json / srt / vtt.
    if (request.timestamps.segment) q.set('utterances', 'true');
    // OpenAI's `prompt` (context words) maps to Deepgram keyterms on Nova-3.
    if (request.prompt && model.startsWith('nova-3')) {
      for (const term of request.prompt.split(/[,\n]/).map(t => t.trim()).filter(Boolean).slice(0, 50)) q.append('keyterm', term);
    }
    const res = await fetch(`${this.baseUrl}/listen?${q}`, {
      method: 'POST',
      headers: { Authorization: `Token ${this.apiKey}`, 'Content-Type': request.file.contentType || 'application/octet-stream' },
      body: request.file.data as BodyInit,
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw await upstreamError(this.name, res);
    return fromDeepgram(await res.json() as DeepgramResponse);
  }
}

type DeepgramWord = { word: string; punctuated_word?: string; start: number; end: number };
type DeepgramResponse = {
  metadata?: { duration?: number };
  results?: {
    channels?: Array<{ detected_language?: string; alternatives?: Array<{ transcript?: string; words?: DeepgramWord[]; languages?: string[] }> }>;
    utterances?: Array<{ start: number; end: number; transcript: string }>;
  };
};

/** Deepgram's prerecorded response as a transcript: first channel's best alternative. */
export function fromDeepgram(body: DeepgramResponse): TranscriptionResult {
  const channel = body.results?.channels?.[0];
  const best = channel?.alternatives?.[0];
  const words = best?.words?.map(w => ({ word: w.punctuated_word ?? w.word, start: w.start, end: w.end }));
  const language = channel?.detected_language ?? best?.languages?.[0];
  return {
    text: best?.transcript ?? '',
    ...(language ? { language } : {}),
    ...(body.metadata?.duration !== undefined ? { duration: body.metadata.duration } : {}),
    ...(body.results?.utterances?.length
      ? { segments: body.results.utterances.map((u, id) => ({ id, start: u.start, end: u.end, text: u.transcript })) }
      : {}),
    ...(words?.length ? { words } : {}),
  };
}
