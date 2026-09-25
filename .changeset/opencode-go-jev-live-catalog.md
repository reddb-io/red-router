---
"@reddb-io/red-router": patch
---

An OpenCode Go connection now also serves the workspace's OpenCode Zen System One models. The same OpenCode workspace key works for Zen, so `/v1/models/systemone` lists `opencode-zen/jev-1.13` and `opencode-zen/jev-1.13-free` (and any other JEV model in Zen's live list) with an OpenCode Go connection, even when there is no separate OpenCode Zen connection. The `provider` block says OpenCode Zen, with `via` naming the OpenCode Go connection. `/v1/systemone` sends these models to `https://opencode.ai/zen/v1/systemone` with that connection's key, and a request for `opencode-zen/jev-1.13` now calls `jev-1.13` instead of the free model. If the workspace has no Zen access (HTTP 401, 402 or 403), the error says so and keeps Zen's message, and the Go connection stays available for chat. Chat `/v1/models` still leaves out System One models.

The OpenCode Go model list now comes from OpenCode's live `/zen/go/v1/models`, refreshed every hour, so new Go models (for example `gpt-6-luna`, `grok-4.7`, `omen-alpha`) show up without a RedRouter release. Models RedRouter already knows keep their names and settings. New models take their name, limits and endpoint from models.dev (`grok-4.7` and `gpt-6-luna` go to `/responses`), or default to `/chat/completions`. When OpenCode can't be reached, RedRouter uses the built-in list.
