---
"@reddb-io/red-router": minor
---

Opt-in Prometheus metrics. Turn on "Prometheus metrics" in Settings → Advanced (it asks for your password), generate a scrape token (shown once, stored encrypted, never returned by any settings call) and point Prometheus at `GET /api/metrics` with `Authorization: Bearer <token>`; a signed-in admin can read it too. It answers 404 while off. The families are `redrouter_requests_total`, `redrouter_tokens_total`, `redrouter_cost_usd_total`, a `redrouter_request_duration_seconds` histogram, `redrouter_circuit_breaker_state`, `redrouter_connections`, `redrouter_build_info` and `redrouter_uptime_seconds`, computed when scraped (cached 15 s), with at most 200 provider/model pairs labelled and no key, connection or user identifiers.
