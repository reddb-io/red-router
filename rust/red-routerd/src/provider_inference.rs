//! Provider inference for bare model names, ported from the legacy
//! `resolveModelByProviderInference` (`open-sse/services/model.ts`).
//!
//! A model name without a `provider/` prefix and without an alias is matched
//! against the static registry index (`legacy_model_index`) and the
//! providers whose synchronized catalog lists it, then narrowed by the
//! legacy preferences: the Codex subscription for Codex-native names, the
//! opencode free tier, OpenAI for names it catalogs, Claude Code when the
//! operator prefers it, and otherwise the first candidate with an active
//! connection. The live-catalog reconciliation is not ported; the legacy
//! inference behaves the same way when that catalog is unavailable.

use crate::legacy_model_index;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// Bare Codex CLI defaults that prefer the ChatGPT subscription (legacy
/// `CODEX_NATIVE_UNPREFIXED_MODELS`).
const CODEX_NATIVE_UNPREFIXED_MODELS: [&str; 34] = [
    "codex-auto-review",
    "gpt-6-astra",
    "gpt-6-astra-ultra",
    "gpt-6-astra-max",
    "gpt-6-astra-xhigh",
    "gpt-6-astra-high",
    "gpt-6-astra-medium",
    "gpt-6-astra-low",
    "gpt-5.6-sol",
    "gpt-5.6-sol-ultra",
    "gpt-5.6-sol-max",
    "gpt-5.6-sol-xhigh",
    "gpt-5.6-sol-high",
    "gpt-5.6-sol-medium",
    "gpt-5.6-sol-low",
    "gpt-5.6-terra",
    "gpt-5.6-terra-ultra",
    "gpt-5.6-terra-max",
    "gpt-5.6-terra-xhigh",
    "gpt-5.6-terra-high",
    "gpt-5.6-terra-medium",
    "gpt-5.6-terra-low",
    "gpt-5.6-luna",
    "gpt-5.6-luna-max",
    "gpt-5.6-luna-xhigh",
    "gpt-5.6-luna-high",
    "gpt-5.6-luna-medium",
    "gpt-5.6-luna-low",
    "gpt-5.5",
    "gpt-5.5-xhigh",
    "gpt-5.5-high",
    "gpt-5.5-medium",
    "gpt-5.5-low",
    "gpt-5.3-codex-spark",
];

/// Provider-specific legacy model names (legacy `PROVIDER_MODEL_ALIASES`).
const PROVIDER_MODEL_ALIASES: [(&str, &str, &str); 26] = [
    ("openai", "gpt-4o-mini", "gpt-4o-mini"),
    ("github", "claude-4.5-opus", "claude-opus-4-5-20251101"),
    ("github", "claude-opus-4.5", "claude-opus-4-5-20251101"),
    ("github", "gemini-3-pro", "gemini-3.1-pro-preview"),
    ("github", "gemini-3-pro-preview", "gemini-3.1-pro-preview"),
    ("github", "gemini-3-flash", "gemini-3-flash-preview"),
    ("github", "raptor-mini", "oswe-vscode-prime"),
    ("gemini", "gemini-3.1-pro", "gemini-3.1-pro-preview"),
    ("gemini", "gemini-3-1-pro", "gemini-3.1-pro-preview"),
    ("nvidia", "gpt-oss-120b", "openai/gpt-oss-120b"),
    ("nvidia", "nvidia/gpt-oss-120b", "openai/gpt-oss-120b"),
    ("nvidia", "gpt-oss-20b", "openai/gpt-oss-20b"),
    ("nvidia", "nvidia/gpt-oss-20b", "openai/gpt-oss-20b"),
    ("synthetic", "syn:gpt-oss-120b", "hf:openai/gpt-oss-120b"),
    ("synthetic", "syn:large:text", "hf:zai-org/GLM-5.2"),
    (
        "synthetic",
        "syn:large:vision",
        "hf:moonshotai/Kimi-K2.7-Code",
    ),
    ("synthetic", "syn:small:vision", "hf:Qwen/Qwen3.6-27B"),
    ("synthetic", "syn:minimax-m3", "hf:MiniMaxAI/MiniMax-M3"),
    ("synthetic", "syn:small:text", "hf:zai-org/GLM-4.7-Flash"),
    (
        "synthetic",
        "syn:nemotron-3-super",
        "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
    ),
    ("kiro", "claude-opus-4-7", "claude-opus-4.7"),
    ("kiro", "claude-opus-4-6", "claude-opus-4.6"),
    ("kiro", "claude-sonnet-4-6", "claude-sonnet-4.6"),
    ("kiro", "claude-sonnet-4-5", "claude-sonnet-4.5"),
    ("kiro", "claude-haiku-4-5", "claude-haiku-4.5"),
    ("zed-hosted", "claude-haiku-4-5", "claude-haiku-4.5"),
];

