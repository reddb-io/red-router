-- Sign-in lockout decisions that must outlive a restart. Only the DECISION is stored (the failure
-- counters stay in memory): `level` counts consecutive lockouts of the same client and drives the
-- escalating duration; `locked_until` is a unix-ms deadline.
CREATE TABLE IF NOT EXISTS login_lockouts (
  key TEXT PRIMARY KEY,
  level INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
