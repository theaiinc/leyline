import type { ModelDetail, Provider } from '../core/types';

export type WaveSpeedStatus = 'created' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface WaveSpeedPrediction {
  id: string;
  status: WaveSpeedStatus;
  outputs?: unknown[];
  error?: string;
  usage?: Record<string, unknown>;
  cost?: number;
}

export interface WaveSpeedModel extends Omit<ModelDetail, 'pricing'> {
  modality: 'image' | 'video' | 'audio' | '3d' | 'lip-sync';
  inputSchema: Record<string, unknown>;
  /** Official WaveSpeed price and source for publication/audit. */
  pricing: { usd: number; source: string };
  pricingRule: Record<string, number | string>;
}

export interface WaveSpeedClient {
  submit(provider: string, model: string, input: Record<string, unknown>): Promise<WaveSpeedPrediction>;
  getPrediction(id: string): Promise<WaveSpeedPrediction>;
}

const WAVESPEED_API = 'https://api.wavespeed.ai/api/v3';

export const WAVESPEED_CATALOG: WaveSpeedModel[] = [
  {
    id: 'wavespeed/bfl/flux-dev',
    name: 'FLUX.1 dev',
    modality: 'image',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    pricing: { usd: 0.025, source: 'https://wavespeed.ai/models/bfl/flux-dev' },
    pricingRule: { unit: 'per_run', usd: 0.025 },
  },
  {
    id: 'wavespeed/bytedance/latentsync',
    name: 'LatentSync',
    modality: 'lip-sync',
    inputSchema: { type: 'object', properties: { video: { type: 'string' }, audio: { type: 'string' } }, required: ['video', 'audio'] },
    pricing: { usd: 0.10, source: 'https://wavespeed.ai/models/bytedance/latentsync' },
    pricingRule: { unit: 'per_run', usd: 0.10 },
  },
  {
    id: 'wavespeed/bytedance/seedance-1-0-pro',
    name: 'Seedance 1.0 Pro',
    modality: 'video',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    pricing: { usd: 0.40, source: 'https://wavespeed.ai/models/bytedance/seedance-1-0-pro' },
    pricingRule: { unit: 'per_second', usd: 0.40 },
  },
  {
    id: 'wavespeed/tencent/hunyuan-video',
    name: 'HunyuanVideo',
    modality: 'video',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    pricing: { usd: 0.50, source: 'https://wavespeed.ai/models/tencent/hunyuan-video' },
    pricingRule: { unit: 'per_run', usd: 0.50 },
  },
  {
    id: 'wavespeed/elevenlabs/tts',
    name: 'ElevenLabs TTS',
    modality: 'audio',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    pricing: { usd: 0.30, source: 'https://wavespeed.ai/models/elevenlabs/tts' },
    pricingRule: { unit: 'per_1000_characters', usd: 0.30 },
  },
  {
    id: 'wavespeed/openai/whisper',
    name: 'Whisper',
    modality: 'audio',
    inputSchema: { type: 'object', properties: { audio: { type: 'string' } }, required: ['audio'] },
    pricing: { usd: 0.006, source: 'https://wavespeed.ai/models/openai/whisper' },
    pricingRule: { unit: 'per_minute', usd: 0.006 }
  },
];

export class WaveSpeedProvider implements Provider {
  name = 'WaveSpeed';
  family = 'WaveSpeed';
  defaultModel = WAVESPEED_CATALOG[0]?.id || '';
  capabilities: import('../core/types').Capability[] = [];
  private apiKey: string;
  private client: WaveSpeedClient;

  constructor(apiKey = process.env.WAVESPEED_API_KEY || '', client?: WaveSpeedClient) {
    this.apiKey = apiKey;
    this.client = client || createWaveSpeedClient(apiKey);
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
    this.client = createWaveSpeedClient(apiKey);
  }

  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  async isAvailable(): Promise<boolean> {
    return this.hasApiKey() && WAVESPEED_CATALOG.length > 0;
  }

  async complete(): Promise<never> {
    throw new Error('WaveSpeed does not provide chat completions');
  }

  async *completeStream(): AsyncGenerator<never, void, unknown> {
    throw new Error('WaveSpeed does not provide chat completions');
  }

  servesModel(): boolean {
    return this.hasApiKey() && WAVESPEED_CATALOG.length > 0;
  }

  async getModels(): Promise<ModelDetail[]> {
    return this.hasApiKey() ? [...WAVESPEED_CATALOG] as unknown as ModelDetail[] : [];
  }

  async predict(provider: string, model: string, input: Record<string, unknown>): Promise<WaveSpeedPrediction> {
    if (!this.hasApiKey()) throw new Error('WaveSpeed is not configured');
    if (!WAVESPEED_CATALOG.some(entry => entry.id === `wavespeed/${provider}/${model}`)) {
      throw new Error(`WaveSpeed model is not offered: ${provider}/${model}`);
    }
    return this.client.submit(provider, model, input);
  }

  async poll(id: string, options: { maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<WaveSpeedPrediction> {
    const maxAttempts = options.maxAttempts ?? 30;
    const sleep = options.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
    let delay = 2000;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const prediction = await this.client.getPrediction(id);
      if (['completed', 'failed', 'cancelled'].includes(prediction.status)) return prediction;
      await sleep(delay);
      delay = Math.min(delay * 1.5, 10000);
    }
    throw new Error(`WaveSpeed prediction ${id} did not finish`);
  }
}

function createWaveSpeedClient(apiKey: string): WaveSpeedClient {
  const request = async (url: string, init?: RequestInit): Promise<WaveSpeedPrediction> => {
    const response = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
    });
    const body = await response.json() as { data?: WaveSpeedPrediction; error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message || `WaveSpeed request failed (${response.status})`);
    return body.data || body as unknown as WaveSpeedPrediction;
  };
  return {
    submit: (provider, model, input) => request(`${WAVESPEED_API}/${provider}/${model}`, { method: 'POST', body: JSON.stringify(input) }),
    getPrediction: id => request(`${WAVESPEED_API}/predictions/${id}`),
  };
}