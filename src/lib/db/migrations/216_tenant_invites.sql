-- Single-use, expiring invitations that let a tenant user set their own password. Only the SHA-256
-- of the token is stored; the token itself is shown once when the invitation is created.
CREATE TABLE IF NOT EXISTS tenant_invites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tenant_invites_user ON tenant_invites(user_id);
