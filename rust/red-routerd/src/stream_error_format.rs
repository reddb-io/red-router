//! Upstream stream failure normalization and client-format error framing,
//! ported from the legacy `utils/streamErrorFormat.ts`,
//! `utils/responsesFailureOutput.ts` and `utils/responsesSequence.ts`.
//!
//! Key order in the envelopes written by `format_translated_stream_error`
//! follows the legacy `JSON.stringify`; the error body inside comes from
//! `build_error_body`, whose keys serialize sorted.

use crate::error_sanitization::sanitize_error_message;
use crate::public_error::{build_error_body, Classification};
use crate::responses_stream_pure::Ordered;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::LazyLock;

/// Legacy `SYNTHETIC_RESPONSES_SEQUENCE_NUMBER` (#14330): every frame
/// synthesized outside the live event emitter starts at 1, never at 0, which
/// collided with the real first event.
pub const SYNTHETIC_RESPONSES_SEQUENCE_NUMBER: u64 = 1;

/// Legacy `StreamFailurePayload`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamFailure {
    pub status: u16,
    pub message: String,
    pub code: Option<String>,
    pub error_type: Option<String>,
}

/// Legacy `ProjectedStreamFailureEvent`: `internal_failure` keeps the raw
/// provider wording for account fallback; `public_payload` is safe to send.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectedStreamFailureEvent {
    pub internal_failure: StreamFailure,
    pub public_message: String,
    pub public_payload: Value,
}

/// Legacy `PreparedTranslatedStreamFailure`.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedTranslatedStreamFailure {
    pub record: Value,
    pub provider_payload: Value,
    pub internal_failure: StreamFailure,
    pub public_message: String,
}

fn empty_map() -> &'static Map<String, Value> {
    static EMPTY: LazyLock<Map<String, Value>> = LazyLock::new(Map::new);
    &EMPTY
}

fn record(value: Option<&Value>) -> &Map<String, Value> {
    value
        .and_then(Value::as_object)
        .unwrap_or_else(|| empty_map())
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

fn non_blank_string(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !js_trim(text).is_empty())
}

/// Legacy `toStreamFailureStatus`: an HTTP error status given as a number or
/// a three digit string.
fn failure_status(value: Option<&Value>) -> Option<u16> {
    match value? {
        Value::Number(number) => {
            let n = number.as_f64()?;
            (n.fract() == 0.0 && (400.0..=599.0).contains(&n)).then_some(n as u16)
        }
        Value::String(text) => {
            let trimmed = js_trim(text);
            if trimmed.len() == 3 && trimmed.bytes().all(|byte| byte.is_ascii_digit()) {
                trimmed
                    .parse::<u16>()
                    .ok()
                    .filter(|status| (400..=599).contains(status))
            } else {
                None
            }
        }
        _ => None,
    }
}

fn looks_like_rate_limit(code: &str, error_type: &str, message: &str) -> bool {
    let haystack = format!("{code} {error_type} {message}").to_lowercase();
    [
        "usage_limit_reached",
        "rate_limit",
        "rate limit",
        "quota",
        "too many requests",
        "limit reached",
        "limit has been reached",
    ]
    .iter()
    .any(|needle| haystack.contains(needle))
}

fn non_empty_object(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value
        .and_then(Value::as_object)
        .filter(|map| !map.is_empty())
}

