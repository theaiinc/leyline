# Valefront shared provider-key pool

## Status and boundary

This is a design for the hosted Valefront product, which will live in the private `theaiinc/valefront` repository. It must not be pushed, proposed, or implemented in the public `theaiinc/leyline` repository.

Valefront uses Leyline as its gateway foundation:

- **Public Leyline candidates:** generic provider-key storage abstractions, multiple provider instances, weighted selection, health tracking, capability filtering, and provider failover useful to self-hosted installations.
- **Private Valefront:** workspaces, members, Aegis product access, operator administration, platform/shared keys, customer keys, per-user limits, budgets, usage charging, alerts, billing integration, custom hosted domains, and migration of the hosted single-owner service.

"Shared pool is basically BYOK but configured by admin" means there is one provider-key mechanism, not separate pool-key and BYOK models. A provider key has an `ownerScope`:

- `platform`: added by an administrator in `adm.valefront.com`; available to eligible users subject to their limits. This is the shared pool.
- `workspace`: added by workspace administrators in `dash.valefront.com`; available only to that workspace under its policy.

Both scopes share storage, encryption, provider configuration, model capability metadata, health tracking, routing/failover, and usage records. They differ in who may manage the key, who may use it, and which limits and charging rules apply.

## Current implementation baseline

The existing hosted Worker runs the same Express application as the Node server and serves dashboard assets through Wrangler. `wrangler.jsonc` currently has one `llm.theaiinc.com` custom domain, D1 binding `DB`, hosted keys enabled, Aegis login configuration, `LEYLINE_ADMIN_EMAILS`, and a monthly budget variable.

Relevant existing behavior to preserve or extend:

- `src/core/admin-login.ts` authenticates the dashboard through Aegis and derives the signed-in identity. Admin authorization currently comes from the configured email allowlist.
- `src/core/issued-keys.ts` owns issued-key records, caps such as tokens/month, requests/day and requests/minute, model restrictions, monthly USD caps, usage counters, and budget alerts. The new pool limits should reuse its cap and accounting semantics where practical, while adding user identity and source-aware records.
- `src/core/secret-store.ts` supports encrypted/persistent stores and Arcana-backed references. `LEYLINE_STORE_KEY` protects locally persisted secrets; Arcana references remain references and are resolved only when needed.
- `src/core/secret-manager-store.ts` provides a hosted Secret Manager implementation for deployments that do not use a local keychain.
- The router already has model-pool behavior and provider capability filtering. Pool selection should become a provider-instance selection step, not a replacement for capability checks.
- `worker/migrations/0001_init.sql` is the baseline D1 schema. Valefront should add forward-only migrations in its private repository rather than altering public Leyline schema for hosted-product concerns.
- The existing dashboard includes key-management pages such as `dashboard/src/pages/keys.tsx`; the same dashboard build will serve both product hosts.
- Existing issued keys and the current owner-oriented hosted configuration are compatibility inputs, not reasons to create a second secret or routing system.

## 1. Data model

All records below are private Valefront D1 records unless explicitly marked as a possible public-core abstraction. IDs are opaque random identifiers. Timestamps are UTC ISO strings or integer milliseconds consistently within the implementation.

### `workspaces`

- `id`
- `name`
- `status`
- `created_at`, `updated_at`
- `pool_access_enabled`
- `workspace_pool_budget_usd` or credits, nullable
- `workspace_pool_tokens`, nullable
- `workspace_pool_requests_per_day`, nullable
- `workspace_pool_requests_per_minute`, nullable
- `alert_email` or notification settings

A workspace cap is an optional aggregate ceiling on platform-key usage across its members. It is applied in addition to each user's limit.

### `workspace_members`

- `workspace_id`
- `user_id` (Aegis subject or stable account identity)
- `role`: `member`, `admin`, or `owner`
- `status`
- `created_at`, `updated_at`

A unique `(workspace_id, user_id)` constraint prevents duplicate membership. Server-side authorization must check membership and role on every workspace API request.

### `users`

- `id` (stable Aegis subject)
- `email`
- `display_name`
- `status`
- `created_at`, `updated_at`
- optional notification fields

A user has a default pool limit inherited from product configuration and an optional override.

