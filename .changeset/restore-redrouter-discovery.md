---
"@reddb-io/red-router": patch
---

Restore RedRouter branding compatibility and partial client discovery at `/v1/key`,
`/v1/catalog` and `/v1/capabilities`. Discovery uses the caller's authorized model
catalog and explicitly identifies the legacy capabilities that remain unimplemented.

Restore direct remote-router chat model discovery with automatic per-connection
persistence, credential-bound fallback, and invalidation after connection edits.
Preserve remote-qualified model IDs and align chat/discovery endpoint URL handling.
Multi-hop federation and remote System One dispatch are not included in this change.
