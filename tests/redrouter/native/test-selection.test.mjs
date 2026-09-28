import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { root, suiteFiles } from "../../../scripts/test/redrouter-suites.mjs";

function fixture(t, manifest = { native: [], ui: [], e2e: [] }) {
  const directory = mkdtempSync(join(tmpdir(), "redrouter-suites-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "config/testing"), { recursive: true });
  writeFileSync(join(directory, "config/testing/redrouter-suites.json"), JSON.stringify(manifest));
  return directory;
}

function touch(directory, path) {
  const target = join(directory, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, "");
}

test("new product tests are discovered without including inherited neighbors", (t) => {
  const directory = fixture(t, { native: ["tests/unit/retained.test.ts"] });
  touch(directory, "tests/unit/retained.test.ts");
  touch(directory, "tests/unit/upstream.test.ts");
  touch(directory, "tests/redrouter/native/nested/new.test.mjs");
  touch(directory, "tests/redrouter/ui/component.test.tsx");
  assert.deepEqual(suiteFiles("native", directory), [
    "tests/redrouter/native/nested/new.test.mjs",
    "tests/unit/retained.test.ts",
  ]);
});

test("empty, missing and invalid selections fail instead of falling back to upstream", (t) => {
  assert.throws(() => suiteFiles("unknown"), /Unknown RedRouter suite/);
  assert.throws(() => suiteFiles("native", fixture(t)), /is empty/);
  assert.throws(() => suiteFiles("ui", fixture(t, { native: [] })), /Missing RedRouter suite/);
  for (const path of ["tests/missing.test.ts", "tests/../package.json", "package.json", null]) {
    assert.throws(
      () => suiteFiles("native", fixture(t, { native: [path] })),
      /Invalid or missing RedRouter test/
    );
  }
});

test("each product runner selects a nonempty, disjoint set of real test files", () => {
  const selections = ["native", "ui", "e2e"].map((kind) => suiteFiles(kind));
  const all = selections.flat();
  assert.equal(new Set(all).size, all.length);
  assert.ok(selections[0].includes("tests/redrouter/native/test-selection.test.mjs"));
  for (const file of selections[0]) {
    const source = readFileSync(join(root, file), "utf8");
    assert.doesNotMatch(source, /from ["'](?:vitest|@playwright\/test)["']/);
  }
});

test("default commands and CI only run the product suites, with one shared build", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const key of ["test", "test:unit", "test:unit:ci"]) {
    assert.equal(pkg.scripts[key], "node scripts/test/run-redrouter.mjs native");
  }
  assert.equal(pkg.scripts["test:vitest"], "node scripts/test/run-redrouter.mjs ui");
  assert.equal(pkg.scripts["test:e2e"], "node scripts/test/run-redrouter.mjs e2e");
  assert.equal(
    pkg.scripts["test:all"],
    "npm run test:unit && npm run test:vitest && npm run test:e2e"
  );
  assert.ok(pkg.scripts["test:upstream:unit"]);
  const ci = YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
  const jobs = Object.values(ci.jobs);
  const commands = jobs.flatMap((job) => job.steps.map((step) => step.run || ""));
  assert.equal(commands.filter((command) => command === "npm run build:release").length, 1);
  for (const command of [
    "npm run test:unit:ci",
    "npm run test:vitest",
    "npm run test:e2e",
    "npm run check:pack-artifact",
    "npm run check:pack-boot",
  ]) {
    assert.ok(commands.includes(command), command);
  }
  assert.doesNotMatch(
    commands.join("\n"),
    /test:upstream|test:unit:ci:shard|test:coverage|test:ecosystem/
  );
  assert.ok(jobs.every((job) => !job["continue-on-error"]));
});
