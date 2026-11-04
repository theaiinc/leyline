import { computeWaveSpeedCost, WaveSpeedProvider, WAVESPEED_CATALOG, type WaveSpeedClient, type WaveSpeedPrediction } from '../src/providers/wavespeed';

describe('WaveSpeedProvider', () => {
  const prediction = (overrides: Partial<WaveSpeedPrediction> = {}): WaveSpeedPrediction => ({
    id: 'pred-1',
    status: 'completed',
    outputs: ['https://example.test/output.png'],
    usage: { seconds: 1 },
    cost: 0.025,
    ...overrides,
  });

  it('is unavailable without the configured Worker secret', async () => {
    const provider = new WaveSpeedProvider('', {} as WaveSpeedClient);
    expect(await provider.isAvailable()).toBe(false);
    await expect(provider.predict('bfl', 'flux-dev', { prompt: 'x' })).rejects.toThrow('not configured');
  });

  it('submits a priced catalog model and rejects an unpriced model', async () => {
    const client: WaveSpeedClient = {
      submit: jest.fn().mockResolvedValue(prediction({ status: 'processing' })),
      getPrediction: jest.fn(),
    };
    const provider = new WaveSpeedProvider('mock-only', client);
    await expect(provider.predict('bfl', 'flux-dev', { prompt: 'x' })).resolves.toMatchObject({ id: 'pred-1' });
    expect(client.submit).toHaveBeenCalledWith('bfl', 'flux-dev', { prompt: 'x' });
    await expect(provider.predict('unknown', 'unpriced', {})).rejects.toThrow('not offered');
    expect(WAVESPEED_CATALOG.every(model => Number(model.pricing.usd) > 0 && model.pricing.source)).toBe(true);
  });

  it('computes the published no-markup pricing rules exactly', () => {
    const image = WAVESPEED_CATALOG.find(model => model.id === 'wavespeed/bfl/flux-dev');
    const lipSync = WAVESPEED_CATALOG.find(model => model.id === 'wavespeed/bytedance/latentsync');
    expect(image).toBeDefined();
    expect(lipSync).toBeDefined();
    expect(computeWaveSpeedCost(image!, { prompt: 'x' })).toBe(0.025);
    expect(computeWaveSpeedCost(lipSync!, { audio_seconds: 2.1 })).toBe(0.09);
    expect(computeWaveSpeedCost(lipSync!, { audio_seconds: 3 })).toBe(0.09);
    expect(computeWaveSpeedCost(lipSync!, { audio_seconds: 5 })).toBe(0.15);
    expect(computeWaveSpeedCost(lipSync!, { audio_seconds: 6 })).toBe(0.18);
    expect(computeWaveSpeedCost(lipSync!, { audio_seconds: 7 })).toBe(0.21);
    expect(computeWaveSpeedCost(lipSync!, { audio_seconds: 600 })).toBe(18);
    expect(computeWaveSpeedCost(lipSync!, { audio_seconds: 900 })).toBe(18);

    for (const model of WAVESPEED_CATALOG) {
      expect(model.pricing.source).toMatch(/^https:\/\/wavespeed\.ai\/models\//);
      expect(model.pricingRule.usd).toBe(model.pricing.usd);
      expect(model.pricingRule.unit).toBeTruthy();
    }

    expect(WAVESPEED_CATALOG.map(model => model.id)).toEqual([
      'wavespeed/bfl/flux-dev',
      'wavespeed/bytedance/latentsync',
    ]);
  });

  it('polls to completion and records terminal failures without contacting the real API', async () => {
    const client: WaveSpeedClient = {
      submit: jest.fn(),
      getPrediction: jest.fn()
        .mockResolvedValueOnce(prediction({ status: 'processing' }))
        .mockResolvedValueOnce(prediction({ status: 'completed', usage: { seconds: 2 }, cost: 0.05 })),
    };
    const provider = new WaveSpeedProvider('mock-only', client);
    const result = await provider.poll('pred-1', { sleep: async () => undefined });
    expect(result.status).toBe('completed');
    expect(result.outputs).toEqual(['https://example.test/output.png']);
    expect(result.usage).toEqual({ seconds: 2 });
    expect(result.cost).toBe(0.05);

    client.getPrediction = jest.fn().mockResolvedValue(prediction({ status: 'failed', error: 'quota' }));
    await expect(provider.poll('pred-1', { sleep: async () => undefined })).resolves.toMatchObject({ status: 'failed', error: 'quota' });
  });
});