import { createHash, randomUUID } from 'crypto';
import { DEFAULT_FREE_TIER_LIMITS, isDisposableEmail, normalizeEmail } from './self-serve-policy';
import { DEFAULT_FREE_TIER_EXPIRES_AFTER_DAYS, DEFAULT_FREE_TIER_TOKENS } from './pricing';
import { config } from '../config';
import type { D1BillingStore, WorkspaceRecord } from './billing-store';

/**
 * Self-serve sign-up: a workspace for an Aegis account, after (in this order, all checked here on the server) the
 * Terms, a verified and non-disposable email, the per-IP sign-up limit and a Cloudflare Turnstile check. The first
 * workspace for an email and Aegis account gets the free grant; a later one (the same person again) does not.
 */

/** The Terms on valefront.com/terms ("Last updated: 3 November 2026"). Bump when they change. */
export const TERMS_VERSION = '2026-11-03';
export const SIGNUPS_PER_IP_PER_DAY = 3;

export type FreeTierConfig = {
  tokens: number;
  expiresAfterDays: number;
  /** Models free tokens can be spent on (FREE_TIER_MODELS, the same list /v1/pricing publishes). */
  models: string[];
  /** Abuse limits: free tokens a workspace may use a UTC day, and all workspaces together. */
  tokensPerDay: number;
  globalTokensPerDay: number;
};

export type TurnstileSiteverifyResponse = { success: boolean; 'error-codes'?: string[]; hostname?: string };

/** Cloudflare Turnstile Siteverify. Fails closed: no secret, no token, an error or a non-success answer is false. */
export async function verifyTurnstile(token: string, secret: string | undefined, remoteIp: string | undefined, fetcher: typeof fetch = (i, init) => fetch(i, init)): Promise<boolean> {
  if (!token || !secret || token.length > 2048) return false;
  const body = new URLSearchParams({ secret, response: token, idempotency_key: randomUUID() });
  if (remoteIp) body.set('remoteip', remoteIp);
  try {
    const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) return false;
    const result = (await response.json()) as TurnstileSiteverifyResponse;
    return result.success === true;
  } catch {
    return false;
  }
}

export function hashIdentity(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

export class SignupError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export type SignupInput = {
  identity: { sub: string; email: string; emailVerified: boolean; name?: string };
  acceptTerms: boolean;
  termsVersion: string;
  turnstileToken: string;
  ip: string;
};

export async function signUp(
  store: D1BillingStore,
  input: SignupInput,
  deps: { verifyTurnstile: (token: string, ip: string) => Promise<boolean>; free: FreeTierConfig; now?: number },
): Promise<{ workspace: WorkspaceRecord; created: boolean; granted: boolean }> {
  const now = deps.now ?? Date.now();
  const existing = await store.workspaceBySub(input.identity.sub);
  if (existing) return { workspace: existing, created: false, granted: false };
  if (!input.acceptTerms || input.termsVersion !== TERMS_VERSION) {
    throw new SignupError('terms_required', 'Accept the current Terms of Service to continue.');
  }
  const email = normalizeEmail(input.identity.email);
  if (!input.identity.emailVerified) {
    throw new SignupError('email_verification_required', 'Verify your email address with your Aegis account first, then sign in again.', 403);
  }
  if (!email.includes('@') || isDisposableEmail(email)) {
    throw new SignupError('disposable_email_not_allowed', 'Sign up with a permanent email address; disposable addresses are not accepted.', 403);
  }
  const ipHash = hashIdentity(`ip:${input.ip}`);
  if ((await store.countSignups(ipHash, now - 86_400_000)) >= SIGNUPS_PER_IP_PER_DAY) {
    throw new SignupError('workspace_creation_rate_limited', 'Too many sign-ups from this network today; try again tomorrow.', 429);
  }
  if (!(await deps.verifyTurnstile(input.turnstileToken, input.ip))) {
    throw new SignupError('turnstile_failed', 'The security check did not pass; try it again.', 403);
  }
  const emailHash = hashIdentity(email);
  const subHash = hashIdentity(`sub:${input.identity.sub}`);
  const grantAvailable = !(await store.grantUsed(emailHash, subHash));
  const workspace: WorkspaceRecord = {
    id: `ws_${randomUUID().replace(/-/g, '')}`,
    ownerSub: input.identity.sub,
    email,
    emailHash,
    name: input.identity.name ?? null,
    termsVersion: TERMS_VERSION,
    termsAcceptedAt: now,
    createdAt: now,
  };
  try {
    const { granted } = await store.createWorkspace(
      workspace,
      grantAvailable ? { emailHash, subHash, tokens: deps.free.tokens, expiresAt: now + deps.free.expiresAfterDays * 86_400_000 } : null,
      { type: 'workspace.signup', ipHash, meta: { termsVersion: TERMS_VERSION } },
    );
    if (granted) await store.audit({ type: 'free_grant.claimed', workspaceId: workspace.id, meta: { tokens: deps.free.tokens } });
    else await store.audit({ type: 'free_grant.rejected', workspaceId: workspace.id, meta: { reason: 'already_used' } });
    return { workspace, created: true, granted };
  } catch (err) {
    // Two tabs signing up at once: the other one made it.
    const raced = await store.workspaceBySub(input.identity.sub);
    if (raced) return { workspace: raced, created: false, granted: false };
    throw err;
  }
}

/**
 * The free tier from deployment settings: the public offer (DEFAULT_FREE_TIER_TOKENS for
 * DEFAULT_FREE_TIER_EXPIRES_AFTER_DAYS on FREE_TIER_MODELS, exactly what /v1/pricing's free_tier and valefront.com
 * say) and the abuse limits (FREE_TIER_TOKENS_PER_DAY, FREE_TIER_GLOBAL_TOKENS_PER_DAY).
 */
export function freeTierConfig(env: Record<string, string | undefined> = process.env): FreeTierConfig {
  const n = (v: string | undefined, fallback: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.floor(x) : fallback;
  };
  return {
    tokens: DEFAULT_FREE_TIER_TOKENS,
    expiresAfterDays: DEFAULT_FREE_TIER_EXPIRES_AFTER_DAYS,
    models: [...config.freeTierModels],
    tokensPerDay: n(env.FREE_TIER_TOKENS_PER_DAY, DEFAULT_FREE_TIER_LIMITS.tokensPerDay),
    globalTokensPerDay: n(env.FREE_TIER_GLOBAL_TOKENS_PER_DAY, 20_000_000),
  };
}
