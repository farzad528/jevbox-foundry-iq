CREATE TABLE knowledge_import_connections (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES orgs(id),
  owner_oid TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('local','google')),
  label TEXT NOT NULL,
  root_id TEXT NOT NULL REFERENCES resources(id),
  created TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE knowledge_import_items (
  connection_id UUID NOT NULL REFERENCES knowledge_import_connections(id),
  external_key TEXT NOT NULL,
  document_id TEXT NOT NULL UNIQUE REFERENCES resources(id),
  content_hash TEXT NOT NULL,
  PRIMARY KEY(connection_id,external_key)
);
CREATE TABLE knowledge_import_revisions (
  document_id TEXT NOT NULL REFERENCES resources(id),
  source_revision BIGINT NOT NULL,
  origin JSONB NOT NULL,
  PRIMARY KEY(document_id,source_revision),
  FOREIGN KEY(document_id,source_revision) REFERENCES knowledge_originals(document_id,source_revision)
);
