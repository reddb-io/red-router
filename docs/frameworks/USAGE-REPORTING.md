---
title: Usage reporting context
description: Stable operator attributes, tenant identity and optional reporting without positive pricing.
---

# Usage reporting context

Usage sinks deliver persisted ledger records through webhook, SQS, Kafka or RedDB.
The ledger recovery outbox and sink outbox retain stable identities across retries.
An SQS acknowledgement means the queue accepted the event, not that a downstream
warehouse ingested it. Consumers must acknowledge their queue message only after
successful ingestion and deduplicate independently of SQS's finite FIFO window.

## Operator metadata

Set `REDROUTER_USAGE_ATTRIBUTES_JSON` to a JSON object of installation attributes.
For example, `{"region":"example-region","deployment":"testing"}`. The optional
`usageAttributes` object on `POST /api/keys` supplies immutable attributes for a key,
such as `{"project_id":"project-a","resource_id":"resource-a"}`. Key creation
persists them in the same transaction as the key. These are operator values, not
client request headers. A key cannot override an installation attribute with a
different value.

Attribute names use lowercase letters, digits and underscores, starting with a
letter. There are at most 32 combined attributes; values are strings up to 256
characters, finite numbers or booleans. Credential field names are rejected. Do not
put secrets in any attribute value. The bearer key never appears in usage payloads.

Ledger/outbox events capture these attributes when recorded. Retries and export
use that snapshot rather than joining mutable key metadata. Instant payloads carry
`event.attributes`, `event.tenantId` and `event.eventId`. Window payloads split a
key's totals when its captured tenant or attributes differ; each group includes
its own `tenantId` and `attributes`.

## Usage without a positive price

`REDROUTER_USAGE_REPORT_ALL_REQUESTS=true` opts completed chat, streaming and embedding calls
into ledger recording even when their calculated price is zero or unavailable.
The default preserves the positive-price recording behavior. This switch does
not promise coverage for every other endpoint or for usage the upstream never
reported. It does not enable a billing system or change a quota.

`event.pricingKnown=false` means the recorder did not resolve a model pricing row.
The existing numeric `cost` remains compatible with ledger consumers; financial
consumers must treat an unknown price as unavailable, never as evidence of a free
request. Provider estimates and invoice reconciliation remain separate concerns.

Token fields include `promptTokens`, `completionTokens`, `cachedTokens`,
`cacheCreationTokens` and `reasoningTokens`. Normalized prompt tokens include their
cached portion; reasoning is part of output. Do not add either subset a second
time when computing total tokens. Requests, models, tenant identity and key ID
remain distinct dimensions.

Implementation: `src/lib/usage/reportingAttributes.ts`,
`src/lib/db/apiKeys/usageAttributes.ts`, `src/lib/db/costLedger.ts`,
`src/lib/usageSinks/payloads.ts` and `src/lib/usageSinks/engine.ts`.
