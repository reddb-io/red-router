//! Retry hints and reasons read out of an error body, ported from the legacy
//! `open-sse/services/retryAfterJson.ts` and from `parseRetryFromErrorText`
//! and `classifyErrorText` in `accountFallback.ts`.
//!
//! Timestamps are read as ISO 8601 (`Z`, an offset, or none, which is UTC
//! here as on a server) and as the HTTP date form `Wed, 21 Oct 2026 07:28:00
//! GMT`; other spellings `Date.parse` accepts are not recognized.

use crate::error_config::{match_error_rule_by_text, ErrorReason};
use crate::quota_reset_parsing::{parse_day_granularity_reset_ms, parse_iso_datetime_reset_ms};
use crate::quota_text_cooldowns::is_subscription_quota_text;
use crate::resilience::{banned_text, credits_exhausted_text, looks_like_quota_exhausted};
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::LazyLock;

/// Legacy `MAX_SHORT_RETRY_HINT_MS`: a per-request throttle hint (Gemini
/// free tier) is capped at a day, independently of the caller's maximum, so a
/// malformed value cannot pass for a multi-day quota reset (#7940).
pub const MAX_SHORT_RETRY_HINT_MS: u64 = 24 * 60 * 60 * 1000;
/// Legacy `MAX_PROVIDER_COOLDOWN_MS`: thirty days.
pub const MAX_PROVIDER_COOLDOWN_MS: u64 = 30 * 24 * 60 * 60 * 1000;

/// Where a JSON retry hint came from (legacy `JsonRetryHintProvenance`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryHintSource {
    GoogleRpcRetryInfo,
    Body,
}

impl RetryHintSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GoogleRpcRetryInfo => "google_rpc_retry_info",
            Self::Body => "body",
        }
    }
}

/// Legacy `DetailedJsonRetryHint`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryHint {
    pub retry_after_ms: u64,
    pub source: RetryHintSource,
}

static LEADING_FLOAT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?").expect("static pattern")
});
static DELAY_MS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^([0-9]+(?:\.[0-9]+)?)\s*ms$").expect("static pattern"));
static DELAY_S: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^([0-9]+(?:\.[0-9]+)?)\s*s$").expect("static pattern"));
static DELAY_M: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^([0-9]+(?:\.[0-9]+)?)\s*m$").expect("static pattern"));
static DELAY_H: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^([0-9]+(?:\.[0-9]+)?)\s*h$").expect("static pattern"));
static NUMERIC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]+(?:\.[0-9]+)?$").expect("static pattern"));
static PLEASE_RETRY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)please retry in\s+([0-9.]+\s*s)").expect("static pattern"));
static RESETS_AFTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)resets? after ([0-9]+h)?([0-9]+m)?([0-9]+s)?").expect("static pattern")
});
static WILL_RESET_AFTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)will reset after ([0-9]+h)?([0-9]+m)?([0-9]+s)?").expect("static pattern")
});
static RESETS_IN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)resets? in ([0-9]+h)?([0-9]+m)?([0-9]+s)?").expect("static pattern")
});
static RETRY_IN_SEC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)please retry in ([0-9]+(?:\.[0-9]+)?)\s*s").expect("static pattern")
});
static HTTP_DATE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:[A-Za-z]{3},\s+)?([0-9]{1,2})\s+([A-Za-z]{3})\s+([0-9]{4})\s+([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?\s+(?:GMT|UTC|Z)$")
        .expect("static pattern")
});
static ISO_STAMP: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[Tt ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?\s*(Z|z|[+-][0-9]{2}:?[0-9]{2})?)?$")
        .expect("static pattern")
});

/// JavaScript `Math.round`: halves go up.
fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

/// JavaScript `Number.parseFloat`: the longest numeric prefix.
fn js_parse_float(text: &str) -> Option<f64> {
    let trimmed = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    LEADING_FLOAT
        .find(trimmed)
        .and_then(|found| found.as_str().parse::<f64>().ok())
}

/// Legacy `parseDelayString`: `33s`, `26.66s`, `2m`, `1h`, `1500ms`, or a bare
/// number of seconds. Falsy input is `None`.
pub fn parse_delay_string(value: &Value) -> Option<i64> {
    let text = match value {
        Value::Null | Value::Bool(false) => return None,
        Value::String(text) if text.is_empty() => return None,
        Value::String(text) => text.clone(),
        Value::Number(number) if number.as_f64() == Some(0.0) => return None,
        Value::Number(number) => number.to_string(),
        Value::Bool(true) => "true".to_owned(),
        other => other.to_string(),
    };
    let text = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let scaled = |pattern: &Regex, factor: f64| -> Option<i64> {
        pattern
            .captures(text)
            .and_then(|captures| captures[1].parse::<f64>().ok())
            .map(|number| js_round(number * factor))
    };
    if let Some(ms) = scaled(&DELAY_MS, 1.0) {
        return Some(ms);
    }
    if let Some(ms) = scaled(&DELAY_S, 1_000.0) {
        return Some(ms);
    }
    if let Some(ms) = scaled(&DELAY_M, 60_000.0) {
        return Some(ms);
    }
    if let Some(ms) = scaled(&DELAY_H, 3_600_000.0) {
        return Some(ms);
    }
    js_parse_float(text)
        .filter(|number| number.is_finite())
        .map(|number| js_round(number * 1_000.0))
}

