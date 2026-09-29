import assert from "node:assert/strict";
import { test } from "node:test";

const { computeCatalogVersion, catalogVersionFromBody } =
  await import("../../../src/lib/catalogVersion.ts");

const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "chat", ...extra });

test("the version is 16 hex characters and ignores the catalog build time", () => {
  const a = computeCatalogVersion([model("a/x", { created: 1 })]);
  const b = computeCatalogVersion([model("a/x", { created: 2 })]);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, b);
});

test("any change a client would cache changes the version", () => {
  const base = computeCatalogVersion([model("a/x", { context_length: 1000 })]);
  assert.notEqual(base, computeCatalogVersion([model("a/x", { context_length: 2000 })]));
  assert.notEqual(base, computeCatalogVersion([model("a/x"), model("a/y")]));
  assert.notEqual(base, computeCatalogVersion([]));
});

test("the version of a serialized /v1/models body matches its entries, and junk has none", () => {
  const data = [model("a/x", { created: 5 })];
  assert.equal(catalogVersionFromBody(JSON.stringify({ object: "list", data })), computeCatalogVersion(data));
  assert.equal(catalogVersionFromBody("not json"), null);
  assert.equal(catalogVersionFromBody(JSON.stringify({ error: "x" })), null);
});
