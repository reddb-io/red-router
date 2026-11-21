//! The in-chat usage command, ported from the legacy
//! `src/lib/usage/internalUsageCommand.ts`: a chat, messages or responses
//! request whose last user text is `@@om-usage` is answered locally with the
//! provider quota of the key's accounts instead of reaching an upstream.
//!
//! A key opts in with the `usage:command` scope (legacy `allow_usage_command`).
//! Narrower than the legacy command: quotas come from the stored native
//! `session`/`weekly` windows, the cutoff is the global quota preflight
//! threshold (no per-connection or per-provider window overrides), and the
//! per-key USD "Personal quota" section is absent because the cutover refuses
//! per-key usage limits.

use crate::control_plane::{ProviderQuotaView, QuotaWindowView};
use axum::{
    http::{header, HeaderValue},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

/// Legacy `INTERNAL_USAGE_COMMAND`.
pub const INTERNAL_USAGE_COMMAND: &str = "@@om-usage";
/// The scope that opts a key into the command (legacy `allow_usage_command`).
pub const USAGE_COMMAND_SCOPE: &str = "usage:command";
/// Legacy `USAGE_COMMAND_DISABLED_MESSAGE`.
pub const USAGE_COMMAND_DISABLED_MESSAGE: &str = "Usage command is disabled for this API key.";
const LOCAL_USAGE_MODEL: &str = "omniroute/local-usage";

/// Legacy `textFromContent`.
fn text_from_content(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let texts: Vec<&str> = parts
                .iter()
                .filter_map(|part| match part {
                    Value::String(text) => Some(text.as_str()),
                    Value::Object(part) => part
                        .get("text")
                        .or_else(|| part.get("content"))
                        .and_then(Value::as_str),
                    _ => None,
                })
                .collect();
            (!texts.is_empty()).then(|| texts.concat())
        }
        Value::Object(part) => part
            .get("text")
            .or_else(|| part.get("content"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        _ => None,
    }
}

/// Legacy `extractLastRoleText` for the user role.
fn last_user_text(items: &Value) -> Option<String> {
    let item = items
        .as_array()?
        .iter()
        .rev()
        .find(|item| item.get("role").and_then(Value::as_str) == Some("user"))?;
    text_from_content(item.get("content")?)
}

/// Legacy `extractLastUserText` + `isInternalUsageCommand`.
pub fn is_usage_command(body: &Value) -> bool {
    if !body.is_object() {
        return false;
    }
    let text = body
        .get("messages")
        .and_then(last_user_text)
        .or_else(|| body.get("input").and_then(Value::as_str).map(str::to_owned))
        .or_else(|| body.get("input").and_then(last_user_text));
    text.is_some_and(|text| text.trim() == INTERNAL_USAGE_COMMAND)
}

/// Legacy `formatResetIn`.
pub fn format_reset_in(reset_at_unix_ms: Option<u64>, now_unix_ms: i64) -> String {
    let Some(reset) = reset_at_unix_ms.and_then(|at| i64::try_from(at).ok()) else {
        return "unknown".to_owned();
    };
    let delta = reset - now_unix_ms;
    if delta <= 0 {
        return "now".to_owned();
    }
    let total_minutes = ((delta + 59_999) / 60_000).max(1);
    let days = total_minutes / (24 * 60);
    let hours = (total_minutes % (24 * 60)) / 60;
    let minutes = total_minutes % 60;
    if days > 0 {
        format!("{days}d {hours}h {minutes}m")
    } else if hours > 0 {
        format!("{hours}h {minutes}m")
    } else {
        format!("{minutes}m")
    }
}

/// Legacy `effectiveRemainingPercent`.
fn effective_remaining(real_remaining: f64, cutoff_percent: f64) -> f64 {
    let remaining = real_remaining.clamp(0.0, 100.0);
    let cutoff = cutoff_percent.clamp(0.0, 99.0);
    if remaining <= cutoff {
        return 0.0;
    }
    (remaining - cutoff) / (100.0 - cutoff) * 100.0
}

/// Legacy `formatLeftPercent`.
fn format_left(percent: Option<f64>) -> String {
    match percent.filter(|value| value.is_finite()) {
        Some(value) => format!("{}% left", value.clamp(0.0, 100.0).round() as i64),
        None => "Unavailable".to_owned(),
    }
}

fn append_block(
    lines: &mut Vec<String>,
    label: &str,
    window: Option<&QuotaWindowView>,
    cutoff: f64,
    now: i64,
) {
    lines.push(label.to_owned());
    // A missing window has no cutoff applied (legacy `match ? ... : 0`).
    let remaining = window.map(|window| effective_remaining(window.remaining_percent, cutoff));
    lines.push(format_left(remaining));
    lines.push(format!(
        "⏱ reset in {}",
        format_reset_in(window.and_then(|window| window.reset_at_unix_ms), now)
    ));
}

/// Legacy `snapshotScore` over a native quota view (no plan, no sonnet
/// window natively).
fn score(provider: &str, view: &ProviderQuotaView) -> i32 {
    let mut score = if provider == "claude" { 100 } else { 0 };
    if view.session.is_some() {
        score += 10;
    }
    if view.weekly.is_some() {
        score += 10;
    }
    score
}

/// Legacy `buildUsageCommandText`: the best account's provider quota block,
/// accounts given as `(record id, provider type, stored quota)`.
pub fn usage_text(
    accounts: &[(String, String, Option<ProviderQuotaView>)],
    cutoff_percent: f64,
    now_unix_ms: i64,
) -> String {
    let mut best: Option<(&str, &ProviderQuotaView)> = None;
    let mut best_score = -1;
    for (_, provider, view) in accounts {
        // Legacy snapshots exist only for connections with cached quotas.
        let Some(view) = view
            .as_ref()
            .filter(|view| view.session.is_some() || view.weekly.is_some())
        else {
            continue;
        };
        let score = score(provider, view);
        if score > best_score {
            best = Some((provider, view));
            best_score = score;
        }
    }
    let Some((_, view)) = best else {
        return ["Provider quota", "No cached usage data available."].join("\n");
    };
    let mut lines = vec!["Provider quota".to_owned()];
    append_block(
        &mut lines,
        "Session",
        view.session.as_ref(),
        cutoff_percent,
        now_unix_ms,
    );
    lines.push(String::new());
    append_block(
        &mut lines,
        "Weekly",
        view.weekly.as_ref(),
        cutoff_percent,
        now_unix_ms,
    );
    lines.join("\n")
}

fn response_model(body: &Value) -> String {
    body.get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.trim().is_empty())
        .unwrap_or(LOCAL_USAGE_MODEL)
        .to_owned()
}

