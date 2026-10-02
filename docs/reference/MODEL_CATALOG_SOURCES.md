---
title: "Model Catalog Sources"
version: 0.57.7
lastUpdated: 2026-10-02
---

# Model catalog sources

RedRouter keeps provider routing separate from model metadata. A connection and its adapter
define the destination URL, credential, protocol and native model ID. Catalog enrichment never
creates a connection, enables a model or substitutes a canonical ID in an upstream request.

## Initial metadata and updates

`src/lib/catalog/modelsDevSeed.json` contains a normalized public snapshot from
`https://models.dev/catalog.json?type=all`. It includes provider-scoped model IDs and a separate
canonical model table. The manifest records the exact input and normalized content hashes,
capture time, URL, license and the upstream schema reference inspected during import. That
schema reference is not a claim that the live API deployment was built from that commit.

The snapshot supplies metadata on first use without network access or database seed writes.
Existing provider definitions, explicit overrides and connection-discovered metadata take
precedence over bundled facts. Bundled pricing is below existing local defaults; runtime
pricing retains the order user overrides, models.dev, LiteLLM, local defaults, bundled data.
Catalog enrichment uses the same effective price layers as cost estimation, with exact native
model matching. A canonical relationship never shares prices between regions, plans or gateways.

Builds and installation use the committed snapshot. Updating it is an explicit maintenance step:

```sh
npm run catalog:seed
```

Review the resulting snapshot and manifest before integration. The generator preserves IDs
and selects data fields; upstream provider URLs, environment settings and request bodies are
not imported as connection configuration. It rejects mismatched IDs, negative prices and
unrecognized reasoning option shapes. Its implementation is
`scripts/research/update-models-dev-seed.mjs`.

Optional runtime updates use `https://models.dev/api.json?type=all`. Their public metadata cache
retains the last committed data and HTTP validator together. Conditional refresh can reuse a
validated snapshot on HTTP 304. A failed or cancelled refresh retains the previous committed
snapshot. The management status endpoint `/api/settings/models-dev?action=status` also returns
the bundled manifest, independently of whether runtime synchronization has been enabled.

## Identity and accepted parameters

Provider-native IDs are opaque. For example, OpenRouter advertises
`anthropic/claude-opus-4.6`, while the canonical metadata identity is
`anthropic/claude-opus-4-6`. A public RedRouter ID adds the local routing prefix to the native
ID. A chained Router removes its own hop and forwards the remaining native ID. A namespace
that happens to equal a local provider prefix remains part of the native model name.

`canonical_model_id` is optional. It supports attribution and grouping, not universal dispatch
or inference of model entitlement. Versions and serving variants can have different limits,
prices and controls even when they share descriptive metadata.

models.dev `reasoning_options` describes abstract toggle, effort and token-budget controls.
RedRouter retains it as descriptive metadata. The adapter and explicit model configuration
continue to define the payload carrier and effective accepted values. Learned effort limits
stay scoped to the provider/model that produced them. A metadata flag cannot bypass an
adapter's explicit tools restriction. Image generation output does not imply image-input
understanding.

## Decision discovery

models.dev excludes specialized decision types from its default feed. `?type=all` preserves
their taxonomy, but its complete catalog still does not include every provider's decision
offering. RedRouter retains its independent typed decision integration.

OpenRouter discovery combines its model feed with
`/api/v1/models?output_modalities=decisions`, retaining exact IDs including
`~typesafe/jev-latest`. Known JEV offerings use the explicitly implemented System One adapter.
Other decision offerings remain metadata until their protocol is implemented; a decision type
does not imply compatibility with JEV questions and answers.

The OpenRouter adapter destination remains `/api/v1/systemone`, as documented at
<https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request>.
RedRouter's `/v1/systemone` and `/v1/decisions` aliases preserve their existing handler contract.
Catalog discovery does not run an evaluation or establish that a credential can execute it.

## Visibility and cache boundaries

Public metadata can be shared. A connection's discovered inventory and the catalog visible to
a key are scoped to eligible connections, model activation and key restrictions. The same
provider name does not authorize joining two private inventories. Configuration generations
also fence last-good catalog fallbacks: timeout must not reintroduce a model after a connection
or visibility change. These cache guards are process-local; they do not establish replica-wide
invalidation or shared database support.

Product regression tests live under `tests/redrouter/native/`. CI verifies identity and payload
preservation, provider-specific pricing and controls, conditional refresh, authorization changes
and an installed package with bundled metadata and zero activated models. Credentialed upstream
evaluation is a separate verification boundary from these local HTTP fixtures.

Source and remaining behavioral differences are recorded in
`config/upstream/product-inheritance.json`. models.dev attribution is retained in
`THIRD_PARTY_NOTICES.md`.
