-- Separate from the ALTERs: the runner records a file as applied on its duplicate-column path.
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_provider_connections_tenant ON provider_connections(tenant_id);
CREATE INDEX IF NOT EXISTS idx_combos_tenant ON combos(tenant_id);