#[derive(Deserialize)]
struct ProviderNamesSnapshot {
    canonical: HashMap<String, String>,
    hint_aliases: HashMap<String, String>,
}

static PROVIDER_NAMES: LazyLock<ProviderNamesSnapshot> = LazyLock::new(|| {
    serde_json::from_str(include_str!("legacy_model_providers.json"))
        .expect("built-in legacy model provider snapshot")
});

/// Legacy `resolveProviderAlias` over the indexed providers.
fn canonical_provider(provider: &str) -> &str {
    PROVIDER_NAMES
        .canonical
        .get(provider)
        .map_or(provider, String::as_str)
}

/// Legacy `resolveInferredProviderModel`.
fn provider_model(provider: &str, model: &str) -> String {
    PROVIDER_MODEL_ALIASES
        .iter()
        .find(|(owner, alias, _)| *owner == provider && *alias == model)
        .map_or(model, |(_, _, target)| *target)
        .to_owned()
}

fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    text.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

/// Inputs the legacy inference reads from the database and settings.
pub(crate) struct InferenceContext<'a> {
    /// Canonical ids of providers with an active connection; `None` when the
    /// connection state is unavailable.
    pub(crate) active: Option<&'a HashSet<String>>,
    /// Providers whose synchronized catalog lists the model.
    pub(crate) synced: &'a [String],
    /// `preferClaudeCodeForUnprefixedClaudeModels`.
    pub(crate) prefer_claude_code: bool,
}

impl InferenceContext<'_> {
    fn has_active(&self, provider: &str) -> bool {
        self.active.is_some_and(|active| active.contains(provider))
    }

    /// Legacy `shouldPreferClaudeCodeForUnprefixedClaudeModel`.
    fn prefers_claude_code(&self, model: &str) -> bool {
        self.prefer_claude_code
            && starts_with_ignore_case(model, "claude-")
            && self
                .active
                .is_none_or(|active| active.is_empty() || active.contains("claude"))
    }
}

/// The legacy outcome; the router does not surface the ambiguity and
/// not-found messages yet because bare names it cannot place still reach
/// the active provider.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Inference {
    Provider {
        provider: String,
        model: String,
    },
    #[allow(dead_code)]
    Ambiguous(String),
    #[allow(dead_code)]
    NotFound(String),
}

fn resolved(provider: &str, model: String) -> Inference {
    Inference::Provider {
        provider: provider.to_owned(),
        model,
    }
}

