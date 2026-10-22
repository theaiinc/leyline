import { IssuedKeys, MemoryDocStore } from '../src/core/issued-keys';

describe('daily spend persistence', () => {
  it('aggregates same-day usage by provider and model', async () => {
    let now = Date.parse('2026-10-21T10:00:00Z');
    const keys = new IssuedKeys(new MemoryDocStore(), { now: () => now });

    await keys.record(null, 'model-a', { prompt_tokens: 10, completion_tokens: 5 }, 0.25, {
      provider: 'BytePlus',
      model: 'model-a',
    });
    await keys.record(null, 'model-a', { prompt_tokens: 20, completion_tokens: 7 }, 0.5, {
      provider: 'BytePlus',
      model: 'model-a',
    });
    await keys.record(null, 'model-b', { prompt_tokens: 4, completion_tokens: 1 }, 0.1, {
      provider: 'OpenAI',
      model: 'model-b',
    });

    const spend = await keys.spend('2026-10');
    expect(spend.byDay?.['2026-10-21']?.['BytePlus/model-a']).toMatchObject({
      usd: 0.75,
      requests: 2,
      tokens: 42,
    });
    expect(spend.byDay?.['2026-10-21']?.['OpenAI/model-b']).toMatchObject({
      usd: 0.1,
      requests: 1,
      tokens: 5,
    });
    expect(spend.byModel?.['BytePlus/model-a']).toMatchObject({
      usd: 0.75,
      requests: 2,
      tokens: 42,
    });
  });

  it('stores different UTC dates in separate daily buckets', async () => {
    let now = Date.parse('2026-10-21T23:59:00Z');
    const keys = new IssuedKeys(new MemoryDocStore(), { now: () => now });

    await keys.record(null, 'model-a', { prompt_tokens: 3, completion_tokens: 2 }, 0.2, {
      provider: 'BytePlus',
      model: 'model-a',
    });

    now = Date.parse('2026-10-22T00:01:00Z');
    await keys.record(null, 'model-a', { prompt_tokens: 6, completion_tokens: 4 }, 0.4, {
      provider: 'BytePlus',
      model: 'model-a',
    });

    const spend = await keys.spend('2026-10');
    expect(spend.byDay?.['2026-10-21']?.['BytePlus/model-a']).toMatchObject({
      usd: 0.2,
      requests: 1,
      tokens: 5,
    });
    expect(spend.byDay?.['2026-10-22']?.['BytePlus/model-a']).toMatchObject({
      usd: 0.4,
      requests: 1,
      tokens: 10,
    });
  });
});