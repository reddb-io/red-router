import assert from "node:assert/strict";
import test from "node:test";

import { LRUCache } from "../../../src/lib/cacheLayer.ts";

test("oversized cache writes preserve useful entries and obey the byte budget", () => {
  const cache = new LRUCache({ maxSize: 10, maxBytes: 1024 });
  cache.set("keep", "small");
  cache.set("other", "useful");
  cache.set("huge", "x".repeat(4096));
  cache.set("keep", { huge: "x".repeat(4096) });
  assert.equal(cache.get("huge"), undefined);
  assert.equal(cache.get("keep"), "small");
  assert.equal(cache.get("other"), "useful");
  assert.ok(cache.getStats().bytes <= cache.getStats().maxBytes);
});

test("cache budgets include the cost of many tiny objects, not just serialized text", () => {
  const cache = new LRUCache({ maxSize: 10, maxBytes: 1024 });
  cache.set(
    "objects",
    Array.from({ length: 100 }, () => ({}))
  );
  assert.equal(cache.has("objects"), false);
});

test("invalid cache limits cannot disable eviction and zero capacity disables storage", () => {
  const cache = new LRUCache({ maxSize: NaN, maxBytes: Infinity });
  for (let i = 0; i < 100; i++) cache.set(String(i), "value");
  const stats = cache.getStats();
  assert.ok(Number.isFinite(stats.maxSize));
  assert.ok(Number.isFinite(stats.maxBytes));
  assert.ok(stats.size <= stats.maxSize);
  assert.ok(stats.bytes <= stats.maxBytes);

  for (const options of [{ maxSize: 0 }, { maxBytes: 0 }]) {
    const disabled = new LRUCache(options);
    disabled.set("key", "value");
    assert.equal(disabled.has("key"), false);
  }
});
