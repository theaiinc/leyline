import {
  assertFirstGrantAvailable,
  assertTurnstilePassed,
  assertVerifiedEmail,
  createWorkspace,
  DEFAULT_FREE_TIER_LIMITS,
  freeTierRefusal,
  suspensionRefusal,
} from '../src/core/self-serve-policy';

describe('self-serve signup policy', () => {
  const identity = {
    aegisAccountId: 'aegis-user-a',
    verifiedEmail: 'user-a@example.com',
  };

  it('creates an isolated workspace owned by the Aegis account', () => {
    const workspace = createWorkspace(identity, 'workspace-a', 123);
    expect(workspace).toMatchObject({
      id: 'workspace-a',
      ownerAegisAccountId: 'aegis-user-a',
      verifiedEmail: 'user-a@example.com',
      createdAt: 123,
    });
    expect(workspace.ownerEmailHash).toHaveLength(64);
  });

  it('requires verified email before key creation', () => {
    expect(() => assertVerifiedEmail(identity.verifiedEmail, false)).toThrow('email_verification_required');
  });

  it('rejects failed Turnstile validation', () => {
    expect(() => assertTurnstilePassed(false)).toThrow('turnstile_failed');
  });

  it('rejects disposable email domains', () => {
    expect(() => assertVerifiedEmail('person@mailinator.com', true)).toThrow('disposable_email_not_allowed');
  });

  it('allows only one free grant per email or Aegis account', () => {
    expect(() => assertFirstGrantAvailable([], identity)).not.toThrow();
    expect(() => assertFirstGrantAvailable([{ emailHash: 'different' }], identity)).not.toThrow();
    expect(() => assertFirstGrantAvailable([{ aegisAccountId: identity.aegisAccountId }], identity)).toThrow('free_grant_already_used');
  });

  it('returns explicit free-tier 429 responses for limits and global budget', () => {
    expect(freeTierRefusal(DEFAULT_FREE_TIER_LIMITS, {
      model: 'gpt-4o-mini',
      requestsThisMinute: 10,
      concurrent: 0,
      tokensToday: 0,
      globalTokensToday: 0,
      globalDailyBudget: 1_000_000,
      hasPaidCredit: false,
    })).toMatchObject({ status: 429, code: 'free_rate_limited' });

    expect(freeTierRefusal(DEFAULT_FREE_TIER_LIMITS, {
      model: 'gpt-4o-mini',
      requestsThisMinute: 0,
      concurrent: 0,
      tokensToday: 0,
      globalTokensToday: 1_000_000,
      globalDailyBudget: 1_000_000,
      hasPaidCredit: false,
    })).toMatchObject({ status: 429, code: 'global_free_budget_exhausted' });
  });

  it('blocks paid models without paid credit', () => {
    expect(freeTierRefusal(DEFAULT_FREE_TIER_LIMITS, {
      model: 'paid-model',
      requestsThisMinute: 0,
      concurrent: 0,
      tokensToday: 0,
      globalTokensToday: 0,
      globalDailyBudget: 1_000_000,
      hasPaidCredit: false,
    })).toMatchObject({ status: 403, code: 'free_model_not_allowed' });
  });

  it('returns 403 for suspended workspaces or keys', () => {
    expect(suspensionRefusal(true)).toMatchObject({ status: 403, code: 'workspace_or_key_suspended' });
    expect(suspensionRefusal(false)).toBeNull();
  });
});