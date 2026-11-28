//! Provider-specific resilience policy used by the Rust request path.

use axum::http::{HeaderMap, StatusCode};
use regex::Regex;
use serde::Serialize;
use std::sync::LazyLock;

/// Fixed lockout for failures that repeat until an operator acts: a retired
/// model or a moved endpoint (legacy `checkFallbackError`, 24 hours).
pub(crate) const PERMANENT_FAILURE_LOCKOUT_MS: u64 = 24 * 60 * 60 * 1_000;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RateLimitScope {
    #[default]
    Auto,
    Connection,
    Model,
}

impl RateLimitScope {
    pub(crate) fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "auto" => Ok(Self::Auto),
            "connection" => Ok(Self::Connection),
            "model" => Ok(Self::Model),
            _ => Err("invalid provider rate-limit scope"),
        }
    }

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Connection => "connection",
            Self::Model => "model",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FailureScope {
    Connection,
    Model,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProviderFailureClass {
    Transient,
    Model,
    Banned,
    Expired,
    AmbiguousExpired,
    CreditsExhausted,
    /// The provider retired the model (legacy
    /// `MODEL_PERMANENTLY_UNAVAILABLE_PATTERNS` on a 404 or 410).
    RetiredModel,
    /// The provider moved its API endpoint (legacy
    /// `ENDPOINT_PERMANENTLY_MOVED_PATTERNS`).
    MovedEndpoint,
    /// The request names a resource the provider does not have (legacy
    /// `request_resource_not_found`): no fallback, cooldown or lockout.
    RequestScoped,
    /// The provider refused this request, not the account (legacy OpenCode
    /// free-tier refusal): the next account is tried, nothing is recorded.
    RequestRefusal,
}

impl ProviderFailureClass {
    pub(crate) const fn semantic_fallback(self) -> bool {
        !matches!(self, Self::Transient | Self::RequestScoped)
    }
}

/// A bare 401 is strong credential evidence only on direct API-key surfaces.
/// Multiplexing and generic OpenAI-compatible gateways sometimes use 401 for
/// model entitlement or format errors; those need bounded body classification
/// before the entire connection may be parked.
impl ProviderFailureClass {
    /// The failure class name the request log records.
    pub(crate) fn log_label(self) -> &'static str {
        match self {
            Self::Transient => "upstream_error",
            Self::Model => "model_unavailable",
            Self::RetiredModel => "model_retired",
            Self::MovedEndpoint => "endpoint_moved",
            Self::Banned => "account_banned",
            Self::Expired => "credential_expired",
            Self::AmbiguousExpired => "credential_rejected",
            Self::CreditsExhausted => "credits_exhausted",
            Self::RequestScoped => "request_resource_missing",
            Self::RequestRefusal => "request_refused",
        }
    }
}

pub(crate) fn authentication_failure_is_terminal(provider: Option<&str>) -> bool {
    matches!(
        provider.unwrap_or_default().to_ascii_lowercase().as_str(),
        "openai"
            | "anthropic"
            | "cohere"
            | "groq"
            | "deepseek"
            | "together"
            | "perplexity"
            | "fireworks"
            | "cerebras"
            | "sambanova"
            | "xai"
            | "nvidia"
            | "ai21"
            | "moonshot"
            | "kimi"
            | "siliconflow"
            | "novita"
    )
}

/// The automatic 429/402 scope follows the legacy `hasPerModelQuota`:
/// providers that multiplex independently limited models behind one
/// credential (see `model_scope_providers`) lock the model, others the
/// connection. Operators can override either way per account.
/// Legacy `hasPerModelFailureScope` for a non-quota failure such as a 404:
/// the multiplexing providers of `hasPerModelQuota` plus Claude, with the
/// account's configured scope taking precedence. Codex stays out, as the
/// legacy `markAccountUnavailable` excludes it from the model-only branch.
pub(crate) fn per_model_failure_scope(configured: RateLimitScope, provider: Option<&str>) -> bool {
    let provider = provider.unwrap_or_default().trim().to_ascii_lowercase();
    if provider == "codex" {
        return false;
    }
    match configured {
        RateLimitScope::Connection => false,
        RateLimitScope::Model => true,
        RateLimitScope::Auto => {
            provider == "claude" || crate::model_scope_providers::has_per_model_quota(&provider)
        }
    }
}

pub(crate) fn quota_failure_scope(
    configured: RateLimitScope,
    provider: Option<&str>,
    status: StatusCode,
    headers: &HeaderMap,
) -> FailureScope {
    if !matches!(
        status,
        StatusCode::PAYMENT_REQUIRED | StatusCode::TOO_MANY_REQUESTS
    ) {
        return FailureScope::Connection;
    }
    match configured {
        RateLimitScope::Connection => FailureScope::Connection,
        RateLimitScope::Model => FailureScope::Model,
        RateLimitScope::Auto => automatic_scope(provider, headers),
    }
}

/// `classify_provider_failure_with` for a connection whose quota signals are
/// preserved on a 429 (an OAuth account, or an unknown provider as in the
/// legacy `shouldPreserveQuotaSignals`). The unit tests use it; the proxy
/// passes the connection's own flag.
#[cfg(test)]
pub(crate) fn classify_provider_failure(
    configured: RateLimitScope,
    provider: Option<&str>,
    status: StatusCode,
    headers: &HeaderMap,
    body: Option<&[u8]>,
) -> ProviderFailureClass {
    classify_provider_failure_with(configured, provider, status, headers, body, true)
}

