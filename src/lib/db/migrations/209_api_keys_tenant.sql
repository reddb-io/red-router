-- API keys belong to one tenant; existing keys stay with the default tenant 'red'.
ALTER TABLE api_keys ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'red';
