---
"@reddb-io/red-router": patch
---

Dashboard fixes.

- **Request details.** The request-details view no longer crashes when a response's content or thinking is an array of blocks.
- **Account order.** Reordering the accounts of a provider now saves the whole order at once, with priorities starting at 1. Before, it wrote two 0-based priorities in parallel, so whichever landed last won. With the owner filter active, it also moved the wrong rows. Accounts the user cannot see keep their place, and shared accounts stay admin-managed.
