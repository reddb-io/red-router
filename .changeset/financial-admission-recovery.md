---
"@reddb-io/red-router": patch
---

Refuse requests when budget policy or pending cost accounting cannot be verified, retain subscription traffic in RPM/TPM limits, reserve estimated in-flight costs atomically, and release reservations when responses finish or are cancelled. Recover cost events through an idempotent durable outbox, preserve tenant ownership, and expose pending accounting and estimated reservations separately from recorded spend.
