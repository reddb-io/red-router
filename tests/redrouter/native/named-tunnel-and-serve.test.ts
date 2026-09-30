import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// Real database on a scratch install; real encryption; NO real processes. cloudflared is replaced
// at the runner's spawn seam and the Tailscale CLI at its execFile seam.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-named-tunnel-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-named-tunnel";
process.env.STORAGE_ENCRYPTION_KEY = "test-storage-encryption-key-for-named-tunnel";
process.env.API_PORT = "20128";
delete process.env.TUNNEL_TOKEN;

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { getSettings, updateSettings } = await import("../../../src/lib/db/settings.ts");
const { hashManagementPassword } = await import("../../../src/lib/auth/managementPassword.ts");
const { DASHBOARD_SESSION_COOKIE, getDashboardJwtSecret, mintDashboardSessionToken } = await import(
  "../../../src/shared/utils/dashboardSessionToken.ts"
);
const schemas = await import("../../../src/shared/validation/namedTunnelSchemas.ts");
const named = await import("../../../src/lib/cloudflaredNamedTunnel.ts");
const serve = await import("../../../src/lib/tailscaleServe.ts");
const namedRoute = await import("../../../src/app/api/tunnels/cloudflared-named/route.ts");
const namedConfigRoute = await import(
  "../../../src/app/api/tunnels/cloudflared-named/config/route.ts"
);
const serveRoute = await import("../../../src/app/api/tunnels/tailscale-serve/route.ts");
const settingsRoute = await import("../../../src/app/api/settings/route.ts");
const guard = await import("../../../src/server/authz/routeGuard.ts");
const { SPAWN_CAPABLE_PREFIXES } = await import(
  "../../../src/shared/constants/spawnCapablePrefixes.ts"
);
const presentation = await import(
  "../../../src/app/(dashboard)/dashboard/endpoint/components/tunnelPresentation.ts"
);

const PASSWORD = "correct horse battery staple 42";
const TOKEN =
  "eyJhIjoiMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYiLCJ0IjoiMTIzNDU2NzgtOTBhYi1jZGVmLTEyMzQtNTY3ODkwYWJjZGVmIiwicyI6InNlY3JldC1zZWNyZXQifQ==";
const HOSTNAME = "ai.example.com";

