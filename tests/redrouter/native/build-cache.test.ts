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

test("the release reset removes all Rust and SPA build outputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "redrouter-clean-build-"));
  roots.push(root);
  for (const file of [
    ".build/rust-dashboard/index.html",
    "dist/legacy-server.js",
    "rust-runtime/BUILD_SHA",
  ]) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "stale");
  }

  assert.deepEqual(await cleanBuildOutput(root), {
    removed: [".build", "dist", "rust-runtime"],
  });
  for (const output of [".build", "dist", "rust-runtime"]) {
    assert.equal(existsSync(join(root, output)), false);
  }
});

test("the release build resets once and builds only the Rust package", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(
    pkg.scripts["build:release"],
    "node scripts/build/clean-build-output.mjs && npm run build:rust-package"
  );

  const workflow = YAML.parse(readFileSync(".github/workflows/red-publish.yml", "utf8"));
  const steps = workflow.jobs.build.steps as Array<Record<string, unknown>>;
  assert.equal(steps.find((step) => step.name === "Build once")?.run, "npm run build:release");
});
