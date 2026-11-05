-- Self-serve workspaces and prepaid billing (src/core/billing-store.ts). All money is integer US cents.

-- One workspace per Aegis account. A deleted workspace keeps its row (anonymized) because the ledger, invoices and
-- receipts point at it and are kept for accounting.
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  owner_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  name TEXT,
  terms_version TEXT NOT NULL,
  terms_accepted_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  suspended_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX workspaces_email_hash ON workspaces (email_hash);

-- The free grant: one per verified email and one per Aegis account, ever (hashes only, kept after deletion so a
-- deleted account can't sign up again for another grant).
CREATE TABLE free_grants (
  workspace_id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL UNIQUE,
  sub_hash TEXT NOT NULL UNIQUE,
  tokens INTEGER NOT NULL,
  used_tokens INTEGER NOT NULL DEFAULT 0,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Free-tier tokens by workspace and UTC day (the daily cap), and across workspaces (the global daily budget).
CREATE TABLE free_usage_days (
  workspace_id TEXT NOT NULL,
  day TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, day)
);
CREATE TABLE free_budget_days (
  day TEXT PRIMARY KEY,
  tokens INTEGER NOT NULL
);

-- What the customer puts on their invoices.
CREATE TABLE billing_profiles (
  workspace_id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Add-credit orders. amount_cents is the credit bought; total_cents what the customer pays (credit + VAT).
CREATE TABLE billing_orders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  method TEXT NOT NULL,
  -- live, or sandbox (a test payment: its receipt is marked SANDBOX and numbered apart from real ones).
  mode TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  vat_rate_bp INTEGER NOT NULL,
  vat_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  buyer TEXT NOT NULL,
  -- The VAT invoice the customer asked for with this order (JSON), or NULL.
  einvoice_request TEXT,
  account TEXT,
  provider_order_id TEXT UNIQUE,
  provider_capture_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  paid_by TEXT,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX billing_orders_workspace ON billing_orders (workspace_id, created_at);
CREATE INDEX billing_orders_status ON billing_orders (status, created_at);

-- The ledger: the only source of a workspace's balance. source_key makes every entry happen at most once
-- ("order:<id>" for a payment, "usage:<workspace>:<n>" for usage).
CREATE TABLE ledger (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source_key TEXT NOT NULL UNIQUE,
  order_id TEXT,
  description TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX ledger_workspace ON ledger (workspace_id, created_at);

-- Usage not yet moved to the ledger: millionths of a dollar, moved in whole cents.
CREATE TABLE usage_accrual (
  workspace_id TEXT PRIMARY KEY,
  micros INTEGER NOT NULL,
  flushes INTEGER NOT NULL
);

-- Receipts: one per payment, numbered without gaps per seller and year (VF-RCT-2026-000001); sandbox receipts have
-- their own sequence (VF-RCT-SANDBOX-2026-000001) and never use a real number.
CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  year INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  number TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  seller TEXT NOT NULL,
  buyer TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  vat_rate_bp INTEGER NOT NULL,
  vat_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  method TEXT NOT NULL,
  reference TEXT NOT NULL,
  provider_reference TEXT,
  email_status TEXT,
  email_at INTEGER,
  UNIQUE (mode, year, seq)
);
CREATE INDEX receipts_workspace ON receipts (workspace_id, issued_at);

-- Vietnamese VAT e-invoices (hóa đơn GTGT), issued through Viettel S-Invoice, only for a buyer in Vietnam who asked
-- for one. pending -> issuing -> issued (or failed, retried); the id is the transactionUuid sent to Viettel.
CREATE TABLE einvoices (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  receipt_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  -- The payment's mode: issued only through S-Invoice in that same mode.
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  details TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  vat_rate_bp INTEGER NOT NULL,
  vat_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  paid_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  attempt_at INTEGER,
  last_error TEXT,
  record TEXT,
  issued_at INTEGER,
  email_status TEXT,
  email_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX einvoices_status ON einvoices (status, created_at);
CREATE INDEX einvoices_workspace ON einvoices (workspace_id, created_at);

-- PDFs (base64): our receipts, and the e-invoice PDFs Viettel returns.
CREATE TABLE billing_documents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  pdf TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Admin settings: WorldFirst receiving account, seller legal details, VAT rates, the e-invoice exchange rate.
CREATE TABLE billing_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

-- Sign-up and billing audit trail (no raw emails, keys or secrets).
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  ip_hash TEXT,
  meta TEXT
);
CREATE INDEX audit_events_type_ip ON audit_events (type, ip_hash, at);
CREATE INDEX audit_events_workspace ON audit_events (workspace_id, at);
