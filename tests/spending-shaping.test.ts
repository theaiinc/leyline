import { shapeDailySpend } from '../dashboard/src/lib/spending-shaping';

describe('daily spending chart shaping', () => {
  const spend = {
    month: '2026-10', usd: 10, requests: 3,
    byDay: {
      '2026-10-01': {
        'A/model-a': { usd: 6, requests: 1, tokens: 100 },
        'B/model-b': { usd: 3, requests: 1, tokens: 50 },
        'C/model-c': { usd: 1, requests: 1, tokens: 25 },
        'D/model-d': { usd: 0, requests: 1, tokens: 10 },
        'E/model-e': { usd: 0, requests: 1, tokens: 10 },
        'F/model-f': { usd: 0, requests: 1, tokens: 10 },
        'G/model-g': { usd: 0, requests: 1, tokens: 10 },
      },
    },
  };

  it('keeps the top six and groups the rest as Other', () => {
    const shaped = shapeDailySpend(spend, 'usd');
    expect(shaped?.series).toEqual(['A/model-a', 'B/model-b', 'C/model-c', 'D/model-d', 'E/model-e', 'F/model-f', 'Other']);
    expect(shaped?.points[0].Other).toBe(0);
  });

  it('uses tokens when token mode is selected', () => {
    const shaped = shapeDailySpend(spend, 'tokens');
    expect(shaped?.points[0]['A/model-a']).toBe(100);
    expect(shaped?.points[0].Other).toBe(10);
  });
});
