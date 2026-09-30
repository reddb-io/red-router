/**
 * Field validators and request schemas for the WireGuard ingress routes.
 *
 * Client-reachable on purpose (the Endpoint page validates before it posts), so this file depends
 * on zod only: no `node:net`, no `@/lib/*`. Every value that ends up inside a rendered wg-quick
 * file goes through one of these validators first.
 */
import { z } from "zod";

export const WG_DEFAULT_INTERFACE_NAME = "wg-redrouter";
export const WG_DEFAULT_ADDRESS = "10.99.0.1/24";
export const WG_DEFAULT_LISTEN_PORT = 51820;
export const WG_PEER_NAME_MAX = 64;

const INTERFACE_NAME = /^[a-zA-Z0-9_=+.-]{1,15}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PEER_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** Flat on purpose: TS union narrowing is off under strict:false. */
export type FieldCheck<T> = { ok: boolean; value?: T; reason?: string };

const fail = <T>(reason: string): FieldCheck<T> => ({ ok: false, reason });
const pass = <T>(value: T): FieldCheck<T> => ({ ok: true, value });

// --- IPv4 -----------------------------------------------------------------------------------

/** Dotted quad to an unsigned 32-bit number; null for anything that is not a plain IPv4 address. */
export function parseIPv4(value: string): number | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return null;
  let out = 0;
  for (let i = 1; i <= 4; i += 1) {
    const part = match[i];
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

export function formatIPv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

export function prefixMask(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function isPrivateIPv4(value: number): boolean {
  const first = value >>> 24;
  const second = (value >>> 16) & 255;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

export type ParsedCidr = {
  /** Normalised `a.b.c.d/nn`. */
  cidr: string;
  ip: number;
  prefix: number;
  network: number;
  broadcast: number;
};

/** Parse `a.b.c.d/nn` without any policy beyond well-formedness. */
export function parseCidr(value: string): ParsedCidr | null {
  const match = /^([0-9.]{7,15})\/(\d{1,2})$/.exec(value);
  if (!match) return null;
  const ip = parseIPv4(match[1]);
  const prefix = Number(match[2]);
  if (ip === null || prefix > 32 || (match[2].length > 1 && match[2].startsWith("0"))) return null;
  const mask = prefixMask(prefix);
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { cidr: `${formatIPv4(ip)}/${prefix}`, ip, prefix, network, broadcast };
}

/**
 * The server's tunnel address: a host address inside an RFC 1918 subnet, /8 to /30, that is neither
 * the network nor the broadcast address. Overlap with LAN or Docker ranges is the operator's call.
 */
export function checkWireGuardAddress(raw: unknown): FieldCheck<string> {
  if (typeof raw !== "string") return fail("Address must be text");
  const parsed = parseCidr(raw.trim());
  if (!parsed) return fail("Enter an IPv4 address with a prefix, such as 10.99.0.1/24");
  if (parsed.prefix < 8 || parsed.prefix > 30) return fail("The prefix length must be between 8 and 30");
  if (!isPrivateIPv4(parsed.network) || !isPrivateIPv4(parsed.broadcast)) {
    return fail("Use a private IPv4 range (10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16)");
  }
  if (parsed.ip === parsed.network || parsed.ip === parsed.broadcast) {
    return fail("The address must be a host address, not the network or broadcast address");
  }
  return pass(parsed.cidr);
}

// --- IPv6 (validation only) -------------------------------------------------------------------

function expandIPv6(value: string): number[] | null {
  if (!/^[0-9a-fA-F:]+$/.test(value)) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const all = [...head, ...tail];
  if (all.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group))) return null;
  if (halves.length === 2) {
    if (all.length > 7) return null;
    const fill = new Array<number>(8 - all.length).fill(0);
    return [...head, ...fill.map(String), ...tail].map((g) => parseInt(g, 16));
  }
  return all.length === 8 ? all.map((g) => parseInt(g, 16)) : null;
}

// --- endpoint host ----------------------------------------------------------------------------

/**
 * The public host or address peers dial. Bare host only: no scheme, port, path, credentials or
 * whitespace. Hostnames are lower-cased; `[v6]` brackets are accepted and dropped. Loopback and
 * unspecified addresses are refused because no peer could ever reach them.
 */
export function checkWireGuardEndpointHost(raw: unknown): FieldCheck<string> {
  if (typeof raw !== "string") return fail("Endpoint host must be text");
  let value = raw.trim();
  if (!value) return fail("Endpoint host is required");
  if (value.length > 253) return fail("Endpoint host must be at most 253 characters");
  if (value.includes("://")) return fail("Enter the host only, without http:// or https://");
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (/[/?#@\s*[\]\\,;=]/.test(value)) {
    return fail("Enter the host only: no path, port, wildcard, spaces or brackets");
  }

  if (value.includes(":")) {
    const groups = expandIPv6(value);
    if (!groups) return fail("Enter a hostname, an IPv4 address or an IPv6 address (the port is set separately)");
    const isZero = groups.every((g) => g === 0);
    const isLoopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
    if (isZero || isLoopback) return fail("A loopback or unspecified address cannot be reached by peers");
    return pass(value.toLowerCase());
  }

  if (/^[0-9.]+$/.test(value)) {
    const ip = parseIPv4(value);
    if (ip === null) return fail("That is not a valid IPv4 address");
    if (ip === 0 || ip >>> 24 === 127) return fail("A loopback or unspecified address cannot be reached by peers");
    return pass(formatIPv4(ip));
  }

  const host = value.toLowerCase();
  if (host.endsWith(".")) return fail("Remove the trailing dot");
  const labels = host.split(".");
  for (const label of labels) {
    if (!label || !DNS_LABEL.test(label)) return fail("Endpoint host contains an invalid label");
  }
  if (/^\d+$/.test(labels[labels.length - 1])) return fail("That is not a valid IPv4 address");
  if (host === "localhost" || labels[labels.length - 1] === "localhost") {
    return fail("localhost cannot be reached by peers");
  }
  return pass(host);
}

/** `host:port` as it goes into a peer's `Endpoint =` line (IPv6 hosts are bracketed). */
export function formatEndpoint(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Inverse of `formatEndpoint`, validating both halves. */
export function parseEndpoint(raw: unknown): FieldCheck<{ host: string; port: number }> {
  if (typeof raw !== "string") return fail("Endpoint must be text");
  const match = /^(?:\[([0-9a-fA-F:]+)\]|([^:\s[\]]+)):(\d{1,5})$/.exec(raw.trim());
  if (!match) return fail("Endpoint must look like host:port");
  const host = checkWireGuardEndpointHost(match[1] ?? match[2]);
  if (!host.ok) return fail(host.reason as string);
  const port = checkWireGuardPort(Number(match[3]));
  if (!port.ok) return fail(port.reason as string);
  return pass({ host: host.value as string, port: port.value as number });
}

// --- the remaining scalar fields --------------------------------------------------------------

export function checkWireGuardInterfaceName(raw: unknown): FieldCheck<string> {
  if (typeof raw !== "string") return fail("Interface name must be text");
  const value = raw.trim();
  if (!INTERFACE_NAME.test(value)) {
    return fail("Use 1 to 15 letters, digits or _ = + . - (no spaces or slashes)");
  }
  // The name becomes a file name (<name>.conf) and is typed into shell commands.
  if (/^\.+$/.test(value) || value.startsWith("-")) {
    return fail("The interface name cannot be only dots or start with a dash");
  }
  return pass(value);
}

export function checkWireGuardPort(raw: unknown): FieldCheck<number> {
  const value = typeof raw === "string" && /^\d{1,5}$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    return fail("The port must be a whole number between 1 and 65535");
  }
  return pass(value);
}

/** Up to three resolver addresses, comma separated. Empty text means "no DNS line". */
export function checkWireGuardDns(raw: unknown): FieldCheck<string> {
  if (typeof raw !== "string") return fail("DNS must be text");
  const parts = raw.split(/[,\s]+/).filter(Boolean);
  if (parts.length === 0) return pass("");
  if (parts.length > 3) return fail("Enter at most three DNS servers");
  for (const part of parts) {
    const isV4 = parseIPv4(part) !== null;
    const isV6 = part.includes(":") && expandIPv6(part) !== null;
    if (!isV4 && !isV6) return fail(`"${part.slice(0, 40)}" is not an IP address`);
  }
  return pass(parts.join(", "));
}

/**
 * A peer's display name. Control characters, line and paragraph separators and bidi/zero-width
 * marks are replaced by spaces, whitespace is collapsed and the result is cut to 64 characters.
 * Names only ever appear in a `# name` comment, so no line of a rendered file can be forged
 * through one; the stripping is what keeps the comment on a single line.
 */
export function sanitizePeerName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let out = "";
  for (const char of raw) {
    const code = char.codePointAt(0) as number;
    const invisible =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff;
    out += invisible ? " " : char;
  }
  return Array.from(out.replace(/\s+/g, " ").trim())
    .slice(0, WG_PEER_NAME_MAX)
    .join("")
    .trim();
}

export function checkPeerName(raw: unknown): FieldCheck<string> {
  if (typeof raw !== "string") return fail("Name must be text");
  if (raw.length > 512) return fail("Name is too long");
  const value = sanitizePeerName(raw);
  return value ? pass(value) : fail("Enter a name for this device");
}

export function isValidPeerId(value: unknown): value is string {
  return typeof value === "string" && PEER_ID.test(value);
}

/** A file-name-safe slug of a peer name for the downloaded `.conf`. */
export function peerFileSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug || "peer";
}

