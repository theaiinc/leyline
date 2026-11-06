import { resolveRoutingStrategy, type RouteCandidate } from '../src/core/types';
import { selectRoute } from '../src/core/routing-strategies';

const candidates: RouteCandidate[] = [
  { provider: 'AzureOpenAI', model: 'gpt-5.6-luna', price: { input: 1, output: 2 }, latencyMs: 800, ttftMs: 300, qualityScore: 0.9, order: 0, available: true },
  { provider: 'BytePlus', model: 'deepseek-v4-flash', price: { input: 0.14, output: 0.28 }, latencyMs: 250, ttftMs: 100, qualityScore: 0.75, order: 1, available: true },
  { provider: 'OpenAI', model: 'gpt-4o', price: { input: 5, output: 10 }, latencyMs: 500, ttftMs: 200, qualityScore: 0.98, order: 2, available: true },
];

describe('routing strategies', () => {
  test.each([
    ['custom', ['AzureOpenAI', 'BytePlus', 'OpenAI']],
    ['cheapest', ['BytePlus', 'AzureOpenAI', 'OpenAI']],
    ['fastest', ['BytePlus', 'OpenAI', 'AzureOpenAI']],
    ['best', ['OpenAI', 'AzureOpenAI', 'BytePlus']],
  ] as const)('%s orders eligible candidates', (strategy, expected) => {
    expect(selectRoute(candidates, strategy).map(route => route.candidate.provider)).toEqual(expected);
  });

  it('excludes unavailable and breaker-paused models', () => {
    const result = selectRoute([
      ...candidates,
      { ...candidates[1], provider: 'Paused', model: 'paused', order: 3, available: true, breakerPaused: true },
      { ...candidates[2], provider: 'Unavailable', model: 'unavailable', order: 4, available: false },
    ], 'custom');
    expect(result.map(route => route.candidate.provider)).toEqual(['AzureOpenAI', 'BytePlus', 'OpenAI']);
  });

  it('never treats an unpublished price as cheapest', () => {
    const result = selectRoute([
      { ...candidates[0], price: undefined },
      { ...candidates[1], order: 1 },
    ], 'cheapest');
    expect(result.map(route => route.candidate.provider)).toEqual(['BytePlus']);
    expect(result[0].reason).toContain('cheapest of 1 available');
  });

  it('includes the strategy and human-readable reason', () => {
    const result = selectRoute(candidates, 'balanced');
    expect(result[0].strategy).toBe('balanced');
    expect(result[0].reason).toContain('quality');
    expect(result[0].reason).toContain('price');
    expect(result[0].reason).toContain('speed');
  });

    it('uses request, key, then account strategy precedence', () => {
    expect(resolveRoutingStrategy('auto:fastest', 'best', 'cheapest')).toBe('fastest');
    expect(resolveRoutingStrategy(undefined, 'best', 'cheapest')).toBe('best');
    expect(resolveRoutingStrategy(undefined, undefined, 'cheapest')).toBe('cheapest');
    expect(resolveRoutingStrategy(undefined, undefined, undefined)).toBe('custom');
  });

  it('preserves registration order for the default custom strategy', () => {
    expect(selectRoute(candidates).map(route => route.candidate.model)).toEqual([
      'gpt-5.6-luna',
      'deepseek-v4-flash',
      'gpt-4o',
    ]);
  });

  it('orders balanced candidates using the supplied weights', () => {
    const result = selectRoute(candidates, 'balanced', { quality: 1, price: 0, speed: 0 });
    expect(result[0].candidate.provider).toBe('OpenAI');
    expect(result[0].reason).toContain('1 quality');
  });
});