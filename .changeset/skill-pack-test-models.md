---
"@reddb-io/red-router": minor
---

A RedRouter skill pack for coding agents: `red-router` (an index) plus one skill each for chat, image, text-to-speech, speech-to-text, embeddings, video, web search and web fetch, written against RedRouter's real endpoints, environment variables (`RED_ROUTER_BASE_URL`, `RED_ROUTER_API_KEY`) and install command, and served from this repository. The agent-skills page now links to reddb-io/red-router instead of the inherited repository. New management-authenticated `POST /api/providers/{id}/test-models` probes a connection's models in one call (up to 50, at most 3 at a time, per-model and overall time limits, fixed error messages, stops early on repeated rate limits).
