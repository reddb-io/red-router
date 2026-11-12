import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

test("Dockerfile no longer contains the Next-specific base-path patch pipeline", () => {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
  assert.doesNotMatch(dockerfile, /OMNIROUTE_BASE_PATH|patch-basepath|ensure-docker-base-path/);
  assert.match(dockerfile, /ENTRYPOINT \["red-routerd"\]/);
});

test("docker-compose serves the SPA directly from the Rust process", () => {
  const compose = fs.readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8");
  assert.match(compose, /RED_ROUTER_SPA_DIR=\/app\/dashboard/);
  assert.doesNotMatch(compose, /OMNIROUTE_BASE_PATH/);
});

test("Hard Rule #13: shell basePath helpers never interpolate into sed/awk", () => {
  const shellFiles = [
    "scripts/check-permissions.sh",
    "scripts/docker/patch-basepath.sh",
  ];
  for (const rel of shellFiles) {
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:sed|awk)\b.*\$\{?OMNIROUTE_BASE_PATH/,
      `${rel} must not expand OMNIROUTE_BASE_PATH into sed/awk`
    );
    assert.doesNotMatch(
      source,
      /(?:sed|awk).*OMNIROUTE_BASE_PATH/,
      `${rel} must not pass OMNIROUTE_BASE_PATH on a sed/awk command line`
    );
  }

  const patcher = fs.readFileSync(
    path.join(REPO_ROOT, "scripts/docker/patch-basepath.sh"),
    "utf8"
  );
  assert.match(patcher, /exec node .*ensure-docker-base-path\.mjs/);
  assert.match(patcher, /Hard Rule #13/);

  const ensure = fs.readFileSync(
    path.join(REPO_ROOT, "scripts/docker/ensure-docker-base-path.mjs"),
    "utf8"
  );
  assert.match(ensure, /process\.env\.OMNIROUTE_BASE_PATH/);
});
