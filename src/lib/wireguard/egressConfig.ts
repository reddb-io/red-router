/**
 * WireGuard egress: parse a wg-quick style client config into a validated model and render the
 * `wireproxy` config RedRouter actually runs. Pure: no I/O, no process, no database.
 *
 * Trust model. The pasted text is untrusted. Nothing from it is ever copied into the rendered
 * config verbatim: every value is parsed into a typed field with a strict validator first, and the
 * renderer only writes those typed fields (plus fixed literals). A value therefore cannot smuggle
 * a new line, section or key into the wireproxy file, whatever it contains. wg-quick script hooks
 * (PostUp, PostDown, PreUp, PreDown, SaveConfig) and routing knobs (Table, FwMark) are never
 * executed and never rendered: they are dropped and reported by key name only (the value may be a
 * shell command containing secrets, so it is not echoed either).
 *
 * Error and warning strings are fixed sentences plus a line number. They never contain any part of
 * the input, so they are safe to return to the browser and to log.
 *
 * wireproxy syntax assumptions (github.com/pufferffish/wireproxy README, v1.0.x; not verified
 * against a running binary here):
 *   [Interface]  PrivateKey, Address (comma separated CIDRs), DNS (comma separated IPs), MTU
 *   [Peer]       PublicKey, PresharedKey, Endpoint (host:port), AllowedIPs, PersistentKeepalive
 *   [Socks5]     BindAddress = host:port, optional Username / Password
 * The bind address is always 127.0.0.1: the SOCKS listener must never be reachable off-host.
 */

import { isIP } from "net";

export const MAX_WG_CONFIG_BYTES = 16 * 1024;
export const WG_EGRESS_FULL_TUNNEL = ["0.0.0.0/0", "::/0"] as const;
export const WG_EGRESS_DEFAULT_KEEPALIVE = 25;

const MAX_ADDRESSES = 8;
const MAX_DNS = 8;
const MAX_ALLOWED_IPS = 64;
const MIN_MTU = 576;
const MAX_MTU = 9000;

/** wg-quick keys that would run commands or change host routing. Dropped and reported, never used. */
const HOOK_KEYS = new Set([
  "preup",
  "predown",
  "postup",
  "postdown",
  "saveconfig",
  "table",
  "fwmark",
]);
const INTERFACE_KEYS = new Set(["privatekey", "address", "dns", "mtu", ...HOOK_KEYS, "listenport"]);
const PEER_KEYS = new Set([
  "publickey",
  "presharedkey",
  "endpoint",
  "allowedips",
  "persistentkeepalive",
]);

export type WgIgnoredLine = { line: number; key: string; reason: string };

export type WgPeerModel = {
  publicKey: string;
  presharedKey: string | null;
  endpointHost: string;
  endpointPort: number;
  /** Full-tunnel is always rendered; this is what the uploaded file asked for. */
  allowedIps: string[];
  persistentKeepalive: number | null;
};

export type WgEgressModel = {
  privateKey: string;
  /** Normalised CIDRs (a bare address becomes /32 or /128). */
  addresses: string[];
  dns: string[];
  mtu: number | null;
  peer: WgPeerModel;
};

/** Flat on purpose: TypeScript union narrowing is off under `strict: false`. */
export type WgParseResult = {
  ok: boolean;
  model?: WgEgressModel;
  errors: string[];
  warnings: string[];
  ignored: WgIgnoredLine[];
};

/** Reject anything that is not a 32-byte canonical base64 WireGuard key. Private to this module. */
export function isWireGuardKeyText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32) return false;
  // Canonical encoding only (the trailing character carries two spare bits that must be zero).
  if (bytes.toString("base64") !== value) return false;
  return bytes.some((byte) => byte !== 0);
}

function isHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split(".");
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) return false;
  }
  // An all-numeric last label is an (invalid) IPv4 literal, not a name.
  if (/^\d+$/.test(labels[labels.length - 1])) return false;
  return true;
}

