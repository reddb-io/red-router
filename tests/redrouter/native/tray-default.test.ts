import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const lock = await import("../../../bin/cli/tray/singleInstance.mjs");
const attached = await import("../../../bin/cli/tray/attachedTray.mjs");

const dir = mkdtempSync(join(tmpdir(), "redrouter-tray-lock-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const LOCK = join(dir, "tray.lock.json");
const alive = new Set<number>();
const isAlive = (pid: number) => alive.has(pid);

test("the first tray takes the lock, and a second of the same version does not start another icon", () => {
  alive.clear();
  const first = lock.claimTrayLock({
    path: LOCK,
    port: 25050,
    version: "1.0.0",
    pid: 111,
    isAlive,
  });
  assert.equal(first.claimed, true);
  alive.add(111);
  const second = lock.claimTrayLock({
    path: LOCK,
    port: 25050,
    version: "1.0.0",
    pid: 222,
    isAlive,
  });
  assert.deepEqual([second.claimed, second.reason, second.pid], [false, "already-running", 111]);
});

test("a tray of a newer version replaces the old one: this is what fixes the stale icon after an upgrade", () => {
  alive.clear();
  lock.claimTrayLock({ path: LOCK, port: 25050, version: "0.35.1", pid: 111, isAlive });
  alive.add(111);
  const stopped: number[] = [];
  const next = lock.claimTrayLock({
    path: LOCK,
    port: 25050,
    version: "0.53.0",
    pid: 222,
    isAlive,
    terminate: (pid: number) => stopped.push(pid),
  });
  assert.equal(next.claimed, true);
  assert.deepEqual(stopped, [111]);
  assert.equal(JSON.parse(readFileSync(LOCK, "utf8")).version, "0.53.0");
});

test("--replace takes over even a tray of the same version; a different port also replaces", () => {
  alive.clear();
  lock.claimTrayLock({ path: LOCK, port: 25050, version: "1.0.0", pid: 111, isAlive });
  alive.add(111);
  const stopped: number[] = [];
  const terminate = (pid: number) => stopped.push(pid);
  assert.equal(
    lock.claimTrayLock({
      path: LOCK,
      port: 25050,
      version: "1.0.0",
      pid: 222,
      isAlive,
      replace: true,
      terminate,
    }).claimed,
    true
  );
  alive.add(222);
  assert.equal(
    lock.claimTrayLock({ path: LOCK, port: 20128, version: "1.0.0", pid: 333, isAlive, terminate })
      .claimed,
    true
  );
  assert.deepEqual(stopped, [111, 222]);
});

test("a dead tray's lock is ignored, and a lock is released only by its owner", () => {
  alive.clear();
  writeFileSync(LOCK, JSON.stringify({ pid: 999, port: 25050, version: "1.0.0" }));
  assert.equal(lock.readTrayLock(LOCK, isAlive), null, "pid 999 is not alive");
  assert.equal(
    lock.claimTrayLock({ path: LOCK, port: 25050, version: "1.0.0", pid: 444, isAlive }).claimed,
    true
  );
  lock.releaseTrayLock(LOCK, 555);
  assert.equal(
    JSON.parse(readFileSync(LOCK, "utf8")).pid,
    444,
    "someone else's release does nothing"
  );
  lock.releaseTrayLock(LOCK, 444);
  assert.equal(
    lock.readTrayLock(LOCK, () => true),
    null
  );
});

const interactiveDesktop = {
  stdoutIsTTY: true,
  stdinIsTTY: true,
  platform: "linux",
  env: { DISPLAY: ":0" },
};

test("the tray is on by default for a person at a terminal on a desktop", () => {
  assert.equal(attached.shouldAutoAttachTray({ opts: {}, ...interactiveDesktop }), true);
  assert.equal(
    attached.shouldAutoAttachTray({
      opts: {},
      ...interactiveDesktop,
      env: { WAYLAND_DISPLAY: "wayland-0" },
    }),
    true
  );
  assert.equal(
    attached.shouldAutoAttachTray({ opts: {}, ...interactiveDesktop, platform: "darwin", env: {} }),
    true
  );
});

test("and off when it must be: opt-outs, services, CI, pipes, headless, and the modes that own a tray", () => {
  const off = (over: Record<string, unknown>) =>
    attached.shouldAutoAttachTray({ opts: {}, ...interactiveDesktop, ...over } as never);
  assert.equal(off({ opts: { tray: false } }), false, "--no-tray");
  assert.equal(off({ opts: { tray: true } }), false, "--tray has its own flow");
  assert.equal(off({ env: { DISPLAY: ":0", RED_ROUTER_TRAY: "0" } }), false, "env opt-out");
  assert.equal(off({ env: { DISPLAY: ":0", CI: "true" } }), false, "CI");
  assert.equal(off({ env: { DISPLAY: ":0", INVOCATION_ID: "abc" } }), false, "systemd service");
  assert.equal(off({ stdoutIsTTY: false }), false, "output piped");
  assert.equal(off({ stdinIsTTY: false }), false, "input piped");
  assert.equal(off({ env: {} }), false, "no display on Linux");
  assert.equal(off({ opts: { daemon: true } }), false);
  assert.equal(off({ opts: { log: true } }), false);
  assert.equal(off({ opts: { recovery: false } }), false);
  assert.equal(off({ opts: { trayWorker: true } }), false);
});

test("the tray process is started detached, with --replace only when asked", () => {
  const calls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
  const spawnImpl = (_cmd: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ args, options });
    return { pid: 4242, unref() {} };
  };
  assert.equal(
    attached.spawnAttachedTray({
      cliPath: "/x/omniroute.mjs",
      port: 25050,
      spawnImpl: spawnImpl as never,
    }),
    4242
  );
  attached.spawnAttachedTray({
    cliPath: "/x/omniroute.mjs",
    port: 25050,
    replace: true,
    spawnImpl: spawnImpl as never,
  });
  assert.deepEqual(calls[0].args, ["/x/omniroute.mjs", "tray", "attach", "--port", "25050"]);
  assert.deepEqual(calls[1].args.slice(-1), ["--replace"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
});

test("installing or upgrading the service puts the new tray on screen, replacing an old one", async () => {
  const { installService } = await import("../../../bin/cli/service.mjs");
  assert.equal(typeof installService, "function");
  const source = readFileSync(join(process.cwd(), "bin/cli/service.mjs"), "utf8");
  assert.match(source, /installLinuxTrayService\(/);
  assert.match(source, /replace: true/);
  const serve = readFileSync(join(process.cwd(), "bin/cli/commands/serve.mjs"), "utf8");
  assert.match(serve, /shouldAutoAttachTray\(\{ opts: trayOpts \}\)/);
});

test("a tray that cannot appear never takes over a working one", async () => {
  const source = readFileSync(join(process.cwd(), "bin/cli/commands/tray.mjs"), "utf8");
  const supported = source.indexOf("isTraySupported()");
  const claim = source.indexOf("claimTrayLock({ port, replace })");
  assert.ok(
    supported > 0 && claim > supported,
    "the display check comes before the lock is claimed"
  );
});