after(() => {
  named.setCloudflaredNamedTunnelRuntime(null);
  serve.setTailscaleServeRuntime(null);
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

async function cookie() {
  const token = await mintDashboardSessionToken(getDashboardJwtSecret());
  return `${DASHBOARD_SESSION_COOKIE}=${token}`;
}

async function call(
  handler: (request: Request) => Promise<Response>,
  url: string,
  method: string,
  body?: unknown,
  authenticated = true
) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (authenticated) headers.cookie = await cookie();
  const response = await handler(
    new Request(`http://localhost${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null };
}

// --- hostname / token validation --------------------------------------------------------------

test("hostname validation: accepts real domains, rejects everything else, normalises case", () => {
  const long = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}.com`;
  assert.ok(long.length > 253);
  const table: Array<[string, string | null]> = [
    ["foo.example.com", "foo.example.com"],
    ["  AI.Example.COM ", "ai.example.com"],
    ["a-b.c-d.example.co.uk", "a-b.c-d.example.co.uk"],
    ["xn--nxasmq6b.example.com", "xn--nxasmq6b.example.com"],
    ["https://foo.example.com", null],
    ["http://foo.example.com", null],
    ["foo.example.com/v1", null],
    ["foo.example.com?x=1", null],
    ["foo.example.com:8443", null],
    ["user@foo.example.com", null],
    ["*.example.com", null],
    ["foo.example.com.", null],
    ["foo example.com", null],
    ["localhost", null],
    ["api.localhost", null],
    ["127.0.0.1", null],
    ["10.0.0.5", null],
    ["192.168.1.1", null],
    ["[::1]", null],
    ["::1", null],
    ["2001:db8::1", null],
    ["-bad.example.com", null],
    ["bad-.example.com", null],
    ["bad_name.example.com", null],
    ["a..example.com", null],
    ["singlelabel", null],
    ["", null],
    ["   ", null],
    [long, null],
    [`${"a".repeat(64)}.example.com`, null],
  ];
  for (const [input, expected] of table) {
    const result = schemas.checkTunnelHostname(input);
    if (expected === null) assert.equal(result.ok, false, `should reject ${JSON.stringify(input).slice(0, 60)}`);
    else assert.deepEqual(result, { ok: true, hostname: expected }, input);
  }
  assert.equal(schemas.checkTunnelHostname(undefined).ok, false);
  assert.equal(schemas.checkTunnelHostname(12).ok, false);
});

test("hostname at exactly 253 characters is accepted, 254 is not", () => {
  const label = "a".repeat(63);
  const at253 = `${label}.${label}.${label}.${"b".repeat(61)}`; // 63*3 + 3 dots + 61 = 253
  assert.equal(at253.length, 253);
  assert.equal(schemas.checkTunnelHostname(at253).ok, true);
  assert.equal(schemas.checkTunnelHostname(`${at253}b`).ok, false);
});

test("token schema: accepts a pasted token or install command, rejects junk, hostname is normalised", () => {
  const ok = schemas.cloudflaredNamedTunnelConfigSchema.safeParse({
    token: `  cloudflared service install ${TOKEN}  `,
    hostname: "AI.Example.com",
  });
  assert.equal(ok.success, true);
  if (ok.success) {
    assert.equal(ok.data.token, TOKEN);
    assert.equal(ok.data.hostname, "ai.example.com");
  }
  for (const token of ["short", "!!!!!!!!!!!!!!!!!!!!!!!!!!", "x".repeat(5000), ""]) {
    assert.equal(
      schemas.cloudflaredNamedTunnelConfigSchema.safeParse({ token, hostname: HOSTNAME }).success,
      false,
      token.slice(0, 12)
    );
  }
  // Token optional (keep the stored one); unknown keys refused.
  assert.equal(
    schemas.cloudflaredNamedTunnelConfigSchema.safeParse({ hostname: HOSTNAME }).success,
    true
  );
  assert.equal(
    schemas.cloudflaredNamedTunnelConfigSchema.safeParse({ hostname: HOSTNAME, extra: 1 }).success,
    false
  );
});

// --- a fake cloudflared -----------------------------------------------------------------------

type SpawnCall = { command: string; args: string[]; options: { env?: NodeJS.ProcessEnv } };

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  kill(signal: string) {
    this.killed.push(signal);
    setImmediate(() => this.emit("exit", null, signal));
    return true;
  }
}

function installFakeCloudflared(script: (child: FakeChild) => void) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  named.setCloudflaredNamedTunnelRuntime({
    spawn: ((command: string, args: string[], options: SpawnCall["options"]) => {
      calls.push({ command, args: [...args], options });
      const child = new FakeChild();
      children.push(child);
      setImmediate(() => script(child));
      return child;
    }) as never,
    ensureBinary: async () => ({ binaryPath: "/fake/bin/cloudflared", source: "path", managed: false }),
    resolveBinary: async () => ({ binaryPath: "/fake/bin/cloudflared", source: "path", managed: false }),
    startTimeoutMs: 2000,
    stopTimeoutMs: 500,
  });
  return { calls, children };
}

const READY = "2026-09-29T10:00:00Z INF Registered tunnel connection connIndex=0 location=gru01";

const NAMED_URL = "/api/tunnels/cloudflared-named";
const CONFIG_URL = "/api/tunnels/cloudflared-named/config";

before(async () => {
  await updateSettings({
    requireLogin: true,
    password: await hashManagementPassword(PASSWORD),
  });
});

// --- routes: authentication -------------------------------------------------------------------