/// Legacy `resolveModelByProviderInference`.
pub(crate) fn infer_provider(model: &str, context: &InferenceContext<'_>) -> Inference {
    let static_providers = legacy_model_index::static_providers_for_model(model);
    if CODEX_NATIVE_UNPREFIXED_MODELS.contains(&model) {
        let has_alternative = static_providers.iter().any(|provider| provider != "codex");
        if !has_alternative || context.has_active("codex") {
            return resolved("codex", model.to_owned());
        }
    }
    // The opencode free tier wins for its names when it is active.
    if model == "big-pickle" || model.ends_with("-free") {
        if let Some(provider) = static_providers.iter().find(|provider| {
            matches!(provider.as_str(), "opencode" | "opencode-zen") && context.has_active(provider)
        }) {
            return resolved(provider, model.to_owned());
        }
    }
    let providers = legacy_model_index::inferred_providers_for_model(model, context.synced);
    let includes = |name: &str| providers.iter().any(|provider| provider == name);
    // Codex-only installations take the overlapping Codex models.
    if context.has_active("codex") && !context.has_active("openai") && includes("codex") {
        return resolved("codex", provider_model("codex", model));
    }
    // The historical OpenAI default for names its catalog lists.
    if includes("openai") {
        return resolved("openai", model.to_owned());
    }
    // Newly released OpenAI-family names no catalog lists yet.
    if providers.is_empty()
        && ["gpt-", "o1", "o3"]
            .iter()
            .any(|prefix| starts_with_ignore_case(model, prefix))
    {
        return resolved("openai", model.to_owned());
    }
    let candidates: Vec<&str> = providers
        .iter()
        .map(String::as_str)
        .filter(|provider| *provider != "openai")
        .collect();
    if candidates.contains(&"claude") && context.prefers_claude_code(model) {
        return resolved("claude", provider_model("claude", model));
    }
    let mut canonical: Vec<&str> = Vec::new();
    for provider in candidates
        .iter()
        .map(|provider| canonical_provider(provider))
    {
        if !canonical.contains(&provider) {
            canonical.push(provider);
        }
    }
    let active_candidates: Vec<&str> = if context.active.is_some_and(|active| !active.is_empty()) {
        canonical
            .iter()
            .copied()
            .filter(|provider| context.has_active(provider))
            .collect()
    } else {
        Vec::new()
    };
    let effective = if active_candidates.is_empty() {
        &canonical
    } else {
        &active_candidates
    };
    if let Some(provider) = effective.first() {
        if !active_candidates.is_empty() || effective.len() == 1 {
            return resolved(provider, provider_model(provider, model));
        }
    }
    if candidates.len() > 1 {
        let hints: Vec<String> = candidates
            .iter()
            .take(2)
            .map(|provider| {
                let alias = PROVIDER_NAMES
                    .hint_aliases
                    .get(*provider)
                    .map_or(*provider, String::as_str);
                format!("{alias}/{model}")
            })
            .collect();
        return Inference::Ambiguous(format!(
            "Ambiguous model '{model}'. Use provider/model prefix (ex: {}).",
            hints.join(" or ")
        ));
    }
    if starts_with_ignore_case(model, "claude-") {
        if context.prefers_claude_code(model) {
            return resolved("claude", model.to_owned());
        }
        if context.has_active("anthropic") {
            return resolved("anthropic", model.to_owned());
        }
    }
    if (starts_with_ignore_case(model, "gemini-") || starts_with_ignore_case(model, "gemma-"))
        && context.has_active("gemini")
    {
        return resolved("gemini", model.to_owned());
    }
    Inference::NotFound(format!(
        "Unable to determine provider for model '{model}'. Use a provider/model prefix (e.g. openai/{model}) or ensure the model is added as a combo entry."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active(providers: &[&str]) -> HashSet<String> {
        providers
            .iter()
            .map(|provider| (*provider).to_owned())
            .collect()
    }

    fn infer(model: &str, active: Option<&HashSet<String>>) -> Inference {
        infer_provider(
            model,
            &InferenceContext {
                active,
                synced: &[],
                prefer_claude_code: false,
            },
        )
    }

    fn provider(name: &str, model: &str) -> Inference {
        resolved(name, model.to_owned())
    }

    #[test]
    fn codex_native_names_prefer_an_active_codex_subscription() {
        let openai_only = active(&["openai"]);
        let both = active(&["openai", "codex"]);
        assert_eq!(infer("gpt-5.5", Some(&both)), provider("codex", "gpt-5.5"));
        // Without codex the bare name keeps the OpenAI default.
        assert_eq!(
            infer("gpt-5.5", Some(&openai_only)),
            provider("openai", "gpt-5.5")
        );
        // Codex-only names resolve to codex even without a connection.
        assert_eq!(
            infer("codex-auto-review", None),
            provider("codex", "codex-auto-review")
        );
    }

    #[test]
    fn opencode_free_names_and_canonical_candidates() {
        let opencode = active(&["opencode"]);
        assert_eq!(
            infer("big-pickle", Some(&opencode)),
            provider("opencode", "big-pickle")
        );
        // Unprefixed, the two opencode spellings are one canonical candidate.
        assert_eq!(
            infer("big-pickle", None),
            provider("opencode-zen", "big-pickle")
        );
    }

    #[test]
    fn active_candidates_win_and_several_inactive_ones_are_ambiguous() {
        let fireworks = active(&["fireworks"]);
        assert_eq!(
            infer("gpt-oss-120b", Some(&fireworks)),
            provider("fireworks", "gpt-oss-120b")
        );
        assert!(matches!(
            infer("gpt-oss-120b", Some(&active(&["unrelated"]))),
            Inference::Ambiguous(message) if message.contains("gpt-oss-120b")
        ));
    }

    #[test]
    fn unknown_names_fall_back_by_family_or_fail() {
        assert_eq!(
            infer("gpt-9-preview", None),
            provider("openai", "gpt-9-preview")
        );
        assert_eq!(
            infer("claude-future", Some(&active(&["anthropic"]))),
            provider("anthropic", "claude-future")
        );
        assert_eq!(
            infer("gemma-9", Some(&active(&["gemini"]))),
            provider("gemini", "gemma-9")
        );
        assert!(matches!(
            infer("no-such-model", None),
            Inference::NotFound(_)
        ));
        let prefers = InferenceContext {
            active: None,
            synced: &[],
            prefer_claude_code: true,
        };
        assert_eq!(
            infer_provider("claude-future", &prefers),
            provider("claude", "claude-future")
        );
    }

    #[test]
    fn synced_catalogs_add_candidates() {
        let synced = ["local-node".to_owned()];
        let context = InferenceContext {
            active: None,
            synced: &synced,
            prefer_claude_code: false,
        };
        assert_eq!(
            infer_provider("private-model", &context),
            provider("local-node", "private-model")
        );
    }
}
