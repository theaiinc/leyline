import { calculateReprice, type KeySpend, type RepriceDocument } from '../src/core/spend-reprice';

const prices = {
  from: { input: 10, output: 40, cached: 1 },
  to: { input: 0.2, output: 0.8, cached: 0.02 },
};

function document(): RepriceDocument {
  return {
    month: '2026-11',
    usd: 300,
    byProvider: { 'LLM API': 265, Other: 35 },
    byModel: {
      'LLM API/deepseek-v4-flash': { usd: 264.8, provider: 'LLM API', model: 'deepseek-v4-flash' },
      'LLM API/other': { usd: 0.2, provider: 'LLM API', model: 'other' },
    },
    byDay: {
      '2026-11-01': {
        deepseek: { usd: 264.8, provider: 'LLM API', model: 'deepseek-v4-flash' },
        other: { usd: 35.2, provider: 'Other', model: 'other' },
      },
    },
  };
}

function keys(): Array<{ id: string; usage: KeySpend }> {
  return [
    {
      id: 'simasis-hosted',
      usage: { usd: 266.22, byModel: { 'deepseek-v4-flash': { usd: 265 }, other: { usd: 1.22 } } },
    },
  ];
}

describe('spend repricing', () => {
  it('returns a dry-run preview without mutating the document or keys', () => {
    const before = document();
    const result = calculateReprice({
      month: '2026-11',
      provider: 'LLM API',
      model: 'deepseek-v4-flash',
      ...prices,
      dryRun: true,
      now: new Date('2026-11-05T00:00:00Z'),
    }, before, keys(), 'admin@example.com');

    expect(result.changed).toBe(true);
    expect(result.before.byModel?.['LLM API/deepseek-v4-flash']?.usd).toBe(264.8);
    expect(result.after.byModel?.['LLM API/deepseek-v4-flash']?.usd).toBe(264.8);
    expect(result.keys[0].after.usd).toBe(result.keys[0].before.usd);
    expect(before.usd).toBe(300);
  });

  it('rescales matching month, provider, day, and per-key totals exactly', () => {
    const result = calculateReprice({
      month: '2026-11',
      provider: 'LLM API',
      model: 'deepseek-v4-flash',
      ...prices,
      dryRun: false,
      now: new Date('2026-11-05T00:00:00Z'),
    }, document(), keys(), 'admin@example.com');

    expect(result.ratio).toBeCloseTo(0.02);
    expect(result.after.byModel?.['LLM API/deepseek-v4-flash']?.usd).toBe(5.3);
    expect(result.after.usd).toBe(40.5);
    expect(result.after.byProvider?.['LLM API']).toBe(5.5);
    expect(result.after.byDay?.['2026-11-01'].deepseek.usd).toBe(5.3);
    expect(result.keys[0].after.byModel?.['deepseek-v4-flash'].usd).toBe(5.3);
    expect(result.keys[0].after.usd).toBe(6.52);
    expect(result.after.adjustments).toHaveLength(1);
    expect(result.after.adjustments?.[0].by).toBe('admin@example.com');
  });

  it('supports wildcard models', () => {
    const result = calculateReprice({
      month: '2026-11',
      provider: 'LLM API',
      model: 'deepseek-*',
      ...prices,
      dryRun: false,
      now: new Date('2026-11-05T00:00:00Z'),
    }, document(), keys(), 'admin@example.com');
    expect(result.after.byModel?.['LLM API/deepseek-v4-flash']?.usd).toBe(5.3);
  });

  it('rejects non-proportional prices and disallowed months', () => {
    expect(() => calculateReprice({
      month: '2026-11',
      provider: 'LLM API',
      model: 'deepseek-v4-flash',
      from: { input: 10, output: 40 },
      to: { input: 0.2, output: 0.9 },
      dryRun: true,
      now: new Date('2026-11-05T00:00:00Z'),
    }, document(), keys(), 'admin@example.com')).toThrow(/same input/);
    expect(() => calculateReprice({
      month: '2026-01',
      provider: 'LLM API',
      model: 'deepseek-v4-flash',
      ...prices,
      dryRun: true,
      now: new Date('2026-11-05T00:00:00Z'),
    }, document(), keys(), 'admin@example.com')).toThrow(/current and previous/);
  });

  it('is idempotent and surfaces unsupported per-key storage', () => {
    const first = calculateReprice({
      month: '2026-11',
      provider: 'LLM API',
      model: 'deepseek-v4-flash',
      ...prices,
      dryRun: false,
      now: new Date('2026-11-05T00:00:00Z'),
    }, document(), [{ id: 'legacy', usage: { usd: 9 } }], 'admin@example.com');
    const second = calculateReprice({
      month: '2026-11',
      provider: 'LLM API',
      model: 'deepseek-v4-flash',
      ...prices,
      dryRun: false,
      now: new Date('2026-11-05T00:00:00Z'),
    }, first.after, keys(), 'admin@example.com');
    expect(first.keys[0].supported).toBe(false);
    expect(second.alreadyApplied).toBe(true);
    expect(second.changed).toBe(false);
  });
});