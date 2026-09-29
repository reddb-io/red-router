-- Prompt-cache prefix diagnostics (X-CACHE1). One row per upstream request of a conversation:
-- how much of the previous request's prefix (tools, system, messages) it kept, where the first
-- difference is and the most likely cause. Providers cache by exact prefix, so a request that
-- rewrites an earlier message re-writes the cache instead of reading it. Rows are short-lived
-- (pruned after 14 days) and hold only counts, indexes and cause names, never message content.
CREATE TABLE IF NOT EXISTS redrouter_cache_prefix_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  connection_id TEXT,
  api_key_id TEXT,
  request_index INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  previous_message_count INTEGER NOT NULL,
  stable_prefix_messages INTEGER NOT NULL,
  first_divergent_index INTEGER NOT NULL,
  cause TEXT NOT NULL,
  causes TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rcpo_timestamp
  ON redrouter_cache_prefix_observations (timestamp);
CREATE INDEX IF NOT EXISTS idx_rcpo_conversation
  ON redrouter_cache_prefix_observations (conversation_key, id);
