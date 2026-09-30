import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WireGuardConfigError,
  allocatePeerAddress,
  defaultServerModel,
  hostCommands,
  renderPeerConf,
  renderServerConf,
  tunnelApiUrl,
  type WireGuardPeer,
  type WireGuardServerModel,
} from "../../../src/lib/wireguard/serverConfig.ts";
import * as schemas from "../../../src/shared/validation/wireguardSchemas.ts";

// Fixed keys (RFC 7748 vectors) so the rendered files can be compared byte for byte.
const SERVER_PRIVATE = "dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo=";
const SERVER_PUBLIC = "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=";
const PEER_PRIVATE = "XasIfmJKikt54X+Lg4AO5m87sSkmGLb9HC+LJ/+I4Os=";
const PEER_PUBLIC = "3p7bfXt9wbTTW2HC7OQ1Nz+DQ8hbeGdNrfx+FG+IK08=";
const PSK = "Sl2dW6TOLeFyjjv0gDUPJeB+IclH0Z4zdvCbPB4WF0I=";

function peer(id: string, name: string, allowedIp: string, extra: Partial<WireGuardPeer> = {}): WireGuardPeer {
  return { id, name, publicKey: PEER_PUBLIC, allowedIp, createdAt: "2026-09-29T00:00:00.000Z", ...extra };
}

function model(overrides: Partial<WireGuardServerModel> = {}): WireGuardServerModel {
  return { ...defaultServerModel(), endpointHost: "vpn.example.com", ...overrides };
}

// Every line of a rendered file must be one of these shapes: nothing else can be smuggled in.
const KEY = "[A-Za-z0-9+/]{43}=";
const ALLOWED_LINES: RegExp[] = [
  /^$/,
  /^# [^\n]*$/,
  /^\[Interface\]$/,
  /^\[Peer\]$/,
  new RegExp(`^(PrivateKey|PublicKey|PresharedKey) = ${KEY}$`),
  /^Address = \d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/,
  /^ListenPort = \d{1,5}$/,
  /^AllowedIPs = \d{1,3}(\.\d{1,3}){3}\/32$/,
  /^Endpoint = (\[[0-9a-f:]+\]|[a-z0-9.-]+|\d{1,3}(\.\d{1,3}){3}):\d{1,5}$/,
  /^DNS = [0-9a-f.:]+(, [0-9a-f.:]+){0,2}$/,
  /^PersistentKeepalive = 25$/,
];

