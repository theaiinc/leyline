import {
  familyOf,
  formatLogUsage,
  formatLogTime,
  normalizeApiKeyStatusResponse,
  normalizeProviderInstancesResponse,
  normalizeRouting,
  normalizeStatsResponse,
  providerDescription,
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
      clientAuth: {
        enabled: true,
        apiKey: 'll-session-key',
        generated: true,
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
    expect(stats.clientAuth).toEqual({
      enabled: true,
      apiKey: 'll-session-key',
      generated: true,
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
    expect(formatLogUsage({ chars: 42 })).toBe('42 output chars');
    expect(formatLogUsage(undefined)).toBe('-');
  });

  it('groups multi-instance providers by family for tone/description', () => {
    expect(familyOf('AzureOpenAI:prod-eastus', 'AzureOpenAI')).toBe('AzureOpenAI');
    expect(providerTone('AzureOpenAI:prod-eastus', 'AzureOpenAI')).toBe('azureopenai');
    expect(providerTone('AzureOpenAI:prod-eastus')).toBe('default');
    expect(providerDescription('AzureOpenAI:prod-eastus', 'AzureOpenAI')).toContain('Azure OpenAI');
  });

  it('normalizes model pins and the model index on routing status', () => {
    const routing = normalizeRouting({
      singleModelEnabled: false,
      fixedProvider: null,
      fixedModel: null,
      enabledModels: {},
      modelPins: { 'gpt-4o': 'AzureOpenAI:prod-eastus' },
      modelIndex: { 'gpt-4o': ['AzureOpenAI', 'AzureOpenAI:prod-eastus'] },
    });

    expect(routing?.modelPins).toEqual({ 'gpt-4o': 'AzureOpenAI:prod-eastus' });
    expect(routing?.modelIndex).toEqual({ 'gpt-4o': ['AzureOpenAI', 'AzureOpenAI:prod-eastus'] });
  });

  it('normalizes the provider-instances families response', () => {
    const result = normalizeProviderInstancesResponse({
      families: [
        {
          family: 'AzureOpenAI',
          displayName: 'Azure OpenAI',
          baseName: 'AzureOpenAI',
          fields: [
            { key: 'endpoint', label: 'Endpoint', role: 'runtimeBaseUrl', required: true },
            { key: 'apiKey', label: 'API key', role: 'secret', required: true },
            { key: 'unknownRole', label: 'Bad field', role: 'not-a-role' },
          ],
          instances: [{ id: 'prod-eastus', name: 'AzureOpenAI:prod-eastus', label: 'prod-eastus' }],
        },
      ],
    });

    expect(result.families).toHaveLength(1);
    expect(result.families[0].fields).toEqual([
      { key: 'endpoint', label: 'Endpoint', role: 'runtimeBaseUrl', required: true, placeholder: undefined },
      { key: 'apiKey', label: 'API key', role: 'secret', required: true, placeholder: undefined },
    ]);
    expect(result.families[0].instances).toEqual([
      { id: 'prod-eastus', name: 'AzureOpenAI:prod-eastus', label: 'prod-eastus' },
    ]);
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
