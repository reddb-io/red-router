//! The per-provider error rule catalog, ported from the legacy
//! `open-sse/config/providerErrorRules.ts`.
//!
//! A rule recognizes a provider's own way of saying a quota is spent (a
//! header, a body phrase, a status) and declares the reason, the lock scope
//! and optionally the cooldown, so an exhausted account is not retried as if
//! it were a short rate limit. This module only matches; what a match does to
//! availability is decided by the caller.

use axum::http::HeaderMap;
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

/// What a rule locks (legacy `ProviderErrorRuleMatch.scope`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleScope {
    Model,
    Provider,
    Connection,
}

impl RuleScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::Provider => "provider",
            Self::Connection => "connection",
        }
    }
}

/// A matched rule (legacy `ProviderErrorRuleMatch`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleMatch {
    pub reason: String,
    pub scope: RuleScope,
    /// An explicit cooldown; the per-reason default applies when absent.
    pub cooldown_ms: Option<u64>,
}

/// An operator-declared rule (legacy `OperatorProviderErrorRule`): a plain
/// case-insensitive substring of the error body, never a pattern, so it
/// cannot introduce a ReDoS on the classification path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperatorRule {
    pub status: u16,
    pub match_text: String,
    pub scope: RuleScope,
    pub reason: Option<String>,
    pub cooldown_ms: Option<u64>,
}

/// Providers sharing the opencode upstream envelope.
const OPENCODE_FAMILY: [&str; 4] = ["opencode", "opencode-zen", "opencode-go", "opencode-cli"];

/// Providers whose built-in rule scope is consumed by the persistence layer
/// (legacy `HONORS_RULE_LOCK_SCOPE_PROVIDERS`), an exclusive allowlist.
fn honors_builtin_scope(key: &str) -> bool {
    key == "agentrouter" || OPENCODE_FAMILY.contains(&key)
}

/// Legacy `honorsRuleLockScope`: the built-in allowlist, or any provider the
/// operator declared a rule for.
pub fn honors_rule_lock_scope(provider: Option<&str>, has_operator_rule: bool) -> bool {
    provider
        .filter(|provider| !provider.is_empty())
        .is_some_and(|provider| honors_builtin_scope(&provider.to_lowercase()) || has_operator_rule)
}

/// Legacy `isEgressBucketedLockScope`: the opencode free tier is bucketed by
/// egress IP, not by account (#9611), so its 429 locks apply per IP.
pub fn is_egress_bucketed_lock_scope(provider: Option<&str>) -> bool {
    provider.is_some_and(|provider| {
        matches!(
            provider.to_lowercase().as_str(),
            "opencode" | "opencode-go" | "opencode-cli"
        )
    })
}

/// Legacy `egressBucketedLockProviders`, sorted.
pub fn egress_bucketed_lock_providers() -> [&'static str; 3] {
    ["opencode", "opencode-cli", "opencode-go"]
}

/// Legacy `resolveRuleMatchBody`: the full error text for the providers whose
/// rules read it (agentrouter's `额度不足`) or that have an operator rule, the
/// structured error `{code, type}` for everyone else.
pub fn resolve_rule_match_body(
    provider: Option<&str>,
    structured_error: Option<&Value>,
    error_text: Option<&str>,
    has_operator_rule: bool,
) -> Value {
    let reads_text = provider
        .is_some_and(|provider| provider.to_lowercase() == "agentrouter" || has_operator_rule);
    match error_text.filter(|text| !text.is_empty()) {
        Some(text) if reads_text => Value::String(text.to_owned()),
        _ => structured_error.cloned().unwrap_or(Value::Null),
    }
}

/// `JSON.stringify(body ?? "").toLowerCase()`, the text the built-in rules
/// search.
fn body_text(body: &Value) -> String {
    let body = if body.is_null() {
        Value::String(String::new())
    } else {
        body.clone()
    };
    serde_json::to_string(&body)
        .unwrap_or_default()
        .to_lowercase()
}

