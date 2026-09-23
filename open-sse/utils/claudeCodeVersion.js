// The Claude Code version RedRouter advertises to Anthropic (User-Agent and the
// billing header's cc_version). Anthropic gates new models on it and answers an
// older one with 400 `claude_code_version_too_old` ("... version X.Y.Z or newer is
// required"), so the router adopts the version that error names instead of waiting
// for a release that bumps CLAUDE_CLI_VERSION.
//
// Resolution: RED_ROUTER_CLAUDE_CODE_VERSION (operator override, always wins) >
// the version adopted from an upstream error (process-wide, only ever raised) >
// the built-in CLAUDE_CLI_VERSION.
import { CLAUDE_CLI_VERSION } from "../providers/shared.js";

export const CLAUDE_CODE_VERSION_ENV = "RED_ROUTER_CLAUDE_CODE_VERSION";

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const TOO_OLD_CODE = "claude_code_version_too_old";
const REQUIRED_RE = /(\d+\.\d+\.\d+)\s+or\s+newer\s+is\s+required/i;
const BILLING_PREFIX = "x-anthropic-billing-header:";
const BILLING_VERSION_RE = /cc_version=\d+\.\d+\.\d+/;

let adopted = null;

export function getClaudeCodeVersion() {
  return envOverride() || adopted || CLAUDE_CLI_VERSION;
}

export function claudeCodeUserAgent() {
  return `claude-cli/${getClaudeCodeVersion()} (external, sdk-cli)`;
}

/** The version a `claude_code_version_too_old` 400 asks for, or null for any other response. */
export function parseRequiredClaudeCodeVersion(status, text) {
  if (status !== 400 || typeof text !== "string" || !text.includes(TOO_OLD_CODE)) return null;
  return text.match(REQUIRED_RE)?.[1] || null;
}

/**
 * Adopt `version` process-wide when it is newer than the one advertised now.
 * Never lowers the version and never overrides the env pin.
 * @returns {boolean} true when the advertised version changed
 */
export function adoptClaudeCodeVersion(version) {
  if (envOverride() || !VERSION_RE.test(String(version || ""))) return false;
  if (compareVersions(version, getClaudeCodeVersion()) <= 0) return false;
  adopted = version;
  return true;
}

/** True when the advertised version is at least `version`. */
export function advertisesClaudeCodeVersion(version) {
  return compareVersions(getClaudeCodeVersion(), version) >= 0;
}

/** Test hook: forget an adopted version. */
export function resetAdoptedClaudeCodeVersion() {
  adopted = null;
}

/**
 * Rewrite the cc_version in an injected billing header (system[0]) to the version
 * advertised now. Returns a new body; the input is left untouched because the
 * caller reuses it across account-fallback attempts.
 */
export function withCurrentBillingVersion(body) {
  const first = Array.isArray(body?.system) ? body.system[0] : null;
  if (typeof first?.text !== "string" || !first.text.startsWith(BILLING_PREFIX)) return body;
  const text = first.text.replace(BILLING_VERSION_RE, `cc_version=${getClaudeCodeVersion()}`);
  return { ...body, system: [{ ...first, text }, ...body.system.slice(1)] };
}

function envOverride() {
  const value = process.env[CLAUDE_CODE_VERSION_ENV]?.trim();
  return value && VERSION_RE.test(value) ? value : null;
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}
