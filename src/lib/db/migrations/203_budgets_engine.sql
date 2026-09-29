-- Reusable budgets (slice 1: key and key-group scopes). A budget is a spending cap with a window
-- (daily / weekly / monthly / total), a soft threshold that raises one alert per window, and an
-- on-exceed behaviour (block the request or throttle it). One budget can be assigned to many
-- API keys and key groups (teams); the per-key budget in domain_budgets is unrelated and unchanged.
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  max_usd REAL NOT NULL CHECK (max_usd > 0),
  -- NULL means "80% of max_usd".
  soft_usd REAL,
  duration TEXT NOT NULL DEFAULT 'monthly'
    CHECK (duration IN ('daily', 'weekly', 'monthly', 'total')),
  -- HH:MM (UTC) the window rolls over, same meaning as the per-key budget's resetTime.
  reset_time TEXT,
  on_exceed TEXT NOT NULL DEFAULT 'block' CHECK (on_exceed IN ('block', 'throttle')),
  throttle_delay_ms INTEGER NOT NULL DEFAULT 1000,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_assignments (
  budget_id TEXT NOT NULL,
  -- 'key' = api_keys.id, 'group' = key_groups.id (a team; the whole group shares one window).
  scope_type TEXT NOT NULL CHECK (scope_type IN ('key', 'group')),
  scope_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (scope_type, scope_value, budget_id),
  FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_budget_assignments_budget
  ON budget_assignments (budget_id);

-- Spend per budget, scope and window. window_start is the epoch ms the window began (0 for a
-- 'total' budget), so a new window is a new row and old windows stay as history.
-- alerted_at is set once when the soft threshold is crossed, so the alert survives restarts.
CREATE TABLE IF NOT EXISTS budget_windows (
  budget_id TEXT NOT NULL,
  scope_value TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  spent_usd REAL NOT NULL DEFAULT 0,
  alerted_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (budget_id, scope_value, window_start),
  FOREIGN KEY (budget_id) REFERENCES budgets(id) ON DELETE CASCADE
);
