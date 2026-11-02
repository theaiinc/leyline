# Valefront shared pool and customer BYOK

Status: design only. Valefront is the product name for Leyline. This proposal does not implement routing, authentication, storage, hosting, or deployment.

## Product interpretation

- `adm.valefront.com` is the operator console for Steve and explicitly allowlisted administrators. It replaces today's owner-only admin page and uses Aegis sign-in.
- `dash.valefront.com` is the customer dashboard.
- The shared pool is operator-level BYOK: provider keys supplied by the operator are shared across eligible users.
- Customer BYOK remains separate. A workspace may use `own keys only`, `pool only`, or `own keys first; pool fallback`.
- Each user has an independently enforced pool limit. A workspace-wide cap may additionally constrain all members.
- Pool usage will be chargeable later using Bookkeeper (`theaiinc/bookeeper`, `packages/pricing`) when its catalog lands. BYOK usage is displayed but is not charged as model cost.
- Interpretation requiring confirmation: per-user limits apply to pool-served usage, not a user's own BYOK usage; workspace administrators may manage limits only where explicitly authorized.

## Current constraints

The Worker/Express application uses D1 and currently serves the existing dashboard and `llm.theaiinc.com` custom domain. Aegis authentication and the admin allowlist are already present. Issued keys already have cap concepts including monthly tokens, requests per day/minute, monthly USD, and model allowlists; the implementation should reuse those semantics.

Provider secrets flow through `SecretStore`/`SecretManagerStore`, using encrypted persistence with `LEYLINE_STORE_KEY` or Arcana references. The router already has provider/model capability and model-pool concepts. The shared-pool selector belongs at provider-key selection, after capability and policy filtering but before provider invocation.

## Data model

Use opaque IDs and UTC timestamps.

### `workspaces`

- `id`, `name`, `slug`, `status`
- `pool_access_allowed`
- normalized `allowed_pool_models`
- default key-source policy
- workspace monthly USD/credit, token, and request caps
- credit balance/ledger reference and reset day
- created/updated timestamps

The workspace cap is an aggregate ceiling in addition to each member's allowance.

### `workspace_members`

- `workspace_id`, `user_id`, role (`owner`, `admin`, `member`), status
- per-user pool limit override: monthly USD/credits, monthly tokens, requests/day, requests/minute, allowed models
- alert preferences and timestamps

Effective limits are the operator default for new users, overridden by an explicit member setting, then intersected with workspace policy and cap. Store the selected policy explicitly as `own_only`, `pool_only`, or `own_first_pool_fallback`.

### `pool_keys`

One row per operator-provided provider key, allowing multiple keys for one provider:

- provider, label, `last4`, declared models/capabilities
- encrypted-store or Arcana secret backend/reference metadata, never plaintext
- weight and optional priority
- monthly spend/token/request caps and rate limits
- enabled state
- failure, 429, 5xx, consecutive-failure, last-error, cooldown, and last-success health fields
- usage-period metadata

Disabled, exhausted, and unhealthy must remain distinct states so the admin console can explain selection failures.

### `byok_keys`

Workspace-scoped customer keys, optionally associated with an owning member:

- `id`, `workspace_id`, optional `owner_user_id`
- provider, label, `last4`, backend/reference metadata
- declared models/capabilities and enabled state
- created, rotated, and disabled timestamps

Workspace owners/admins can manage workspace keys. Ordinary members cannot list another member's keys.

### `workspace_policies`

Keep policy history rather than silently overwriting it:

- workspace and effective policy
- pool enabled flag and allowed models
- default member limits and alert thresholds
- budget/credits and reset day
- version, actor, and effective timestamps

### `usage_records`

Record every logical request and each provider attempt needed for failover:

- request, workspace, and user IDs
- provider/model
- `source`: `pool` or `byok`
- pool key ID when pool; redacted BYOK key/source ID when BYOK
- prompt, completion, and total tokens
- pricing snapshot/version and calculated USD/credits
- status, latency, response class, and failover attempt
- created timestamp and billing period

Aggregate pool usage idempotently by user, workspace, pool key, and period. BYOK usage remains visible but is excluded from model-cost charging.

### Audits and alerts

`audit_events` records actor, target, action (`add`, `rotate`, `enable`, `disable`, policy/limit change), timestamp, request ID, and safe metadata. Never include plaintext secrets.

`limit_alerts` deduplicates 80% and 100% notifications per user, limit, and period, addressed to the user and Steve/operator. Alert failure must not affect request admission.

## Migration from the single-owner deployment

Make migration additive, idempotent, reversible, and preceded by a backup/export and dry-run report:

1. Create a default workspace owned by Steve using the existing owner identity and admin allowlist.
2. Convert each current provider key into a pool-key row, preserving provider/model capabilities, enabled state, secret account/reference, and a stable label without unnecessarily exporting plaintext.
3. Convert existing issued keys into default-workspace members/API credentials while retaining IDs, hashes, caps, model allowlists, PII settings, and usage history. Existing authentication must continue working.
4. Preserve current behavior for the migrated owner. Do not expose the pool to new users until an administrator enables a workspace/member.
5. Attribute historical usage where provable and mark unknown historical source as `legacy`.
6. Roll out schema/data migration before routing reads new records, with verification and a rollback flag.

## Secrets and security boundaries

