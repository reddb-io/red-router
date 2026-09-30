-- Tenants: an isolated slice of the instance (own API keys, provider connections, combos, users).
-- The default tenant "red" exists on every install and owns everything created before tenants
-- existed, so a single-tenant instance behaves exactly as it did. Its admin is the instance owner
-- (the initial password login), which is not a tenant_users row.
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO tenants (id, slug, name, is_default, disabled, created_at, updated_at)
VALUES ('red', 'red', 'red', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- E-mail is unique across tenants so a sign-in can resolve the tenant from the address alone.
-- password_hash stays NULL until the user is given a way in (SSO match or an invite).
CREATE TABLE IF NOT EXISTS tenant_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  password_hash TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant ON tenant_users(tenant_id);

-- A resource owned by one tenant that other tenants may also use (the owner's shared account).
-- Only the owning tenant's admin (or the instance owner) changes it.
CREATE TABLE IF NOT EXISTS tenant_shared_resources (
  kind TEXT NOT NULL CHECK (kind IN ('connection', 'combo')),
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, resource_id)
);
