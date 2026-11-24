//! Reset times quoted in quota error bodies, ported from the legacy
//! `open-sse/services/quotaResetParsing.ts`: a countdown in whole days, an
//! absolute datetime, or a year-less `MM-DD HH:MM` stamp, each as the wait in
//! milliseconds capped at a maximum.

use regex::Regex;
use std::sync::LazyLock;

static ZAI_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"\[1308\]",
        r"\[1310\]",
        r"(?i)(?-u:\b)z\.ai(?-u:\b)",
        r"(?i)(?-u:\b)bigmodel\.cn(?-u:\b)",
    ]
    .iter()
    .map(|pattern| Regex::new(pattern).expect("static pattern"))
    .collect()
});
static ZONE_ONLY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^(?:Z|[+-][0-9]{2}:?[0-9]{2})$").expect("static pattern"));
static DAY_COUNTDOWN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)reset(?:s)?\s+in\s+([0-9]+)\s*day(?:s)?").expect("static pattern")
});
static ISO_RESET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?-u:\b)(?:try again at|wait until|reset(?:s)?\s+at|available at|retry after)\s+([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt ]([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?(?:\.([0-9]+))?\s*(Z|[+-][0-9]{2}:?[0-9]{2})?",
    )
    .expect("static pattern")
});
static MONTH_DAY_RESET: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)reset(?:s)?\s+at\s+([0-9]{2})-([0-9]{2})\s+([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?\s*(?:UTC|Z)?")
        .expect("static pattern")
});

/// The providers whose registry entry declares a `naiveResetTimezone` of
/// `+08:00` (Z.AI and the GLM family, which quote China Standard Time).
fn configured_naive_zone(provider: &str) -> Option<&'static str> {
    matches!(provider, "glm" | "glm-cn" | "glmcn" | "glmt" | "zai").then_some("+08:00")
}

/// Legacy `resolveNaiveResetZone` (#14479): the zone for a timestamp that
/// names none. An explicit offset passed as the provider wins, then the
/// provider's configured zone, then a Z.AI or GLM marker in the message,
/// else UTC.
pub fn resolve_naive_reset_zone(message: &str, provider_or_zone: Option<&str>) -> String {
    if let Some(value) = provider_or_zone.filter(|value| !value.is_empty()) {
        if ZONE_ONLY.is_match(value) {
            return value.to_uppercase();
        }
        if let Some(zone) = configured_naive_zone(value) {
            return zone.to_owned();
        }
    }
    if ZAI_PATTERNS.iter().any(|pattern| pattern.is_match(message)) {
        return "+08:00".to_owned();
    }
    "Z".to_owned()
}

/// Days since 1970-01-01 of a civil date (proleptic Gregorian); a day past the
/// month end rolls into the next month, like `Date.UTC`.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468 + (day - 1)
}

/// The civil year of a day count since the epoch.
fn year_from_days(days: i64) -> i64 {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        y + 1
    } else {
        y
    }
}

