//! Provider model endpoint policy, ported from the legacy
//! `open-sse/services/modelEndpointPolicy.ts`.
//!
//! Upstream `/models` responses often omit endpoint or modality metadata, so a
//! specialty model could otherwise be listed as chat simply because chat is the
//! historical default. The exceptional provider knowledge lives here so
//! discovery, import and catalog projection agree.

use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ModelEndpointKind {
    Chat,
    Image,
    Video,
    Embedding,
    Rerank,
    SystemOne,
    NonChat,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ModelEndpointReason {
    ExplicitEndpoints,
    ProviderPolicy,
    Unclassified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ModelEndpointDecision {
    pub(crate) kind: ModelEndpointKind,
    pub(crate) chat_selectable: bool,
    /// Why the decision was made; kept for parity and diagnostics.
    #[allow(dead_code)]
    pub(crate) reason: ModelEndpointReason,
}

const fn decision(
    kind: ModelEndpointKind,
    chat_selectable: bool,
    reason: ModelEndpointReason,
) -> ModelEndpointDecision {
    ModelEndpointDecision {
        kind,
        chat_selectable,
        reason,
    }
}

const CHAT_ENDPOINTS: &[&str] = &[
    "chat",
    "chat-completions",
    "chat/completions",
    "messages",
    "responses",
];
const EMBEDDING_ENDPOINTS: &[&str] = &["embeddings", "embedding"];
const RERANK_ENDPOINTS: &[&str] = &["rerank", "reranking"];
const IMAGE_ENDPOINTS: &[&str] = &["image", "images", "images/generations"];
const VIDEO_ENDPOINTS: &[&str] = &["video", "videos", "videos/generations"];
const SYSTEM_ONE_ENDPOINTS: &[&str] = &["systemone", "decisions"];

/// Legacy `endpoint.trim().toLowerCase().replace(/^\/+/, "").replace(/^v1\//, "")`.
fn normalize_endpoint(endpoint: &str) -> String {
    let lower = endpoint
        .trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
        .to_lowercase();
    let without_slashes = lower.trim_start_matches('/');
    without_slashes
        .strip_prefix("v1/")
        .unwrap_or(without_slashes)
        .to_owned()
}

fn classify_explicit_endpoints(
    supported_endpoints: Option<&[String]>,
) -> Option<ModelEndpointDecision> {
    use ModelEndpointKind::*;
    let supported = supported_endpoints.filter(|endpoints| !endpoints.is_empty())?;
    let endpoints: Vec<String> = supported
        .iter()
        .map(|endpoint| normalize_endpoint(endpoint))
        .filter(|endpoint| !endpoint.is_empty())
        .collect();
    let any = |set: &[&str]| {
        endpoints
            .iter()
            .any(|endpoint| set.contains(&endpoint.as_str()))
    };
    let reason = ModelEndpointReason::ExplicitEndpoints;
    Some(if any(CHAT_ENDPOINTS) {
        decision(Chat, true, reason)
    } else if any(EMBEDDING_ENDPOINTS) {
        decision(Embedding, false, reason)
    } else if any(RERANK_ENDPOINTS) {
        decision(Rerank, false, reason)
    } else if any(IMAGE_ENDPOINTS) {
        decision(Image, false, reason)
    } else if any(VIDEO_ENDPOINTS) {
        decision(Video, false, reason)
    } else if any(SYSTEM_ONE_ENDPOINTS) {
        decision(SystemOne, false, reason)
    } else {
        decision(NonChat, false, reason)
    })
}

fn classify_openai_model(model_id: &str) -> Option<ModelEndpointDecision> {
    use ModelEndpointKind::*;
    let normalized = model_id
        .strip_prefix("openai/")
        .unwrap_or(model_id)
        .to_lowercase();
    let reason = ModelEndpointReason::ProviderPolicy;
    if normalized.starts_with("text-embedding-") {
        Some(decision(Embedding, false, reason))
    } else if normalized.starts_with("gpt-image-")
        || normalized.starts_with("dall-e-")
        || normalized == "chatgpt-image-latest"
    {
        Some(decision(Image, false, reason))
    } else if normalized.starts_with("sora-") {
        Some(decision(Video, false, reason))
    } else {
        None
    }
}

/// OpenRouter's `:batch` suffix names the Batch-API-only variant, which
/// rejects chat completions. The other variant suffixes (`:free`, `:nitro`,
/// `:online`, …) are routing hints on the same chat model and stay chat.
fn classify_openrouter_model(model_id: &str) -> Option<ModelEndpointDecision> {
    let id = js_trim(model_id).to_lowercase();
    (id.ends_with(":batch")
        || (is_openrouter_decision_family_model_id(&id) && !is_openrouter_system_one_model_id(&id)))
    .then_some(decision(
        ModelEndpointKind::NonChat,
        false,
        ModelEndpointReason::ProviderPolicy,
    ))
}

/// Known decision routes override stale synced rows stamped with a synthetic `chat`.
pub(crate) fn is_openrouter_system_one_model_id(model_id: &str) -> bool {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    model_id == "~typesafe/jev-latest"
        || PATTERN
            .get_or_init(|| {
                regex::Regex::new(r"^typesafe/jev-[0-9]+(?:[.][0-9]+)*(?:-[a-z0-9._-]+)?$")
                    .expect("valid System One pattern")
            })
            .is_match(model_id)
}

/// Historical decision ids stay outside chat even when no adapter accepts them.
pub(crate) fn is_openrouter_decision_family_model_id(model_id: &str) -> bool {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN
        .get_or_init(|| {
            regex::Regex::new(
                r"^~?typesafe/jev-(?:latest|preview|[0-9]+(?:[.][0-9]+)*(?:-[a-z0-9._-]+)?)$",
            )
            .expect("valid decision family pattern")
        })
        .is_match(model_id)
}

fn classify_system_one_model(provider: &str, model_id: &str) -> Option<ModelEndpointDecision> {
    let id = js_trim(model_id).to_lowercase();
    let opencode_jev = id
        .strip_prefix("jev-")
        .and_then(|rest| rest.chars().next())
        .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let decision_only = provider == "typesafe-ai"
        || (provider == "openrouter" && is_openrouter_system_one_model_id(&id))
        || (matches!(provider, "opencode" | "opencode-zen") && opencode_jev);
    decision_only.then_some(decision(
        ModelEndpointKind::SystemOne,
        false,
        ModelEndpointReason::ProviderPolicy,
    ))
}

/// Classify a model's endpoint from its provider, id, declared endpoints and
/// stored model type.
pub(crate) fn model_endpoint_decision(
    provider: Option<&str>,
    model_id: &str,
    supported_endpoints: Option<&[String]>,
    model_type: Option<&str>,
) -> ModelEndpointDecision {
    let provider = provider
        .map(|p| js_trim(p).to_lowercase())
        .unwrap_or_default();
    if let Some(system_one) = classify_system_one_model(&provider, model_id) {
        return system_one;
    }
    let declared = supported_endpoints.filter(|endpoints| !endpoints.is_empty());
    if model_type == Some("decision") && declared.is_none() {
        return decision(
            ModelEndpointKind::NonChat,
            false,
            ModelEndpointReason::ExplicitEndpoints,
        );
    }
    let explicit = classify_explicit_endpoints(supported_endpoints);
    if provider == "openrouter" {
        // Unconditional: stored rows for these carry the synthetic `["chat"]`
        // default, and letting it win would re-import the excluded variants.
        if let Some(openrouter) = classify_openrouter_model(model_id) {
            return openrouter;
        }
    }
    if provider == "openai" {
        if let Some(openai) = classify_openai_model(model_id) {
            // A synthetic `["chat"]` default must not reclassify a known
            // specialty model; a real multi-endpoint model names both.
            let normalized: Vec<String> = supported_endpoints
                .unwrap_or_default()
                .iter()
                .map(|endpoint| normalize_endpoint(endpoint))
                .collect();
            let specialty = if openai.kind == ModelEndpointKind::Image {
                IMAGE_ENDPOINTS
            } else {
                VIDEO_ENDPOINTS
            };
            let has_specialty_endpoint = normalized
                .iter()
                .any(|endpoint| specialty.contains(&endpoint.as_str()));
            if let Some(explicit) = explicit.filter(|explicit| explicit.chat_selectable) {
                if has_specialty_endpoint {
                    return explicit;
                }
            }
            return openai;
        }
    }
    explicit.unwrap_or(decision(
        ModelEndpointKind::Unknown,
        true,
        ModelEndpointReason::Unclassified,
    ))
}

/// True when a model's own endpoint list names only non-chat endpoints.
/// Provider rules are not consulted.
#[allow(dead_code)]
pub(crate) fn declares_only_non_chat_endpoints(supported_endpoints: &[String]) -> bool {
    classify_explicit_endpoints(Some(supported_endpoints))
        .is_some_and(|explicit| !explicit.chat_selectable)
}

#[allow(dead_code)]
pub(crate) fn is_chat_selectable_model(
    provider: Option<&str>,
    model_id: &str,
    supported_endpoints: Option<&[String]>,
    model_type: Option<&str>,
) -> bool {
    model_endpoint_decision(provider, model_id, supported_endpoints, model_type).chat_selectable
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

#[cfg(test)]
mod tests {
    use super::ModelEndpointKind::*;
    use super::ModelEndpointReason::*;
    use super::*;

    fn endpoints(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn chat_selectable(provider: Option<&str>, id: &str, declared: Option<&[&str]>) -> bool {
        let declared = declared.map(endpoints);
        is_chat_selectable_model(provider, id, declared.as_deref(), None)
    }

    // tests/unit/model-endpoint-policy.test.ts
    #[test]
    fn openai_image_and_video_models_are_not_chat_without_metadata() {
        for id in [
            "gpt-image-2",
            "gpt-image-1.5",
            "gpt-image-1-mini",
            "dall-e-3",
            "chatgpt-image-latest",
        ] {
            assert_eq!(
                model_endpoint_decision(Some("openai"), id, None, None),
                decision(Image, false, ProviderPolicy),
                "{id}"
            );
        }
        assert_eq!(
            model_endpoint_decision(Some("openai"), "sora-2-pro", None, None),
            decision(Video, false, ProviderPolicy)
        );
    }

    #[test]
    fn openrouter_batch_variants_are_not_chat() {
        for id in [
            "google/gemini-3.6-flash:batch",
            "anthropic/claude-sonnet-4.5:batch",
            "minimax/minimax-m3:batch",
            "inkling:batch",
        ] {
            assert_eq!(
                model_endpoint_decision(Some("openrouter"), id, None, None),
                decision(NonChat, false, ProviderPolicy),
                "{id}"
            );
        }
        assert!(!chat_selectable(
            Some("openrouter"),
            "google/gemini-3.6-flash:batch",
            Some(&["chat"])
        ));
    }

    #[test]
    fn system_one_models_stay_out_of_chat_after_synthetic_discovery() {
        for (provider, id) in [
            ("typesafe-ai", "jev-latest"),
            ("openrouter", "typesafe/jev-1.13"),
            ("opencode-zen", "jev-1.13"),
            ("opencode", "jev-1.13-free"),
        ] {
            let declared = endpoints(&["chat"]);
            assert_eq!(
                model_endpoint_decision(Some(provider), id, Some(declared.as_slice()), None),
                decision(SystemOne, false, ProviderPolicy),
                "{provider} {id}"
            );
        }
        assert!(chat_selectable(Some("custom-provider"), "jev-latest", None));
        assert!(chat_selectable(Some("openrouter"), "openai/gpt-4o", None));
        let declared = endpoints(&["/v1/systemone"]);
        assert_eq!(
            model_endpoint_decision(
                Some("custom-provider"),
                "typed",
                Some(declared.as_slice()),
                None
            ),
            decision(SystemOne, false, ExplicitEndpoints)
        );
    }

    #[test]
    fn other_openrouter_suffixes_stay_chat_and_batch_policy_is_scoped() {
        for id in [
            "google/gemini-3.6-flash:free",
            "anthropic/claude-sonnet-4.5:thinking",
            "meta-llama/llama-4-70b:nitro",
            "perplexity/sonar:online",
            "google/gemini-3.6-flash",
        ] {
            assert!(chat_selectable(Some("openrouter"), id, None), "{id}");
        }
        assert!(chat_selectable(
            Some("custom-provider"),
            "some-model:batch",
            None
        ));
        assert!(chat_selectable(None, "some-model:batch", None));
        assert!(chat_selectable(
            Some("custom-provider"),
            "gpt-image-shaped-chat-model",
            None
        ));
    }

    #[test]
    fn explicit_chat_wins_only_when_a_specialty_endpoint_is_also_named() {
        assert!(chat_selectable(
            Some("openai"),
            "gpt-image-shaped-multimodal-model",
            Some(&["/v1/images/generations", "/v1/responses"])
        ));
        assert!(!chat_selectable(Some("openai"), "sora-2", Some(&["chat"])));
    }

    #[test]
    fn explicit_endpoints_classify_in_legacy_priority_order() {
        let classify = |values: &[&str]| {
            let declared = endpoints(values);
            model_endpoint_decision(Some("custom"), "m", Some(declared.as_slice()), None).kind
        };
        assert_eq!(classify(&["embeddings", "chat"]), Chat);
        assert_eq!(classify(&["embedding"]), Embedding);
        assert_eq!(classify(&["reranking"]), Rerank);
        assert_eq!(classify(&["/images"]), Image);
        assert_eq!(classify(&["V1/Videos"]), Video);
        assert_eq!(classify(&["decisions"]), SystemOne);
        assert_eq!(classify(&["audio-speech"]), NonChat);
        assert_eq!(classify(&["  "]), NonChat);
        assert_eq!(
            model_endpoint_decision(Some("custom"), "m", Some(&[][..]), None),
            decision(Unknown, true, Unclassified)
        );
        assert!(declares_only_non_chat_endpoints(&endpoints(&[
            "audio-speech"
        ])));
        assert!(!declares_only_non_chat_endpoints(&endpoints(&["chat"])));
        assert!(!declares_only_non_chat_endpoints(&[]));
    }

    #[test]
    fn decision_type_without_endpoints_is_non_chat() {
        assert_eq!(
            model_endpoint_decision(Some("custom"), "m", None, Some("decision")),
            decision(NonChat, false, ExplicitEndpoints)
        );
    }
}