### `pool_limits`

This is the per-user limit for platform-scope keys.

- `user_id`
- `default_or_override`
- `monthly_spend_usd` or credits
- `monthly_tokens`
- `requests_per_day`
- `requests_per_minute`
- `allowed_models` (normalized table preferred; JSON is acceptable only for the first migration)
- `effective_at`, `updated_at`
- alert state for 80% and 100% notifications

The limit applies to the user's aggregate platform-key usage across workspaces. If the product decides limits are workspace-member specific instead, use a scoped key `(workspace_id, user_id)`; this is an open question below.

### `provider_keys`

This is the unified key record.

- `id`
- `owner_scope`: `platform` or `workspace`
- `workspace_id`, nullable for `platform`
- `provider`
- `label`
- `secret_account` or secret reference identifier; never the plaintext key
- `secret_source`: encrypted store or Arcana reference
- `last4`
- `models` / normalized `provider_key_models`
- provider endpoint and instance configuration, where required
- `weight` and optional `priority`
- `monthly_spend_cap_usd` or credits, nullable
- rate limits (requests/minute, requests/day, tokens/month if key-specific)
- `enabled`
- health counters: failures, 429s, 5xxs, consecutive failures, last error, last error time, cooldown until
- `created_by`, `updated_by`
- `created_at`, `updated_at`, `disabled_at`

A platform key has no workspace owner. A workspace key must reference exactly one workspace. A key's model list is an allowlist intersected with the provider's discovered/configured capabilities.

### `workspace_policies`

- `workspace_id`
- `key_source_policy`: `own_only`, `pool_only`, `own_first_pool_fallback`
- `pool_access_enabled`
- `allowed_pool_models`
- optional default behavior for models not explicitly allowed
- `updated_by`, `updated_at`

The policy is evaluated in addition to user limits and key availability. `own_first_pool_fallback` means a user's own workspace key is attempted first; platform usage is not consumed unless routing actually falls back to a platform key.

### `usage_records`

One immutable record per completed or attempted provider serving event.

- `id`
- request/correlation ID
- `user_id`, nullable only for explicitly unauthenticated internal operations
- `workspace_id`
- `provider_key_id`
- `key_source`: derived as `platform` or `workspace`
- provider and model
- prompt tokens, completion tokens, total tokens
- estimated/provider-reported cost
- pricing version/catalog reference, nullable until Bookkeeper pricing is available
- request status and failure category
- HTTP status
- created_at

Usage must record the source even for failed attempts where a provider key was selected. Retries/failover attempts need either one child attempt table or an attempt number on each record.

Platform usage is chargeable product usage. Workspace-key usage is displayed in analytics but is not charged as Valefront model cost. When `theaiinc/bookeeper` pricing (`packages/pricing`) is available, the private product records the catalog version and computes chargeable pool credits/cost from it rather than embedding prices in routing code.

### `audit_events`

- actor identity and role
- action (`add`, `rotate`, `disable`, policy/limit change, access denial)
- target type and identifier
- metadata and timestamp
- request correlation ID where applicable

## Ownership boundary: public Leyline versus private Valefront

This design is for the private `theaiinc/valefront` repository. Nothing in this document should be implemented, committed, or pushed to the public `theaiinc/leyline` repository as a Valefront feature.

Some lower-level capabilities are useful to self-hosters and may later be proposed independently in Leyline, without mentioning Valefront:

**Public Leyline candidates**
- Multiple provider instances/keys for one provider.
- Provider-instance model configuration and capability filtering.
- Weighted selection, health tracking, cooldowns, and retry/failover for provider instances.
- Generic request-attempt telemetry hooks that do not contain Valefront users, workspaces, limits, billing, or hosted-domain assumptions.
- Existing encrypted/Arcana-backed secret-store primitives, with their current operational contract.

**Private Valefront**
- Platform/workspace ownership scopes and multi-user identity.
- Workspaces, memberships, admin roles, policies, per-user limits, workspace caps, alerts, and usage enforcement.
- `adm.valefront.com`, `dash.valefront.com`, admin-only APIs, customer screens, billing/credits, Bookkeeper integration, and migration of the hosted single-owner installation.
- The unified provider-key records described below when they carry Valefront ownership, access, charging, or user-limit semantics.

