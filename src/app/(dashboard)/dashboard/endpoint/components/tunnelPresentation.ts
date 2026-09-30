/**
 * Pure presentation logic for the Tunnels card: the "x / y active" counter and the status pill and
 * primary action of the Cloudflare Named Tunnel and Tailscale Serve rows. No React, no fetching.
 */

export type TunnelActivity = { visible: boolean; active: boolean };

/** Count the tunnels shown on the card and how many of them are running. Hidden tunnels count for neither. */
export function countTunnels(entries: ReadonlyArray<TunnelActivity>): {
  active: number;
  total: number;
} {
  let active = 0;
  let total = 0;
  for (const entry of entries) {
    if (!entry.visible) continue;
    total += 1;
    if (entry.active) active += 1;
  }
  return { active, total };
}

export type PillTone = "success" | "info" | "default" | "warning" | "danger";

export type NamedTunnelPhase =
  "unsupported" | "not_configured" | "stopped" | "starting" | "running" | "error";
export type ServePhase =
  "unsupported" | "not_installed" | "needs_login" | "stopped" | "running" | "error";

export const NAMED_TUNNEL_PILLS: Record<NamedTunnelPhase, { label: string; tone: PillTone }> = {
  running: { label: "Running", tone: "success" },
  starting: { label: "Starting", tone: "info" },
  stopped: { label: "Stopped", tone: "default" },
  not_configured: { label: "Not configured", tone: "default" },
  unsupported: { label: "Unsupported", tone: "warning" },
  error: { label: "Error", tone: "danger" },
};

export const SERVE_PILLS: Record<ServePhase, { label: string; tone: PillTone }> = {
  running: { label: "Running", tone: "success" },
  needs_login: { label: "Needs login", tone: "info" },
  stopped: { label: "Stopped", tone: "default" },
  not_installed: { label: "Not installed", tone: "default" },
  unsupported: { label: "Unsupported", tone: "warning" },
  error: { label: "Error", tone: "danger" },
};

export type NamedTunnelAction = "set-up" | "enable" | "stop";

/** What the row's primary button does, from the status the API returned. */
export function namedTunnelPrimaryAction(status: {
  configured: boolean;
  running: boolean;
  phase: NamedTunnelPhase;
} | null): NamedTunnelAction {
  if (!status || !status.configured) return "set-up";
  if (status.running || status.phase === "starting") return "stop";
  return "enable";
}

export type ServeAction = "install" | "enable" | "stop";

export function servePrimaryAction(status: {
  installed: boolean;
  running: boolean;
} | null): ServeAction {
  if (!status || !status.installed) return "install";
  return status.running ? "stop" : "enable";
}

/**
 * The internet-exposure notice for a running Named Tunnel. Client routes need an API key only
 * when REQUIRE_API_KEY is on (the authz client-API policy allows anonymous callers otherwise, from
 * any origin), so the notice states which case applies instead of always claiming keys are required.
 */
export function namedTunnelExposureNotice(requireApiKey: boolean): {
  tone: "info" | "warning";
  message: string;
} {
  return requireApiKey
    ? {
        tone: "info",
        message:
          "This endpoint is reachable from the internet. Requests to /v1 need a RedRouter API key.",
      }
    : {
        tone: "warning",
        message:
          "This endpoint is reachable from the internet and Require API Key is off, so anyone with the URL can send requests. Turn on Require API Key in Settings first.",
      };
}
