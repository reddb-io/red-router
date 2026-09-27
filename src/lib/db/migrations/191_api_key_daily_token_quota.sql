-- Optional UTC calendar-day token cap for API keys. Keep this additive and
-- idempotent; usage is read from the indexed request_cost_ledger.
CREATE TABLE IF NOT EXISTS api_key_daily_token_limits (
  api_key_id         TEXT PRIMARY KEY,
  daily_tokens_limit INTEGER NOT NULL CHECK (daily_tokens_limit > 0),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