fn month_number(name: &str) -> Option<i64> {
    [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ]
    .iter()
    .position(|month| month.eq_ignore_ascii_case(name))
    .map(|index| index as i64 + 1)
}

/// `Date.parse` of an ISO 8601 or HTTP date string, in milliseconds.
fn parse_date_ms(text: &str) -> Option<i64> {
    let text = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let days = |year: i64, month: i64, day: i64| {
        let y = if month <= 2 { year - 1 } else { year };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let mp = (month + 9) % 12;
        let doy = (153 * mp + 2) / 5;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146_097 + doe - 719_468 + (day - 1)
    };
    if let Some(captures) = HTTP_DATE.captures(text) {
        let day: i64 = captures[1].parse().ok()?;
        let month = month_number(&captures[2])?;
        let year: i64 = captures[3].parse().ok()?;
        let hour: i64 = captures[4].parse().ok()?;
        let minute: i64 = captures[5].parse().ok()?;
        let second: i64 = captures
            .get(6)
            .map_or(Some(0), |m| m.as_str().parse().ok())?;
        if !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 59 {
            return None;
        }
        return Some(
            (days(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000,
        );
    }
    let captures = ISO_STAMP.captures(text)?;
    let number = |index: usize| captures.get(index).map(|m| m.as_str().parse::<i64>().ok());
    let year = number(1)??;
    let month = number(2)??;
    let day = number(3)??;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (hour, minute) = (number(4).unwrap_or(Some(0))?, number(5).unwrap_or(Some(0))?);
    let second = number(6).unwrap_or(Some(0))?;
    let millis: i64 = captures.get(7).map_or(Some(0), |m| {
        let mut digits: String = m.as_str().chars().take(3).collect();
        while digits.len() < 3 {
            digits.push('0');
        }
        digits.parse().ok()
    })?;
    if minute > 59
        || second > 59
        || hour > 24
        || (hour == 24 && (minute != 0 || second != 0 || millis != 0))
    {
        return None;
    }
    let offset = match captures.get(8).map(|m| m.as_str()) {
        None | Some("Z" | "z") => 0,
        Some(zone) => {
            let sign = if zone.starts_with('-') { -1 } else { 1 };
            let digits: String = zone[1..].chars().filter(char::is_ascii_digit).collect();
            let (hours, minutes): (i64, i64) =
                (digits[..2].parse().ok()?, digits[2..].parse().ok()?);
            if hours > 23 || minutes > 59 {
                return None;
            }
            sign * (hours * 60 + minutes)
        }
    };
    Some(
        (days(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000 + millis
            - offset * 60_000,
    )
}

fn positive_capped_ms(value: Option<&Value>, max_ms: u64) -> Option<u64> {
    let number = value?.as_f64().filter(|n| n.is_finite() && *n > 0.0)?;
    Some(if number >= max_ms as f64 {
        max_ms
    } else {
        number as u64
    })
}

fn future_timestamp_ms(value: Option<&Value>, max_ms: u64, now_ms: i64) -> Option<u64> {
    let wait = parse_date_ms(value?.as_str()?)? - now_ms;
    (wait > 0).then(|| u64::try_from(wait).unwrap_or(u64::MAX).min(max_ms))
}

/// Legacy `futureResetAtMs`: `resets_at` as epoch seconds or milliseconds, a
/// numeric string of either, or an ISO timestamp.
fn future_reset_at_ms(value: Option<&Value>, max_ms: u64, now_ms: i64) -> Option<u64> {
    match value? {
        Value::Number(number) => {
            let n = number.as_f64().filter(|n| n.is_finite() && *n > 0.0)?;
            let ms = if n < 1e12 { n * 1_000.0 } else { n };
            let wait = ms - now_ms as f64;
            (wait > 0.0).then_some(if wait >= max_ms as f64 {
                max_ms
            } else {
                wait as u64
            })
        }
        Value::String(text)
            if NUMERIC
                .is_match(text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')) =>
        {
            let number: f64 = text.trim().parse().ok()?;
            future_reset_at_ms(Some(&serde_json::json!(number)), max_ms, now_ms)
        }
        other => future_timestamp_ms(Some(other), max_ms, now_ms),
    }
}

fn record(value: Option<&Value>) -> &Map<String, Value> {
    static EMPTY: LazyLock<Map<String, Value>> = LazyLock::new(Map::new);
    value.and_then(Value::as_object).unwrap_or(&EMPTY)
}

/// The first of `fields` present and not null, like a `??` chain.
fn first_of<'a>(maps: &[&'a Map<String, Value>], fields: &[&str]) -> Option<&'a Value> {
    for field in fields {
        for map in maps {
            if let Some(value) = map.get(*field).filter(|value| !value.is_null()) {
                return Some(value);
            }
        }
    }
    None
}

/// Gemini and Google RPC 429 bodies carry the throttle hint as
/// `error.details[].{"@type": ".../google.rpc.RetryInfo", "retryDelay": "26s"}`.
fn retry_info_details_ms(details: Option<&Value>) -> Option<u64> {
    for detail in details.and_then(Value::as_array).into_iter().flatten() {
        let detail = record(Some(detail));
        let kind = detail
            .get("@type")
            .filter(|value| !value.is_null())
            .map_or_else(String::new, |value| match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            });
        if !kind.contains("RetryInfo") {
            continue;
        }
        if let Some(ms) = detail
            .get("retryDelay")
            .and_then(parse_delay_string)
            .filter(|ms| *ms > 0)
        {
            return Some((ms as u64).min(MAX_SHORT_RETRY_HINT_MS));
        }
    }
    None
}

/// Legacy `parseDetailedRetryHintFromJsonBody`: the wait a 429 JSON body asks
/// for, from a RetryInfo detail, a reset time, an ISO `retryAfter` or a
/// millisecond field, at the top level or under `error`.
pub fn parse_detailed_retry_hint_from_json_body(
    body: &str,
    max_ms: u64,
    now_ms: i64,
) -> Option<RetryHint> {
    let parsed: Value = serde_json::from_str(body).ok()?;
    let root = parsed.as_object().filter(|root| !root.is_empty())?;
    let error = record(root.get("error"));
    let details = error
        .get("details")
        .filter(|value| !value.is_null())
        .or_else(|| root.get("details"));
    if let Some(retry_after_ms) = retry_info_details_ms(details) {
        return Some(RetryHint {
            retry_after_ms,
            source: RetryHintSource::GoogleRpcRetryInfo,
        });
    }
    let maps = [error, root];
    let hint = |retry_after_ms| RetryHint {
        retry_after_ms,
        source: RetryHintSource::Body,
    };
    if let Some(ms) = future_reset_at_ms(
        first_of(&maps, &["resets_at"]).or_else(|| first_of(&maps, &["resetsAt"])),
        max_ms,
        now_ms,
    ) {
        return Some(hint(ms));
    }
    if let Some(ms) = future_timestamp_ms(first_of(&maps, &["retryAfter"]), max_ms, now_ms) {
        return Some(hint(ms));
    }
    let numeric =
        first_of(&maps, &["retry_after_ms"]).or_else(|| first_of(&maps, &["retryAfterMs"]));
    positive_capped_ms(numeric, max_ms).map(hint)
}

/// Legacy `parseRetryHintFromJsonBody`.
pub fn parse_retry_hint_from_json_body(body: &str, max_ms: u64, now_ms: i64) -> Option<u64> {
    parse_detailed_retry_hint_from_json_body(body, max_ms, now_ms).map(|hint| hint.retry_after_ms)
}

/// The `(Xh)(Ym)(Zs)` groups of a match as milliseconds, capped at thirty days.
fn duration_ms(captures: &regex::Captures<'_>) -> Option<u64> {
    let part = |index: usize, unit_ms: u64| {
        captures
            .get(index)
            .and_then(|m| {
                m.as_str()
                    .trim_end_matches(|c: char| c.is_ascii_alphabetic())
                    .parse::<u64>()
                    .ok()
            })
            .map_or(0, |count| count.saturating_mul(unit_ms))
    };
    let total = part(1, 3_600_000) + part(2, 60_000) + part(3, 1_000);
    (total > 0).then(|| total.min(MAX_PROVIDER_COOLDOWN_MS))
}

fn any_group(captures: &regex::Captures<'_>) -> bool {
    (1..=3).any(|index| captures.get(index).is_some_and(|m| !m.as_str().is_empty()))
}

/// Legacy `parseRetryFromErrorText`: how long to wait, read from a JSON body or
/// from phrasing such as "Please retry in 26.6s", "resets after 2h5m",
/// "Resets in 164h27m24s", an absolute reset time or a day countdown.
pub fn parse_retry_from_error_text(text: &str, provider: Option<&str>, now_ms: i64) -> Option<u64> {
    if text.is_empty() {
        return None;
    }
    if let Some(ms) = parse_retry_hint_from_json_body(text, MAX_PROVIDER_COOLDOWN_MS, now_ms) {
        return Some(ms);
    }
    // Gemini free-tier text, short throttle hint.
    let please = PLEASE_RETRY
        .captures(text)
        .and_then(|captures| parse_delay_string(&Value::String(captures[1].to_owned())))
        .filter(|ms| *ms > 0);
    if let Some(ms) = please {
        return Some((ms as u64).min(MAX_SHORT_RETRY_HINT_MS));
    }
    if let Some(ms) = parse_iso_datetime_reset_ms(text, MAX_PROVIDER_COOLDOWN_MS, now_ms, provider)
    {
        return Some(ms);
    }
    for pattern in [&RESETS_AFTER, &WILL_RESET_AFTER, &RESETS_IN] {
        if let Some(captures) = pattern
            .captures(text)
            .filter(|captures| any_group(captures))
        {
            return duration_ms(&captures);
        }
    }
    if let Some(captures) = RETRY_IN_SEC.captures(text) {
        if let Some(seconds) = captures[1]
            .parse::<f64>()
            .ok()
            .filter(|s| s.is_finite() && *s > 0.0)
        {
            return Some((js_round(seconds * 1_000.0) as u64).min(MAX_PROVIDER_COOLDOWN_MS));
        }
    }
    parse_day_granularity_reset_ms(text, MAX_PROVIDER_COOLDOWN_MS, now_ms, provider)
}

/// Legacy `classifyErrorText`: the rate limit reason an error text points at.
/// Quota and billing wording first, then credit and ban signals, the
/// configured text rules, and a few generic markers.
pub fn classify_error_text(text: &str) -> ErrorReason {
    if text.is_empty() {
        return ErrorReason::Unknown;
    }
    let lower = text.to_lowercase();
    let has = |marker: &str| lower.contains(marker);
    if has("quota exceeded")
        || has("quota depleted")
        || has("quota will reset")
        || has("your quota will reset")
        || has("quota has been exceeded")
        || has("hour quota")
        || has("billing")
        || looks_like_quota_exhausted(Some(lower.as_bytes()))
        || is_subscription_quota_text(&lower, None)
    {
        return ErrorReason::QuotaExhausted;
    }
    if credits_exhausted_text(&lower) {
        return ErrorReason::QuotaExhausted;
    }
    if banned_text(&lower) {
        return ErrorReason::AuthError;
    }
    if let Some(rule) = match_error_rule_by_text(text) {
        return rule.reason;
    }
    if has("rate_limit") {
        return ErrorReason::RateLimitExceeded;
    }
    if has("resource exhausted") || has("high demand") {
        return ErrorReason::ModelCapacity;
    }
    if has("unauthorized") || has("invalid api key") || has("authentication") {
        return ErrorReason::AuthError;
    }
    if has("server error") || has("internal error") {
        return ErrorReason::ServerError;
    }
    ErrorReason::Unknown
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Outputs the legacy functions produced for the same inputs, with the
    /// clock fixed and the zone UTC (`error_text_classification_oracle.json`,
    /// generated with Node).
    #[test]
    fn retry_hints_and_reasons_match_the_legacy_functions() {
        let oracle: Value =
            serde_json::from_str(include_str!("error_text_classification_oracle.json")).unwrap();
        let now = oracle["now"].as_i64().unwrap();
        for case in oracle["delay"].as_array().unwrap() {
            assert_eq!(parse_delay_string(&case[0]), case[1].as_i64(), "{case}");
        }
        for case in oracle["json"].as_array().unwrap() {
            let found = parse_detailed_retry_hint_from_json_body(
                case[0].as_str().unwrap(),
                MAX_PROVIDER_COOLDOWN_MS,
                now,
            );
            let actual = found.map_or(Value::Null, |hint| json!({"retryAfterMs": hint.retry_after_ms, "provenance": hint.source.as_str()}));
            assert_eq!(actual, case[1], "{case}");
        }
        for case in oracle["text"].as_array().unwrap() {
            let provider = case[1].as_str();
            assert_eq!(
                parse_retry_from_error_text(case[0].as_str().unwrap(), provider, now),
                case[2].as_u64(),
                "{case}"
            );
        }
        for case in oracle["classify"].as_array().unwrap() {
            assert_eq!(
                classify_error_text(case[0].as_str().unwrap()).as_str(),
                case[1].as_str().unwrap(),
                "{case}"
            );
        }
    }
}
