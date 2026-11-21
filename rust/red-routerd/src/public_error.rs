//! The client-visible error envelope, ported from the legacy
//! `open-sse/utils/error.ts` (`buildErrorBody`, `projectPublicErrorIdentifier`,
//! `parseUpstreamError`, `formatProviderError`, `createErrorResult`),
//! `open-sse/config/errorConfig.ts` (`ERROR_TYPES`, `DEFAULT_ERROR_MESSAGES`),
//! `open-sse/utils/upstreamErrorPassthrough.ts` and
//! `open-sse/utils/upstreamErrorResponse.ts`.
//!
//! RedRouter-generated errors always carry the OpenAI-compatible envelope
//! `{error:{message,type,code}}` with a sanitized message and, when the
//! provider answered with a body, its sanitized projection as
//! `upstream_details`. A Claude-format 4xx whose body is free of internal
//! paths and echoed credentials keeps its own sanitized shape instead.

use crate::error_sanitization::{
    contains_sensitive_error_credential, sanitize_error_message,
    sanitize_passthrough_upstream_details, sanitize_upstream_details, JS_S,
};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime};

/// Legacy `SAFE_PUBLIC_ERROR_IDENTIFIERS` (open-sse/utils/error.ts), in order.
const SAFE_PUBLIC_ERROR_IDENTIFIERS: &[&str] = &[
    "systemone_credential_required",
    "systemone_credential_rejected",
    "systemone_endpoint_not_found",
    "systemone_resource_not_found",
    "systemone_model_unavailable",
    "systemone_transport_failure",
    "systemone_invalid_response",
    "systemone_upstream_http_error",
    "systemone_connection_unavailable",
    "abort",
    "aborted",
    "account_semaphore_capacity",
    "acp_cancelled",
    "acp_early_exit",
    "acp_error",
    "acp_output_too_large",
    "acp_session_mismatch",
    "acp_timeout",
    "admission_aborted",
    "admission_deadline",
    "admission_lane_evicted",
    "admission_oversized",
    "admission_queue_full",
    "admission_shutdown",
    "admission_unavailable",
    "all_accounts_inactive",
    "all_targets_cooling_down",
    "all_targets_skipped",
    "antigravity_pool_busy",
    "antigravity_pre_response_timeout",
    "api_error",
    "api_key_limit",
    "auth_error",
    "authentication_error",
    "authentication_required",
    "bad_gateway",
    "bad_request",
    "bedrock_stream_error",
    "billing_error",
    "blackbox_auth_required",
    "blackbox_rate_limit",
    "blackbox_subscription_required",
    "body_exceeds_budget",
    "browser_stream_inconsistent",
    "budget_exceeded",
    "budget_unavailable",
    "budget_price_unavailable",
    "capability_mismatch",
    "cf_mitigated_challenge",
    "chat_admission_busy",
    "chat_history_too_large",
    "chatgpt_session_expired",
    "chatgpt_submission_ambiguous",
    "chatgpt_submitted_turn_failed",
    "chatgpt_subscription_unavailable",
    "chatgpt_web_codex_error",
    "chatgpt_web_codex_turn_failed",
    "claude_web_protocol_error",
    "cli_not_found",
    "client_cancelled",
    "client_closed_request",
    "client_disconnected",
    "cloudflare_challenge",
    "cloudflare_or_bot",
    "codex_app_server_turn_failed",
    "codex_app_server_unconfigured",
    "codex_scope_cooldown",
    "codex_tool_timeout",
    "combo_target_timeout",
    "combo_timeout",
    "compaction_control_unavailable",
    "compaction_handoff_failed",
    "compaction_source_unavailable",
    "connection_cooldown",
    "connection_error",
    "connection_not_allowed",
    "connection_terminal_status",
    "connection_unavailable",
    "connector_error",
    "connector_not_found",
    "context_length_exceeded",
    "context_window",
    "devin_agentic_error",
    "devin_cli_error",
    "devin_desktop_error",
    "devin_internal_tool_execution",
    "direct_response_start_timeout",
    "duplicate_tool_use_id",
    "eai_again",
    "econnrefused",
    "econnreset",
    "empty_acp_output",
    "empty_content",
    "empty_messages",
    "empty_response",
    "error",
    "etimedout",
    "executor_contract_violation",
    "executor_error",
    "extract_failed",
    "feature_disabled",
    "file_too_large",
    "gateway_timeout",
    "gcp_project_required",
    "gemini_tpm_exhausted",
    "grok_error",
    "heap_pressure",
    "huggingchat_generation_error",
    "incompatible_reasoning_effort",
    "inspector_error",
    "insufficient_quota",
    "internal_server_error",
    "invalid_acp_frame",
    "invalid_acp_upstream",
    "invalid_api_key",
    "invalid_authentication",
    "invalid_connection_id",
    "invalid_encrypted_content",
    "invalid_grant",
    "invalid_json",
    "invalid_kiro_tool_call",
    "invalid_output_schema",
    "invalid_previous_response_binding",
    "invalid_provider",
    "invalid_request",
    "invalid_request_body",
    "invalid_request_error",
    "invalid_tool_arguments",
    "invalid_tool_choice",
    "invalid_tool_json",
    "invalid_tool_name",
    "invalid_tools",
    "invalid_trailer",
    "lease_action_invalid",
    "lease_api_key_invalid",
    "lease_authentication_required",
    "lease_authorization_mismatch",
    "lease_capacity_unavailable",
    "lease_connection_mismatch",
    "lease_content_type_required",
    "lease_context_invalid",
    "lease_context_required",
    "lease_eligibility_unavailable",
    "lease_error",
    "lease_fence_stale",
    "lease_key_configuration_invalid",
    "lease_key_policy_invalid",
    "lease_model_invalid",
    "lease_no_eligible_connection",
    "lease_required",
    "lease_scope_required",
    "lease_service_unavailable",
    "lease_unsupported_route",
    "lease_unsupported_transport",
    "lmarena_error",
    "lmarena_stream_error",
    "message_limit",
    "meta_ai_empty_response",
    "meta_ai_mode_switch_failed",
    "meta_ai_warmup_failed",
    "meta_ai_ws_error",
    "missing_authorization",
    "missing_cookie",
    "missing_credentials",
    "missing_credits",
    "missing_project_id",
    "missing_session_id",
    "missing_tool_name",
    "missing_tool_use_id",
    "mixed_tool_narrative",
    "model_cooldown",
    "model_disabled",
    "model_excluded",
    "model_lockout",
    "model_not_allowed",
    "model_not_found",
    "model_not_supported",
    "model_shutdown",
    "multipart_protocol_violation",
    "multiple_tool_requests",
    "native_codex_pinned_model_unavailable",
    "network_error",
    "no_active_connection",
    "no_active_credentials",
    "no_free_eligible_connection",
    "no_local_login",
    "no_refresh_token",
    "not_found",
    "oauth_missing_project_id",
    "origin_rejected",
    "orphan_tool_result",
    "overloaded",
    "payload_too_large",
    "payment_required",
    "peer_hop_limit_exceeded",
    "peer_loop_detected",
    "permission_denied",
    "permission_error",
    "pplx_error",
    "premium_model_requires_key",
    "previous_response_not_found",
    "prompt_attachment_integrity",
    "provider_circuit_half_open",
    "provider_circuit_open",
    "provider_deprecated",
    "provider_error",
    "provider_retired",
    "provider_unavailable",
    "proxy_family_unavailable",
    "proxy_request_failed",
    "proxy_unavailable",
    "proxy_unreachable",
    "quota_exhausted",
    "quota_not_allocated",
    "quota_only",
    "rate_limit_error",
    "rate_limit_exceeded",
    "rate_limit_execution_timeout",
    "rate_limit_longer_reached",
    "rate_limit_queue_full",
    "rate_limit_queue_timeout",
    "rate_limit_queue_wedged",
    "rate_limit_reached",
    "rate_limited",
    "reached_limit",
    "read_failed",
    "relay_timeout",
    "request_failed",
    "resource_exhausted",
    "resource_pressure",
    "risk_session_stale",
    "semaphore_queue_full",
    "semaphore_timeout",
    "server_error",
    "server_is_overloaded",
    "service_not_running",
    "service_unavailable",
    "session_expired",
    "session_pool_exhausted",
    "spawn_failed",
    "storage_encryption_stale",
    "stream_content_stall",
    "stream_disconnected",
    "stream_early_eof",
    "stream_error",
    "stream_idle_timeout",
    "stream_pipeline_error",
    "stream_readiness_timeout",
    "stream_terminated",
    "stream_timeout",
    "structure_limit",
    "structured_output",
    "structured_output_validation_failed",
    "subscription_required",
    "temporarily_unavailable",
    "timeout",
    "timeout_error",
    "tls_circuit_open",
    "tls_client_unavailable",
    "tls_fingerprint_failed",
    "tls_session_capacity",
    "token_limit_exceeded",
    "token_required",
    "tool_calling_not_supported",
    "tools",
    "turn_in_progress",
    "uc_auth_error",
    "uc_generation_failed",
    "uc_message_limit_exceeded",
    "uc_paywall_exceeded",
    "uc_rate_limit_exceeded",
    "uc_timeout",
    "uc_upstream_error",
    "unauthorized",
    "unavailable",
    "und_err_body_timeout",
    "und_err_connect_timeout",
    "und_err_headers_timeout",
    "und_err_socket",
    "undeclared_historical_tool",
    "unexecuted_tool_intent",
    "routing_storage_already_exists",
    "routing_storage_configuration",
    "routing_storage_conflict",
    "routing_storage_invalid_snapshot",
    "routing_storage_not_initialized",
    "routing_storage_unavailable",
    "routing_storage_unsupported_operation",
    "unexpected_acp_response",
    "unknown_devin_model",
    "unknown_route",
    "unknown_tool",
    "unsafe_devin_home",
    "unsupported_acp_version",
    "unsupported_content_block",
    "unsupported_control_for_provider",
    "unsupported_endpoint",
    "unsupported_feature",
    "unsupported_image_block",
    "unsupported_media_type",
    "unsupported_role",
    "unsupported_runtime",
    "unsupported_system_block",
    "unverified_codex_client",
    "upgrade_required",
    "upstream_access_denied",
    "upstream_auth_error",
    "upstream_empty_response",
    "upstream_error",
    "upstream_protocol_error",
    "upstream_response_error",
    "upstream_response_failed",
    "upstream_server_error",
    "upstream_timeout",
    "upstream_websocket_connect_failed",
    "upstream_websocket_error",
    "usage_limit_exceeded",
    "usage_limit_reached",
    "video_artifact_content_type_invalid",
    "video_artifact_download_failed",
    "video_artifact_not_ready",
    "video_artifact_signature_invalid",
    "video_artifact_too_large",
    "video_artifact_unavailable",
    "video_artifact_url_blocked",
    "video_artifact_url_invalid",
    "vision",
    "wreq_unavailable",
    "writes_disabled",
    "zai_stream_error",
];

