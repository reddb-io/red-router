import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectInstallationChannel, runUpdateCommand } from "../../../bin/cli/commands/update.mjs";

test("channel detection compares package locations rather than using the first package manager found", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-update-channel-"));
  const root = join(dir, "lib", "node_modules", "@reddb-io", "red-router");
  mkdirSync(root, { recursive: true });
  try {
    const exec = async (command, args, options) => {
      assert.equal(options.shell, false);
      if (command === "mise") throw new Error("not installed");
      assert.deepEqual(args, ["root", "--global"]);
      return { stdout: join(dir, "lib", "node_modules") };
    };
    assert.equal((await detectInstallationChannel(exec, { packageRoot: root })).kind, "npm");
    const source = join(dir, "source");
    mkdirSync(source);
    assert.equal(await detectInstallationChannel(exec, { packageRoot: source }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply uses an exact RedRouter version; dry-run and unknown channels never mutate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-update-apply-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "99.0.0" }));
  const calls = [];
  const dependencies = {
    latest: async () => "99.0.0",
    detect: async () => ({ kind: "npm", root: dir }),
    status: () => ({ installed: false }),
    exec: async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: "" };
    },
  };
  try {
    assert.equal(await runUpdateCommand({ apply: true, dryRun: true }, dependencies), 0);
    assert.equal(calls.length, 0);
    assert.equal(
      await runUpdateCommand({ apply: true }, { ...dependencies, detect: async () => null }),
      1
    );
    assert.equal(calls.length, 0);
    assert.equal(await runUpdateCommand({ apply: true }, dependencies), 0);
    assert.deepEqual(calls[0].slice(1), ["install", "--global", "@reddb-io/red-router@99.0.0"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
