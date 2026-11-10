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

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ModelSnapshot {
    pub(crate) model_id: String,
    pub(crate) quota: Snapshot,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Observation {
    pub(crate) aggregate: Snapshot,
    pub(crate) models: Vec<ModelSnapshot>,
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

/// Antigravity exposes quota per model and per weekly model family. Until the
/// routing snapshot carries model-scoped windows, keep the most constrained
/// active window as the provider score and only mark the provider exhausted
/// when every known bucket in either enforced window is empty. This preserves
/// fallback ordering without turning one exhausted model family into a global
/// hard stop.
pub(crate) fn parse_antigravity(
    user_quota: &Value,
    quota_summary: Option<&Value>,
) -> Result<Snapshot, &'static str> {
    parse_antigravity_observation(user_quota, quota_summary)
        .map(|observation| observation.aggregate)
}

pub(crate) fn parse_antigravity_observation(
    user_quota: &Value,
    quota_summary: Option<&Value>,
) -> Result<Observation, &'static str> {
    let root = object(user_quota).ok_or("invalid Antigravity quota response")?;
    let buckets = root
        .get("buckets")
        .and_then(Value::as_array)
        .ok_or("Antigravity quota response has no buckets")?;
    if buckets.len() > 1_024 {
        return Err("Antigravity quota response has too many buckets");
    }
    let mut session_windows = Vec::new();
    let mut model_windows = Vec::new();
    for value in buckets {
        let Some(bucket) = object(value) else {
            continue;
        };
        let Some(model_id) = field(bucket, "model_id", "modelId").and_then(Value::as_str) else {
            continue;
        };
        if model_id.is_empty() || model_id.len() > 256 || model_id.chars().any(char::is_control) {
            continue;
        }
        if let Some(window) = antigravity_window(bucket)? {
            session_windows.push(window);
            model_windows.push((model_id.to_owned(), window));
        }
    }

    let mut weekly_windows = Vec::new();
    let mut weekly_family_windows = Vec::new();
    let mut summary_session_windows = Vec::new();
    if let Some(summary) = quota_summary {
        let summary = object(summary).ok_or("invalid Antigravity quota summary")?;
        let groups = summary
            .get("groups")
            .and_then(Value::as_array)
            .or_else(|| {
                summary
                    .get("quotaSummary")
                    .and_then(object)
                    .and_then(|value| value.get("groups"))
                    .and_then(Value::as_array)
            })
            .map(Vec::as_slice)
            .unwrap_or_default();
        if groups.len() > 256 {
            return Err("Antigravity quota summary has too many groups");
        }
        for value in groups {
            let Some(group) = object(value) else {
                continue;
            };
            let group_label = group
                .get("displayName")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let buckets = group
                .get("buckets")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            if buckets.len() > 256 {
                return Err("Antigravity quota summary has too many buckets");
            }
            for value in buckets {
                let Some(bucket) = object(value) else {
                    continue;
                };
                let Some(window) = antigravity_window(bucket)? else {
                    continue;
                };
                let label = format!(
                    "{} {}",
                    bucket
                        .get("bucketId")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    bucket
                        .get("displayName")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                );
                if label
                    .split(|character: char| !character.is_ascii_alphanumeric())
                    .any(|part| part.eq_ignore_ascii_case("weekly"))
                {
                    weekly_windows.push(window);
                    weekly_family_windows.push((group_label.clone(), window));
                } else {
                    summary_session_windows.push(window);
                }
            }
        }
    }
    if session_windows.is_empty() {
        session_windows = summary_session_windows;
    }
    if session_windows.is_empty() && weekly_windows.is_empty() {
        return Err("Antigravity quota response has no supported windows");
    }
    let session_exhausted = all_exhausted(&session_windows);
    let weekly_exhausted = all_exhausted(&weekly_windows);
    let aggregate = Snapshot {
        session: most_constrained(&session_windows),
        weekly: most_constrained(&weekly_windows),
        limit_reached: session_exhausted || weekly_exhausted,
    };
    let models = model_windows
        .into_iter()
        .map(|(model_id, session)| {
            let matching_weekly = weekly_family_windows
                .iter()
                .filter_map(|(family, window)| {
                    family_matches_model(family, &model_id).then_some(*window)
                })
                .collect::<Vec<_>>();
            let weekly = most_constrained(&matching_weekly);
            ModelSnapshot {
                model_id,
                quota: Snapshot {
                    session: Some(session),
                    weekly,
                    limit_reached: exhausted(Some(session)) || exhausted(weekly),
                },
            }
        })
        .collect();
    Ok(Observation { aggregate, models })
}

