-- Freeze each closed window's source high-water mark. Without this, a long
-- paginated drain can include later ledger rows in an earlier billing window.
CREATE TABLE IF NOT EXISTS redrouter_usage_windows (
  sink_id TEXT PRIMARY KEY REFERENCES redrouter_usage_sinks(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  next_window_end TEXT NOT NULL,
  created_at TEXT NOT NULL
);
