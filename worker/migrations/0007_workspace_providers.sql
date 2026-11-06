-- A workspace's own model providers ("bring your own key", src/core/workspace-providers.ts): an Azure OpenAI
-- resource, an OpenAI-compatible gateway (LLM API, OpenRouter, …) or Anthropic, configured on dash ("Your
-- providers") and used only by that workspace's keys, for the models listed here. Billed by that provider, not by
-- Valefront: requests through it are counted (spend line "BYOK:<label>") but never charged a model price.
--
-- The API key is encrypted with AES-GCM under LEYLINE_STORE_KEY (like the secrets table), its additional data bound
-- to the workspace and the provider id, so a value can't be moved to another row. It is write-only: no API returns it.
CREATE TABLE workspace_providers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  -- 'azure-openai' | 'openai-compatible' | 'anthropic'
  kind TEXT NOT NULL,
  -- Shown on dash and in the spend line (BYOK:<label>); unique within the workspace.
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  -- Azure OpenAI only: the default deployment (used by "Test") and the API version of a legacy endpoint.
  deployment TEXT,
  api_version TEXT,
  -- JSON array of the model ids this provider serves for the workspace (for Azure: deployment names).
  models TEXT NOT NULL,
  key_iv TEXT NOT NULL,
  key_data TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, label)
);
CREATE INDEX workspace_providers_workspace ON workspace_providers (workspace_id, created_at);