/// Legacy `normalizeStreamFailurePayload`: the error in a stream failure
/// event, wherever the provider put it, with an HTTP status derived from the
/// event or, failing that, from the error's own type and code.
pub fn normalize_stream_failure_payload(payload: &Value) -> StreamFailure {
    let root = record(Some(payload));
    let response = record(root.get("response"));
    let response_error = response.get("error");
    let response_last_error = response.get("last_error");
    let root_error = root.get("error");
    let error = non_empty_object(response_error)
        .or_else(|| non_empty_object(response_last_error))
        .or_else(|| non_empty_object(root_error))
        .unwrap_or(root);

    let code = match error.get("code") {
        Some(Value::String(code)) => code.clone(),
        other => failure_status(other)
            .map_or_else(|| "upstream_error".to_owned(), |status| status.to_string()),
    };
    let error_type = error.get("type").and_then(Value::as_str).map(str::to_owned);
    let message = non_blank_string(error.get("message"))
        .or_else(|| non_blank_string(response_error))
        .or_else(|| non_blank_string(response_last_error))
        .or_else(|| non_blank_string(root_error))
        .or_else(|| non_blank_string(root.get("message")))
        .unwrap_or("Upstream failure")
        .to_owned();
    let type_name = error_type.as_deref();
    let request_scoped = matches!(
        type_name,
        Some("invalid_request_error" | "context_length_exceeded" | "context_window_exceeded")
    ) || matches!(
        code.as_str(),
        "invalid_request_error" | "context_length_exceeded" | "context_window_exceeded"
    );
    let status = [
        error.get("status_code"),
        error.get("status"),
        response.get("status_code"),
        response.get("status"),
        root.get("status_code"),
        root.get("status"),
        error.get("code"),
    ]
    .into_iter()
    .find_map(failure_status)
    .unwrap_or_else(|| {
        if request_scoped {
            400
        } else if type_name == Some("authentication_error") || code == "invalid_api_key" {
            401
        } else if type_name == Some("permission_error") || code == "permission_denied" {
            403
        } else if type_name == Some("billing_error") || code == "payment_required" {
            402
        } else if looks_like_rate_limit(&code, type_name.unwrap_or(""), &message) {
            429
        } else {
            502
        }
    });
    StreamFailure {
        status,
        message,
        code: Some(code),
        error_type: error_type.filter(|name| !name.is_empty()),
    }
}

fn public_error(failure: &StreamFailure) -> Value {
    let classification = Classification {
        error_type: Some(failure.error_type.as_deref().unwrap_or("server_error")),
        code: Some(failure.code.as_deref().unwrap_or("stream_error")),
        ..Classification::default()
    };
    build_error_body(failure.status, &failure.message, None, &classification)
        .get("error")
        .cloned()
        .unwrap_or(Value::Null)
}

/// Legacy `projectCompletedStreamError`: the public error of a stream that
/// completed with a failure.
pub fn project_completed_stream_error(failure: &StreamFailure) -> Value {
    // The legacy code is the numeric status as a string.
    let code = failure.status.to_string();
    let classification = Classification {
        error_type: Some(failure.error_type.as_deref().unwrap_or("server_error")),
        code: Some(&code),
        ..Classification::default()
    };
    build_error_body(failure.status, &failure.message, None, &classification)
        .get("error")
        .cloned()
        .unwrap_or(Value::Null)
}

const RESPONSES_FAILURE_SCALAR_FIELDS: [&str; 15] = [
    "id",
    "object",
    "created_at",
    "completed_at",
    "background",
    "model",
    "max_output_tokens",
    "max_tool_calls",
    "parallel_tool_calls",
    "previous_response_id",
    "service_tier",
    "store",
    "temperature",
    "top_p",
    "truncation",
];

static ABSOLUTE_PATH_SEGMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:^|[\\/])(?:Users|app|etc|home|opt|private|root|srv|tmp|usr|var|workspace)[\\/]",
    )
    .expect("static pattern")
});
static RESPONSE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,511}$").expect("static pattern"));
static MODEL_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$").expect("static pattern"));

/// Legacy `projectResponsesFailureString`: a string field of a failed
/// response, redacted when it holds a secret, an absolute path or, for ids
/// and the model, an unexpected shape.
fn project_failure_string(key: &str, value: &str) -> String {
    let sanitized = sanitize_error_message(value);
    if sanitized != value || ABSOLUTE_PATH_SEGMENT.is_match(value) {
        return "[REDACTED]".to_owned();
    }
    if matches!(key, "id" | "previous_response_id") && !RESPONSE_ID.is_match(value) {
        return "[REDACTED]".to_owned();
    }
    if key == "model" && !MODEL_NAME.is_match(value) {
        return "[REDACTED]".to_owned();
    }
    sanitized
}