function hasForbiddenChar(line: string): boolean {
  for (const char of line) {
    const code = char.codePointAt(0) as number;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  return false;
}

function assertOnlyKnownLines(text: string) {
  assert.ok(text.endsWith("\n"));
  for (const line of text.slice(0, -1).split("\n")) {
    assert.ok(
      ALLOWED_LINES.some((re) => re.test(line)),
      `unexpected line in rendered file: ${JSON.stringify(line)}`
    );
  }
}

// --- rendering --------------------------------------------------------------------------------

test("server file: exact wg-quick text, one Peer per peer, each allowed only its own /32", () => {
  const text = renderServerConf(
    model({
      peers: [
        peer("p1", "Phone", "10.99.0.2/32", { presharedKey: PSK, hasPresharedKey: true }),
        peer("p2", "Laptop", "10.99.0.3/32"),
      ],
    }),
    SERVER_PRIVATE
  );
  assert.equal(
    text,
    [
      '# RedRouter WireGuard server "wg-redrouter". This file contains a private key: chmod 600 it.',
      "# Bring the interface up on this machine with: sudo wg-quick up ./wg-redrouter.conf",
      "[Interface]",
      `PrivateKey = ${SERVER_PRIVATE}`,
      "Address = 10.99.0.1/24",
      "ListenPort = 51820",
      "",
      "# peer: Phone",
      "[Peer]",
      `PublicKey = ${PEER_PUBLIC}`,
      `PresharedKey = ${PSK}`,
      "AllowedIPs = 10.99.0.2/32",
      "",
      "# peer: Laptop",
      "[Peer]",
      `PublicKey = ${PEER_PUBLIC}`,
      "AllowedIPs = 10.99.0.3/32",
      "",
    ].join("\n")
  );
  assertOnlyKnownLines(text);
});

test("server file is a private tunnel, not a router: no hooks, no forwarding, no default route", () => {
  const text = renderServerConf(model({ peers: [peer("p1", "Phone", "10.99.0.2/32")] }), SERVER_PRIVATE);
  for (const forbidden of ["PostUp", "PostDown", "PreUp", "PreDown", "iptables", "nft", "0.0.0.0/0", "::/0", "SaveConfig", "Table"]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
});

test("peer file: split tunnel to the server /32 only, keepalive 25, exact text", () => {
  const text = renderPeerConf({
    peerPrivateKey: PEER_PRIVATE,
    peerAddress: "10.99.0.2/32",
    serverAddress: "10.99.0.1/24",
    serverPublicKey: SERVER_PUBLIC,
    endpoint: "vpn.example.com:51820",
    presharedKey: PSK,
    name: "Phone",
  });
  assert.equal(
    text,
    [
      "# RedRouter WireGuard peer: Phone",
      "[Interface]",
      `PrivateKey = ${PEER_PRIVATE}`,
      "Address = 10.99.0.2/32",
      "",
      "[Peer]",
      `PublicKey = ${SERVER_PUBLIC}`,
      `PresharedKey = ${PSK}`,
      "Endpoint = vpn.example.com:51820",
      "AllowedIPs = 10.99.0.1/32",
      "PersistentKeepalive = 25",
      "",
    ].join("\n")
  );
  assertOnlyKnownLines(text);
  assert.equal(/0\.0\.0\.0\/0|::\/0/.test(text), false, "never a default route");
  assert.equal(text.includes("DNS"), false, "no DNS line unless configured");
  assert.equal(text.includes("PostUp"), false);
});

test("peer file: DNS only when configured, IPv6 endpoints are bracketed, no PSK line without a PSK", () => {
  const text = renderPeerConf({
    peerPrivateKey: PEER_PRIVATE,
    peerAddress: "10.99.0.2/32",
    serverAddress: "10.99.0.1/24",
    serverPublicKey: SERVER_PUBLIC,
    endpoint: "[2001:db8::1]:443",
    dns: "1.1.1.1, 9.9.9.9",
  });
  assert.match(text, /^DNS = 1\.1\.1\.1, 9\.9\.9\.9$/m);
  assert.match(text, /^Endpoint = \[2001:db8::1\]:443$/m);
  assert.equal(text.includes("PresharedKey"), false);
  assertOnlyKnownLines(text);
});

// --- injection --------------------------------------------------------------------------------

test("peer names cannot forge lines: control characters are stripped, the name is one comment line", () => {
  const hostile = [
    "Phone\n[Peer]\nPublicKey = AAAA\nAllowedIPs = 0.0.0.0/0",
    "Phone\r\nPostUp = rm -rf /",
    "x\u2028PostUp = evil\u2029y",
    "\u202eevil\u202c",
    "tab\tsep\u0000nul\u007f",
    "# ; [Interface] PostUp = x",
  ];
  for (const name of hostile) {
    const text = renderServerConf(model({ peers: [peer("p1", name, "10.99.0.2/32")] }), SERVER_PRIVATE);
    assertOnlyKnownLines(text);
    assert.equal(text.includes("PostUp\n"), false);
    assert.equal((text.match(/^\[Peer\]$/gm) ?? []).length, 1, "exactly one Peer block");
    assert.equal((text.match(/^AllowedIPs/gm) ?? []).length, 1);
    const commentLine = text.split("\n").find((line) => line.startsWith("# peer: ")) as string;
    assert.ok(commentLine, "the name is a comment");
    assert.equal(hasForbiddenChar(commentLine), false, "no control, separator or bidi characters");
  }
  // The same holds for the peer file's own header.
  const peerText = renderPeerConf({
    peerPrivateKey: PEER_PRIVATE,
    peerAddress: "10.99.0.2/32",
    serverAddress: "10.99.0.1/24",
    serverPublicKey: SERVER_PUBLIC,
    endpoint: "vpn.example.com:51820",
    name: "a\n[Peer]\nEndpoint = evil:1",
  });
  assertOnlyKnownLines(peerText);
  assert.equal((peerText.match(/^\[Peer\]$/gm) ?? []).length, 1);
  assert.equal((peerText.match(/^Endpoint/gm) ?? []).length, 1);
});

test("peer names are limited to 64 characters and must not end up empty", () => {
  assert.equal(schemas.sanitizePeerName("x".repeat(200)).length, 64);
  assert.equal(schemas.sanitizePeerName("  a \n\t b  "), "a b");
  assert.equal(schemas.checkPeerName("\n\t\u0000").ok, false);
  assert.equal(schemas.checkPeerName("").ok, false);
  assert.equal(schemas.checkPeerName(42).ok, false);
  assert.equal(schemas.checkPeerName("Filipe's phone").value, "Filipe's phone");
  assert.equal(schemas.peerFileSlug("Filipe's Phone!"), "filipe-s-phone");
  assert.equal(schemas.peerFileSlug("\u202e\u0000"), "peer");
});

test("endpoint host: hostnames, IPv4 and IPv6 pass; anything with a scheme, port, path or newline is rejected", () => {
  const good: Array<[string, string]> = [
    ["vpn.example.com", "vpn.example.com"],
    ["  VPN.Example.COM ", "vpn.example.com"],
    ["myserver", "myserver"],
    ["203.0.113.7", "203.0.113.7"],
    ["2001:db8::1", "2001:db8::1"],
    ["[2001:DB8::1]", "2001:db8::1"],
  ];
  for (const [input, expected] of good) {
    assert.deepEqual(schemas.checkWireGuardEndpointHost(input), { ok: true, value: expected }, input);
  }
  const bad = [
    "https://vpn.example.com",
    "vpn.example.com:51820",
    "203.0.113.7:51820",
    "vpn.example.com/path",
    "vpn.example.com\nPostUp = rm -rf /",
    "vpn.example.com\r\n[Peer]",
    "vpn example.com",
    "user@vpn.example.com",
    "vpn.example.com;x",
    "vpn.example.com#c",
    "*.example.com",
    "vpn.example.com.",
    "-bad.example.com",
    "bad_name.example.com",
    "a..example.com",
    "localhost",
    "api.localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "0:0:0:0:0:0:0:1",
    "999.1.1.1",
    "1.2.3",
    "01.2.3.4",
    "2001:db8::zz",
    "1:2:3:4:5:6:7:8:9",
    "",
    "   ",
    "a".repeat(254),
  ];
  for (const input of bad) {
    assert.equal(schemas.checkWireGuardEndpointHost(input).ok, false, JSON.stringify(input).slice(0, 60));
  }
  assert.equal(schemas.checkWireGuardEndpointHost(undefined).ok, false);
});

test("renderers re-validate: an injected endpoint, DNS, key, address or interface name is refused", () => {
  const base = {
    peerPrivateKey: PEER_PRIVATE,
    peerAddress: "10.99.0.2/32",
    serverAddress: "10.99.0.1/24",
    serverPublicKey: SERVER_PUBLIC,
    endpoint: "vpn.example.com:51820",
  };
  assert.doesNotThrow(() => renderPeerConf(base));
  for (const patch of [
    { endpoint: "vpn.example.com\nPostUp = x:51820" },
    { endpoint: "vpn.example.com:51820\nPostUp = x" },
    { endpoint: "http://vpn.example.com:51820" },
    { endpoint: "vpn.example.com" },
    { endpoint: "vpn.example.com:99999" },
    { dns: "1.1.1.1\nPostUp = x" },
    { dns: "not-an-ip" },
    { dns: "1.1.1.1 2.2.2.2 3.3.3.3 4.4.4.4" },
    { peerPrivateKey: `${PEER_PRIVATE}\nPostUp = x` },
    { peerPrivateKey: "short" },
    { serverPublicKey: "" },
    { presharedKey: "nope" },
    { peerAddress: "10.99.0.2/24" },
    { peerAddress: "10.99.0.2/32\nPostUp = x" },
    { serverAddress: "garbage" },
  ]) {
    assert.throws(() => renderPeerConf({ ...base, ...patch }), WireGuardConfigError, JSON.stringify(patch).slice(0, 50));
  }

  const ok = model({ peers: [peer("p1", "P", "10.99.0.2/32")] });
  assert.doesNotThrow(() => renderServerConf(ok, SERVER_PRIVATE));
  assert.throws(() => renderServerConf(ok, "bad"), WireGuardConfigError);
  assert.throws(() => renderServerConf({ ...ok, interfaceName: "wg0\nPostUp = x" }, SERVER_PRIVATE), WireGuardConfigError);
  assert.throws(() => renderServerConf({ ...ok, interfaceName: "../etc/x" }, SERVER_PRIVATE), WireGuardConfigError);
  assert.throws(() => renderServerConf({ ...ok, address: "8.8.8.8/24" }, SERVER_PRIVATE), WireGuardConfigError);
  assert.throws(() => renderServerConf({ ...ok, listenPort: 0 }, SERVER_PRIVATE), WireGuardConfigError);
  assert.throws(
    () => renderServerConf({ ...ok, peers: [peer("p1", "P", "10.99.0.2/32", { publicKey: "x" })] }, SERVER_PRIVATE),
    WireGuardConfigError
  );
  // A peer outside the subnet, on the server's own address, or wider than a /32 is refused.
  for (const allowedIp of ["10.98.0.2/32", "10.99.0.1/32", "10.99.0.0/32", "10.99.0.255/32", "10.99.0.2/24", "0.0.0.0/0"]) {
    assert.throws(
      () => renderServerConf({ ...ok, peers: [peer("p1", "P", allowedIp)] }, SERVER_PRIVATE),
      WireGuardConfigError,
      allowedIp
    );
  }
});

test("interface names follow /^[a-zA-Z0-9_=+.-]{1,15}$/ and cannot be path-like", () => {
  for (const good of ["wg-redrouter", "wg0", "a", "A_b=c+d.e-f", "x".repeat(15)]) {
    assert.equal(schemas.checkWireGuardInterfaceName(good).ok, true, good);
  }
  assert.deepEqual(schemas.checkWireGuardInterfaceName(" wg0\n"), { ok: true, value: "wg0" }, "trimmed");
  for (const bad of ["", "x".repeat(16), "wg 0", "wg/0", "../x", "..", ".", "-h", "wg0\nPostUp", "wg0;ls", "wg$0", "wg'0"]) {
    assert.equal(schemas.checkWireGuardInterfaceName(bad).ok, false, JSON.stringify(bad));
  }
});

test("tunnel address: private IPv4 CIDR host address only", () => {
  const good: Array<[string, string]> = [
    ["10.99.0.1/24", "10.99.0.1/24"],
    [" 192.168.77.1/24 ", "192.168.77.1/24"],
    ["172.16.5.1/16", "172.16.5.1/16"],
    ["10.0.0.1/8", "10.0.0.1/8"],
    ["10.99.0.1/30", "10.99.0.1/30"],
  ];
  for (const [input, expected] of good) {
    assert.deepEqual(schemas.checkWireGuardAddress(input), { ok: true, value: expected }, input);
  }
  for (const bad of [
    "8.8.8.8/24",
    "100.64.0.1/24",
    "172.32.0.1/24",
    "172.16.0.1/8", // would cover public space
    "192.168.0.1/15",
    "10.99.0.0/24", // network address
    "10.99.0.255/24", // broadcast address
    "10.99.0.1/31",
    "10.99.0.1/32",
    "10.99.0.1/7",
    "10.99.0.1",
    "10.99.0.1/",
    "10.99.0.1/024",
    "010.99.0.1/24",
    "10.99.0.256/24",
    "10.99.0.1/24\nPostUp = x",
    "fd00::1/64",
    "",
    42,
  ]) {
    assert.equal(schemas.checkWireGuardAddress(bad).ok, false, JSON.stringify(bad));
  }
});

test("port and DNS field checks", () => {
  assert.deepEqual(schemas.checkWireGuardPort(51820), { ok: true, value: 51820 });
  assert.deepEqual(schemas.checkWireGuardPort("443"), { ok: true, value: 443 });
  for (const bad of [0, 65536, -1, 1.5, "abc", "1e3", "", null, undefined, "99999"]) {
    assert.equal(schemas.checkWireGuardPort(bad).ok, false, String(bad));
  }
  assert.deepEqual(schemas.checkWireGuardDns(""), { ok: true, value: "" });
  assert.deepEqual(schemas.checkWireGuardDns("1.1.1.1,9.9.9.9"), { ok: true, value: "1.1.1.1, 9.9.9.9" });
  assert.equal(schemas.checkWireGuardDns("dns.example.com").ok, false);
});

test("config schema: strict, endpointHost required, values normalised", () => {
  const ok = schemas.wireguardConfigSchema.safeParse({
    endpointHost: " VPN.example.com ",
    listenPort: "51821",
    address: "10.50.0.1/24",
    interfaceName: "wg1",
    dns: "1.1.1.1",
  });
  assert.equal(ok.success, true);
  if (ok.success) {
    assert.equal(ok.data.endpointHost, "vpn.example.com");
    assert.equal(ok.data.listenPort, 51821);
  }
  assert.equal(schemas.wireguardConfigSchema.safeParse({}).success, false);
  assert.equal(schemas.wireguardConfigSchema.safeParse({ endpointHost: "vpn.example.com", extra: 1 }).success, false);
  assert.equal(schemas.wireguardConfigSchema.safeParse({ endpointHost: "http://x.y" }).success, false);
  assert.equal(schemas.wireguardPeerAddSchema.safeParse({ name: "Phone" }).success, true);
  assert.equal(schemas.wireguardPeerAddSchema.safeParse({ name: "\n" }).success, false);
  assert.equal(schemas.wireguardPeerAddSchema.safeParse({ name: "a", privateKey: "x" }).success, false);
  assert.equal(schemas.wireguardActionSchema.safeParse({ action: "rotate-server-key" }).success, true);
  assert.equal(schemas.wireguardActionSchema.safeParse({ action: "delete-everything" }).success, false);
});

// --- allocation -------------------------------------------------------------------------------

test("peer addresses are allocated sequentially, skipping the network, the server and used addresses", () => {
  const m = model();
  assert.equal(allocatePeerAddress(m), "10.99.0.2/32");
  m.peers.push(peer("a", "A", "10.99.0.2/32"));
  assert.equal(allocatePeerAddress(m), "10.99.0.3/32");
  m.peers.push(peer("c", "C", "10.99.0.4/32"));
  assert.equal(allocatePeerAddress(m), "10.99.0.3/32", "a freed or skipped address is reused first");
  m.peers.push(peer("b", "B", "10.99.0.3/32"));
  assert.equal(allocatePeerAddress(m), "10.99.0.5/32");

  // The server need not be .1: allocation starts at the first free host address.
  const odd = model({ address: "10.99.0.5/24" });
  assert.equal(allocatePeerAddress(odd), "10.99.0.1/32");
  odd.peers.push(peer("a", "A", "10.99.0.1/32"));
  assert.equal(allocatePeerAddress(odd), "10.99.0.2/32");
});

test("allocation never hands out the network or broadcast address and fails cleanly when the subnet is full", () => {
  // /29 has hosts .1-.6: the server takes .1, five peers fit, the sixth does not.
  const m = model({ address: "10.99.0.1/29" });
  const handed: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    const next = allocatePeerAddress(m);
    handed.push(next);
    m.peers.push(peer(`p${i}`, `P${i}`, next));
  }
  assert.deepEqual(handed, ["10.99.0.2/32", "10.99.0.3/32", "10.99.0.4/32", "10.99.0.5/32", "10.99.0.6/32"]);
  assert.throws(
    () => allocatePeerAddress(m),
    (error: unknown) => error instanceof WireGuardConfigError && error.code === "subnet_exhausted"
  );

  // /30: server .1, one peer .2, then exhausted.
  const tiny = model({ address: "10.99.0.1/30" });
  assert.equal(allocatePeerAddress(tiny), "10.99.0.2/32");
  tiny.peers.push(peer("a", "A", "10.99.0.2/32"));
  assert.throws(() => allocatePeerAddress(tiny), WireGuardConfigError);
});

test("helpers: tunnel URL and the exact host commands", () => {
  assert.equal(tunnelApiUrl({ address: "10.99.0.1/24" }, 20128), "http://10.99.0.1:20128/v1");
  assert.deepEqual(hostCommands("wg-redrouter"), {
    up: "sudo wg-quick up ./wg-redrouter.conf",
    down: "sudo wg-quick down ./wg-redrouter.conf",
    status: "sudo wg show wg-redrouter",
  });
});