/// Legacy `ERROR_TYPES` / `getErrorInfo`: the public type and code of a status.
pub fn error_info(status: u16) -> (&'static str, &'static str) {
    match status {
        400 => ("invalid_request_error", "bad_request"),
        401 => ("authentication_error", "invalid_api_key"),
        402 => ("billing_error", "payment_required"),
        403 => ("permission_error", "permission_denied"),
        404 => ("invalid_request_error", "model_not_found"),
        406 => ("invalid_request_error", "model_not_supported"),
        410 => ("invalid_request_error", "model_shutdown"),
        429 => ("rate_limit_error", "rate_limit_exceeded"),
        499 => ("client_disconnected", "client_disconnected"),
        502 => ("server_error", "bad_gateway"),
        503 => ("server_error", "service_unavailable"),
        504 => ("server_error", "gateway_timeout"),
        500.. => ("server_error", "internal_server_error"),
        _ => ("invalid_request_error", ""),
    }
}

/// Legacy `DEFAULT_ERROR_MESSAGES` / `getDefaultErrorMessage`.
pub fn default_error_message(status: u16) -> &'static str {
    match status {
        400 => "Bad request",
        401 => "Invalid API key provided",
        402 => "Payment required",
        403 => "Permission denied",
        404 => "Model not found",
        406 => "Model not supported",
        410 => "Model has been shut down",
        429 => "Rate limit exceeded",
        499 => "Client disconnected",
        500 => "Internal server error",
        502 => "Bad gateway - upstream provider error",
        503 => "Service temporarily unavailable",
        504 => "Gateway timeout",
        _ => "An error occurred",
    }
}

