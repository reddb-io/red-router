-- RedRouter-owned costed-usage delivery. The source is request_cost_ledger,
-- not the broader usage_history table. This is intentionally not a claim that
-- every request has a priced ledger row yet.
CREATE TABLE IF NOT EXISTS redrouter_usage_sinks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_encrypted TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('instant', 'window')),
  window_sec INTEGER,
  api_key_ids TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  cursor_id INTEGER NOT NULL DEFAULT 0,
  next_window_end TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS redrouter_usage_deliveries (
  id TEXT PRIMARY KEY,
  sink_id TEXT NOT NULL REFERENCES redrouter_usage_sinks(id) ON DELETE CASCADE,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'delivered', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  lease_until TEXT,
  last_status INTEGER,
  last_error TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_redrouter_usage_delivery_due
  ON redrouter_usage_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_redrouter_usage_delivery_sink
  ON redrouter_usage_deliveries(sink_id, created_at);