/// `Date.UTC(year, month - 1, day, hour, minute, second)` in milliseconds.
fn utc_ms(year: i64, month: i64, day: i64, hour: i64, minute: i64, second: i64) -> i64 {
    (days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000
}

/// Legacy `parseMonthDayResetMs`: `reset at MM-DD HH:MM[:SS] [UTC]` with no
/// year is the next such instant, rolling to next year when it has passed.
pub fn parse_month_day_reset_ms(message: &str, max_ms: u64, now_ms: i64) -> Option<u64> {
    let captures = MONTH_DAY_RESET.captures(message)?;
    let number = |index: usize| {
        captures
            .get(index)
            .map_or(Some(0), |m| m.as_str().parse::<i64>().ok())
    };
    let (month, day, hour, minute, second) =
        (number(1)?, number(2)?, number(3)?, number(4)?, number(5)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let mut year = year_from_days(now_ms.div_euclid(86_400_000));
    let mut reset = utc_ms(year, month, day, hour, minute, second);
    if reset <= now_ms {
        year += 1;
        reset = utc_ms(year, month, day, hour, minute, second);
    }
    let wait = reset - now_ms;
    (wait > 0).then(|| u64::try_from(wait).unwrap_or(u64::MAX).min(max_ms))
}

/// Legacy `parseIsoDateTimeResetMs`: `reset at 2026-08-29 21:01:21` (a `T` or
/// space separator, `Z` or `±HH:MM`). A naive datetime takes the zone of
/// `resolve_naive_reset_zone`. `None` when the instant is not in the future.
pub fn parse_iso_datetime_reset_ms(
    message: &str,
    max_ms: u64,
    now_ms: i64,
    provider_or_zone: Option<&str>,
) -> Option<u64> {
    let captures = ISO_RESET.captures(message)?;
    let part = |index: usize| captures.get(index).map(|m| m.as_str());
    let year: i64 = part(1)?.parse().ok()?;
    let (month, day): (i64, i64) = (part(2)?.parse().ok()?, part(3)?.parse().ok()?);
    let (hour, minute): (i64, i64) = (part(4)?.parse().ok()?, part(5)?.parse().ok()?);
    let second: i64 = part(6).map_or(Some(0), |text| text.parse().ok())?;
    // Fractional seconds beyond milliseconds are truncated.
    let millis: i64 = part(7).map_or(Some(0), |text| {
        let mut digits: String = text.chars().take(3).collect();
        while digits.len() < 3 {
            digits.push('0');
        }
        digits.parse().ok()
    })?;
    let raw_zone = part(8).map_or_else(
        || resolve_naive_reset_zone(message, provider_or_zone),
        str::to_uppercase,
    );
    let offset_minutes = if raw_zone == "Z" {
        0
    } else {
        let sign = if raw_zone.starts_with('-') { -1 } else { 1 };
        let digits: String = raw_zone[1..].chars().filter(char::is_ascii_digit).collect();
        let (hours, minutes): (i64, i64) = (digits[..2].parse().ok()?, digits[2..].parse().ok()?);
        if hours > 23 || minutes > 59 {
            return None;
        }
        sign * (hours * 60 + minutes)
    };
    // `Date.parse` grammar: month 01-12, day 01-31 (rolling over a short
    // month), hour 24 only as 24:00:00.000.
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || minute > 59 || second > 59 {
        return None;
    }
    if hour > 24 || (hour == 24 && (minute != 0 || second != 0 || millis != 0)) {
        return None;
    }
    let reset = utc_ms(year, month, day, hour, minute, second) + millis - offset_minutes * 60_000;
    let wait = reset - now_ms;
    (wait > 0).then(|| u64::try_from(wait).unwrap_or(u64::MAX).min(max_ms))
}

/// Legacy `parseDayGranularityResetMs`: a quota reset quoted as whole days
/// (`resets in 13 days`), else an absolute datetime, else a year-less stamp.
pub fn parse_day_granularity_reset_ms(
    message: &str,
    max_ms: u64,
    now_ms: i64,
    provider_or_zone: Option<&str>,
) -> Option<u64> {
    if let Some(captures) = DAY_COUNTDOWN.captures(message) {
        if let Some(days) = captures[1].parse::<u64>().ok().filter(|days| *days > 0) {
            return Some(days.saturating_mul(24 * 3_600 * 1_000).min(max_ms));
        }
    }
    parse_iso_datetime_reset_ms(message, max_ms, now_ms, provider_or_zone)
        .or_else(|| parse_month_day_reset_ms(message, max_ms, now_ms))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Outputs the legacy parsers produced for the same inputs, with the clock
    /// fixed (`quota_reset_parsing_oracle.json`, generated with Node).
    #[test]
    fn reset_parsers_match_the_legacy_implementation() {
        let oracle: Value =
            serde_json::from_str(include_str!("quota_reset_parsing_oracle.json")).unwrap();
        let now = oracle["now"].as_i64().unwrap();
        let max = 30 * 24 * 60 * 60 * 1000;
        for case in oracle["zone"].as_array().unwrap() {
            assert_eq!(
                resolve_naive_reset_zone(case[0].as_str().unwrap(), case[1].as_str()),
                case[2].as_str().unwrap(),
                "{case}"
            );
        }
        for case in oracle["parse"].as_array().unwrap() {
            let message = case[0].as_str().unwrap();
            let provider = case[1].as_str();
            assert_eq!(
                parse_day_granularity_reset_ms(message, max, now, provider),
                case[2].as_u64(),
                "day {case}"
            );
            assert_eq!(
                parse_iso_datetime_reset_ms(message, max, now, provider),
                case[3].as_u64(),
                "iso {case}"
            );
            assert_eq!(
                parse_month_day_reset_ms(message, max, now),
                case[4].as_u64(),
                "month-day {case}"
            );
        }
    }
}
