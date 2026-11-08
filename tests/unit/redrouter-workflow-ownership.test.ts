import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";

const root = process.cwd();
const active = join(root, ".github/workflows");

// red-docker.yml only publishes an image built from the already-published npm package; it has no
// push/pull_request/schedule trigger and cannot affect the release workflow (see docker-workflow.test.ts).
test("RedRouter keeps manual quality separate from exact-artifact releases", () => {
  const files = readdirSync(active)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort();
  assert.deepEqual(files, ["quality.yml", "quick-checks.yml", "red-docker.yml", "red-publish.yml"]);

  const text = readFileSync(join(active, "red-publish.yml"), "utf8");
  const workflow = YAML.parse(text);
  assert.deepEqual(workflow.on.push.tags, ["v*.*.*"]);
  assert.equal(workflow.on.push.branches, undefined);
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(workflow.on.schedule, undefined);
  const quality = YAML.parse(readFileSync(join(active, "quality.yml"), "utf8"));
  assert.deepEqual(Object.keys(quality.on), ["workflow_dispatch"]);
  assert.ok(quality.jobs.checks);
  assert.ok(quality.jobs["test-unit"]);
  assert.ok(quality.jobs["test-vitest"]);
  assert.ok(workflow.jobs.build);
  assert.ok(workflow.jobs.release);
  assert.deepEqual(workflow.jobs.release.needs, ["build"]);
});

test("the one workflow owns exact-artifact npm and GitHub publication", () => {
  const text = readFileSync(join(active, "red-publish.yml"), "utf8");
  const workflow = YAML.parse(text);
  const release = workflow.jobs.release;
  assert.match(release.if, /github\.repository == 'reddb-io\/red-router'/);
  assert.equal(release["runs-on"], "ubuntu-latest");
  assert.equal(release.environment, "npm-release");
  assert.equal(release.permissions["id-token"], "write");
  assert.match(text, /--provenance --ignore-scripts/);
  assert.match(text, /scripts\/release\/artifact\.mjs verify/);
  assert.match(text, /sha256sum -c SHA256SUMS/);
  assert.match(text, /MISE_NPM_PACKAGE_MANAGER: aube/);
  assert.match(text, /mise install --verbose/);
  assert.match(text, /mise exec -- red-router --version/);
  assert.match(text, /dist\.integrity --prefer-online/);
  assert.match(text, /--fetch-retries=0 --fetch-timeout=10000/);
  assert.doesNotMatch(
    text,
    /trust_policy_excludes|NODE_TLS_REJECT_UNAUTHORIZED|MISE_INSECURE|npm\.shell_out/
  );

  const releaseCommands = release.steps.map((step: { run?: string }) => step.run || "").join("\n");
  assert.doesNotMatch(releaseCommands, /npm run build:release|npm ci|npm pack|npm pkg set/);
  const smoke = release.steps.findIndex(
    (step: { name?: string }) => step.name === "Smoke the published package"
  );
  const githubRelease = release.steps.findIndex(
    (step: { name?: string }) => step.name === "Create GitHub Release"
  );
  assert.ok(smoke >= 0 && smoke < githubRelease);
});

test("npm propagation recovery verifies the original published tarball", () => {
  const workflow = YAML.parse(readFileSync(join(active, "red-publish.yml"), "utf8"));
  const build = workflow.jobs.build;
  const release = workflow.jobs.release;

  assert.equal(
    build.steps.find((step: { name?: string }) => step.name === "Build once").if,
    "${{ inputs.artifact_run_id == '' && !startsWith(github.ref, 'refs/tags/v') && inputs.tag == '' }}"
  );
  assert.equal(
    build.steps.find((step: { name?: string }) => step.name === "Pack once").if,
    "${{ inputs.artifact_run_id == '' && !startsWith(github.ref, 'refs/tags/v') && inputs.tag == '' }}"
  );
  const download = release.steps.find(
    (step: { name?: string }) => step.name === "Download the tested tarball"
  );
  assert.equal(download.if, "${{ inputs.artifact_run_id == '' }}");
  const recovery = release.steps.find(
    (step: { name?: string }) => step.name === "Recover the original published tarball"
  );
  assert.equal(recovery.if, "${{ inputs.artifact_run_id != '' }}");
  assert.match(recovery.run, /recover-published\.mjs/);
  assert.equal(recovery.env.RELEASE_RUN_ID, "${{ inputs.artifact_run_id }}");
  assert.equal(recovery.env.RELEASE_RUN_ATTEMPT, "${{ inputs.artifact_run_attempt }}");
  const verify = release.steps.find(
    (step: { name?: string }) => step.name === "Verify artifact identity and checksum"
  );
  assert.equal(verify.if, "${{ inputs.artifact_run_id == '' }}");
});

test("foreign upstream operational workflows remain inert fixtures", () => {
  for (const file of [
    "claude.yml",
    "deploy-vps.yml",
    "lock-released-branch.yml",
    "radar-export.yml",
    "wiki-sync.yml",
    "npm-publish.yml",
    "electron-release.yml",
    "nightly-release-green.yml",
    "build.yml",
    "release-acceptance.yml",
    "docker-publish.yml",
    "opencode-provider-ci.yml",
    "opencode-plugin-ci.yml",
    "dast-smoke.yml",
    "nightly-compat.yml",
    "nightly-llm-security.yml",
    "nightly-property.yml",
    "nightly-resilience.yml",
    "nightly-schemathesis.yml",
    "nightly-mutation.yml",
    "mutation-redundancy.yml",
  ]) {
    assert.equal(existsSync(join(active, file)), false, file);
    assert.equal(existsSync(join(root, "tests/fixtures/upstream-workflows", file)), true, file);
  }
  assert.ok(existsSync(join(root, "tests/fixtures/upstream-workflows/quality.yml")));
  const owned = YAML.parse(readFileSync(join(active, "quality.yml"), "utf8"));
  assert.equal(owned.name, "Optional quality");
  assert.deepEqual(Object.keys(owned.on), ["workflow_dispatch"]);
});
