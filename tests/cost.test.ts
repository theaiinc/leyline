import { costForTokens, displayUsage, formatUsd, freeTierRemaining, usageCost } from '../dashboard/src/lib/cost';

describe('cost utilities', () => {
  const price = { model: 'demo', input: 2, output: 4, cachedInput: 0.5, freeTier: 1 };

  it('calculates input, output, and cached token cost and formats six-decimal values sensibly', () => {
    expect(costForTokens(1000, 500, price, 200)).toBeCloseTo(0.0037, 10);
    expect(formatUsd(0.000001)).toBe('$0.000001');
    expect(formatUsd(1.25)).toBe('$1.25');
  });

  it('reports free-tier remaining without going below zero', () => {
    expect(freeTierRemaining(0.25, 1)).toBe(0.75);
    expect(freeTierRemaining(2, 1)).toBe(0);
  });

  it('does not guess for unpriced models', () => {
    expect(usageCost({ prompt_tokens: 10, completion_tokens: 10 })).toBeUndefined();
    expect(formatUsd(undefined)).toBe('price not published');
  });

  it('normalizes a response usage block for the playground display and tracks a session total', () => {
    const usage = displayUsage({ model: 'served-model', usage: { prompt_tokens: 120, completion_tokens: 80, cached_tokens: 20 } }, 'requested-model', { 'served-model': price });
    const secondUsage = displayUsage({ model: 'served-model', usage: { prompt_tokens: 100, completion_tokens: 40 } }, 'requested-model', { 'served-model': price });
    expect(usage).toEqual({ input: 120, output: 80, cached: 20, servedModel: 'served-model', cost: 0.0005300000000000001 });
    expect((usage.cost ?? 0) + (secondUsage.cost ?? 0)).toBeCloseTo(0.00089, 10);
  });
});
