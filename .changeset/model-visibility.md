---
"@reddb-io/red-router": minor
---

Transparent or not: who chooses the provider.

- **Transparent (the default)** is unchanged: `/v1/models` lists `provider/model` and the client picks the provider.
- **Off** lists each chat model once, under its bare name, and hides the provider. RedRouter picks the provider from an ordered provider priority and tries the next one if it fails (it is routed as a priority combo, so fallback, breakers, budgets and quotas apply). A provider prefix in a request is ignored: `openai/gpt-4o` and `gpt-4o` are the same request. Two providers offer "the same model" when their ids match once lower-cased and stripped of every namespace. Combos, embeddings, images and audio keep their usual ids for now.
- **The owner has the last word.** In Settings › Routing the owner sets the mode and the provider order for the instance, can pin either for a single tenant (`PUT /api/tenants/:id/routing`), and decides whether tenant admins may change them at all (a "Let tenant admins change this" switch, off by default). A tenant admin's own choice (`GET`/`PUT /api/tenant/routing`, admin only) applies only while delegated and never over what the owner pinned; they can order only the providers their tenant can use.
