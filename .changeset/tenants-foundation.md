---
"@reddb-io/red-router": minor
---

Tenants. The instance owner can now create tenants (System › Tenants), assign each one an admin and users, create API keys scoped to a tenant, and move provider accounts, combos and keys between tenants. The default tenant is `red`: it holds everything that existed before, its admin is the instance owner, and an install with no other tenant routes exactly as before.

A tenant key only reaches its own accounts and combos (plus anything the owning tenant explicitly shares), never carries `manage`, `admin` or `mcp:connect`, and stops working when its tenant is disabled. A tenant with no accounts is refused rather than falling through to another tenant's. Traffic from the default tenant no longer draws on another tenant's private accounts. Signing in as a tenant admin or user comes in the next release; this one covers the data model, the owner-side management API and the isolation of tenant keys.
