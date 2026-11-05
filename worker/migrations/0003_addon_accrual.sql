-- Paid add-ons (src/core/addons.ts), e.g. PII protection: accrued per workspace and add-on in millionths of a dollar,
-- like usage_accrual, and moved to the ledger in whole cents as their own line ("PII protection"). The balance
-- subtracts what is still accrued here (src/core/billing-store.ts balance()).
CREATE TABLE addon_accrual (
  workspace_id TEXT NOT NULL,
  addon TEXT NOT NULL,
  micros INTEGER NOT NULL,
  flushes INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, addon)
);