/** `host:port`, `[v6]:port`. No scheme, path, credentials, whitespace or zone id. */
export function parseWgEndpoint(raw: string): { host: string; port: number } | null {
  const value = raw.trim();
  if (!value || value.includes("://") || /[\s/@?#%]/.test(value)) return null;
  let host: string;
  let portText: string;
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0 || value[end + 1] !== ":") return null;
    host = value.slice(1, end);
    portText = value.slice(end + 2);
    if (isIP(host) !== 6) return null;
  } else {
    const colon = value.lastIndexOf(":");
    if (colon < 0) return null;
    host = value.slice(0, colon);
    portText = value.slice(colon + 1);
    if (host.includes(":")) return null; // bare IPv6 needs brackets
    if (isIP(host) !== 4 && !isHostname(host)) return null;
  }
  if (!/^\d{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (port < 1 || port > 65535) return null;
  return { host, port };
}

/** `ip` or `ip/prefix` -> normalised CIDR, or null. */
function parseCidr(raw: string): string | null {
  const value = raw.trim();
  if (!value || /[^0-9a-fA-F:./]/.test(value)) return null;
  const slash = value.indexOf("/");
  const ip = slash < 0 ? value : value.slice(0, slash);
  const family = isIP(ip);
  if (!family) return null;
  const max = family === 4 ? 32 : 128;
  if (slash < 0) return `${ip}/${max}`;
  const prefixText = value.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix > max) return null;
  return `${ip}/${prefix}`;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

type Section = "interface" | "peer";

type ParsedLine = { line: number; key: string; keyLower: string; value: string };

/**
 * Parse and validate a wg-quick client config. Never throws.
 * Exactly one [Interface] and exactly one [Peer]; any other section is refused.
 */
export function parseWireGuardEgressConfig(input: unknown): WgParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ignored: WgIgnoredLine[] = [];
  const fail = (): WgParseResult => ({ ok: false, errors, warnings, ignored });

  if (typeof input !== "string") {
    errors.push("The configuration must be text.");
    return fail();
  }
  if (Buffer.byteLength(input, "utf8") > MAX_WG_CONFIG_BYTES) {
    errors.push(`The configuration is larger than ${MAX_WG_CONFIG_BYTES / 1024} KB.`);
    return fail();
  }
  // Control characters (NUL, ESC, lone CR, ...) are never valid in a config; tab, LF and CRLF are.
  const text = input.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) {
    errors.push("The configuration contains control characters.");
    return fail();
  }
  if (!text.trim()) {
    errors.push("The configuration is empty.");
    return fail();
  }

  let section: Section | null = null;
  let interfaceCount = 0;
  let peerCount = 0;
  const interfaceLines: ParsedLine[] = [];
  const peerLines: ParsedLine[] = [];

  const rows = text.split("\n");
  for (let index = 0; index < rows.length; index += 1) {
    const lineNo = index + 1;
    const hash = rows[index].indexOf("#");
    const row = (hash >= 0 ? rows[index].slice(0, hash) : rows[index]).trim();
    if (!row) continue;

    if (row.startsWith("[")) {
      if (!row.endsWith("]")) {
        errors.push(`Line ${lineNo}: malformed section header.`);
        continue;
      }
      const name = row.slice(1, -1).trim().toLowerCase();
      if (name === "interface") {
        interfaceCount += 1;
        section = "interface";
        if (interfaceCount > 1)
          errors.push(`Line ${lineNo}: only one [Interface] section is allowed.`);
      } else if (name === "peer") {
        peerCount += 1;
        section = "peer";
        if (peerCount > 1) {
          errors.push(
            `Line ${lineNo}: exactly one [Peer] is supported; remove the additional peers.`
          );
        }
      } else {
        section = null;
        errors.push(
          `Line ${lineNo}: unsupported section; only [Interface] and [Peer] are allowed.`
        );
      }
      continue;
    }

    const eq = row.indexOf("=");
    if (eq <= 0) {
      errors.push(`Line ${lineNo}: expected "Key = Value".`);
      continue;
    }
    if (!section) {
      errors.push(`Line ${lineNo}: setting outside a section.`);
      continue;
    }
    const key = row.slice(0, eq).trim();
    if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key)) {
      errors.push(`Line ${lineNo}: invalid setting name.`);
      continue;
    }
    // Only the parsed line is kept; a peer beyond the first is already an error above.
    (section === "interface" ? interfaceLines : peerLines).push({
      line: lineNo,
      key,
      keyLower: key.toLowerCase(),
      value: row.slice(eq + 1).trim(),
    });
  }

  if (interfaceCount === 0) errors.push("Missing [Interface] section.");
  if (peerCount === 0) errors.push("Missing [Peer] section.");

  // -- [Interface] ------------------------------------------------------------------------------
  let privateKey: string | null = null;
  const addresses: string[] = [];
  const dns: string[] = [];
  let mtu: number | null = null;
  const seenInterface = new Set<string>();

  for (const entry of interfaceLines) {
    const { line, key, keyLower, value } = entry;
    if (HOOK_KEYS.has(keyLower) || keyLower === "listenport") {
      ignored.push({
        line,
        key,
        reason: HOOK_KEYS.has(keyLower)
          ? "Ignored: RedRouter never runs wg-quick hooks or changes host routing."
          : "Ignored: not used by a userspace client.",
      });
      continue;
    }
    if (!INTERFACE_KEYS.has(keyLower)) {
      ignored.push({ line, key, reason: "Ignored: unsupported setting." });
      continue;
    }
    if (keyLower !== "address" && keyLower !== "dns") {
      if (seenInterface.has(keyLower)) {
        errors.push(`Line ${line}: ${key} is set more than once.`);
        continue;
      }
      seenInterface.add(keyLower);
    }
    if (keyLower === "privatekey") {
      if (!isWireGuardKeyText(value))
        errors.push(`Line ${line}: PrivateKey is not a valid WireGuard key.`);
      else privateKey = value;
    } else if (keyLower === "address") {
      const parts = splitList(value);
      if (parts.length === 0) errors.push(`Line ${line}: Address is empty.`);
      for (const part of parts) {
        const cidr = parseCidr(part);
        if (!cidr) errors.push(`Line ${line}: Address contains an invalid IP address.`);
        else if (!addresses.includes(cidr)) addresses.push(cidr);
      }
    } else if (keyLower === "dns") {
      for (const part of splitList(value)) {
        if (isIP(part) && !/[%/]/.test(part)) {
          if (!dns.includes(part)) dns.push(part);
        } else {
          // wg-quick allows search domains here; wireproxy only understands resolver IPs.
          warnings.push(`Line ${line}: DNS entry is not an IP address and was ignored.`);
        }
      }
    } else if (keyLower === "mtu") {
      if (!/^\d{3,4}$/.test(value) || Number(value) < MIN_MTU || Number(value) > MAX_MTU) {
        errors.push(`Line ${line}: MTU must be a number between ${MIN_MTU} and ${MAX_MTU}.`);
      } else {
        mtu = Number(value);
      }
    }
  }

  if (interfaceCount > 0) {
    if (!privateKey && !errors.some((message) => message.includes("PrivateKey"))) {
      errors.push("[Interface] is missing PrivateKey.");
    }
    if (addresses.length === 0 && !errors.some((message) => message.includes("Address"))) {
      errors.push("[Interface] is missing Address.");
    }
  }
  if (addresses.length > MAX_ADDRESSES)
    errors.push(`At most ${MAX_ADDRESSES} addresses are supported.`);
  if (dns.length > MAX_DNS) errors.push(`At most ${MAX_DNS} DNS servers are supported.`);
  if (interfaceCount > 0 && dns.length === 0) {
    warnings.push(
      "No DNS server in the configuration; wireproxy may not resolve names through the tunnel."
    );
  }

  // -- [Peer] -----------------------------------------------------------------------------------
  let publicKey: string | null = null;
  let presharedKey: string | null = null;
  let endpoint: { host: string; port: number } | null = null;
  const allowedIps: string[] = [];
  let keepalive: number | null = null;
  const seenPeer = new Set<string>();

  for (const entry of peerLines) {
    const { line, key, keyLower, value } = entry;
    if (!PEER_KEYS.has(keyLower)) {
      ignored.push({ line, key, reason: "Ignored: unsupported setting." });
      continue;
    }
    if (keyLower !== "allowedips") {
      if (seenPeer.has(keyLower)) {
        errors.push(`Line ${line}: ${key} is set more than once.`);
        continue;
      }
      seenPeer.add(keyLower);
    }
    if (keyLower === "publickey") {
      if (!isWireGuardKeyText(value))
        errors.push(`Line ${line}: PublicKey is not a valid WireGuard key.`);
      else publicKey = value;
    } else if (keyLower === "presharedkey") {
      if (!isWireGuardKeyText(value))
        errors.push(`Line ${line}: PresharedKey is not a valid WireGuard key.`);
      else presharedKey = value;
    } else if (keyLower === "endpoint") {
      endpoint = parseWgEndpoint(value);
      if (!endpoint)
        errors.push(`Line ${line}: Endpoint must be host:port (no scheme, port 1-65535).`);
    } else if (keyLower === "allowedips") {
      for (const part of splitList(value)) {
        const cidr = parseCidr(part);
        if (!cidr) errors.push(`Line ${line}: AllowedIPs contains an invalid network.`);
        else if (!allowedIps.includes(cidr)) allowedIps.push(cidr);
      }
    } else if (keyLower === "persistentkeepalive") {
      if (value.toLowerCase() === "off") keepalive = 0;
      else if (!/^\d{1,5}$/.test(value) || Number(value) > 65535) {
        errors.push(`Line ${line}: PersistentKeepalive must be a number between 0 and 65535.`);
      } else keepalive = Number(value);
    }
  }

  if (peerCount > 0) {
    if (!publicKey && !errors.some((message) => message.includes("PublicKey"))) {
      errors.push("[Peer] is missing PublicKey.");
    }
    if (!endpoint && !errors.some((message) => message.includes("Endpoint"))) {
      errors.push("[Peer] is missing Endpoint.");
    }
  }
  if (allowedIps.length > MAX_ALLOWED_IPS)
    errors.push(`At most ${MAX_ALLOWED_IPS} AllowedIPs are supported.`);
  const defaultV4 = allowedIps.some(
    (cidr) => isIP(cidr.split("/")[0]) === 4 && cidr.endsWith("/0")
  );
  const defaultV6 = allowedIps.some(
    (cidr) => isIP(cidr.split("/")[0]) === 6 && cidr.endsWith("/0")
  );
  if (peerCount > 0 && !(defaultV4 && defaultV6)) {
    warnings.push(
      "AllowedIPs is not a full tunnel; provider traffic is always routed through the tunnel."
    );
  }

  if (errors.length > 0 || !privateKey || !publicKey || !endpoint) return fail();

  return {
    ok: true,
    errors,
    warnings,
    ignored,
    model: {
      privateKey,
      addresses,
      dns,
      mtu,
      peer: {
        publicKey,
        presharedKey,
        endpointHost: endpoint.host,
        endpointPort: endpoint.port,
        allowedIps,
        persistentKeepalive: keepalive,
      },
    },
  };
}