fn finite_number(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| value.as_f64().is_some_and(f64::is_finite) && value.is_number())
}

fn project_failure_usage(value: Option<&Value>) -> Option<Value> {
    let usage = record(value);
    let mut projected = Map::new();
    for key in ["input_tokens", "output_tokens", "total_tokens"] {
        if let Some(number) = finite_number(usage.get(key)) {
            projected.insert(key.to_owned(), number.clone());
        }
    }
    for (key, allowed) in [
        ("input_tokens_details", &["cached_tokens"][..]),
        (
            "output_tokens_details",
            &[
                "reasoning_tokens",
                "accepted_prediction_tokens",
                "rejected_prediction_tokens",
            ][..],
        ),
    ] {
        let details: Map<String, Value> = record(usage.get(key))
            .iter()
            .filter(|(name, detail)| {
                allowed.contains(&name.as_str()) && finite_number(Some(detail)).is_some()
            })
            .map(|(name, detail)| (name.clone(), detail.clone()))
            .collect();
        if !details.is_empty() {
            projected.insert(key.to_owned(), Value::Object(details));
        }
    }
    (!projected.is_empty()).then_some(Value::Object(projected))
}

/// Legacy `projectResponsesFailureOutput`: only the public assistant text and
/// refusal of a failed response, every kept field rebuilt explicitly.
fn project_failure_output(value: &Value) -> Vec<Value> {
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    let mut output = Vec::new();
    for item in items {
        let item = record(Some(item));
        let is_assistant_message = item.get("type").and_then(Value::as_str) == Some("message")
            && item.get("role").and_then(Value::as_str) == Some("assistant");
        if !is_assistant_message || item.get("phase").and_then(Value::as_str) == Some("commentary")
        {
            continue;
        }
        let mut content = Vec::new();
        if let Some(Value::Array(parts)) = item.get("content") {
            for part in parts {
                let part = record(Some(part));
                if part.get("phase").and_then(Value::as_str) == Some("commentary") {
                    continue;
                }
                match (
                    part.get("type").and_then(Value::as_str),
                    part.get("text"),
                    part.get("refusal"),
                ) {
                    (Some("output_text"), Some(Value::String(text)), _) => content.push(json!({
                        "type": "output_text",
                        "text": project_failure_string("text", text),
                        // The required schema, without any provider citation metadata.
                        "annotations": [],
                    })),
                    (Some("refusal"), _, Some(Value::String(refusal))) => content.push(json!({
                        "type": "refusal",
                        "refusal": project_failure_string("refusal", refusal),
                    })),
                    _ => {}
                }
            }
        }
        let mut projected = Map::new();
        projected.insert("type".to_owned(), json!("message"));
        projected.insert("role".to_owned(), json!("assistant"));
        projected.insert("content".to_owned(), Value::Array(content));
        if let Some(Value::String(id)) = item.get("id") {
            projected.insert("id".to_owned(), json!(project_failure_string("id", id)));
        }
        if let Some(status @ ("in_progress" | "completed" | "incomplete")) =
            item.get("status").and_then(Value::as_str)
        {
            projected.insert("status".to_owned(), json!(status));
        }
        output.push(Value::Object(projected));
    }
    output
}

/// Legacy `projectResponsesFailureObject`: only documented protocol fields,
/// so provider diagnostics, settings and stack traces never cross.
fn project_failure_response(response: &Map<String, Value>, public_error: &Value) -> Value {
    let mut projected = Map::new();
    projected.insert("status".to_owned(), json!("failed"));
    projected.insert("error".to_owned(), public_error.clone());
    for key in RESPONSES_FAILURE_SCALAR_FIELDS {
        match response.get(key) {
            Some(Value::String(text)) => {
                projected.insert(key.to_owned(), json!(project_failure_string(key, text)));
            }
            Some(value @ (Value::Null | Value::Number(_) | Value::Bool(_))) => {
                projected.insert(key.to_owned(), value.clone());
            }
            _ => {}
        }
    }
    if let Some(output) = response.get("output").filter(|output| output.is_array()) {
        projected.insert(
            "output".to_owned(),
            Value::Array(project_failure_output(output)),
        );
    }
    if let Some(usage) = project_failure_usage(response.get("usage")) {
        projected.insert("usage".to_owned(), usage);
    }
    if response.contains_key("last_error") {
        projected.insert("last_error".to_owned(), public_error.clone());
    }
    Value::Object(projected)
}

