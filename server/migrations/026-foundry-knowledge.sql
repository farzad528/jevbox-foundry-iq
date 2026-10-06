CREATE TABLE knowledge_source_state (
  document_id TEXT PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  source_revision BIGINT NOT NULL CHECK (source_revision > 0),
  acl_revision BIGINT NOT NULL CHECK (acl_revision > 0),
  generation BIGINT NOT NULL CHECK (generation > 0),
  readers JSONB NOT NULL CHECK (jsonb_typeof(readers) = 'array'),
  state TEXT NOT NULL CHECK (state IN ('pending','syncing','verified','failed','deleted')),
  updated TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE knowledge_evidence (
  index_key TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL,
  content_kind TEXT NOT NULL CHECK (content_kind IN ('raw','wiki')),
  source_revision BIGINT NOT NULL CHECK (source_revision > 0),
  acl_revision BIGINT NOT NULL CHECK (acl_revision > 0),
  raw_source_ids TEXT[] NOT NULL,
  current BOOLEAN NOT NULL DEFAULT false,
  retrievable BOOLEAN NOT NULL DEFAULT false,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX knowledge_evidence_dependencies ON knowledge_evidence USING gin(raw_source_ids);
CREATE TABLE knowledge_outbox (
  id UUID PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_source_state(document_id) ON DELETE CASCADE,
  generation BIGINT NOT NULL CHECK (generation > 0),
  operation TEXT NOT NULL CHECK (operation IN ('publish','acl-sync','delete','source-change')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','working','verified','failed','obsolete')),
  attempt_id UUID,
  item_results JSONB,
  error_code TEXT,
  created TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(document_id,generation)
);
CREATE INDEX knowledge_outbox_pending ON knowledge_outbox(created) WHERE state IN ('pending','working','failed');
CREATE TABLE knowledge_wiki_revisions (
  workspace_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('draft','reviewed','published','stale')),
  raw_source_ids TEXT[] NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,page_id,revision)
);
CREATE INDEX knowledge_wiki_dependencies ON knowledge_wiki_revisions USING gin(raw_source_ids);
