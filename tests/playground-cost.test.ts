import { calculateRunCost, type PricingEntry } from '../dashboard/src/lib/cost';

describe('playground usage cost display data', () => {
  it('calculates cost from a response usage block, including cached tokens and served model', () => {
    const pricing: PricingEntry = {
      model: 'served-model',
      input: 2,
      output: 5,
      cachedInput: 0.2,
    };
    const usage = {
      prompt_tokens: 120,
      completion_tokens: 80,
      prompt_tokens_details: { cached_tokens: 20 },
    };

    const result = calculateRunCost({
      usage,
      pricing,
      servedModel: 'served-model',
    });

    expect(result).toEqual({
      inputTokens: 120,
      outputTokens: 80,
      cachedTokens: 20,
      servedModel: 'served-model',
      cost: 0.000604,
    });
  });

  it('returns an unpublished-price state when the served model has no pricing', () => {
    const result = calculateRunCost({
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      pricing: undefined,
      servedModel: 'unpriced-model',
    });

    expect(result.servedModel).toBe('unpriced-model');
    expect(result.cost).toBeUndefined();
    expect(result.priceLabel).toBe('price not published');
  });
});