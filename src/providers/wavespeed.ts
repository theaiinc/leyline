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

export function computeWaveSpeedCost(model: WaveSpeedModel, input: Record<string, unknown>): number {
  const rule = model.pricingRule;
  if (rule.unit === 'per_run') return Number(rule.usd);
  if (rule.unit === 'audio_per_second') {
    // WaveSpeed documents whole-second rounding, a 3-second minimum, and a
    // 600-second billable maximum. The published $0.03/second rate is derived
    // from its unchanged $0.15 per 5-second table.
    const seconds = Math.min(600, Math.max(3, Math.ceil(Number(input.audio_seconds ?? input.duration_seconds ?? 3))));
    return seconds * Number(rule.usd);
  }
  throw new Error(`No executable pricing rule for ${model.id}`);
}

const WAVESPEED_API = 'https://api.wavespeed.ai/api/v3';

export const WAVESPEED_CATALOG: WaveSpeedModel[] = [
  {
    id: 'wavespeed/bfl/flux-dev',
    name: 'FLUX.1 dev',
    modality: 'image',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    // WaveSpeed model page: "Billed per image generation at $0.025 per run."
    pricing: { usd: 0.025, source: 'https://wavespeed.ai/models/bfl/flux-dev' },
    pricingRule: { unit: 'per_run', usd: 0.025 },
  },
  {
    id: 'wavespeed/bytedance/latentsync',
    name: 'LatentSync',
    modality: 'lip-sync',
    inputSchema: { type: 'object', properties: { video: { type: 'string' }, audio: { type: 'string' } }, required: ['video', 'audio'] },
    // WaveSpeed model page: "Input media duration is rounded up to whole seconds. The minimum billed duration is 3 seconds; shorter inputs are billed as 3 seconds. Existing per-5-second rate tables remain unchanged."
    // The unchanged $0.15/5-second table is $0.03 per billed second; apply the page's whole-second rounding, minimum, and maximum exactly.
    pricing: { usd: 0.03, source: 'https://wavespeed.ai/models/bytedance/latentsync' },
    pricingRule: { unit: 'audio_per_second', usd: 0.03, table_rate_usd: 0.15, table_seconds: 5, minimum_seconds: 3, maximum_seconds: 600, rounding: 'ceil_whole_second' },
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
    const modelId = `wavespeed/${provider}/${model}`;
    if (!WAVESPEED_CATALOG.some(entry => entry.id === modelId)) {
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