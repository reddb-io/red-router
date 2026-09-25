---
"@reddb-io/red-router": minor
---

**Models page: choose the offers behind each flat model id.** Operate → Models lists every model once, with each connected provider or route that serves it.

- **Order:** move offers up or down. A flat id tries them from the top. By default the cheapest comes first.
- **Switch offers off:** a switched-off offer is skipped by the flat id. Its full id still works. When every offer is off, the flat id is no longer listed.
- **Keep the default for new offers:** a newly connected provider joins after the ones you ordered. "Back to cheapest first" drops the custom order.
- **What clients see:** `/v1/models` flat entries now carry `offer_order` ("price" or "custom"), and switched-off offers show `available: false`. The catalog version header follows a flat key's own catalog, so clients re-read it after an order change.
- **Access:** the page is admin-only while resource scoping is on, because the order applies to every key.
