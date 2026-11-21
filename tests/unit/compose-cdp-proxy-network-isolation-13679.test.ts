import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("the Rust-only compose topology has no unauthenticated browser sidecar", () => {
  const compose = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
  assert.doesNotMatch(compose, /chatgpt-web-codex-browser|cdp-proxy|9223|omniroute-web/);
});
