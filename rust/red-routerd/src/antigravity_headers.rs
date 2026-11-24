// Dead code until the IDE profile is wired into the request path (step 3 of the Antigravity IDE plan in
// docs/architecture/RUSTIFY_HANDOFF.md); remove this allow when it is.
#![allow(dead_code)]

//! Antigravity client identity headers (legacy `open-sse/services/antigravityHeaders.ts`).
//!
//! The upstream backend expects the native macOS client fingerprint, so the OS
//! and architecture tokens of the user agents are pinned to `darwin/arm64`
//! whatever the host is (legacy #8098). The IDE, CLI and IDE-Node user agents
//! stay distinct (legacy #8013).

use serde_json::{json, Value};

/// Legacy `ANTIGRAVITY_IDE_FALLBACK_VERSION` and `ANTIGRAVITY_CLI_FALLBACK_VERSION`.
pub const IDE_FALLBACK_VERSION: &str = "2.1.1";
pub const CLI_FALLBACK_VERSION: &str = "1.1.5";

pub const IDE_NODE_API_CLIENT: &str = "google-api-nodejs-client/10.3.0";
pub const IDE_NODE_X_GOOG_API_CLIENT: &str = "gl-node/22.21.1";

const OS_TYPE: &str = "darwin";
const ARCH: &str = "arm64";

/// Legacy `AntigravityClientProfile`; `ide` is the default, and the old
/// `harness` and `sdk` spellings read as `cli`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClientProfile {
    Ide,
    Cli,
}

impl ClientProfile {
    /// Legacy `normalizeAntigravityClientProfile`.
    pub fn normalize(value: Option<&Value>) -> Self {
        match value
            .and_then(Value::as_str)
            .map(|value| value.trim().to_lowercase())
            .as_deref()
        {
            Some("ide") => Self::Ide,
            Some("cli" | "harness" | "sdk") => Self::Cli,
            _ => Self::Ide,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ide => "ide",
            Self::Cli => "cli",
        }
    }
}

pub fn ide_user_agent(version: &str) -> String {
    format!("antigravity/ide/{version} {OS_TYPE}/{ARCH}")
}

pub fn cli_user_agent(version: &str, auth_method: &str) -> String {
    format!("antigravity/cli/{version} (aidev_client; os_type={OS_TYPE}; arch={ARCH}; auth_method={auth_method})")
}

pub fn ide_node_user_agent(version: &str) -> String {
    format!("antigravity/{version} {OS_TYPE}/{ARCH} {IDE_NODE_API_CLIENT}")
}

/// Legacy `getAntigravityOAuthUserAgent` at the fallback versions.
pub fn oauth_user_agent(profile: ClientProfile) -> String {
    match profile {
        ClientProfile::Cli => cli_user_agent(CLI_FALLBACK_VERSION, "consumer"),
        ClientProfile::Ide => ide_node_user_agent(IDE_FALLBACK_VERSION),
    }
}

