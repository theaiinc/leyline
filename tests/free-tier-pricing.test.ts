import {
  canUseFreeGrant,
  rankFreeTierProviders,
  selectFreeTierCandidate,
} from '../src/core/pricing';

describe('free-tier policy', () => {
  it('does not use an expired grant', () => {
    expect(canUseFreeGrant({ remainingTokens: 100, expiresAt: '2026-11-02T00:00:00.000Z' }, Date.parse('2026-11-03T00:00:00.000Z'))).toBe(false);
  });

  it('prefers the provider with the soonest expiring credit', () => {
    const ranked = rankFreeTierProviders(
      [
        { provider: 'OpenAI', input: 1, output: 1 },
        { provider: 'BytePlus', input: 2, output: 2 },
      ],
      [
        { provider: 'BytePlus', amountUsd: 600, expiresAt: '2026-12-02T00:00:00.000Z' },
      ],
      [],
      Date.parse('2026-11-03T00:00:00.000Z'),
    );
    expect(ranked[0].provider).toBe('BytePlus');
  });

  it('falls back when the preferred provider is over budget', () => {
    expect(selectFreeTierCandidate(
      [
        { id: 'byteplus-chat', provider: 'BytePlus', input: 1, output: 1 },
        { id: 'openai-chat', provider: 'OpenAI', input: 2, output: 2 },
      ],
      ['byteplus-chat', 'openai-chat'],
      {
        credits: [{ provider: 'BytePlus', amountUsd: 600, expiresAt: '2026-12-02T00:00:00.000Z' }],
        providerBudgetsUsd: { BytePlus: 10 },
        providerSpendUsd: { BytePlus: 10 },
        now: Date.parse('2026-11-03T00:00:00.000Z'),
      },
    )?.provider).toBe('OpenAI');
  });

  it('bills a pinned model that is not eligible instead of switching it to free tier', () => {
    expect(selectFreeTierCandidate(
      [{ id: 'openai-pinned', provider: 'OpenAI', input: 1, output: 1 }],
      ['byteplus-chat'],
      { pinnedModel: 'openai-pinned' },
    )).toBeUndefined();
  });
});
