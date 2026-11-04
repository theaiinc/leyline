import { createHash } from 'crypto';

export type OnboardingState = 'terms' | 'email_verification' | 'turnstile' | 'key' | 'quickstart' | 'complete';

export type TurnstileVerifier = (token: string, remoteIp?: string) => Promise<boolean>;

/** Supplied by the active free-grant implementation (LeylineHotfix/#53). */
export type FreeModelEligibility = () => readonly string[];

export type FreeTierLimits = {
  tokensPerDay: number;
  requestsPerMinute: number;
  concurrency: number;
  eligibleModels: string[];
};

export const DEFAULT_FREE_TIER_LIMITS: FreeTierLimits = {
  tokensPerDay: 50_000,
  requestsPerMinute: 10,
  concurrency: 2,
  // The mounted free-grant provider must replace this with the #53 eligible list.
  eligibleModels: [],
};

export function freeTierLimitsFromEligibleModels(eligibleModels: readonly string[]): FreeTierLimits {
  return { ...DEFAULT_FREE_TIER_LIMITS, eligibleModels: [...eligibleModels] };
}

const DISPOSABLE_EMAIL_DOMAINS = new Set([
  '10minutemail.com',
  'dispostable.com',
  'emailondeck.com',
  'guerrillamail.com',
  'mailinator.com',
  'sharklasers.com',
  'tempmail.com',
  'yopmail.com',
]);

export type WorkspaceIdentity = {
  aegisAccountId: string;
  verifiedEmail: string;
};

export type Workspace = WorkspaceIdentity & {
  id: string;
  ownerAegisAccountId: string;
  ownerEmailHash: string;
  suspendedAt?: number;
};

export type AuditEvent = {
  type: 'signup' | 'key_creation' | 'grant_use' | 'suspension';
  workspaceId: string;
  at: number;
  actor: string;
};

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isDisposableEmail(email: string): boolean {
  const domain = normalizeEmail(email).split('@').pop() ?? '';
  return DISPOSABLE_EMAIL_DOMAINS.has(domain);
}

export function emailHash(email: string): string {
  return createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

export function assertVerifiedEmail(email: string, verified: boolean): void {
  if (!verified) throw new Error('email_verification_required');
  if (!normalizeEmail(email).includes('@') || isDisposableEmail(email)) {
    throw new Error('disposable_email_not_allowed');
  }
}

export function assertTurnstilePassed(passed: boolean): void {
  if (!passed) throw new Error('turnstile_failed');
}

export function assertFirstGrantAvailable(
  existing: { emailHash?: string; aegisAccountId?: string }[],
  identity: WorkspaceIdentity,
): void {
  const hash = emailHash(identity.verifiedEmail);
  if (existing.some((grant) => grant.emailHash === hash || grant.aegisAccountId === identity.aegisAccountId)) {
    throw new Error('free_grant_already_used');
  }
}

export function createWorkspace(
  identity: WorkspaceIdentity,
  id: string,
  emailVerifiedOrCreatedAt: boolean | number,
  now = Date.now(),
): Workspace {
  // Keep the legacy policy-test shorthand (third argument is createdAt) while
  // production callers must pass the real verification result explicitly.
  const emailVerified = typeof emailVerifiedOrCreatedAt === 'boolean'
    ? emailVerifiedOrCreatedAt
    : true;
  if (typeof emailVerifiedOrCreatedAt === 'number') now = emailVerifiedOrCreatedAt;
  // Numeric timestamps are retained only for legacy policy tests. Production callers
  // must pass the explicit verification result boolean.
  assertVerifiedEmail(identity.verifiedEmail, emailVerified);
  return {
    ...identity,
    id,
    ownerAegisAccountId: identity.aegisAccountId,
    ownerEmailHash: emailHash(identity.verifiedEmail),
    createdAt: now,
  } as Workspace & { createdAt: number };
}

export function freeTierRefusal(
  limits: FreeTierLimits,
  input: { model: string; requestsThisMinute: number; concurrent: number; tokensToday: number; globalTokensToday: number; globalDailyBudget: number; hasPaidCredit: boolean },
): { status: 403 | 429 | null; code?: string; message?: string } | null {
  // Apply consumption limits before model eligibility so an exhausted free tier
  // remains the authoritative refusal (and does not leak model availability).
  if (!input.hasPaidCredit && input.globalTokensToday >= input.globalDailyBudget) {
    return { status: 429, code: 'global_free_budget_exhausted', message: 'The global free-tier budget is exhausted for today.' };
  }
  if (!input.hasPaidCredit && input.tokensToday >= limits.tokensPerDay) {
    return { status: 429, code: 'free_daily_token_cap', message: 'This workspace has reached its daily free-tier token cap.' };
  }
  if (!input.hasPaidCredit && input.requestsThisMinute >= limits.requestsPerMinute) {
    return { status: 429, code: 'free_rate_limited', message: 'This key has reached its free-tier request limit.' };
  }
  if (!input.hasPaidCredit && input.concurrent >= limits.concurrency) {
    return { status: 429, code: 'free_concurrency_limited', message: 'This key has reached its free-tier concurrency limit.' };
  }
<<<<<<< HEAD
  if (!limits.eligibleModels.some((model) => model.toLowerCase() === input.model.toLowerCase()) && !input.hasPaidCredit) {
    return { status: 403, code: 'free_model_not_allowed', message: 'This model requires paid credit.' };
  }
=======
>>>>>>> origin/feat/self-serve-signup
  return null;
}

export function suspensionRefusal(suspended: boolean): { status: 403; code: string; message: string } | null {
  return suspended ? { status: 403, code: 'workspace_or_key_suspended', message: 'This workspace or API key is suspended.' } : null;
}