-- Combos belong to one tenant; existing combos stay with 'red'.
ALTER TABLE combos ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'red';
