import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import YAML from "yaml";

const { cleanBuildOutput } = await import("../../../scripts/build/clean-build-output.mjs");

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "redrouter-clean-build-"));
  roots.push(root);
  for (const dir of [".build/next/cache/webpack", ".build/next/standalone", ".build/cli", "dist"]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, ".build/next/cache/webpack/entry"), "cached");
  writeFileSync(join(root, ".build/next/standalone/server.js"), "stale");
  writeFileSync(join(root, ".build/cli/index.js"), "stale");
  writeFileSync(join(root, "dist/BUILD_SHA"), "stale");
  return root;
}

test("by default the reset is exactly `rm -rf .build dist`", async () => {
  const root = fixture();
  const result = await cleanBuildOutput(root, {});
  assert.equal(result.keptCache, false);
  assert.equal(existsSync(join(root, ".build")), false);
  assert.equal(existsSync(join(root, "dist")), false);
});

test("RR_KEEP_NEXT_CACHE=1 keeps Next's cache and nothing else that could ship stale", async () => {
  const root = fixture();
  const result = await cleanBuildOutput(root, { RR_KEEP_NEXT_CACHE: "1" });
  assert.equal(result.keptCache, true);
  assert.equal(readFileSync(join(root, ".build/next/cache/webpack/entry"), "utf8"), "cached");
  assert.equal(existsSync(join(root, ".build/next/standalone")), false, "standalone is rebuilt");
  assert.equal(existsSync(join(root, ".build/cli")), false);
  assert.equal(existsSync(join(root, "dist")), false);
});

test("with the flag but no cache yet, the reset is a full clean", async () => {
  const root = mkdtempSync(join(tmpdir(), "redrouter-clean-build-"));
  roots.push(root);
  mkdirSync(join(root, ".build/next/standalone"), { recursive: true });
  const result = await cleanBuildOutput(root, { RR_KEEP_NEXT_CACHE: "1" });
  assert.equal(result.keptCache, false);
  assert.equal(existsSync(join(root, ".build")), false);
});

test("only the exact value 1 turns the cache on", async () => {
  for (const value of ["true", "0", "", "yes"]) {
    const root = fixture();
    const result = await cleanBuildOutput(root, { RR_KEEP_NEXT_CACHE: value });
    assert.equal(result.keptCache, false, value);
    assert.equal(existsSync(join(root, ".build")), false, value);
  }
});

test("the release build resets through the script and the workflow opts in for the build job only", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(pkg.scripts["build:release"], /^node scripts\/build\/clean-build-output\.mjs && /);

  const workflow = YAML.parse(readFileSync(".github/workflows/red-publish.yml", "utf8"));
  const steps = workflow.jobs.build.steps as Array<Record<string, unknown>>;
  const restore = steps.findIndex((step) => step.name === "Restore the Next build cache");
  const build = steps.findIndex((step) => step.name === "Build once");
  assert.ok(restore >= 0 && restore < build, "the cache is restored before the build");
  assert.equal((steps[restore].with as Record<string, string>).path, ".build/next/cache");
  assert.equal(steps[restore].if, "${{ inputs.artifact_run_id == '' }}");
  assert.equal((steps[build].env as Record<string, string>).RR_KEEP_NEXT_CACHE, "1");
  assert.equal(steps[build].run, "npm run build:release");

  // No other job may keep a stale build around.
  for (const [name, job] of Object.entries(workflow.jobs as Record<string, { steps: unknown[] }>)) {
    if (name === "build") continue;
    assert.doesNotMatch(JSON.stringify(job.steps), /RR_KEEP_NEXT_CACHE/, name);
  }
});