test("every new route answers 401 without a management session", async () => {
  const cases: Array<[typeof namedRoute.GET, string, string, unknown]> = [
    [namedRoute.GET, NAMED_URL, "GET", undefined],
    [namedRoute.POST, NAMED_URL, "POST", { action: "enable" }],
    [namedConfigRoute.PUT, CONFIG_URL, "PUT", { hostname: HOSTNAME, token: TOKEN }],
    [namedConfigRoute.DELETE, CONFIG_URL, "DELETE", undefined],
    [serveRoute.GET, "/api/tunnels/tailscale-serve", "GET", undefined],
    [serveRoute.POST, "/api/tunnels/tailscale-serve", "POST", { action: "enable" }],
  ];
  for (const [handler, url, method, body] of cases) {
    const result = await call(handler, url, method, body, false);
    assert.equal(result.status, 401, `${method} ${url}`);
  }
  // Nothing was stored or started by the rejected calls.
  assert.equal(
    getDbInstance()
      .prepare("SELECT COUNT(*) AS n FROM key_value WHERE key LIKE '\\_cloudflaredNamed%' ESCAPE '\\'")
      .get().n,
    0
  );
});

test("route guard: both prefixes are local-only, spawn-capable and have no GET exemption", () => {
  for (const prefix of ["/api/tunnels/cloudflared-named", "/api/tunnels/tailscale-serve"]) {
    assert.ok(guard.LOCAL_ONLY_API_PREFIXES.includes(prefix), `${prefix} listed as local-only`);
    assert.ok(SPAWN_CAPABLE_PREFIXES.includes(prefix), `${prefix} denied the manage-scope bypass`);
    assert.equal(guard.LOCAL_ONLY_API_GET_EXEMPTIONS.has(prefix), false);
    for (const method of ["GET", "HEAD", "POST", "PUT", "DELETE"]) {
      assert.equal(guard.isLocalOnlyPath(prefix, method), true, `${method} ${prefix}`);
    }
  }
  assert.equal(guard.isLocalOnlyPath("/api/tunnels/cloudflared-named/config", "PUT"), true);
  assert.equal(guard.isLocalOnlyPath("/api/tunnels/cloudflared-named/config", "GET"), true);
  // The quick-tunnel status exemption is not widened to the new routes.
  assert.equal(guard.isLocalOnlyPath("/api/tunnels/cloudflared", "GET"), false);
});

// --- Cloudflare Named Tunnel ------------------------------------------------------------------

test("named tunnel: enabling before configuration is a fixed 409 and starts nothing", async () => {
  const fake = installFakeCloudflared(() => {});
  const status = await call(namedRoute.GET, NAMED_URL, "GET");
  assert.equal(status.status, 200);
  assert.equal(status.json.phase, "not_configured");
  assert.equal(status.json.hasToken, false);
  assert.equal(status.json.configured, false);

  const enable = await call(namedRoute.POST, NAMED_URL, "POST", { action: "enable" });
  assert.equal(enable.status, 409);
  assert.equal(fake.calls.length, 0);
});

test("named tunnel: bad bodies are 400 and never echo what was sent", async () => {
  const secretish = "!!!!not-a-token-but-secret-looking!!!!";
  const cases: unknown[] = [
    { hostname: "https://ai.example.com", token: TOKEN },
    { hostname: "10.0.0.1", token: TOKEN },
    { hostname: HOSTNAME, token: secretish },
    { hostname: HOSTNAME, token: TOKEN, extra: true },
    { token: TOKEN },
  ];
  for (const body of cases) {
    const result = await call(namedConfigRoute.PUT, CONFIG_URL, "PUT", body);
    assert.equal(result.status, 400, JSON.stringify(body).slice(0, 60));
    assert.ok(!result.text.includes(secretish));
    assert.ok(!result.text.includes(TOKEN));
  }
  const bad = await call(namedRoute.POST, NAMED_URL, "POST", { action: "explode" });
  assert.equal(bad.status, 400);
  const notJson = await namedRoute.POST(
    new Request(`http://localhost${NAMED_URL}`, {
      method: "POST",
      headers: { cookie: await cookie(), "content-type": "application/json" },
      body: "{oops",
    })
  );
  assert.equal(notJson.status, 400);
  // A first save without any token is refused (nothing stored to keep).
  const noToken = await call(namedConfigRoute.PUT, CONFIG_URL, "PUT", { hostname: HOSTNAME });
  assert.equal(noToken.status, 400);
});

