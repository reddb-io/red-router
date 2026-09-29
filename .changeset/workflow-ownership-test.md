---
"@reddb-io/red-router": patch
---

Fixes the release contract test that rejected the Docker image workflow, which stopped 0.45.0 from publishing. That version's changes (playground chat sessions, MiniMax voices, Kiro CLIProxy import, proxy-pool import, skills pack, OpenRouter Messages transport) ship in this release, together with Prometheus metrics and the first slice of budgets.
