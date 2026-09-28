import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";

const root = process.cwd();
const active = join(root, ".github/workflows");
test("RedRouter is the only active npm publisher and keeps independent provenance", () => {
  const publishers = readdirSync(active).filter((file) => {
    const text = readFileSync(join(active, file), "utf8");
    return /npm(?:-cli\.js\")?\s+publish|npm-cli\.js.*\bpublish\b/.test(text);
  });
  assert.deepEqual(publishers, ["red-publish.yml"]);
  const text = readFileSync(join(active, "red-publish.yml"), "utf8");
  const workflow = YAML.parse(text);
  assert.equal(workflow.jobs.build.if, "github.repository == 'reddb-io/red-router'");
  assert.equal(workflow.jobs.publish.if, "github.repository == 'reddb-io/red-router'");
  assert.equal(workflow.jobs.publish["runs-on"], "ubuntu-latest");
  assert.equal(workflow.jobs.publish.permissions["id-token"], "write");
  assert.match(text, /--provenance --ignore-scripts/);
  assert.match(text, /sha256sum -c SHA256SUMS/);
  assert.match(text, /npm run check:pack-boot/);
  assert.match(text, /workflow_id: "ci.yml"/);
  assert.match(text, /run.head_sha === process.env.RELEASE_SHA/);
  assert.match(text, /latest.status !== "completed" \|\| latest.conclusion !== "success"/);
  assert.match(text, /@reddb-io\/red-router/);
  assert.match(text, /MISE_NPM_PACKAGE_MANAGER: aube/);
  assert.match(text, /mise install --verbose/);
  assert.match(text, /mise exec -- red-router --version/);
  assert.match(text, /dist.integrity --prefer-online/);
  const steps = workflow.jobs.publish.steps;
  const consumerCheck = steps.findIndex((step: { name: string }) =>
    step.name.includes("aube trust checks")
  );
  const githubRelease = steps.findIndex(
    (step: { name: string }) => step.name === "Create GitHub release with checksum"
  );
  assert.ok(consumerCheck >= 0 && consumerCheck < githubRelease);
  assert.doesNotMatch(
    text,
    /trust_policy_excludes|NODE_TLS_REJECT_UNAUTHORIZED|MISE_INSECURE|npm\.shell_out/
  );
});

test("upstream operational jobs remain inert fixtures, not active workflows", () => {
  for (const file of [
    "claude.yml",
    "deploy-vps.yml",
    "lock-released-branch.yml",
    "radar-export.yml",
    "wiki-sync.yml",
    "npm-publish.yml",
    "electron-release.yml",
    "nightly-release-green.yml",
  ]) {
    assert.equal(existsSync(join(active, file)), false, file);
    assert.equal(existsSync(join(root, "tests/fixtures/upstream-workflows", file)), true, file);
  }
  const ci = YAML.parse(readFileSync(join(active, "ci.yml"), "utf8"));
  assert.deepEqual(ci.on.push.branches, ["main"]);
  assert.deepEqual(ci.on.pull_request.branches, ["main"]);
  assert.ok(ci.jobs["test-unit"]);
  assert.ok(ci.jobs["test-vitest"]);
});
