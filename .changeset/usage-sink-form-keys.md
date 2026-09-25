---
"@reddb-io/red-router": patch
---

Usage sinks: a roomier form that works with any number of API keys.

- **Wider form:** short fields sit side by side, and the signing secret gets its own full row.
- **Picking keys:** API keys are no longer all loaded as checkboxes. Choose "All keys" or "Selected keys", then search by name or tag; the server returns one page at a time, so it works the same with 5 keys or 50,000. Chosen keys show as removable chips. Saving "Selected keys" with none picked is refused, because it would send every key's usage.
- **Faster page:** the Usage Sinks page no longer loads every API key. The keys a sink filters on come with the sink.

Endpoint & Keys: the "Advanced exposure" section (Cloudflare, Tailscale, dashboard access) is always open.
