ALTER TABLE resources ADD COLUMN knowledge_deleted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE resources ADD COLUMN knowledge_manual BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE resources ADD COLUMN knowledge_acl_pending BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE resources ADD COLUMN knowledge_parse_state TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE resources ADD COLUMN knowledge_filing_state TEXT NOT NULL DEFAULT 'pending';
CREATE TABLE knowledge_originals (
  document_id TEXT NOT NULL REFERENCES resources(id),
  source_revision BIGINT NOT NULL,
  body BYTEA NOT NULL,
  parsed JSONB,
  PRIMARY KEY(document_id,source_revision)
);
CREATE TABLE knowledge_wiki_locations (
  page_id TEXT PRIMARY KEY REFERENCES resources(id),
  published_revision BIGINT,
  updated TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE knowledge_requests (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES orgs(id),
  user_oid TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('answer','wiki-draft','native-agent')),
  input JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','working','completed','failed','cancelled')),
  attempt_id UUID,
  lease_until TIMESTAMPTZ,
  dependencies JSONB NOT NULL DEFAULT '[]',
  observability JSONB,
  result JSONB,
  error_code TEXT,
  created TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_requests_owner ON knowledge_requests(workspace_id,user_oid,created DESC);
ALTER TABLE knowledge_outbox ADD COLUMN session_id TEXT;
ALTER TABLE knowledge_outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_outbox ADD COLUMN lease_until TIMESTAMPTZ;