fn with_bearer(
    mut headers: Vec<(&'static str, String)>,
    token: Option<&str>,
) -> Vec<(&'static str, String)> {
    if let Some(token) = token.filter(|token| !token.is_empty()) {
        headers.push(("Authorization", format!("Bearer {token}")));
    }
    headers
}

/// Legacy `getAntigravityContentHeaders` at the fallback versions.
pub fn content_headers(profile: ClientProfile, token: Option<&str>) -> Vec<(&'static str, String)> {
    let agent = match profile {
        ClientProfile::Cli => cli_user_agent(CLI_FALLBACK_VERSION, "consumer"),
        ClientProfile::Ide => ide_user_agent(IDE_FALLBACK_VERSION),
    };
    with_bearer(
        vec![
            ("Content-Type", "application/json".to_owned()),
            ("User-Agent", agent),
        ],
        token,
    )
}

/// Legacy `getAntigravityIdeNodeHeaders` at the fallback version.
pub fn ide_node_headers(token: Option<&str>) -> Vec<(&'static str, String)> {
    with_bearer(
        vec![
            ("Content-Type", "application/json".to_owned()),
            ("User-Agent", ide_node_user_agent(IDE_FALLBACK_VERSION)),
            ("X-Goog-Api-Client", IDE_NODE_X_GOOG_API_CLIENT.to_owned()),
        ],
        token,
    )
}

/// Legacy `resolveAntigravityPlatformEnum` for an explicit host: the wire
/// enum of `loadCodeAssist` metadata (unspecified 0, darwin amd64/arm64 1/2,
/// linux amd64/arm64 3/4, windows amd64 5).
pub fn platform_enum(os: &str, arch: &str) -> u8 {
    match (os, arch) {
        ("macos" | "darwin", "aarch64" | "arm64") => 2,
        ("macos" | "darwin", _) => 1,
        ("linux", "aarch64" | "arm64") => 4,
        ("linux", _) => 3,
        ("windows" | "win32", _) => 5,
        _ => 0,
    }
}

/// Legacy `getAntigravityLoadCodeAssistMetadata`: `ideType` and `pluginType`
/// are int32 enums on the wire, and `platform` is required.
pub fn load_code_assist_metadata(os: &str, arch: &str) -> Value {
    json!({"ideType": 9, "platform": platform_enum(os, arch), "pluginType": 2})
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected strings are the legacy functions' outputs at the fallback versions.
    #[test]
    fn user_agents_match_the_legacy_strings() {
        assert_eq!(
            ide_user_agent("2.1.1"),
            "antigravity/ide/2.1.1 darwin/arm64"
        );
        assert_eq!(
            cli_user_agent("1.1.5", "consumer"),
            "antigravity/cli/1.1.5 (aidev_client; os_type=darwin; arch=arm64; auth_method=consumer)"
        );
        assert_eq!(
            ide_node_user_agent("2.1.1"),
            "antigravity/2.1.1 darwin/arm64 google-api-nodejs-client/10.3.0"
        );
        assert_eq!(
            oauth_user_agent(ClientProfile::Cli),
            cli_user_agent("1.1.5", "consumer")
        );
        assert_eq!(
            oauth_user_agent(ClientProfile::Ide),
            ide_node_user_agent("2.1.1")
        );
    }

    #[test]
    fn headers_follow_the_profile_and_add_bearer_only_with_a_token() {
        assert_eq!(
            content_headers(ClientProfile::Ide, Some("tok")),
            vec![
                ("Content-Type", "application/json".to_owned()),
                (
                    "User-Agent",
                    "antigravity/ide/2.1.1 darwin/arm64".to_owned()
                ),
                ("Authorization", "Bearer tok".to_owned()),
            ]
        );
        assert_eq!(content_headers(ClientProfile::Cli, None).len(), 2);
        assert_eq!(content_headers(ClientProfile::Cli, Some("")).len(), 2);
        assert_eq!(
            ide_node_headers(Some("tok")),
            vec![
                ("Content-Type", "application/json".to_owned()),
                (
                    "User-Agent",
                    "antigravity/2.1.1 darwin/arm64 google-api-nodejs-client/10.3.0".to_owned()
                ),
                ("X-Goog-Api-Client", "gl-node/22.21.1".to_owned()),
                ("Authorization", "Bearer tok".to_owned()),
            ]
        );
    }

    #[test]
    fn load_code_assist_metadata_uses_wire_enums() {
        assert_eq!(
            load_code_assist_metadata("linux", "x86_64"),
            json!({"ideType":9,"platform":3,"pluginType":2})
        );
        assert_eq!(platform_enum("linux", "aarch64"), 4);
        assert_eq!(platform_enum("macos", "aarch64"), 2);
        assert_eq!(platform_enum("macos", "x86_64"), 1);
        assert_eq!(platform_enum("windows", "x86_64"), 5);
        assert_eq!(platform_enum("freebsd", "x86_64"), 0);
    }

    #[test]
    fn the_profile_defaults_to_ide_and_reads_the_old_cli_spellings() {
        assert_eq!(ClientProfile::normalize(None), ClientProfile::Ide);
        assert_eq!(
            ClientProfile::normalize(Some(&json!(" CLI "))),
            ClientProfile::Cli
        );
        assert_eq!(
            ClientProfile::normalize(Some(&json!("harness"))),
            ClientProfile::Cli
        );
        assert_eq!(
            ClientProfile::normalize(Some(&json!("sdk"))),
            ClientProfile::Cli
        );
        assert_eq!(
            ClientProfile::normalize(Some(&json!("ide"))),
            ClientProfile::Ide
        );
        assert_eq!(
            ClientProfile::normalize(Some(&json!("other"))),
            ClientProfile::Ide
        );
        assert_eq!(
            ClientProfile::normalize(Some(&json!(3))),
            ClientProfile::Ide
        );
    }
}
