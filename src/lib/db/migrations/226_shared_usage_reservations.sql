-- Reservations intentionally do not expire: after dispatch an interrupted
-- request can have incurred provider charges even if its usage is unknown.
CREATE TABLE IF NOT EXISTS api_key_usage_reservations (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens >= 0),
  reserved_usd REAL NOT NULL CHECK (reserved_usd >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'dispatched')),
  provider TEXT,
  model TEXT,
  connection_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_reservations_key
  ON api_key_usage_reservations(api_key_id);
