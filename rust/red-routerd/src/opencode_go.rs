//! OpenCode Go per-model endpoint selection, ported from the legacy
//! `OpencodeExecutor.buildUrl` and the `opencode-go` registry entry
//! (`open-sse/config/providers/registry/opencode/go/index.ts`).
//!
//! The registry mixes three target formats by model: chat completions
//! (`openai`, the default), Anthropic Messages (`claude`) and the Responses
//! API (`openai-responses`). `opencode_go_formats.json` is generated from the
//! registry; a model outside it uses chat completions, as the legacy
//! `resolveOpencodeTargetFormat` falls back to `openai`.

use serde::Deserialize;
use std::{collections::HashMap, sync::LazyLock};

/// Legacy registry `baseUrl`.
pub const BASE_URL: &str = "https://opencode.ai/zen/go/v1";

#[derive(Deserialize)]
struct Table {
    formats: HashMap<String, String>,
}

static FORMATS: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    serde_json::from_str::<Table>(include_str!("opencode_go_formats.json"))
        .expect("bundled OpenCode Go formats")
        .formats
});

/// The wire format of a model on OpenCode Go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetFormat {
    ChatCompletions,
    Messages,
    Responses,
}

/// Legacy `resolveOpencodeTargetFormat`.
pub fn target_format(model: &str) -> TargetFormat {
    match FORMATS.get(model).map(String::as_str) {
        Some("claude") => TargetFormat::Messages,
        Some("openai-responses") => TargetFormat::Responses,
        _ => TargetFormat::ChatCompletions,
    }
}

/// Legacy `OpencodeExecutor.buildUrl` for a model.
pub fn url(model: &str) -> String {
    let path = match target_format(model) {
        TargetFormat::Messages => "messages",
        TargetFormat::Responses => "responses",
        TargetFormat::ChatCompletions => "chat/completions",
    };
    format!("{BASE_URL}/{path}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_follow_the_legacy_registry() {
        let count = |wanted: &str| FORMATS.values().filter(|format| *format == wanted).count();
        assert_eq!(FORMATS.len(), 68);
        assert_eq!(count("openai"), 32);
        assert_eq!(count("claude"), 16);
        assert_eq!(count("openai-responses"), 20);
        // Spot checks from the registry comments (#2292, #3110).
        assert_eq!(target_format("minimax-m3"), TargetFormat::Messages);
        assert_eq!(target_format("qwen3.7-max"), TargetFormat::Messages);
        assert_eq!(url("minimax-m3"), "https://opencode.ai/zen/go/v1/messages");
        assert_eq!(
            url("model-not-in-the-registry"),
            "https://opencode.ai/zen/go/v1/chat/completions"
        );
        let responses = FORMATS
            .iter()
            .find(|(_, format)| *format == "openai-responses")
            .map(|(model, _)| model.as_str())
            .unwrap();
        assert_eq!(url(responses), "https://opencode.ai/zen/go/v1/responses");
    }
}
