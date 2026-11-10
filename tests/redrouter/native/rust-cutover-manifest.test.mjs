import assert from "node:assert/strict";
import test from "node:test";

import {
  inventoryNextRoutes,
  inventoryRustRoutes,
  loadCutoverManifest,
  validateCutoverManifest,
} from "../../../scripts/check/check-rust-cutover.mjs";

const manifest = loadCutoverManifest();
const nextRoutes = inventoryNextRoutes();
const rustRoutes = inventoryRustRoutes();

test("the Rust cutover ledger classifies every Next route and references real Rust routes", () => {
  assert.deepEqual(validateCutoverManifest(manifest, { nextRoutes, rustRoutes }), []);
});

test("a new Next route family cannot bypass an ownership decision", () => {
  const errors = validateCutoverManifest(manifest, {
    nextRoutes: [...nextRoutes, "unclassified-product/route.ts"],
    rustRoutes,
  });
  assert.ok(errors.some((error) => error.includes("unclassified Next route family")));
  assert.ok(errors.some((error) => error.includes("Next route total changed")));
});

test("ready mode stays red until all five operator gates are closed", () => {
  const errors = validateCutoverManifest(manifest, {
    nextRoutes,
    rustRoutes,
    requireReady: true,
  });
  assert.equal(errors.filter((error) => error.includes("cutover gate is not ready")).length, 5);
});

test("a gate cannot claim a Rust endpoint that the server does not expose", () => {
  const changed = structuredClone(manifest);
  changed.cutoverGates[0].requiredRustRoutes.push("/api/admin/not-implemented");
  const errors = validateCutoverManifest(changed, { nextRoutes, rustRoutes });
  assert.ok(errors.some((error) => error.includes("references missing Rust route")));
});
