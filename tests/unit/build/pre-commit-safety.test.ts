import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const root = new URL("../../../", import.meta.url);

test("RedRouter commits do not execute or install pre-commit tooling", () => {
  assert.equal(existsSync(new URL(".husky/pre-commit", root)), false);
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  assert.equal(pkg["lint-staged"], undefined);
  assert.equal(pkg.devDependencies["lint-staged"], undefined);
  assert.equal(pkg.scripts["pre-commit"], undefined);
});

test("removing pre-commit keeps RedRouter contracts and package validation in CI", () => {
  const ci = readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
  for (const command of [
    "test:unit:ci",
    "test:vitest",
    "check:tracked-artifacts",
    "check:pack-artifact",
    "check:pack-boot",
  ]) {
    assert.ok(ci.includes(`npm run ${command}`), `${command} must remain in CI`);
  }
  assert.ok(existsSync(new URL(".husky/commit-msg", root)));
  assert.ok(existsSync(new URL(".husky/pre-push", root)));
});
