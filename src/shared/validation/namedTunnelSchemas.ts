/**
 * Request schemas for the Cloudflare Named Tunnel and Tailscale Serve routes.
 *
 * Client-reachable on purpose (the Endpoint page validates the hostname before it posts), so this
 * file depends on zod only.
 */
import { z } from "zod";

const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const MAX_TOKEN_LENGTH = 4096;
const MIN_TOKEN_LENGTH = 20;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const ALL_DIGITS = /^\d+$/;
// Cloudflare tunnel tokens are base64 of a small JSON document; accept both alphabets.
const TOKEN_CHARSET = /^[A-Za-z0-9+/=_-]+$/;

/** `ok` with the normalised `hostname`, or not `ok` with a `reason` (flat on purpose: TS union narrowing is off under strict:false). */
export type HostnameCheck = { ok: boolean; hostname?: string; reason?: string };

/**
 * Validate the public hostname mapped to this router in Cloudflare Zero Trust (RFC 1123).
 * Bare host names only: no scheme, path, port, credentials or wildcard; no IP literal; not
 * `localhost`. Upper case is accepted and normalised to lower case.
 */
export function checkTunnelHostname(raw: unknown): HostnameCheck {
  if (typeof raw !== "string") return { ok: false, reason: "Hostname must be text" };
  const value = raw.trim().toLowerCase();
  if (!value) return { ok: false, reason: "Hostname is required" };
  if (value.length > MAX_HOSTNAME_LENGTH) {
    return { ok: false, reason: `Hostname must be at most ${MAX_HOSTNAME_LENGTH} characters` };
  }
  if (value.includes("://")) {
    return { ok: false, reason: "Enter the hostname only, without http:// or https://" };
  }
  if (/[/?#@\s:*]/.test(value)) {
    return { ok: false, reason: "Enter the hostname only: no path, port, wildcard or spaces" };
  }
  if (value.endsWith(".")) return { ok: false, reason: "Remove the trailing dot" };

  const labels = value.split(".");
  if (labels.length < 2) {
    return { ok: false, reason: "Enter a full domain name such as ai.example.com" };
  }
  for (const label of labels) {
    if (!label || label.length > MAX_LABEL_LENGTH || !DNS_LABEL.test(label)) {
      return { ok: false, reason: "Hostname contains an invalid label" };
    }
  }
  // An all-numeric last label is an IPv4 literal (or a malformed one), never a public suffix.
  if (ALL_DIGITS.test(labels[labels.length - 1])) {
    return { ok: false, reason: "IP addresses are not allowed; use a domain name" };
  }
  const last = labels[labels.length - 1];
  if (value === "localhost" || last === "localhost") {
    return { ok: false, reason: "localhost is not a public hostname" };
  }
  return { ok: true, hostname: value };
}

/** Pull the token out of whatever the operator pasted (bare token or a full `cloudflared ... <token>` command). */
export function normalizeTunnelToken(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

const hostnameSchema = z.string().transform((value, ctx) => {
  const checked = checkTunnelHostname(value);
  if (!checked.ok) {
    ctx.addIssue({ code: "custom", message: checked.reason });
    return z.NEVER;
  }
  return checked.hostname;
});

const tokenSchema = z
  .string()
  .max(MAX_TOKEN_LENGTH * 2, "Token is too long")
  .transform((value, ctx) => {
    const token = normalizeTunnelToken(value);
    if (token.length < MIN_TOKEN_LENGTH) {
      ctx.addIssue({ code: "custom", message: "Enter the tunnel token from Cloudflare" });
      return z.NEVER;
    }
    if (token.length > MAX_TOKEN_LENGTH || !TOKEN_CHARSET.test(token)) {
      ctx.addIssue({ code: "custom", message: "That does not look like a Cloudflare tunnel token" });
      return z.NEVER;
    }
    return token;
  });

/** Save (or update) the token and hostname. The token is optional once one is stored. */
export const cloudflaredNamedTunnelConfigSchema = z
  .object({
    token: tokenSchema.optional(),
    hostname: hostnameSchema,
  })
  .strict();

export const cloudflaredNamedTunnelActionSchema = z
  .object({ action: z.enum(["enable", "disable", "restart"]) })
  .strict();

export const tailscaleServeActionSchema = z
  .object({
    action: z.enum(["enable", "disable"]),
    sudoPassword: z.string().max(512).optional(),
    hostname: z.string().max(63).optional(),
  })
  .strict();

export type CloudflaredNamedTunnelConfigInput = z.infer<typeof cloudflaredNamedTunnelConfigSchema>;