- Encrypt provider values through the existing `LEYLINE_STORE_KEY` path, or store only an Arcana reference.
- Accept plaintext only over an authenticated create/rotate request, validate and immediately discard it. Responses show provider, label, status, and the last four characters only.
- Only `adm` routes, after Aegis authentication and admin-allowlist checks, may view or modify pool-key metadata or operations.
- Workspace BYOK keys are visible only to workspace owners/admins; members receive only permitted safe metadata.
- Audit every add, rotate, enable, disable, delete, policy change, limit change, and failed authorization. Audit reads are permissioned and rate-limited.
- Never log headers, secret payloads, Arcana values, or decrypted store contents. Enforce CSRF/origin protection for browser writes.

## Routing, limits, capability filtering, and failover

1. Authenticate the session/issued key and resolve user, workspace, policy, and current counters.
2. Apply existing model-registry and provider capability filtering, intersected with workspace and member allowed models, before credential selection.
3. For `own_only`, select an enabled compatible BYOK key or return a provider-unavailable error.
4. For `pool_only`, require workspace pool access and preflight the user's monthly spend/credits, monthly tokens, requests/day, requests/minute, workspace cap, key cap, and model allowance.
5. For `own_first_pool_fallback`, try an eligible BYOK key first; only configured unavailable/retryable failures may proceed to pool.
6. For pool selection, filter enabled compatible keys by model, caps, rate limits, cooldown, and health. Select by weight, with priority and health reducing or excluding unhealthy keys.
7. Reserve counters atomically before dispatch. On 429 or retryable 5xx, record health and the attempt, cool down the key, and fail over to another eligible pool key. Bound retries and do not duplicate non-idempotent requests.
8. Reconcile actual tokens/cost after completion and release or adjust reservations on admission failure. Persist source and key ID for every attempt.
9. If a user/workspace limit is exhausted, return a clear 429-style error naming the limit and reset time. If all compatible keys are unhealthy or exhausted, return a distinct temporary-capacity error. With own-first policy, BYOK remains usable when only pool budget is exhausted.
10. Emit 80% and 100% alerts asynchronously. Reuse the existing issued-key cap machinery where it can enforce per-user limits atomically.

## Hosting and host isolation

Add both custom domains to the Worker while retaining `llm.theaiinc.com` as an explicit compatibility host during migration:

- `adm.valefront.com`: separate Aegis admin client, admin callback/redirect URI, `/admin/*`, admin assets, auth callbacks, and an admin-safe health route.
- `dash.valefront.com`: separate Aegis customer client, customer callback/redirect URI, dashboard assets, customer API routes, and customer auth callbacks.

The exact callback paths must match Aegis registrations. Use separate client IDs and redirect allowlists so a customer session cannot become an admin session. Host routing must occur before dispatch: admin routes on `dash` and customer routes on `adm` return 404, not redirects or authorization hints. Authorization remains server-side.

## Admin console

On `adm.valefront.com`:

1. Pool keys: add/rotate/disable, provider/model metadata, weight/priority, caps, rate limits, last four, enabled state, health, cooldown, and recent errors.
2. Workspaces: create/suspend, members/roles, pool access, allowed models, workspace budget, and policy.
3. User limits: defaults, per-user overrides, current usage/reset, 80%/100% state, and alert delivery.
4. Usage: period/workspace/user/provider/model/source/pool-key filters, tokens, requests, cost/credits, failover and error rates.
5. Audit: key, policy, and limit changes with actor/request IDs.

## Customer dashboard

On `dash.valefront.com`:

- Add/rotate/disable BYOK keys with provider, label, models, and last-four display only.
- Show workspace policy and allow policy selection only when the operator permits it.
- Explain pool availability and allowed models without revealing pool secrets.
- Show personal pool usage, effective limits, reset dates, workspace cap status, and alerts.
- Split usage history by `pool` and `byok`; show pool cost/credits and BYOK usage without charging BYOK model cost.

## Phased delivery

1. **Schema and contracts:** add additive D1 tables, indexes, migrations, typed policy/usage models, audit events, and compatibility readers. Ship with routing unchanged.
2. **Secret and admin API:** implement encrypted/Arcana-backed pool/BYOK lifecycle, masking, audit, admin authorization, and migration dry-run tooling. Ship behind feature flags.
3. **Limits and metering:** add atomic per-user/workspace reservations, usage attribution, alerts, and Bookkeeper pricing adapter boundary. Ship reporting before admission enforcement.
4. **Routing:** integrate policy and capability filtering, weighted healthy selection, bounded 429/5xx failover, and clear exhaustion errors. Enable for the migrated workspace first.
5. **Host and UI split:** configure custom domains and separate Aegis clients, enforce host isolation, then ship admin pool/workspace screens and customer BYOK/policy/usage screens.
6. **Expansion:** migrate additional workspaces, enable charging only after Bookkeeper pricing is stable, and retire the compatibility admin page after adoption.

Each phase has a rollback/feature flag and is independently deployable.

## Open questions for Steve

1. Should per-user pool limits always exclude BYOK usage, including for `own_first_pool_fallback`?
2. Are limits denominated primarily in USD, credits, tokens, or a configurable combination, and what timezone/reset day applies?
3. Which users may administer limits, policies, and workspace members, and may workspace admins override operator defaults?
4. What are the initial default per-user limits, alert recipients/channels, and grace behavior at 80% and 100%?
5. Should a BYOK 429/5xx always fall back to pool, or only selected error classes?
6. What exact Aegis client IDs and redirect URI paths should be registered for `adm` and `dash`?
7. Which existing provider keys should be migrated immediately, and what initial weights, caps, and model allowlists should they receive?
8. Should `llm.theaiinc.com` remain a permanent compatibility host or have a dated sunset?
9. What Bookkeeper pricing/version should be used during the interim, and should pool credits be prepaid, invoiced, or both?
10. Should users see pool-key labels/provider health, or only model availability and their own limits? 