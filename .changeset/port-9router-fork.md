---
"@reddb-io/red-router": minor
---

Port of the PentatonicDev/9router fork features: external Postgres via Kysely (`DATABASE_URL` → Distributed Mode, schema created on boot, shared database across instances), per-user resource scoping (owner on accounts/keys/combos, admin gating, hidden combos, shared-account admin rules), API key ↔ account bindings (`allowedConnectionIds`) with per-key usage and rename/tags, per-user token-saver flags, canonical error contract with `503 no_active_credentials`, translator credential redaction, boot-time token refresh, quota reset-aware locking, openrouter claude-format routing and credit quota, plus a batch of translator/kiro/thinking/RTK fixes.
