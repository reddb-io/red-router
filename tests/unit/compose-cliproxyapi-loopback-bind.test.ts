import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("the Rust-only compose topology has no external proxy sidecars", () => {
  const compose = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
  assert.doesNotMatch(compose, /cliproxyapi|qdrant|bifrost|redis/i);
  assert.match(compose, /RED_ROUTER_DB_BACKEND=sqlite/);
});

test(".env.example retains legacy bind documentation for upgrade compatibility", () => {
  const env = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  assert.match(env, /# CLIPROXY_BIND_HOST=127\.0\.0\.1/);
});