/// Legacy `projectStreamFailureEvent`: a failure event of the stream rebuilt
/// from public pieces only. `None` when the payload is not a failure event.
pub fn project_stream_failure_event(payload: &Value) -> Option<ProjectedStreamFailureEvent> {
    let root = record(Some(payload));
    let response = record(root.get("response"));
    let has_root_error = non_empty_object(root.get("error")).is_some()
        || non_blank_string(root.get("error")).is_some();
    let kind = root.get("type").and_then(Value::as_str);
    let is_responses_failure = kind == Some("response.failed")
        || (kind == Some("response.completed")
            && response.get("status").and_then(Value::as_str) == Some("failed"));
    let is_claude_failure = kind == Some("error");
    if !is_responses_failure && !is_claude_failure && !has_root_error {
        return None;
    }
    let internal_failure = normalize_stream_failure_payload(payload);
    let error = public_error(&internal_failure);
    let public_payload = if is_responses_failure {
        let mut out = Map::new();
        out.insert(
            "type".to_owned(),
            root.get("type").cloned().unwrap_or(Value::Null),
        );
        out.insert(
            "response".to_owned(),
            project_failure_response(response, &error),
        );
        if let Some(sequence) = finite_number(root.get("sequence_number")) {
            out.insert("sequence_number".to_owned(), sequence.clone());
        }
        Value::Object(out)
    } else if is_claude_failure {
        json!({"type": "error", "error": error})
    } else {
        json!({"error": error})
    };
    let public_message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    Some(ProjectedStreamFailureEvent {
        internal_failure,
        public_message,
        public_payload,
    })
}

