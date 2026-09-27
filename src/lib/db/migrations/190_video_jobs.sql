-- Durable, account-bound async video jobs. Reservation happens BEFORE a
-- billable upstream POST; an interrupted reservation is deliberately not
-- resubmitted because the remote outcome cannot be inferred after a crash.
CREATE TABLE IF NOT EXISTS video_jobs (
  id TEXT PRIMARY KEY,
  owner_hash TEXT NOT NULL,
  idempotency_hash TEXT,
  request_hash TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('generations', 'edits', 'extensions')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  upstream_request_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'submitted', 'uncertain', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_hash, idempotency_hash)
);

CREATE INDEX IF NOT EXISTS idx_video_jobs_owner_created
  ON video_jobs(owner_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_jobs_owner_upstream
  ON video_jobs(owner_hash, upstream_request_id);
