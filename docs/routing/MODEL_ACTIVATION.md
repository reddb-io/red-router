---
title: Connection and model activation
description: Explicit opt-in for provider connections and discovered models.
---

# Connection and model activation

Provider discovery and model selection are separate operator actions. A free badge
only describes pricing. It does not activate a connection or a model.

On the provider detail page, activate individual models or use **Activate matching**
to select every model matching the current search and filters. Bulk selection includes
all matching pages, not just the 100 rows currently displayed. Enable a connection
separately to route inference requests. Connection tests update diagnostics without
enabling an inactive connection.

Management model discovery retains the full inventory, including inactive models.
Public model catalogs and automatic routing use explicitly selected models. Direct
inference requests also require selection. Synchronization preserves existing selections
and leaves newly discovered models inactive.

Existing explicit activation flags remain valid. Models that previously relied on
implicit visibility now require selection. Credentials, inventories and other model
metadata remain stored.

## Management API

`PATCH /api/provider-models?provider=<provider-id>` accepts explicit activation:

```json
{ "isActive": true, "modelIds": ["model-a", "model-b"] }
```

Use `isActive: false` to deactivate the models. Explicit activation applies across the
model's supported endpoints and replaces previous modality visibility overrides for
those selected models. The older `isHidden` and optional `modality` fields remain
supported for scoped visibility management. Do not combine them with `isActive`.

Sources: `src/app/api/provider-models/route.ts`, `src/lib/db/models.ts`,
`src/shared/utils/modelVisibility.ts`, and `src/sse/services/auth.ts`.
