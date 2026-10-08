import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";

const root = process.cwd();
const read = (name: string): string => fs.readFileSync(path.join(root, name), "utf8");

type Workflow = {
  name: string;
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, { permissions?: Record<string, string>; needs?: unknown }>;
};

const dockerText = read(".github/workflows/red-docker.yml");
const docker = parse(dockerText) as Workflow;
const publish = parse(read(".github/workflows/red-publish.yml")) as Workflow;
const dockerfile = read("Dockerfile.npm");

test("the Docker workflow parses and is named distinctly from the npm pipeline", () => {
  assert.equal(typeof docker.name, "string");
  assert.notEqual(docker.name, publish.name);
  assert.ok(Object.keys(docker.jobs).length >= 1);
});

test("it listens to the exact name of the npm publish workflow", () => {
  const workflowRun = docker.on.workflow_run as { workflows: string[]; types: string[] };
  assert.deepEqual(workflowRun.workflows, [publish.name]);
  assert.deepEqual(workflowRun.types, ["completed"]);
});

test("it publishes only on workflow_run and workflow_dispatch, never on push or schedule", () => {
  assert.deepEqual(Object.keys(docker.on).sort(), ["workflow_dispatch", "workflow_run"]);
  assert.doesNotMatch(dockerText, /^\s*schedule:/m);
  assert.doesNotMatch(dockerText, /^\s*push:\s*$/m);
  assert.doesNotMatch(dockerText, /^\s*pull_request/m);
  const dispatch = docker.on.workflow_dispatch as {
    inputs: { tag: { required: boolean } };
  };
  assert.equal(dispatch.inputs.tag.required, true);
});

test("automatic runs require a successful SemVer tag push run", () => {
  assert.match(dockerText, /workflow_run\.conclusion == 'success'/);
  assert.match(dockerText, /workflow_run\.event == 'push'/);
  assert.match(dockerText, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
});

test("every action is pinned to a full commit SHA", () => {
  const uses = [...dockerText.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 6, "expected the checkout and docker actions");
  for (const ref of uses) {
    assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `unpinned action: ${ref}`);
  }
});

test("packages: write is granted to the image job only", () => {
  assert.doesNotMatch(dockerText.split(/^jobs:/m)[0], /packages:\s*write/);
  const writers = Object.entries(docker.jobs)
    .filter(([, job]) => job.permissions?.packages === "write")
    .map(([name]) => name);
  assert.deepEqual(writers, ["image"]);
  assert.equal((dockerText.match(/packages:\s*write/g) ?? []).length, 1);
  assert.deepEqual(docker.permissions, { contents: "read" });
  assert.equal(docker.jobs.resolve.permissions, undefined);
});

test("the image is built from the published package for both platforms", () => {
  assert.match(dockerText, /npm view "@reddb-io\/red-router@\$VERSION" version/);
  assert.match(dockerText, /file: Dockerfile\.npm/);
  assert.match(dockerText, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(dockerText, /password: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(dockerText, /enable=\$\{\{ !contains\(needs\.resolve\.outputs\.version, '-'\) \}\}/);
  assert.match(dockerText, /\/healthz/);
});

test("red-publish.yml adds routing conformance and gains no Docker publication job", () => {
  assert.deepEqual(Object.keys(publish.jobs), [
    "checks",
    "test-unit",
    "test-routing-storage",
    "test-vitest",
    "build",
    "release",
  ]);
  assert.doesNotMatch(read(".github/workflows/red-publish.yml"), /ghcr\.io|docker\//);
});

test("Dockerfile.npm installs the published package by version as a non-root user", () => {
  assert.match(dockerfile, /^FROM node:24-slim$/m);
  assert.match(dockerfile, /^ARG VERSION$/m);
  assert.match(dockerfile, /npm install -g --prefer-online "@reddb-io\/red-router@\$\{VERSION\}"/);
  const lastUser = [...dockerfile.matchAll(/^USER\s+(\S+)/gm)].pop()?.[1];
  assert.equal(lastUser, "node");
  assert.notEqual(lastUser, "root");
  // The npm install happens after dropping privileges, so the package is user-owned.
  assert.ok(dockerfile.indexOf("USER node") < dockerfile.indexOf("npm install -g"));
  assert.match(dockerfile, /DATA_DIR=\/data/);
  assert.match(dockerfile, /^VOLUME \/data$/m);
  assert.match(dockerfile, /^EXPOSE 25050$/m);
  assert.match(dockerfile, /^HEALTHCHECK .*\n\s*CMD \[.*\/healthz/m);
  assert.match(dockerfile, /^CMD \["red-router", "serve", "--expose"/m);
  const instructions = dockerfile.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(instructions, /build-essential|python3|apt-get/);
});

test("the container defaults match the CLI's real port", () => {
  assert.match(read("bin/cli/product.mjs"), /DEFAULT_PORT = 25050/);
  assert.ok(fs.existsSync(path.join(root, "src/app/healthz/route.ts")));
});
