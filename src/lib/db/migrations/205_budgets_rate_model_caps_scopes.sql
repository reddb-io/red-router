-- Budgets slice 2: tokens/requests per minute, per-model USD caps, tag and end-user scopes.
--
-- 1. tpm_limit / rpm_limit: NULL = no rate limit. The counters reuse api_key_quota_counters
--    (owner 'budget:<id>'), so no new counter table.
-- 2. model_max_json: {"<provider>/<model>" | "<model>" | "<provider>/*": usd}. NULL = no caps.
--    The spend behind each cap key lives in budget_window_models, one row per
--    (budget, scope, window, cap key), incremented with the same atomic UPSERT as budget_windows.
-- 3. budget_assignments.scope_type gains 'tag' and 'user'. SQLite cannot alter a CHECK in place,
--    so the table is rebuilt: the new table is created first, rows are copied, the old one is
--    dropped and the new one renamed into place (nothing references budget_assignments, so no
--    foreign key is repointed). Re-running copies the same rows again (INSERT OR IGNORE).

ALTER TABLE budgets ADD COLUMN tpm_limit INTEGER;
ALTER TABLE budgets ADD COLUMN rpm_limit INTEGER;
ALTER TABLE budgets ADD COLUMN model_max_json TEXT;

CREATE TABLE IF NOT EXISTS budget_window_models (
  budget_id TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  cap_key TEXT NOT NULL,
  spent_usd REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (budget_id, scope_value, window_start, cap_key),
  FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS budget_assignments_new (
  budget_id TEXT NOT NULL,
  -- 'key' = api_keys.id, 'group' = key_groups.id (a team; the whole group shares one window),
  -- 'tag' = a lowercased request tag, 'user' = an end-user id as sent by the client.
  scope_type TEXT NOT NULL CHECK (scope_type IN ('key', 'group', 'tag', 'user')),
  scope_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (scope_type, scope_value, budget_id),
  FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE CASCADE
);

INSERT OR IGNORE INTO budget_assignments_new (budget_id, scope_type, scope_value, created_at)
SELECT budget_id, scope_type, scope_value, created_at FROM budget_assignments;

DROP TABLE budget_assignments;

ALTER TABLE budget_assignments_new RENAME TO budget_assignments;

CREATE INDEX IF NOT EXISTS idx_budget_assignments_budget ON budget_assignments (budget_id);
