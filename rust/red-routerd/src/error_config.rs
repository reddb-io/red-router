//! The configured error rule table of account fallback, ported from the
//! legacy `open-sse/config/errorConfig.ts`: text rules, then status rules,
//! each with a reason and a cooldown, plus the backoff curve, the NVIDIA NIM
//! degraded-function check and the service supervisor cooldown. The status to
//! error type table and default messages already live in `public_error`.

use axum::http::HeaderMap;
use regex::Regex;
use std::sync::LazyLock;

/// Legacy `BACKOFF_CONFIG`.
pub const BACKOFF_BASE_MS: u64 = 1_000;
pub const BACKOFF_MAX_MS: u64 = 2 * 60 * 1_000;
pub const BACKOFF_MAX_LEVEL: u32 = 15;

/// Legacy `TRANSIENT_COOLDOWN_MS`.
pub const TRANSIENT_COOLDOWN_MS: u64 = 5 * 1_000;

/// Legacy `COOLDOWN_MS`.
pub mod cooldown_ms {
    pub const UNAUTHORIZED: u64 = 2 * 60 * 1_000;
    pub const PAYMENT_REQUIRED: u64 = 2 * 60 * 1_000;
    pub const NOT_FOUND: u64 = 2 * 60 * 1_000;
    pub const NOT_FOUND_LOCAL: u64 = 5 * 1_000;
    pub const TRANSIENT_INITIAL: u64 = super::TRANSIENT_COOLDOWN_MS;
    pub const TRANSIENT_MAX: u64 = 60 * 1_000;
    pub const TRANSIENT: u64 = super::TRANSIENT_COOLDOWN_MS;
    pub const REQUEST_NOT_ALLOWED: u64 = 5 * 1_000;
    pub const REQUEST_REJECTED: u64 = 5 * 60 * 1_000;
    pub const REQUEST_REJECTED_REPEAT: u64 = 15 * 60 * 1_000;
    pub const RATE_LIMIT: u64 = 2 * 60 * 1_000;
    pub const SERVICE_UNAVAILABLE: u64 = 2 * 1_000;
    pub const AUTH_EXPIRED: u64 = 2 * 60 * 1_000;
    pub const GEO_BLOCKED: u64 = 24 * 60 * 60 * 1_000;
    pub const GCP_PROJECT_REQUIRED: u64 = 24 * 60 * 60 * 1_000;
}

/// Legacy `ConfiguredErrorReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorReason {
    AuthError,
    QuotaExhausted,
    RateLimitExceeded,
    ModelCapacity,
    ServerError,
    Unknown,
}

impl ErrorReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AuthError => "auth_error",
            Self::QuotaExhausted => "quota_exhausted",
            Self::RateLimitExceeded => "rate_limit_exceeded",
            Self::ModelCapacity => "model_capacity",
            Self::ServerError => "server_error",
            Self::Unknown => "unknown",
        }
    }
}

/// One rule of the table (legacy `ErrorRule`): a lowercase text to find in the
/// message or a status, the reason, and either a fixed cooldown or a backoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ErrorRule {
    pub id: &'static str,
    pub text: Option<&'static str>,
    pub status: Option<u16>,
    pub reason: ErrorReason,
    pub cooldown_ms: Option<u64>,
    pub backoff: bool,
}

const fn text_rule(
    id: &'static str,
    text: &'static str,
    reason: ErrorReason,
    cooldown_ms: Option<u64>,
    backoff: bool,
) -> ErrorRule {
    ErrorRule {
        id,
        text: Some(text),
        status: None,
        reason,
        cooldown_ms,
        backoff,
    }
}

const fn status_rule(
    id: &'static str,
    status: u16,
    reason: ErrorReason,
    cooldown_ms: Option<u64>,
    backoff: bool,
) -> ErrorRule {
    ErrorRule {
        id,
        text: None,
        status: Some(status),
        reason,
        cooldown_ms,
        backoff,
    }
}

use ErrorReason::{
    AuthError, ModelCapacity, QuotaExhausted, RateLimitExceeded, ServerError, Unknown,
};

