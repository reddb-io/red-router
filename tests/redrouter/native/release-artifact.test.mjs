import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import YAML from "yaml";
import {
  hashes,
  validateMetadata,
  verifyArtifact,
  tarballName,
} from "../../../scripts/release/artifact.mjs";
import { CHANGESETS_CLI, releasePackage } from "../../../scripts/release/changesets.mjs";

test("Changesets targets only the root deliverable, not private upstream workspaces", () => {
  assert.equal(CHANGESETS_CLI, "@changesets/cli@3.0.3");
  assert.deepEqual(
    releasePackage({
      name: "@reddb-io/red-router",
      version: "0.34.0",
      workspaces: ["open-sse"],
      dependencies: { x: "1" },
    }),
    { name: "@reddb-io/red-router", version: "0.34.0", private: false }
  );
  assert.throws(() => releasePackage({ name: "omniroute", version: "3.8.51" }));
});

test("source and lockfile carry the canonical package identity before building", async () => {
  const root = new URL("../../../", import.meta.url);
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8"));
  assert.equal(pkg.name, "@reddb-io/red-router");
  assert.match(pkg.version, /^0\.\d+\.\d+$/);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""].version, pkg.version);
  assert.equal(lock.packages[""].name, pkg.name);
});

test("artifact verification rejects wrong SHA, run, version, manifest and tampered bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "redrouter-artifact-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "package"));
  const manifest = {
    name: "@reddb-io/red-router",
    version: "0.34.1",
    bin: { "red-router": "bin/omniroute.mjs" },
  };
  await writeFile(join(directory, "package/package.json"), JSON.stringify(manifest));
  const tarball = tarballName(manifest.version);
  await promisify(execFile)("tar", ["-czf", join(directory, tarball), "-C", directory, "package"]);
  const metadata = {
    schema: 1,
    packageName: manifest.name,
    version: manifest.version,
    sourceSha: "a".repeat(40),
    tarball,
    runId: "123",
    runAttempt: "1",
    ...(await hashes(join(directory, tarball))),
  };
  await writeFile(join(directory, "release.json"), JSON.stringify(metadata));
  await verifyArtifact(directory, {
    sourceSha: metadata.sourceSha,
    version: "0.34.1",
    runId: "123",
    runAttempt: "1",
  });
  for (const expected of [
    { sourceSha: "b".repeat(40) },
    { version: "0.34.2" },
    { runId: "999" },
    { runAttempt: "2" },
  ]) {
    await assert.rejects(verifyArtifact(directory, expected), /mismatch/);
  }
  assert.throws(() => validateMetadata({ ...metadata, tarball: "../outside.tgz" }), /Invalid/);
  await writeFile(
    join(directory, "package/package.json"),
    JSON.stringify({ ...manifest, name: "omniroute" })
  );
  await promisify(execFile)("tar", ["-czf", join(directory, tarball), "-C", directory, "package"]);
  await writeFile(
    join(directory, "release.json"),
    JSON.stringify({
      ...metadata,
      ...(await hashes(join(directory, tarball))),
    })
  );
  await assert.rejects(verifyArtifact(directory), /manifest differs/);
  await writeFile(join(directory, tarball), "tampered");
  await assert.rejects(verifyArtifact(directory), /checksum mismatch/);
});

test("CI packs once and publication only promotes the verified artifact", async () => {
  const root = new URL("../../../", import.meta.url);
  const workflow = YAML.parse(
    await readFile(new URL(".github/workflows/red-publish.yml", root), "utf8")
  );
  const build = workflow.jobs.build;
  const commands = build.steps.map((step) => step.run).filter(Boolean);
  assert.equal(commands.filter((cmd) => cmd === "npm run release:pack").length, 1);
  assert.ok(
    commands.indexOf("npm run release:pack") < commands.indexOf("npm run check:pack-artifact")
  );
  assert.equal(build.env.REDROUTER_RELEASE_ARTIFACT_DIR, "release-artifacts");
  assert.equal(build.env.OMNIROUTE_PLAYWRIGHT_SKIP_BUILD, "1");
  const upload = build.steps.find((step) => step.name === "Upload the tested release artifact");
  assert.equal(upload.if, "inputs.artifact_run_id == ''");
  const promotion = build.steps.find((step) => step.id === "promote");
  assert.match(promotion.if, /refs\/tags\/v/);
  assert.match(promotion.run, /promote-main-artifact/);
  const buildOnce = build.steps.find((step) => step.name === "Build once");
  assert.match(buildOnce.if, /!startsWith/);
  const releaseCommands = workflow.jobs.release.steps
    .map((step) => step.run)
    .filter(Boolean)
    .join("\n");
  assert.doesNotMatch(releaseCommands, /npm run build|npm ci|npm pack|npm pkg set/);
  assert.match(releaseCommands, /scripts\/release\/artifact\.mjs verify/);
  assert.match(releaseCommands, /--provenance --ignore-scripts/);
  assert.match(releaseCommands, /mise install --verbose/);
  assert.match(releaseCommands, /sha256sum -c SHA256SUMS/);
  assert.equal(workflow.jobs.release.needs.includes("build"), true);
});

test("browser smoke and browser installation use the same Playwright test CLI", async () => {
  const root = new URL("../../../", import.meta.url);
  const runner = await readFile(new URL("scripts/dev/run-playwright-tests.mjs", root), "utf8");
  assert.ok(runner.includes('require.resolve("@playwright/test/cli")'));
  assert.doesNotMatch(runner, /node_modules\/playwright\/cli\.js/);
  const ci = YAML.parse(await readFile(new URL(".github/workflows/red-publish.yml", root), "utf8"));
  assert.ok(
    ci.jobs.build.steps.some(
      (step) =>
        step.run === "node scripts/dev/run-playwright-tests.mjs install --with-deps chromium"
    )
  );
});
