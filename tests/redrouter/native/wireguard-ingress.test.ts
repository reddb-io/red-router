import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// Real database on a scratch install and real encryption. Nothing here runs wg, wg-quick or ip,
// and no interface is created: the interface list is faked at the status seam.
const dataDir = mkdtempSync(join(tmpdir(), "redrouter-wireguard-"));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = "test-jwt-secret-for-wireguard";
process.env.STORAGE_ENCRYPTION_KEY = "test-storage-encryption-key-for-wireguard";
for (const name of [
  "API_PORT",
  "DASHBOARD_PORT",
  "OMNIROUTE_PORT",
  "API_HOST",
  "RED_ROUTER_SERVER_HOST",
  "OMNIROUTE_SERVER_HOST",
  "HOSTNAME",
]) {
  delete process.env[name];
}
process.env.PORT = "20128";

const { getDbInstance, resetDbInstance } = await import("../../../src/lib/db/core.ts");
const { updateSettings } = await import("../../../src/lib/db/settings.ts");
const { hashManagementPassword } = await import("../../../src/lib/auth/managementPassword.ts");
const { DASHBOARD_SESSION_COOKIE, getDashboardJwtSecret, mintDashboardSessionToken } = await import(
  "../../../src/shared/utils/dashboardSessionToken.ts"
);
const overviewRoute = await import("../../../src/app/api/tunnels/wireguard/route.ts");
const configRoute = await import("../../../src/app/api/tunnels/wireguard/config/route.ts");
const peersRoute = await import("../../../src/app/api/tunnels/wireguard/peers/route.ts");
const peerRoute = await import("../../../src/app/api/tunnels/wireguard/peers/[id]/route.ts");
const serverConfRoute = await import("../../../src/app/api/tunnels/wireguard/server-conf/route.ts");
const settingsRoute = await import("../../../src/app/api/settings/route.ts");
const guard = await import("../../../src/server/authz/routeGuard.ts");
const { SPAWN_CAPABLE_PREFIXES } = await import("../../../src/shared/constants/spawnCapablePrefixes.ts");
const status = await import("../../../src/lib/wireguard/status.ts");
const keys = await import("../../../src/lib/wireguard/keys.ts");
const store = await import("../../../src/lib/db/wireguardServerConfig.ts");
const presentation = await import(
  "../../../src/app/(dashboard)/dashboard/endpoint/components/tunnelPresentation.ts"
);

const PASSWORD = "correct horse battery staple 42";
const BASE = "/api/tunnels/wireguard";

