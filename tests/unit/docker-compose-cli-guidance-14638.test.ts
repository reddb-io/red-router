import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

test("the production compose no longer exposes Node/CLI image profiles", () => {
  const compose = read("docker-compose.yml");
  assert.match(compose, /dockerfile: Dockerfile\.rust/);
  assert.doesNotMatch(compose, /profiles:|runner-cli|runner-base|runner-web|omniroute-(cli|base|web|host)/);
});
