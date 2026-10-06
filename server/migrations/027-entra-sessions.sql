-- Isolated Entra auth-code/PKCE state. No bearer cookie, verifier, or MSAL cache is plaintext.
-- Epoch milliseconds match the auth adapter; BIGINT values may be returned as strings by pg.
-- Durable jobs carry only fiq_entra_sessions.id; deleting that row revokes browser and worker access.
CREATE TABLE fiq_entra_requests (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  browser_hash TEXT NOT NULL CHECK (browser_hash ~ '^[a-f0-9]{64}$'),
  encrypted_request TEXT NOT NULL CHECK (encrypted_request LIKE 'v1.%'),
  created_at BIGINT NOT NULL CHECK (created_at > 0),
  expires_at BIGINT NOT NULL CHECK (
    expires_at > created_at AND expires_at <= created_at + 300000
  )
);
CREATE INDEX fiq_entra_requests_expiry ON fiq_entra_requests(expires_at);

CREATE TABLE fiq_entra_sessions (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  tenant_id UUID NOT NULL,
  object_id UUID NOT NULL,
  encrypted_cache TEXT NOT NULL CHECK (encrypted_cache LIKE 'v1.%'),
  created_at BIGINT NOT NULL CHECK (created_at > 0),
  expires_at BIGINT NOT NULL CHECK (
    expires_at > created_at AND expires_at <= created_at + 28800000
  )
);
CREATE INDEX fiq_entra_sessions_expiry ON fiq_entra_sessions(expires_at);
CREATE INDEX fiq_entra_sessions_roster_recent ON fiq_entra_sessions(
  tenant_id, object_id, created_at DESC, id DESC
);
