-- Tenant contacts and administrative ownership. The owner is an existing tenant admin;
-- this designation never grants instance-wide access.
CREATE TABLE IF NOT EXISTS tenant_profiles (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  owner_user_id TEXT REFERENCES tenant_users(id) ON DELETE SET NULL,
  owner_email TEXT NOT NULL DEFAULT '',
  technical_email TEXT NOT NULL DEFAULT '',
  billing_email TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  metadata TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
ALTER TABLE usage_history ADD COLUMN tenant_id TEXT;
ALTER TABLE request_cost_ledger ADD COLUMN tenant_id TEXT;
-- Historical attribution can only be inferred for keys that still exist.
UPDATE usage_history SET tenant_id = CASE
  WHEN api_key_id IS NULL OR api_key_id = '' THEN 'red'
  ELSE (SELECT tenant_id FROM api_keys WHERE id = usage_history.api_key_id) END;
UPDATE request_cost_ledger SET tenant_id =
  (SELECT tenant_id FROM api_keys WHERE id = request_cost_ledger.api_key_id);
CREATE INDEX IF NOT EXISTS idx_uh_tenant_month ON usage_history(tenant_id, timestamp, api_key_id);
CREATE INDEX IF NOT EXISTS idx_rcl_tenant_month ON request_cost_ledger(tenant_id, timestamp, api_key_id);