// --- zod schemas ------------------------------------------------------------------------------

function fieldSchema<T>(check: (raw: unknown) => FieldCheck<T>) {
  return z.string().transform((value, ctx) => {
    const result = check(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.reason });
      return z.NEVER;
    }
    return result.value as T;
  });
}

const portSchema = z.union([z.number(), z.string().max(8)]).transform((value, ctx) => {
  const result = checkWireGuardPort(value);
  if (!result.ok) {
    ctx.addIssue({ code: "custom", message: result.reason });
    return z.NEVER;
  }
  return result.value as number;
});

/**
 * Save the server settings. `endpointHost` is always required (peer configs cannot be rendered
 * without it); every other field keeps its stored value, or its default on the first save.
 */
export const wireguardConfigSchema = z
  .object({
    endpointHost: fieldSchema(checkWireGuardEndpointHost),
    interfaceName: fieldSchema(checkWireGuardInterfaceName).optional(),
    address: fieldSchema(checkWireGuardAddress).optional(),
    listenPort: portSchema.optional(),
    dns: fieldSchema(checkWireGuardDns).optional(),
  })
  .strict();

export const wireguardPeerAddSchema = z
  .object({
    name: fieldSchema(checkPeerName),
    usePresharedKey: z.boolean().optional(),
  })
  .strict();

export const wireguardActionSchema = z
  .object({
    action: z.literal("rotate-server-key"),
    currentPassword: z.string().max(200).optional(),
  })
  .strict();

export type WireGuardConfigInput = z.infer<typeof wireguardConfigSchema>;
