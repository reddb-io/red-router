import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildLinuxTrayUnit,
  installLinuxTrayService,
  registeredTrayPids,
  startLinuxTrayService,
  uninstallLinuxTrayService,
  waitForTrayRegistration,
} from "../../../bin/cli/tray/linuxService.mjs";
import { runTrayLifecycle } from "../../../bin/cli/tray/lifecycle.mjs";

const config = {
  nodePath: "/opt/node/bin/node",
  cliPath: "/opt/red router/bin/omniroute.mjs",
  dataDir: "/home/test/.red/router",
  port: 25050,
};

test("Linux tray has its own graphical service, with readiness, recovery and journal diagnostics", () => {
  const unit = buildLinuxTrayUnit(config);
  assert.match(unit, /Type=notify\nNotifyAccess=all/);
  assert.match(unit, /PartOf=graphical-session.target/);
  assert.match(unit, /WantedBy=graphical-session.target/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /"tray" "attach".*"--managed"/);
  assert.match(unit, /StandardError=journal/);
  assert.doesNotMatch(unit, /"serve"|WantedBy=default.target/);
  assert.match(buildLinuxTrayUnit({ ...config, cliPath: "/opt/100%/router.mjs" }), /100%%/);
});

test("upgrade switches the tray unit, while repeated installation keeps its process", () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-tray-service-"));
  const unitPath = join(dir, "tray.service");
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return "";
  };
  try {
    installLinuxTrayService({ ...config, unitPath, env: { DISPLAY: ":0" }, run });
    assert.deepEqual(calls.at(-1), [
      "systemctl",
      "--user",
      "--no-block",
      "restart",
      "red-router-tray.service",
    ]);
    calls.length = 0;
    installLinuxTrayService({ ...config, unitPath, env: { DISPLAY: ":0" }, run });
    assert.deepEqual(calls.at(-1), [
      "systemctl",
      "--user",
      "--no-block",
      "start",
      "red-router-tray.service",
    ]);
    calls.length = 0;
    installLinuxTrayService({
      ...config,
      cliPath: "/new/router.mjs",
      unitPath,
      env: { DISPLAY: ":0" },
      run,
    });
    assert.match(readFileSync(unitPath, "utf8"), /\/new\/router.mjs/);
    assert.equal(calls.at(-1)[3], "restart");
    assert.deepEqual(
      calls.find((call) => call.includes("import-environment")),
      ["systemctl", "--user", "import-environment", "DISPLAY"]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("headless installation waits for a desktop, and an unattended upgrade uses the active session", () => {
  assert.equal(
    startLinuxTrayService({
      env: {},
      run: () => {
        throw new Error("inactive");
      },
    }).state,
    "waiting-for-desktop"
  );
  const calls = [];
  assert.equal(
    startLinuxTrayService({
      env: {},
      replace: true,
      run: (_cmd, args) => {
        calls.push(args);
        return "active";
      },
    }).state,
    "starting"
  );
  assert.deepEqual(calls.at(-1), ["--user", "--no-block", "restart", "red-router-tray.service"]);
});

test("an explicit opt-out removes owned startup, but never rewrites someone else's unit", () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-tray-optout-"));
  const unitPath = join(dir, "tray.service");
  const calls = [];
  const run = (_cmd, args) => {
    calls.push(args);
    return "";
  };
  try {
    writeFileSync(unitPath, "# Custom operator unit\n");
    assert.equal(
      installLinuxTrayService({ ...config, unitPath, env: { DISPLAY: ":0" }, run }).state,
      "unmanaged"
    );
    uninstallLinuxTrayService({ unitPath, run });
    assert.equal(calls.length, 0);
    assert.equal(readFileSync(unitPath, "utf8"), "# Custom operator unit\n");
    writeFileSync(unitPath, buildLinuxTrayUnit(config));
    assert.equal(
      installLinuxTrayService({ ...config, unitPath, env: { RED_ROUTER_TRAY: "0" }, run }).state,
      "disabled"
    );
    assert.equal(existsSync(unitPath), false);
    assert.deepEqual(calls[0], ["--user", "disable", "--now", "red-router-tray.service"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("desktop readiness checks the helper's D-Bus owner instead of accepting another app's icon", async () => {
  const run = (_cmd, args) => {
    if (args.includes("get-property"))
      return JSON.stringify({ data: [":1.1@/item", ":1.2@/item", ":1.gone@/item"] });
    if (args.at(-1) === ":1.gone") throw new Error("gone");
    return JSON.stringify({ data: [args.at(-1) === ":1.1" ? 101 : 202] });
  };
  assert.deepEqual(registeredTrayPids(run), [101, 202]);
  await waitForTrayRegistration(202, { run });
  await assert.rejects(waitForTrayRegistration(999, { run, timeoutMs: 1 }), /did not register/);
});

test("startup errors release the tray lock; native helper death fails for supervisor recovery", async () => {
  let destroyed = 0;
  let released = 0;
  const cleanup = { destroy: () => destroyed++, release: () => released++ };
  await assert.rejects(
    runTrayLifecycle({
      ...cleanup,
      initialize: async () => {
        throw new Error("broken runtime");
      },
    }),
    /broken runtime/
  );
  await assert.rejects(
    runTrayLifecycle({ ...cleanup, initialize: async () => null }),
    /unavailable/
  );
  const child = new EventEmitter();
  await assert.rejects(
    runTrayLifecycle({
      ...cleanup,
      initialize: async () => ({ _process: child }),
      onReady: async () => {
        child.emit("exit", 1);
      },
    }),
    /exited unexpectedly/
  );
  assert.equal(destroyed, 3);
  assert.equal(released, 3);
  assert.equal(child.listenerCount("exit"), 0);
});

test("shutdown during startup cleans up, and lost registration restarts the tray", async () => {
  const signals = new EventEmitter();
  let released = 0;
  await runTrayLifecycle({
    signalSource: signals,
    initialize: () => {
      signals.emit("SIGTERM");
      return new Promise(() => {});
    },
    destroy: () => {},
    release: () => released++,
  });
  assert.equal(released, 1);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
  await assert.rejects(
    runTrayLifecycle({
      initialize: async () => ({}),
      destroy: () => {},
      release: () => released++,
      healthCheck: () => false,
      healthIntervalMs: 1,
    }),
    /lost its desktop registration/
  );
  assert.equal(released, 2);
});
