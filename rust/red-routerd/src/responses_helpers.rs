//! Pure primitives of the OpenAI Chat Completions to Responses request
//! translation, ported from the legacy
//! `open-sse/translator/request/openai-responses/helpers.ts`.

use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

/// Legacy `MAX_CALL_ID_LEN`: the Responses API rejects longer call ids.
pub const MAX_CALL_ID_LEN: usize = 64;

/// Legacy `normalizeVerbosity`: only the three GPT-5 levels, lower-cased.
pub fn normalize_verbosity(value: &Value) -> Option<&'static str> {
    match value.as_str()?.to_lowercase().as_str() {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        _ => None,
    }
}

/// Legacy `clampCallId`: the first 64 UTF-16 units, deterministically, so a
/// call and its output keep the same id.
pub fn clamp_call_id(id: &str) -> String {
    let units: Vec<u16> = id.encode_utf16().collect();
    if units.len() <= MAX_CALL_ID_LEN {
        return id.to_owned();
    }
    String::from_utf16_lossy(&units[..MAX_CALL_ID_LEN])
}

static CODEX_MAX_EFFORT_MODEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:gpt-5\.6-(?:sol|terra|luna)|gpt-6-(?:astra|sol|luna)|gpt-6\.1-sol)(?:-(?:none|low|medium|high|xhigh|max|ultra))?$")
        .expect("static pattern")
});
static KIRO_GPT_56_MODEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:kiro|kr)/gpt-5\.6-(?:sol|terra|luna)(?:-(?:none|low|medium|high|xhigh|max))?$")
        .expect("static pattern")
});

/// JavaScript `String.prototype.trim` (Unicode White_Space plus BOM).
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

fn supports_native_max_effort(model: &str) -> bool {
    let lowered = js_trim(model).to_lowercase();
    let stripped = lowered
        .strip_prefix("codex/")
        .or_else(|| lowered.strip_prefix("cx/"))
        .unwrap_or(&lowered);
    CODEX_MAX_EFFORT_MODEL.is_match(stripped) || KIRO_GPT_56_MODEL.is_match(&lowered)
}

fn string_or_empty(value: &Value) -> &str {
    value.as_str().unwrap_or("")
}

/// Legacy `normalizeResponsesReasoningEffort`: lower-cased, and `max` only
/// where the model supports it natively, `xhigh` elsewhere.
pub fn normalize_reasoning_effort(value: &Value, model: &Value) -> String {
    let effort = string_or_empty(value).to_lowercase();
    if effort != "max" {
        return effort;
    }
    if supports_native_max_effort(string_or_empty(model)) {
        "max".to_owned()
    } else {
        "xhigh".to_owned()
    }
}

/// Legacy `shouldRequestClaudeSummarizedThinking`.
pub fn should_request_summarized_thinking(value: &Value) -> bool {
    let summary = string_or_empty(value).to_lowercase();
    !summary.is_empty() && !matches!(summary.as_str(), "off" | "none" | "disabled")
}

/// Legacy `imageUrlToText`: a string as is, an object's string `url`.
pub fn image_url_to_text(value: &Value) -> String {
    match value {
        Value::String(url) => url.clone(),
        Value::Object(record) => record
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn from_oracle(value: &Value) -> Value {
        match value.as_str() {
            Some("__undefined") => Value::Null,
            _ => value.clone(),
        }
    }

    /// Outputs the legacy helpers produced for the same inputs
    /// (`responses_helpers_oracle.json`, generated with Node).
    #[test]
    fn helpers_match_the_legacy_implementation() {
        let oracle: Value =
            serde_json::from_str(include_str!("responses_helpers_oracle.json")).unwrap();
        for case in oracle["verbosity"].as_array().unwrap() {
            assert_eq!(
                normalize_verbosity(&from_oracle(&case[0]))
                    .map(Value::from)
                    .unwrap_or(Value::Null),
                case[1],
                "{case}"
            );
        }
        for case in oracle["clamp"].as_array().unwrap() {
            assert_eq!(
                clamp_call_id(case[0].as_str().unwrap()),
                case[1].as_str().unwrap()
            );
        }
        for case in oracle["effort"].as_array().unwrap() {
            assert_eq!(
                normalize_reasoning_effort(&case[0], &case[1]),
                case[2].as_str().unwrap(),
                "{case}"
            );
        }
        for case in oracle["summary"].as_array().unwrap() {
            assert_eq!(
                should_request_summarized_thinking(&case[0]),
                case[1].as_bool().unwrap(),
                "{case}"
            );
        }
        for case in oracle["image"].as_array().unwrap() {
            let input: Value = serde_json::from_str(case[0].as_str().unwrap()).unwrap();
            assert_eq!(
                image_url_to_text(&input),
                case[1].as_str().unwrap(),
                "{case}"
            );
        }
        assert_eq!(clamp_call_id(&"é".repeat(70)).encode_utf16().count(), 64);
        assert_eq!(image_url_to_text(&json!({"url": 5})), "");
    }
}
