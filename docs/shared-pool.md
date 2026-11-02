# Valefront shared pool and customer BYOK

Status: design only. This document proposes the smallest safe path for Valefront (the product name for Leyline); it does not change routing, authentication, storage, hosting, or deployment.

## Product boundary and interpretation

- `adm.valefront.com` is the operator console for Steve and other explicitly allowlisted administrators. It replaces the current owner-only admin page and uses Aegis sign-in.
- `dash.valefront.com` is the customer dashboard. It is the only customer-facing management host.
- The shared pool is operator-level BYOK: keys brought by Steve/the operator are shared across eligible customer users, subject to per-user and workspace limits.
- Customer BYOK remains separate. A workspace can add provider keys and select `own keys only`, `pool only`, or `own keys first; pool fallback`.
- "Per-user limits" means the pool is shared, but each user has an independently enforced pool allowance. A workspace-wide cap may additionally constrain all users in that workspace.
- "Cost" is initially recorded using the current provider/cost representation. Once Bookkeeper (`theaiinc/bookeeper`, `packages/pricing`) ships its pricing catalog, pool metering should use that catalog. BYOK usage is visible but is not charged as model cost.
- Open interpretation: this design treats a user's limit as applying to pool-served usage only, not to that user's own BYOK usage. Steve should confirm whether workspace administrators may exempt or delegate limit administration.

## Current implementation constraints

The current hosted deployment runs one Worker/Express application with D1, serves assets through `wrangler.jsonc`, and currently uses `llm.theaiinc.com` as its custom domain. Authentication uses the configured Aegis issuer/client and an admin email allowlist. Issued keys already carry caps such as monthly tokens, requests per day/minute, monthly USD, model allowlists, and usage accounting; the shared-pool design should reuse those cap semantics rather than create a second, subtly different limiter.

Provider secrets currently flow through the `SecretStore` family. Depending on deployment they are encrypted/persisted with `LEYLINE_STORE_KEY`, stored in a compatible persistent store, or resolved through Arcana references. The store interfaces intentionally return secret values only to the provider path; Arcana references are read-only from Leyline. The dashboard currently exposes provider/key management and issued-key settings, but not workspace membership or a pool inventory.

The router already has model-pool/capability filtering concepts. The shared-pool selector should be inserted at the provider-key selection boundary, after request/model capability checks and before provider invocation, so model availability and policy cannot be bypassed by selecting another key.

## Data model

Use stable opaque IDs and timestamps in UTC. Secrets are never stored in these records.

### `workspaces`

- `id`
- `name`, `slug`
- `status` (`active`, `suspended`)
- `pool_access_allowed`
- `allowed_pool_models` (normalized model IDs; empty means no pool model is permitted, never "all" by accident)
- `default_policy`
- workspace pool budget/credits: `monthly_usd_limit`, `monthly_token_limit`, `monthly_request_limit`, `credits_remaining` or an equivalent ledger
- `created_at`, `updated_at`

The workspace cap is an aggregate ceiling above each member's pool allowance. A request must pass both limits.

### `workspace_members`

- `workspace_id`, `user_id`
- role (`owner`, `admin`, `member`)
- per-user pool limit override: monthly USD/credits, monthly tokens, requests per day, requests per minute, allowed pool models
- alert preferences and `status`
- audit timestamps

Resolve effective limits as: operator default for new users, overridden by the member record, then intersected with workspace policy and workspace cap. Store the policy explicitly as `own_only`, `pool_only`, or `own_first_pool_fallback`.

### `pool_keys`

One record per operator-provided provider key, allowing several keys for the same provider.

- `id`, `provider`, `label`
- secret backend (`encrypted_store` or `arcana`) and secret account/reference metadata, never the plaintext
- `last4`
- declared `models`/capabilities
- selection `weight` and optional priority
- per-key monthly USD/token/request caps and rate limits
- `enabled`
- health counters: failures, 429s, 5xxs, consecutive failures, `last_error`, `last_error_at`, `cooldown_until`, `last_success_at`
- usage period/version timestamps

