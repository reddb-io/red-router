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
  assert.equal(workflow.jobs.resolve.if, "github.repository == 'reddb-io/red-router'");
  assert.equal(workflow.jobs.publish.if, "github.repository == 'reddb-io/red-router'");
  assert.equal(workflow.jobs.publish["runs-on"], "ubuntu-latest");
  assert.equal(workflow.jobs.publish.permissions["id-token"], "write");
  assert.match(text, /--provenance --ignore-scripts/);
  assert.match(text, /sha256sum -c SHA256SUMS/);
  assert.doesNotMatch(text, /npm run build:release|npm ci|npm pkg set/);
  assert.match(text, /scripts\/release\/artifact\.mjs verify/);
  assert.match(text, /run-id: \$\{\{ needs.resolve.outputs.run_id \}\}/);
  assert.match(text, /workflow_id: "ci.yml"/);
  assert.match(text, /run.head_sha === process.env.RELEASE_SHA/);
  assert.match(text, /latest.status !== "completed" \|\| latest.conclusion !== "success"/);
  assert.match(text, /@reddb-io\/red-router/);
  assert.match(text, /MISE_NPM_PACKAGE_MANAGER: aube/);
  assert.match(text, /mise install --verbose/);
  assert.match(text, /mise exec -- red-router --version/);
  assert.match(text, /dist.integrity --prefer-online/);
  assert.match(text, /seq 1 90/);
  assert.match(text, /--fetch-retries=0 --fetch-timeout=10000/);
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
    "build.yml",
    "quality.yml",
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
  const ci = YAML.parse(readFileSync(join(active, "ci.yml"), "utf8"));
  assert.deepEqual(ci.on.push.branches, ["main"]);
  assert.deepEqual(ci.on.pull_request.branches, ["main"]);
  assert.ok(ci.jobs["test-unit"]);
  assert.ok(ci.jobs["test-vitest"]);
  for (const file of readdirSync(active).filter((name) => /\.ya?ml$/.test(name))) {
    const workflow = YAML.parse(readFileSync(join(active, file), "utf8"));
    assert.equal(workflow.on.schedule, undefined, `${file} must not schedule background jobs`);
  }
  assert.deepEqual(
    readdirSync(active)
      .filter((file) => /\.ya?ml$/.test(file))
      .sort(),
    [
      "api-route-typecheck.yml",
      "ci.yml",
      "codeql.yml",
      "red-publish.yml",
      "scorecard.yml",
      "semgrep.yml",
    ]
  );
});