static PUBLIC_ERROR_IDENTIFIER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$").expect("static pattern"));
static HTTP_STATUS_IDENTIFIER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:[1-5][0-9]{2}|(?i-u:HTTP_)[1-5][0-9]{2})$").expect("static pattern")
});

/// Legacy `isSafePublicErrorIdentifier`.
fn safe_public_error_identifier(value: &str) -> bool {
    PUBLIC_ERROR_IDENTIFIER.is_match(value)
        && (HTTP_STATUS_IDENTIFIER.is_match(value)
            || SAFE_PUBLIC_ERROR_IDENTIFIERS.contains(&value.to_ascii_lowercase().as_str()))
}

/// Legacy `projectPublicErrorIdentifier`: an internal classification on the
/// bounded public vocabulary, else the (safe) fallback, else `"error"`.
pub fn project_public_error_identifier(value: Option<&str>, fallback: &str) -> String {
    let safe_fallback = if fallback.is_empty() || safe_public_error_identifier(fallback) {
        fallback
    } else {
        "error"
    };
    match value {
        Some(value) if safe_public_error_identifier(value) => value.to_owned(),
        _ => safe_fallback.to_owned(),
    }
}

/// Legacy `ErrorBodyClassification`.
#[derive(Debug, Default, Clone)]
pub struct Classification<'a> {
    pub error_type: Option<&'a str>,
    pub code: Option<&'a str>,
    pub reason: Option<&'a str>,
    /// The instant the underlying limit resets.
    pub retry_at: Option<SystemTime>,
}

