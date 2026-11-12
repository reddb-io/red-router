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

test("manual quality runs product suites and release owns one package build", () => {
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
  const ci = YAML.parse(readFileSync(join(root, ".github/workflows/red-publish.yml"), "utf8"));
  const quality = YAML.parse(readFileSync(join(root, ".github/workflows/quality.yml"), "utf8"));
  assert.deepEqual(Object.keys(quality.on), ["workflow_dispatch"]);
  const releaseCommands = Object.values(ci.jobs).flatMap((job) =>
    job.steps.map((step) => step.run || "")
  );
  assert.equal(releaseCommands.filter((command) => command === "npm run build:release").length, 1);
  const jobs = [...Object.values(ci.jobs), ...Object.values(quality.jobs)];
  const commands = jobs.flatMap((job) => job.steps.map((step) => step.run || ""));
  for (const command of [
    "npm run test:unit:ci",
    "npm run test:vitest",
    "npm run test:e2e",
    "npm run check:rust-package",
  ]) {
    assert.ok(commands.includes(command), command);
  }
  assert.doesNotMatch(
    commands.join("\n"),
    /test:upstream|test:unit:ci:shard|test:coverage|test:ecosystem/
  );
  assert.ok(jobs.every((job) => !job["continue-on-error"]));
});

test("company worker suites keep heavyweight builds and publishers hosted", () => {
  const quality = YAML.parse(readFileSync(join(root, ".github/workflows/quality.yml"), "utf8"));
  const publish = YAML.parse(readFileSync(join(root, ".github/workflows/red-publish.yml"), "utf8"));
  assert.ok(quality.on.workflow_dispatch.inputs.suite.options.includes("workers"));
  for (const name of ["test-unit", "test-vitest"]) {
    assert.match(quality.jobs[name]["runs-on"], /reddb-public-linux-x64/);
    assert.match(quality.jobs[name].if, /inputs\.suite == 'workers'/);
  }
  assert.equal(quality.jobs["desktop-services"]["runs-on"], "ubuntu-latest");
  assert.match(quality.jobs["desktop-services"].if, /inputs\.runner_qualification != true/);
  assert.equal(quality.jobs.checks["runs-on"], "ubuntu-latest");
  assert.doesNotMatch(quality.jobs.checks.if, /inputs\.suite == 'workers'/);
  assert.equal(publish.jobs.build["runs-on"], "ubuntu-latest");
  assert.equal(publish.jobs.release["runs-on"], "ubuntu-latest");
  assert.equal(quality.jobs.browser["runs-on"], "ubuntu-24.04");
  assert.equal(quality.jobs["test-routing-storage"]["runs-on"], "ubuntu-latest");
  assert.match(publish.jobs.release.if, /inputs\.runner_qualification != true/);
});