/// Legacy `checkFallbackError` classification of a failed upstream response.
/// `preserve_quota_signals` is the connection's OAuth flag: on a 429 the
/// credit and quota text only counts for such an account or when the body
/// itself names a long-period cap (legacy `shouldUseQuotaSignal`).
pub(crate) fn classify_provider_failure_with(
    configured: RateLimitScope,
    provider: Option<&str>,
    status: StatusCode,
    headers: &HeaderMap,
    body: Option<&[u8]>,
    preserve_quota_signals: bool,
) -> ProviderFailureClass {
    // Legacy checkFallbackError classifies a missing conversation or file
    // reference before every generic 404 rule.
    let raw = body.map(String::from_utf8_lossy).unwrap_or_default();
    if status == StatusCode::NOT_FOUND
        && crate::request_resource_errors::is_resource_not_found_response(&raw)
    {
        return ProviderFailureClass::RequestScoped;
    }
    // Legacy auth guard: the OpenCode free tier refusing a request outside
    // its client belongs on neither the account nor the model.
    if crate::opencode_geo_block::is_opencode_free_tier_refusal_for_provider(
        provider,
        status.as_u16(),
        &raw,
    ) {
        return ProviderFailureClass::RequestRefusal;
    }
    // Legacy resolveApiKeyForbiddenFallback (#8775): a Cloudflare signature ban
    // on an API-key provider moves on without a cooldown a retry would wait out.
    if status == StatusCode::FORBIDDEN
        && provider.is_some_and(api_key_provider)
        && !forbidden_quota_text(&raw)
        && crate::non_retryable_upstream::is_non_retryable_cloudflare_error(&raw)
    {
        return ProviderFailureClass::RequestRefusal;
    }
    let normalized = normalized_error_evidence(body);
    let text = normalized.as_str();

    if matches!(status.as_u16(), 404 | 410) && matches_any(&RETIRED_MODEL_PATTERNS, text) {
        return ProviderFailureClass::RetiredModel;
    }
    // A model-specific denial is safer to scope narrowly even when an
    // aggregator uses an authentication-looking HTTP status.
    if matches!(status.as_u16(), 400 | 401 | 403 | 404) && model_failure_text(text) {
        return ProviderFailureClass::Model;
    }
    // Legacy isAccountDeactivated runs before any status rule: a deactivation
    // signal in the body of any failure parks the account, whatever the status
    // (a 400, a 429 or a 5xx from a gateway included).
    if (status.is_client_error() || status.is_server_error()) && banned_text(text) {
        return ProviderFailureClass::Banned;
    }
    if matches!(status.as_u16(), 401 | 403) && credential_failure_text(text) {
        return ProviderFailureClass::Expired;
    }
    let failed = status.is_client_error() || status.is_server_error();
    if failed && matches_any(&MOVED_ENDPOINT_PATTERNS, text) {
        return ProviderFailureClass::MovedEndpoint;
    }
    // A billing suspension (unpaid invoice, spending limit) arrives on
    // statuses nothing else classifies, such as Fireworks' 412.
    if failed && matches_any(&BILLING_SUSPENSION_PATTERNS, text) {
        return ProviderFailureClass::CreditsExhausted;
    }
    // A shared-wallet 402 empties the whole account, whatever scope the
    // operator configured for model-level quota failures.
    // Only an empty raw body counts as "no detail"; a body whose JSON carries
    // no error text still has to show the balance signal.
    let raw_empty = body.is_none_or(|body| body.trim_ascii().is_empty());
    if crate::shared_wallet_credits::is_shared_wallet_credits_402(
        provider,
        status.as_u16(),
        (!raw_empty).then_some(text),
    ) {
        return ProviderFailureClass::CreditsExhausted;
    }
    // Legacy isCreditsExhausted is a text rule like the deactivation one: it
    // applies to any failing status. Only a 429 is gated, to avoid reading a
    // short rate limit as an empty wallet.
    let quota_signal = status != StatusCode::TOO_MANY_REQUESTS
        || preserve_quota_signals
        || looks_like_quota_exhausted(body);
    if failed && quota_signal && credits_exhausted_text(text) {
        return if quota_failure_scope(configured, provider, StatusCode::PAYMENT_REQUIRED, headers)
            == FailureScope::Model
        {
            ProviderFailureClass::Model
        } else {
            ProviderFailureClass::CreditsExhausted
        };
    }

    // The Mistral 401 rule sits after the text rules in the legacy order, so a
    // credit or quota body on a 401 is still read as exhausted credits.
    // Every other Mistral 401 parks the connection as expired, unless the
    // legacy soft lockout is on for an ambiguous one (mistral_ambiguous_auth).
    if status == StatusCode::UNAUTHORIZED
        && provider.is_some_and(|provider| provider.eq_ignore_ascii_case("mistral"))
    {
        return mistral_401_class(text, crate::mistral_ambiguous_auth::soft_lockout_enabled());
    }

    match status {
        StatusCode::UNAUTHORIZED if authentication_failure_is_terminal(provider) => {
            ProviderFailureClass::Expired
        }
        StatusCode::PAYMENT_REQUIRED => {
            if quota_failure_scope(configured, provider, status, headers) == FailureScope::Model {
                ProviderFailureClass::Model
            } else {
                ProviderFailureClass::CreditsExhausted
            }
        }
        StatusCode::NOT_FOUND => ProviderFailureClass::Model,
        StatusCode::TOO_MANY_REQUESTS
            if quota_failure_scope(configured, provider, status, headers)
                == FailureScope::Model =>
        {
            ProviderFailureClass::Model
        }
        _ => ProviderFailureClass::Transient,
    }
}

fn compile(patterns: &[&str]) -> Vec<Regex> {
    patterns
        .iter()
        .map(|pattern| Regex::new(pattern).expect("static pattern"))
        .collect()
}

