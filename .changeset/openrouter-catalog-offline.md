---
"@reddb-io/red-router": patch
---

The OpenRouter model browser works offline with the full catalog. The last list RedRouter got from OpenRouter is saved to disk, and a copy of OpenRouter's full catalog (all 625 models, JEV included) now ships with RedRouter. Without network, or right after a restart without it, the browser shows the saved list, or the bundled one, instead of falling back to the ~370 models models.dev knows. The source line says when it's showing an offline copy and how old it is.

The bundled models.dev catalog is also refreshed, and `scripts/refresh-catalog-snapshots.mjs` refreshes all bundled catalogs before a release.
