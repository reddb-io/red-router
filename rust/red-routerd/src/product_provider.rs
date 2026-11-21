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

/// Legacy CloudflareAIExecutor.buildUrl: Workers AI chat completions for one
/// Cloudflare account (a 32-character hexadecimal account ID).
pub fn cloudflare_chat_url(account_id: &str) -> Option<String> {
    (account_id.len() == 32 && account_id.bytes().all(|byte| byte.is_ascii_hexdigit())).then(|| {
        format!("https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions")
    })
}

/// Legacy CloudflareAIExecutor.transformRequest: Workers AI validates content
/// against each model's schema and text-only models reject the content-part
/// array, so a message whose parts are all text becomes one string (the shape
/// every model accepts); anything else passes through.
pub fn flatten_text_only_content(payload: &mut serde_json::Value) {
    let Some(messages) = payload
        .get_mut("messages")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for message in messages {
        let Some(parts) = message.get("content").and_then(serde_json::Value::as_array) else {
            continue;
        };
        let texts: Option<Vec<&str>> = parts
            .iter()
            .map(|part| {
                (part.get("type").and_then(serde_json::Value::as_str) == Some("text"))
                    .then(|| part.get("text").and_then(serde_json::Value::as_str))
                    .flatten()
            })
            .collect();
        if let Some(texts) = texts {
            let joined = texts.concat();
            message["content"] = serde_json::Value::String(joined);
        }
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

#[cfg(test)]
mod cloudflare_tests {
    use super::*;
    use serde_json::json;

    // Ported from the legacy CloudflareAIExecutor buildUrl/transformRequest.
    #[test]
    fn workers_ai_url_and_text_flattening_follow_the_legacy_executor() {
        assert_eq!(
            cloudflare_chat_url("0123456789abcdef0123456789ABCDEF").as_deref(),
            Some("https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789ABCDEF/ai/v1/chat/completions")
        );
        assert_eq!(cloudflare_chat_url("short"), None);
        assert_eq!(
            cloudflare_chat_url("0123456789abcdef0123456789abcdeg"),
            None
        );
        let mut body = json!({"messages":[
            {"role":"user","content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]},
            {"role":"user","content":[{"type":"text","text":"x"},{"type":"image_url","image_url":{"url":"data:"}}]},
            {"role":"assistant","content":"plain"}
        ]});
        flatten_text_only_content(&mut body);
        assert_eq!(body["messages"][0]["content"], "ab");
        assert!(body["messages"][1]["content"].is_array());
        assert_eq!(body["messages"][2]["content"], "plain");
    }
}