/// Legacy `resolveRetryAfterInstant` for an instant: `retry_after` seconds
/// (rounded up, at least 1) and the ISO `reset_at`, only when in the future.
fn retry_fields(retry_at: SystemTime, now: SystemTime) -> Option<(u64, String)> {
    let remaining = retry_at.duration_since(now).ok().filter(|d| !d.is_zero())?;
    let millis = remaining.as_millis();
    let seconds = u64::try_from(millis.div_ceil(1000))
        .unwrap_or(u64::MAX)
        .max(1);
    let since_epoch = retry_at.duration_since(SystemTime::UNIX_EPOCH).ok()?;
    let truncated = SystemTime::UNIX_EPOCH + Duration::from_millis(since_epoch.as_millis() as u64);
    let reset = chrono::DateTime::<chrono::Utc>::from(truncated)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    Some((seconds, reset))
}

/// Legacy `buildErrorBody`.
pub fn build_error_body(
    status: u16,
    message: &str,
    upstream_details: Option<&Value>,
    classification: &Classification<'_>,
) -> Value {
    let (error_type, code) = error_info(status);
    let sanitized = sanitize_error_message(message);
    let message = if sanitized.is_empty() {
        default_error_message(status).to_owned()
    } else {
        sanitized
    };
    let mut error = Map::new();
    error.insert("message".to_owned(), Value::String(message));
    error.insert(
        "type".to_owned(),
        Value::String(project_public_error_identifier(
            classification.error_type,
            error_type,
        )),
    );
    error.insert(
        "code".to_owned(),
        Value::String(project_public_error_identifier(classification.code, code)),
    );
    if let Some(reason) = classification
        .reason
        .filter(|reason| safe_public_error_identifier(reason))
    {
        error.insert("reason".to_owned(), Value::String(reason.to_owned()));
    }
    if let Some((seconds, reset)) = classification
        .retry_at
        .and_then(|retry_at| retry_fields(retry_at, SystemTime::now()))
    {
        error.insert("retry_after".to_owned(), json!(seconds));
        error.insert("reset_at".to_owned(), Value::String(reset));
    }
    let mut body = Map::new();
    body.insert("error".to_owned(), Value::Object(error));
    if let Some(details) = upstream_details.filter(|details| !details.is_null()) {
        let sanitized = sanitize_upstream_details(details);
        if sanitized.is_object() {
            body.insert("upstream_details".to_owned(), sanitized);
        }
    }
    Value::Object(body)
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `a || b` over optional JSON values.
fn or<'a>(first: Option<&'a Value>, second: Option<&'a Value>) -> Option<&'a Value> {
    match first {
        Some(value) if truthy(value) => Some(value),
        _ => second,
    }
}

/// The fields legacy `parseUpstreamError` reads from a failed provider body.
#[derive(Debug, Clone, PartialEq)]
pub struct UpstreamError {
    pub message: String,
    /// `errorCode` when it is a string (chatCore keeps only strings).
    pub code: Option<String>,
    /// `errorType` when it is a string.
    pub error_type: Option<String>,
    /// `normalizePayloadForLog(text)`: the parsed JSON, `""`, or `{_rawText}`.
    pub body: Value,
}

/// Legacy `parseUpstreamError` (message, code, type and body; retry hints are
/// read by the resilience classifier).
pub fn parse_upstream_error(status: u16, text: &str, provider: &str) -> UpstreamError {
    let trimmed = text.trim_matches(|c: char| u16::try_from(u32::from(c)).is_ok_and(js_space));
    let body = if trimmed.is_empty() {
        Value::String(String::new())
    } else {
        serde_json::from_str(trimmed).unwrap_or_else(|_| json!({"_rawText": text}))
    };
    let fallback = || format!("Upstream error: {status}");
    // JSON.parse(text), like serde_json, accepts only JSON whitespace around.
    let Ok(parsed) = serde_json::from_str::<Value>(text) else {
        return UpstreamError {
            message: text.to_owned(),
            code: None,
            error_type: None,
            body,
        };
    };
    let first = match &parsed {
        Value::Array(items) if !items.is_empty() => &items[0],
        other => other,
    };
    let empty = Value::Object(Map::new());
    let json = if truthy(first) { first } else { &empty };
    let field = |value: &'_ Value, key: &str| {
        value
            .as_object()
            .and_then(|object| object.get(key))
            .cloned()
    };
    let error = field(json, "error");
    let error_field = |key: &str| error.as_ref().and_then(|error| field(error, key));
    let clinepass_error =
        (provider == "clinepass" && json.get("success") == Some(&Value::Bool(false))).then(|| {
            let message = match &error {
                Some(Value::String(text)) => Some(Value::String(text.clone())),
                _ => or(
                    error_field("message").as_ref(),
                    json.get("message").filter(|m| m.is_string()),
                )
                .cloned(),
            };
            match message {
                Some(message) if truthy(&message) => message,
                _ => Value::String("Upstream error".to_owned()),
            }
        });
    let message_field = error_field("message");
    let extracted = clinepass_error.or_else(|| {
        or(message_field.as_ref(), json.get("message"))
            .cloned()
            .filter(truthy)
            .or_else(|| error.clone().filter(Value::is_string))
    });
    let message = match extracted {
        Some(Value::String(text)) => text,
        _ => fallback(),
    };
    let string = |value: Option<&Value>| value.and_then(Value::as_str).map(str::to_owned);
    let code_field = error_field("code");
    let type_field = error_field("type");
    UpstreamError {
        message,
        code: string(or(code_field.as_ref(), json.get("code"))),
        error_type: string(or(type_field.as_ref(), json.get("type"))),
        body,
    }
}

