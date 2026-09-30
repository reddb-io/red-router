/**
 * Proxy-registry `source` values whose rows are owned by another subsystem and follow its
 * lifecycle (a supervised local process). Operators can assign them to scopes like any other
 * proxy, but cannot edit or delete the row by hand: the owner rewrites it, and a manual change
 * could point a "WireGuard" proxy at a plain host and quietly bypass the tunnel.
 *
 * Client-safe leaf: no server imports, so the dashboard can share it with the db layer.
 */
export const WIREGUARD_EGRESS_PROXY_SOURCE = "wireguard-egress";

const MANAGED_PROXY_SOURCES: ReadonlySet<string> = new Set([WIREGUARD_EGRESS_PROXY_SOURCE]);

export function isManagedProxySource(source: unknown): boolean {
  return typeof source === "string" && MANAGED_PROXY_SOURCES.has(source);
}
