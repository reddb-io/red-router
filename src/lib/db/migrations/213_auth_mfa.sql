-- Second factor (TOTP + recovery codes) per principal: 'owner' today, 'user:<id>' for tenant users.
-- The secret is encrypted through db/encryption.ts. last_used_step blocks replaying a code inside its
-- validity window; recovery_hashes is a JSON array of SHA-256 hex digests, one removed on use.
CREATE TABLE IF NOT EXISTS auth_mfa (
  principal TEXT PRIMARY KEY,
  secret_encrypted TEXT NOT NULL,
  recovery_hashes TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 0,
  last_used_step INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