fn js_space(code: u16) -> bool {
    matches!(
        code,
        0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

/// Legacy `formatProviderError` for an HTTP failure.
pub fn format_provider_error(status: u16, message: &str) -> String {
    let message = if message.is_empty() {
        "Unknown error"
    } else {
        message
    };
    format!("[{status}]: {message}")
}

static INTERNAL_LEAK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i){JS_S}(?-u:at){JS_S}/|(?-u:node_modules|omniroute/)"
    ))
    .expect("static pattern")
});
static CREDENTIAL_LEAK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?i)(?-u:\b(?:Bearer|Basic)){JS_S}+(?-u:[A-Za-z0-9._~+/=-]{{8,}})|(?-u:\bsk-[A-Za-z0-9._-]{{8,}})|(?-u:(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|secret)\\?["']?){JS_S}*[:=]{JS_S}*(?-u:\\?["']?)[^"'\\,\t\n\x0B\x0C\r \x{{A0}}\x{{1680}}\x{{2000}}-\x{{200A}}\x{{2028}}\x{{2029}}\x{{202F}}\x{{205F}}\x{{3000}}\x{{FEFF}}}}]{{6,}}"#
    ))
    .expect("static pattern")
});

/// Legacy `shouldPassthroughUpstreamError`: a 4xx other than 401/403/407 whose
/// JSON body leaks no internal path and echoes no credential.
pub fn should_passthrough_upstream_error(status: u16, body: &Value) -> bool {
    if !(400..=499).contains(&status) || matches!(status, 401 | 403 | 407) {
        return false;
    }
    if !(body.is_object() || body.is_array()) {
        return false;
    }
    let Ok(text) = serde_json::to_string(body) else {
        return false;
    };
    !INTERNAL_LEAK.is_match(&text)
        && !CREDENTIAL_LEAK.is_match(&text)
        && !contains_sensitive_error_credential(&text)
}