fn matches_any(patterns: &[Regex], text: &str) -> bool {
    patterns.iter().any(|pattern| pattern.is_match(text))
}

/// Legacy `QUOTA_PATTERNS` (`src/shared/utils/classify429.ts`): text an
/// upstream uses when a long-period cap, not a short rate limit, was hit.
static QUOTA_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    compile(&[
        r"(?i)daily.*limit",
        r"(?i)daily.*quota",
        r"(?i)per.?day.*limit",
        r"(?i)monthly.*limit",
        r"(?i)monthly.*quota",
        r"(?i)per.?month.*limit",
        r"(?i)(?:api\s+)?calls?\s*/\s*month",
        r"(?i)requests?\s*/\s*month",
        r"(?i)limited\s+to\s+[\d,]+.*(?:calls?|requests?).*per\s+month",
        r"(?i)quota.*exceed",
        r"(?i)exceed.*quota",
        r"(?i)insufficient.*quota",
        r"(?i)billing.*cap",
        r"(?i)credit.*exhaust",
        r"(?i)exhausted.*credits",
        r"(?i)out of credits",
        r"(?i)hard.?limit",
        r"(?i)plan.*limit",
        r"(?i)individual quota reached",
        r"(?i)enable overages",
        r"(?i)INSUFFICIENT_G1_CREDITS_BALANCE",
        r"(?i)resource has been exhausted.*reset after",
        r"(?i)daily free allocation",
        r"(?i)have exhausted their quota",
        r#"(?i)"error"\s*:\s*"usage limit reached[.\s]*""#,
    ])
});

/// Legacy `looksLikeQuotaExhausted` over the raw body text.
pub(crate) fn looks_like_quota_exhausted(body: Option<&[u8]>) -> bool {
    body.is_some_and(|body| matches_any(&QUOTA_PATTERNS, &String::from_utf8_lossy(body)))
}

/// The legacy `checkFallbackError` daily-quota rule: `Some(true)` for a TPD
/// ("tokens per day") limit, `Some(false)` for other daily-quota text, when
/// quota signals apply. They apply to every failure but a 429, and to a 429
/// only for OAuth accounts or an explicit long-period quota body (legacy
/// `shouldPreserveQuotaSignals`).
pub(crate) fn daily_quota_failure(
    status: StatusCode,
    body: Option<&[u8]>,
    oauth: bool,
) -> Option<bool> {
    if !(status.is_client_error() || status.is_server_error()) {
        return None;
    }
    let normalized = normalized_error_evidence(body);
    let text = normalized.as_str();
    if !crate::daily_quota_reset::is_daily_quota_exhausted(text) {
        return None;
    }
    if status == StatusCode::TOO_MANY_REQUESTS && !oauth && !looks_like_quota_exhausted(body) {
        return None;
    }
    Some(crate::daily_quota_reset::is_tpd_rate_limit(text))
}

static RETIRED_MODEL_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    compile(&[
        r"(?i)\bno longer available\b",
        r"(?i)\bno longer supported\b",
        r"(?i)\bhas reached (?:its |the )?end.?of.?life\b",
        r"(?i)\bmodel[\s\S]{0,40}?\b(?:deprecated|retired|discontinued|decommissioned)\b",
        r"(?i)\b(?:deprecated|retired|discontinued|decommissioned)[\s\S]{0,40}?\bmodel\b",
    ])
});

static MOVED_ENDPOINT_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    compile(&[
        r"(?i)\bendpoint has moved\b",
        r"(?i)\bno longer works\b",
        r"(?i)\bupdate your base.?url\b",
    ])
});

static BILLING_SUSPENSION_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    compile(&[
        r"(?i)\bsuspended\b[\s\S]{0,120}?\b(?:spending limit|billing|invoice|payment)\b",
        r"(?i)\b(?:spending limit|billing|invoice|payment)\b[\s\S]{0,120}?\bsuspended\b",
    ])
});

fn normalized_error_evidence(body: Option<&[u8]>) -> String {
    let Some(body) = body else {
        return String::new();
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return String::from_utf8_lossy(body).to_ascii_lowercase();
    };
    let mut evidence = String::new();
    collect_json_error_evidence(&value, 0, &mut evidence);
    evidence.make_ascii_lowercase();
    evidence
}

/// The quota text branch of the legacy `checkFallbackError`: a fixed cooldown
/// for a recognized quota phrase, whatever the status. A subscription or plan
/// limit takes the upstream hint (when the profile honors hints) or an hour,
/// and only when quota signals apply and the text is neither a credit nor a
/// daily quota; a weekly cap takes the quoted reset or a day; a session cap
/// five hours; a rolling free-usage cap a day. The caller runs it after the
/// ban, credit, retired-model, moved-endpoint and daily-quota decisions,
/// which the legacy function checks first.
pub(crate) fn quota_text_lockout_ms(
    status: StatusCode,
    provider: Option<&str>,
    body: Option<&[u8]>,
    oauth: bool,
    upstream_hint_ms: Option<u64>,
    now_ms: i64,
) -> Option<u64> {
    if !(status.is_client_error() || status.is_server_error()) {
        return None;
    }
    let raw = String::from_utf8_lossy(body?);
    let normalized = normalized_error_evidence(body);
    let quota_signal =
        status != StatusCode::TOO_MANY_REQUESTS || oauth || looks_like_quota_exhausted(body);
    if quota_signal
        && !credits_exhausted_text(&normalized)
        && !crate::daily_quota_reset::is_daily_quota_exhausted(&normalized)
    {
        if let Some(fallback) = crate::quota_text_cooldowns::build_subscription_quota_fallback(
            &raw,
            upstream_hint_ms,
            None,
            provider,
        ) {
            return Some(fallback.cooldown_ms);
        }
    }
    crate::quota_text_cooldowns::build_weekly_quota_fallback(&raw, now_ms, provider)
        .or_else(|| crate::quota_text_cooldowns::build_session_quota_fallback(&raw))
        .or_else(|| crate::quota_text_cooldowns::build_rolling_24h_quota_fallback(&raw))
        .map(|fallback| fallback.cooldown_ms)
}

