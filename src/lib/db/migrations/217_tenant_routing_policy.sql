-- Model visibility ("transparent" listing) and provider priority, per tenant. Two sets of columns so
-- the OWNER always has the last word: owner_* is what the owner pinned for the tenant and beats
-- everything; tenant_* is what the tenant's admin chose and counts only while the owner delegates
-- (setting `delegateRoutingToTenants`). NULL = not set at that level.
CREATE TABLE IF NOT EXISTS tenant_routing_policy (
  tenant_id TEXT PRIMARY KEY,
  owner_transparent INTEGER,
  owner_priority TEXT,
  tenant_transparent INTEGER,
  tenant_priority TEXT,
  updated_at TEXT NOT NULL
);
