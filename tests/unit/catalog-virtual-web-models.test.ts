import assert from "node:assert/strict";
import test from "node:test";

import {
  buildVirtualWebCatalogModels,
  hasConfiguredSearchUrl,
  type VirtualWebModelKind,
} from "../../src/app/api/v1/models/catalogVirtualWebModels.ts";
import type { SearchProviderConfig } from "../../open-sse/config/searchRegistry.ts";

const searchProvider = {
  id: "exa-search",
  name: "Exa Search",
  searchTypes: ["web", "news"],
  maxMaxResults: 100,
  disabled: false,
} as SearchProviderConfig;

test("virtual web models expose search and fetch metadata only when eligible", () => {
  const seen: Array<[string, string, VirtualWebModelKind]> = [];
  const models = buildVirtualWebCatalogModels({
    timestamp: 123,
    searchProviders: [searchProvider],
    fetchProviderIds: ["exa-search", "context7"],
    isEligible: (provider, model, kind) => {
      seen.push([provider, model, kind]);
      return provider === "exa-search";
    },
  });

  assert.deepEqual(seen, [
    ["exa-search", "search", "webSearch"],
    ["exa-search", "fetch", "webFetch"],
    ["context7", "fetch", "webFetch"],
  ]);
  assert.deepEqual(
    models.map(({ id, type }) => ({ id, type })),
    [
      { id: "exa-search/search", type: "webSearch" },
      { id: "exa-search/fetch", type: "webFetch" },
    ]
  );
  assert.equal(models[0]?.maxResults, 100);
  assert.deepEqual(models[0]?.searchTypes, ["web", "news"]);
  assert.equal(models[1]?.maxResults, undefined);
});

test("disabled search provider is never advertised even if connection is eligible", () => {
  const models = buildVirtualWebCatalogModels({
    timestamp: 123,
    searchProviders: [{ ...searchProvider, disabled: true }],
    fetchProviderIds: [],
    isEligible: () => true,
  });
  assert.deepEqual(models, []);
});

test("SearXNG needs an operator URL; the catalog localhost is not a live service", () => {
  const searxng = {
    ...searchProvider,
    id: "searxng-search",
    baseUrl: "http://localhost:8888/search",
  };
  assert.equal(hasConfiguredSearchUrl(searxng, []), false);
  assert.equal(hasConfiguredSearchUrl(searxng, [{ providerSpecificData: {} }]), false);
  assert.equal(
    hasConfiguredSearchUrl(searxng, [
      { providerSpecificData: { baseUrl: "https://search.example.net/search" } },
    ]),
    true
  );
});
