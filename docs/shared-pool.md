# Valefront shared pool and free-token allowance

## Free-token allowance

The intended Valefront product behavior is pay-as-you-go at the provider's official price, with no markup. Every new account or workspace receives a configurable default grant of 1,000,000 input-plus-output tokens. The grant applies only to an admin-editable eligible-model list, initially the BytePlus ModelArk chat models covered by the coupon. Once exhausted, eligible requests are charged normally. Requests using ineligible models never consume the grant.

This belongs in the private Valefront product, not the public Leyline core. The current public repository has no account/workspace identity, durable billing ledger, free-grant balance, admin settings store, or hosted dashboard balance surface that can safely implement this behavior. The existing `docs`/`secrets` D1 documents and issued-key caps are not a substitute: they do not provide atomic per-account token debits, model eligibility configuration, billing reconciliation, or the required 80%/100% alerts. The first Valefront implementation should add a durable grant and usage ledger with an atomic reservation/debit operation, keyed by account or workspace, and expose the remaining balance to the dashboard. It should charge only pool-sourced usage; workspace BYOK usage is displayed but is not charged as model cost.

The public endpoint in this PR deliberately reports the free-tier shape with an empty model list until the private product configures its eligible BytePlus model IDs. It must never invent a free grant in the open-source gateway.

## Shared-pool placement

The shared pool is "BYOK configured by admin", not a second key mechanism. A provider key has one storage representation and an owner scope:

- `platform`: configured by an administrator and shared across users, subject to per-user and optional workspace limits.
- `workspace`: configured by workspace administrators and usable only in that workspace.

Both scopes should share encryption, provider-instance configuration, health tracking, weighted routing, failover, capability filtering, and source-aware usage records. Multi-user identity, admin views, limits, charging, billing, and hosting remain private Valefront product code. Generic multi-key provider routing can be contributed to public Leyline independently.

The current public core does not yet contain the account/workspace and platform-key primitives described above; this document records the boundary rather than pretending they exist.