import { WaveSpeedProvider, WAVESPEED_CATALOG, type WaveSpeedClient, type WaveSpeedPrediction } from '../src/providers/wavespeed';

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