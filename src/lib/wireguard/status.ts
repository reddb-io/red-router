/**
 * WireGuard ingress status. Read-only, no root, no processes: whether an interface carrying the
 * configured address exists is answered by `os.networkInterfaces()` (injectable for tests), and
 * whether RedRouter listens on an address the tunnel can reach is answered from the same
 * environment `red-router serve` writes when it starts the server.
 */

import { isIP } from "node:net";
import os from "node:os";
import { getRuntimePorts } from "@/lib/runtime/ports";
import {
  hostCommands,
  serverTunnelIp,
  tunnelApiUrl,
  type WireGuardServerModel,
} from "@/lib/wireguard/serverConfig";

export type WireGuardState = "not_configured" | "configured_interface_down" | "interface_up";

export type BindKind = "all_interfaces" | "wireguard_address" | "loopback" | "other_address";

export type WireGuardBindStatus = {
  host: string;
  /** Where the bind host came from: the env var that carries it, or the loopback default. */
  source: string;
  /** The client API listens through the separate API-port bridge (`API_HOST`), not the server host. */
  apiBridge: boolean;
  kind: BindKind;
  /** True when a packet arriving on the WireGuard address can reach the listener. */
  reachable: boolean;
  warning: string | null;
  note: string | null;
};

export type WireGuardStatus = {
  state: WireGuardState;
  configured: boolean;
  interfaceUp: boolean;
  /** The local interface that carries the configured address, if any. */
  activeInterface: string | null;
  interfaceName: string | null;
  address: string | null;
  serverIp: string | null;
  listenPort: number | null;
  endpointHost: string | null;
  peerCount: number;
  apiPort: number;
  /** Where clients reach RedRouter through the tunnel. */
  apiUrl: string | null;
  bind: WireGuardBindStatus | null;
  commands: { up: string; down: string; status: string } | null;
  /** The interface is up AND the server listens on an address the tunnel reaches. */
  reachable: boolean;
  message: string;
  firewallHint: string | null;
};

export type WireGuardStatusRuntime = {
  networkInterfaces: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;
};

const defaultRuntime: WireGuardStatusRuntime = { networkInterfaces: () => os.networkInterfaces() };
let runtime: WireGuardStatusRuntime = defaultRuntime;

/** Test seam: replace the interface lister; `null` restores the real one. */
export function setWireGuardStatusRuntime(next: Partial<WireGuardStatusRuntime> | null): void {
  runtime = next ? { ...defaultRuntime, ...next } : defaultRuntime;
}

/** Name of the first local interface that has `ip` as an IPv4 address, or null. */
export function findInterfaceWithAddress(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
  ip: string
): string | null {
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      // Node reports the family as "IPv4" (or the number 4 on some releases).
      const family = String(entry.family);
      if ((family === "IPv4" || family === "4") && entry.address === ip) return name;
    }
  }
  return null;
}

/**
 * The address RedRouter listens on for the client API, from the environment `serve` sets. With a
 * separate API port the API bridge binds `API_HOST`; otherwise the server binds the serve host.
 * `HOSTNAME` counts only when it is an IP literal, because it is ordinary shell state elsewhere.
 */
export function resolveBindHost(
  env: NodeJS.ProcessEnv,
  ports: { apiPort: number; dashboardPort: number }
): { host: string; source: string; apiBridge: boolean } {
  if (ports.apiPort !== ports.dashboardPort) {
    return env.API_HOST
      ? { host: env.API_HOST, source: "API_HOST", apiBridge: true }
      : { host: "127.0.0.1", source: "default", apiBridge: true };
  }
  const apiBridge = false;
  if (env.RED_ROUTER_SERVER_HOST) {
    return { host: env.RED_ROUTER_SERVER_HOST, source: "RED_ROUTER_SERVER_HOST", apiBridge };
  }
  if (env.OMNIROUTE_SERVER_HOST) {
    return { host: env.OMNIROUTE_SERVER_HOST, source: "OMNIROUTE_SERVER_HOST", apiBridge };
  }
  if (env.HOSTNAME && isIP(env.HOSTNAME)) return { host: env.HOSTNAME, source: "HOSTNAME", apiBridge };
  return { host: "127.0.0.1", source: "default", apiBridge };
}

