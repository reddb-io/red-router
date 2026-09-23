// Claude Code gateway fidelity. When Claude Code talks through RedRouter to an
// Anthropic first-party upstream, Anthropic's gateway protocol asks the gateway
// to pass the request and the answer through unchanged: headers, body fields
// (known or not, e.g. `safeguards`), streaming events (e.g. `safeguard_results`),
// error bodies and rate-limit headers. Server-side auto-mode classifier checks,
// plan-limit display, retries, preserved thinking and prompt-cache attribution
// all depend on it. https://code.claude.com/docs/en/llm-gateway-protocol

const FIRST_PARTY_PROVIDERS = new Set(["claude", "anthropic"]);
const ANTHROPIC_HOST = /(^|\.)api\.anthropic\.com$/i;

/** Whether the upstream is Anthropic's own API (not a third-party Anthropic-format gateway). */
export function isAnthropicFirstParty(provider, credentials = null) {
  if (FIRST_PARTY_PROVIDERS.has(provider)) return true;
  if (typeof provider === "string" && provider.startsWith("anthropic-compatible")) {
    const baseUrl = credentials?.providerSpecificData?.baseUrl || "";
    if (!baseUrl) return true;
    try { return ANTHROPIC_HOST.test(new URL(baseUrl).hostname); } catch { return false; }
  }
  return false;
}

/** The request is Claude Code, on the native path, to Anthropic itself: pass everything through. */
export function isClaudeFaithful({ passthrough, clientTool, provider, credentials = null }) {
  return passthrough === true && clientTool === "claude" && isAnthropicFirstParty(provider, credentials);
}

// Response headers Claude Code reads: plan usage (anthropic-ratelimit-unified-*),
// retry decisions (x-should-retry, retry-after) and the upstream request id.
const FORWARDED_RESPONSE_HEADER = /^(?:anthropic-|x-should-retry$|retry-after$|request-id$)/i;

/** Upstream response headers to hand back to Claude Code unchanged. */
export function forwardedResponseHeaders(response) {
  const out = {};
  const headers = response?.headers;
  if (!headers || typeof headers.forEach !== "function") return out;
  headers.forEach((value, name) => {
    if (FORWARDED_RESPONSE_HEADER.test(name)) out[name] = value;
  });
  return out;
}

// Betas the credential itself needs: an OAuth token is refused without the
// OAuth capability, and a Claude subscription serves Claude Code traffic only.
const OAUTH_REQUIRED_BETAS = ["oauth-2025-04-20", "claude-code-20250219"];

/** The client's anthropic-beta, plus only what our credential requires. */
export function faithfulAnthropicBeta(clientBeta, { oauth = false } = {}) {
  const flags = String(clientBeta || "").split(",").map((f) => f.trim()).filter(Boolean);
  if (oauth) for (const flag of OAUTH_REQUIRED_BETAS) if (!flags.includes(flag)) flags.push(flag);
  return flags.join(",");
}
