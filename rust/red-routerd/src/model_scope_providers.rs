//! Providers that multiplex independently limited models behind one
//! credential, so a quota failure (402/429) locks one model rather than the
//! whole connection. The static branches of the legacy `hasPerModelQuota`
//! (open-sse/services/accountFallback.ts) are snapshotted in
//! `legacy_model_scope_providers.json`, written by
//! `scripts/research/legacy-model-scope-providers.ts`; compatible providers
//! are matched by prefix as the legacy `isCompatibleProvider` does.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

#[derive(serde::Deserialize)]
struct Snapshot {
    aliases: HashMap<String, String>,
    providers: HashSet<String>,
}

static SNAPSHOT: LazyLock<Snapshot> = LazyLock::new(|| {
    serde_json::from_str(include_str!("legacy_model_scope_providers.json"))
        .expect("the model-scope provider snapshot is valid JSON")
});

/// Legacy `hasPerModelQuota` without a per-connection override (the native
/// override is the account's configured rate-limit scope).
pub(crate) fn has_per_model_quota(provider: &str) -> bool {
    let provider = provider.trim().to_ascii_lowercase();
    if provider.starts_with("openai-compatible") || provider.starts_with("anthropic-compatible") {
        return true;
    }
    let snapshot = &*SNAPSHOT;
    snapshot.providers.contains(&provider)
        || snapshot
            .aliases
            .get(&provider)
            .is_some_and(|canonical| snapshot.providers.contains(canonical))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multiplexing_providers_follow_the_legacy_registry() {
        // The previous hand-written list is a subset of the legacy set.
        for provider in [
            "openrouter",
            "gemini",
            "github",
            "codex",
            "antigravity",
            "agy",
            "kilo-gateway",
            "ollama-cloud",
        ] {
            assert!(has_per_model_quota(provider), "{provider}");
        }
        // Passthrough registry providers, their aliases and compatible nodes.
        for provider in [
            "grok-cli",
            "gc",
            "xai-oauth",
            "openai-compatible",
            "openai-compatible-node-1",
            "anthropic-compatible-x",
        ] {
            assert!(has_per_model_quota(provider), "{provider}");
        }
        for provider in ["openai", "anthropic", "claude", "mistral", "minimax", ""] {
            assert!(!has_per_model_quota(provider), "{provider}");
        }
    }
}