Pool-key records are operator-only. "Disabled" must be distinct from exhausted or unhealthy so the console can explain why a key was not selected.

### `byok_keys`

Scoped to a workspace and optionally a member/owner.

- `id`, `workspace_id`, optional `owner_user_id`
- provider, label, `last4`, secret backend/account/reference
- declared models/capabilities, enabled state
- created/rotated/disabled timestamps

Workspace admins can manage that workspace's BYOK records; ordinary members cannot list or reveal another member's keys. No API response returns a secret after create or rotate.

### `workspace_policies`

Keep policy history rather than overwriting it invisibly.

- workspace ID and effective policy
- pool enabled flag
- allowed pool models
- default member limits and alert thresholds
- workspace budget/credits and reset day
- version, actor, effective timestamps

### `usage_records`

Append one record per completed provider attempt or one logical request with attempt children; the latter is preferable for failover accounting.

- request ID, workspace ID, user ID, model/provider
- `source`: `pool` or `byok`
- `pool_key_id` when pool; BYOK key ID or a redacted BYOK source identifier when BYOK
- prompt/completion/total tokens
- pricing snapshot/version and calculated USD/credits
- status, latency, provider response class, failover attempt number
- created timestamp and billing period

Pool usage must be idempotently aggregated into per-user, workspace, per-pool-key, and daily/monthly counters. BYOK usage is retained for display and capacity reporting but excluded from model-cost charging.

### `audit_events` and `limit_alerts`

Audit events include actor, workspace/key target, action (`add`, `rotate`, `disable`, `enable`, policy/limit change), timestamp, request ID, and safe metadata. Never put plaintext secrets in audit data.

Alert records deduplicate 80% and 100% notifications per user/limit/period, and identify the recipient (user and Steve/operator). Send alerts when usage crosses a threshold; do not let an alert failure change request admission.

## Migration from the current single-owner deployment

Migration must be additive and reversible:

1. Create a default workspace owned by Steve, using the current owner identity and existing admin allowlist.
2. Convert each current provider key into a pool-key record with a stable label, its current provider/model capabilities, enabled state, and conservative default weight/caps. Preserve its existing secret account/reference; do not export or re-encrypt plaintext unnecessarily.
3. Convert existing issued keys into members/API credentials of the default workspace, retaining IDs, hashes, caps, model allowlists, PII settings, and usage history. Existing key authentication must continue to resolve during and after migration.
4. Set the default workspace policy to preserve today's behavior: pool access enabled for the migrated owner, and a default policy equivalent to the current provider path. Do not silently expose the pool to new users until an administrator enables a workspace/member.
5. Backfill usage attribution where it is provable; mark historical rows as `legacy` when the serving key source cannot be known.
6. Deploy schema/data migration with a dry-run report, backup/export, idempotency key, and rollback flag. Only after verification should new routing read pool/workspace records.

## Secrets and security boundaries

- Store encrypted values using the existing `LEYLINE_STORE_KEY` path, or store only an Arcana reference when Arcana is selected. Keep the provider secret account separate from display metadata.
- Create/rotate accepts plaintext only over the authenticated write request, validates it, stores it, and immediately discards it. Responses show only `last4`, provider, label, and status.
- Pool keys are visible or mutable only through `adm` routes after Aegis authentication and the admin allowlist. Customer routes must not disclose pool secret metadata beyond policy-visible availability.
- Workspace BYOK keys are visible only to workspace admins/owners; members receive only whether a permitted key/policy exists and safe last-four metadata if product policy allows it.
- Every add, rotate, enable, disable, delete, policy change, limit change, and failed authorization is audited. Audit reads are also permissioned and should be rate-limited.
- Never log request headers, secret payloads, Arcana values, or decrypted store contents. Enforce CSRF/origin protections for browser writes and use constant-time token/hash comparisons where applicable.