after(() => {
  status.setWireGuardStatusRuntime(null);
  resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

before(async () => {
  await updateSettings({ requireLogin: true, password: await hashManagementPassword(PASSWORD) });
});

async function cookie() {
  const token = await mintDashboardSessionToken(getDashboardJwtSecret());
  return `${DASHBOARD_SESSION_COOKIE}=${token}`;
}

// Response bodies are read loosely on purpose: assertions dig into them by path.
type Body = Record<string, ReturnType<typeof JSON.parse>>;

async function call(
  handler: (request: Request, context?: never) => Promise<Response>,
  url: string,
  method: string,
  body?: unknown,
  options: { authenticated?: boolean; context?: unknown } = {}
) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (options.authenticated !== false) headers.cookie = await cookie();
  const response = await (handler as (r: Request, c?: unknown) => Promise<Response>)(
    new Request(`http://localhost${url}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    options.context
  );
  const text = await response.text();
  let json: Body | null = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, text, json, headers: response.headers };
}

const peerContext = (id: string) => ({ params: Promise.resolve({ id }) });

function rawValue(key: string): string | null {
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = 'settings' AND key = ?")
    .get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

/** Every value of every table, as text: the haystack for "this secret was never persisted". */
function dumpDatabase(): string {
  const db = getDbInstance();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  const parts: string[] = [];
  for (const { name } of tables) {
    parts.push(JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()));
  }
  return parts.join("\n");
}

function auditActions(): string[] {
  return (
    getDbInstance().prepare("SELECT action FROM audit_log ORDER BY id").all() as Array<{ action: string }>
  ).map((row) => row.action);
}

function conf(text: string, key: string, section?: "Interface" | "Peer"): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const header = /^\[(Interface|Peer)\]$/.exec(line);
    if (header) current = header[1];
    const pair = /^([A-Za-z]+) = (.*)$/.exec(line);
    if (pair && pair[1] === key && (!section || section === current)) out.push(pair[2]);
  }
  return out;
}

// --- authentication and classification ----------------------------------------------------------

test("every WireGuard route answers 401 without a management session and stores nothing", async () => {
  const cases: Array<[Parameters<typeof call>[0], string, string, unknown, unknown?]> = [
    [overviewRoute.GET, BASE, "GET", undefined],
    [overviewRoute.POST, BASE, "POST", { action: "rotate-server-key", currentPassword: PASSWORD }],
    [configRoute.PUT, `${BASE}/config`, "PUT", { endpointHost: "vpn.example.com" }],
    [peersRoute.POST, `${BASE}/peers`, "POST", { name: "Phone" }],
    [peerRoute.DELETE, `${BASE}/peers/peer_x`, "DELETE", undefined, peerContext("peer_x")],
    [serverConfRoute.GET, `${BASE}/server-conf`, "GET", undefined],
  ];
  for (const [handler, url, method, body, context] of cases) {
    const result = await call(handler, url, method, body, { authenticated: false, context });
    assert.equal(result.status, 401, `${method} ${url}`);
  }
  assert.equal(
    (
      getDbInstance()
        .prepare("SELECT COUNT(*) AS n FROM key_value WHERE key LIKE '\\_wireguard%' ESCAPE '\\'")
        .get() as { n: number }
    ).n,
    0
  );
});

test("route guard: the prefix is local-only for every method and path, and can never be whitelisted for manage-scope bypass", () => {
  assert.ok(guard.LOCAL_ONLY_API_PREFIXES.includes(BASE));
  assert.equal(guard.LOCAL_ONLY_API_GET_EXEMPTIONS.has(BASE), false, "no read exemption");
  assert.equal(
    SPAWN_CAPABLE_PREFIXES.includes(BASE),
    true,
    "it hands out the server private key, so the bypass deny-list covers it even though it spawns nothing"
  );
  for (const path of [BASE, `${BASE}/config`, `${BASE}/peers`, `${BASE}/peers/peer_x`, `${BASE}/server-conf`]) {
    for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PUT", "DELETE"]) {
      assert.equal(guard.isLocalOnlyPath(path, method), true, `${method} ${path}`);
    }
  }
  // Siblings are unaffected.
  assert.equal(guard.isLocalOnlyPath("/api/tunnels/ngrok", "GET"), false);
});

// --- before configuration -----------------------------------------------------------------------

test("before the first save: not configured, peers and downloads are refused with fixed 409s", async () => {
  const overview = await call(overviewRoute.GET, BASE, "GET");
  assert.equal(overview.status, 200);
  assert.equal(overview.json.config, null);
  assert.equal(overview.json.status.state, "not_configured");
  assert.equal(overview.headers.get("cache-control"), "no-store");

  const add = await call(peersRoute.POST, `${BASE}/peers`, "POST", { name: "Phone" });
  assert.equal(add.status, 409);
  const download = await call(serverConfRoute.GET, `${BASE}/server-conf`, "GET");
  assert.equal(download.status, 409);
  assert.ok(!download.text.includes("PrivateKey"));
  const rotate = await call(overviewRoute.POST, BASE, "POST", {
    action: "rotate-server-key",
    currentPassword: PASSWORD,
  });
  assert.equal(rotate.status, 409);
});

test("config validation: bad bodies are fixed 400s and nothing is stored", async () => {
  const bodies: unknown[] = [
    {},
    { endpointHost: "https://vpn.example.com" },
    { endpointHost: "vpn.example.com:51820" },
    { endpointHost: "vpn.example.com\nPostUp = x" },
    { endpointHost: "vpn.example.com", address: "8.8.8.8/24" },
    { endpointHost: "vpn.example.com", interfaceName: "../evil" },
    { endpointHost: "vpn.example.com", listenPort: 0 },
    { endpointHost: "vpn.example.com", dns: "1.1.1.1\nPostUp = x" },
    { endpointHost: "vpn.example.com", privateKey: "x" },
  ];
  for (const body of bodies) {
    const result = await call(configRoute.PUT, `${BASE}/config`, "PUT", body);
    assert.equal(result.status, 400, JSON.stringify(body));
    assert.ok(!result.text.includes("at /"), "no stack trace");
  }
  assert.equal(rawValue("_wireguardServerConfig"), null);
  assert.equal(rawValue("_wireguardServerPrivateKey"), null);
});

// --- configuration, peers, secrets --------------------------------------------------------------

let serverPublicKey = "";
let serverPrivateKey = "";
let firstPeerConf = "";
let firstPeerPrivateKey = "";
let firstPeerPsk = "";
let firstPeerId = "";

test("first save generates the server keypair; the response and every GET carry public keys only", async () => {
  const saved = await call(configRoute.PUT, `${BASE}/config`, "PUT", {
    endpointHost: " VPN.Example.com ",
    listenPort: 51820,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.serverKeyGenerated, true);
  assert.equal(saved.json.config.endpointHost, "vpn.example.com");
  assert.equal(saved.json.config.interfaceName, "wg-redrouter");
  assert.equal(saved.json.config.address, "10.99.0.1/24");
  serverPublicKey = saved.json.config.serverPublicKey;
  assert.ok(keys.isWireGuardKey(serverPublicKey));

  const stored = rawValue("_wireguardServerPrivateKey") as string;
  assert.ok(stored, "server private key row exists");
  assert.ok(JSON.parse(stored).startsWith("enc:v1:"), "server private key is encrypted at rest");

  // Read the plaintext through the module built for the authenticated download and check it is the
  // key behind the published public key.
  const source = store.readWireGuardServerConfSource();
  assert.ok(source);
  serverPrivateKey = source.serverPrivateKey;
  assert.equal(keys.derivePublicKey(serverPrivateKey), serverPublicKey);
  assert.equal(saved.text.includes(serverPrivateKey), false);
});

test("saving again never regenerates the server key", async () => {
  const before = rawValue("_wireguardServerPrivateKey");
  const again = await call(configRoute.PUT, `${BASE}/config`, "PUT", {
    endpointHost: "vpn2.example.com",
    listenPort: 51999,
    dns: "1.1.1.1",
  });
  assert.equal(again.status, 200);
  assert.equal(again.json.serverKeyGenerated, false);
  assert.equal(again.json.config.serverPublicKey, serverPublicKey);
  assert.equal(again.json.config.listenPort, 51999);
  assert.equal(again.json.config.dns, "1.1.1.1");
  assert.equal(rawValue("_wireguardServerPrivateKey"), before, "the stored ciphertext is untouched");
});

test("adding a peer returns the file once; only its public key and an encrypted PSK are stored", async () => {
  await call(configRoute.PUT, `${BASE}/config`, "PUT", {
    endpointHost: "vpn.example.com",
    listenPort: 51820,
    dns: "",
  });
  const added = await call(peersRoute.POST, `${BASE}/peers`, "POST", { name: "Filipe's phone" });
  assert.equal(added.status, 200);
  assert.equal(added.headers.get("cache-control"), "no-store");
  assert.equal(added.json.success, true);
  assert.match(added.json.notice, /only time this peer's private key is shown/i);
  assert.match(added.json.notice, /does not store it/i);
  assert.equal(added.json.filename, "filipe-s-phone.conf");
  assert.equal(added.json.peer.name, "Filipe's phone");
  assert.equal(added.json.peer.allowedIp, "10.99.0.2/32");
  assert.equal(added.json.peer.hasPresharedKey, true);
  assert.equal("privateKey" in added.json.peer, false);
  firstPeerId = added.json.peer.id;
  firstPeerConf = added.json.config;

  // The file is a complete split-tunnel peer file for this server.
  assert.deepEqual(conf(firstPeerConf, "Address", "Interface"), ["10.99.0.2/32"]);
  assert.deepEqual(conf(firstPeerConf, "PublicKey", "Peer"), [serverPublicKey]);
  assert.deepEqual(conf(firstPeerConf, "Endpoint", "Peer"), ["vpn.example.com:51820"]);
  assert.deepEqual(conf(firstPeerConf, "AllowedIPs", "Peer"), ["10.99.0.1/32"]);
  assert.deepEqual(conf(firstPeerConf, "PersistentKeepalive", "Peer"), ["25"]);
  assert.equal(/PostUp|PostDown|0\.0\.0\.0\/0/.test(firstPeerConf), false);
  firstPeerPrivateKey = conf(firstPeerConf, "PrivateKey", "Interface")[0];
  firstPeerPsk = conf(firstPeerConf, "PresharedKey", "Peer")[0];
  assert.ok(keys.isWireGuardKey(firstPeerPrivateKey));
  assert.ok(keys.isWireGuardKey(firstPeerPsk));
  assert.equal(keys.derivePublicKey(firstPeerPrivateKey), added.json.peer.publicKey);

  // Storage: public key kept, PSK encrypted, private key nowhere.
  const model = JSON.parse(rawValue("_wireguardServerConfig") as string);
  assert.equal(model.peers.length, 1);
  assert.equal(model.peers[0].publicKey, added.json.peer.publicKey);
  assert.ok(JSON.parse(rawValue(`_wireguardPsk:${firstPeerId}`) as string).startsWith("enc:v1:"));

  const dump = dumpDatabase();
  assert.equal(dump.includes(serverPublicKey), true, "control: the dump does show stored public keys");
  assert.equal(dump.includes(added.json.peer.publicKey), true);
  const urlSafe = (value: string) => value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const hex = (value: string) => Buffer.from(value, "base64").toString("hex");
  for (const [label, secret] of [
    ["peer private key", firstPeerPrivateKey],
    ["preshared key", firstPeerPsk],
    ["server private key", serverPrivateKey],
  ] as const) {
    assert.equal(dump.includes(secret), false, `${label} (base64) is not in the database`);
    assert.equal(dump.includes(urlSafe(secret)), false, `${label} (base64url) is not in the database`);
    assert.equal(dump.includes(hex(secret)), false, `${label} (hex) is not in the database`);
  }
});

test("no GET or list ever returns a secret, including the settings API", async () => {
  const overview = await call(overviewRoute.GET, BASE, "GET");
  const settings = await call(settingsRoute.GET, "/api/settings", "GET");
  assert.equal(overview.status, 200);
  assert.equal(overview.json.config.peers.length, 1);
  assert.equal(overview.json.config.peers[0].hasPresharedKey, true);
  for (const secret of [serverPrivateKey, firstPeerPrivateKey, firstPeerPsk]) {
    assert.equal(overview.text.includes(secret), false);
    assert.equal(settings.text.includes(secret), false);
  }
  assert.equal(/^(private|preshared)/i.test(Object.keys(overview.json.config).join(" ")), false);
  assert.equal(settings.text.includes("wireguard"), false, "underscore keys are not settings");
  assert.equal(/\b(Private|Preshared)Key\b/.test(overview.text), false);
});

test("peers get sequential addresses; a removed peer's address is reused and its PSK row deleted", async () => {
  const second = await call(peersRoute.POST, `${BASE}/peers`, "POST", { name: "Laptop", usePresharedKey: false });
  const third = await call(peersRoute.POST, `${BASE}/peers`, "POST", { name: "Tablet" });
  assert.equal(second.json.peer.allowedIp, "10.99.0.3/32");
  assert.equal(second.json.peer.hasPresharedKey, false);
  assert.equal(conf(second.json.config, "PresharedKey").length, 0);
  assert.equal(third.json.peer.allowedIp, "10.99.0.4/32");

  const removed = await call(peerRoute.DELETE, `${BASE}/peers/${firstPeerId}`, "DELETE", undefined, {
    context: peerContext(firstPeerId),
  });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.config.peers.length, 2);
  assert.equal(rawValue(`_wireguardPsk:${firstPeerId}`), null, "the preshared key is deleted with the peer");

  const reused = await call(peersRoute.POST, `${BASE}/peers`, "POST", { name: "Desktop" });
  assert.equal(reused.json.peer.allowedIp, "10.99.0.2/32");

  const missing = await call(peerRoute.DELETE, `${BASE}/peers/peer_nope`, "DELETE", undefined, {
    context: peerContext("peer_nope"),
  });
  assert.equal(missing.status, 404);
  const invalid = await call(peerRoute.DELETE, `${BASE}/peers/x%20y`, "DELETE", undefined, {
    context: peerContext("../../etc"),
  });
  assert.equal(invalid.status, 400);
});

test("peer add validates the name and refuses unknown fields", async () => {
  for (const body of [{}, { name: "" }, { name: "\n\t" }, { name: "ok", publicKey: "x" }, { name: 5 }]) {
    const result = await call(peersRoute.POST, `${BASE}/peers`, "POST", body);
    assert.equal(result.status, 400, JSON.stringify(body));
  }
  const long = await call(peersRoute.POST, `${BASE}/peers`, "POST", { name: `${"n".repeat(70)}\n[Peer]` });
  assert.equal(long.status, 200);
  assert.ok(long.json.peer.name.length <= 64);
  assert.ok(!long.json.peer.name.includes("\n"));
  const cleanup = await call(peerRoute.DELETE, `${BASE}/peers/${long.json.peer.id}`, "DELETE", undefined, {
    context: peerContext(long.json.peer.id),
  });
  assert.equal(cleanup.status, 200);
});

test("the tunnel address cannot change while peers exist", async () => {
  const blocked = await call(configRoute.PUT, `${BASE}/config`, "PUT", {
    endpointHost: "vpn.example.com",
    address: "10.50.0.1/24",
  });
  assert.equal(blocked.status, 409);
  const same = await call(configRoute.PUT, `${BASE}/config`, "PUT", {
    endpointHost: "vpn.example.com",
    address: "10.99.0.1/24",
  });
  assert.equal(same.status, 200);
});

test("server config download: attachment headers, no caching, the private key, every peer, audited", async () => {
  const before = auditActions().filter((a) => a === "tunnel.wireguard.server_conf_downloaded").length;
  const download = await call(serverConfRoute.GET, `${BASE}/server-conf`, "GET");
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-disposition"), 'attachment; filename="wg-redrouter.conf"');
  assert.equal(download.headers.get("cache-control"), "no-store");
  assert.match(download.headers.get("content-type") ?? "", /^text\/plain/);
  assert.deepEqual(conf(download.text, "PrivateKey", "Interface"), [serverPrivateKey]);
  assert.deepEqual(conf(download.text, "Address", "Interface"), ["10.99.0.1/24"]);
  assert.deepEqual(conf(download.text, "ListenPort", "Interface"), ["51820"]);
  assert.equal(conf(download.text, "PublicKey", "Peer").length, 3);
  assert.deepEqual(conf(download.text, "AllowedIPs", "Peer").sort(), ["10.99.0.2/32", "10.99.0.3/32", "10.99.0.4/32"]);
  assert.equal(conf(download.text, "PresharedKey", "Peer").length, 2, "PSKs for the two peers that have one");
  assert.equal(/PostUp|PostDown|iptables/.test(download.text), false);
  assert.equal(download.text.includes(firstPeerPrivateKey), false, "no peer private key, ever");

  const after = auditActions().filter((a) => a === "tunnel.wireguard.server_conf_downloaded").length;
  assert.equal(after, before + 1, "the download is audited");
});

test("every mutation is audited, and no audit row carries key material", async () => {
  const actions = new Set(auditActions());
  for (const expected of [
    "tunnel.wireguard.configured",
    "tunnel.wireguard.peer_added",
    "tunnel.wireguard.peer_removed",
    "tunnel.wireguard.server_conf_downloaded",
  ]) {
    assert.ok(actions.has(expected), expected);
  }
  const audit = JSON.stringify(getDbInstance().prepare("SELECT * FROM audit_log").all());
  for (const secret of [serverPrivateKey, firstPeerPrivateKey, firstPeerPsk]) {
    assert.equal(audit.includes(secret), false);
  }
});

// --- rotation ---------------------------------------------------------------------------------

test("rotating the server key needs the current password and is audited", async () => {
  const before = rawValue("_wireguardServerPrivateKey");

  const missing = await call(overviewRoute.POST, BASE, "POST", { action: "rotate-server-key" });
  assert.equal(missing.status, 400);
  const wrong = await call(overviewRoute.POST, BASE, "POST", {
    action: "rotate-server-key",
    currentPassword: "not the password",
  });
  assert.equal(wrong.status, 401);
  const unknown = await call(overviewRoute.POST, BASE, "POST", { action: "reset-everything", currentPassword: PASSWORD });
  assert.equal(unknown.status, 400);
  assert.equal(rawValue("_wireguardServerPrivateKey"), before, "nothing changed without the password");

  const ok = await call(overviewRoute.POST, BASE, "POST", {
    action: "rotate-server-key",
    currentPassword: PASSWORD,
  });
  assert.equal(ok.status, 200);
  assert.notEqual(ok.json.serverPublicKey, serverPublicKey);
  assert.ok(keys.isWireGuardKey(ok.json.serverPublicKey));
  assert.match(ok.json.notice, /peer/i);
  assert.notEqual(rawValue("_wireguardServerPrivateKey"), before);
  assert.equal(ok.text.includes(serverPrivateKey), false);

  const download = await call(serverConfRoute.GET, `${BASE}/server-conf`, "GET");
  const newPrivate = conf(download.text, "PrivateKey", "Interface")[0];
  assert.notEqual(newPrivate, serverPrivateKey);
  assert.equal(keys.derivePublicKey(newPrivate), ok.json.serverPublicKey);

  const rows = getDbInstance()
    .prepare("SELECT status FROM audit_log WHERE action = 'tunnel.wireguard.server_key_rotated' ORDER BY id")
    .all() as Array<{ status: string }>;
  assert.deepEqual(
    rows.slice(-3).map((row) => row.status),
    ["failure", "failure", "success"],
    "the missing and wrong password attempts are audited as failures"
  );
});

// --- status ------------------------------------------------------------------------------------

function fakeInterfaces(map: Record<string, Array<{ address: string; family: string }>>) {
  status.setWireGuardStatusRuntime({
    networkInterfaces: () =>
      Object.fromEntries(
        Object.entries(map).map(([name, entries]) => [
          name,
          entries.map((entry) => ({ ...entry, netmask: "255.255.255.0", mac: "", internal: false, cidr: null })),
        ])
      ) as never,
  });
}

test("status: not_configured, configured_interface_down and interface_up from a faked interface list", () => {
  assert.equal(status.getWireGuardStatus(null).state, "not_configured");
  assert.equal(status.getWireGuardStatus(null).configured, false);

  const config = store.readWireGuardConfig();
  assert.ok(config);

  fakeInterfaces({ lo: [{ address: "127.0.0.1", family: "IPv4" }], eth0: [{ address: "192.168.1.5", family: "IPv4" }] });
  const down = status.getWireGuardStatus(config);
  assert.equal(down.state, "configured_interface_down");
  assert.equal(down.interfaceUp, false);
  assert.equal(down.activeInterface, null);
  assert.equal(down.reachable, false);
  assert.equal(down.commands?.up, "sudo wg-quick up ./wg-redrouter.conf");
  assert.equal(down.commands?.down, "sudo wg-quick down ./wg-redrouter.conf");
  assert.match(down.message, /sudo wg-quick up \.\/wg-redrouter\.conf/);

  // Same address on an IPv6 entry or a different IPv4 address does not count.
  fakeInterfaces({ wg9: [{ address: "10.99.0.1", family: "IPv6" }], wg8: [{ address: "10.99.0.2", family: "IPv4" }] });
  assert.equal(status.getWireGuardStatus(config).state, "configured_interface_down");

  fakeInterfaces({ "wg-redrouter": [{ address: "10.99.0.1", family: "IPv4" }] });
  const up = status.getWireGuardStatus(config);
  assert.equal(up.state, "interface_up");
  assert.equal(up.interfaceUp, true);
  assert.equal(up.activeInterface, "wg-redrouter");
  assert.equal(up.serverIp, "10.99.0.1");
  assert.equal(up.apiUrl, "http://10.99.0.1:20128/v1");
  assert.equal(up.peerCount, config.peers.length);
});

test("status over HTTP reports the same three states without secrets", async () => {
  fakeInterfaces({});
  const down = await call(overviewRoute.GET, BASE, "GET");
  assert.equal(down.json.status.state, "configured_interface_down");
  fakeInterfaces({ wgx: [{ address: "10.99.0.1", family: "IPv4" }] });
  const up = await call(overviewRoute.GET, BASE, "GET");
  assert.equal(up.json.status.state, "interface_up");
  assert.equal(up.json.status.activeInterface, "wgx");
  assert.equal(/\b(Private|Preshared)Key\b/.test(up.text), false);
});

test("status: RedRouter bound to loopback is flagged, with the exact flag that fixes it", () => {
  const config = store.readWireGuardConfig();
  assert.ok(config);
  fakeInterfaces({ wg0: [{ address: "10.99.0.1", family: "IPv4" }] });

  const loopback = status.getWireGuardStatus(config);
  assert.equal(loopback.bind?.host, "127.0.0.1");
  assert.equal(loopback.bind?.kind, "loopback");
  assert.equal(loopback.bind?.reachable, false);
  assert.match(loopback.bind?.warning ?? "", /will NOT reach it/);
  assert.match(loopback.bind?.warning ?? "", /red-router serve --expose/);
  assert.match(loopback.bind?.warning ?? "", /red-router serve --host 10\.99\.0\.1/);
  assert.match(loopback.bind?.warning ?? "", /RED_ROUTER_SERVER_HOST/);
  assert.equal(loopback.interfaceUp, true);
  assert.equal(loopback.reachable, false, "up, but nothing listens on it");
  assert.match(loopback.message, /not listening on it/);

  process.env.RED_ROUTER_SERVER_HOST = "0.0.0.0";
  try {
    const all = status.getWireGuardStatus(config);
    assert.equal(all.bind?.kind, "all_interfaces");
    assert.equal(all.bind?.reachable, true);
    assert.equal(all.bind?.warning, null);
    assert.match(all.bind?.note ?? "", /LAN too/);
    assert.equal(all.reachable, true);

    process.env.RED_ROUTER_SERVER_HOST = "10.99.0.1";
    const exact = status.getWireGuardStatus(config);
    assert.equal(exact.bind?.kind, "wireguard_address");
    assert.equal(exact.bind?.reachable, true);
    assert.equal(exact.bind?.note, null);

    process.env.RED_ROUTER_SERVER_HOST = "192.168.1.5";
    const other = status.getWireGuardStatus(config);
    assert.equal(other.bind?.kind, "other_address");
    assert.equal(other.bind?.reachable, false);
    assert.match(other.bind?.warning ?? "", /not the WireGuard address/);

    delete process.env.RED_ROUTER_SERVER_HOST;
    process.env.OMNIROUTE_SERVER_HOST = "::";
    assert.equal(status.getWireGuardStatus(config).bind?.reachable, true);
    delete process.env.OMNIROUTE_SERVER_HOST;

    // HOSTNAME is only trusted when it is an IP literal (it is ordinary shell state otherwise).
    process.env.HOSTNAME = "my-laptop";
    assert.equal(status.getWireGuardStatus(config).bind?.host, "127.0.0.1");
    process.env.HOSTNAME = "0.0.0.0";
    assert.equal(status.getWireGuardStatus(config).bind?.reachable, true);
    delete process.env.HOSTNAME;
  } finally {
    delete process.env.RED_ROUTER_SERVER_HOST;
    delete process.env.OMNIROUTE_SERVER_HOST;
    delete process.env.HOSTNAME;
  }
});

test("status: with a separate API port the API bridge host (API_HOST) decides, and the URL uses the API port", () => {
  const config = store.readWireGuardConfig();
  assert.ok(config);
  fakeInterfaces({ wg0: [{ address: "10.99.0.1", family: "IPv4" }] });
  process.env.API_PORT = "20129";
  process.env.DASHBOARD_PORT = "20128";
  process.env.RED_ROUTER_SERVER_HOST = "0.0.0.0"; // the dashboard host is irrelevant to the API port
  try {
    const bridged = status.getWireGuardStatus(config);
    assert.equal(bridged.apiPort, 20129);
    assert.equal(bridged.apiUrl, "http://10.99.0.1:20129/v1");
    assert.equal(bridged.bind?.source, "default");
    assert.equal(bridged.bind?.reachable, false);
    assert.match(bridged.bind?.warning ?? "", /API_HOST=0\.0\.0\.0/);

    process.env.API_HOST = "0.0.0.0";
    const exposed = status.getWireGuardStatus(config);
    assert.equal(exposed.bind?.source, "API_HOST");
    assert.equal(exposed.bind?.reachable, true);
  } finally {
    delete process.env.API_PORT;
    delete process.env.DASHBOARD_PORT;
    delete process.env.API_HOST;
    delete process.env.RED_ROUTER_SERVER_HOST;
  }
});

// --- presentation and page wiring ---------------------------------------------------------------

test("presentation: pills for the three states; WireGuard counts as active only when the interface is up", () => {
  assert.deepEqual(presentation.WIREGUARD_PILLS.not_configured, { label: "Not configured", tone: "default" });
  assert.deepEqual(presentation.WIREGUARD_PILLS.configured_interface_down, { label: "Interface down", tone: "warning" });
  assert.deepEqual(presentation.WIREGUARD_PILLS.interface_up, { label: "Up", tone: "success" });
  assert.equal(presentation.isWireGuardActive(null), false);
  assert.equal(presentation.isWireGuardActive({ state: "not_configured" }), false);
  assert.equal(presentation.isWireGuardActive({ state: "configured_interface_down" }), false);
  assert.equal(presentation.isWireGuardActive({ state: "interface_up" }), true);
  const counted = presentation.countTunnels([
    { visible: true, active: presentation.isWireGuardActive({ state: "configured_interface_down" }) },
    { visible: true, active: presentation.isWireGuardActive({ state: "interface_up" }) },
  ]);
  assert.deepEqual(counted, { active: 1, total: 2 });
});

test("Endpoint page mounts the WireGuard row in the Private group and counts it; the row stays on the DS", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
  const page = read("src/app/(dashboard)/dashboard/endpoint/EndpointPageClient.tsx");
  assert.ok(page.includes("<WireGuardRow"));
  assert.ok(page.includes("isWireGuardActive(wireGuardStatus)"));
  assert.ok(
    page.indexOf("<WireGuardRow") < page.indexOf('kind="public"'),
    "WireGuard sits above the Public group heading"
  );

  const row = read("src/app/(dashboard)/dashboard/endpoint/components/WireGuardRow.tsx");
  assert.ok(!row.includes("material-symbols-outlined"), "no Material Symbols in new code");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(row), "no hex colours");
  assert.ok(
    !/\b(?:text|bg|border)-(?:red|green|blue|amber|orange|yellow|emerald|sky|slate|gray|zinc)-\d{2,3}\b/.test(row),
    "no raw palette colours"
  );
  assert.ok(row.includes("<Modal") && row.includes("<Textarea") && row.includes("readOnly"));
  assert.ok(row.includes("This is the only time this private key is shown."));
  assert.ok(row.includes("Download server config"));
  assert.ok(row.includes("status.commands.up") && row.includes("status.commands.down"));
  assert.ok(row.includes("status.bind.warning"), "the exposure warning is rendered");
  assert.ok(!/localStorage|sessionStorage/.test(row), "the one-time key is never persisted client-side");
});