pub(crate) fn antigravity_credits_retry_eligible(body: Option<&[u8]>) -> bool {
    let text = normalized_error_evidence(body);
    if text.contains("reset after 0s") || text.contains("reset in 0s") {
        return false;
    }
    contains_any(
        &text,
        &[
            "quota_exhausted",
            "quota exhausted",
            "quota reached",
            "enable overages",
            "individual quota",
            "free tier",
            "daily limit",
            "exhausted your capacity",
        ],
    )
}

fn collect_json_error_evidence(value: &serde_json::Value, depth: usize, output: &mut String) {
    if depth > 4 {
        return;
    }
    match value {
        serde_json::Value::String(value) => {
            if !output.is_empty() {
                output.push(' ');
            }
            output.push_str(value);
        }
        serde_json::Value::Array(values) => {
            for value in values.iter().take(16) {
                collect_json_error_evidence(value, depth + 1, output);
            }
        }
        serde_json::Value::Object(values) => {
            for key in [
                "error", "errors", "message", "code", "type", "status", "detail", "reason", "title",
            ] {
                if let Some(value) = values.get(key) {
                    collect_json_error_evidence(value, depth + 1, output);
                }
            }
        }
        _ => {}
    }
}

fn contains_any(text: &str, signals: &[&str]) -> bool {
    !text.is_empty() && signals.iter().any(|signal| text.contains(signal))
}

fn model_failure_text(text: &str) -> bool {
    contains_any(
        text,
        &[
            "model_not_found",
            "model not found",
            "unknown model",
            "model unavailable",
            "model is unavailable",
            "model access denied",
            "no access to this model",
            "not have access to this model",
        ],
    ) || (text.contains("model")
        && contains_any(
            text,
            &[
                "is not supported",
                "not supported for format",
                "does not exist",
                "not entitled",
            ],
        ))
}

/// The operator's custom ban signals (legacy `customBannedSignals`), merged
/// with the built-in list like the legacy `getMergedBannedSignals`.
static CUSTOM_BANNED_SIGNALS: std::sync::RwLock<Vec<String>> = std::sync::RwLock::new(Vec::new());

/// Largest custom signal list and signal length the admin API accepts.
pub(crate) const MAX_CUSTOM_BANNED_SIGNALS: usize = 500;
pub(crate) const MAX_CUSTOM_BANNED_SIGNAL_LEN: usize = 512;

/// Legacy `normalizeStringArray`: trimmed, non-empty, first occurrence kept.
pub(crate) fn normalize_banned_signals(values: Vec<String>) -> Result<Vec<String>, &'static str> {
    let mut signals = Vec::new();
    for value in values {
        let value = value.trim().to_owned();
        if value.is_empty() || signals.contains(&value) {
            continue;
        }
        if value.len() > MAX_CUSTOM_BANNED_SIGNAL_LEN || value.chars().any(char::is_control) {
            return Err("invalid custom banned signal");
        }
        signals.push(value);
    }
    if signals.len() > MAX_CUSTOM_BANNED_SIGNALS {
        return Err("too many custom banned signals");
    }
    Ok(signals)
}

/// Replace the custom signals the classifier uses (legacy
/// `setCustomBannedSignals`).
pub(crate) fn set_custom_banned_signals(signals: Vec<String>) {
    if let Ok(mut current) = CUSTOM_BANNED_SIGNALS.write() {
        *current = signals;
    }
}

pub(crate) fn banned_text(text: &str) -> bool {
    // As in the legacy matcher, the body is lowercased but a custom signal is
    // compared as stored.
    let custom = CUSTOM_BANNED_SIGNALS
        .read()
        .is_ok_and(|signals| signals.iter().any(|signal| text.contains(signal.as_str())));
    custom
        || contains_any(
            text,
            &[
                "account_deactivated",
                "account has been deactivated",
                "account has been disabled",
                "your account has been suspended",
                "this account is deactivated",
                // Antigravity bans; legacy ACCOUNT_DEACTIVATED_SIGNALS lists both.
                "service has been disabled in this account",
            ],
        )
}

pub(crate) fn credits_exhausted_text(text: &str) -> bool {
    contains_any(
        text,
        &[
            "insufficient_quota",
            "billing_hard_limit_reached",
            "exceeded your current quota",
            "exceeded your current usage quota",
            "credit_balance_too_low",
            // Legacy anchors this on "your"; a bare "credit balance is too low"
            // is not a signal.
            "your credit balance is too low",
            "credits exhausted",
            "out of credits",
            "payment required",
            "free tier of the model has been exhausted",
            // Narrower than "has been exhausted", which Gemini also uses for
            // transient rate limits (legacy #8631).
            "tier has been exhausted",
            "insufficient balance",
            "insufficient_balance",
            "insufficient account balance",
            "insufficient credit balance",
            "insufficient credit",
            "exhausted all your credits",
            // Shared-wallet providers (Grok Build) report the weekly pool.
            "usage balance exhausted",
        ],
    )
}

/// Legacy `getProviderCategory(provider) === "apikey"`: every provider but
/// the OAuth accounts Rust adopts (unknown providers are API-key ones).
fn api_key_provider(provider: &str) -> bool {
    !matches!(
        provider.to_ascii_lowercase().as_str(),
        "codex" | "claude" | "agy" | "antigravity" | "github" | "xai-oauth" | "openference"
    )
}

