-- Keep live-discovery capabilities separate from the models.dev overlay.
ALTER TABLE model_capabilities ADD COLUMN capability_source TEXT NOT NULL DEFAULT 'legacy';
