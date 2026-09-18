---
"@reddb-io/red-router": minor
---

Port upstream fixes and features:

- **Combos**: merge member capabilities into combo `/v1/models` entries — boolean features are unioned, numeric limits minimized, nested combos flattened; thinking levels for suffixed ids resolve through the clean model
- **Capabilities**: OpenAI reasoning models cannot disable thinking (levels drop "none"); o-series globs no longer capture Cline's Solar Pro 4
- **Translator**: repair tool_call_id lost by Responses clients; preserve function-tool strict across Claude/Chat routes
- **Catalog**: register the renamed deepseek-flash id; pricing gains missing long-context tiers
- **Dashboard**: surface why a provider connection test failed
