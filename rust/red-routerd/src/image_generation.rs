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

/// Cloudflare Workers AI (`cloudflare-ai-image` format): the image URL is
/// derived from the account's chat URL, so the account ID is already known.
pub(crate) fn is_cloudflare(provider: &str) -> bool {
    provider == "cloudflare-ai"
}

/// Providers whose accounts can serve `/v1/images/generations`.
pub(crate) fn serves_images(provider: &str) -> bool {
    serves_images_beside_chat(provider) || is_cloudflare(provider)
}

/// Legacy `handleCloudflareAiImageGeneration` body: the prompt, the
/// `WIDTHxHEIGHT` size split into numbers (`auto` and malformed sizes are
/// dropped), and numeric `seed` / `num_steps`.
pub(crate) fn cloudflare_request_body(
    body: &Value,
    requested_model: &str,
) -> Result<Vec<u8>, String> {
    let object = body.as_object().ok_or("Invalid JSON body")?;
    let prompt = object
        .get("prompt")
        .and_then(Value::as_str)
        .filter(|prompt| !prompt.trim().is_empty())
        .ok_or_else(|| format!("Prompt is required for image model: {requested_model}"))?;
    let mut upstream = Map::new();
    upstream.insert("prompt".to_owned(), json!(prompt));
    if let Some((width, height)) = object
        .get("size")
        .and_then(Value::as_str)
        .and_then(|size| size.split_once('x'))
        .and_then(|(width, height)| {
            let parse = |part: &str| {
                (!part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
                    .then(|| part.parse::<u64>().ok())
                    .flatten()
            };
            Some((parse(width)?, parse(height)?))
        })
    {
        if width != 0 {
            upstream.insert("width".to_owned(), json!(width));
        }
        if height != 0 {
            upstream.insert("height".to_owned(), json!(height));
        }
    }
    for field in ["seed", "num_steps"] {
        if let Some(value) = object.get(field).filter(|value| value.is_number()) {
            upstream.insert(field.to_owned(), value.clone());
        }
    }
    serde_json::to_vec(&Value::Object(upstream)).map_err(|_| "Invalid JSON body".to_owned())
}

fn is_aspect_ratio(value: &str) -> bool {
    value.split_once(':').is_some_and(|(width, height)| {
        [width, height]
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    })
}

/// Legacy `mapImageSize`: an aspect ratio passes through, the OpenAI sizes map
/// to their ratio, anything else is square.
fn aspect_ratio_for_size(size: Option<&str>) -> &str {
    match size {
        Some(size) if is_aspect_ratio(size) => size,
        Some("1792x1024") => "16:9",
        Some("1024x1792") => "9:16",
        Some("1536x1024") => "3:2",
        Some("1024x1536") => "2:3",
        _ => "1:1",
    }
}

/// Legacy `IMAGE_MODEL_ALIASES` entry that stays on Antigravity.
pub(crate) fn antigravity_model(model: &str) -> &str {
    match model {
        "gemini-3.1-flash-image-preview" => "gemini-3.1-flash-image",
        model => model,
    }
}

/// Legacy `handleGeminiImageGeneration` envelope (`requestType: "image_gen"`):
/// `n` becomes the candidate count, `aspect_ratio` (or the mapped `size`) the
/// aspect ratio, and `image_size` the `1K`/`2K`/`4K` resolution (any other
/// string is clamped to `1K`, a missing one is left out).
pub(crate) fn antigravity_request_body(
    body: &Value,
    model: &str,
    project: Option<&str>,
    requested_model: &str,
    request_id: &str,
) -> Result<Vec<u8>, String> {
    let object = body.as_object().ok_or("Invalid JSON body")?;
    let prompt = object
        .get("prompt")
        .and_then(Value::as_str)
        .filter(|prompt| !prompt.trim().is_empty())
        .ok_or_else(|| format!("Prompt is required for image model: {requested_model}"))?;
    let project = project.filter(|project| !project.is_empty()).ok_or(
        "Missing Google projectId for Antigravity account. Please reconnect OAuth in Providers so RedRouter can fetch your Cloud Code project.",
    )?;
    let candidate_count = object
        .get("n")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
        .map_or(1, |n| n.floor() as u64);
    let aspect_ratio = object
        .get("aspect_ratio")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|ratio| is_aspect_ratio(ratio))
        .unwrap_or_else(|| aspect_ratio_for_size(object.get("size").and_then(Value::as_str)));
    let mut image_config = Map::new();
    image_config.insert("aspectRatio".to_owned(), json!(aspect_ratio));
    if let Some(size) = object.get("image_size").and_then(Value::as_str) {
        let size = size.trim().to_uppercase();
        let size = if matches!(size.as_str(), "1K" | "2K" | "4K") {
            size
        } else {
            "1K".to_owned()
        };
        image_config.insert("imageSize".to_owned(), json!(size));
    }
    serde_json::to_vec(&json!({
        "project": project,
        "requestId": request_id,
        "request": {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "candidateCount": candidate_count,
                "imageConfig": image_config,
            },
        },
        "model": antigravity_model(model),
        "userAgent": "antigravity",
        "requestType": "image_gen",
    }))
    .map_err(|_| "Invalid JSON body".to_owned())
}

