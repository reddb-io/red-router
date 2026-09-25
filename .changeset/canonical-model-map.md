---
"@reddb-io/red-router": patch
---

The model catalog now includes models.dev's specialized models, and RedRouter knows which underlying model each provider offer serves.

- The daily models.dev sync and the bundled catalogs ask for every model type. Before, decision models such as TypeSafe's JEV were left out, so they never showed on a models.dev-backed provider page. They now show there marked System One.
- A bundled canonical map links each provider offer to its underlying model (`vendor/model`, e.g. OpenCode Zen's `jev-1.13` → `typesafe/jev-latest`). It's built from the models.dev repository's `base_model` links, which models.dev's published JSON leaves out: 428 models and about 6,300 offer links. This is the groundwork for flat model ids; nothing user-facing uses it yet.