/// Legacy `prepareTranslatedStreamFailure`. `None` when the payload carries no
/// failure at all.
pub fn prepare_translated_stream_failure(
    payload: &Value,
) -> Option<PreparedTranslatedStreamFailure> {
    let record_value = if payload.is_object() {
        payload.clone()
    } else {
        json!({})
    };
    let projected = project_stream_failure_event(&record_value);
    if projected.is_none() && !truthy(record_value.get("error")) {
        return None;
    }
    let (internal_failure, provider_payload, public_message) = match projected {
        Some(projected) => (
            projected.internal_failure,
            projected.public_payload,
            Some(projected.public_message).filter(|message| !message.is_empty()),
        ),
        None => (
            // The legacy code runs normalization here and has the generic
            // fallback only if it returns nothing, which it never does.
            normalize_stream_failure_payload(&record_value),
            record_value.clone(),
            None,
        ),
    };
    Some(PreparedTranslatedStreamFailure {
        record: record_value,
        provider_payload,
        internal_failure,
        public_message: public_message.unwrap_or_else(|| "Upstream failure".to_owned()),
    })
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

fn ordered_object(entries: Vec<(&str, Ordered)>) -> Ordered {
    Ordered::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

fn scalar(value: Value) -> Ordered {
    Ordered::Scalar(value)
}

/// Legacy `formatTranslatedStreamError`: the SSE text a client in
/// `source_format` receives for a failure in a translated stream.
pub fn format_translated_stream_error(
    payload: &Value,
    source_format: Option<&str>,
    now_ms: u128,
) -> String {
    let failure = normalize_stream_failure_payload(payload);
    let error = public_error(&failure);
    match source_format {
        Some("openai-responses") => {
            let failed = ordered_object(vec![
                ("type", scalar(json!("response.failed"))),
                (
                    "response",
                    ordered_object(vec![
                        ("id", scalar(json!(format!("resp_error_{now_ms}")))),
                        ("object", scalar(json!("response"))),
                        ("created_at", scalar(json!(now_ms / 1000))),
                        ("status", scalar(json!("failed"))),
                        ("background", scalar(json!(false))),
                        ("error", Ordered::from_value(&error)),
                        ("output", Ordered::Array(Vec::new())),
                    ]),
                ),
                (
                    "sequence_number",
                    scalar(json!(SYNTHETIC_RESPONSES_SEQUENCE_NUMBER)),
                ),
            ]);
            format!(
                "event: response.failed\ndata: {}\n\n",
                serde_json::to_string(&failed).unwrap_or_default()
            )
        }
        Some("claude") => {
            let body = ordered_object(vec![
                ("type", scalar(json!("error"))),
                ("error", Ordered::from_value(&error)),
            ]);
            format!(
                "event: error\ndata: {}\n\n",
                serde_json::to_string(&body).unwrap_or_default()
            )
        }
        _ => {
            let body = ordered_object(vec![("error", Ordered::from_value(&error))]);
            format!(
                "data: {}\n\ndata: [DONE]\n\n",
                serde_json::to_string(&body).unwrap_or_default()
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure_json(failure: &StreamFailure) -> Value {
        let mut out = json!({"status": failure.status, "message": failure.message});
        if let Some(code) = &failure.code {
            out["code"] = json!(code);
        }
        if let Some(kind) = &failure.error_type {
            out["type"] = json!(kind);
        }
        out
    }

    /// The data payload of the first SSE frame of `text`.
    fn frame_data(text: &str) -> Value {
        let data = text
            .lines()
            .find(|line| line.starts_with("data: "))
            .unwrap();
        serde_json::from_str(&data["data: ".len()..]).unwrap()
    }

    /// Outputs the legacy functions produced for the same inputs
    /// (`stream_error_format_oracle.json`, generated with Node with the clock
    /// fixed).
    #[test]
    fn failures_match_the_legacy_implementation() {
        let oracle: Value =
            serde_json::from_str(include_str!("stream_error_format_oracle.json")).unwrap();
        for case in oracle["normalize"].as_array().unwrap() {
            assert_eq!(
                failure_json(&normalize_stream_failure_payload(&case[0])),
                case[1],
                "{case}"
            );
        }
        for case in oracle["project"].as_array().unwrap() {
            let actual = project_stream_failure_event(&case[0]).map_or(Value::Null, |event| {
                json!({
                    "internalFailure": failure_json(&event.internal_failure),
                    "publicMessage": event.public_message,
                    "publicPayload": event.public_payload,
                })
            });
            assert_eq!(actual, case[1], "{case}");
        }
        for case in oracle["prepare"].as_array().unwrap() {
            let actual =
                prepare_translated_stream_failure(&case[0]).map_or(Value::Null, |prepared| {
                    json!({
                        "record": prepared.record,
                        "providerPayload": prepared.provider_payload,
                        "internalFailure": failure_json(&prepared.internal_failure),
                        "publicMessage": prepared.public_message,
                    })
                });
            assert_eq!(actual, case[1], "{case}");
        }
        for case in oracle["format"].as_array().unwrap() {
            let text =
                format_translated_stream_error(&case[0], case[1].as_str(), 1_700_000_000_000);
            let expected = case[2].as_str().unwrap();
            let prefix = expected.split("data: ").next().unwrap();
            assert!(text.starts_with(prefix), "{case}: {text}");
            assert_eq!(frame_data(&text), frame_data(expected), "{case}");
            assert_eq!(
                text.ends_with("data: [DONE]\n\n"),
                expected.ends_with("data: [DONE]\n\n"),
                "{case}"
            );
        }
        let completed = oracle["completed"].as_array().unwrap();
        for case in completed {
            let failure = StreamFailure {
                status: u16::try_from(case[0].as_i64().unwrap()).unwrap(),
                message: case[1].as_str().unwrap().to_owned(),
                code: None,
                error_type: case[2].as_str().map(str::to_owned),
            };
            assert_eq!(project_completed_stream_error(&failure), case[3], "{case}");
        }
    }
}
