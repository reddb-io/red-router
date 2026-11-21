//! Client-key self-service status, ported from the legacy
//! `src/app/api/v1/me/status/route.ts` and `src/lib/usage/apiKeySelfService.ts`.
//!
//! `GET /v1/me/status` lets a key holding `self:usage` read its own spend and
//! token totals for the current period; `self:account-quota` adds the quota
//! of the provider accounts the key can use. Narrower than the legacy view:
//! the cost is the calendar-month spend from the native ledger (a native key
//! has no legacy per-key budget, which the cutover refuses), usage settled
//! before the cutover stays in the legacy archive, and account quotas come
//! from the stored native quota windows (`session`, `weekly`) instead of a
//! live provider fetch.

use crate::control_plane::{ProviderQuotaView, QuotaWindowView};
use crate::ProxyState;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Map, Value};

/// Legacy `SELF_USAGE_SCOPE`.
pub const SELF_USAGE_SCOPE: &str = "self:usage";
/// Legacy `SELF_ACCOUNT_QUOTA_SCOPE`.
pub const SELF_ACCOUNT_QUOTA_SCOPE: &str = "self:account-quota";

fn auth_error(status: StatusCode) -> Response {
    let message = if status == StatusCode::UNAUTHORIZED {
        "Unauthorized"
    } else {
        "Forbidden"
    };
    (status, Json(json!({"error": message}))).into_response()
}

fn status_failure() -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": "Failed to build API key status"})),
    )
        .into_response()
}

/// Legacy `roundNumber`: `Number(value.toFixed(precision))`.
fn round(value: f64, precision: i32) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    let factor = 10_f64.powi(precision);
    (value * factor).round() / factor
}

fn iso(unix_ms: i64) -> Value {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(unix_ms).map_or(Value::Null, |at| {
        Value::String(at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
    })
}

/// Legacy `getCurrentMonthWindow`: the UTC calendar month around `now`.
pub(crate) fn month_window(now_unix_ms: i64) -> (i64, i64) {
    use chrono::{Datelike, TimeZone};
    let now =
        chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now_unix_ms).unwrap_or_default();
    let start = chrono::Utc
        .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
        .single()
        .unwrap_or_default();
    let (year, month) = if now.month() == 12 {
        (now.year() + 1, 1)
    } else {
        (now.year(), now.month() + 1)
    };
    let next = chrono::Utc
        .with_ymd_and_hms(year, month, 1, 0, 0, 0)
        .single()
        .unwrap_or_default();
    (start.timestamp_millis(), next.timestamp_millis())
}

/// Legacy `quotaWindow` over a native quota window.
fn quota_window(window: &QuotaWindowView) -> Value {
    let remaining = round(window.remaining_percent, 2);
    json!({
        "usedPercentage": round(100.0 - window.remaining_percent, 2),
        "remainingPercentage": remaining,
        "resetAt": window.reset_at_unix_ms.map_or(Value::Null, |at| iso(at as i64)),
    })
}

/// One legacy `accountQuotas` entry for a provider record.
fn account_quota(id: &str, provider: &str, view: Option<&ProviderQuotaView>) -> Value {
    let mut entry = Map::new();
    entry.insert("provider".to_owned(), json!(provider));
    entry.insert("connectionId".to_owned(), json!(id));
    entry.insert("shared".to_owned(), json!(true));
    let mut quotas = Map::new();
    if let Some(view) = view {
        if let Some(session) = &view.session {
            quotas.insert("session".to_owned(), quota_window(session));
        }
        if let Some(weekly) = &view.weekly {
            quotas.insert("weekly".to_owned(), quota_window(weekly));
        }
    }
    if quotas.is_empty() {
        entry.insert("available".to_owned(), json!(false));
        entry.insert("reason".to_owned(), json!("not_available"));
    } else {
        entry.insert("quotas".to_owned(), Value::Object(quotas));
    }
    Value::Object(entry)
}

/// The legacy self-service status body.
pub(crate) fn status_body(
    key_id: &str,
    key_name: &str,
    now_unix_ms: i64,
    amount_microusd: i64,
    tokens: [i64; 5],
    account_quotas: Option<Vec<Value>>,
) -> Value {
    let (period_start, reset_at) = month_window(now_unix_ms);
    let [input, output, cache_read, cache_creation, reasoning] = tokens;
    let mut body = json!({
        "apiKey": {"id": key_id, "name": key_name},
        "usage": {
            "cost": {
                "period": "monthly",
                "currency": "USD",
                "usedUsd": round(amount_microusd as f64 / 1_000_000.0, 6),
                "limitUsd": null,
                "remainingUsd": null,
                "usedPercent": null,
                "warningThreshold": null,
                "resetAt": iso(reset_at),
                "periodStartAt": iso(period_start),
            },
            "tokens": {
                "periodStartAt": iso(period_start),
                "inputTokens": input,
                "outputTokens": output,
                "cacheReadTokens": cache_read,
                "cacheCreationTokens": cache_creation,
                "reasoningTokens": reasoning,
                "totalTokens": input + output + cache_read + cache_creation + reasoning,
            },
        },
    });
    if let Some(quotas) = account_quotas {
        if quotas.len() == 1 {
            body["accountQuota"] = quotas[0].clone();
        }
        body["accountQuotas"] = Value::Array(quotas);
    }
    body
}