fn event_stream(payload: String) -> Response {
    let mut response = payload.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    response
}

/// Legacy `createLocalTextResponse`: the text as an assistant answer in the
/// client's format (Anthropic Messages or OpenAI Chat Completions).
pub fn local_text_response(
    anthropic: bool,
    body: &Value,
    text: &str,
    now_unix_ms: i64,
) -> Response {
    let stream = body.get("stream") == Some(&Value::Bool(true));
    let model = response_model(body);
    if anthropic {
        let id = format!("msg_usage_{now_unix_ms}");
        if !stream {
            return Json(json!({
                "id": id,
                "type": "message",
                "role": "assistant",
                "model": model,
                "content": [{"type": "text", "text": text}],
                "stop_reason": "end_turn",
                "stop_sequence": null,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            }))
            .into_response();
        }
        let events = [
            (
                "message_start",
                json!({"type":"message_start","message":{"id":id,"type":"message","role":"assistant","model":model,"content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}),
            ),
            (
                "content_block_start",
                json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            ),
            (
                "content_block_delta",
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}),
            ),
            (
                "content_block_stop",
                json!({"type":"content_block_stop","index":0}),
            ),
            (
                "message_delta",
                json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":0}}),
            ),
            ("message_stop", json!({"type":"message_stop"})),
        ];
        return event_stream(
            events
                .iter()
                .map(|(event, data)| format!("event: {event}\ndata: {data}\n\n"))
                .collect(),
        );
    }
    let created = now_unix_ms / 1000;
    let id = format!("chatcmpl_usage_{created}");
    if !stream {
        return Json(json!({
            "id": id,
            "object": "chat.completion",
            "created": created,
            "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }))
        .into_response();
    }
    let first = json!({"id":id,"object":"chat.completion.chunk","created":created,"model":model,"choices":[{"index":0,"delta":{"role":"assistant","content":text},"finish_reason":null}]});
    let second = json!({"id":id,"object":"chat.completion.chunk","created":created,"model":model,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
    event_stream(format!(
        "data: {first}\n\ndata: {second}\n\ndata: [DONE]\n\n"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(session: Option<f64>, weekly: Option<f64>, reset: Option<u64>) -> ProviderQuotaView {
        ProviderQuotaView {
            provider_id: "acct".to_owned(),
            models: Vec::new(),
            session: session.map(|remaining_percent| QuotaWindowView {
                remaining_percent,
                reset_at_unix_ms: reset,
            }),
            weekly: weekly.map(|remaining_percent| QuotaWindowView {
                remaining_percent,
                reset_at_unix_ms: reset,
            }),
            limit_reached: false,
            observed_at_unix_ms: 0,
            expires_at_unix_ms: 0,
            revision: String::new(),
        }
    }

    #[test]
    fn the_command_is_the_trimmed_last_user_text() {
        assert!(is_usage_command(
            &json!({"messages":[{"role":"user","content":"hi"},{"role":"user","content":"  @@om-usage \n"}]})
        ));
        assert!(is_usage_command(
            &json!({"messages":[{"role":"user","content":[{"type":"text","text":"@@om-usage"}]}]})
        ));
        assert!(is_usage_command(&json!({"input":"@@om-usage"})));
        assert!(is_usage_command(
            &json!({"input":[{"role":"user","content":"@@om-usage"}]})
        ));
        assert!(!is_usage_command(
            &json!({"messages":[{"role":"user","content":"@@om-usage"},{"role":"user","content":"hi"}]})
        ));
        assert!(!is_usage_command(
            &json!({"messages":[{"role":"user","content":"@@om-usage please"}]})
        ));
    }

    #[test]
    fn reset_and_percent_format_like_the_legacy_command() {
        let now = 1_000_000_000;
        assert_eq!(format_reset_in(None, now), "unknown");
        assert_eq!(format_reset_in(Some(1_000), now), "now");
        assert_eq!(format_reset_in(Some(now as u64 + 30_000), now), "1m");
        assert_eq!(
            format_reset_in(Some(now as u64 + 3 * 3_600_000 + 5 * 60_000), now),
            "3h 5m"
        );
        assert_eq!(
            format_reset_in(Some(now as u64 + 2 * 86_400_000 + 60_000), now),
            "2d 0h 1m"
        );
        assert_eq!(
            format_left(Some(effective_remaining(50.0, 2.0))),
            "49% left"
        );
        assert_eq!(format_left(Some(effective_remaining(1.0, 2.0))), "0% left");
        assert_eq!(format_left(None), "Unavailable");
    }

    #[test]
    fn the_best_account_is_rendered() {
        let now = 1_000_000_000;
        assert_eq!(
            usage_text(&[], 2.0, now),
            "Provider quota\nNo cached usage data available."
        );
        let accounts = vec![
            (
                "a".to_owned(),
                "codex".to_owned(),
                Some(view(Some(80.0), None, None)),
            ),
            (
                "b".to_owned(),
                "claude".to_owned(),
                Some(view(Some(50.0), Some(98.0), Some(now as u64 + 60_000))),
            ),
            ("c".to_owned(), "openai".to_owned(), None),
        ];
        assert_eq!(
            usage_text(&accounts, 2.0, now),
            "Provider quota\nSession\n49% left\n⏱ reset in 1m\n\nWeekly\n98% left\n⏱ reset in 1m"
        );
    }
}
