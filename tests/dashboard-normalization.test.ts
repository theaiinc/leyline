import {
  formatLogUsage,
  formatLogTime,
  normalizeApiKeyStatusResponse,
  normalizeStatsResponse,
  providerTone,
  sourceLabel,
  statusTone,
} from '../dashboard/src/normalization';

describe('dashboard response normalization', () => {
  it('handles missing dashboard stats fields without throwing', () => {
    const stats = normalizeStatsResponse({
      providers: [
        {
          models: [
            { description: undefined, score: 'not-a-number' },
            { id: 42, name: 'Numeric Model' },
          ],
          usage: { minute: 3 },
        },
      ],
      logs: [
        {
          requestId: 'req-1',
          model: 'gpt-5.5',
          status: undefined,
          duration: 'slow',
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, chars: 20 },
        },
      ],
    });

    expect(stats.providers[0].name).toBe('Unknown provider 1');
    expect(stats.providers[0].defaultModel).toBe('-');
    expect(stats.providers[0].usage).toEqual({ minute: 3, day: 0 });
    expect(stats.providers[0].models).toMatchObject([
      { id: 'model-1' },
      { id: '42', name: 'Numeric Model' },
    ]);
    expect(stats.logs[0]).toMatchObject({
      provider: 'Unknown provider',
      status: 'unknown',
      model: 'gpt-5.5',
      requestId: 'req-1',
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, chars: 20 },
    });
  });

  it('normalizes tunnel status from dashboard stats', () => {
    const stats = normalizeStatsResponse({
      providers: [],
      logs: [],
      tunnel: {
        enabled: true,
        state: 'ready',
        publicUrl: 'https://example.trycloudflare.com',
        publicBaseUrl: 'https://example.trycloudflare.com/v1',
      },
    });

    expect(stats.tunnel).toEqual({
      enabled: true,
      state: 'ready',
      publicUrl: 'https://example.trycloudflare.com',
      publicBaseUrl: 'https://example.trycloudflare.com/v1',
      localUrl: undefined,
      error: undefined,
    });
  });

  it('keeps dashboard labels and tones defensive', () => {
    expect(providerTone(undefined)).toBe('default');
    expect(providerTone('Azure OpenAI')).toBe('azureopenai');
    expect(sourceLabel(undefined)).toBe('Not configured');
    expect(statusTone(undefined)).toBe('danger');
    expect(statusTone('rate_limited')).toBe('warning');
    expect(formatLogTime('')).toBe('-');
    expect(formatLogUsage({ total_tokens: 5 })).toBe('5 tokens');
    expect(formatLogUsage({ chars: 42 })).toBe('42 chars');
    expect(formatLogUsage(undefined)).toBe('-');
  });

  it('fills missing API key status structures with safe defaults', () => {
    const status = normalizeApiKeyStatusResponse({
      providers: [
        { name: undefined, source: 'mystery' },
      ],
    });

    expect(status.persistence.server.mode).toBe('memory');
    expect(status.persistence.modes.localStorage.available).toBe(true);
    expect(status.persistence.modes.memory.available).toBe(true);
    expect(status.providers[0]).toMatchObject({
      name: 'Unknown provider 1',
      defaultModel: '-',
      configured: false,
      source: 'none',
      persisted: false,
    });
  });
});