test("named tunnel: the token is stored encrypted and appears in no GET, status or settings output", async () => {
  const saved = await call(namedConfigRoute.PUT, CONFIG_URL, "PUT", {
    token: TOKEN,
    hostname: "AI.Example.com",
  });
  assert.equal(saved.status, 200);
  assert.ok(!saved.text.includes(TOKEN));
  assert.equal(saved.json.status.hasToken, true);
  assert.equal(saved.json.status.hostname, HOSTNAME);
  assert.equal(saved.json.status.configured, true);
  assert.equal(saved.json.status.phase, "stopped");
  assert.ok(!("token" in saved.json.status));

  // At rest: ciphertext only.
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = '_cloudflaredNamedTunnelToken'")
    .get() as { value: string };
  const stored = JSON.parse(row.value) as string;
  assert.ok(stored.startsWith("enc:v1:"), "token is encrypted at rest");
  assert.ok(!row.value.includes(TOKEN));
  const raw = readFileSync(join(dataDir, "storage.sqlite"), "latin1");
  assert.ok(!raw.includes(TOKEN), "token is not in the database file");

  // Every read path.
  const statusGet = await call(namedRoute.GET, NAMED_URL, "GET");
  assert.ok(!statusGet.text.includes(TOKEN));
  assert.equal(statusGet.json.hasToken, true);
  const settings = await getSettings();
  assert.ok(!JSON.stringify(settings).includes(TOKEN));
  assert.ok(!Object.keys(settings).some((key) => key.startsWith("_cloudflaredNamed")));
  const settingsGet = await settingsRoute.GET(
    new Request("http://localhost/api/settings", { headers: { cookie: await cookie() } })
  );
  assert.ok(!(await settingsGet.text()).includes(TOKEN));
});

test("named tunnel: cloudflared gets the token in its environment, never in argv", async () => {
  const fake = installFakeCloudflared((child) => child.stderr.emit("data", Buffer.from(READY)));
  const enable = await call(namedRoute.POST, NAMED_URL, "POST", { action: "enable" });
  assert.equal(enable.status, 200, enable.text);
  assert.ok(!enable.text.includes(TOKEN));

  assert.equal(fake.calls.length, 1);
  const [spawnCall] = fake.calls;
  assert.equal(spawnCall.command, "/fake/bin/cloudflared");
  assert.deepEqual(spawnCall.args, ["tunnel", "--no-autoupdate", "run"]);
  assert.ok(!spawnCall.args.join(" ").includes(TOKEN), "token must not be in argv");
  assert.ok(!spawnCall.args.some((arg) => arg.includes("--token")));
  assert.equal(spawnCall.options.env?.TUNNEL_TOKEN, TOKEN, "token is passed via TUNNEL_TOKEN");
  // The child env is the allow-listed one: the server's own secrets do not leak into it.
  assert.equal(spawnCall.options.env?.JWT_SECRET, undefined);
  assert.equal(spawnCall.options.env?.STORAGE_ENCRYPTION_KEY, undefined);
  assert.equal(process.env.TUNNEL_TOKEN, undefined, "the server's own env is untouched");

  assert.equal(enable.json.success, true);
  assert.equal(enable.json.status.running, true);
  assert.equal(enable.json.status.phase, "running");
  assert.equal(enable.json.status.publicUrl, `https://${HOSTNAME}`);
  assert.equal(enable.json.status.apiUrl, `https://${HOSTNAME}/v1`);
  assert.equal(enable.json.status.pid, 4242);

  // GET reflects the running state and still carries no token.
  const status = await call(namedRoute.GET, NAMED_URL, "GET");
  assert.equal(status.json.phase, "running");
  assert.ok(!status.text.includes(TOKEN));
});

test("named tunnel: pure helpers build the exact args and env", () => {
  assert.deepEqual(named.getCloudflaredNamedTunnelArgs(), ["tunnel", "--no-autoupdate", "run"]);
  const env = named.buildCloudflaredNamedTunnelEnv("tok-123");
  assert.equal(env.TUNNEL_TOKEN, "tok-123");
  assert.equal(env.JWT_SECRET, undefined);
  assert.equal(named.redactNamedTunnelText(`bad token ${TOKEN} here`, TOKEN).includes(TOKEN), false);
  assert.equal(named.redactNamedTunnelText("x".repeat(80)).includes("x".repeat(80)), false);
  assert.ok(!named.redactNamedTunnelText("open /home/alice/.cloudflared/cert.pem").includes("alice"));
});

