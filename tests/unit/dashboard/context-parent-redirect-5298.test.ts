import test from "node:test";
import assert from "node:assert/strict";

// #5298: `/dashboard/context` had only sub-routes and no parent page, so RSC
// prefetches of the bare parent 404'd. The new parent page redirects to a
// canonical sub-route (now its area URL); this guards the pure route resolver it uses.
const { resolveContextRoute } =
  await import("../../../src/app/(dashboard)/dashboard/context/page.tsx");

test("#5298: resolveContextRoute defaults the bare parent to the canonical sub-route", () => {
  assert.equal(resolveContextRoute(undefined), "/optimize/token-saver");
  assert.equal(resolveContextRoute(""), "/optimize/token-saver");
});

test("#5298: resolveContextRoute maps a known tab to its sub-route", () => {
  assert.equal(resolveContextRoute("ultra"), "/optimize/token-saver/engines/ultra");
  assert.equal(resolveContextRoute("session-dedup"), "/optimize/token-saver/engines/session-dedup");
  assert.equal(resolveContextRoute("llmlingua"), "/optimize/token-saver/engines/llmlingua");
});

test("#5298: resolveContextRoute falls back to the default for an unknown tab", () => {
  assert.equal(resolveContextRoute("bogus"), "/optimize/token-saver");
});