export type WireproxyRenderOptions = {
  /** Loopback TCP port the SOCKS5 listener binds. */
  socksPort: number;
  /** Optional SOCKS5 username/password so other local processes cannot use the tunnel. */
  socksUsername?: string | null;
  socksPassword?: string | null;
};

function endpointText(host: string, port: number): string {
  return isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * Render the wireproxy configuration. Throws on a bad port / credentials (a programming error, not
 * user input). Always binds 127.0.0.1 and always routes everything through the tunnel.
 */
export function renderWireproxyConfig(
  model: WgEgressModel,
  options: WireproxyRenderOptions
): string {
  const { socksPort } = options;
  if (!Number.isInteger(socksPort) || socksPort < 1 || socksPort > 65535) {
    throw new Error("Invalid SOCKS5 port");
  }
  const user = options.socksUsername ?? null;
  const pass = options.socksPassword ?? null;
  if ((user === null) !== (pass === null))
    throw new Error("SOCKS5 credentials must be set together");
  if (
    user !== null &&
    (!/^[A-Za-z0-9_-]{1,64}$/.test(user) || !/^[A-Za-z0-9_-]{1,128}$/.test(String(pass)))
  ) {
    throw new Error("Invalid SOCKS5 credentials");
  }
  // Re-validate the typed fields: the renderer must be safe even when handed a hand-built model.
  if (!isWireGuardKeyText(model.privateKey) || !isWireGuardKeyText(model.peer.publicKey)) {
    throw new Error("Invalid WireGuard key");
  }
  if (model.peer.presharedKey !== null && !isWireGuardKeyText(model.peer.presharedKey)) {
    throw new Error("Invalid WireGuard key");
  }
  if (!parseWgEndpoint(endpointText(model.peer.endpointHost, model.peer.endpointPort))) {
    throw new Error("Invalid endpoint");
  }
  if (
    model.addresses.length === 0 ||
    model.addresses.some((address) => parseCidr(address) !== address)
  ) {
    throw new Error("Invalid address");
  }
  if (model.dns.some((entry) => !isIP(entry))) throw new Error("Invalid DNS server");
  if (
    model.mtu !== null &&
    (!Number.isInteger(model.mtu) || model.mtu < MIN_MTU || model.mtu > MAX_MTU)
  ) {
    throw new Error("Invalid MTU");
  }
  const keepalive =
    model.peer.persistentKeepalive === null
      ? WG_EGRESS_DEFAULT_KEEPALIVE
      : model.peer.persistentKeepalive;
  if (!Number.isInteger(keepalive) || keepalive < 0 || keepalive > 65535) {
    throw new Error("Invalid keepalive");
  }

  const lines: string[] = ["[Interface]", `PrivateKey = ${model.privateKey}`];
  lines.push(`Address = ${model.addresses.join(", ")}`);
  if (model.dns.length > 0) lines.push(`DNS = ${model.dns.join(", ")}`);
  if (model.mtu !== null) lines.push(`MTU = ${model.mtu}`);
  lines.push("", "[Peer]", `PublicKey = ${model.peer.publicKey}`);
  if (model.peer.presharedKey !== null) lines.push(`PresharedKey = ${model.peer.presharedKey}`);
  lines.push(`Endpoint = ${endpointText(model.peer.endpointHost, model.peer.endpointPort)}`);
  lines.push(`AllowedIPs = ${WG_EGRESS_FULL_TUNNEL.join(", ")}`);
  if (keepalive > 0) lines.push(`PersistentKeepalive = ${keepalive}`);
  lines.push("", "[Socks5]", `BindAddress = 127.0.0.1:${socksPort}`);
  if (user !== null) lines.push(`Username = ${user}`, `Password = ${pass}`);
  return `${lines.join("\n")}\n`;
}