/// The public failure response: status, extra headers and JSON bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct PublicFailure {
    pub status: u16,
    pub retry_after_seconds: Option<u64>,
    pub body: Value,
}

/// Legacy `createErrorResult(status, formatProviderError(...), retryAfterMs,
/// code, type, upstreamErrorBody, {passthrough})` for an upstream failure:
/// the canonical envelope, or with `passthrough` (a Claude-format client) and
/// an eligible body its sanitized shape plus `Retry-After`.
pub fn upstream_failure(
    status: u16,
    upstream: &UpstreamError,
    retry_after_ms: Option<u64>,
    passthrough: bool,
) -> PublicFailure {
    if passthrough && should_passthrough_upstream_error(status, &upstream.body) {
        let sanitized = sanitize_passthrough_upstream_details(&upstream.body);
        let body = if truthy(&sanitized) && (sanitized.is_object() || sanitized.is_array()) {
            sanitized
        } else {
            json!({"error": {"message": "Upstream error"}})
        };
        return PublicFailure {
            status,
            retry_after_seconds: retry_after_ms
                .filter(|ms| *ms > 0)
                .map(|ms| ms.div_ceil(1000)),
            body,
        };
    }
    let message = format_provider_error(status, &upstream.message);
    let classification = Classification {
        error_type: upstream.error_type.as_deref(),
        code: upstream.code.as_deref(),
        ..Classification::default()
    };
    PublicFailure {
        status,
        retry_after_seconds: None,
        body: build_error_body(status, &message, Some(&upstream.body), &classification),
    }
}

