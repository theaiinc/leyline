import type { ImageGenerationRequest, ImageGenerationResult, ModelDetail, Provider, VideoGenerationRequest, VideoGenerationResult } from '../core/types';
import { upstreamError } from '../core/media';

export const WAVESPEED_MEDIA_PRICES: Record<string, { image?: number; videoPerSecond?: number; source: string }> = {
  'wavespeed-ai/flux-dev': { image: 0.025, source: 'https://wavespeed.ai/models' },
  'wavespeed-ai/seedance-1.5-pro': { videoPerSecond: 0.04, source: 'https://wavespeed.ai/models' },
};

export class WaveSpeedProvider implements Provider {
  name = 'WaveSpeed';
  family = 'WaveSpeed';
  defaultModel = 'wavespeed-ai/flux-dev';
  capabilities: import('../core/types').Capability[] = ['image', 'video'];
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey = process.env.WAVESPEED_API_KEY || '', baseUrl = process.env.WAVESPEED_BASE_URL || 'https://api.wavespeed.ai/api/v3') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  servesModel(_capability: import('../core/types').Capability, model: string): boolean {
    return Boolean(this.apiKey) && model.startsWith('wavespeed-ai/');
  }

  async complete(_request: import('../core/types').CompletionRequest): Promise<import('../core/types').CompletionResponse> {
    throw new Error('WaveSpeed does not serve chat completions');
  }

  async *completeStream(_request: import('../core/types').CompletionRequest): AsyncGenerator<import('../core/types').StreamChunk, void, unknown> {
    throw new Error('WaveSpeed does not serve chat completions');
  }

  defaultModelFor(_capability: import('../core/types').Capability): string | undefined {
    return undefined;
  }

  async getModels(): Promise<ModelDetail[]> {
    return Object.entries(WAVESPEED_MEDIA_PRICES).map(([id, price]) => ({
      id,
      name: id.split('/').pop() || id,
      source: price.source,
    }));
  }

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const response = await fetch(`${this.baseUrl}/image/generations`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw await upstreamError(this.name, response);
    return await response.json() as ImageGenerationResult;
  }

  async generateVideo(request: VideoGenerationRequest): Promise<VideoGenerationResult> {
    const created = await fetch(`${this.baseUrl}/video/generations`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(120_000),
    });
    if (!created.ok) throw await upstreamError(this.name, created);
    const result = await created.json() as VideoGenerationResult;
    if (!result.id || ['succeeded', 'completed', 'failed'].includes(result.status)) return result;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      const polled = await fetch(`${this.baseUrl}/video/generations/${encodeURIComponent(result.id)}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(30_000),
      });
      if (!polled.ok) throw await upstreamError(this.name, polled);
      const current = await polled.json() as VideoGenerationResult;
      if (['succeeded', 'completed', 'failed', 'error'].includes(current.status)) return current;
    }
    return { ...result, status: 'timeout', error: 'WaveSpeed video generation timed out' };
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' };
  }
}
