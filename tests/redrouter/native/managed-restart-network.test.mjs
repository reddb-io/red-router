import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSystemdUnit, restartManagedService } from "../../../bin/cli/service.mjs";
import { runRestartCommand } from "../../../bin/cli/commands/restart.mjs";

test("managed CLI restart preserves the LAN interface, custom port and data directory", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "redrouter-managed-restart-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const path = join(dataDir, "router.service");
  const original = buildSystemdUnit({ port: 25123, host: "0.0.0.0", dataDir });
  writeFileSync(path, original);
  const calls = [];
  const restartService = (options) =>
    restartManagedService({
      ...options,
      paths: { linux: path },
      platform: "linux",
      dataDir,
      runCommand: (command, args) => calls.push([command, ...args]),
      probe: async ({ port, dataDir: requestedDir }) => ({
        matches: port === 25123 && requestedDir === dataDir,
      }),
    });
  const noForeground = () => assert.fail("managed restart must not stop PIDs or launch defaults");
  assert.equal(
    await runRestartCommand({}, { restartService, stop: noForeground, serve: noForeground }),
    0
  );
  assert.deepEqual(calls, [["systemctl", "--user", "restart", "red-router.service"]]);
  assert.equal(readFileSync(path, "utf8"), original);

  for (const options of [{ port: 25124 }, { dataDir: join(dataDir, "other") }]) {
    const result = await restartManagedService({
      paths: { linux: path },
      platform: "linux",
      dataDir,
      ...options,
      runCommand: noForeground,
    });
    assert.equal(result.handled, false, "another instance must not restart the saved service");
  }
});

test("a service-manager failure or readiness mismatch does not launch a competing router", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "redrouter-managed-restart-failure-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const path = join(dataDir, "router.service");
  writeFileSync(path, buildSystemdUnit({ host: "0.0.0.0", dataDir }));
  for (const managerFails of [true, false]) {
    const restartService = () =>
      restartManagedService({
        paths: { linux: path },
        platform: "linux",
        dataDir,
        runCommand: () => {
          if (managerFails) throw new Error("private manager error");
        },
        probe: async () => ({ matches: false }),
      });
    assert.equal(
      await runRestartCommand(
        {},
        {
          restartService,
          stop: () => assert.fail("must not kill managed processes"),
          serve: () => assert.fail("must not replace the listener with local-only defaults"),
        }
      ),
      1
    );
  }
});

test("unmanaged restart retains CLI options and does not start after a failed stop", async () => {
  const options = { port: "25124", expose: true };
  const calls = [];
  const deps = {
    restartService: async () => ({ handled: false }),
    stop: async (opts) => {
      calls.push(["stop", opts]);
      return 0;
    },
    sleep: async (ms) => calls.push(["sleep", ms]),
    serve: async (opts) => calls.push(["serve", opts]),
  };
  assert.equal(await runRestartCommand(options, deps), 0);
  assert.deepEqual(calls, [
    ["stop", options],
    ["sleep", 1000],
    ["serve", options],
  ]);
  calls.length = 0;
  assert.equal(await runRestartCommand(options, { ...deps, stop: async () => 1 }), 1);
  assert.deepEqual(calls, []);
});