## Hosting and authentication

`adm.valefront.com` and `dash.valefront.com` are two custom domains for the same dashboard application and Worker/API, not separate applications. The existing Aegis login flow is shared. The exact Aegis client IDs and redirect URIs must be provisioned for both origins:

- `https://adm.valefront.com/` (or the chosen callback path) for the admin origin.
- `https://dash.valefront.com/` (or the chosen callback path) for the customer origin.

The final callback path must match the existing `admin-login.ts` route contract and be registered exactly in Aegis; do not infer or silently reuse a URI before the Aegis tenant configuration is confirmed. The Worker custom-domain configuration should list both hostnames, and environment configuration should replace the current single hosted URL with the Valefront origins while preserving local development.

Host authorization is server-side:
- Requests to `dash.valefront.com` can use customer APIs and shared dashboard APIs, but all admin views and admin API routes return 404. Hiding buttons is not an access control.
- Requests to `adm.valefront.com` use the same login and dashboard code, but require an authenticated email in `LEYLINE_ADMIN_EMAILS` (currently `stevetran.dev@gmail.com,steve.tran@theaiinc.com`). Steve's account, `steve.tran@theaiinc.com`, is therefore an admin from the first release. A non-admin cannot use adm, even if authenticated.
- Every admin API handler repeats the server-side admin check. Admin routes also verify the expected host so a route cannot be reached through dash.
- Customer routes are host-scoped to dash; adm may expose the shared common customer shell only as needed for admin workflows, but admin data remains admin-authorized.
- Unknown hosts and cross-host attempts receive an appropriate 404 rather than revealing route existence.

Keep `LEYLINE_ADMIN_EMAILS` as the break-glass source. Later, admin roles may be seeded into D1 and managed from adm, but an environment allowlist must continue to grant emergency access and must not be removable through the UI. Any D1 role cannot reduce access granted by the break-glass list without an explicit future policy decision.

## Admin console and customer dashboard

Because adm is the dashboard application for admins, use shared components, auth, API clients, and layout rather than creating a second frontend.

On adm, the signed-in admin sees:
1. **Pool / provider keys**: unified key records filtered to `owner_scope=platform`; add, rotate, disable, model capabilities, labels, weights, spend caps, rate limits, and health. Secrets are never displayed.
2. **Users and limits**: users, workspace membership, default policy, per-user pool limits, overrides, current-period usage, 80%/100% alerts, and reset dates.
3. **Workspaces and policies**: workspace members, pool access, allowed pool models, key-source policy, workspace pool cap/credits, and audit history.
4. **Usage**: filters by workspace, user, provider, model, source, key, status, tokens, estimated cost, and period; platform usage is separated from workspace-key usage.
5. **Audit and operations**: key lifecycle events, policy/limit changes, failures, 429s, 5xxs, and exhausted-key/budget events.

On dash, a workspace admin sees only:
1. Workspace-key records (`owner_scope=workspace`) for their workspace, with label/provider/models/status and last four characters.
2. The workspace's key-source policy and the pool models/permissions granted by adm.
3. Usage for authorized workspace members, with source and tokens; workspace-key usage is informational and not charged as Valefront model cost.
4. The current user's pool limits and usage, including reset times and alerts.

Dash does not render or expose pool-key management, all-user usage, other workspaces, or admin APIs. A workspace admin cannot see another member's secret or any platform key secret.

## Phased plan

Each phase is independently shippable and should be deployed only from the private Valefront repository.

### Phase 1 — safe provider-instance foundation (public-core candidate)

Extract or extend the generic provider-instance abstraction behind the existing router model pool. Add multiple instances per provider, explicit capabilities/models, weighted selection, health counters, cooldowns, and bounded retry/failover for 429/5xx. Preserve current single-key configuration as one instance and preserve existing provider behavior. Add unit/integration tests for capability filtering, weighted selection, health suppression, and failover. Keep user, workspace, billing, and Valefront host concepts out of this phase.

### Phase 2 — unified provider-key storage and migration (private Valefront)