/// Legacy `ERROR_RULES`, checked top to bottom: text rules first, then status.
pub const ERROR_RULES: [ErrorRule; 28] = [
    text_rule(
        "no_credentials",
        "no credentials",
        AuthError,
        Some(cooldown_ms::NOT_FOUND),
        false,
    ),
    text_rule(
        "request_not_allowed",
        "request not allowed",
        RateLimitExceeded,
        Some(cooldown_ms::REQUEST_NOT_ALLOWED),
        false,
    ),
    text_rule(
        "improperly_formed_request",
        "improperly formed request",
        ModelCapacity,
        Some(0),
        false,
    ),
    text_rule("rate_limit", "rate limit", RateLimitExceeded, None, true),
    text_rule(
        "too_many_requests",
        "too many requests",
        RateLimitExceeded,
        None,
        true,
    ),
    text_rule(
        "hour_quota_exceeded",
        "hour quota",
        QuotaExhausted,
        None,
        true,
    ),
    text_rule(
        "quota_has_been_exceeded",
        "quota has been exceeded",
        QuotaExhausted,
        None,
        true,
    ),
    text_rule(
        "quota_exceeded",
        "quota exceeded",
        QuotaExhausted,
        None,
        true,
    ),
    text_rule(
        "quota_will_reset",
        "quota will reset",
        QuotaExhausted,
        None,
        true,
    ),
    text_rule(
        "capacity_exhausted",
        "exhausted your capacity",
        QuotaExhausted,
        None,
        true,
    ),
    text_rule(
        "quota_exhausted",
        "quota exhausted",
        QuotaExhausted,
        None,
        true,
    ),
    text_rule(
        "free_tier_exhausted",
        "free tier of the model has been exhausted",
        QuotaExhausted,
        None,
        true,
    ),
    text_rule(
        "out_of_extra_usage",
        "out of extra usage",
        QuotaExhausted,
        None,
        true,
    ),
    text_rule(
        "extra_usage_required",
        "extra usage required",
        QuotaExhausted,
        None,
        true,
    ),
    text_rule("capacity", "capacity", ModelCapacity, None, true),
    text_rule("overloaded", "overloaded", ModelCapacity, None, true),
    text_rule("high_demand", "high demand", ModelCapacity, None, true),
    status_rule("status_401", 401, AuthError, Some(0), false),
    status_rule("status_402", 402, QuotaExhausted, Some(0), false),
    status_rule("status_403", 403, Unknown, Some(0), false),
    status_rule(
        "status_404",
        404,
        Unknown,
        Some(cooldown_ms::NOT_FOUND),
        false,
    ),
    status_rule("status_406", 406, ServerError, None, true),
    status_rule("status_408", 408, ServerError, None, true),
    status_rule("status_429", 429, RateLimitExceeded, None, true),
    status_rule("status_500", 500, ServerError, None, true),
    status_rule("status_502", 502, ServerError, None, true),
    status_rule("status_503", 503, ServerError, None, true),
    status_rule("status_504", 504, ServerError, None, true),
];

fn rules() -> &'static [ErrorRule] {
    &ERROR_RULES
}

/// Legacy `calculateBackoffCooldown`: `1 s * 2^level`, capped at two minutes.
pub fn calculate_backoff_cooldown(level: f64) -> u64 {
    let safe_level = level.floor().max(0.0);
    let cooldown = BACKOFF_BASE_MS as f64 * 2f64.powf(safe_level);
    if cooldown >= BACKOFF_MAX_MS as f64 {
        BACKOFF_MAX_MS
    } else {
        cooldown as u64
    }
}

/// Legacy `matchErrorRuleByText`: the first text rule whose text the lowercased
/// message contains; `None` for an empty message.
pub fn match_error_rule_by_text(message: &str) -> Option<&'static ErrorRule> {
    let lower = message.to_lowercase();
    if lower.is_empty() {
        return None;
    }
    rules()
        .iter()
        .find(|rule| rule.text.is_some_and(|text| lower.contains(text)))
}

/// Legacy `matchErrorRuleByStatus`.
pub fn match_error_rule_by_status(status: u16) -> Option<&'static ErrorRule> {
    rules().iter().find(|rule| rule.status == Some(status))
}

/// Legacy `findMatchingErrorRule`: a text rule beats a status rule.
pub fn find_matching_error_rule(status: u16, message: &str) -> Option<&'static ErrorRule> {
    match_error_rule_by_text(message).or_else(|| match_error_rule_by_status(status))
}

static NIM_FUNCTION_DEGRADED: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)(?-u:\b)function(?-u:\b)[\s\S]{0,80}?(?-u:\b)DEGRADED(?-u:\b)",
        r"(?i)(?-u:\b)DEGRADED(?-u:\b)[\s\S]{0,80}?(?-u:\b)function(?-u:\b)",
    ]
    .iter()
    .map(|pattern| Regex::new(pattern).expect("static pattern"))
    .collect()
});

