---
"@reddb-io/red-router": minor
---

**Usage Sinks**: send usage to your billing system by webhook. Set it up under System → Usage Sinks (admin only).

- **Two modes.** Every request as it happens (`usage.recorded`), or totals per API key for a clock-aligned window of 5, 15, 30 or 60 minutes (`usage.window`), with a breakdown per provider and model: requests, errors, prompt, completion and cached tokens, and cost.
- **Pick the keys.** Send everything, or only chosen API keys or keys with given tags.
- **Built for billing.**
  - Each delivery is signed per Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256).
  - It carries a stable id to deduplicate on, and it's stored before it's sent.
  - Failed deliveries are retried with backoff for about 16 hours; a `410 Gone` stops retries.
  - Keys are identified by id, name and masked value, never the raw key.
- **See what happened.** "Send test" posts a sample and shows the response status, latency and size. The deliveries list shows each batch's window, requests, cost, status and attempts, with "Retry now".

A new sink receives usage recorded from the moment it's created. Windows with no usage send nothing.
