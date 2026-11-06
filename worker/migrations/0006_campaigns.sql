-- Promotions (src/core/campaigns.ts): a campaign, made on the admin host, sells some models below their official
-- price between starts_at and ends_at (UTC, ms). type 'automatic' applies to every workspace; type 'code' only to
-- workspaces that redeemed its code on dash Billing. discount is JSON: {"kind":"percent","percentBp":2500} (25%
-- off) or {"kind":"price","prices":{"<model>":{"input":0.1,"output":0.4}|{"perImage":0.02}|{"perMVideoTokens":1.5}}}
-- (US dollars). Charges stay in micro-dollars; the discount is recorded as its own spend line.
CREATE TABLE campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  code TEXT UNIQUE,
  status TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  models TEXT NOT NULL,
  discount TEXT NOT NULL,
  max_redemptions INTEGER,
  once_per_workspace INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX campaigns_window ON campaigns (status, ends_at);

-- A workspace that entered a campaign's code. One row per campaign and workspace (a code never counts twice for
-- one workspace); max_redemptions caps the rows of a campaign, checked in the same INSERT.
CREATE TABLE campaign_redemptions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  redeemed_at INTEGER NOT NULL,
  UNIQUE (campaign_id, workspace_id)
);
CREATE INDEX campaign_redemptions_workspace ON campaign_redemptions (workspace_id);
