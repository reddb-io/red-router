import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSystemdUnit,
  installService,
  probeRunningVersion,
  readServiceConfiguration,
  servicePaths,
} from "../../../bin/cli/service.mjs";
import { checkServiceReadiness } from "../../../bin/cli/commands/doctor.mjs";

test("an upgrade restarts the active server and preserves its bind configuration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-service-upgrade-"));
  const paths = { ...servicePaths(dir), linux: join(dir, "router.service") };
  writeFileSync(
    paths.linux,
    buildSystemdUnit({ port: 25123, host: "0.0.0.0", dataDir: join(dir, "custom data") })
  );
  const calls = [];
  try {
    const result = await installService({
      paths,
      platform: "linux",
      env: {},
      runCommand: (_command, args) => {
        calls.push(args);
        return "active";
      },
      installTray: () => ({ state: "waiting-for-desktop" }),
      desktopInstaller: () => {},
      probe: async ({ port }) => ({ matches: port === 25123 }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.action, "restarted");
    assert.deepEqual(calls.at(-1), ["--user", "restart", "red-router.service"]);
    assert.deepEqual(readServiceConfiguration(paths.linux), { port: 25123, host: "0.0.0.0" });
    const failed = await installService({
      paths,
      platform: "linux",
      env: {},
      runCommand: () => "active",
      installTray: () => ({ state: "failed" }),
      desktopInstaller: () => {},
      probe: async () => ({ matches: true }),
    });
    assert.equal(failed.serverReady, true);
    assert.equal(failed.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("version verification is authenticated, bounded, local and refuses redirects", async () => {
  let calls = 0;
  const options = {
    expectedVersion: "1.2.3",
    tokenProvider: async () => "fixture-token",
    timeoutMs: 1,
    fetchImpl: async (_url, init) => {
      calls++;
      assert.equal(init.headers["x-omniroute-cli-token"], "fixture-token");
      assert.equal(init.redirect, "error");
      return Response.json({ version: "1.2.3", system: { pid: 42 } });
    },
  };
  assert.equal((await probeRunningVersion(options)).matches, true);
  for (const url of ["https://example.com", "http://secret@127.0.0.1", "file:///tmp/foo"]) {
    assert.equal((await probeRunningVersion({ ...options, url })).matches, false);
  }
  assert.equal(calls, 1);
  assert.equal(
    (
      await probeRunningVersion({
        ...options,
        fetchImpl: async () => Response.json({ version: "old" }),
      })
    ).reason,
    "version-mismatch"
  );
  assert.match(buildSystemdUnit({ cliPath: "/opt/100%/cli.mjs" }), /100%%/);
});

test("doctor distinguishes an active server from a registered desktop icon", async () => {
  const checks = await checkServiceReadiness(
    {},
    {
      status: () => ({
        ok: true,
        installed: true,
        state: "active",
        tray: { installed: true, registered: false },
      }),
      probe: async () => ({ matches: false, runningVersion: "old" }),
    }
  );
  assert.equal(checks.find((c) => c.name === "Background service").status, "ok");
  assert.equal(checks.find((c) => c.name === "Running version").status, "fail");
  assert.equal(checks.find((c) => c.name === "Desktop tray").status, "warn");
});
