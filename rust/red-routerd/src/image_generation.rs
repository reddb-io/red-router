//! OpenAI-format image generation (legacy `imageGeneration.ts`:
//! `handleOpenAIImageGeneration` and `fetchImageEndpoint`).
//!
//! The legacy handler picks the upstream URL from `imageRegistry.ts`. For the
//! providers below that URL is the sibling of the provider's chat completions
//! URL (`.../chat/completions` becomes `.../images/generations`), so an account
//! adopted for chat serves images without further configuration.

use serde_json::{json, Map, Value};

/// Registry providers with `format: "openai"` and a bearer key whose image URL
/// sits beside their chat URL.
pub(crate) fn serves_images_beside_chat(provider: &str) -> bool {
    matches!(
        provider,
        "openai" | "openrouter" | "xai" | "together" | "fireworks"
    )
}

/// The legacy upstream body: the routed model and prompt, plus the optional
/// parameters that are passed through when present.
pub(crate) fn request_body(
    body: &Value,
    routed_model: &str,
    requested_model: &str,
) -> Result<Vec<u8>, String> {
    let object = body.as_object().ok_or("Invalid JSON body")?;
    let has_prompt = object
        .get("prompt")
        .and_then(Value::as_str)
        .is_some_and(|prompt| !prompt.trim().is_empty());
    if !has_prompt {
        return Err(format!(
            "Prompt is required for image model: {requested_model}"
        ));
    }
    let mut upstream = Map::new();
    upstream.insert("model".to_owned(), json!(routed_model));
    upstream.insert("prompt".to_owned(), object["prompt"].clone());
    for field in ["n", "size", "quality", "response_format", "style"] {
        if let Some(value) = object.get(field) {
            upstream.insert(field.to_owned(), value.clone());
        }
    }
    serde_json::to_vec(&Value::Object(upstream)).map_err(|_| "Invalid JSON body".to_owned())
}

/// Legacy `fetchImageEndpoint` on a 2xx: answer `{created, data}`, and refuse an
/// answer without a single usable image (`b64_json` or `url`), which the legacy
/// router reports as a retryable 502 so combos fall back.
pub(crate) fn normalize_response(bytes: &[u8], now_secs: u64) -> Result<Value, &'static str> {
    let parsed: Value = serde_json::from_slice(bytes).map_err(|_| "Invalid image response")?;
    let items = parsed
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let usable = items.iter().any(|item| {
        item.as_object().is_some_and(|item| {
            ["b64_json", "url"].iter().any(|key| {
                item.get(*key)
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.is_empty())
            })
        })
    });
    if !usable {
        return Err("Image provider returned a success status without an image payload");
    }
    // `data.created || now`: a missing or zero value falls back to the clock.
    let created = parsed
        .get("created")
        .filter(|value| value.as_f64().is_some_and(|number| number != 0.0))
        .cloned()
        .unwrap_or_else(|| json!(now_secs));
    Ok(json!({"created": created, "data": items}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_registry_providers_with_a_sibling_images_url_are_served() {
        for provider in ["openai", "openrouter", "xai", "together", "fireworks"] {
            assert!(serves_images_beside_chat(provider), "{provider}");
        }
        for provider in ["cloudflare-ai", "opencode-go", "agy", "claude"] {
            assert!(!serves_images_beside_chat(provider), "{provider}");
        }
    }

    #[test]
    fn the_upstream_body_keeps_only_the_legacy_fields() {
        let body = json!({
            "model":"openrouter/black-forest-labs/flux.2-pro","prompt":"a red fox","n":2,
            "size":"1024x1024","quality":"hd","response_format":"b64_json","style":"vivid",
            "user":"someone","image_url":"https://example.invalid/x.png","seed":7
        });
        let upstream = request_body(&body, "black-forest-labs/flux.2-pro", "x").unwrap();
        let upstream: Value = serde_json::from_slice(&upstream).unwrap();
        assert_eq!(
            upstream,
            json!({
                "model":"black-forest-labs/flux.2-pro","prompt":"a red fox","n":2,
                "size":"1024x1024","quality":"hd","response_format":"b64_json","style":"vivid"
            })
        );
        let minimal = request_body(&json!({"prompt":"p"}), "m", "x").unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&minimal).unwrap(),
            json!({"model":"m","prompt":"p"})
        );
    }

    #[test]
    fn a_missing_or_blank_prompt_is_refused_with_the_legacy_message() {
        for body in [json!({}), json!({"prompt":"   "}), json!({"prompt":3})] {
            assert_eq!(
                request_body(&body, "m", "openrouter/m").unwrap_err(),
                "Prompt is required for image model: openrouter/m"
            );
        }
    }

    #[test]
    fn a_success_answer_is_reduced_to_created_and_data() {
        let answer = normalize_response(
            br#"{"created":123,"data":[{"b64_json":"AAAA","revised_prompt":"r"}],"usage":{"x":1}}"#,
            999,
        )
        .unwrap();
        assert_eq!(
            answer,
            json!({"created":123,"data":[{"b64_json":"AAAA","revised_prompt":"r"}]})
        );
        let by_url = normalize_response(br#"{"data":[{"url":"https://img/1"}]}"#, 999).unwrap();
        assert_eq!(by_url["created"], 999);
        let zero = normalize_response(br#"{"created":0,"data":[{"url":"u"}]}"#, 999).unwrap();
        assert_eq!(zero["created"], 999);
    }

    #[test]
    fn an_answer_without_a_usable_image_is_refused() {
        for body in [
            &br#"{"data":[]}"#[..],
            br#"{}"#,
            br#"{"data":[{"b64_json":""},{"url":""},{"other":"x"},"text"]}"#,
        ] {
            assert_eq!(
                normalize_response(body, 1).unwrap_err(),
                "Image provider returned a success status without an image payload"
            );
        }
        assert_eq!(
            normalize_response(b"not json", 1).unwrap_err(),
            "Invalid image response"
        );
    }
}
