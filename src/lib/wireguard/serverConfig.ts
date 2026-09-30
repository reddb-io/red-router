/**
 * WireGuard server model and wg-quick renderers. Pure: no I/O, no database, no processes.
 *
 * RedRouter only generates keys and configuration text. The operator brings the interface up on
 * the host (`sudo wg-quick up ./<name>.conf`), so RedRouter itself never needs root. This is a
 * private tunnel to the RedRouter endpoint, not a router: the rendered files carry no
 * PostUp/PostDown/iptables lines and peers get a split tunnel (only the server's own /32).
 *
 * Every value written into a file is re-validated here, so a model that reached storage by some
 * other path still cannot inject a line into the output.
 */

import {
  WG_DEFAULT_ADDRESS,
  WG_DEFAULT_INTERFACE_NAME,
  WG_DEFAULT_LISTEN_PORT,
  checkPeerName,
  checkWireGuardAddress,
  checkWireGuardDns,
  checkWireGuardInterfaceName,
  checkWireGuardPort,
  formatEndpoint,
  formatIPv4,
  parseCidr,
  parseEndpoint,
} from "@/shared/validation/wireguardSchemas";
import { isWireGuardKey } from "./keys";

export const PERSISTENT_KEEPALIVE_SECONDS = 25;

export type WireGuardConfigErrorCode =
  | "invalid_model"
  | "invalid_key"
  | "invalid_peer"
  | "endpoint_required"
  | "subnet_exhausted"
  | "not_configured"
  | "address_locked"
  | "peer_not_found";

/** A validation failure with a fixed, key-free message that is safe to show to the operator. */
export class WireGuardConfigError extends Error {
  readonly code: WireGuardConfigErrorCode;
  constructor(code: WireGuardConfigErrorCode, message: string) {
    super(message);
    this.name = "WireGuardConfigError";
    this.code = code;
  }
}

export type WireGuardPeer = {
  id: string;
  name: string;
  publicKey: string;
  /** The peer's tunnel address, always a /32 inside the server subnet. */
  allowedIp: string;
  createdAt: string;
  /** Whether a preshared key is stored (encrypted) for this peer. */
  hasPresharedKey?: boolean;
  /** Present only while rendering; hydrated from the encrypted store, never persisted here. */
  presharedKey?: string;
};

export type WireGuardServerModel = {
  interfaceName: string;
  address: string;
  listenPort: number;
  /** Public host or IP the peers dial. Empty until the operator sets it. */
  endpointHost: string;
  /** Comma separated resolver addresses written into peer configs; empty for none. */
  dns: string;
  peers: WireGuardPeer[];
};

export function defaultServerModel(): WireGuardServerModel {
  return {
    interfaceName: WG_DEFAULT_INTERFACE_NAME,
    address: WG_DEFAULT_ADDRESS,
    listenPort: WG_DEFAULT_LISTEN_PORT,
    endpointHost: "",
    dns: "",
    peers: [],
  };
}

/** The server's own tunnel IP, without the prefix. */
export function serverTunnelIp(model: Pick<WireGuardServerModel, "address">): string {
  const parsed = parseCidr(model.address);
  if (!parsed) throw new WireGuardConfigError("invalid_model", "The server address is not valid");
  return formatIPv4(parsed.ip);
}

/** `host:port` the peers dial. */
export function peerEndpointFor(model: Pick<WireGuardServerModel, "endpointHost" | "listenPort">): string {
  if (!model.endpointHost) {
    throw new WireGuardConfigError("endpoint_required", "Set the endpoint host before adding peers");
  }
  return formatEndpoint(model.endpointHost, model.listenPort);
}

/** The RedRouter URL clients use through the tunnel. */
export function tunnelApiUrl(model: Pick<WireGuardServerModel, "address">, apiPort: number): string {
  return `http://${serverTunnelIp(model)}:${apiPort}/v1`;
}

/** The exact host commands the operator runs; the file name is the validated interface name. */
export function hostCommands(interfaceName: string): { up: string; down: string; status: string } {
  return {
    up: `sudo wg-quick up ./${interfaceName}.conf`,
    down: `sudo wg-quick down ./${interfaceName}.conf`,
    status: `sudo wg show ${interfaceName}`,
  };
}

/**
 * The next free host address in the server subnet as a /32, lowest first. The network and
 * broadcast addresses, the server's own address and every address already handed to a peer are
 * skipped.
 */
export function allocatePeerAddress(
  model: Pick<WireGuardServerModel, "address" | "peers">
): string {
  const subnet = parseCidr(model.address);
  if (!subnet) throw new WireGuardConfigError("invalid_model", "The server address is not valid");
  const used = new Set<number>([subnet.ip]);
  for (const peer of model.peers) {
    const parsed = parseCidr(peer.allowedIp);
    if (parsed) used.add(parsed.ip);
  }
  for (let candidate = subnet.network + 1; candidate < subnet.broadcast; candidate += 1) {
    if (!used.has(candidate)) return `${formatIPv4(candidate)}/32`;
  }
  throw new WireGuardConfigError(
    "subnet_exhausted",
    "There are no free addresses left in the WireGuard subnet. Remove a peer or use a larger subnet."
  );
}