static RESET_COUNTDOWN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"resets?\s+in\s+(\d+)\s+(day|days|hour|hours|minute|minutes|second|seconds)\b")
        .expect("static pattern")
});

/// Legacy `parseResetCountdownMs`: the cooldown of a `Resets in N <unit>`
/// phrase, from an already lowercased body. `None` without one, or for zero.
pub fn parse_reset_countdown_ms(text: &str) -> Option<u64> {
    let captures = RESET_COUNTDOWN.captures(text)?;
    let n: u64 = captures[1].parse().ok().filter(|n| *n > 0)?;
    let unit_ms = match &captures[2] {
        "day" | "days" => 86_400_000,
        "hour" | "hours" => 3_600_000,
        "minute" | "minutes" => 60_000,
        _ => 1_000,
    };
    Some(n.saturating_mul(unit_ms))
}

fn rule(reason: &str, scope: RuleScope, cooldown_ms: Option<u64>) -> Option<RuleMatch> {
    Some(RuleMatch {
        reason: reason.to_owned(),
        scope,
        cooldown_ms,
    })
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// The opencode family: an account-wide quota whose body often just says
/// "rate limit reached", so a header or phrase is the tell.
fn opencode_rules(status: u16, headers: &HeaderMap, body: &Value) -> Option<RuleMatch> {
    let text = body_text(body);
    // The monthly cap carries its reset in the body: "Resets in 13 days".
    if status == 429 && text.contains("monthly usage limit reached") {
        if let Some(cooldown) = parse_reset_countdown_ms(&text) {
            return rule("quota_exhausted", RuleScope::Connection, Some(cooldown));
        }
    }
    if status == 429
        && (header(headers, "x-ratelimit-remaining-requests") == Some("0")
            || header(headers, "x-ratelimit-remaining-tokens") == Some("0"))
    {
        return rule("quota_exhausted", RuleScope::Connection, None);
    }
    if status == 429
        && [
            "organization_quota_exceeded",
            "account_quota_exceeded",
            "plan_limit_reached",
        ]
        .iter()
        .any(|marker| text.contains(marker))
    {
        return rule("quota_exhausted", RuleScope::Connection, None);
    }
    if status == 400 && text.contains("upstream request failed: model is unavailable.") {
        return rule("model_capacity", RuleScope::Model, Some(3_600_000));
    }
    None
}

/// Minimax reports per-model quota in `x-model-quota-remaining:
/// haiku=0,sonnet=42`, so only the exhausted model is locked.
fn minimax_rules(status: u16, headers: &HeaderMap) -> Option<RuleMatch> {
    if status != 429 {
        return None;
    }
    let value = header(headers, "x-model-quota-remaining").filter(|value| !value.is_empty())?;
    let exhausted = value
        .split(',')
        .any(|pair| pair.split('=').nth(1).map(str::trim) == Some("0"));
    exhausted.then(|| RuleMatch {
        reason: "quota_exhausted".to_owned(),
        scope: RuleScope::Model,
        cooldown_ms: None,
    })
}

/// Cloudflare Workers AI shares 10,000 neurons a day across the account (#6980).
fn cloudflare_rules(status: u16, body: &Value) -> Option<RuleMatch> {
    (status == 429 && body_text(body).contains("daily free allocation")).then(|| RuleMatch {
        reason: "quota_exhausted".to_owned(),
        scope: RuleScope::Connection,
        cooldown_ms: None,
    })
}

/// OpenRouter answers 402 for a negative balance and for a depleted per-key
/// cap (#6842): lock the connection for two minutes so routing does not
/// hot-loop back onto it.
fn openrouter_rules(status: u16) -> Option<RuleMatch> {
    (status == 402).then(|| RuleMatch {
        reason: "quota_exhausted".to_owned(),
        scope: RuleScope::Connection,
        cooldown_ms: Some(2 * 60 * 1000),
    })
}

/// AgentRouter restates a temporary quota as a 400, 403 or 429 with a Chinese
/// body, so the text is the discriminator.
fn agentrouter_rules(status: u16, body: &Value) -> Option<RuleMatch> {
    let text = body_text(body);
    if matches!(status, 400 | 403 | 429) && text.contains("额度不足") {
        return rule("quota_exhausted", RuleScope::Connection, None);
    }
    if status == 403 && text.contains("无权访问模型") {
        // Declared 6 h; the model lockout clamps it to its own ceiling.
        return rule("auth_error", RuleScope::Model, Some(6 * 60 * 60 * 1000));
    }
    None
}

/// Legacy `getProviderErrorRuleMatch`: the first rule that matches. An
/// operator rule wins over the built-in catalog.
pub fn get_provider_error_rule_match(
    provider: Option<&str>,
    status: u16,
    headers: &HeaderMap,
    body: &Value,
    operator_rules: &[OperatorRule],
) -> Option<RuleMatch> {
    let key = provider?.to_lowercase();
    let text = match body {
        Value::String(text) => text.clone(),
        // `JSON.stringify(body ?? "")`: a missing body is the empty string.
        Value::Null => "\"\"".to_owned(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
    .to_lowercase();
    for operator in operator_rules {
        if operator.status == status && text.contains(&operator.match_text.to_lowercase()) {
            return Some(RuleMatch {
                reason: operator
                    .reason
                    .clone()
                    .unwrap_or_else(|| "quota_exhausted".to_owned()),
                scope: operator.scope,
                cooldown_ms: operator.cooldown_ms,
            });
        }
    }
    match key.as_str() {
        key if OPENCODE_FAMILY.contains(&key) => opencode_rules(status, headers, body),
        "minimax" | "minimax-passthrough" => minimax_rules(status, headers),
        "cloudflare-ai" => cloudflare_rules(status, body),
        "openrouter" => openrouter_rules(status),
        "agentrouter" => agentrouter_rules(status, body),
        _ => None,
    }
}

/// Legacy `getOpencodeModelUnavailableMatch`: the opencode family's
/// "Upstream request failed: Model is unavailable." 400, or `None`.
pub fn get_opencode_model_unavailable_match(
    provider: Option<&str>,
    status: u16,
    headers: &HeaderMap,
    error_text: &Value,
) -> Option<RuleMatch> {
    if status != 400
        || !provider
            .is_some_and(|provider| OPENCODE_FAMILY.contains(&provider.to_lowercase().as_str()))
    {
        return None;
    }
    get_provider_error_rule_match(provider, status, headers, error_text, &[])
        .filter(|found| found.scope == RuleScope::Model && found.reason == "model_capacity")
}

/// The model lockout of the opencode family's "Model is unavailable." 400
/// (legacy `checkFallbackError` 400 pre-check and the model-scope branch of
/// `markAccountUnavailable`): the rule's hour, read from the raw error text.
pub fn opencode_model_unavailable_ms(
    provider: Option<&str>,
    status: u16,
    headers: &HeaderMap,
    error_text: &str,
) -> Option<u64> {
    get_opencode_model_unavailable_match(
        provider,
        status,
        headers,
        &Value::String(error_text.to_owned()),
    )
    .map(|found| found.cooldown_ms.unwrap_or(3_600_000))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderName, HeaderValue};
    use serde_json::json;

    /// The model-scope rows of the fallback cooldown oracle (legacy
    /// `checkFallbackError` over 1980 status, body and provider rows): only
    /// the opencode family's "Model is unavailable." 400 locks the model.
    #[test]
    fn the_opencode_model_lockout_matches_the_legacy_fallback_rows() {
        let rows: Vec<Value> =
            serde_json::from_str(include_str!("fallback_cooldown_oracle.json")).unwrap();
        let mut matched = 0;
        for row in &rows {
            let status = row[0].as_u64().unwrap() as u16;
            let body = row[1].as_str().unwrap();
            let provider = row[2].as_str();
            let actual = opencode_model_unavailable_ms(provider, status, &HeaderMap::new(), body);
            let expected =
                (row[7] == "model" && row[4] == "model_capacity").then(|| row[5].as_u64().unwrap());
            if expected.is_some() {
                matched += 1;
            }
            assert_eq!(actual, expected, "{row}");
        }
        assert_eq!(matched, 1);
    }

    fn headers_from(value: &Value) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in value.as_object().into_iter().flatten() {
            map.insert(
                HeaderName::from_bytes(name.as_bytes()).unwrap(),
                HeaderValue::from_str(value.as_str().unwrap()).unwrap(),
            );
        }
        map
    }

    fn operator_rules(value: &Value) -> Vec<OperatorRule> {
        value
            .as_array()
            .into_iter()
            .flatten()
            .map(|rule| OperatorRule {
                status: rule["status"].as_u64().unwrap() as u16,
                match_text: rule["match"].as_str().unwrap().to_owned(),
                scope: match rule["scope"].as_str().unwrap() {
                    "model" => RuleScope::Model,
                    "provider" => RuleScope::Provider,
                    _ => RuleScope::Connection,
                },
                reason: rule["reason"].as_str().map(str::to_owned),
                cooldown_ms: rule["cooldownMs"].as_u64(),
            })
            .collect()
    }

    fn match_json(found: Option<RuleMatch>) -> Value {
        found.map_or(Value::Null, |found| {
            let mut out = json!({"reason": found.reason, "scope": found.scope.as_str()});
            if let Some(cooldown) = found.cooldown_ms {
                out["cooldownMs"] = json!(cooldown);
            }
            out
        })
    }

    /// Outputs the legacy functions produced for the same inputs
    /// (`provider_error_rules_oracle.json`, generated with Node).
    #[test]
    fn rules_match_the_legacy_catalog() {
        let oracle: Value =
            serde_json::from_str(include_str!("provider_error_rules_oracle.json")).unwrap();
        for case in oracle["match"].as_array().unwrap() {
            let found = get_provider_error_rule_match(
                case["provider"].as_str(),
                case["status"].as_u64().unwrap() as u16,
                &headers_from(&case["headers"]),
                &case["body"],
                &operator_rules(&case["operator"]),
            );
            assert_eq!(match_json(found), case["result"], "{case}");
        }
        for case in oracle["countdown"].as_array().unwrap() {
            assert_eq!(
                parse_reset_countdown_ms(case[0].as_str().unwrap()),
                case[1].as_u64(),
                "{case}"
            );
        }
        for case in oracle["unavailable"].as_array().unwrap() {
            let found = get_opencode_model_unavailable_match(
                case["provider"].as_str(),
                case["status"].as_u64().unwrap() as u16,
                &HeaderMap::new(),
                &case["body"],
            );
            assert_eq!(match_json(found), case["result"], "{case}");
        }
        for case in oracle["scope"].as_array().unwrap() {
            let provider = case["provider"].as_str();
            assert_eq!(
                honors_rule_lock_scope(provider, case["operator"].as_bool().unwrap()),
                case["honors"].as_bool().unwrap(),
                "{case}"
            );
            assert_eq!(
                is_egress_bucketed_lock_scope(provider),
                case["egress"].as_bool().unwrap(),
                "{case}"
            );
        }
        for case in oracle["body"].as_array().unwrap() {
            let structured = (!case["structured"].is_null()).then_some(&case["structured"]);
            assert_eq!(
                resolve_rule_match_body(
                    case["provider"].as_str(),
                    structured,
                    case["text"].as_str(),
                    case["operator"].as_bool().unwrap()
                ),
                case["result"],
                "{case}"
            );
        }
        assert_eq!(
            egress_bucketed_lock_providers(),
            ["opencode", "opencode-cli", "opencode-go"]
        );
    }
}
