-- Cost attribution on the ledger: who a request was for, not just which key paid.
--
-- request_cost_ledger gains nullable columns (NULL = not supplied / stamped before this
-- migration): end_user (client-supplied id, at most 128 characters), tags (JSON array of
-- lowercase strings) and session_id. Prompt text is never stored here.
-- The (end_user, timestamp) index serves the per-user rollup; tags are exploded with json_each
-- at read time and need no index of their own. call_logs is handled by 207.

ALTER TABLE request_cost_ledger ADD COLUMN end_user TEXT;
ALTER TABLE request_cost_ledger ADD COLUMN tags TEXT;
ALTER TABLE request_cost_ledger ADD COLUMN session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_rcl_end_user_timestamp ON request_cost_ledger (end_user, timestamp);
