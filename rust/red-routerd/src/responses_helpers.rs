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

/// Legacy `buildResponsesTextParts`: a content block (string or text-part
/// array) as the Responses `input_text` parts of a message input item.
pub fn build_text_parts(content: &Value) -> Vec<Value> {
    let part = |text: &str| serde_json::json!({"type": "input_text", "text": text});
    match content {
        Value::String(text) => vec![part(text)],
        Value::Array(items) => {
            let mut parts = Vec::new();
            for item in items {
                // A bare string in the array is a real instruction, not a part.
                if let Value::String(text) = item {
                    parts.push(part(text));
                    continue;
                }
                let record = item.as_object();
                let is_text = record
                    .and_then(|record| record.get("type"))
                    .is_some_and(|kind| kind == "text");
                let text = record.and_then(|record| record.get("text"));
                if is_text || text.is_some_and(Value::is_string) {
                    parts.push(part(text.and_then(Value::as_str).unwrap_or("")));
                }
            }
            if parts.is_empty() {
                vec![part("")]
            } else {
                parts
            }
        }
        _ => vec![part("")],
    }
}

/// Legacy `buildInstructionsText`: the text parts of a system content block
/// joined for the string-valued `instructions` field.
pub fn build_instructions_text(content: &Value) -> String {
    if let Value::String(text) = content {
        return text.clone();
    }
    build_text_parts(content)
        .iter()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Legacy `mapChatResponseFormatToResponsesText`: Chat `response_format`
/// into the Responses `text.format`, merged into an existing `text`.
pub fn map_response_format(body: &Value, result: &mut serde_json::Map<String, Value>) {
    let Some(format) = body.get("response_format").and_then(Value::as_object) else {
        return;
    };
    let mut text = result
        .get("text")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    match format.get("type").and_then(Value::as_str) {
        Some("json_object") => {
            text.insert(
                "format".to_owned(),
                serde_json::json!({"type": "json_object"}),
            );
        }
        Some("json_schema") => {
            let Some(schema) = format.get("json_schema").and_then(Value::as_object) else {
                return;
            };
            let Some(body_schema) = schema.get("schema") else {
                return;
            };
            let mut out = serde_json::Map::new();
            out.insert("type".to_owned(), Value::String("json_schema".to_owned()));
            out.insert(
                "name".to_owned(),
                Value::String(
                    schema
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("codex_output_schema")
                        .to_owned(),
                ),
            );
            out.insert("schema".to_owned(), body_schema.clone());
            for key in ["description", "strict"] {
                if let Some(value) = schema.get(key) {
                    out.insert(key.to_owned(), value.clone());
                }
            }
            text.insert("format".to_owned(), Value::Object(out));
        }
        _ => return,
    }
    result.insert("text".to_owned(), Value::Object(text));
}

#[cfg(test)]
mod text_tests {
    use super::*;

    fn from_oracle(value: &Value) -> Value {
        match value.as_str() {
            Some("__undefined") => Value::Null,
            _ => value.clone(),
        }
    }

    /// Outputs the legacy text helpers produced for the same inputs
    /// (`responses_text_oracle.json`, evaluated from the legacy source).
    #[test]
    fn text_helpers_match_the_legacy_implementation() {
        let oracle: Value =
            serde_json::from_str(include_str!("responses_text_oracle.json")).unwrap();
        for case in oracle["instructions"].as_array().unwrap() {
            let content = from_oracle(&case[0]);
            assert_eq!(
                build_instructions_text(&content),
                case[1].as_str().unwrap(),
                "{case}"
            );
        }
        for case in oracle["parts"].as_array().unwrap() {
            let content = from_oracle(&case[0]);
            assert_eq!(Value::Array(build_text_parts(&content)), case[1], "{case}");
        }
        for case in oracle["format"].as_array().unwrap() {
            let mut result = serde_json::Map::new();
            if let Some(existing) = case[1].as_object() {
                result.insert("text".to_owned(), Value::Object(existing.clone()));
            }
            map_response_format(&case[0], &mut result);
            assert_eq!(Value::Object(result), case[2], "{case}");
        }
    }
}

fn non_empty_string(value: Option<&Value>) -> &str {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .unwrap_or("")
}

/// Legacy `extractReasoningDetailsText`: the `text` or `content` of every
/// `reasoning_details` item, concatenated.
fn reasoning_details_text(record: &serde_json::Map<String, Value>) -> String {
    let Some(details) = record.get("reasoning_details").and_then(Value::as_array) else {
        return String::new();
    };
    details
        .iter()
        .map(|detail| {
            let item = detail.as_object();
            let text = non_empty_string(item.and_then(|item| item.get("text")));
            if text.is_empty() {
                non_empty_string(item.and_then(|item| item.get("content")))
            } else {
                text
            }
            .to_owned()
        })
        .collect()
}

/// Legacy `getReadableReasoningValue`: `reasoning_content`, else `reasoning`.
pub fn readable_reasoning(value: &Value) -> String {
    let Some(record) = value.as_object() else {
        return String::new();
    };
    let readable = non_empty_string(record.get("reasoning_content"));
    if readable.is_empty() {
        non_empty_string(record.get("reasoning")).to_owned()
    } else {
        readable.to_owned()
    }
}

/// Legacy `getUnsupportedReasoningValue`: the first non-empty of
/// `reasoning_text`, `thinking`, `thought` and the details text.
pub fn unsupported_reasoning(value: &Value) -> String {
    let Some(record) = value.as_object() else {
        return String::new();
    };
    for key in ["reasoning_text", "thinking", "thought"] {
        let text = non_empty_string(record.get(key));
        if !text.is_empty() {
            return text.to_owned();
        }
    }
    reasoning_details_text(record)
}

#[cfg(test)]
mod reasoning_tests {
    use super::*;

    /// Outputs the legacy reasoning field readers produced for the same
    /// inputs (`reasoning_fields_oracle.json`, generated with Node).
    #[test]
    fn reasoning_readers_match_the_legacy_implementation() {
        let oracle: Vec<(Value, String, String)> =
            serde_json::from_str(include_str!("reasoning_fields_oracle.json")).unwrap();
        assert_eq!(oracle.len(), 14);
        for (input, readable, unsupported) in &oracle {
            assert_eq!(&readable_reasoning(input), readable, "{input}");
            assert_eq!(&unsupported_reasoning(input), unsupported, "{input}");
        }
    }
}