/// The quota texts the legacy API-key 403 branch leaves to the quota rules.
fn forbidden_quota_text(raw: &str) -> bool {
    let lower = raw.to_lowercase();
    lower.contains("has not been used in project")
        || lower.contains("hour quota")
        || lower.contains("quota has been exceeded")
}

fn credential_failure_text(text: &str) -> bool {
    contains_any(
        text,
        &[
            "invalid_api_key",
            "invalid api key",
            "incorrect api key",
            "api key is invalid",
            "invalid authentication credentials",
            "authentication token is expired",
            "token expired",
            "expired token",
            "invalid token",
        ],
    )
}

fn mistral_401_class(text: &str, soft_lockout: bool) -> ProviderFailureClass {
    if soft_lockout
        && crate::mistral_ambiguous_auth::is_mistral_ambiguous_401(Some("mistral"), text)
    {
        ProviderFailureClass::AmbiguousExpired
    } else {
        ProviderFailureClass::Expired
    }
}

fn automatic_scope(provider: Option<&str>, headers: &HeaderMap) -> FailureScope {
    let provider = provider.unwrap_or_default().to_ascii_lowercase();
    if matches!(provider.as_str(), "minimax" | "minimax-passthrough")
        && headers
            .get("x-model-quota-remaining")
            .and_then(|value| value.to_str().ok())
            .is_some_and(any_model_exhausted)
    {
        return FailureScope::Model;
    }
    if crate::model_scope_providers::has_per_model_quota(&provider) {
        FailureScope::Model
    } else {
        FailureScope::Connection
    }
}

