---
"@reddb-io/red-router": minor
---

Three LLM gateways as upstream providers: Cloudflare AI Gateway (your account's gateway URL as the connection Base URL, with an optional `cf-aig-authorization` token), Helicone AI Gateway and Portkey (with an optional virtual key). Their endpoints could not be checked offline, so test the connection before relying on them. The OTLP log destination gains an "endpoint is complete" option and there is a read-only list of ready-made presets at `GET /api/log-export/otlp-templates` for Langfuse, Helicone, Braintrust, Grafana Cloud, Honeycomb and a local collector; the Langfuse, Helicone and Braintrust ones are marked unverified because those vendors document OTLP for traces only or the URL is unconfirmed.
