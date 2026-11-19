//! The legacy static model -> provider index (`MODEL_TO_PROVIDERS` and
//! `getInferredProvidersForModel` in `open-sse/services/model.ts`), the
//! first input of the provider inference for bare model names.
//!
//! The index is a snapshot of the legacy provider registry catalogs in
//! `legacy_model_providers.json`, written by
//! `scripts/research/legacy-model-providers.ts`; each model lists its
//! providers in registry order, which the inference relies on.

// The bare-name provider inference that consumes this index is ported next.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::LazyLock;

#[derive(serde::Deserialize)]
struct ModelProvidersSnapshot {
    models: Vec<(String, Vec<String>)>,
}

static MODEL_TO_PROVIDERS: LazyLock<HashMap<String, Vec<String>>> = LazyLock::new(|| {
    let snapshot: ModelProvidersSnapshot =
        serde_json::from_str(include_str!("legacy_model_providers.json"))
            .expect("built-in legacy model provider snapshot");
    snapshot.models.into_iter().collect()
});

/// Providers whose static catalog lists `model`, in registry order.
pub(crate) fn static_providers_for_model(model: &str) -> &'static [String] {
    MODEL_TO_PROVIDERS
        .get(model)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// Legacy `KNOWN_MODEL_IDS`.
pub(crate) fn is_known_model(model: &str) -> bool {
    MODEL_TO_PROVIDERS.contains_key(model)
}

/// Legacy `getInferredProvidersForModel`: the static providers, then the
/// providers whose synchronized catalog lists the model, without repeats.
pub(crate) fn inferred_providers_for_model(model: &str, dynamic: &[String]) -> Vec<String> {
    let mut providers: Vec<String> = Vec::new();
    for provider in static_providers_for_model(model).iter().chain(dynamic) {
        if !providers.contains(provider) {
            providers.push(provider.clone());
        }
    }
    providers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_snapshot_keeps_registry_order_per_model() {
        assert_eq!(
            static_providers_for_model("big-pickle"),
            ["opencode-zen", "opencode"]
        );
        let gpt = static_providers_for_model("gpt-5.5");
        assert!(gpt.iter().any(|provider| provider == "openai"));
        assert!(gpt.iter().any(|provider| provider == "codex"));
        assert!(is_known_model("gpt-oss-120b"));
        assert!(!is_known_model("no-such-model"));
        assert!(static_providers_for_model("no-such-model").is_empty());
    }

    #[test]
    fn synced_providers_follow_the_static_ones_without_repeats() {
        let dynamic = ["opencode".to_owned(), "local-node".to_owned()];
        assert_eq!(
            inferred_providers_for_model("big-pickle", &dynamic),
            ["opencode-zen", "opencode", "local-node"]
        );
        assert_eq!(
            inferred_providers_for_model("no-such-model", &dynamic[1..]),
            ["local-node"]
        );
    }
}