test("named tunnel: enable/restart/disable transitions and the exposure notice inputs", async () => {
  // Already running from the previous test: disable stops the child (SIGTERM) and reports stopped.
  const before = await call(namedRoute.GET, NAMED_URL, "GET");
  assert.equal(before.json.running, true);

  const disable = await call(namedRoute.POST, NAMED_URL, "POST", { action: "disable" });
  assert.equal(disable.status, 200);
  assert.equal(disable.json.status.running, false);
  assert.equal(disable.json.status.phase, "stopped");
  assert.equal(disable.json.status.publicUrl, null);
  assert.equal(disable.json.status.pid, null);

  const fake = installFakeCloudflared((child) => child.stdout.emit("data", Buffer.from(READY)));
  const enable = await call(namedRoute.POST, NAMED_URL, "POST", { action: "enable" });
  assert.equal(enable.json.status.phase, "running");
  const restart = await call(namedRoute.POST, NAMED_URL, "POST", { action: "restart" });
  assert.equal(restart.status, 200, restart.text);
  assert.equal(restart.json.status.phase, "running");
  assert.equal(fake.calls.length, 2, "restart spawned a fresh process");
  assert.deepEqual(fake.children[0].killed, ["SIGTERM"], "the old process was stopped first");

  // The notice is driven by REQUIRE_API_KEY, which the status reports.
  assert.equal(typeof restart.json.status.requireApiKey, "boolean");
  assert.equal(presentation.namedTunnelExposureNotice(true).tone, "info");
  assert.match(presentation.namedTunnelExposureNotice(true).message, /API key/);
  assert.equal(presentation.namedTunnelExposureNotice(false).tone, "warning");
  assert.match(presentation.namedTunnelExposureNotice(false).message, /Require API Key is off/);

  await call(namedRoute.POST, NAMED_URL, "POST", { action: "disable" });
});

test("named tunnel: cloudflared failures never leak the token to the response, status or log", async () => {
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
  };
  try {
    installFakeCloudflared((child) => {
      child.stderr.emit(
        "data",
        Buffer.from(`2026-09-29T10:00:00Z ERR failed to authenticate: token ${TOKEN} rejected at /home/alice/.cloudflared/x`)
      );
      setImmediate(() => child.emit("exit", 1, null));
    });
    const enable = await call(namedRoute.POST, NAMED_URL, "POST", { action: "enable" });
    assert.equal(enable.status, 500);
    assert.equal(enable.json.error.message, "Failed to update the Cloudflare Named Tunnel.");
    assert.ok(!enable.text.includes(TOKEN));

    const status = await call(namedRoute.GET, NAMED_URL, "GET");
    assert.equal(status.json.phase, "error");
    assert.ok(status.json.lastError, "an actionable error is shown");
    assert.ok(!status.text.includes(TOKEN));
    assert.ok(!status.text.includes("alice"), "host paths are stripped from the error");
  } finally {
    console.error = originalError;
  }
  assert.ok(logged.length > 0);
  assert.ok(!logged.join("\n").includes(TOKEN), "the server log is redacted too");
});

