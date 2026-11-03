# Valefront shared pool and free-token allowance

## Free-token allowance

The intended Valefront product behavior is pay-as-you-go at the provider's official price, with no markup. Every new account or workspace receives a configurable default grant of 1,000,000 input-plus-output tokens. Each grant has an `expires_at`, defaulting to 30 days after grant creation; unused tokens disappear at expiry. The dashboard must show both the remaining balance and its expiry (for example, "X free tokens left, expires <date>"). Admin settings may change the default grant amount, duration, and eligible-model list for future grants.

The grant applies only to an admin-editable eligible-model list, initially the BytePlus ModelArk chat models covered by the coupon. A free request is selected only when the request's capabilities (vision, tools, context length, and so on) can be served by an eligible model. A user-pinned model outside the eligible list is paid, even if another eligible model could serve the request. Once the grant runs out or expires, requests are charged normally.

Free routing is an accounting decision as well as a model decision. Among capable eligible candidates, the router should prefer providers with an administered prepaid credit that expires soonest (for example the BytePlus ModelArk $600 credit expiring 2026-12-02), then providers with configured volume discounts, then the lowest official list price. Credits are explicit records (`provider`, amount, expiry), not data scraped from provider consoles. The selection must ignore expired/exhausted credits, respect `providerBudgetsUsd`, and skip unhealthy providers; 429/5xx or an over-budget provider falls through to the next capable candidate. If no eligible candidate remains, the request is paid or fails clearly according to the normal routing policy.

This allowance and its routing policy belong in the private Valefront product, not the public Leyline core. The current public repository has no account/workspace identity, durable billing ledger, free-grant balance, admin settings store, provider-credit ledger, atomic reservation/debit operation, or hosted dashboard balance surface that can safely implement them. The existing `docs`/`secrets` D1 documents and issued-key caps are not a substitute: they do not provide expiry-safe per-account debits, capability-aware free routing, billing reconciliation, or the required alerts. The first Valefront implementation should add durable grant, credit, and usage ledgers with atomic reservation/debit operations, keyed by account or workspace, and expose the remaining balance and expiry to the dashboard. It should charge only pool-sourced usage; workspace BYOK usage is displayed but is not charged as model cost.

The public endpoint in this PR deliberately reports the free-tier shape with an empty model list until the private product configures its eligible BytePlus model IDs. It includes `expires_after_days: 30` as the public default. The private product may expose the admin-selected period in this field, but the open-source gateway must never invent account grants, coupon balances, or provider-credit state.

### Expiry and intelligent free routing (Valefront)

A grant is a durable account/workspace record with `granted_tokens`, `remaining_tokens`, `granted_at`, `expires_at`, and the eligible model IDs captured from admin settings. The default expiry is 30 days after grant creation; changing the admin setting affects newly issued grants unless Steve explicitly chooses a migration policy. Reservation and debit must be atomic and must reject a grant when `now >= expires_at`, so expired unused tokens can never be consumed. The dashboard displays `free tokens left, expires <date>`; an expired grant displays zero available tokens and its expiry date. Once no valid balance remains, usage is charged at the official provider price.

Free routing is attempted only for an eligible request. Capability filtering must happen before ranking (vision, tools, context length, and other request requirements). If the caller pins a model that is not in the eligible list, that request is billed normally rather than silently switching to an eligible model. Among remaining capable candidates, rank providers by: (1) an administered, positive, unexpired and unexhausted prepaid credit with the soonest expiry; (2) configured volume-discount priority; (3) lowest official input-plus-output list price. A credit is an explicit record containing provider, amount, and expiry; no provider console is scraped. The candidate selector must skip unhealthy providers and providers whose `providerBudgetsUsd` is exhausted, then try the next candidate after a 429 or 5xx. If all candidates are unavailable, follow normal paid routing or return the existing provider-unavailable error; never consume the grant without a successful reservation/debit.

The private Valefront test plan must cover: an expired grant refusing consumption; an expiring provider credit outranking a cheaper provider; fallback when the preferred provider is over budget; and a pinned non-eligible model being billed. These tests belong with the private grant ledger/router integration, not as fake account state in public Leyline.

## Shared-pool placement

The shared pool is "BYOK configured by admin", not a second key mechanism. A provider key has one storage representation and an owner scope:

- `platform`: configured by an administrator and shared across users, subject to per-user and optional workspace limits.
- `workspace`: configured by workspace administrators and usable only in that workspace.

Both scopes should share encryption, provider-instance configuration, health tracking, weighted routing, failover, capability filtering, and source-aware usage records. Multi-user identity, admin views, limits, charging, billing, and hosting remain private Valefront product code. Generic multi-key provider routing can be contributed to public Leyline independently.

The current public core does not yet contain the account/workspace and platform-key primitives described above; this document records the boundary rather than pretending they exist.