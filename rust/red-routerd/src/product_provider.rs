//! Fixed OpenAI-compatible provider endpoints from the product registry.
//! This is a narrow chat subset; it does not imply model or protocol parity.
pub fn chat_url(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("https://api.openai.com/v1/chat/completions"),
        "openrouter" => Some("https://openrouter.ai/api/v1/chat/completions"),
        "groq" => Some("https://api.groq.com/openai/v1/chat/completions"),
        "cerebras" => Some("https://api.cerebras.ai/v1/chat/completions"),
        "sambanova" => Some("https://api.sambanova.ai/v1/chat/completions"),
        "mistral" => Some("https://api.mistral.ai/v1/chat/completions"),
        "deepseek" => Some("https://api.deepseek.com/chat/completions"),
        "together" => Some("https://api.together.xyz/v1/chat/completions"),
        "perplexity" => Some("https://api.perplexity.ai/chat/completions"),
        "fireworks" => Some("https://api.fireworks.ai/inference/v1/chat/completions"),
        "xai" => Some("https://api.x.ai/v1/chat/completions"),
        "nvidia" => Some("https://integrate.api.nvidia.com/v1/chat/completions"),
        "ai21" => Some("https://api.ai21.com/studio/v1/chat/completions"),
        "moonshot" | "kimi" => Some("https://api.moonshot.ai/v1/chat/completions"),
        "siliconflow" => Some("https://api.siliconflow.com/v1/chat/completions"),
        "novita" => Some("https://api.novita.ai/openai/v1/chat/completions"),
        _ => None,
    }
}

/// Fireworks shorthand names require product-specific expansion. Until that
/// behavior is ported, accept only complete model or router identifiers.
pub fn supports_model(provider: &str, model: &str) -> bool {
    if chat_url(provider).is_none() || model.is_empty() || model.trim() != model {
        return false;
    }
    provider != "fireworks"
        || ["accounts/fireworks/models/", "accounts/fireworks/routers/"]
            .iter()
            .any(|prefix| {
                model
                    .strip_prefix(prefix)
                    .is_some_and(|suffix| !suffix.is_empty())
            })
}
