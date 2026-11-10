use serde_json::{Map, Value};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Window {
    pub(crate) remaining_percent: f64,
    pub(crate) reset_at_unix_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Snapshot {
    pub(crate) session: Option<Window>,
    pub(crate) weekly: Option<Window>,
    pub(crate) limit_reached: bool,
}

pub(crate) fn parse_codex(value: &Value, now_unix_ms: u64) -> Result<Snapshot, &'static str> {
    let root = object(value).ok_or("invalid Codex quota response")?;
    let rate_limit = field(root, "rate_limit", "rateLimit")
        .and_then(object)
        .ok_or("Codex quota response has no rate limit")?;
    let session = field(rate_limit, "primary_window", "primaryWindow")
        .and_then(object)
        .map(|window| codex_window(window, now_unix_ms))
        .transpose()?;
    let weekly = field(rate_limit, "secondary_window", "secondaryWindow")
        .and_then(object)
        .map(|window| codex_window(window, now_unix_ms))
        .transpose()?;
    if session.is_none() && weekly.is_none() {
        return Err("Codex quota response has no supported windows");
    }
    let limit_reached = field(rate_limit, "limit_reached", "limitReached")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || exhausted(session)
        || exhausted(weekly);
    Ok(Snapshot {
        session,
        weekly,
        limit_reached,
    })
}

pub(crate) fn parse_claude(value: &Value) -> Result<Snapshot, &'static str> {
    let root = object(value).ok_or("invalid Claude quota response")?;
    let mut session = root
        .get("five_hour")
        .and_then(object)
        .map(claude_legacy_window)
        .transpose()?;
    let mut weekly = root
        .get("seven_day")
        .and_then(object)
        .map(claude_legacy_window)
        .transpose()?;
    let mut active_limit = false;
    if let Some(limits) = root.get("limits").and_then(Value::as_array) {
        if limits.len() > 256 {
            return Err("Claude quota response has too many limits");
        }
        for value in limits {
            let Some(limit) = object(value) else {
                continue;
            };
            let target = match limit.get("kind").and_then(Value::as_str) {
                Some("session") => &mut session,
                Some("weekly_all") => &mut weekly,
                _ => continue,
            };
            *target = Some(claude_current_window(limit)?);
            active_limit |= field(limit, "isActive", "is_active")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        }
    }
    if session.is_none() && weekly.is_none() {
        return Err("Claude quota response has no supported windows");
    }
    Ok(Snapshot {
        session,
        weekly,
        limit_reached: active_limit || exhausted(session) || exhausted(weekly),
    })
}

fn codex_window(window: &Map<String, Value>, now_unix_ms: u64) -> Result<Window, &'static str> {
    let used = finite_number(field(window, "used_percent", "usedPercent"))?;
    let reset_at_unix_ms = if let Some(value) = field(window, "reset_at", "resetAt") {
        Some(epoch_milliseconds(value)?)
    } else if let Some(value) = field(window, "reset_after_seconds", "resetAfterSeconds") {
        let seconds = non_negative_number(Some(value))?;
        let milliseconds = (seconds * 1_000.0).round();
        if milliseconds > u64::MAX as f64 {
            return Err("invalid Codex quota reset");
        }
        Some(now_unix_ms.saturating_add(milliseconds as u64))
    } else {
        None
    };
    Ok(Window {
        remaining_percent: remaining(used)?,
        reset_at_unix_ms,
    })
}

fn claude_legacy_window(window: &Map<String, Value>) -> Result<Window, &'static str> {
    let used = finite_number(window.get("utilization"))?;
    Ok(Window {
        remaining_percent: remaining(used)?,
        reset_at_unix_ms: optional_timestamp(window.get("resets_at"))?,
    })
}

fn claude_current_window(limit: &Map<String, Value>) -> Result<Window, &'static str> {
    let used = ["percent", "utilization", "percentage"]
        .into_iter()
        .find_map(|name| limit.get(name))
        .ok_or("Claude quota limit has no percentage")?;
    let reset = ["resetsAt", "resets_at", "resetAt", "reset_at"]
        .into_iter()
        .find_map(|name| limit.get(name));
    Ok(Window {
        remaining_percent: remaining(finite_number(Some(used))?)?,
        reset_at_unix_ms: optional_timestamp(reset)?,
    })
}

fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn field<'a>(object: &'a Map<String, Value>, snake: &str, camel: &str) -> Option<&'a Value> {
    object.get(snake).or_else(|| object.get(camel))
}

fn finite_number(value: Option<&Value>) -> Result<f64, &'static str> {
    let value = value.ok_or("quota percentage is missing")?;
    let number = value
        .as_f64()
        .or_else(|| value.as_str().and_then(|value| value.parse::<f64>().ok()))
        .filter(|value| value.is_finite())
        .ok_or("invalid quota percentage")?;
    Ok(number)
}

fn non_negative_number(value: Option<&Value>) -> Result<f64, &'static str> {
    finite_number(value)
        .and_then(|value| (value >= 0.0).then_some(value).ok_or("invalid quota reset"))
}

fn remaining(used: f64) -> Result<f64, &'static str> {
    if !(0.0..=100.0).contains(&used) {
        return Err("quota percentage is out of range");
    }
    Ok((100.0 - used).max(0.0))
}

fn epoch_milliseconds(value: &Value) -> Result<u64, &'static str> {
    let raw = non_negative_number(Some(value))?;
    let milliseconds = if raw >= 1_000_000_000_000.0 {
        raw
    } else {
        raw * 1_000.0
    };
    if milliseconds > u64::MAX as f64 {
        return Err("invalid quota reset");
    }
    Ok(milliseconds.round() as u64)
}

fn optional_timestamp(value: Option<&Value>) -> Result<Option<u64>, &'static str> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    if value.is_number() {
        return epoch_milliseconds(value).map(Some);
    }
    let text = value.as_str().ok_or("invalid quota reset")?;
    let parsed = OffsetDateTime::parse(text, &Rfc3339).map_err(|_| "invalid quota reset")?;
    let milliseconds = parsed.unix_timestamp_nanos() / 1_000_000;
    u64::try_from(milliseconds)
        .map(Some)
        .map_err(|_| "invalid quota reset")
}

fn exhausted(window: Option<Window>) -> bool {
    window.is_some_and(|window| window.remaining_percent <= f64::EPSILON)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_codex_dual_window_and_relative_reset() {
        let snapshot = parse_codex(
            &json!({"rate_limit":{
                "primary_window":{"used_percent":80,"reset_after_seconds":60},
                "secondary_window":{"used_percent":"40","reset_at":2_000_000_000},
                "limit_reached":false
            }}),
            1_000,
        )
        .unwrap();
        assert_eq!(snapshot.session.unwrap().remaining_percent, 20.0);
        assert_eq!(snapshot.session.unwrap().reset_at_unix_ms, Some(61_000));
        assert_eq!(snapshot.weekly.unwrap().remaining_percent, 60.0);
        assert_eq!(
            snapshot.weekly.unwrap().reset_at_unix_ms,
            Some(2_000_000_000_000)
        );
        assert!(!snapshot.limit_reached);
    }

    #[test]
    fn parses_claude_current_limits_over_legacy_windows() {
        let snapshot = parse_claude(&json!({
            "five_hour":{"utilization":90,"resets_at":"2099-09-10T14:00:00Z"},
            "seven_day":{"utilization":20,"resets_at":"2099-09-16T13:00:00Z"},
            "limits":[
                {"kind":"session","percent":30,"resetsAt":"2099-09-10T15:00:00Z","isActive":false},
                {"kind":"weekly_scoped","percent":100,"isActive":true}
            ]
        }))
        .unwrap();
        assert_eq!(snapshot.session.unwrap().remaining_percent, 70.0);
        assert_eq!(snapshot.weekly.unwrap().remaining_percent, 80.0);
        assert!(!snapshot.limit_reached);
    }

    #[test]
    fn rejects_missing_or_out_of_range_windows() {
        assert!(parse_codex(&json!({"rate_limit":{}}), 0).is_err());
        assert!(parse_codex(
            &json!({"rate_limit":{"primary_window":{"used_percent":101}}}),
            0
        )
        .is_err());
        assert!(parse_claude(&json!({"limits":[]})).is_err());
    }
}