function classifyBind(host: string, serverIp: string): BindKind {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "0.0.0.0" || value === "::" || value === "*") return "all_interfaces";
  if (value === serverIp) return "wireguard_address";
  if (value === "localhost" || value === "::1" || value.startsWith("127.")) return "loopback";
  return "other_address";
}

/** Whether the WireGuard address can reach the listener, with the exact fix when it cannot. */
export function assessBind(
  bind: { host: string; source: string; apiBridge: boolean },
  serverIp: string
): WireGuardBindStatus {
  const kind = classifyBind(bind.host, serverIp);
  if (kind === "all_interfaces" || kind === "wireguard_address") {
    return {
      ...bind,
      kind,
      reachable: true,
      warning: null,
      note:
        kind === "all_interfaces"
          ? `RedRouter listens on ${bind.host}, so the endpoint is reachable from the WireGuard address and from your LAN too. To accept only the tunnel, start it with --host ${serverIp} once the interface is up.`
          : null,
    };
  }
  const where =
    kind === "loopback"
      ? `${bind.host} (this machine only)`
      : `${bind.host}, which is not the WireGuard address`;
  const fix =
    bind.apiBridge
      ? `Set API_HOST=0.0.0.0 (or API_HOST=${serverIp}) and restart RedRouter.`
      : `Restart it with "red-router serve --expose" (binds 0.0.0.0) or "red-router serve --host ${serverIp}" (binds only the WireGuard address; start it after the interface is up), or set RED_ROUTER_SERVER_HOST to one of those addresses.`;
  return {
    ...bind,
    kind,
    reachable: false,
    warning: `RedRouter is bound to ${where}, so the WireGuard address ${serverIp} will NOT reach it until it is exposed. ${fix}`,
    note: null,
  };
}

function emptyStatus(apiPort: number): WireGuardStatus {
  return {
    state: "not_configured",
    configured: false,
    interfaceUp: false,
    activeInterface: null,
    interfaceName: null,
    address: null,
    serverIp: null,
    listenPort: null,
    endpointHost: null,
    peerCount: 0,
    apiPort,
    apiUrl: null,
    bind: null,
    commands: null,
    reachable: false,
    message: "WireGuard is not set up. Save an endpoint host to generate the server keys and files.",
    firewallHint: null,
  };
}

/** Status for a stored model (`null` when nothing is configured). */
export function getWireGuardStatus(model: WireGuardServerModel | null): WireGuardStatus {
  const ports = getRuntimePorts();
  if (!model) return emptyStatus(ports.apiPort);

  const serverIp = serverTunnelIp(model);
  const activeInterface = findInterfaceWithAddress(runtime.networkInterfaces(), serverIp);
  const interfaceUp = activeInterface !== null;
  const bind = assessBind(resolveBindHost(process.env, ports), serverIp);
  const commands = hostCommands(model.interfaceName);
  const state: WireGuardState = interfaceUp ? "interface_up" : "configured_interface_down";

  let message: string;
  if (!interfaceUp) {
    message = `No interface with ${serverIp} exists on this machine. Download the server config, then run: ${commands.up}`;
  } else if (!bind.reachable) {
    message = `The interface ${activeInterface} is up, but RedRouter is not listening on it. ${bind.warning}`;
  } else {
    message = `The interface ${activeInterface} is up. Peers reach RedRouter at ${tunnelApiUrl(model, ports.apiPort)}.`;
  }

  return {
    state,
    configured: true,
    interfaceUp,
    activeInterface,
    interfaceName: model.interfaceName,
    address: model.address,
    serverIp,
    listenPort: model.listenPort,
    endpointHost: model.endpointHost || null,
    peerCount: model.peers.length,
    apiPort: ports.apiPort,
    apiUrl: tunnelApiUrl(model, ports.apiPort),
    bind,
    commands,
    reachable: interfaceUp && bind.reachable,
    message,
    firewallHint: `Allow inbound UDP ${model.listenPort} to this machine (and forward it on your router if peers connect from the internet).`,
  };
}
