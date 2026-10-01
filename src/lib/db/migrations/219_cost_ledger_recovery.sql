-- New events are idempotent without rewriting historical request IDs.
ALTER TABLE request_cost_ledger ADD COLUMN event_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_ledger_event_id
  ON request_cost_ledger(event_id) WHERE event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cost_ledger_outbox (
  event_id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_outbox_key ON cost_ledger_outbox(api_key_id);