/// Legacy `buildSanitizedUpstreamErrorResponse`: a JSON provider body keeps
/// its sanitized shape; anything else becomes the canonical envelope with
/// `fallback_message`, never echoing opaque text.
pub fn sanitized_upstream_error_body(status: u16, raw: &str, fallback_message: &str) -> Value {
    let trimmed = raw.trim_matches(|c: char| u16::try_from(u32::from(c)).is_ok_and(js_space));
    if !trimmed.is_empty() {
        if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
            return sanitize_upstream_details(&parsed);
        }
    }
    build_error_body(status, fallback_message, None, &Classification::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Outputs the legacy TypeScript produced for the same inputs
    /// (`public_error_oracle.json`, generated with Node).
    #[test]
    fn outputs_match_the_legacy_implementation() {
        let oracle: Value = serde_json::from_str(include_str!("public_error_oracle.json")).unwrap();
        for case in oracle["bodies"].as_array().unwrap() {
            let classification = Classification {
                error_type: case["type"].as_str(),
                code: case["code"].as_str(),
                reason: case["reason"].as_str(),
                retry_at: None,
            };
            let details = case.get("details");
            assert_eq!(
                build_error_body(
                    case["status"].as_u64().unwrap() as u16,
                    case["message"].as_str().unwrap(),
                    details,
                    &classification
                ),
                case["out"],
                "{case}"
            );
        }
        for case in oracle["parsed"].as_array().unwrap() {
            let parsed = parse_upstream_error(
                case["status"].as_u64().unwrap() as u16,
                case["text"].as_str().unwrap(),
                case["provider"].as_str().unwrap(),
            );
            assert_eq!(parsed.message, case["message"].as_str().unwrap(), "{case}");
            assert_eq!(parsed.code.as_deref(), case["code"].as_str(), "{case}");
            assert_eq!(
                parsed.error_type.as_deref(),
                case["errorType"].as_str(),
                "{case}"
            );
            assert_eq!(parsed.body, case["body"], "{case}");
        }
        for case in oracle["passthrough"].as_array().unwrap() {
            assert_eq!(
                should_passthrough_upstream_error(
                    case["status"].as_u64().unwrap() as u16,
                    &case["body"]
                ),
                case["out"].as_bool().unwrap(),
                "{case}"
            );
        }
        for case in oracle["failures"].as_array().unwrap() {
            let status = case["status"].as_u64().unwrap() as u16;
            let upstream = parse_upstream_error(status, case["text"].as_str().unwrap(), "openai");
            let failure = upstream_failure(
                status,
                &upstream,
                case["retryAfterMs"].as_u64(),
                case["passthrough"].as_bool().unwrap(),
            );
            assert_eq!(failure.body, case["out"], "{case}");
            assert_eq!(
                failure.retry_after_seconds,
                case["retryAfter"].as_u64(),
                "{case}"
            );
        }
        for case in oracle["sanitized"].as_array().unwrap() {
            assert_eq!(
                sanitized_upstream_error_body(
                    case["status"].as_u64().unwrap() as u16,
                    case["raw"].as_str().unwrap(),
                    "Upstream error"
                ),
                case["out"],
                "{case}"
            );
        }
    }

    #[test]
    fn retry_fields_round_up_and_skip_the_past() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_millis(1_700_000_000_000);
        assert_eq!(
            retry_fields(now + Duration::from_millis(1_500), now),
            Some((2, "2023-11-14T22:13:21.500Z".to_owned()))
        );
        assert_eq!(retry_fields(now, now), None);
        assert_eq!(retry_fields(now - Duration::from_secs(1), now), None);
    }
}