// --- rendering --------------------------------------------------------------------------------

function requireKey(value: unknown, label: string): string {
  if (!isWireGuardKey(value)) {
    throw new WireGuardConfigError("invalid_key", `${label} is not a valid WireGuard key`);
  }
  return value;
}

function assertPeerInSubnet(peer: WireGuardPeer, subnet: ReturnType<typeof parseCidr>): string {
  const parsed = parseCidr(peer.allowedIp);
  if (
    !parsed ||
    parsed.prefix !== 32 ||
    !subnet ||
    parsed.ip <= subnet.network ||
    parsed.ip >= subnet.broadcast ||
    parsed.ip === subnet.ip
  ) {
    throw new WireGuardConfigError("invalid_peer", "A peer address is outside the WireGuard subnet");
  }
  return parsed.cidr;
}

/** A `# name` comment line; the name is sanitised to a single line of at most 64 characters. */
function commentLine(prefix: string, name: string): string {
  const checked = checkPeerName(name);
  return `# ${prefix}${checked.ok ? checked.value : "unnamed"}`;
}

/**
 * The server's wg-quick file. Contains the server private key (and any preshared keys), so the
 * caller must treat the text as a secret. One `[Peer]` per peer, each allowed only its own /32.
 */
export function renderServerConf(model: WireGuardServerModel, serverPrivateKey: string): string {
  const iface = checkWireGuardInterfaceName(model.interfaceName);
  const address = checkWireGuardAddress(model.address);
  const port = checkWireGuardPort(model.listenPort);
  if (!iface.ok || !address.ok || !port.ok) {
    throw new WireGuardConfigError("invalid_model", "The WireGuard server settings are not valid");
  }
  const subnet = parseCidr(address.value as string);
  const lines: string[] = [
    `# RedRouter WireGuard server "${iface.value}". This file contains a private key: chmod 600 it.`,
    `# Bring the interface up on this machine with: sudo wg-quick up ./${iface.value}.conf`,
    "[Interface]",
    `PrivateKey = ${requireKey(serverPrivateKey, "The server private key")}`,
    `Address = ${address.value}`,
    `ListenPort = ${port.value}`,
  ];
  for (const peer of model.peers) {
    lines.push(
      "",
      commentLine("peer: ", peer.name),
      "[Peer]",
      `PublicKey = ${requireKey(peer.publicKey, "A peer public key")}`
    );
    if (peer.presharedKey !== undefined) {
      lines.push(`PresharedKey = ${requireKey(peer.presharedKey, "A preshared key")}`);
    }
    lines.push(`AllowedIPs = ${assertPeerInSubnet(peer, subnet)}`);
  }
  return `${lines.join("\n")}\n`;
}

export type PeerConfInput = {
  peerPrivateKey: string;
  /** The peer's own tunnel address, a /32 such as 10.99.0.2/32. */
  peerAddress: string;
  /** The server's tunnel address; only its /32 is routed through the tunnel (split tunnel). */
  serverAddress: string;
  serverPublicKey: string;
  /** `host:port` the server listens on. */
  endpoint: string;
  presharedKey?: string;
  dns?: string;
  /** Display name, written as a comment only. */
  name?: string;
};

/**
 * A peer's wg-quick file. `AllowedIPs` is the server's /32 only, so the peer's other traffic is
 * untouched and 0.0.0.0/0 can never appear; `PersistentKeepalive` keeps NAT mappings open.
 */
export function renderPeerConf(input: PeerConfInput): string {
  const peerAddress = parseCidr(input.peerAddress);
  const serverAddress = parseCidr(input.serverAddress);
  if (!peerAddress || peerAddress.prefix !== 32 || !serverAddress) {
    throw new WireGuardConfigError("invalid_model", "A tunnel address is not valid");
  }
  const endpoint = parseEndpoint(input.endpoint);
  if (!endpoint.ok) {
    throw new WireGuardConfigError("endpoint_required", "The endpoint is not valid");
  }
  const dns = input.dns ? checkWireGuardDns(input.dns) : { ok: true, value: "" };
  if (!dns.ok) throw new WireGuardConfigError("invalid_model", "The DNS servers are not valid");

  const lines: string[] = [
    commentLine("RedRouter WireGuard peer: ", input.name ?? "unnamed"),
    "[Interface]",
    `PrivateKey = ${requireKey(input.peerPrivateKey, "The peer private key")}`,
    `Address = ${peerAddress.cidr}`,
  ];
  if (dns.value) lines.push(`DNS = ${dns.value}`);
  lines.push(
    "",
    "[Peer]",
    `PublicKey = ${requireKey(input.serverPublicKey, "The server public key")}`
  );
  if (input.presharedKey !== undefined) {
    lines.push(`PresharedKey = ${requireKey(input.presharedKey, "The preshared key")}`);
  }
  lines.push(
    `Endpoint = ${formatEndpoint(endpoint.value.host, endpoint.value.port)}`,
    `AllowedIPs = ${formatIPv4(serverAddress.ip)}/32`,
    `PersistentKeepalive = ${PERSISTENT_KEEPALIVE_SECONDS}`
  );
  return `${lines.join("\n")}\n`;
}
