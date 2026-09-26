---
"@reddb-io/red-router": minor
---

`/v1/models` entries now carry a `parameters` block with every setting a client must respect (context and output limits, reasoning, accepted thinking levels, whether thinking can be disabled, whether a forced `tool_choice` is accepted, tools, search, input/output modalities). Combos add `members`, with nested combos expanded, and their parameters come from the strictest member. A combo with one member that cannot disable thinking no longer reports that it can. Chat and `/v1/models` responses carry `X-RedRouter-Catalog-Version`, and `/v1/capabilities` advertises it under `catalog`, so clients know when to re-read a cached catalog.
