import assert from "node:assert/strict";
import test from "node:test";
import { estimateRetainedBytes } from "../../../src/lib/retainedSize.ts";

test("size admission stops at the budget without serializing the full payload", () => {
  let touched = false;
  const payload = {
    body: "x".repeat(4096),
    get later() {
      touched = true;
      throw new Error("must not walk this subtree");
    },
  };
  assert.equal(estimateRetainedBytes(payload, 1024), Infinity);
  assert.equal(touched, false);
  assert.equal(estimateRetainedBytes(new Array(1_000_000_000), 1024), Infinity);
});

test("estimates cover container overhead and the backing buffer of a small view", () => {
  assert.ok(
    estimateRetainedBytes(
      Array.from({ length: 100 }, () => ({})),
      1_000_000
    ) > 6000
  );
  const bytes = new Uint8Array(4096);
  assert.equal(estimateRetainedBytes(bytes.subarray(0, 1), 1024), Infinity);
});

test("cycles are counted once and unsupported or deeply nested values fail closed", () => {
  const cyclic: Record<string, unknown> = { value: "small" };
  cyclic.self = cyclic;
  assert.ok(Number.isFinite(estimateRetainedBytes(cyclic, 1024)));
  let deep: unknown = "leaf";
  for (let i = 0; i < 100; i++) deep = { child: deep };
  for (const value of [deep, new Map(), () => {}, 1n]) {
    assert.equal(estimateRetainedBytes(value, 1_000_000), Infinity);
  }
  for (const budget of [NaN, Infinity, -1]) {
    assert.equal(estimateRetainedBytes("small", budget), Infinity);
  }
});