## Routing, limits, capability filtering, and failover

1. Authenticate the issued key/session and resolve user, workspace, effective policy, and current period counters.
2. Apply the existing model registry/capability filtering and workspace/member allowed-model intersection before choosing a credential.
3. For `own_only`, select an enabled compatible BYOK key or return a clear provider-unavailable error.
4. For `pool_only`, require pool access, then preflight the user's monthly USD/credits, monthly tokens, daily/minute requests, workspace cap, and requested model. A failed preflight returns a 429-style error naming the exhausted limit and reset time.
5. For `own_first_pool_fallback`, try an eligible BYOK path first. If it is unavailable or fails according to the configured fallback policy, run the pool preflight and select a pool key.
6. For pool selection, filter enabled keys by provider/model capability, per-key caps/rate limits, cooldown/health, and workspace allowed models. Choose by weighted selection, with priority/health reducing or removing unhealthy candidates. Do not select an exhausted key.
7. On a provider 429 or retryable 5xx, record health and the attempt, cool down/back off that key, and fail over to another eligible pool key. Bound attempts and never duplicate a non-idempotent request. A BYOK-first request may fall back to pool only when policy says the error is eligible.
8. If all compatible pool keys are exhausted/unhealthy, return a clear 429/503 distinction: limit/budget exhausted includes reset time; temporary provider capacity says no eligible healthy key. With own-first policy, BYOK remains usable when only the pool budget is exhausted.
9. Reserve counters before dispatch, reconcile actual tokens/cost after completion, and release/adjust reservations on admission failure. Persist source and key ID for every attempt and logical request.
10. Emit 80%/100% user alerts asynchronously. Enforce per-minute/day limits atomically in D1 or the existing cap mechanism to avoid concurrent-request oversubscription.

## Hosting and host isolation

Add both custom domains to the Worker configuration and keep the existing API/domain compatibility during migration:

- `adm.valefront.com`: Aegis client registration and redirect URI such as `https://adm.valefront.com/auth/callback`; serves only `/admin/*`, admin auth/session callbacks, admin assets, and an admin-safe health route.
- `dash.valefront.com`: separate Aegis client registration and redirect URI such as `https://dash.valefront.com/auth/callback`; serves customer dashboard assets, `/api/*` customer routes, and customer auth/session callbacks.

The exact callback paths must match the Aegis client registrations; use separate client IDs and redirect allowlists so a dashboard session cannot be promoted to admin. Host routing must happen before route dispatch: admin paths on `dash` and customer paths on `adm` return 404, not a redirect or authorization hint. API route authorization remains server-side even if assets are hidden. `llm.theaiinc.com` should remain an explicit compatibility host until customers are migrated, with a documented sunset.

## Admin console (`adm.valefront.com`)

Screens:

1. Pool keys: add/rotate/disable, label/provider/models, weight/priority, caps/rate limits, last four, enabled state, health, cooldown, and recent errors. Secret values are never rendered.
2. Workspaces: create/suspend, members and roles, pool access, allowed models, workspace cap/budget, and effective policy.
3. User limits: default limits, per-user overrides, current usage/reset, 80%/100% status, and alert delivery.
4. Usage: filters by period/workspace/user/provider/model/source/pool key, tokens, requests, cost/credits, failover and error rates; export only redacted data.
5. Audit: key/policy/limit changes and actor/request IDs.

## Customer dashboard (`dash.valefront.com`)

Add:

- BYOK key list and add/rotate/disable flow with provider, label, models, and last four only.
- Workspace policy display and, where permitted, policy selection among own-only/pool-only/own-first.
- Pool availability and allowed model explanation without exposing pool secrets.
- Personal pool usage, effective limits, reset dates, workspace cap status, and 80%/100% notices.
- Usage history split by `pool` and `byok`, with