/// A random `image_gen/<ms>/<uuid v4>/0` request id.
pub(crate) fn antigravity_request_id(now_millis: u128) -> Option<String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Some(format!(
        "image_gen/{now_millis}/{}-{}-{}-{}-{}/0",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

/// Legacy Antigravity answer: every `inlineData` part of every candidate of the
/// (possibly `response`-wrapped) Gemini answer is an image, captioned with the
/// first text part or the prompt. The legacy router answers 200 even when no
/// candidate carries an image.
pub(crate) fn normalize_antigravity_response(
    bytes: &[u8],
    now_secs: u64,
    prompt: Option<&str>,
) -> Result<Value, &'static str> {
    let parsed: Value = serde_json::from_slice(bytes).map_err(|_| "Invalid image response")?;
    let body = parsed
        .get("response")
        .filter(|response| response.is_object())
        .unwrap_or(&parsed);
    let mut images = Vec::new();
    for candidate in body
        .get("candidates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let parts = candidate
            .pointer("/content/parts")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        let caption = parts
            .iter()
            .find_map(|part| part.get("text").and_then(Value::as_str))
            .filter(|text| !text.is_empty())
            .or(prompt)
            .unwrap_or_default();
        for part in parts {
            if let Some(inline) = part.get("inlineData").filter(|inline| inline.is_object()) {
                images.push(json!({
                    "b64_json": inline.get("data").cloned().unwrap_or(Value::Null),
                    "revised_prompt": caption,
                }));
            }
        }
    }
    Ok(json!({"created": now_secs, "data": images}))
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
pub(crate) fn normalize_response(
    bytes: &[u8],
    now_secs: u64,
    prompt: Option<&str>,
) -> Result<Value, &'static str> {
    let parsed: Value = serde_json::from_slice(bytes).map_err(|_| "Invalid image response")?;
    // Cloudflare answers `{result:{image}, success}` with a raw base64 image.
    if let Some(result) = parsed.get("result").filter(|result| result.is_object()) {
        let image = result
            .get("image")
            .and_then(Value::as_str)
            .filter(|image| !image.is_empty());
        return match image {
            Some(image) if parsed.get("success").and_then(Value::as_bool) == Some(true) => {
                Ok(json!({
                    "created": now_secs,
                    "data": [{"b64_json": image, "revised_prompt": prompt.unwrap_or_default()}]
                }))
            }
            _ => Err("No image returned from Cloudflare Workers AI"),
        };
    }
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
            None,
        )
        .unwrap();
        assert_eq!(
            answer,
            json!({"created":123,"data":[{"b64_json":"AAAA","revised_prompt":"r"}]})
        );
        let by_url =
            normalize_response(br#"{"data":[{"url":"https://img/1"}]}"#, 999, None).unwrap();
        assert_eq!(by_url["created"], 999);
        let zero = normalize_response(br#"{"created":0,"data":[{"url":"u"}]}"#, 999, None).unwrap();
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
                normalize_response(body, 1, None).unwrap_err(),
                "Image provider returned a success status without an image payload"
            );
        }
        assert_eq!(
            normalize_response(b"not json", 1, None).unwrap_err(),
            "Invalid image response"
        );
    }

    #[test]
    fn a_cloudflare_body_splits_the_size_and_keeps_numeric_options() {
        let body = json!({"prompt":"a fox","size":"1024x768","seed":7,"num_steps":4,"n":2});
        let upstream: Value =
            serde_json::from_slice(&cloudflare_request_body(&body, "x").unwrap()).unwrap();
        assert_eq!(
            upstream,
            json!({"prompt":"a fox","width":1024,"height":768,"seed":7,"num_steps":4})
        );
        for size in ["auto", "big", "10x", "x10", "-1x5"] {
            let body = json!({"prompt":"p","size":size,"seed":"7"});
            let upstream: Value =
                serde_json::from_slice(&cloudflare_request_body(&body, "x").unwrap()).unwrap();
            assert_eq!(upstream, json!({"prompt":"p"}), "{size}");
        }
        assert_eq!(
            cloudflare_request_body(&json!({"prompt":" "}), "cf/m").unwrap_err(),
            "Prompt is required for image model: cf/m"
        );
        assert!(is_cloudflare("cloudflare-ai") && serves_images("cloudflare-ai"));
    }

    #[test]
    fn a_cloudflare_answer_becomes_one_b64_image() {
        let answer = normalize_response(
            br#"{"result":{"image":"QUJD"},"success":true,"errors":[]}"#,
            50,
            Some("a fox"),
        )
        .unwrap();
        assert_eq!(
            answer,
            json!({"created":50,"data":[{"b64_json":"QUJD","revised_prompt":"a fox"}]})
        );
        for body in [
            &br#"{"result":{"image":"QUJD"},"success":false}"#[..],
            br#"{"result":{},"success":true}"#,
            br#"{"result":{"image":""},"success":true}"#,
        ] {
            assert_eq!(
                normalize_response(body, 1, None).unwrap_err(),
                "No image returned from Cloudflare Workers AI"
            );
        }
    }

    #[test]
    fn the_antigravity_envelope_follows_the_legacy_image_gen_request() {
        let body = json!({
            "model":"agy/gemini-3.1-flash-image-preview","prompt":"a red fox","n":2.7,
            "size":"1792x1024","image_size":"2k","user":"ignored"
        });
        let envelope: Value = serde_json::from_slice(
            &antigravity_request_body(
                &body,
                "gemini-3.1-flash-image-preview",
                Some("agy-project"),
                "agy/x",
                "image_gen/1/u/0",
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            envelope,
            json!({
                "project":"agy-project","requestId":"image_gen/1/u/0",
                "request":{
                    "contents":[{"role":"user","parts":[{"text":"a red fox"}]}],
                    "generationConfig":{
                        "candidateCount":2,
                        "imageConfig":{"aspectRatio":"16:9","imageSize":"2K"}
                    }
                },
                "model":"gemini-3.1-flash-image","userAgent":"antigravity","requestType":"image_gen"
            })
        );
        // An explicit ratio wins, an unknown resolution is clamped, a bad n is one.
        let envelope: Value = serde_json::from_slice(
            &antigravity_request_body(
                &json!({"prompt":"p","aspect_ratio":" 4:3 ","size":"1024x1792","image_size":"8K","n":0}),
                "m",
                Some("p1"),
                "x",
                "id",
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            envelope["request"]["generationConfig"],
            json!({"candidateCount":1,"imageConfig":{"aspectRatio":"4:3","imageSize":"1K"}})
        );
        let square: Value = serde_json::from_slice(
            &antigravity_request_body(
                &json!({"prompt":"p","size":"auto"}),
                "m",
                Some("p1"),
                "x",
                "id",
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            square["request"]["generationConfig"]["imageConfig"],
            json!({"aspectRatio":"1:1"})
        );
        assert!(
            antigravity_request_body(&json!({"prompt":"p"}), "m", None, "x", "id")
                .unwrap_err()
                .starts_with("Missing Google projectId for Antigravity account.")
        );
        assert_eq!(
            antigravity_request_body(&json!({"prompt":" "}), "m", Some("p1"), "agy/m", "id")
                .unwrap_err(),
            "Prompt is required for image model: agy/m"
        );
    }

    #[test]
    fn the_antigravity_request_id_is_a_timestamped_uuid() {
        let id = antigravity_request_id(1_700).unwrap();
        let parts: Vec<&str> = id.split('/').collect();
        assert_eq!(parts.len(), 4);
        assert_eq!((parts[0], parts[1], parts[3]), ("image_gen", "1700", "0"));
        let uuid: Vec<&str> = parts[2].split('-').collect();
        assert_eq!(
            uuid.iter().map(|part| part.len()).collect::<Vec<_>>(),
            [8, 4, 4, 4, 12]
        );
        assert!(uuid[2].starts_with('4'));
        assert_ne!(id, antigravity_request_id(1_700).unwrap());
    }

    #[test]
    fn an_antigravity_answer_lists_every_inline_image() {
        let answer = normalize_antigravity_response(
            br#"{"response":{"candidates":[
                {"content":{"parts":[{"text":"caption"},{"inlineData":{"mimeType":"image/png","data":"AAA"}}]}},
                {"content":{"parts":[{"inlineData":{"data":"BBB"}},{"inlineData":{"data":"CCC"}}]}}
            ]}}"#,
            9,
            Some("a fox"),
        )
        .unwrap();
        assert_eq!(
            answer,
            json!({"created":9,"data":[
                {"b64_json":"AAA","revised_prompt":"caption"},
                {"b64_json":"BBB","revised_prompt":"a fox"},
                {"b64_json":"CCC","revised_prompt":"a fox"}
            ]})
        );
        // An unwrapped answer reads the same; no image is still a 200 in the legacy router.
        let bare = normalize_antigravity_response(
            br#"{"candidates":[{"content":{"parts":[{"inlineData":{"data":"D"}}]}}]}"#,
            1,
            None,
        )
        .unwrap();
        assert_eq!(bare["data"], json!([{"b64_json":"D","revised_prompt":""}]));
        assert_eq!(
            normalize_antigravity_response(br#"{"response":{"candidates":[]}}"#, 1, None).unwrap(),
            json!({"created":1,"data":[]})
        );
        assert!(normalize_antigravity_response(b"nope", 1, None).is_err());
        assert_eq!(
            antigravity_model("gemini-3.1-flash-image-preview"),
            "gemini-3.1-flash-image"
        );
        assert_eq!(
            antigravity_model("gemini-3.1-flash-image"),
            "gemini-3.1-flash-image"
        );
    }
}
