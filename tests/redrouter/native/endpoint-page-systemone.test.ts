import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

test("the Endpoint page lists /v1/systemone and its /v1/decisions alias", () => {
  const page = read("src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.tsx");
  assert.ok(page.includes('path="/v1/systemone"'));
  assert.ok(page.includes('path="/v1/decisions"'));
  // Both cards read the System One models of the caller's catalog.
  assert.ok(page.includes('m.type === "systemone"'));
  const messages = JSON.parse(read("src/i18n/messages/en.json"));
  assert.equal(messages.endpoint.systemOne, "System One");
  assert.equal(messages.endpoint.decisions, "Decisions");
});
