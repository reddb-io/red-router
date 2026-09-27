import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

test("#8093: .env.example documents INPUT_SANITIZER_ENABLED as enabled by default", () => {
  const envExample = readFileSync(join(repoRoot, ".env.example"), "utf8");
  const section = envExample
    .split("INPUT_SANITIZER_ENABLED")
    .slice(0, 2)
    .join("INPUT_SANITIZER_ENABLED");
  assert.match(section, /INPUT_SANITIZER_ENABLED=false/);
});

test("#8093: main ENVIRONMENT.md lists default as true", () => {
  const envDoc = readFileSync(join(repoRoot, "docs/reference/ENVIRONMENT.md"), "utf8");
  const line = envDoc.split("\n").find((entry) => entry.includes("INPUT_SANITIZER_ENABLED"));
  assert.ok(line, "ENVIRONMENT.md should have INPUT_SANITIZER_ENABLED entry");
  assert.ok(line.includes("`true`"), "ENVIRONMENT.md should list default as `true`");
  assert.ok(!line.includes("`false`"), "ENVIRONMENT.md should not list default as `false`");
});
