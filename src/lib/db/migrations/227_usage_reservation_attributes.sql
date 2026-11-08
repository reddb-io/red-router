-- Keep request-time attribution immutable across crashes and manual reconciliation.
ALTER TABLE api_key_usage_reservations
  ADD COLUMN usage_attributes TEXT NOT NULL DEFAULT '{}';
