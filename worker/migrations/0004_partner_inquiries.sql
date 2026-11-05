-- "Partner with Valefront" inquiries from model/AI providers (the form on valefront.com; src/core/partner-inquiries.ts).
-- The submitter's IP is kept only as a hash (ip_hash), for the per-IP rate limit. Status and note are set on
-- adm.valefront.com/partners.
CREATE TABLE partner_inquiries (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  company TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  website TEXT,
  role TEXT,
  models_offered TEXT NOT NULL,
  -- JSON array of 'text' | 'image' | 'video' | 'audio' | 'embeddings'
  modalities TEXT NOT NULL DEFAULT '[]',
  regions TEXT,
  partnership_type TEXT NOT NULL,
  message TEXT,
  lang TEXT NOT NULL DEFAULT 'en',
  ip_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'closed')),
  note TEXT,
  updated_at INTEGER,
  updated_by TEXT,
  -- 'sent' | 'failed' | NULL (no email on this host), for the team notification and the submitter's confirmation
  notify_email_status TEXT,
  confirm_email_status TEXT
);
CREATE INDEX partner_inquiries_created ON partner_inquiries (created_at);
CREATE INDEX partner_inquiries_ip ON partner_inquiries (ip_hash, created_at);