fn family_matches_model(family: &str, model_id: &str) -> bool {
    let family = family.to_ascii_lowercase();
    let model = model_id.to_ascii_lowercase();
    if model.contains("gemini") {
        return family.contains("gemini");
    }
    if model.contains("claude") {
        return family.contains("claude");
    }
    if model.contains("gpt") || model.contains("openai") || model.contains("codex") {
        return family.contains("gpt") || family.contains("openai") || family.contains("codex");
    }
    false
}

fn antigravity_window(bucket: &Map<String, Value>) -> Result<Option<Window>, &'static str> {
    if bucket
        .get("disabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Ok(None);
    }
    let Some(value) = field(bucket, "remaining_fraction", "remainingFraction") else {
        return Ok(None);
    };
    let fraction = finite_number(Some(value))?;
    if !(0.0..=1.0).contains(&fraction) {
        return Err("Antigravity quota fraction is out of range");
    }
    Ok(Some(Window {
        remaining_percent: fraction * 100.0,
        reset_at_unix_ms: optional_timestamp(field(bucket, "reset_time", "resetTime"))?,
    }))
}

fn most_constrained(windows: &[Window]) -> Option<Window> {
    windows.iter().copied().min_by(|left, right| {
        left.remaining_percent
            .total_cmp(&right.remaining_percent)
            .then_with(|| {
                left.reset_at_unix_ms
                    .unwrap_or(u64::MAX)
                    .cmp(&right.reset_at_unix_ms.unwrap_or(u64::MAX))
            })
    })
}

fn all_exhausted(windows: &[Window]) -> bool {
    !windows.is_empty()
        && windows
            .iter()
            .all(|window| window.remaining_percent <= f64::EPSILON)
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

    #[test]
    fn parses_antigravity_model_and_weekly_family_windows() {
        let observation = parse_antigravity_observation(
            &json!({"buckets":[
                {"modelId":"gemini-3.1-pro","remainingFraction":0.75,"resetTime":"2099-09-10T14:00:00Z"},
                {"modelId":"gemini-3.1-flash","remainingFraction":"0.25","resetTime":"2099-09-10T13:00:00Z"},
                {"modelId":"disabled","remainingFraction":0.0,"disabled":true}
            ]}),
            Some(&json!({"quotaSummary":{"groups":[
                {"displayName":"Gemini Models","buckets":[
                    {"bucketId":"gemini-5h","remainingFraction":0.8},
                    {"bucketId":"gemini-weekly","displayName":"Weekly","remainingFraction":0.6,"resetTime":"2099-09-16T13:00:00Z"}
                ]},
                {"displayName":"Claude and GPT models","buckets":[
                    {"bucketId":"claude-gpt-weekly","remainingFraction":0.4,"resetTime":"2099-09-16T12:00:00Z"}
                ]}
            ]}})),
        )
        .unwrap();
        let snapshot = observation.aggregate;
        assert_eq!(snapshot.session.unwrap().remaining_percent, 25.0);
        assert_eq!(snapshot.weekly.unwrap().remaining_percent, 40.0);
        assert!(!snapshot.limit_reached);
        assert_eq!(observation.models.len(), 2);
        assert_eq!(observation.models[0].model_id, "gemini-3.1-pro");
        assert_eq!(
            observation.models[0]
                .quota
                .session
                .unwrap()
                .remaining_percent,
            75.0
        );
        assert_eq!(
            observation.models[0]
                .quota
                .weekly
                .unwrap()
                .remaining_percent,
            60.0
        );
        assert_eq!(
            observation.models[1]
                .quota
                .session
                .unwrap()
                .remaining_percent,
            25.0
        );
    }

    #[test]
    fn antigravity_only_marks_a_window_exhausted_when_all_known_buckets_are_empty() {
        let partial = parse_antigravity(
            &json!({"buckets":[
                {"modelId":"first","remainingFraction":0},
                {"modelId":"second","remainingFraction":0.5}
            ]}),
            None,
        )
        .unwrap();
        assert_eq!(partial.session.unwrap().remaining_percent, 0.0);
        assert!(!partial.limit_reached);

        let exhausted = parse_antigravity(
            &json!({"buckets":[
                {"modelId":"first","remainingFraction":0},
                {"modelId":"second","remainingFraction":0}
            ]}),
            None,
        )
        .unwrap();
        assert!(exhausted.limit_reached);
    }
}
