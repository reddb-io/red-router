//! Node-level daily quota reset clock, ported from the legacy
//! `open-sse/services/dailyQuotaReset.ts`, plus the daily-quota text checks
//! and host-midnight estimate of `open-sse/services/accountFallback.ts`.
//!
//! A compatible-provider node may declare an IANA timezone and a local hour
//! at which its daily quota resets. A TPD ("tokens per day") 429 cools down
//! until the `Reset` header or that clock; other daily-quota text uses the
//! clock or, unconfigured, the host's next midnight.

// `nodeDailyResetConfigured` and `parseTpdLimitFromText` keep their legacy
// counterparts' names for the port index; only the tests read them today.
#![allow(dead_code)]

use chrono::{Datelike, LocalResult, NaiveDate, TimeZone};
use chrono_tz::Tz;
use regex::Regex;
use std::sync::LazyLock;

const DAY_MS: u64 = 24 * 60 * 60 * 1_000;

/// An IANA timezone as the legacy `Intl.DateTimeFormat` check accepts it
/// (surrounding whitespace ignored; names are matched case-sensitively).
pub(crate) fn parse_time_zone(timezone: &str) -> Option<Tz> {
    let timezone = timezone.trim();
    if timezone.is_empty() {
        return None;
    }
    timezone.parse::<Tz>().ok()
}

/// Legacy `isValidIanaTimeZone`.
pub(crate) fn is_valid_iana_time_zone(timezone: &str) -> bool {
    parse_time_zone(timezone).is_some()
}

/// Legacy `isValidResetHour`: an integer hour from 0 to 23.
pub(crate) fn is_valid_reset_hour(hour: i64) -> bool {
    (0..=23).contains(&hour)
}

/// Legacy `nodeDailyResetConfigured`.
pub(crate) fn node_daily_reset_configured(timezone: Option<&str>, hour: Option<i64>) -> bool {
    timezone.is_some_and(is_valid_iana_time_zone) && hour.is_some_and(is_valid_reset_hour)
}

/// Epoch milliseconds of `hour:00:00` local time on `date`. An ambiguous
/// wall time (DST fall-back) takes its earlier instant, as the legacy offset
/// iteration does; a wall time inside a DST gap walks forward minute by
/// minute to the first one that exists.
fn local_hour_to_utc_ms(zone: Tz, date: NaiveDate, hour: u32) -> Option<i64> {
    let mut date = date;
    let mut minute_of_day = hour * 60;
    for _ in 0..=24 * 60 {
        let (wall_hour, minute) = (minute_of_day / 60, minute_of_day % 60);
        match zone.with_ymd_and_hms(date.year(), date.month(), date.day(), wall_hour, minute, 0) {
            LocalResult::Single(instant) => return Some(instant.timestamp_millis()),
            LocalResult::Ambiguous(earliest, _) => return Some(earliest.timestamp_millis()),
            LocalResult::None => {
                minute_of_day += 1;
                if minute_of_day >= 24 * 60 {
                    minute_of_day -= 24 * 60;
                    date = date.succ_opt()?;
                }
            }
        }
    }
    None
}

/// Legacy `nextDailyResetAtMs`: the next local `hour:00:00` in `zone`
/// strictly after `now_ms`; landing exactly on it returns the next cycle.
pub(crate) fn next_daily_reset_at_ms(zone: Tz, hour: u32, now_ms: i64) -> Option<i64> {
    let today = zone.timestamp_millis_opt(now_ms).single()?.date_naive();
    let next = local_hour_to_utc_ms(zone, today, hour)?;
    if next > now_ms {
        return Some(next);
    }
    local_hour_to_utc_ms(zone, today.succ_opt()?, hour)
}

/// Legacy `nextConfiguredResetMs`: milliseconds until the node's next reset,
/// or none when the clock is absent or invalid.
pub(crate) fn next_configured_reset_ms(
    timezone: Option<&str>,
    hour: Option<i64>,
    now_ms: i64,
) -> Option<u64> {
    let zone = timezone.and_then(parse_time_zone)?;
    let hour = hour.filter(|hour| is_valid_reset_hour(*hour))?;
    let next = next_daily_reset_at_ms(zone, u32::try_from(hour).ok()?, now_ms)?;
    u64::try_from(next.checked_sub(now_ms)?)
        .ok()
        .filter(|ms| *ms > 0)
}

/// Legacy `parseTpdLimitFromText`.
pub(crate) fn parse_tpd_limit_from_text(text: &str) -> Option<u64> {
    static LIMIT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)limit:\s*(\d+)").expect("static pattern"));
    LIMIT.captures(text)?.get(1)?.as_str().parse().ok()
}

/// Legacy `isTpdRateLimit`.
pub(crate) fn is_tpd_rate_limit(text: &str) -> bool {
    text.to_lowercase().contains("tpd rate limit")
}

/// Legacy `isDailyQuotaExhausted`.
pub(crate) fn is_daily_quota_exhausted(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "today's quota",
        "daily quota",
        "try again tomorrow",
        "tpd rate limit",
    ]
    .iter()
    .any(|signal| lower.contains(signal))
}

