-- Provider connections belong to one tenant; existing connections stay with 'red'.
ALTER TABLE provider_connections ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'red';
