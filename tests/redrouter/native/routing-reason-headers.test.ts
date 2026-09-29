import assert from "node:assert/strict";
import test from "node:test";

const { errorResponse, routingErrorHeaders, ACCESS_DENIED_ROUTING_REASONS } = await import(
  "../../../open-sse/utils/error.ts"
);
const headers = await import("../../../src/shared/constants/redRouterHeaders.ts");
const { CORS_HEADERS } = await import("../../../open-sse/utils/cors.ts");

test("the routing header names keep the v0.33.0 spelling next to the RedRouter one", () => {
  assert.equal(headers.RED_ROUTER_REASON_HEADER, "X-RedRouter-Reason");
  assert.equal(headers.RED_ROUTER_RETRY_AT_HEADER, "X-RedRouter-Retry-At");
  assert.equal(headers.LEGACY_ROUTING_REASON_HEADER, "X-9Router-Reason");
  assert.equal(headers.LEGACY_ROUTING_RETRY_AT_HEADER, "X-9Router-Retry-At");
});

test("a disabled model answers 403 with a machine-readable reason", () => {
  const response = errorResponse(403, 'Model "x" is disabled', { code: "model_disabled" });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("X-RedRouter-Reason"), "model_disabled");
  assert.equal(response.headers.get("X-9Router-Reason"), "model_disabled");
  assert.equal(response.headers.get("X-RedRouter-Retry-At"), null);
});

test("a key that may not use the model says so", () => {
  const response = errorResponse(403, "not allowed", { reason: "model_not_allowed" });
  assert.equal(response.headers.get("X-RedRouter-Reason"), "model_not_allowed");
  assert.ok(ACCESS_DENIED_ROUTING_REASONS.has("model_not_allowed"));
  assert.ok(ACCESS_DENIED_ROUTING_REASONS.has("model_disabled"));
});

test("a key limit carries the reason, the retry instant and Retry-After", () => {
  const resetAt = new Date(Date.now() + 90_000).toISOString();
  const response = errorResponse(429, "limit", { code: "rate_limit_exceeded", retryAfter: resetAt });
  assert.equal(response.headers.get("X-RedRouter-Reason"), "api_key_limit");
  assert.equal(response.headers.get("X-RedRouter-Retry-At"), resetAt);
  assert.equal(response.headers.get("X-9Router-Retry-At"), resetAt);
  assert.ok(Number(response.headers.get("Retry-After")) >= 1);
});

test("quota exhaustion and overload are classified, ordinary errors are not", () => {
  assert.equal(routingErrorHeaders(429, { error: { message: "m", code: "insufficient_quota" } })["X-RedRouter-Reason"], "quota_exhausted");
  assert.equal(routingErrorHeaders(529, { error: { message: "m" } })["X-RedRouter-Reason"], "overloaded");
  assert.deepEqual(routingErrorHeaders(500, { error: { message: "boom" } }), {});
  assert.equal(errorResponse(500, "boom").headers.get("X-RedRouter-Reason"), null);
});

test("an explicit reason wins and unsafe values never reach a header", () => {
  const response = errorResponse(503, "m", { reason: "temporarily_unavailable" });
  assert.equal(response.headers.get("X-RedRouter-Reason"), "temporarily_unavailable");
  assert.deepEqual(
    routingErrorHeaders(503, { error: { message: "m", reason: "bad\r\nX-Injected: 1" } }),
    {}
  );
});

test("browsers may read the routing headers", () => {
  const exposed = CORS_HEADERS["Access-Control-Expose-Headers"];
  for (const name of ["X-RedRouter-Reason", "X-RedRouter-Retry-At", "X-9Router-Reason", "X-9Router-Retry-At", "Retry-After"]) {
    assert.ok(exposed.includes(name), name);
  }
});