Create one encrypted/Arcana-compatible provider-key record with `owner_scope` (`platform` or `workspace`), owner identifier, provider-instance configuration, metadata, health, and lifecycle audit. Build migration tooling that:
- Imports today's single provider keys as enabled platform records without exposing plaintext.
- Creates Steve's default workspace and membership.
- Associates existing issued keys with that workspace while preserving their identifiers and caps.
- Keeps legacy environment-key fallback during migration and makes rollback possible.
- Verifies counts, ownership, and secret-source status before retiring legacy paths.

### Phase 3 — identity, host separation, and authorization (private Valefront)

Add workspace/member records, session identity mapping, the shared dashboard host handling, and server-side admin authorization. Register both custom domains and Aegis redirect URIs. Keep the environment admin list as break-glass access, seed Steve, and add host-specific 404 tests for admin routes on dash and customer boundaries on adm.

### Phase 4 — key management and routing policy (private Valefront)

Ship adm platform-key management and dash workspace-key management using the same record/storage APIs. Add policy evaluation (`own_only`, `pool_only`, `own_first_pool_fallback`) before provider selection. Filter requested models against workspace permissions and per-key capabilities. Select weighted healthy instances and retry another eligible key on 429/5xx. A disabled/unhealthy/exhausted key is skipped; if no eligible key remains, return a clear temporary-unavailable response. A policy that forbids pool access never falls back to it.

### Phase 5 — metering and limits (private Valefront)

Record an attempt and final usage with key source, provider-key ID, tokens, status, and pricing reference. Enforce user monthly spend/credits, monthly tokens, requests per minute/day, and allowed models before dispatch; enforce the optional workspace pool cap as a second reservation. Use atomic D1/transactional reservation semantics so concurrent requests cannot overspend. Return a 429-style error naming the exhausted limit and reset time. With `own_first_pool_fallback`, a failed user-limit check may still use an eligible workspace key; pool usage is charged only when a platform key actually serves the request.

### Phase 6 — alerts, charging integration, and operational hardening (private Valefront)

Add 80% and 100% alerts to the user and Steve, dashboards for usage and health, and reconciliation for provider-reported usage. Integrate Bookkeeper's `packages/pricing` catalog when its contract is stable; store catalog version and calculate platform charges/credits from it rather than hardcoding prices. Add audit export, retention rules, abuse/rate-limit protections, migration rollback drills, and failure-mode tests. Only then remove legacy hosted-owner paths.

## Open questions for Steve

1. Should limits be denominated primarily in USD, credits, or both, and what conversion/rounding policy applies before Bookkeeper pricing exists?
2. What are the default per-user monthly spend, monthly tokens, requests/minute, and requests/day, and should a new user receive pool access automatically?
3. Is the optional workspace cap a hard reservation cap, a soft alert threshold, or both? What happens to existing in-flight requests near the cap?
4. Should admins be able to manage D1 admin roles from adm in the first release, or should the environment allowlist remain the only role source initially? The design recommends seeding roles later while retaining the allowlist as break-glass.
5. Which Aegis tenant/client IDs and exact callback paths should be registered for adm and dash?
6. Which provider/model families are in the first release, and are model aliases/capability metadata centrally managed or editable per key?
7. What health window, cooldown, and maximum retry count should apply, and should a provider 5xx consume a key's monthly cap reservation?
8. What notification channels should receive 80%/100% alerts, and who besides Steve may receive operational key-health alerts?
9. What retention period and export requirements apply to per-request usage and audit records?
10. Should platform keys be eligible for all workspaces by default, or require an explicit per-workspace enablement and model allowlist?
11. What is the rollback policy if migrating the current single-owner keys or issued keys reveals inconsistent ownership?
12. Should workspace admins see aggregate member usage only, or individual member usage and limits as proposed above?
13. Confirm that "shared pool is basically BYOK configured by admin" means the single unified provider-key model with platform/workspace ownership scopes, rather than separate pool and BYOK tables. This document assumes that unified interpretation.
14. Confirm that adm and dash may share one Worker/API deployment and frontend build, with host-based route authorization, rather than separate services.
15. Confirm the private repository name and initial deployment environments for Valefront; no Valefront implementation or deployment is to be made in public Leyline.