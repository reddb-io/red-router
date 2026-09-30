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

test("the release build resets through the script; the Next build cache stays OFF in CI", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.match(pkg.scripts["build:release"], /^node scripts\/build\/clean-build-output\.mjs && /);

  // A restored 330 MB webpack cache saved about half a minute and added memory pressure to a build
  // that already runs close to the runner's limit (0.53.0: the build worker was SIGKILLed). The
  // script keeps the opt-in (RR_KEEP_NEXT_CACHE=1) but no workflow turns it on.
  const text = readFileSync(".github/workflows/red-publish.yml", "utf8");
  assert.doesNotMatch(text, /RR_KEEP_NEXT_CACHE/);
  assert.doesNotMatch(text, /\.build\/next\/cache/);
  const workflow = YAML.parse(text);
  const steps = workflow.jobs.build.steps as Array<Record<string, unknown>>;
  assert.equal(steps.find((step) => step.name === "Build once")?.run, "npm run build:release");
  assert.equal(
    steps.find((step) => step.name === "Restore the Next build cache"),
    undefined
  );
});

test("the caches survive a release: keys ignore the lockfile's own version", async () => {
  const { spawnSync } = await import("node:child_process");
  const action = YAML.parse(readFileSync(".github/actions/npm-ci-retry/action.yml", "utf8"));
  const lockStep = action.runs.steps.find((step: { id?: string }) => step.id === "lock");
  assert.ok(lockStep, "the composite action computes a version-free lock hash");
  assert.equal(action.outputs["lock-hash"].value, "${{ steps.lock.outputs.hash }}");

  const hashFor = (version: string, extra = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "redrouter-lock-hash-"));
    roots.push(dir);
    const lock = {
      name: "@reddb-io/red-router",
      version,
      lockfileVersion: 3,
      packages: {
        "": { name: "@reddb-io/red-router", version, dependencies: { a: "1.0.0" } },
        "node_modules/a": { version: "1.0.0", ...extra },
      },
    };
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock));
    const output = join(dir, "out");
    writeFileSync(output, "");
    const run = spawnSync("bash", ["-c", lockStep.run], {
      cwd: dir,
      env: { ...process.env, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(output, "utf8").trim();
  };

  const a = hashFor("0.51.1");
  assert.match(a, /^hash=[0-9a-f]{64}$/);
  assert.equal(hashFor("0.52.0"), a, "a release bump does not change the key");
  assert.notEqual(
    hashFor("0.52.0", { integrity: "sha512-changed" }),
    a,
    "a real dependency change does"
  );

  const workflow = YAML.parse(readFileSync(".github/workflows/red-publish.yml", "utf8"));
  const text = readFileSync(".github/workflows/red-publish.yml", "utf8");
  const build = workflow.jobs.build.steps as Array<Record<string, unknown>>;
  const playwright = build.find((step) => step.name === "Restore the Playwright browsers")!;
  assert.match((playwright.with as Record<string, string>).key, /steps\.ci\.outputs\.lock-hash/);
  assert.equal(build.find((step) => step.id === "ci")?.uses, "./.github/actions/npm-ci-retry");
  assert.doesNotMatch(text, /hashFiles\('package-lock\.json'/, "no cache keys on the raw lockfile");
});
