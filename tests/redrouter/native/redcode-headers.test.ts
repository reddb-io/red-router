import assert from "node:assert/strict";
import { test } from "node:test";

const { buildOmniRouteResponseMetaHeaders, formatRedRouterCost } =
  await import("../../../src/domain/omnirouteResponseMeta.ts");
const headers = await import("../../../src/shared/constants/redRouterHeaders.ts");
const { CORS_HEADERS } = await import("../../../open-sse/utils/cors.ts");

test("the RedCode header names are the v0.33.0 contract", () => {
  assert.equal(headers.RED_ROUTER_SERVED_MODEL_HEADER, "X-RedRouter-Served-Model");
  assert.equal(headers.RED_ROUTER_COST_HEADER, "X-RedRouter-Cost-USD");
  assert.equal(headers.RED_ROUTER_CATALOG_VERSION_HEADER, "X-RedRouter-Catalog-Version");
  assert.equal(headers.RED_ROUTER_REASONING_RESPONSE_HEADER, "X-RedRouter-Reasoning");
  assert.equal(headers.RED_ROUTER_HINT_HEADER, "x-red-router-hint");
  assert.equal(headers.RED_ROUTER_REASONING_HEADER, "x-red-router-reasoning");
  assert.equal(headers.RED_ROUTER_TOKEN_SAVER_HEADER, "x-red-router-token-saver");
  assert.equal(headers.RED_ROUTER_CHAIN_HEADER, "x-red-router-chain");
  assert.equal(headers.RED_ROUTER_INSTANCE_HEADER, "x-red-router-instance");
});

test("a successful answer names the model that served it and what it cost", () => {
  const meta = buildOmniRouteResponseMetaHeaders({
    provider: "claude",
    model: "claude-opus-5-5",
    costUsd: 0.0123,
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  assert.equal(meta["X-RedRouter-Served-Model"], "claude/claude-opus-5-5");
  assert.equal(meta["X-RedRouter-Cost-USD"], "0.0123");
  // The OmniRoute headers are kept alongside.
  assert.equal(meta["X-OmniRoute-Model"], "claude-opus-5-5");
});

test("an unpriced answer carries no cost header and never a fake zero", () => {
  const meta = buildOmniRouteResponseMetaHeaders({ provider: "openrouter", model: "x/y" });
  assert.equal(meta["X-RedRouter-Served-Model"], "openrouter/x/y");
  assert.equal("X-RedRouter-Cost-USD" in meta, false);
});

test("costs are plain decimals, never exponent notation", () => {
  assert.equal(formatRedRouterCost(0.00000123), "0.00000123");
  assert.equal(formatRedRouterCost(2), "2");
  assert.equal(formatRedRouterCost(1.5), "1.5");
});

test("browser clients may send the steering headers and read the answer headers", () => {
  const allow = CORS_HEADERS["Access-Control-Allow-Headers"].toLowerCase();
  for (const name of headers.RED_ROUTER_REQUEST_HEADERS) assert.ok(allow.includes(name));
  const expose = CORS_HEADERS["Access-Control-Expose-Headers"];
  for (const name of headers.RED_ROUTER_RESPONSE_HEADERS) assert.ok(expose.includes(name));
});
