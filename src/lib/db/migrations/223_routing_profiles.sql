-- Explicit reusable routing defaults. Nothing is attached or enabled by migration.
CREATE TABLE IF NOT EXISTS routing_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transparent INTEGER CHECK (transparent IN (0, 1) OR transparent IS NULL),
  priority TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routing_profile_bindings (
  scope TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES routing_profiles(id) ON DELETE RESTRICT,
  transparent_override INTEGER CHECK (transparent_override IN (0, 1) OR transparent_override IS NULL),
  priority_override TEXT
);
CREATE INDEX IF NOT EXISTS idx_routing_profile_bindings_profile ON routing_profile_bindings(profile_id);
CREATE INDEX IF NOT EXISTS idx_routing_profile_bindings_tenant ON routing_profile_bindings(tenant_id);
