---
"@reddb-io/red-router": patch
---

Restore the RedRouter setup-readiness endpoint and add an encrypted, signed webhook outbox for costed usage with stable delivery IDs. Freeze window high-water marks and fence expired delivery leases so retries cannot overwrite another worker. Record amount-only charges in the cost ledger and identify search charges by provider. The usage sink explicitly reports costed-request coverage; full Friday billing-source and transport parity is still in progress.