fn any_model_exhausted(value: &str) -> bool {
    value.split(',').any(|pair| {
        pair.split_once('=')
            .is_some_and(|(_, remaining)| remaining.trim() == "0")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    /// The ban, credit and resource-not-found decisions of the legacy
    /// `checkFallbackError` for 840 status, body and provider combinations
    /// (`provider_failure_oracle.json`, run through the legacy function with
    /// Node). Rows are [status, body, provider, credits, banned, request-scoped].
    /// A credit failure on a per-model provider is a `Model` class here, which
    /// is the legacy flag plus its `hasPerModelQuota` scope, so credits are
    /// read with the connection scope forced. Bare 402s are not in the matrix:
    /// the legacy rule table gives them no cooldown, which differs by policy.
    #[test]
    fn ban_credit_and_scope_decisions_match_the_legacy_check_fallback_error() {
        let rows: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("provider_failure_oracle.json")).unwrap();
        assert_eq!(rows.len(), 840);
        for row in &rows {
            let status = StatusCode::from_u16(row[0].as_u64().unwrap() as u16).unwrap();
            let body = row[1].as_str().unwrap();
            let provider = row[2].as_str();
            // The legacy preserve gate: an unknown provider or an OAuth one.
            let preserve = provider.is_none_or(|p| matches!(p, "codex" | "claude" | "github"));
            let class = |scope| {
                classify_provider_failure_with(
                    scope,
                    provider,
                    status,
                    &HeaderMap::new(),
                    Some(body.as_bytes()),
                    preserve,
                )
            };
            let connection = class(RateLimitScope::Connection);
            assert_eq!(
                connection == ProviderFailureClass::CreditsExhausted,
                row[3] == 1,
                "credits {row}"
            );
            assert_eq!(
                class(RateLimitScope::Auto) == ProviderFailureClass::Banned,
                row[4] == 1,
                "banned {row}"
            );
            assert_eq!(
                class(RateLimitScope::Auto) == ProviderFailureClass::RequestScoped,
                row[5] == 1,
                "scoped {row}"
            );
        }
    }

    /// The quota text cooldowns of the legacy `checkFallbackError` for 1980
    /// status, body and provider combinations at backoff levels 0 and 3
    /// (`fallback_cooldown_oracle.json`). Rows are [status, body, provider,
    /// fallback, reason, cooldown at 0, cooldown at 3, rule scope, used hint,
    /// credits, permanent, reset hint]. A quota text row whose legacy cooldown
    /// is the same at both levels is the fixed cooldown this branch returns.
    #[test]
    fn quota_text_lockouts_match_the_legacy_check_fallback_error() {
        let rows: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("fallback_cooldown_oracle.json")).unwrap();
        assert_eq!(rows.len(), 1980);
        let quota_texts = [
            "Monthly usage limit reached. Resets in 13 days.",
            "monthly usage limit reached",
            "Usage limit reached for your plan",
            "You have reached your weekly usage limit",
            "Session limit reached",
            "You have used all the included free usage",
        ];
        let now = 1_700_000_000_000_i64;
        let mut checked = 0;
        for row in &rows {
            let status = StatusCode::from_u16(row[0].as_u64().unwrap() as u16).unwrap();
            let body = row[1].as_str().unwrap();
            let provider = row[2].as_str();
            let oauth = provider.is_none_or(|p| matches!(p, "agy" | "claude" | "codex"));
            // A legacy profile honors upstream hints for API key providers;
            // an unknown provider has no profile.
            let hints = provider.is_some_and(|p| !matches!(p, "agy" | "claude" | "codex"));
            let hint = hints
                .then(|| {
                    crate::error_text_classification::parse_retry_from_error_text(
                        body, provider, now,
                    )
                })
                .flatten()
                .filter(|hint| *hint > 0);
            let actual =
                quota_text_lockout_ms(status, provider, Some(body.as_bytes()), oauth, hint, now);
            let fixed = row[4] == "quota_exhausted"
                && row[5] == row[6]
                && row[5].as_u64().unwrap() > 0
                && row[9] == 0
                && row[10] == 0;
            let expected = (quota_texts.contains(&body) && fixed).then(|| row[5].as_u64().unwrap());
            if expected.is_some() {
                checked += 1;
            }
            assert_eq!(actual, expected, "{row}");
        }
        assert!(checked > 500, "{checked}");
    }

    #[test]
    fn a_missing_model_is_model_scoped_on_multiplexing_accounts() {
        assert!(per_model_failure_scope(
            RateLimitScope::Auto,
            Some("openrouter")
        ));
        assert!(per_model_failure_scope(
            RateLimitScope::Auto,
            Some("claude")
        ));
        assert!(per_model_failure_scope(
            RateLimitScope::Auto,
            Some("openai-compatible-acme")
        ));
        assert!(!per_model_failure_scope(
            RateLimitScope::Auto,
            Some("codex")
        ));
        assert!(!per_model_failure_scope(
            RateLimitScope::Model,
            Some("codex")
        ));
        assert!(!per_model_failure_scope(RateLimitScope::Auto, None));
        assert!(per_model_failure_scope(
            RateLimitScope::Model,
            Some("mistral")
        ));
        assert!(!per_model_failure_scope(
            RateLimitScope::Connection,
            Some("openrouter")
        ));
    }

    #[test]
    fn a_credit_body_on_a_429_needs_preserved_quota_signals() {
        let body = Some(&b"insufficient credits"[..]);
        let class = |preserve| {
            classify_provider_failure_with(
                RateLimitScope::Connection,
                Some("openai"),
                StatusCode::TOO_MANY_REQUESTS,
                &HeaderMap::new(),
                body,
                preserve,
            )
        };
        // Legacy shouldUseQuotaSignal: on a 429 the text counts for an OAuth
        // account, or when the body itself names a long-period quota.
        assert_eq!(class(true), ProviderFailureClass::CreditsExhausted);
        let credit_balance = Some(&b"Your credit balance is too low"[..]);
        assert_ne!(
            classify_provider_failure_with(
                RateLimitScope::Connection,
                Some("openai"),
                StatusCode::TOO_MANY_REQUESTS,
                &HeaderMap::new(),
                credit_balance,
                false,
            ),
            ProviderFailureClass::CreditsExhausted
        );
        // Off a 429 the same text counts for any account.
        assert_eq!(
            classify_provider_failure_with(
                RateLimitScope::Connection,
                Some("openai"),
                StatusCode::UNPROCESSABLE_ENTITY,
                &HeaderMap::new(),
                credit_balance,
                false,
            ),
            ProviderFailureClass::CreditsExhausted
        );
    }

    #[test]
    fn a_shared_wallet_402_exhausts_the_account_even_under_model_scope() {
        let class = |provider: &str, body: Option<&[u8]>| {
            classify_provider_failure(
                RateLimitScope::Model,
                Some(provider),
                StatusCode::PAYMENT_REQUIRED,
                &HeaderMap::new(),
                body,
            )
        };
        for body in [
            None,
            Some(&b"  "[..]),
            Some(br#"{"error":{"message":"Usage balance exhausted"}}"#),
        ] {
            assert_eq!(
                class("grok-cli", body),
                ProviderFailureClass::CreditsExhausted
            );
        }
        // Without the balance signal, or for another provider, the configured
        // model scope still applies.
        assert_eq!(
            class(
                "xai-oauth",
                Some(br#"{"error":{"message":"model not enabled"}}"#)
            ),
            ProviderFailureClass::Model
        );
        assert_eq!(class("xai", None), ProviderFailureClass::Model);
    }

    #[test]
    fn custom_ban_signals_extend_the_built_in_list_like_the_legacy_merge() {
        let class = |body: &[u8]| {
            classify_provider_failure(
                RateLimitScope::Connection,
                Some("openai-compatible"),
                StatusCode::FORBIDDEN,
                &HeaderMap::new(),
                Some(body),
            )
        };
        let body = br#"{"error":{"message":"Zebra-Quartz embargo applies"}}"#;
        assert_eq!(class(body), ProviderFailureClass::Transient);
        assert_eq!(
            normalize_banned_signals(vec![
                " zebra-quartz embargo ".into(),
                "".into(),
                "zebra-quartz embargo".into(),
            ]),
            Ok(vec!["zebra-quartz embargo".to_owned()])
        );
        // The body is lowercased; a signal is compared as stored.
        set_custom_banned_signals(vec!["Zebra-Quartz embargo".into()]);
        assert_eq!(class(body), ProviderFailureClass::Transient);
        set_custom_banned_signals(vec!["zebra-quartz embargo".into()]);
        assert_eq!(class(body), ProviderFailureClass::Banned);
        set_custom_banned_signals(Vec::new());
        assert_eq!(class(body), ProviderFailureClass::Transient);
        assert!(normalize_banned_signals(vec!["a
b"
        .into()])
        .is_err());
    }

    #[test]
    fn credit_and_ban_signals_follow_the_legacy_lists() {
        let class = |status: u16, body: &[u8]| {
            classify_provider_failure(
                RateLimitScope::Connection,
                Some("openai-compatible"),
                StatusCode::from_u16(status).unwrap(),
                &HeaderMap::new(),
                Some(body),
            )
        };
        for body in [
            &br#"{"error":{"message":"Insufficient account balance"}}"#[..],
            br#"{"error":{"message":"You have insufficient credits to make this request."}}"#,
            br#"{"error":{"message":"Your free tier has been exhausted"}}"#,
            br#"{"error":{"message":"You have exhausted all your credits"}}"#,
            br#"{"error":{"message":"Usage balance exhausted for this week"}}"#,
        ] {
            assert!(
                matches!(class(400, body), ProviderFailureClass::CreditsExhausted),
                "{}",
                String::from_utf8_lossy(body)
            );
        }
        // Gemini's transient wording stays a rate limit.
        assert!(matches!(
            class(
                429,
                br#"{"error":{"message":"Resource has been exhausted (e.g. check quota)."}}"#
            ),
            ProviderFailureClass::Transient
        ));
        assert!(matches!(
            class(
                403,
                br#"{"error":{"message":"This service has been disabled in this account."}}"#
            ),
            ProviderFailureClass::Banned
        ));
    }

    #[test]
    fn retired_models_moved_endpoints_and_billing_suspensions_are_lasting() {
        let class = |status: u16, body: &[u8]| {
            classify_provider_failure(
                RateLimitScope::Connection,
                Some("openai-compatible"),
                StatusCode::from_u16(status).unwrap(),
                &HeaderMap::new(),
                Some(body),
            )
        };
        let retired = br#"{"error":{"message":"This model models/gemini-2.5-flash is no longer available to new users."}}"#;
        assert_eq!(class(404, retired), ProviderFailureClass::RetiredModel);
        assert_eq!(
            class(
                410,
                br#"{"error":{"message":"The model has reached its end of life"}}"#
            ),
            ProviderFailureClass::RetiredModel
        );
        // The same text on another status is not a retirement.
        assert_ne!(class(429, retired), ProviderFailureClass::RetiredModel);
        assert_eq!(
            class(
                410,
                br#"{"error":{"message":"This API endpoint has moved. Please update your base_url."}}"#
            ),
            ProviderFailureClass::MovedEndpoint
        );
        assert_eq!(
            class(
                412,
                br#"{"error":{"message":"Account acme is suspended, possibly due to reaching the monthly spending limit"}}"#
            ),
            ProviderFailureClass::CreditsExhausted
        );
        assert!(ProviderFailureClass::RetiredModel.semantic_fallback());
        assert!(ProviderFailureClass::MovedEndpoint.semantic_fallback());
    }

    #[test]
    fn a_missing_request_resource_is_scoped_to_the_request() {
        let class = |status: u16, body: &[u8]| {
            classify_provider_failure(
                RateLimitScope::Connection,
                Some("codex"),
                StatusCode::from_u16(status).unwrap(),
                &HeaderMap::new(),
                Some(body),
            )
        };
        // The resource signal wins over a synthesized model_not_found code.
        let files = br#"{"error":{"message":"[404]: Files [file-be30851bd1614656872e725e] were not found","type":"invalid_request_error","code":"model_not_found"}}"#;
        assert_eq!(class(404, files), ProviderFailureClass::RequestScoped);
        assert!(!ProviderFailureClass::RequestScoped.semantic_fallback());
        let refusal = br#"{"type":"error","error":{"type":"FreeTierError","message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}}"#;
        let opencode = |provider: &str| {
            classify_provider_failure(
                RateLimitScope::Connection,
                Some(provider),
                StatusCode::FORBIDDEN,
                &HeaderMap::new(),
                Some(refusal),
            )
        };
        assert_eq!(
            opencode("opencode-zen"),
            ProviderFailureClass::RequestRefusal
        );
        assert!(ProviderFailureClass::RequestRefusal.semantic_fallback());
        assert_eq!(opencode("groq"), ProviderFailureClass::Transient);
        // Only a 404 is request-scoped; a bare 404 still locks the model.
        assert_eq!(class(400, files), ProviderFailureClass::Model);
        assert_eq!(
            class(404, br#"{"error":{"message":"Not Found"}}"#),
            ProviderFailureClass::Model
        );
    }

    #[test]
    fn daily_quota_signals_apply_off_429_and_for_oauth_or_explicit_quota_bodies() {
        let tpd = br#"{"error":{"message":"TPD rate limit reached, limit: 1000"}}"#;
        assert_eq!(
            daily_quota_failure(StatusCode::FORBIDDEN, Some(tpd), false),
            Some(true)
        );
        // An API-key 429 without long-period wording stays a short limit.
        assert_eq!(
            daily_quota_failure(StatusCode::TOO_MANY_REQUESTS, Some(tpd), false),
            None
        );
        assert_eq!(
            daily_quota_failure(StatusCode::TOO_MANY_REQUESTS, Some(tpd), true),
            Some(true)
        );
        let daily = br#"{"error":{"message":"You have exceeded your daily quota"}}"#;
        assert_eq!(
            daily_quota_failure(StatusCode::TOO_MANY_REQUESTS, Some(daily), false),
            Some(false)
        );
        assert_eq!(daily_quota_failure(StatusCode::OK, Some(daily), true), None);
        assert_eq!(
            daily_quota_failure(
                StatusCode::TOO_MANY_REQUESTS,
                Some(br#"{"error":"slow down"}"#),
                true
            ),
            None
        );
        assert!(looks_like_quota_exhausted(Some(
            br#"{"error":"usage limit reached."}"#
        )));
        assert!(!looks_like_quota_exhausted(Some(
            br#"{"error":"Per-minute usage limit reached"}"#
        )));
    }

    #[test]
    fn antigravity_credits_retry_is_limited_to_plan_quota_exhaustion() {
        assert!(antigravity_credits_retry_eligible(Some(
            br#"{"error":{"message":"Individual quota reached. Contact your administrator to enable overages."}}"#,
        )));
        assert!(antigravity_credits_retry_eligible(Some(
            br#"{"error":{"code":"quota_exhausted"}}"#,
        )));
        assert!(!antigravity_credits_retry_eligible(Some(
            br#"{"error":{"message":"Exhausted your capacity. Reset after 0s."}}"#,
        )));
        assert!(!antigravity_credits_retry_eligible(Some(
            br#"{"error":{"message":"Too many requests per minute"}}"#,
        )));
        assert!(!antigravity_credits_retry_eligible(Some(
            br#"{"error":{"message":"Insufficient GOOGLE_ONE_AI credit balance"}}"#,
        )));
    }

    #[test]
    fn explicit_scope_wins_and_auto_is_provider_specific() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-model-quota-remaining",
            HeaderValue::from_static("haiku=0,sonnet=42"),
        );
        assert_eq!(
            quota_failure_scope(
                RateLimitScope::Auto,
                Some("minimax"),
                StatusCode::TOO_MANY_REQUESTS,
                &headers,
            ),
            FailureScope::Model
        );
        assert_eq!(
            quota_failure_scope(
                RateLimitScope::Auto,
                Some("openai"),
                StatusCode::TOO_MANY_REQUESTS,
                &headers,
            ),
            FailureScope::Connection
        );
        assert_eq!(
            quota_failure_scope(
                RateLimitScope::Connection,
                Some("openrouter"),
                StatusCode::TOO_MANY_REQUESTS,
                &headers,
            ),
            FailureScope::Connection
        );
        assert_eq!(
            quota_failure_scope(
                RateLimitScope::Model,
                Some("custom"),
                StatusCode::TOO_MANY_REQUESTS,
                &headers,
            ),
            FailureScope::Model
        );
        assert_eq!(
            quota_failure_scope(
                RateLimitScope::Auto,
                Some("openrouter"),
                StatusCode::PAYMENT_REQUIRED,
                &headers,
            ),
            FailureScope::Model
        );
        assert!(authentication_failure_is_terminal(Some("OpenAI")));
        assert!(!authentication_failure_is_terminal(Some("openrouter")));
        assert!(!authentication_failure_is_terminal(Some(
            "openai-compatible"
        )));
    }

    #[test]
    fn bounded_error_evidence_preserves_failure_scope() {
        let headers = HeaderMap::new();
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("opencode"),
                StatusCode::UNAUTHORIZED,
                &headers,
                Some(br#"{"error":{"message":"Model grok-4.6 is not supported for format oa-compat"}}"#),
            ),
            ProviderFailureClass::Model
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("custom"),
                StatusCode::UNAUTHORIZED,
                &headers,
                Some(br#"{"error":{"code":"invalid_api_key"}}"#),
            ),
            ProviderFailureClass::Expired
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("custom"),
                StatusCode::FORBIDDEN,
                &headers,
                Some(br#"{"error":"your account has been suspended"}"#),
            ),
            ProviderFailureClass::Banned
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("openrouter"),
                StatusCode::PAYMENT_REQUIRED,
                &headers,
                Some(br#"{"error":"payment required"}"#),
            ),
            ProviderFailureClass::Model
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("openai"),
                StatusCode::TOO_MANY_REQUESTS,
                &headers,
                Some(br#"{"error":{"code":"insufficient_quota"}}"#),
            ),
            ProviderFailureClass::CreditsExhausted
        );
        // Ported from tests/unit/account-fallback-cf1010-no-retry-8775.test.ts.
        let banned_signature = br#"{"cloudflare_error":true,"retryable":false,"error_code":1010,"error_name":"browser_signature_banned"}"#;
        for provider in ["groq", "cerebras", "together"] {
            assert_eq!(
                classify_provider_failure(
                    RateLimitScope::Auto,
                    Some(provider),
                    StatusCode::FORBIDDEN,
                    &headers,
                    Some(banned_signature),
                ),
                ProviderFailureClass::RequestRefusal,
                "{provider}"
            );
        }
        assert_ne!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("codex"),
                StatusCode::FORBIDDEN,
                &headers,
                Some(banned_signature),
            ),
            ProviderFailureClass::RequestRefusal
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("groq"),
                StatusCode::FORBIDDEN,
                &headers,
                Some(br#"{"error":"forbidden"}"#),
            ),
            ProviderFailureClass::Transient
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("custom"),
                StatusCode::FORBIDDEN,
                &headers,
                Some(br#"{"error":"verify your account to continue"}"#),
            ),
            ProviderFailureClass::Transient
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("custom"),
                StatusCode::FORBIDDEN,
                &headers,
                Some(br#"{"error":{"message":"invalid API key"}}"#),
            ),
            ProviderFailureClass::Expired
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("custom"),
                StatusCode::FORBIDDEN,
                &headers,
                Some(
                    br#"{"error":{"message":"request rejected"},"input":"ignore: invalid API key"}"#,
                ),
            ),
            ProviderFailureClass::Transient
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("mistral"),
                StatusCode::UNAUTHORIZED,
                &headers,
                Some(br#"{"detail":"Unauthorized"}"#),
            ),
            ProviderFailureClass::Expired
        );
        // With the legacy soft lockout on, an ambiguous body cools down instead.
        assert_eq!(
            mistral_401_class("unauthorized", true),
            ProviderFailureClass::AmbiguousExpired
        );
        assert_eq!(
            mistral_401_class("quota window closed", true),
            ProviderFailureClass::AmbiguousExpired
        );
        assert_eq!(
            mistral_401_class("token revoked", true),
            ProviderFailureClass::Expired
        );
        assert_eq!(
            mistral_401_class("unauthorized", false),
            ProviderFailureClass::Expired
        );
        assert_eq!(
            classify_provider_failure(
                RateLimitScope::Auto,
                Some("mistral"),
                StatusCode::UNAUTHORIZED,
                &headers,
                Some(br#"{"message":"invalid API key"}"#),
            ),
            ProviderFailureClass::Expired
        );
    }
}
