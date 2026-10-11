-- Hosted Leyline on Cloudflare Workers (src/core/d1-stores.ts).

-- Issued keys, usage, offered models: JSON documents with a generation for compare-and-set.
CREATE TABLE docs (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  gen INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

-- Provider keys and dashboard settings, AES-GCM encrypted under the LEYLINE_STORE_KEY secret.
CREATE TABLE secrets (
  account TEXT PRIMARY KEY,
  iv TEXT NOT NULL,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL
);

-- The recent request log (the dashboard's Activity page); trimmed to the newest few hundred.
CREATE TABLE logs (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  entry TEXT NOT NULL
);
CREATE INDEX logs_at ON logs (at);