/// Legacy `GET /v1/me/status`.
pub async fn me_status(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = state.control_plane.as_ref() else {
        return auth_error(StatusCode::UNAUTHORIZED);
    };
    let policies = match control.client_policies().await {
        Ok(policies) => policies,
        Err(_) => return status_failure(),
    };
    let clients = policies.as_deref().unwrap_or(state.clients.as_ref());
    let Some(policy) = clients.authenticate(&headers, crate::ProviderProtocol::OpenAi) else {
        return auth_error(StatusCode::UNAUTHORIZED);
    };
    // The environment key has no stored identity (legacy "env-key").
    let Some(identity) = policy.identity() else {
        return auth_error(StatusCode::UNAUTHORIZED);
    };
    if !policy.has_scope(SELF_USAGE_SCOPE) {
        return auth_error(StatusCode::FORBIDDEN);
    }
    let Ok(now) = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    ) else {
        return status_failure();
    };
    let (period_start, _) = month_window(now);
    let report = match control
        .key_usage_totals(&identity.tenant_id, &identity.id, period_start, now + 1)
        .await
    {
        Ok(report) => report,
        Err(_) => return status_failure(),
    };
    let account_quotas = if policy.has_scope(SELF_ACCOUNT_QUOTA_SCOPE) {
        let accounts = match control.tenant_quota_accounts(&identity.tenant_id).await {
            Ok(accounts) => accounts,
            Err(_) => return status_failure(),
        };
        let allowed = policy.allowed_provider_ids();
        Some(
            accounts
                .iter()
                .filter(|(id, _, _)| allowed.is_empty() || allowed.contains(id))
                .map(|(id, provider, view)| account_quota(id, provider, view.as_ref()))
                .collect(),
        )
    } else {
        None
    };
    Json(status_body(
        &identity.id,
        &identity.name,
        now,
        report.amount_microusd,
        [
            report.tokens_input,
            report.tokens_output,
            report.tokens_cache_read,
            report.tokens_cache_creation,
            report.tokens_reasoning,
        ],
        account_quotas,
    ))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_period_is_the_utc_calendar_month() {
        // 2026-11-21T07:52:00Z
        let (start, next) = month_window(1_795_334_320_000);
        assert_eq!(iso(start), json!("2026-11-01T00:00:00.000Z"));
        assert_eq!(iso(next), json!("2026-12-01T00:00:00.000Z"));
        let (start, next) = month_window(1_797_000_000_000);
        assert_eq!(iso(start), json!("2026-12-01T00:00:00.000Z"));
        assert_eq!(iso(next), json!("2027-01-01T00:00:00.000Z"));
    }

    #[test]
    fn the_body_has_the_legacy_shape() {
        let body = status_body(
            "key-1",
            "Key",
            1_795_334_320_000,
            1_234_567,
            [10, 20, 3, 4, 5],
            None,
        );
        assert_eq!(body["apiKey"], json!({"id":"key-1","name":"Key"}));
        assert_eq!(body["usage"]["cost"]["usedUsd"], json!(1.234567));
        assert_eq!(body["usage"]["cost"]["limitUsd"], Value::Null);
        assert_eq!(body["usage"]["cost"]["period"], "monthly");
        assert_eq!(body["usage"]["tokens"]["totalTokens"], json!(42));
        assert!(body.get("accountQuotas").is_none());

        let quota = account_quota(
            "acct",
            "codex",
            Some(&ProviderQuotaView {
                provider_id: "acct".to_owned(),
                models: Vec::new(),
                session: Some(QuotaWindowView {
                    remaining_percent: 62.5,
                    reset_at_unix_ms: Some(1_795_334_320_000),
                }),
                weekly: None,
                limit_reached: false,
                observed_at_unix_ms: 0,
                expires_at_unix_ms: 0,
                revision: String::new(),
            }),
        );
        let body = status_body(
            "key-1",
            "Key",
            1_795_334_320_000,
            0,
            [0; 5],
            Some(vec![quota]),
        );
        assert_eq!(
            body["accountQuota"]["quotas"]["session"]["usedPercentage"],
            json!(37.5)
        );
        assert_eq!(body["accountQuotas"].as_array().unwrap().len(), 1);
        let missing = account_quota("acct", "openai", None);
        assert_eq!(missing["available"], json!(false));
        assert_eq!(missing["reason"], json!("not_available"));
    }
}