test("named tunnel: changing only the hostname keeps the stored token; DELETE removes everything", async () => {
  named.setCloudflaredNamedTunnelRuntime({
    ensureBinary: async () => ({ binaryPath: "/fake/bin/cloudflared", source: "path", managed: false }),
    resolveBinary: async () => ({ binaryPath: "/fake/bin/cloudflared", source: "path", managed: false }),
  });
  const renamed = await call(namedConfigRoute.PUT, CONFIG_URL, "PUT", { hostname: "api.example.org" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.json.status.hostname, "api.example.org");
  assert.equal(renamed.json.status.hasToken, true);

  const removed = await call(namedConfigRoute.DELETE, CONFIG_URL, "DELETE");
  assert.equal(removed.status, 200);
  assert.equal(removed.json.status.hasToken, false);
  assert.equal(removed.json.status.hostname, null);
  assert.equal(removed.json.status.phase, "not_configured");
  assert.equal(
    getDbInstance()
      .prepare("SELECT COUNT(*) AS n FROM key_value WHERE key LIKE '\\_cloudflaredNamed%' ESCAPE '\\'")
      .get().n,
    0
  );
});

// --- Tailscale Serve --------------------------------------------------------------------------

const SOCKET = ["--socket", "/var/run/tailscale/tailscaled.sock"];
const TARGET = "http://127.0.0.1:20128";

type ServeWorld = {
  serving: boolean;
  funnel: boolean;
  loggedIn: boolean;
  serveEnableError: (Error & { stdout?: string; stderr?: string }) | null;
  binary: string | null;
  runs: string[][];
  daemonStarts: number;
};

function installFakeTailscale(world: Partial<ServeWorld> = {}): ServeWorld {
  const state: ServeWorld = {
    serving: false,
    funnel: false,
    loggedIn: true,
    serveEnableError: null,
    binary: "/usr/bin/tailscale",
    runs: [],
    daemonStarts: 0,
    ...world,
  };
  serve.setTailscaleServeRuntime({
    resolveBinary: async () => ({ binaryPath: state.binary }),
    socketArgs: async () => SOCKET,
    startDaemon: async () => {
      state.daemonStarts += 1;
      return { started: false };
    },
    startLogin: async () => ({ authUrl: "https://login.tailscale.com/a/abc123" }),
    run: async (_binary, args) => {
      state.runs.push(args);
      const rest = args.slice(SOCKET.length);
      const key = rest.join(" ");
      if (key === "status --json") {
        return {
          stdout: JSON.stringify({
            BackendState: state.loggedIn ? "Running" : "NeedsLogin",
            Self: { DNSName: "box.tail1234.ts.net." },
          }),
          stderr: "",
        };
      }
      if (key === "serve status --json") {
        return {
          stdout: JSON.stringify(
            state.serving
              ? {
                  TCP: { "443": { HTTPS: true } },
                  Web: { "box.tail1234.ts.net:443": { Handlers: { "/": { Proxy: TARGET } } } },
                  ...(state.funnel ? { AllowFunnel: { "box.tail1234.ts.net:443": true } } : {}),
                }
              : {}
          ),
          stderr: "",
        };
      }
      if (key === `serve --bg --https=443 ${TARGET}`) {
        if (state.serveEnableError) throw state.serveEnableError;
        state.serving = true;
        return { stdout: "", stderr: "" };
      }
      if (key === "serve --https=443 off") {
        state.serving = false;
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected tailscale command: ${key}`);
    },
  });
  return state;
}

const SERVE_URL = "/api/tunnels/tailscale-serve";

test("tailscale serve: command lines are exact", () => {
  assert.deepEqual(serve.buildServeEnableArgs(20128), [
    "serve",
    "--bg",
    "--https=443",
    "http://127.0.0.1:20128",
  ]);
  assert.deepEqual(serve.buildServeDisableArgs(), ["serve", "--https=443", "off"]);
  assert.deepEqual(serve.buildServeStatusArgs(), ["serve", "status", "--json"]);
  assert.equal(serve.getServeTarget(8080), "http://127.0.0.1:8080");
});

test("tailscale serve: config analysis tells private serving from Funnel exposure", () => {
  const web = { "h.ts.net:443": { Handlers: { "/": { Proxy: "http://localhost:20128" } } } };
  assert.deepEqual(serve.analyzeServeConfig({ Web: web }, 20128), { serving: true, publicExposure: false });
  assert.deepEqual(
    serve.analyzeServeConfig({ Web: web, AllowFunnel: { "h.ts.net:443": true } }, 20128),
    { serving: true, publicExposure: true }
  );
  assert.deepEqual(serve.analyzeServeConfig({ Web: web }, 3000), { serving: false, publicExposure: false });
  assert.deepEqual(serve.analyzeServeConfig(null, 20128), { serving: false, publicExposure: false });
});

test("tailscale serve: enable runs exactly the serve command and reports the private tailnet URL", async () => {
  const world = installFakeTailscale();
  const result = await call(serveRoute.POST, SERVE_URL, "POST", { action: "enable" });
  assert.equal(result.status, 200, result.text);
  assert.equal(result.json.success, true);
  assert.equal(result.json.tunnelUrl, "https://box.tail1234.ts.net");
  assert.equal(result.json.apiUrl, "https://box.tail1234.ts.net/v1");
  assert.equal(result.json.status.phase, "running");
  assert.equal(result.json.status.publicExposure, false);
  assert.equal(world.daemonStarts, 1);

  const serveCommands = world.runs.filter((args) => args[SOCKET.length] === "serve" && args[SOCKET.length + 1] !== "status");
  assert.deepEqual(serveCommands, [[...SOCKET, "serve", "--bg", "--https=443", TARGET]]);
  // Funnel-only verbs are never used and Serve never resets the whole config.
  assert.ok(!world.runs.some((args) => args.includes("funnel") || args.includes("reset")));

  const status = await call(serveRoute.GET, SERVE_URL, "GET");
  assert.equal(status.json.running, true);
  assert.equal(status.json.tunnelUrl, "https://box.tail1234.ts.net");
});

test("tailscale serve: disable removes only this mapping and never stops the daemon", async () => {
  const world = installFakeTailscale({ serving: true });
  const result = await call(serveRoute.POST, SERVE_URL, "POST", { action: "disable" });
  assert.equal(result.status, 200);
  assert.equal(result.json.success, true);
  assert.equal(result.json.status.running, false);
  assert.equal(result.json.status.phase, "stopped");
  assert.equal(result.json.status.tunnelUrl, null);
  assert.deepEqual(world.runs.filter((args) => args.includes("off")), [
    [...SOCKET, "serve", "--https=443", "off"],
  ]);
  assert.ok(!world.runs.some((args) => args.includes("reset")));
  assert.equal(world.daemonStarts, 0);
});

test("tailscale serve: refuses to call a Funnel-published port private", async () => {
  const world = installFakeTailscale({ serving: true, funnel: true });
  const status = await call(serveRoute.GET, SERVE_URL, "GET");
  assert.equal(status.json.running, false, "publicly exposed is not 'private and running'");
  assert.equal(status.json.publicExposure, true);
  assert.equal(status.json.phase, "error");
  assert.equal(status.json.tunnelUrl, null);

  const enable = await call(serveRoute.POST, SERVE_URL, "POST", { action: "enable" });
  assert.equal(enable.json.funnelActive, true);
  assert.equal(enable.json.success, false);
  assert.ok(!world.runs.some((args) => args.includes("--bg")), "no serve command was issued");
});

test("tailscale serve: needs-login and not-enabled-on-tailnet are structured results, not errors", async () => {
  installFakeTailscale({ loggedIn: false });
  const login = await call(serveRoute.POST, SERVE_URL, "POST", { action: "enable" });
  assert.equal(login.status, 200);
  assert.equal(login.json.needsLogin, true);
  assert.equal(login.json.authUrl, "https://login.tailscale.com/a/abc123");

  const timeout = Object.assign(new Error("Command failed"), {
    stdout: "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n\thttps://login.tailscale.com/f/serve?node=n123\n",
    stderr: "",
  });
  installFakeTailscale({ serveEnableError: timeout });
  const notEnabled = await call(serveRoute.POST, SERVE_URL, "POST", { action: "enable" });
  assert.equal(notEnabled.status, 200);
  assert.equal(notEnabled.json.serveNotEnabled, true);
  assert.equal(notEnabled.json.enableUrl, "https://login.tailscale.com/f/serve?node=n123");
});

test("tailscale serve: not installed is a fixed 409; failures are fixed 500s that leak nothing", async () => {
  installFakeTailscale({ binary: null });
  const status = await call(serveRoute.GET, SERVE_URL, "GET");
  assert.equal(status.json.phase, "not_installed");
  assert.equal(status.json.installed, false);
  const missing = await call(serveRoute.POST, SERVE_URL, "POST", { action: "enable" });
  assert.equal(missing.status, 409);

  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
  try {
    installFakeTailscale({
      serveEnableError: Object.assign(new Error("spawn /home/alice/bin/tailscale ENOENT tskey-auth-kMn3Qz7RtY-9fVbXsPq2LdWc"), {
        stdout: "",
        stderr: "",
      }),
    });
    const failed = await call(serveRoute.POST, SERVE_URL, "POST", {
      action: "enable",
      sudoPassword: "hunter2-sudo",
    });
    assert.equal(failed.status, 500);
    assert.equal(failed.json.error.message, "Failed to enable Tailscale Serve.");
    assert.ok(!failed.text.includes("alice"));
    assert.ok(!failed.text.includes("tskey-"));
    assert.ok(!failed.text.includes("hunter2-sudo"));
  } finally {
    console.error = originalError;
  }
  assert.ok(!logged.join("\n").includes("hunter2-sudo"));

  const invalid = await call(serveRoute.POST, SERVE_URL, "POST", { action: "reset" });
  assert.equal(invalid.status, 400);
  const extra = await call(serveRoute.POST, SERVE_URL, "POST", { action: "enable", port: 1 });
  assert.equal(extra.status, 400);
});

// --- the Tunnels card -------------------------------------------------------------------------

test("card counter counts the new tunnels and skips hidden ones", () => {
  const base = [
    { visible: true, active: false }, // quick tunnel
    { visible: true, active: false }, // funnel
    { visible: true, active: false }, // ngrok
  ];
  assert.deepEqual(presentation.countTunnels(base), { active: 0, total: 3 });
  assert.deepEqual(
    presentation.countTunnels([...base, { visible: true, active: false }, { visible: true, active: false }]),
    { active: 0, total: 5 }
  );
  assert.deepEqual(
    presentation.countTunnels([
      { visible: true, active: true },
      { visible: false, active: true }, // hidden in settings: counts for neither
      { visible: true, active: false },
      { visible: true, active: true }, // named tunnel
      { visible: true, active: true }, // tailscale serve
    ]),
    { active: 3, total: 4 }
  );
  assert.deepEqual(presentation.countTunnels([]), { active: 0, total: 0 });
});

test("card rows: primary action and status pills follow the status", () => {
  assert.equal(presentation.namedTunnelPrimaryAction(null), "set-up");
  assert.equal(
    presentation.namedTunnelPrimaryAction({ configured: false, running: false, phase: "not_configured" }),
    "set-up"
  );
  assert.equal(
    presentation.namedTunnelPrimaryAction({ configured: true, running: false, phase: "stopped" }),
    "enable"
  );
  assert.equal(
    presentation.namedTunnelPrimaryAction({ configured: true, running: false, phase: "starting" }),
    "stop"
  );
  assert.equal(
    presentation.namedTunnelPrimaryAction({ configured: true, running: true, phase: "running" }),
    "stop"
  );
  assert.equal(presentation.servePrimaryAction(null), "install");
  assert.equal(presentation.servePrimaryAction({ installed: false, running: false }), "install");
  assert.equal(presentation.servePrimaryAction({ installed: true, running: false }), "enable");
  assert.equal(presentation.servePrimaryAction({ installed: true, running: true }), "stop");
  assert.equal(presentation.NAMED_TUNNEL_PILLS.running.tone, "success");
  assert.equal(presentation.NAMED_TUNNEL_PILLS.error.tone, "danger");
  assert.equal(presentation.SERVE_PILLS.needs_login.tone, "info");
});

test("Endpoint page: groups Private/Public, mounts both rows, counts them; new UI stays on the DS", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
  const page = read("src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.tsx");
  assert.ok(page.includes("<TailscaleServeRow"));
  assert.ok(page.includes("<CloudflaredNamedTunnelRow"));
  assert.ok(page.includes('kind="private"') && page.includes('kind="public"'));
  assert.ok(page.includes("countTunnels("));

  const extras = read("src/app/(dashboard)/dashboard/endpoint/components/TunnelExtras.tsx");
  assert.ok(!extras.includes("material-symbols-outlined"), "no Material Symbols in new code");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(extras), "no hex colours");
  assert.ok(
    !/\b(?:text|bg|border)-(?:red|green|blue|amber|orange|yellow|emerald|sky|slate|gray|zinc)-\d{2,3}\b/.test(extras),
    "no raw palette colours"
  );
  assert.ok(extras.includes('type="password"'), "the token input is a password field");
  assert.ok(extras.includes("Private — only devices on your tailnet"));
  assert.ok(extras.includes("<Modal"));
});