/// Legacy `isNimFunctionDegraded` (#8248): a NVIDIA NIM deployment whose
/// backing function is DEGRADED, reported on a non-standard 400.
pub fn is_nim_function_degraded(error_text: &str) -> bool {
    NIM_FUNCTION_DEGRADED
        .iter()
        .any(|pattern| pattern.is_match(error_text))
}

/// The decision for a failure of the embedded service supervisor (legacy
/// `ServiceSupervisorCooldown`): a short connection cooldown that does not
/// count against the provider breaker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceSupervisorCooldown {
    pub cooldown_ms: u64,
    pub reason: &'static str,
}

/// Legacy `serviceSupervisorCooldown` (G-02): a 503 carrying
/// `X-Omni-Fallback-Hint: connection_cooldown` is the local supervisor
/// changing state, not the upstream failing.
pub fn service_supervisor_cooldown(
    status: u16,
    headers: Option<&HeaderMap>,
) -> Option<ServiceSupervisorCooldown> {
    if status != 503 {
        return None;
    }
    let hint = headers?.get("x-omni-fallback-hint")?.to_str().ok()?;
    (hint.to_lowercase() == "connection_cooldown").then_some(ServiceSupervisorCooldown {
        cooldown_ms: 5_000,
        reason: "service_not_running",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderName, HeaderValue};
    use serde_json::{json, Value};

    fn rule_json(rule: Option<&ErrorRule>) -> Value {
        rule.map_or(Value::Null, |rule| {
            let mut out = json!({"id": rule.id, "reason": rule.reason.as_str()});
            if let Some(text) = rule.text {
                out["text"] = json!(text);
            }
            if let Some(status) = rule.status {
                out["status"] = json!(status);
            }
            if let Some(cooldown) = rule.cooldown_ms {
                out["cooldownMs"] = json!(cooldown);
            }
            if rule.backoff {
                out["backoff"] = json!(true);
            }
            out
        })
    }

    /// Outputs the legacy functions produced for the same inputs
    /// (`error_config_oracle.json`, generated with Node).
    #[test]
    fn error_config_matches_the_legacy_module() {
        let oracle: Value = serde_json::from_str(include_str!("error_config_oracle.json")).unwrap();
        assert_eq!(rules().len(), oracle["rules"].as_array().unwrap().len());
        for (actual, expected) in rules().iter().zip(oracle["rules"].as_array().unwrap()) {
            assert_eq!(rule_json(Some(actual)), *expected);
        }
        for case in oracle["text"].as_array().unwrap() {
            assert_eq!(
                rule_json(match_error_rule_by_text(case[0].as_str().unwrap())),
                case[1],
                "{case}"
            );
        }
        for case in oracle["status"].as_array().unwrap() {
            assert_eq!(
                rule_json(match_error_rule_by_status(case[0].as_u64().unwrap() as u16)),
                case[1],
                "{case}"
            );
        }
        for case in oracle["find"].as_array().unwrap() {
            let found = find_matching_error_rule(
                case[0].as_u64().unwrap() as u16,
                case[1].as_str().unwrap(),
            );
            assert_eq!(rule_json(found), case[2], "{case}");
        }
        for case in oracle["backoff"].as_array().unwrap() {
            assert_eq!(
                calculate_backoff_cooldown(case[0].as_f64().unwrap()),
                case[1].as_u64().unwrap(),
                "{case}"
            );
        }
        for case in oracle["nim"].as_array().unwrap() {
            assert_eq!(
                is_nim_function_degraded(case[0].as_str().unwrap()),
                case[1].as_bool().unwrap(),
                "{case}"
            );
        }
        for case in oracle["supervisor"].as_array().unwrap() {
            let mut headers = HeaderMap::new();
            if let Some(value) = case[1].as_str() {
                headers.insert(
                    HeaderName::from_static("x-omni-fallback-hint"),
                    HeaderValue::from_str(value).unwrap(),
                );
            }
            let found = service_supervisor_cooldown(
                case[0].as_u64().unwrap() as u16,
                (!case[2].as_bool().unwrap()).then_some(&headers),
            );
            let actual = found.map_or(
                Value::Null,
                |found| json!({"cooldownMs": found.cooldown_ms, "reason": found.reason}),
            );
            assert_eq!(actual, case[3], "{case}");
        }
    }
}
