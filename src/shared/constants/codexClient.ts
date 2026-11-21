// Captured from the official Codex CLI by refresh-cli-identities.mjs. The Rust
// runtime does not install or shell out to provider CLIs; this value preserves
// the compatible OAuth/Responses wire fingerprint. Overridable per deployment.
export const DEFAULT_CODEX_CLIENT_VERSION = "0.163.0";
export const CODEX_CLI_RS_ORIGINATOR = "codex_cli_rs";

export function getCodexCliRsHeaders(
  version = DEFAULT_CODEX_CLIENT_VERSION
): Record<string, string> {
  return {
    "User-Agent": `${CODEX_CLI_RS_ORIGINATOR}/${version}`,
    originator: CODEX_CLI_RS_ORIGINATOR,
  };
}
