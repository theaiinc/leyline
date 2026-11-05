# Valefront Self-Serve Signup Design

> **Status:** implemented with prepaid billing (README, "Self-serve sign-up and billing"). Differences from this design:
> the free grant is stored in D1 (`free_grants`) rather than behind a separate FreeGrantService; the first API key is
> made in the same step as the workspace (one Turnstile check); a second account with an already-used email gets a
> workspace without free tokens instead of a refusal; per-key concurrency and the anomaly auto-pause are not built yet.

## Goals

Any person who authenticates through Aegis using the `leyline-dashboard` client can create and use an isolated Valefront workspace without an access-request step. Each workspace owns its keys, usage, billing state, history, grants, limits, and suspension state. Administrative capabilities remain restricted to `adminEmails` and the administrator surface is hosted separately behind Cloudflare Access at `adm.valefront.com`.

This change does not modify `router.ts` or `pii-redaction.ts`, and does not depend on another chat's branch.

## Onboarding state machine

Aegis sign-in resolves an account and email identity, then loads or creates the account's workspace:

1. `authenticated` — the Aegis session is valid and the account is identified.
2. `terms_required` — the user must accept the current Terms version.
3. `email_verification_required` — a verified email is required before any API key can be issued.
4. `turnstile_required` — the server must validate a Turnstile token with Cloudflare Siteverify.
5. `ready_for_key` — workspace creation/free-grant eligibility checks have passed.
6. `key_created` — the first API key is returned exactly once; only its hash is persisted.
7. `quickstart` — the dashboard shows working OpenAI-compatible and Anthropic-compatible curl examples targeting `https://llm.valefront.com`.

Every transition is server-authorized. The client cannot bypass Terms, email verification, or Turnstile by selecting a later state.

## Workspace isolation

The authenticated Aegis subject is the tenant boundary. Workspace lookup and mutations require the session subject, and all key, usage, billing, grant, audit, and history queries include the workspace identifier. Cross-workspace identifiers are not sufficient authorization.

The existing admin authorization remains separate: `adminEmails` may access administrative operations only. Regular workspace sessions cannot read another workspace's keys or usage, and administrative access is not granted by workspace ownership.

## Turnstile

Turnstile is required for:

- initial workspace creation;
- every API-key creation;
- Add-credit.

The browser widget must be configured for these domains:

- `dash.valefront.com`
- `valefront.com`

The site key is public configuration. The Siteverify secret is a Worker secret (for example `TURNSTILE_SECRET`) and is never committed or exposed to the dashboard. Server-side verification fails closed, including on missing, expired, malformed, or reused tokens.

## Abuse controls

- One free grant per normalized verified email and one per Aegis account subject. Both identities are persisted and checked atomically.
- Disposable email domains are rejected using a maintained blocklist module that can be updated independently of application logic.
- Workspace creation is limited per source IP, initially three attempts per rolling 24-hour period.
- Free-tier keys can call only the eligible model list, have independent per-key requests-per-minute and concurrency limits, and consume a daily token cap.
- A global administrator-configured daily free-tier budget is reserved atomically. Exhaustion returns an explicit HTTP 429 with a stable error code and retry guidance.
- Paid models remain unavailable until the workspace has paid credit.
- Sudden per-key or per-workspace spikes invoke the anomaly guard, automatically pause the key, and create an admin-review flag. Paused keys return HTTP 403.
- Administrators can suspend workspaces and keys. Suspended resources return HTTP 403 and do not leak tenant details.

All security-sensitive decisions are server-side and auditable.

## Free-grant interface

The signup flow consumes a narrow interface supplied by LeylineHotfix:

```ts
interface FreeGrantService {
  claimGrant(input: {
    workspaceId: string;
    verifiedEmailHash: string;
    aegisSubject: string;
    now: Date;
  }): Promise<{
    granted: boolean;
    tokens: number;
    expiresAt: Date;
    eligibleModels: string[];
  }>;
  getEligibility(workspaceId: string, now: Date): Promise<{
    eligibleModels: string[];
    remainingTokens: number;
    expiresAt: Date | null;
  }>;
}
```

The expected grant is 1,000,000 tokens with a 30-day expiry and an explicit eligible-model list. Claiming is idempotent and rejects a second grant for either the verified email or Aegis account. Until LeylineHotfix is merged, this repository uses the interface and a local adapter/test double rather than duplicating grant ownership.

## Audit events

The audit stream records immutable events for:

- `workspace.signup`;
- `workspace.terms_accepted`;
- `workspace.email_verified`;
- `workspace.turnstile_checked`;
- `api_key.created`;
- `free_grant.claimed` or `free_grant.rejected`;
- `workspace.suspended` / `workspace.unsuspended`;
- `api_key.suspended` / `api_key.unsuspended`;
- `anomaly.flagged`.

Events contain workspace and actor identifiers, outcome/error code, timestamp, and safe request metadata such as a hashed IP. Raw email addresses, API keys, Turnstile secrets, and tokens are not logged.

## Administrative boundaries

Admin endpoints require the existing `adminEmails` authorization and are intended to be exposed only through `adm.valefront.com` protected by Cloudflare Access. They support workspace/key suspension, anomaly review, global free-budget configuration, and audit inspection. No dashboard self-serve endpoint is elevated by the presence of an email address alone.

## Data and rollout assumptions

The implementation introduces the smallest storage abstraction needed for workspaces, onboarding state, grants, limits, suspensions, and audit events. Production persistence must use the existing server/Worker storage layer and migrations; in-memory state is limited to tests. Existing admin login and API-key behavior remains compatible while new keys carry an explicit workspace and free-tier policy.

Rollout order:

1. deploy schema and interface-compatible storage;
2. deploy server-side enforcement and admin controls;
3. configure Turnstile widgets for the two domains and set the Worker secret;
4. enable self-serve dashboard onboarding;
5. monitor signup, grant, rejection, anomaly, and budget metrics.

No secret or widget secret is included in this repository.

## Test plan

Focused tests cover:

- a first-time Aegis user receives an isolated workspace;
- a key cannot be created before email verification;
- failed Siteverify validation is rejected;
- disposable email is rejected;
- a second grant for the same email or Aegis subject is refused;
- free-tier model and rate/concurrency/token limits are enforced;
- global free budget exhaustion returns HTTP 429;
- suspended keys return HTTP 403;
- user A cannot read user B's keys or usage;
- signup, key creation, grant, and suspension audit events are emitted.

The matching `Get started` page will describe only flows and commands that are implemented and tested.