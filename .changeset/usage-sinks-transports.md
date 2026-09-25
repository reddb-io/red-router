---
"@reddb-io/red-router": minor
---

**Usage sinks can now send to Amazon SQS, Kafka or a RedDB queue, not only webhooks.** Pick the target in System → Usage Sinks → Add sink → "Send to". Instant and windowed modes, API key filters, retries, the deliveries list and "Send test" work the same for every target.

- **Amazon SQS:** needs the queue URL and an access key with `sqs:SendMessage`; a session token is optional. It also works with SQS-compatible endpoints such as LocalStack. On a `.fifo` queue, a retried delivery is not enqueued twice and deliveries stay in order.
- **Kafka:** needs brokers and a topic, with optional TLS and SASL (PLAIN or SCRAM). Messages are keyed by sink, and each carries the delivery id in the `redrouter-delivery-id` header for deduplication.
- **RedDB queue:** each delivery is a `QUEUE PUSH` sent to RedDB's HTTP `/query` endpoint, with the delivery id as the `DEDUP` key. It needs a RedDB URL and a queue name; a token and tenant are optional. Create the queue once, e.g. `CREATE QUEUE IF NOT EXISTS usage_events WITH DEDUP_WINDOW 1h`.
- **Secrets:** AWS keys, SASL passwords and RedDB tokens are never returned by the API. Leave a secret empty when editing to keep the stored one.
