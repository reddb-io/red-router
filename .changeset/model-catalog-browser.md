---
"@reddb-io/red-router": minor
---

Provider pages now have a model browser. "Discover models" lists every model the provider serves: the full models.dev catalog for 50 providers, and OpenRouter's live list (about 460 models) merged with models.dev.

Filters:
- name or id;
- owner;
- minimum context;
- release date;
- reasoning, tools, vision, free and open weights.

Sort by newest, largest context, cheapest or name. One-click presets: Recommended, Newest, Free, Reasoning, Long context, Cheapest and Open weights. Add one model, or tick several and add them together.

The daily models.dev sync now also saves this catalog to `model-catalog-browse.json`. Until the first sync, the snapshot vendored in the repo is used.
