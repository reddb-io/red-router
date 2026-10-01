CREATE TABLE IF NOT EXISTS budget_inflight (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  usd REAL NOT NULL CHECK(usd >= 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_budget_inflight_key ON budget_inflight(api_key_id, expires_at);
CREATE TABLE IF NOT EXISTS budget_inflight_scopes (
  reservation_id TEXT NOT NULL REFERENCES budget_inflight(id) ON DELETE CASCADE,
  budget_id TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  cap_key TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(reservation_id, budget_id, scope_value, window_start, cap_key)
);