/// Legacy `resolveTpdCooldownMs`: a TPD 429 cools down until the `Reset`
/// header when it is ahead, else until the node clock; with neither the
/// caller keeps its short cooldown instead of guessing midnight.
pub(crate) fn resolve_tpd_cooldown_ms(
    text: &str,
    timezone: Option<&str>,
    hour: Option<i64>,
    now_ms: i64,
    header_reset_at_ms: Option<i64>,
) -> Option<u64> {
    if !is_tpd_rate_limit(text) {
        return None;
    }
    if let Some(reset) = header_reset_at_ms.filter(|reset| *reset > now_ms) {
        return u64::try_from(reset - now_ms).ok();
    }
    next_configured_reset_ms(timezone, hour, now_ms)
}

/// Legacy `getMsUntilTomorrow`: milliseconds until the host's next local
/// midnight, read from `TZ` (UTC when unset), capped at 24 hours on a
/// DST-shifted day.
pub(crate) fn ms_until_host_midnight(now_ms: i64) -> u64 {
    let zone = std::env::var("TZ")
        .ok()
        .and_then(|timezone| parse_time_zone(&timezone))
        .unwrap_or(Tz::UTC);
    next_daily_reset_at_ms(zone, 0, now_ms)
        .and_then(|next| u64::try_from(next - now_ms).ok())
        .filter(|ms| *ms > 0 && *ms <= 25 * 60 * 60 * 1_000)
        .unwrap_or(DAY_MS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn utc_ms(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
        Utc.with_ymd_and_hms(year, month, day, hour, minute, 0)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn zones_and_hours_are_validated_like_the_legacy_clock() {
        assert!(is_valid_iana_time_zone(" America/Sao_Paulo "));
        assert!(is_valid_iana_time_zone("UTC"));
        assert!(!is_valid_iana_time_zone("Mars/Base"));
        assert!(!is_valid_iana_time_zone("  "));
        assert!(is_valid_reset_hour(0) && is_valid_reset_hour(23));
        assert!(!is_valid_reset_hour(24) && !is_valid_reset_hour(-1));
        assert!(node_daily_reset_configured(Some("Asia/Tokyo"), Some(9)));
        assert!(!node_daily_reset_configured(Some("Asia/Tokyo"), None));
    }

    #[test]
    fn the_next_reset_is_strictly_ahead_in_local_time() {
        let zone: Tz = "America/Sao_Paulo".parse().unwrap();
        // 09:00 local (UTC-3): today's 08:00 has passed, so tomorrow's.
        let now = utc_ms(2026, 11, 19, 12, 0);
        assert_eq!(
            next_daily_reset_at_ms(zone, 8, now),
            Some(utc_ms(2026, 11, 20, 11, 0))
        );
        // Landing exactly on the reset returns the following cycle.
        let at_reset = utc_ms(2026, 11, 20, 11, 0);
        assert_eq!(
            next_daily_reset_at_ms(zone, 8, at_reset),
            Some(utc_ms(2026, 11, 21, 11, 0))
        );
    }

    #[test]
    fn dst_gaps_walk_forward_and_ambiguous_hours_take_the_earlier_instant() {
        let zone: Tz = "America/New_York".parse().unwrap();
        // 2026-03-08 02:00 does not exist; the first wall time is 03:00 EDT.
        assert_eq!(
            next_daily_reset_at_ms(zone, 2, utc_ms(2026, 3, 8, 5, 0)),
            Some(utc_ms(2026, 3, 8, 7, 0))
        );
        // 2026-11-01 01:00 happens twice; the EDT instant comes first.
        assert_eq!(
            next_daily_reset_at_ms(zone, 1, utc_ms(2026, 11, 1, 4, 0)),
            Some(utc_ms(2026, 11, 1, 5, 0))
        );
    }

    #[test]
    fn tpd_cooldowns_prefer_the_header_then_the_node_clock() {
        let now = utc_ms(2026, 11, 19, 12, 0);
        let text = "TPD rate limit reached for model x, limit: 500000";
        assert_eq!(parse_tpd_limit_from_text(text), Some(500_000));
        assert_eq!(
            resolve_tpd_cooldown_ms(text, Some("UTC"), Some(0), now, Some(now + 5_000)),
            Some(5_000)
        );
        assert_eq!(
            resolve_tpd_cooldown_ms(text, Some("UTC"), Some(0), now, Some(now - 1)),
            Some(12 * 60 * 60 * 1_000)
        );
        assert_eq!(resolve_tpd_cooldown_ms(text, None, None, now, None), None);
        assert_eq!(
            resolve_tpd_cooldown_ms("rate limited", Some("UTC"), Some(0), now, None),
            None
        );
    }

    #[test]
    fn daily_quota_text_and_the_host_midnight_estimate() {
        assert!(is_daily_quota_exhausted("You exceeded today's quota"));
        assert!(is_daily_quota_exhausted("Please try again tomorrow"));
        assert!(!is_daily_quota_exhausted("Rate limit exceeded"));
        let wait = ms_until_host_midnight(utc_ms(2026, 11, 19, 12, 0));
        assert!(wait > 0 && wait <= DAY_MS);
    }
}
