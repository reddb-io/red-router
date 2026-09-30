-- Guardrail monitoring: one row each time a guardrail blocks, flags or masks a request or
-- response. Rows carry the guardrail and rule ids only, never the matched text or any content.
-- Kept 30 days; the writer prunes opportunistically (see db/guardrailEvents.ts).
CREATE TABLE IF NOT EXISTS guardrail_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Epoch milliseconds.
  ts INTEGER NOT NULL,
  guardrail_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('request', 'response')),
  action TEXT NOT NULL CHECK (action IN ('block', 'flag', 'mask')),
  api_key_id TEXT,
  request_id TEXT,
  -- Operator content-filter rule id, when a rule fired.
  rule_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_guardrail_events_ts ON guardrail_events(ts);
CREATE INDEX IF NOT EXISTS idx_guardrail_events_guardrail_ts ON guardrail_events(guardrail_id, ts);
