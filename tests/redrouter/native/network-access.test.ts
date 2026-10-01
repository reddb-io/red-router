import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyNetworkAccess,
  localNetworkAddresses,
  readNetworkAccessStatus,
  replaceManagedNetworkHost,
} from "../../../src/lib/runtime/networkAccess.ts";

function unit(dataDir: string) {
  return `[Unit]\nDescription=RedRouter AI routing gateway\n# Keep my operator comment\n[Service]\nExecStart="/custom node/bin/node" "/custom router/bin/omniroute.mjs" "serve" "--port" "25101" "--host" "127.0.0.1" "--no-open"\nEnvironment="RED_ROUTER_PORT=25101"\nEnvironment="RED_ROUTER_SERVER_HOST=127.0.0.1"\nEnvironment=${JSON.stringify("DATA_DIR=" + dataDir)}\nEnvironment="OPERATOR_SETTING=keep this"\nRestart=on-failure\n`;
}

test("changing the listener preserves executable paths, port, data directory and unrelated unit bytes", () => {
  const original = unit("/custom data/with spaces");
  const lan = replaceManagedNetworkHost(original, "0.0.0.0");
  assert.equal(lan.replaceAll("0.0.0.0", "127.0.0.1"), original);
  assert.equal(replaceManagedNetworkHost(lan, "127.0.0.1"), original);
  assert.throws(() => replaceManagedNetworkHost(original, "$(bad)"));
  assert.throws(() => replaceManagedNetworkHost("[Service]\nExecStart=unrelated", "0.0.0.0"));
});

test("saving network access queues a nonblocking service restart and reports the effective listener separately", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "redrouter-network-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "red-router.service");
  const original = unit(dir);
  await writeFile(path, original);
  const env = {
    INVOCATION_ID: "fixture",
    PORT: "25101",
    API_PORT: "25102",
    RED_ROUTER_SERVER_HOST: "127.0.0.1",
    DATA_DIR: dir,
  };
  const calls: string[][] = [];
  let scheduled: (() => Promise<void>) | undefined;
  const options = {
    path,
    env,
    platform: "linux" as const,
    interfaces: {},
    execute: async (args: string[]) => {
      calls.push(args);
    },
    schedule: (action: () => Promise<void>) => {
      scheduled = action;
    },
  };
  const result = await applyNetworkAccess("lan", options);
  assert.equal(result.host, "127.0.0.1");
  assert.equal(result.configuredHost, "0.0.0.0");
  assert.equal(result.pendingRestart, true);
  assert.deepEqual(calls, [["--user", "daemon-reload"]]);
  await scheduled!();
  assert.deepEqual(calls[1], ["--user", "--no-block", "restart", "red-router.service"]);
  const started = await readNetworkAccessStatus({
    ...options,
    env: { ...env, RED_ROUTER_SERVER_HOST: "0.0.0.0" },
  });
  assert.equal(started.mode, "lan");
  assert.equal(started.pendingRestart, false);
  await applyNetworkAccess("local", {
    ...options,
    env: { ...env, RED_ROUTER_SERVER_HOST: "0.0.0.0" },
  });
  await scheduled!();
  assert.equal(await readFile(path, "utf8"), original);
});

test("a service-manager failure restores the original unit instead of reporting a successful change", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "redrouter-network-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "red-router.service");
  const original = unit(dir);
  await writeFile(path, original);
  const env = {
    INVOCATION_ID: "fixture",
    PORT: "25101",
    RED_ROUTER_SERVER_HOST: "127.0.0.1",
    DATA_DIR: dir,
  };
  await assert.rejects(
    applyNetworkAccess("lan", {
      path,
      env,
      platform: "linux",
      execute: async () => {
        throw new Error("private manager error at /path");
      },
    }),
    { code: "apply_failed" }
  );
  assert.equal(await readFile(path, "utf8"), original);
  let scheduled: (() => Promise<void>) | undefined;
  const options = {
    path,
    env,
    platform: "linux" as const,
    interfaces: {},
    execute: async (args: string[]) => {
      if (args.includes("restart")) throw new Error("private restart error");
    },
    schedule: (action: () => Promise<void>) => {
      scheduled = action;
    },
  };
  await applyNetworkAccess("lan", options);
  await scheduled!();
  assert.equal(await readFile(path, "utf8"), original);
  assert.match((await readNetworkAccessStatus(options)).restartError!, /rejected/);
});

test("an unmanaged process cannot rewrite another installed instance's listener", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "redrouter-network-unmanaged-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "red-router.service");
  const original = unit(dir);
  await writeFile(path, original);
  const options = {
    path,
    env: { INVOCATION_ID: "fixture", PORT: "25101", DATA_DIR: join(dir, "other") },
    platform: "linux" as const,
    execute: async () => {
      assert.fail("must not spawn");
    },
  };
  assert.equal((await readNetworkAccessStatus(options)).managed, false);
  await assert.rejects(applyNetworkAccess("lan", options), { code: "unsupported" });
  assert.equal(await readFile(path, "utf8"), original);
});

test("connection hints list private IPv4 interfaces without loopback or Docker bridges", () => {
  const entry = (address: string, internal = false) => ({
    address,
    internal,
    family: "IPv4" as const,
    netmask: "255.255.255.0",
    mac: "00:00:00:00:00:00",
    cidr: address + "/24",
  });
  assert.deepEqual(
    localNetworkAddresses({
      lo: [entry("127.0.0.1", true)],
      docker0: [entry("172.17.0.1")],
      wlan0: [entry("10.101.2.111"), entry("10.101.2.111")],
      eth0: [entry("192.168.1.2"), entry("203.0.113.2")],
    }),
    ["10.101.2.111", "192.168.1.2"]
  );
});
