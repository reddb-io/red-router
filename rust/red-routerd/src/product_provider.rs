//! Fixed OpenAI-compatible provider endpoints from the product registry.
//! This is a narrow chat subset; it does not imply model or protocol parity.
pub fn chat_url(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("https://api.openai.com/v1/chat/completions"),
        "openrouter" => Some("https://openrouter.ai/api/v1/chat/completions"),
        "groq" => Some("https://api.groq.com/openai/v1/chat/completions"),
        "mistral" => Some("https://api.mistral.ai/v1/chat/completions"),
        "deepseek" => Some("https://api.deepseek.com/chat/completions"),
        "together" => Some("https://api.together.xyz/v1/chat/completions"),
        "perplexity" => Some("https://api.perplexity.ai/chat/completions"),
        _ => None,
    }
}
