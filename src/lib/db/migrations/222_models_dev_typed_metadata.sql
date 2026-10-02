-- Preserve public model identity and typed capabilities without activating a route.
ALTER TABLE model_capabilities ADD COLUMN model_type TEXT;
ALTER TABLE model_capabilities ADD COLUMN canonical_model_id TEXT;
ALTER TABLE model_capabilities ADD COLUMN reasoning_options TEXT;
ALTER TABLE model_capabilities ADD COLUMN source_provider TEXT;
ALTER TABLE model_capabilities ADD COLUMN native_model_id TEXT;
