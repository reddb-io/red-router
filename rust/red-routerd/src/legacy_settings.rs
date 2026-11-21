//! Inventory of the legacy `key_value` settings namespace for the offline
//! cutover. The legacy `getSettings()` starts from a defaults object
//! (`legacy_settings_defaults.json`, written by
//! `scripts/research/legacy-settings-defaults.ts`) and applies each stored row
//! on top, skipping keys that start with `_`. Every stored row is classified:
//!
//! - at its default: the row changes nothing;
//! - consumed: another importer reads and migrates (or refuses) it;
//! - dashboard: a personal dashboard preference with no gateway behavior,
//!   dropped;
//! - diagnostic: an opt-in diagnostic that only adds log lines, dropped;
//! - equivalent: a value the native gateway already behaves like, dropped;
//! - imported: migrated by this importer onto native runtime settings;
//! - refused: a non-default value with no native equivalent yet, or a key
//!   this inventory does not know. Each refusal blocks the cutover.

use serde::Serialize;
use serde_json::Value;
use sqlx::{sqlite::SqliteConnectOptions, ConnectOptions, Connection, Row};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;

#[derive(serde::Deserialize)]
struct Snapshot {
    defaults: BTreeMap<String, Value>,
    resilience_defaults: Value,
    model_lockout_defaults: Value,
}

static SNAPSHOT: LazyLock<Snapshot> = LazyLock::new(|| {
    serde_json::from_str::<Snapshot>(include_str!("legacy_settings_defaults.json"))
        .expect("the legacy settings defaults snapshot is valid JSON")
});
static DEFAULTS: LazyLock<&'static BTreeMap<String, Value>> = LazyLock::new(|| &SNAPSHOT.defaults);

/// The native settings a legacy `resilienceSettings` row maps onto: the
/// connection cooldown and provider breaker profiles per account category and
/// the quota preflight cutoff (`StoredRuntimeSettings` without its revision).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ResilienceImport {
    pub quota_preflight_enabled: bool,
    pub quota_preflight_threshold_percent: i64,
    /// `(base_ms, retry_hints, max_backoff_steps)` for OAuth, then API keys.
    pub cooldown: [(i64, bool, i64); 2],
    /// `(failure, degradation, reset_ms)` for OAuth, then API keys.
    pub breaker: [(i64, i64, i64); 2],
}

/// Native ceilings narrower than the legacy normalizers' ranges.
const NATIVE_MAX_COOLDOWN_BASE_MS: i64 = 300_000;
const NATIVE_MAX_BACKOFF_STEPS: i64 = 16;

/// Legacy `toInteger`: a number, or a numeric non-blank string, truncated and
/// clamped; anything else takes the fallback.
fn to_integer(value: Option<&Value>, fallback: i64, min: i64, max: i64) -> i64 {
    let parsed = match value {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(text)) if !text.trim().is_empty() => text.trim().parse::<f64>().ok(),
        _ => None,
    };
    match parsed.filter(|number| number.is_finite()) {
        Some(number) => (number.trunc() as i64).clamp(min, max),
        None => fallback,
    }
}

/// Legacy `toBoolean`: only a boolean overrides the fallback.
fn to_boolean(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

/// A stored section merged over its default the way the legacy normalizers
/// fill missing fields; objects merge recursively, other values replace.
fn merged(default: &Value, stored: &Value) -> Value {
    match (default, stored) {
        (Value::Object(base), Value::Object(patch)) => {
            let mut out = base.clone();
            for (key, value) in patch {
                let next = match base.get(key) {
                    Some(existing) => merged(existing, value),
                    None => value.clone(),
                };
                out.insert(key.clone(), next);
            }
            Value::Object(out)
        }
        (_, stored) => stored.clone(),
    }
}

/// The connection cooldown ceiling a legacy `modelLockout` row resolves to
/// (`resolveModelLockoutSettings`: the max cooldown, clamped to 5 s-1 h, and
/// never below the clamped base).
fn model_lockout_ceiling(raw: &str) -> Result<u64, &'static str> {
    let default = &SNAPSHOT.model_lockout_defaults;
    let stored = merged(default, &parse_value(raw));
    let integer = |field: &str, fallback: u64, min: u64, max: u64| {
        let parsed = match stored.get(field) {
            Some(Value::Number(number)) => number.as_f64(),
            Some(Value::String(text)) => text.trim().parse::<f64>().ok(),
            _ => None,
        };
        match parsed.filter(|number| number.is_finite()) {
            Some(number) => (number.trunc().max(0.0) as u64).clamp(min, max),
            None => fallback,
        }
    };
    let base = integer("baseCooldownMs", 120_000, 5_000, 600_000);
    let maximum = integer("maxCooldownMs", 1_800_000, 5_000, 3_600_000);
    Ok(maximum.max(base))
}

/// The opt-in combo model lockout policy a legacy `modelLockout` row resolves
/// to (`resolveModelLockoutSettings`: `toBoolean`, `toNumberArray` over 100-599
/// with the default list when empty, the base clamped to 5 s-10 min).
/// `maxBackoffSteps` is not read by the legacy lockouts.
fn legacy_model_lockout_policy(raw: &str) -> crate::availability::ModelLockoutPolicy {
    let value = parse_value(raw);
    let mut policy = crate::availability::ModelLockoutPolicy::default();
    let boolean = |field: &str, fallback: bool| match value.get(field) {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => text == "true" || text == "1",
        _ => fallback,
    };
    policy.enabled = boolean("enabled", policy.enabled);
    policy.use_exponential_backoff =
        boolean("useExponentialBackoff", policy.use_exponential_backoff);
    if let Some(Value::Array(codes)) = value.get("errorCodes") {
        let codes: Vec<u16> = codes
            .iter()
            .filter_map(|code| match code {
                Value::Number(number) => number.as_f64(),
                Value::String(text) => text.trim().parse::<f64>().ok(),
                _ => None,
            })
            .filter(|code| code.fract() == 0.0 && (100.0..=599.0).contains(code))
            .map(|code| code as u16)
            .collect();
        if !codes.is_empty() {
            policy.error_codes = codes;
        }
    }
    let base = match value.get("baseCooldownMs") {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(text)) => text.trim().parse::<f64>().ok(),
        _ => None,
    };
    if let Some(base) = base.filter(|base| base.is_finite()) {
        policy.base_cooldown_ms = (base.trunc().max(0.0) as u64).clamp(5_000, 600_000);
    }
    policy
}

/// Legacy `isClaudeFastModeEnabled` and `getClaudeFastModeSupportedModels`:
/// a boolean, or `{enabled, supportedModels}`; the default model list is
/// stored as an empty list.
fn legacy_claude_fast_mode(raw: &str) -> crate::global_settings::ClaudeFastMode {
    let value = parse_value(raw);
    let enabled = match &value {
        Value::Bool(flag) => *flag,
        Value::Object(record) => record.get("enabled") == Some(&Value::Bool(true)),
        _ => false,
    };
    let mut supported_models: Vec<String> = value
        .get("supportedModels")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if supported_models == crate::global_settings::CLAUDE_FAST_MODE_DEFAULT_MODELS {
        supported_models.clear();
    }
    crate::global_settings::ClaudeFastMode {
        enabled,
        supported_models,
    }
}

/// Legacy `resolveCodexGlobalFastServiceTier` over the `codexServiceTier` row,
/// or the early `codexFastServiceTier` flag when that row is not a flag or
/// an object, plus the tier `migrateCodexConnectionDefaultsFromLegacySettings`
/// gives connections when its marker is missing.
fn legacy_codex_service_tier(rows: &[(String, String)]) -> crate::codex_request::CodexServiceTier {
    let row = |name: &str| {
        rows.iter()
            .find(|(key, _)| key == name)
            .map(|(_, raw)| parse_value(raw))
    };
    let raw = row("codexServiceTier");
    let mut tier = crate::codex_request::CodexServiceTier::default();
    match &raw {
        Some(Value::Bool(enabled)) => tier.enabled = *enabled,
        Some(Value::Object(record)) => {
            tier.enabled = record.get("enabled") == Some(&Value::Bool(true));
            tier.tier = record
                .get("tier")
                .and_then(Value::as_str)
                .map(|value| value.trim().to_ascii_lowercase())
                .filter(|value| matches!(value.as_str(), "default" | "priority" | "flex"));
            let models: Vec<String> = record
                .get("supportedModels")
                .and_then(Value::as_array)
                .map(|models| {
                    models
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|model| !model.is_empty())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            if models != crate::codex_request::FAST_TIER_DEFAULT_MODELS {
                tier.supported_models = models;
            }
        }
        _ => tier.enabled = row("codexFastServiceTier") == Some(Value::Bool(true)),
    }
    // Legacy parseLegacyCodexServiceTier: only an enabled object (or its JSON
    // text) without a non-priority tier counts as the old Fast switch.
    let legacy_fast = |value: &Value| {
        value.get("enabled") == Some(&Value::Bool(true))
            && value
                .get("tier")
                .and_then(Value::as_str)
                .map(|tier| tier.trim().to_ascii_lowercase())
                .is_none_or(|tier| matches!(tier.as_str(), "" | "priority" | "fast"))
    };
    let legacy_fast = match &raw {
        Some(Value::String(text)) => serde_json::from_str::<Value>(text)
            .ok()
            .is_some_and(|value| legacy_fast(&value)),
        Some(value) => legacy_fast(value),
        None => false,
    };
    if legacy_fast && row("codexConnectionDefaultsMigrationV1").is_none() {
        tier.unmigrated_connection_tier = Some("priority".to_owned());
    }
    tier
}

/// Legacy `resolveResilienceSettings(...).waitForCooldown`: the stored
/// `resilienceSettings.waitForCooldown` fields over the fallback built from
/// `requestRetry` and `maxRetryIntervalSec`, whose settings defaults (3 and
/// 30) apply when the rows are absent.
pub(crate) fn legacy_wait_for_cooldown(
    rows: &[(String, String)],
) -> crate::cooldown_retry::WaitForCooldown {
    let row = |name: &str| {
        rows.iter()
            .find(|(key, _)| key == name)
            .map(|(_, raw)| parse_value(raw))
    };
    let fallback_retries =
        row("requestRetry").map_or(3, |value| to_integer(Some(&value), 5, 0, 10));
    let fallback_wait_sec =
        row("maxRetryIntervalSec").map_or(30, |value| to_integer(Some(&value), 90, 0, 300));
    let stored = row("resilienceSettings")
        .and_then(|settings| settings.get("waitForCooldown").cloned())
        .unwrap_or(Value::Null);
    let wait_sec = to_integer(stored.get("maxRetryWaitSec"), fallback_wait_sec, 0, 300);
    let retries = to_integer(stored.get("maxRetries"), fallback_retries, 0, 10);
    let budget_ms = to_integer(stored.get("budgetMs"), 300_000, wait_sec * 1_000, 300_000);
    let enabled = match stored.get("enabled") {
        Some(Value::Bool(enabled)) => *enabled,
        _ => fallback_retries > 0 && fallback_wait_sec > 0,
    };
    crate::cooldown_retry::WaitForCooldown {
        enabled: enabled && retries > 0 && wait_sec > 0,
        max_retries: u32::try_from(retries).unwrap_or_default(),
        max_retry_wait_sec: u32::try_from(wait_sec).unwrap_or_default(),
        budget_ms: u64::try_from(budget_ms).unwrap_or_default(),
    }
}

/// Legacy `normalizeComboCooldownWaitSettings` over the stored
/// `resilienceSettings.comboCooldownWait` (the fallback is the default).
pub(crate) fn legacy_combo_cooldown_wait(
    rows: &[(String, String)],
) -> crate::cooldown_retry::ComboCooldownWait {
    let stored = rows
        .iter()
        .find(|(key, _)| key == "resilienceSettings")
        .and_then(|(_, raw)| parse_value(raw).get("comboCooldownWait").cloned())
        .unwrap_or(Value::Null);
    let max_wait_ms = to_integer(stored.get("maxWaitMs"), 90_000, 0, 300_000);
    let max_attempts = to_integer(stored.get("maxAttempts"), 5, 0, 10);
    let budget_ms = to_integer(stored.get("budgetMs"), 300_000, max_wait_ms, 300_000);
    let enabled = !matches!(stored.get("enabled"), Some(Value::Bool(false)));
    crate::cooldown_retry::ComboCooldownWait {
        enabled: enabled && max_wait_ms > 0 && max_attempts > 0,
        max_wait_ms: u64::try_from(max_wait_ms).unwrap_or_default(),
        max_attempts: u32::try_from(max_attempts).unwrap_or_default(),
        budget_ms: u64::try_from(budget_ms).unwrap_or_default(),
    }
}

/// Legacy `normalizeProviderCooldownSettings` over the stored
/// `resilienceSettings.providerCooldown` (the fallback is the default).
pub(crate) fn legacy_provider_cooldown(
    rows: &[(String, String)],
) -> crate::provider_cooldown::ProviderCooldown {
    let stored = rows
        .iter()
        .find(|(key, _)| key == "resilienceSettings")
        .and_then(|(_, raw)| parse_value(raw).get("providerCooldown").cloned())
        .unwrap_or(Value::Null);
    let min_ms = to_integer(stored.get("minRetryCooldownMs"), 5_000, 0, 3_600_000);
    let max_ms = to_integer(
        stored.get("maxRetryCooldownMs"),
        300_000,
        min_ms,
        86_400_000,
    );
    crate::provider_cooldown::ProviderCooldown {
        enabled: matches!(stored.get("enabled"), Some(Value::Bool(true))),
        min_retry_cooldown_ms: u64::try_from(min_ms).unwrap_or_default(),
        max_retry_cooldown_ms: u64::try_from(max_ms).unwrap_or_default(),
    }
}

/// Legacy `comboStickyRoundRobinLimit` through
/// `clampStickyRoundRobinTargetLimit`: unset when null or absent.
fn legacy_combo_sticky_limit(raw: &str) -> Option<u32> {
    let value = parse_value(raw);
    if value.is_null() {
        return None;
    }
    let number = match &value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        Value::Bool(flag) => Some(f64::from(u8::from(*flag))),
        _ => None,
    };
    Some(match number.filter(|number| number.is_finite()) {
        Some(number) => number.floor().clamp(1.0, 1_000.0) as u32,
        None => 1,
    })
}

/// Legacy `normalizeRequestQueueSettings` over a stored `requestQueue`
/// section (the fallback is the legacy default, auto-enabled). A global
/// concurrency cap or an execution backstop other than the default has no
/// native equivalent yet.
fn legacy_request_queue_section(
    stored: &Value,
    rate_limit_defaults: &Value,
) -> Result<crate::request_queue::RequestQueue, &'static str> {
    // Legacy buildLegacyFallback: an old rateLimitDefaults row is the
    // fallback for the rate, gap and concurrency.
    let fallback = |name: &str, default: i64, min: i64, max: i64| {
        to_integer(rate_limit_defaults.get(name), default, min, max)
    };
    let fallback_rpm = fallback("requestsPerMinute", 60, 1, 1_000_000);
    let fallback_gap = fallback("minTimeBetweenRequests", 350, 0, 3_600_000);
    let fallback_concurrency = fallback("concurrentRequests", 6, 1, 10_000);
    let field = |name: &str| stored.get(name);
    // executionMaxWaitMs is inert on the request path: the legacy limiter
    // raises the execution backstop to the upstream timeout, which the
    // executor call already enforces.
    let number =
        |name: &str, fallback: i64, min: i64, max: i64| to_integer(field(name), fallback, min, max);
    Ok(crate::request_queue::RequestQueue {
        enabled: !matches!(field("autoEnableApiKeyProviders"), Some(Value::Bool(false))),
        requests_per_minute: u32::try_from(number("requestsPerMinute", fallback_rpm, 1, 1_000_000))
            .unwrap_or_default(),
        min_time_between_requests_ms: u64::try_from(number(
            "minTimeBetweenRequestsMs",
            fallback_gap,
            0,
            3_600_000,
        ))
        .unwrap_or_default(),
        concurrent_requests: u32::try_from(number(
            "concurrentRequests",
            fallback_concurrency,
            1,
            10_000,
        ))
        .unwrap_or_default(),
        max_wait_ms: u64::try_from(number("maxWaitMs", 30_000, 0, 86_400_000)).unwrap_or_default(),
        max_queue_depth: u32::try_from(number("maxQueueDepth", 0, 0, 100_000)).unwrap_or_default(),
        global_concurrent_requests: u32::try_from(number(
            "globalConcurrentRequests",
            0,
            0,
            100_000,
        ))
        .unwrap_or_default(),
    })
}

/// Legacy `normalizeProviderQuotaOverrides`: per provider, a positive `rpm`
/// and `concurrency` and a non-negative `providerConcurrency`, truncated;
/// providers without a valid value are dropped.
fn legacy_provider_quota_overrides(
    stored: &Value,
) -> Result<
    std::collections::BTreeMap<String, crate::request_queue::ProviderQuotaOverride>,
    &'static str,
> {
    let Value::Object(providers) = stored else {
        return Ok(std::collections::BTreeMap::new());
    };
    let number = |value: Option<&Value>| {
        match value {
            Some(Value::Number(number)) => number.as_f64(),
            Some(Value::String(text)) => text.trim().parse::<f64>().ok(),
            _ => None,
        }
        .filter(|value| value.is_finite())
    };
    let mut out = std::collections::BTreeMap::new();
    for (provider, entry) in providers {
        if provider.is_empty() || !entry.is_object() {
            continue;
        }
        let positive = |name: &str| {
            number(entry.get(name))
                .filter(|value| *value >= 1.0)
                .map(|value| u32::try_from(value.trunc() as u64).unwrap_or(u32::MAX))
        };
        let parsed = crate::request_queue::ProviderQuotaOverride {
            rpm: positive("rpm"),
            concurrency: positive("concurrency"),
            provider_concurrency: number(entry.get("providerConcurrency"))
                .filter(|value| *value >= 0.0)
                .map(|value| u32::try_from(value.trunc() as u64).unwrap_or(u32::MAX)),
        };
        if parsed == crate::request_queue::ProviderQuotaOverride::default() {
            continue;
        }
        if !parsed.valid() {
            return Err("legacy provider quota override exceeds the native range");
        }
        out.insert(provider.clone(), parsed);
    }
    Ok(out)
}

/// The legacy effective request queue, auto-enabled unless configured off.
fn legacy_request_queue(
    rows: &[(String, String)],
) -> Result<crate::request_queue::RequestQueue, &'static str> {
    let stored = rows
        .iter()
        .find(|(key, _)| key == "resilienceSettings")
        .and_then(|(_, raw)| parse_value(raw).get("requestQueue").cloned())
        .unwrap_or(Value::Null);
    let rate_limit_defaults = rows
        .iter()
        .find(|(key, _)| key == "rateLimitDefaults")
        .map_or(Value::Null, |(_, raw)| parse_value(raw));
    legacy_request_queue_section(&stored, &rate_limit_defaults)
}

/// Legacy `shouldPreserveCacheControl` reads only `always` and `never`.
fn legacy_cache_control_mode(raw: &str) -> Option<crate::openai_content::CacheControlMode> {
    match parse_value(raw).as_str()? {
        "always" => Some(crate::openai_content::CacheControlMode::Always),
        "never" => Some(crate::openai_content::CacheControlMode::Never),
        _ => None,
    }
}

/// One legacy strategy choice: a falsy strategy inherits, an unsupported one
/// is refused; a present sticky limit goes through the legacy `toNumber(x, 3)`
/// and the `count < limit` comparison (fractions round up, negatives are 0).
fn legacy_strategy_choice(
    strategy: Option<&Value>,
    limit: Option<&Value>,
) -> Result<crate::global_settings::StrategyChoice, &'static str> {
    let strategy = match strategy {
        None | Some(Value::Null) | Some(Value::Bool(false)) => None,
        Some(Value::String(name)) if name.is_empty() => None,
        Some(Value::String(name)) => Some(
            crate::account_rotation::AccountStrategy::parse_legacy(name)
                .ok_or("legacy account selection strategy requires migration")?,
        ),
        Some(_) => return Err("invalid legacy account selection strategy"),
    };
    let sticky_round_robin_limit = match limit {
        None | Some(Value::Null) => None,
        Some(value) => {
            let number = match value {
                Value::Number(number) => number.as_f64(),
                Value::String(text) if !text.trim().is_empty() => text.trim().parse::<f64>().ok(),
                _ => None,
            }
            .filter(|number| number.is_finite())
            .unwrap_or(f64::from(crate::account_rotation::DEFAULT_STICKY_LIMIT));
            Some(number.ceil().clamp(0.0, 10_000.0) as u32)
        }
    };
    Ok(crate::global_settings::StrategyChoice {
        strategy,
        sticky_round_robin_limit,
    })
}

/// The legacy `fallbackStrategy`, `stickyRoundRobinLimit` and
/// `providerStrategies` rows as native provider strategies.
fn legacy_provider_strategies(
    rows: &[(String, String)],
) -> Result<crate::global_settings::ProviderStrategies, &'static str> {
    let find = |name: &str| {
        rows.iter()
            .find(|(key, _)| key == name)
            .map(|(_, raw)| parse_value(raw))
    };
    let mut strategies = crate::global_settings::ProviderStrategies {
        default: legacy_strategy_choice(
            find("fallbackStrategy").as_ref(),
            find("stickyRoundRobinLimit").as_ref(),
        )?,
        providers: BTreeMap::new(),
    };
    match find("providerStrategies") {
        None | Some(Value::Null) => {}
        Some(Value::Object(providers)) => {
            for (provider, choice) in providers {
                let choice = legacy_strategy_choice(
                    choice.get("fallbackStrategy"),
                    choice.get("stickyRoundRobinLimit"),
                )?;
                if choice != crate::global_settings::StrategyChoice::default() {
                    strategies.providers.insert(provider, choice);
                }
            }
        }
        Some(_) => return Err("invalid legacy provider strategies"),
    }
    strategies.validate()?;
    Ok(strategies)
}

/// Legacy `normalizeRequestBodyLimitMb`: a number or numeric string, floored,
/// within 1-500.
fn legacy_body_size_mb(raw: &str) -> Option<u64> {
    let parsed = match parse_value(raw) {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }?;
    let floored = parsed.is_finite().then(|| parsed.floor())?;
    (1.0..=500.0).contains(&floored).then_some(floored as u64)
}

/// Legacy `resolveIdempotencyWindowMs`: a positive finite number, rounded up.
fn legacy_idempotency_window_ms(raw: &str) -> Option<u64> {
    let value = parse_value(raw).as_f64()?;
    (value.is_finite() && value > 0.0).then(|| value.ceil() as u64)
}

/// Legacy `normalizeStringArray` over a `customBannedSignals` row: a list of
/// trimmed, non-empty, distinct signals (anything but an array is none).
pub(crate) fn custom_banned_signals(raw: &str) -> Result<Vec<String>, &'static str> {
    let Value::Array(values) = parse_value(raw) else {
        return Ok(Vec::new());
    };
    crate::resilience::normalize_banned_signals(
        values
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_owned))
            .collect(),
    )
}

/// Map a legacy `resilienceSettings` row onto native runtime settings
/// (legacy `resolveResilienceSettings`). Sections without a native
/// equivalent must resolve to their defaults.
pub(crate) fn resilience_import(raw: &str) -> Result<ResilienceImport, &'static str> {
    resilience_import_with(raw, None)
}

/// Legacy `buildLegacyFallback` for the cooldown and breaker profiles: an
/// old `providerProfiles` row is the fallback the stored resilience
/// sections resolve over (`normalizeLegacyConnectionCooldownProfile`).
fn profile_defaults(profiles: Option<&Value>) -> Value {
    let mut defaults = SNAPSHOT.resilience_defaults.clone();
    let Some(profiles) = profiles else {
        return defaults;
    };
    for category in ["oauth", "apikey"] {
        let record = profiles.get(category).cloned().unwrap_or(Value::Null);
        let cooldown = &mut defaults["connectionCooldown"][category];
        let transient = to_integer(
            record.get("transientCooldown"),
            cooldown["baseCooldownMs"].as_i64().unwrap_or_default(),
            0,
            86_400_000,
        );
        let rate_limit = to_integer(record.get("rateLimitCooldown"), transient, 0, 86_400_000);
        let hints = match record.get("rateLimitCooldown") {
            Some(Value::Number(number)) => number.as_f64() == Some(0.0),
            _ => cooldown["useUpstreamRetryHints"]
                .as_bool()
                .unwrap_or_default(),
        };
        let steps = to_integer(
            record.get("maxBackoffLevel"),
            cooldown["maxBackoffSteps"].as_i64().unwrap_or_default(),
            0,
            32,
        );
        cooldown["baseCooldownMs"] = Value::from(if hints {
            transient
        } else {
            transient.max(rate_limit)
        });
        cooldown["useUpstreamRetryHints"] = Value::Bool(hints);
        cooldown["maxBackoffSteps"] = Value::from(steps);
        let breaker = &mut defaults["providerBreaker"][category];
        breaker["failureThreshold"] = Value::from(to_integer(
            record.get("circuitBreakerThreshold"),
            breaker["failureThreshold"].as_i64().unwrap_or(1),
            1,
            1_000,
        ));
        breaker["resetTimeoutMs"] = Value::from(to_integer(
            record.get("circuitBreakerReset"),
            breaker["resetTimeoutMs"].as_i64().unwrap_or(1_000),
            1_000,
            86_400_000,
        ));
    }
    defaults
}

/// [`resilience_import`] over the legacy `providerProfiles` fallback.
pub(crate) fn resilience_import_with(
    raw: &str,
    profiles: Option<&Value>,
) -> Result<ResilienceImport, &'static str> {
    let defaults = &profile_defaults(profiles);
    let Value::Object(stored) = parse_value(raw) else {
        return Err("legacy resilience settings are not an object");
    };
    for (section, value) in &stored {
        let Some(default) = defaults.get(section) else {
            return Err("legacy resilience section is not in the migration inventory");
        };
        if matches!(
            section.as_str(),
            "connectionCooldown"
                | "providerBreaker"
                | "quotaPreflight"
                | "waitForCooldown"
                | "comboCooldownWait"
                | "providerCooldown"
        ) {
            continue;
        }
        if section == "providerQuotaOverrides" {
            legacy_provider_quota_overrides(value)?;
            continue;
        }
        if section == "requestQueue" {
            legacy_request_queue_section(value, &Value::Null)?;
            continue;
        }
        // The kill switch only gates the quota-share combo strategy, which the
        // native combo compiler refuses, so it is inert for any importable
        // combo set.
        if section == "quotaShareConcurrencyLimit" {
            continue;
        }
        if merged(default, value) != *default {
            return Err("legacy resilience section has no native equivalent yet");
        }
    }
    let section = |name: &str| stored.get(name).cloned().unwrap_or(Value::Null);
    let mut cooldown = [(0, false, 0); 2];
    let mut breaker = [(0, 0, 0); 2];
    for (index, category) in ["oauth", "apikey"].into_iter().enumerate() {
        let fallback = &defaults["connectionCooldown"][category];
        let profile = section("connectionCooldown")
            .get(category)
            .cloned()
            .unwrap_or(Value::Null);
        // The native breaker has no per-provider 429 hint override.
        if profile
            .get("useUpstream429BreakerHints")
            .is_some_and(Value::is_boolean)
        {
            return Err("legacy upstream 429 breaker hints require migration");
        }
        let base = to_integer(
            profile.get("baseCooldownMs"),
            fallback["baseCooldownMs"].as_i64().unwrap_or_default(),
            0,
            86_400_000,
        );
        let steps = to_integer(
            profile.get("maxBackoffSteps"),
            fallback["maxBackoffSteps"].as_i64().unwrap_or_default(),
            0,
            32,
        );
        if base > NATIVE_MAX_COOLDOWN_BASE_MS || steps > NATIVE_MAX_BACKOFF_STEPS {
            return Err("legacy connection cooldown exceeds the native ceiling");
        }
        let hints = to_boolean(
            profile.get("useUpstreamRetryHints"),
            fallback["useUpstreamRetryHints"]
                .as_bool()
                .unwrap_or_default(),
        );
        cooldown[index] = (base, hints, steps);

        let fallback = &defaults["providerBreaker"][category];
        let profile = section("providerBreaker")
            .get(category)
            .cloned()
            .unwrap_or(Value::Null);
        let failure = to_integer(
            profile.get("failureThreshold"),
            fallback["failureThreshold"].as_i64().unwrap_or(1),
            1,
            1_000,
        );
        let degradation = to_integer(
            profile.get("degradationThreshold"),
            fallback["degradationThreshold"].as_i64().unwrap_or(1),
            1,
            1_000,
        )
        .min(if failure <= 1 { 1 } else { failure - 1 });
        let reset = to_integer(
            profile.get("resetTimeoutMs"),
            fallback["resetTimeoutMs"].as_i64().unwrap_or(1_000),
            1_000,
            86_400_000,
        );
        breaker[index] = (failure, degradation, reset);
    }
    let preflight = section("quotaPreflight");
    let fallback = &defaults["quotaPreflight"];
    let threshold = to_integer(
        preflight.get("defaultThresholdPercent"),
        fallback["defaultThresholdPercent"]
            .as_i64()
            .unwrap_or_default(),
        0,
        99,
    );
    // The warn threshold and per-window cutoffs have no native equivalent;
    // they must resolve as they would from the defaults.
    let warn = |raw: i64| {
        if raw <= threshold {
            (threshold + 1).min(100)
        } else {
            raw
        }
    };
    let stored_warn = warn(to_integer(
        preflight.get("warnThresholdPercent"),
        fallback["warnThresholdPercent"]
            .as_i64()
            .unwrap_or_default(),
        0,
        100,
    ));
    let default_warn = warn(
        fallback["warnThresholdPercent"]
            .as_i64()
            .unwrap_or_default(),
    );
    if stored_warn != default_warn {
        return Err("legacy quota warning threshold has no native equivalent yet");
    }
    if preflight
        .get("providerWindowDefaults")
        .is_some_and(|windows| windows.as_object().is_some_and(|map| !map.is_empty()))
    {
        return Err("legacy per-window quota cutoffs require migration");
    }
    Ok(ResilienceImport {
        quota_preflight_enabled: to_boolean(
            preflight.get("enabled"),
            fallback["enabled"].as_bool().unwrap_or_default(),
        ),
        quota_preflight_threshold_percent: threshold,
        cooldown,
        breaker,
    })
}

/// Settings another importer reads, named by the importer that owns them.
const CONSUMED: &[(&str, &str)] = &[
    ("modelAliases", "legacy_aliases"),
    ("wildcardAliases", "legacy_aliases"),
    ("stripModelPrefix", "legacy_aliases"),
    ("payloadRules", "legacy_payload_rules"),
    ("preferClaudeCodeForUnprefixedClaudeModels", "legacy_keys"),
    ("hidePaidModels", "legacy_keys"),
    ("excludeTosAvoid", "legacy_keys"),
    ("hideAutoCombos", "legacy_keys"),
    ("freeAccessPolicy", "legacy_keys"),
    ("proxyEnabled", "legacy_keys"),
    ("disabledModels", "legacy_keys"),
    ("modelVisibilityAllowlist", "legacy_keys"),
    ("modelVisibilityDenylist", "legacy_keys"),
];

/// Personal dashboard preferences: layout, branding and onboarding state the
/// React UI keeps, with no effect on routing, admission or accounting.
const DASHBOARD: &[&str] = &[
    "hiddenSidebarItems",
    "hiddenSidebarGroupLabels",
    "sidebarSectionOrder",
    "sidebarItemOrder",
    "sidebarActivePreset",
    "hideEndpointCloudflaredTunnel",
    "hideEndpointTailscaleFunnel",
    "hideEndpointNgrokTunnel",
    "quotaVisibility",
    "comboConfigMode",
    // The routing card mirror of its combo round-robin toggle; the toggle
    // writes the real default through comboDefaults, which is imported.
    "comboStrategy",
    "theme",
    "language",
    "instanceName",
    "customLogoUrl",
    "customLogoBase64",
    "customFaviconUrl",
    "customFaviconBase64",
    "showQuickStartOnHome",
    "showProviderTopologyOnHome",
    "pinProviderQuotaToHome",
    "hideHealthCheckLogs",
    "setupComplete",
    // Read only by the dashboard's debug card; no gateway path reads it.
    "debugMode",
    // The dashboard's quota auto-refresh toggle (the auto-combo reads only
    // the interval, which stays in the inventory).
    "autoRefreshProviderQuota",
    // A breach check when changing the dashboard login password; the native
    // management API has no password login.
    "passwordBreachCheckEnabled",
];

/// Opt-in diagnostics that only add log lines (dropped: the native gateway
/// has its own logging).
const DIAGNOSTIC: &[&str] = &[
    // A per-request debug line summarizing tool sources (legacy chatCore).
    "logToolSources",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "class")]
pub enum SettingClass {
    AtDefault,
    Consumed {
        importer: &'static str,
    },
    Dashboard,
    /// The native gateway already behaves like this value; dropped.
    Equivalent {
        reason: &'static str,
    },
    /// An opt-in diagnostic log line, dropped.
    Diagnostic,
    /// Migrated by this importer onto native runtime settings.
    Imported,
    Refused {
        reason: &'static str,
    },
}

#[derive(Debug, Default, Serialize)]
pub struct LegacySettingsReport {
    /// Classification of every stored row, by key.
    pub settings: BTreeMap<String, SettingClass>,
}

impl LegacySettingsReport {
    /// The keys that block the cutover.
    pub fn refused(&self) -> impl Iterator<Item = (&str, &'static str)> {
        self.settings.iter().filter_map(|(key, class)| match class {
            SettingClass::Refused { reason } => Some((key.as_str(), *reason)),
            _ => None,
        })
    }
}

/// Legacy `getSettings` parsing: JSON when it parses, else the raw string.
fn parse_value(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_owned()))
}

/// Classify one stored settings row.
pub(crate) fn classify(key: &str, raw: &str) -> SettingClass {
    if let Some((_, importer)) = CONSUMED.iter().find(|(name, _)| *name == key) {
        return SettingClass::Consumed { importer };
    }
    if DASHBOARD.contains(&key) {
        return SettingClass::Dashboard;
    }
    if DIAGNOSTIC.contains(&key) {
        return SettingClass::Diagnostic;
    }
    match key {
        "resilienceSettings" => {
            return match resilience_import(raw) {
                Ok(_) => SettingClass::Imported,
                Err(reason) => SettingClass::Refused { reason },
            };
        }
        // Account selection inside provider pools (account_rotation).
        "fallbackStrategy" | "stickyRoundRobinLimit" | "providerStrategies" => {
            let rows = [(key.to_owned(), raw.to_owned())];
            return match legacy_provider_strategies(&rows) {
                Ok(strategies)
                    if strategies == crate::global_settings::ProviderStrategies::default()
                        || (key == "stickyRoundRobinLimit"
                            && strategies.default.sticky_round_robin_limit
                                == Some(crate::account_rotation::DEFAULT_STICKY_LIMIT)) =>
                {
                    SettingClass::AtDefault
                }
                Ok(_) => SettingClass::Imported,
                Err(reason) => SettingClass::Refused { reason },
            };
        }
        // An explicit, valid value imports onto the native global setting; an
        // invalid one is ignored by the legacy resolvers, like the default.
        "maxBodySizeMb" => {
            return match legacy_body_size_mb(raw) {
                Some(_) => SettingClass::Imported,
                None => SettingClass::AtDefault,
            };
        }
        "idempotencyWindowMs" => {
            return match legacy_idempotency_window_ms(raw) {
                Some(_) => SettingClass::Imported,
                None => SettingClass::AtDefault,
            };
        }
        // The pair imports onto the native custom system prompt setting.
        "customSystemPromptEnabled" => return SettingClass::Imported,
        // Auto-disabling a banned account only flips it inactive after the
        // ban already parked it; native bans park the account until an
        // operator acts, whatever the scope.
        "autoDisableBannedAccounts" | "autoDisableBannedScope" => {
            let value = parse_value(raw);
            return if value == Value::Bool(false) || value == Value::String("all".to_owned()) {
                SettingClass::AtDefault
            } else {
                SettingClass::Equivalent {
                    reason: "native banned accounts stay parked until an operator acts",
                }
            };
        }
        // Only an explicit true turns the stickiness off.
        "disableSessionStickiness" => {
            return if parse_value(raw) == Value::Bool(true) {
                SettingClass::Imported
            } else {
                SettingClass::AtDefault
            };
        }
        // Only an explicit false turns the affinity off.
        // An unknown classifier compat mode is off, as the legacy detector reads it.
        "claudeClassifierCompat" => {
            return match crate::claude_classifier_compat::ClaudeClassifierCompatMode::normalize(
                &parse_value(raw),
            ) {
                crate::claude_classifier_compat::ClaudeClassifierCompatMode::Off => {
                    SettingClass::AtDefault
                }
                _ => SettingClass::Imported,
            };
        }
        "credentialRedactionEnabled" => {
            return if parse_value(raw) == Value::Bool(true) {
                SettingClass::Imported
            } else {
                SettingClass::AtDefault
            };
        }
        "comboAutoPromoteEnabled" => {
            return if parse_value(raw) == Value::Bool(true) {
                SettingClass::Imported
            } else {
                SettingClass::AtDefault
            };
        }
        "promptCacheAffinityEnabled" => {
            return if parse_value(raw) == Value::Bool(false) {
                SettingClass::Imported
            } else {
                SettingClass::AtDefault
            };
        }
        // Unset (null) inherits the provider pools' sticky limit.
        "comboStickyRoundRobinLimit" => {
            return if legacy_combo_sticky_limit(raw).is_some() {
                SettingClass::Imported
            } else {
                SettingClass::AtDefault
            };
        }
        // The cooldown and breaker fallback of old databases.
        "providerProfiles" => {
            let profiles = parse_value(raw);
            return match resilience_import_with("{}", Some(&profiles)) {
                Ok(mapped) if Ok(mapped) == resilience_import("{}") => SettingClass::AtDefault,
                Ok(_) => SettingClass::Imported,
                Err(reason) => SettingClass::Refused { reason },
            };
        }
        // The request queue fallback of old databases.
        "rateLimitDefaults" => {
            let rows = [(key.to_owned(), raw.to_owned())];
            return match (legacy_request_queue(&rows), legacy_request_queue(&[])) {
                (Ok(own), Ok(default)) if own == default => SettingClass::AtDefault,
                (Ok(_), _) => SettingClass::Imported,
                (Err(reason), _) => SettingClass::Refused { reason },
            };
        }
        // The fallback for an unset `waitForCooldown` resilience section.
        "requestRetry" | "maxRetryIntervalSec" => {
            return if legacy_wait_for_cooldown(&[(key.to_owned(), raw.to_owned())])
                == crate::cooldown_retry::WaitForCooldown::default()
            {
                SettingClass::AtDefault
            } else {
                SettingClass::Imported
            };
        }
        // A disabled Codex service tier has no effect whatever its fields.
        "codexServiceTier" | "codexFastServiceTier" => {
            let rows = [(key.to_owned(), raw.to_owned())];
            return if legacy_codex_service_tier(&rows).enabled {
                SettingClass::Imported
            } else {
                SettingClass::AtDefault
            };
        }
        // Responses continuation policy: an unknown value is auto, as legacy
        // normalizeResponsesPreviousResponseIdMode reads it.
        "responsesPreviousResponseIdMode" => {
            return match crate::responses_state::PreviousResponseIdMode::normalize(&parse_value(
                raw,
            )) {
                crate::responses_state::PreviousResponseIdMode::Auto => SettingClass::AtDefault,
                _ => SettingClass::Imported,
            };
        }
        // An unknown signature cache mode is enabled, as the legacy store reads it.
        "antigravitySignatureCacheMode" => {
            return match crate::antigravity_translation::SignatureCacheMode::normalize(
                &parse_value(raw),
            ) {
                crate::antigravity_translation::SignatureCacheMode::Enabled => {
                    SettingClass::AtDefault
                }
                _ => SettingClass::Imported,
            };
        }
        // The marker of the legacy per-connection Codex defaults migration.
        "codexConnectionDefaultsMigrationV1" => {
            return SettingClass::Equivalent {
                reason:
                    "the Codex request defaults it migrated are imported with each Codex connection",
            };
        }
        // Disabled fast mode has no effect whatever its model list.
        "claudeFastMode" => {
            return if legacy_claude_fast_mode(raw).enabled {
                SettingClass::Imported
            } else {
                SettingClass::AtDefault
            };
        }
        // Only an explicit always/never overrides the automatic rule.
        "alwaysPreserveClientCache" => {
            return match legacy_cache_control_mode(raw) {
                Some(_) => SettingClass::Imported,
                None => SettingClass::AtDefault,
            };
        }
        // Seeded by legacy migration 014 on every store. Legacy chatCore and
        // isDetailedLoggingEnabled treat only JSON true or the strings "1" and
        // "true" as on; the seeded 0 is a number and stays off.
        "call_log_pipeline_enabled" => {
            let enabled = matches!(parse_value(raw), Value::Bool(true))
                || matches!(parse_value(raw), Value::String(value) if value == "1" || value == "true");
            return if enabled {
                SettingClass::Refused {
                    reason: "the native daemon has no detailed request payload logs",
                }
            } else {
                SettingClass::Equivalent {
                    reason: "detailed request payload capture is off, as in the native daemon",
                }
            };
        }
        // Legacy authz: a manage-scope key (or dashboard session) may reach
        // LOCAL_ONLY routes under these prefixes from a non-loopback client.
        // The native management API has no loopback-only routes, so there is
        // nothing for the bypass to open, whatever its value.
        "localOnlyManageScopeBypassEnabled" | "localOnlyManageScopeBypassPrefixes" => {
            return SettingClass::Equivalent {
                reason: "the native management API has no loopback-only routes to bypass",
            };
        }
        // Hiding no-think variants matches the native catalog, which does not
        // advertise them (requests may still name them).
        "hideNoThinkVariants" if parse_value(raw) == Value::Bool(true) => {
            return SettingClass::Equivalent {
                reason: "the native catalog does not list no-think variants",
            };
        }
        "customSystemPrompt" => {
            return match parse_value(raw) {
                Value::String(prompt) if prompt.len() <= 100_000 && !prompt.contains('\0') => {
                    SettingClass::Imported
                }
                _ => SettingClass::Refused {
                    reason: "legacy custom system prompt is invalid",
                },
            };
        }
        "customBannedSignals" => {
            return match custom_banned_signals(raw) {
                Ok(_) => SettingClass::Imported,
                Err(reason) => SettingClass::Refused { reason },
            };
        }
        "modelLockout" => {
            return match model_lockout_ceiling(raw) {
                Ok(crate::availability::DEFAULT_CONNECTION_MAX_COOLDOWN_MS)
                    if legacy_model_lockout_policy(raw)
                        == crate::availability::ModelLockoutPolicy::default() =>
                {
                    SettingClass::AtDefault
                }
                Ok(_) => SettingClass::Imported,
                Err(reason) => SettingClass::Refused { reason },
            };
        }
        _ => {}
    }
    match DEFAULTS.get(key) {
        Some(default) if *default == parse_value(raw) => SettingClass::AtDefault,
        Some(_) => SettingClass::Refused {
            reason: "legacy setting has no native equivalent yet",
        },
        None => SettingClass::Refused {
            reason: "legacy setting is not in the migration inventory",
        },
    }
}

/// Read-only inventory of a legacy database's settings rows.
pub async fn inspect(path: &Path) -> Result<LegacySettingsReport, &'static str> {
    let mut report = LegacySettingsReport::default();
    for (key, value) in settings_rows(path).await? {
        let class = classify(&key, &value);
        report.settings.insert(key, class);
    }
    Ok(report)
}

#[derive(Debug, Serialize)]
pub struct SettingsImport {
    /// Whether a `resilienceSettings` row was migrated onto native runtime
    /// settings (otherwise the native defaults, which match the legacy ones,
    /// stay in place).
    pub runtime_settings_imported: bool,
    /// Custom account-ban signals imported for the failure classifier.
    pub custom_banned_signals: usize,
    /// Whether a configured custom system prompt was imported.
    pub custom_system_prompt_imported: bool,
}

/// Offline cutover step: refuse unless every stored settings row is at its
/// default, consumed by another importer, dashboard-only or importable, then
/// write the native runtime settings a `resilienceSettings` row maps onto.
/// The destination must not have runtime settings configured yet.
pub async fn import(
    source: &Path,
    destination: &crate::storage::Database,
) -> Result<SettingsImport, &'static str> {
    let rows = settings_rows(source).await?;
    if rows
        .iter()
        .any(|(key, value)| matches!(classify(key, value), SettingClass::Refused { .. }))
    {
        return Err("legacy settings require migration; nothing imported");
    }
    // An old providerProfiles row resolves the cooldown and breaker profiles
    // even without a stored resilienceSettings row.
    let profiles = rows
        .iter()
        .find(|(key, _)| key == "providerProfiles")
        .map(|(_, raw)| parse_value(raw));
    let resilience = rows
        .iter()
        .find(|(key, _)| key == "resilienceSettings")
        .map(|(_, raw)| raw.as_str());
    let mapped = match (resilience, &profiles) {
        (None, None) => None,
        (raw, profiles) => Some(resilience_import_with(
            raw.unwrap_or("{}"),
            profiles.as_ref(),
        )?),
    };
    let signals = rows
        .iter()
        .find(|(key, _)| key == "customBannedSignals")
        .map(|(_, raw)| custom_banned_signals(raw))
        .transpose()?
        .unwrap_or_default();
    if mapped.is_some() && destination.runtime_settings().await?.is_some() {
        return Err("destination runtime settings are already configured");
    }
    if !signals.is_empty() && !destination.custom_banned_signals().await?.is_empty() {
        return Err("destination banned signals are already configured");
    }
    let revision = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "system clock is before the Unix epoch")?
        .as_millis();
    let revision = i64::try_from(revision).map_err(|_| "invalid settings revision")?;
    if !signals.is_empty() {
        destination
            .upsert_custom_banned_signals(&signals, revision)
            .await?;
    }
    // Legacy chatCore injects the prompt only when enabled is exactly true.
    let prompt = crate::global_settings::CustomSystemPrompt {
        enabled: rows.iter().any(|(key, raw)| {
            key == "customSystemPromptEnabled" && parse_value(raw) == Value::Bool(true)
        }),
        prompt: rows
            .iter()
            .find(|(key, _)| key == "customSystemPrompt")
            .and_then(|(_, raw)| parse_value(raw).as_str().map(str::to_owned))
            .unwrap_or_default(),
    };
    let custom_system_prompt_imported =
        prompt != crate::global_settings::CustomSystemPrompt::default();
    let mut global = Vec::new();
    if let Some(mb) = rows
        .iter()
        .find(|(key, _)| key == "maxBodySizeMb")
        .and_then(|(_, raw)| legacy_body_size_mb(raw))
    {
        global.push((crate::global_settings::MAX_BODY_SIZE_MB, Value::from(mb)));
    }
    if let Some(ms) = rows
        .iter()
        .find(|(key, _)| key == "idempotencyWindowMs")
        .and_then(|(_, raw)| legacy_idempotency_window_ms(raw))
    {
        global.push((
            crate::global_settings::IDEMPOTENCY_WINDOW_MS,
            Value::from(ms),
        ));
    }
    if let Some(limit) = rows
        .iter()
        .find(|(key, _)| key == "comboStickyRoundRobinLimit")
        .and_then(|(_, raw)| legacy_combo_sticky_limit(raw))
    {
        global.push((
            crate::global_settings::COMBO_STICKY_ROUND_ROBIN_LIMIT,
            Value::from(limit),
        ));
    }
    if rows
        .iter()
        .any(|(key, raw)| key == "comboAutoPromoteEnabled" && parse_value(raw) == Value::Bool(true))
    {
        global.push((
            crate::global_settings::COMBO_AUTO_PROMOTE,
            Value::Bool(true),
        ));
    }
    if rows.iter().any(|(key, raw)| {
        key == "credentialRedactionEnabled" && parse_value(raw) == Value::Bool(true)
    }) {
        global.push((
            crate::global_settings::CREDENTIAL_REDACTION,
            Value::Bool(true),
        ));
    }
    if rows.iter().any(|(key, raw)| {
        key == "promptCacheAffinityEnabled" && parse_value(raw) == Value::Bool(false)
    }) {
        global.push((
            crate::global_settings::PROMPT_CACHE_AFFINITY,
            Value::Bool(false),
        ));
    }
    if rows.iter().any(|(key, raw)| {
        key == "disableSessionStickiness" && parse_value(raw) == Value::Bool(true)
    }) {
        global.push((
            crate::global_settings::SESSION_STICKINESS,
            Value::Bool(false),
        ));
    }
    // The legacy queue is on by default, the native one off: the cutover
    // carries the legacy effective configuration.
    let request_queue = legacy_request_queue(&rows)?;
    if request_queue != crate::request_queue::RequestQueue::default() {
        global.push((
            crate::global_settings::REQUEST_QUEUE,
            serde_json::to_value(request_queue).map_err(|_| "invalid legacy request queue")?,
        ));
    }
    let provider_quota_overrides = legacy_provider_quota_overrides(
        &rows
            .iter()
            .find(|(key, _)| key == "resilienceSettings")
            .and_then(|(_, raw)| parse_value(raw).get("providerQuotaOverrides").cloned())
            .unwrap_or(Value::Null),
    )?;
    if !provider_quota_overrides.is_empty() {
        global.push((
            crate::global_settings::PROVIDER_QUOTA_OVERRIDES,
            serde_json::to_value(provider_quota_overrides)
                .map_err(|_| "invalid legacy provider quota overrides")?,
        ));
    }
    let provider_cooldown = legacy_provider_cooldown(&rows);
    if provider_cooldown != crate::provider_cooldown::ProviderCooldown::default() {
        global.push((
            crate::global_settings::PROVIDER_COOLDOWN,
            serde_json::to_value(provider_cooldown)
                .map_err(|_| "invalid legacy provider cooldown")?,
        ));
    }
    let combo_cooldown_wait = legacy_combo_cooldown_wait(&rows);
    if combo_cooldown_wait != crate::cooldown_retry::ComboCooldownWait::default() {
        global.push((
            crate::global_settings::COMBO_COOLDOWN_WAIT,
            serde_json::to_value(combo_cooldown_wait)
                .map_err(|_| "invalid legacy combo cooldown wait")?,
        ));
    }
    let wait_for_cooldown = legacy_wait_for_cooldown(&rows);
    if wait_for_cooldown != crate::cooldown_retry::WaitForCooldown::default() {
        global.push((
            crate::global_settings::WAIT_FOR_COOLDOWN,
            serde_json::to_value(wait_for_cooldown).map_err(|_| "invalid legacy cooldown wait")?,
        ));
    }
    if let Some(fast_mode) = rows
        .iter()
        .find(|(key, _)| key == "claudeFastMode")
        .map(|(_, raw)| legacy_claude_fast_mode(raw))
        .filter(|mode| mode.enabled)
    {
        global.push((
            crate::global_settings::CLAUDE_FAST_MODE,
            serde_json::to_value(fast_mode).map_err(|_| "invalid legacy Claude fast mode")?,
        ));
    }
    if let Some(mode) = rows
        .iter()
        .find(|(key, _)| key == "responsesPreviousResponseIdMode")
        .map(|(_, raw)| {
            crate::responses_state::PreviousResponseIdMode::normalize(&parse_value(raw))
        })
        .filter(|mode| *mode != crate::responses_state::PreviousResponseIdMode::Auto)
    {
        global.push((
            crate::global_settings::RESPONSES_PREVIOUS_RESPONSE_ID_MODE,
            serde_json::to_value(mode).map_err(|_| "invalid legacy previous response id mode")?,
        ));
    }
    if let Some(mode) = rows
        .iter()
        .find(|(key, _)| key == "antigravitySignatureCacheMode")
        .map(|(_, raw)| {
            crate::antigravity_translation::SignatureCacheMode::normalize(&parse_value(raw))
        })
        .filter(|mode| *mode != crate::antigravity_translation::SignatureCacheMode::Enabled)
    {
        global.push((
            crate::global_settings::ANTIGRAVITY_SIGNATURE_CACHE_MODE,
            serde_json::to_value(mode).map_err(|_| "invalid legacy signature cache mode")?,
        ));
    }
    if let Some(mode) = rows
        .iter()
        .find(|(key, _)| key == "claudeClassifierCompat")
        .map(|(_, raw)| {
            crate::claude_classifier_compat::ClaudeClassifierCompatMode::normalize(&parse_value(
                raw,
            ))
        })
        .filter(|mode| *mode != crate::claude_classifier_compat::ClaudeClassifierCompatMode::Off)
    {
        global.push((
            crate::global_settings::CLAUDE_CLASSIFIER_COMPAT,
            serde_json::to_value(mode)
                .map_err(|_| "invalid legacy Claude classifier compat mode")?,
        ));
    }
    let codex_service_tier = legacy_codex_service_tier(&rows);
    if codex_service_tier != crate::codex_request::CodexServiceTier::default() {
        global.push((
            crate::global_settings::CODEX_SERVICE_TIER,
            serde_json::to_value(codex_service_tier)
                .map_err(|_| "invalid legacy Codex service tier")?,
        ));
    }
    if let Some(mode) = rows
        .iter()
        .find(|(key, _)| key == "alwaysPreserveClientCache")
        .and_then(|(_, raw)| legacy_cache_control_mode(raw))
    {
        global.push((
            crate::global_settings::CACHE_CONTROL_MODE,
            serde_json::to_value(mode).map_err(|_| "invalid legacy cache control mode")?,
        ));
    }
    if let Some(ceiling) = rows
        .iter()
        .find(|(key, _)| key == "modelLockout")
        .map(|(_, raw)| model_lockout_ceiling(raw))
        .transpose()?
        .filter(|ceiling| *ceiling != crate::availability::DEFAULT_CONNECTION_MAX_COOLDOWN_MS)
    {
        global.push((
            crate::global_settings::CONNECTION_MAX_COOLDOWN_MS,
            Value::from(ceiling),
        ));
    }
    if let Some(policy) = rows
        .iter()
        .find(|(key, _)| key == "modelLockout")
        .map(|(_, raw)| legacy_model_lockout_policy(raw))
        .filter(|policy| *policy != crate::availability::ModelLockoutPolicy::default())
    {
        global.push((
            crate::global_settings::MODEL_LOCKOUT_POLICY,
            serde_json::to_value(policy).map_err(|_| "invalid legacy model lockout policy")?,
        ));
    }
    let strategies = legacy_provider_strategies(&rows)?;
    // An explicit default sticky limit alone changes nothing.
    let default_strategies = crate::global_settings::ProviderStrategies {
        default: crate::global_settings::StrategyChoice {
            strategy: None,
            sticky_round_robin_limit: Some(crate::account_rotation::DEFAULT_STICKY_LIMIT),
        },
        providers: BTreeMap::new(),
    };
    if strategies != crate::global_settings::ProviderStrategies::default()
        && strategies != default_strategies
    {
        global.push((
            crate::global_settings::PROVIDER_STRATEGIES,
            serde_json::to_value(&strategies).map_err(|_| "invalid legacy provider strategies")?,
        ));
    }
    if !global.is_empty() {
        let configured = destination.global_settings().await?;
        if global.iter().any(|(key, _)| configured.contains_key(*key)) {
            return Err("destination global settings are already configured");
        }
    }
    for (key, value) in global {
        let value = crate::global_settings::validate(key, value)?;
        destination
            .upsert_global_setting(key, &value, revision)
            .await?;
    }
    if custom_system_prompt_imported {
        if destination
            .global_settings()
            .await?
            .contains_key(crate::global_settings::CUSTOM_SYSTEM_PROMPT)
        {
            return Err("destination custom system prompt is already configured");
        }
        let value = crate::global_settings::validate(
            crate::global_settings::CUSTOM_SYSTEM_PROMPT,
            serde_json::to_value(&prompt).map_err(|_| "invalid legacy custom system prompt")?,
        )?;
        destination
            .upsert_global_setting(
                crate::global_settings::CUSTOM_SYSTEM_PROMPT,
                &value,
                revision,
            )
            .await?;
    }
    let Some(mapped) = mapped else {
        return Ok(SettingsImport {
            runtime_settings_imported: false,
            custom_banned_signals: signals.len(),
            custom_system_prompt_imported,
        });
    };
    let [(oauth_base, oauth_hints, oauth_steps), (apikey_base, apikey_hints, apikey_steps)] =
        mapped.cooldown;
    let [(oauth_failure, oauth_degradation, oauth_reset), (apikey_failure, apikey_degradation, apikey_reset)] =
        mapped.breaker;
    destination
        .upsert_runtime_settings(&crate::storage::StoredRuntimeSettings {
            quota_preflight_enabled: mapped.quota_preflight_enabled,
            // Parts per million remaining: one percent is 10_000.
            quota_preflight_threshold_ppm: mapped.quota_preflight_threshold_percent * 10_000,
            oauth_cooldown_base_ms: oauth_base,
            oauth_cooldown_retry_hints: oauth_hints,
            oauth_cooldown_max_backoff_steps: oauth_steps,
            apikey_cooldown_base_ms: apikey_base,
            apikey_cooldown_retry_hints: apikey_hints,
            apikey_cooldown_max_backoff_steps: apikey_steps,
            oauth_breaker_failure_threshold: oauth_failure,
            oauth_breaker_degradation_threshold: oauth_degradation,
            oauth_breaker_reset_timeout_ms: oauth_reset,
            apikey_breaker_failure_threshold: apikey_failure,
            apikey_breaker_degradation_threshold: apikey_degradation,
            apikey_breaker_reset_timeout_ms: apikey_reset,
            revision,
        })
        .await?;
    Ok(SettingsImport {
        runtime_settings_imported: true,
        custom_banned_signals: signals.len(),
        custom_system_prompt_imported,
    })
}

/// The stored settings rows the legacy loader would apply (internal keys and
/// rows without a value are skipped).
async fn settings_rows(path: &Path) -> Result<Vec<(String, String)>, &'static str> {
    let mut connection = SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .connect()
        .await
        .map_err(|_| "cannot open legacy SQLite database read-only")?;
    sqlx::query("PRAGMA query_only = ON")
        .execute(&mut connection)
        .await
        .map_err(|_| "cannot initialize legacy database")?;
    let has_table: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='key_value'",
    )
    .fetch_one(&mut connection)
    .await
    .map_err(|_| "cannot inspect legacy schema")?;
    let mut settings = Vec::new();
    if has_table == 1 {
        let rows = sqlx::query("SELECT key, value FROM key_value WHERE namespace='settings'")
            .fetch_all(&mut connection)
            .await
            .map_err(|_| "cannot read legacy settings")?;
        for row in rows {
            let key: String = row.try_get("key").map_err(|_| "invalid legacy setting")?;
            let value: Option<String> =
                row.try_get("value").map_err(|_| "invalid legacy setting")?;
            if let Some(value) = value.filter(|_| !key.starts_with('_')) {
                settings.push((key, value));
            }
        }
    }
    connection
        .close()
        .await
        .map_err(|_| "cannot close legacy database")?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_rows_are_classified_against_the_legacy_defaults() {
        assert_eq!(classify("requestRetry", "3"), SettingClass::AtDefault);
        assert_eq!(
            classify("comboStrategy", "\"fallback\""),
            SettingClass::Dashboard
        );
        // A raw string that is not JSON compares as a string, as legacy parses it.
        assert_eq!(
            classify("oidcRedirectPath", "/api/auth/oidc/callback"),
            SettingClass::AtDefault
        );
        assert_eq!(classify("requestRetry", "5"), SettingClass::Imported);
        assert_eq!(
            classify("comboStickyRoundRobinLimit", "null"),
            SettingClass::AtDefault
        );
        assert_eq!(legacy_combo_sticky_limit("5"), Some(5));
        assert_eq!(
            classify("autoDisableBannedAccounts", "false"),
            SettingClass::AtDefault
        );
        assert!(matches!(
            classify("autoDisableBannedAccounts", "true"),
            SettingClass::Equivalent { .. }
        ));
        assert!(matches!(
            classify("autoDisableBannedScope", "\"oauth\""),
            SettingClass::Equivalent { .. }
        ));
        assert_eq!(
            classify("promptCacheAffinityEnabled", "false"),
            SettingClass::Imported
        );
        assert_eq!(
            classify("promptCacheAffinityEnabled", "\"no\""),
            SettingClass::AtDefault
        );
        assert_eq!(legacy_combo_sticky_limit("\"2.7\""), Some(2));
        assert_eq!(
            classify("disableSessionStickiness", "true"),
            SettingClass::Imported
        );
        assert_eq!(
            classify("disableSessionStickiness", "false"),
            SettingClass::AtDefault
        );
        assert_eq!(legacy_combo_sticky_limit("5000"), Some(1_000));
        assert_eq!(legacy_combo_sticky_limit("\"x\""), Some(1));
        assert_eq!(
            classify("maxRetryIntervalSec", "30"),
            SettingClass::AtDefault
        );
        assert_eq!(
            legacy_combo_cooldown_wait(&[(
                "resilienceSettings".to_owned(),
                r#"{"comboCooldownWait":{"maxWaitMs":0,"budgetMs":5}}"#.to_owned(),
            )]),
            crate::cooldown_retry::ComboCooldownWait {
                enabled: false,
                max_wait_ms: 0,
                max_attempts: 5,
                budget_ms: 5,
            }
        );
        assert_eq!(
            legacy_wait_for_cooldown(&[
                ("requestRetry".to_owned(), "0".to_owned()),
                (
                    "resilienceSettings".to_owned(),
                    r#"{"waitForCooldown":{"maxRetries":4,"maxRetryWaitSec":"60","budgetMs":1}}"#
                        .to_owned(),
                ),
            ]),
            crate::cooldown_retry::WaitForCooldown {
                // The fallback with no retries leaves the section disabled.
                enabled: false,
                max_retries: 4,
                max_retry_wait_sec: 60,
                budget_ms: 60_000,
            }
        );
        assert!(matches!(
            classify("connectionAwareExpansion", "true"),
            SettingClass::Refused { .. }
        ));
        assert_eq!(classify("theme", "\"dark\""), SettingClass::Dashboard);
        assert_eq!(classify("debugMode", "true"), SettingClass::Dashboard);
        assert_eq!(
            classify("fallbackStrategy", "\"round-robin\""),
            SettingClass::Imported
        );
        assert!(matches!(
            classify("fallbackStrategy", "\"p2c\""),
            SettingClass::Refused { .. }
        ));
        assert_eq!(
            classify("stickyRoundRobinLimit", "3"),
            SettingClass::AtDefault
        );
        assert_eq!(
            classify("stickyRoundRobinLimit", "5"),
            SettingClass::Imported
        );
        assert_eq!(
            classify("providerStrategies", "{}"),
            SettingClass::AtDefault
        );
        assert_eq!(
            classify(
                "providerStrategies",
                r#"{"openai":{"fallbackStrategy":"least-used","stickyRoundRobinLimit":"2.5"}}"#
            ),
            SettingClass::Imported
        );
        assert!(matches!(
            classify(
                "providerStrategies",
                r#"{"x":{"fallbackStrategy":"health"}}"#
            ),
            SettingClass::Refused { .. }
        ));
        let rows = [
            ("fallbackStrategy".to_owned(), "\"random\"".to_owned()),
            (
                "providerStrategies".to_owned(),
                r#"{"openai":{"stickyRoundRobinLimit":"2.5"},"empty":{}}"#.to_owned(),
            ),
        ];
        let strategies = legacy_provider_strategies(&rows).unwrap();
        assert_eq!(
            strategies.for_provider("openai"),
            (crate::account_rotation::AccountStrategy::Random, 3)
        );
        assert_eq!(strategies.providers.len(), 1);
        assert_eq!(
            classify("modelLockout", r#"{"maxCooldownMs":600000}"#),
            SettingClass::Imported
        );
        assert_eq!(
            model_lockout_ceiling(r#"{"maxCooldownMs":600000}"#),
            Ok(600_000)
        );
        // The legacy resolveModelLockoutSettings coercions: the opt-in
        // policy imports instead of refusing the row.
        let policy = legacy_model_lockout_policy(
            r#"{"enabled":"1","errorCodes":[429,"503",99,600,429.5],"baseCooldownMs":1000,"useExponentialBackoff":0,"maxBackoffSteps":3}"#,
        );
        assert_eq!(
            policy,
            crate::availability::ModelLockoutPolicy {
                enabled: true,
                error_codes: vec![429, 503],
                base_cooldown_ms: 5_000,
                use_exponential_backoff: false,
            }
        );
        assert_eq!(
            legacy_model_lockout_policy(r#"{"errorCodes":[1]}"#),
            crate::availability::ModelLockoutPolicy::default()
        );
        assert_eq!(
            classify("modelLockout", r#"{"enabled":true}"#),
            SettingClass::Imported
        );
        assert_eq!(
            classify("modelLockout", r#"{"maxBackoffSteps":3}"#),
            SettingClass::AtDefault
        );
        assert_eq!(
            classify(
                "modelLockout",
                r#"{"enabled":false,"maxCooldownMs":1800000}"#
            ),
            SettingClass::AtDefault
        );
        // The ceiling never drops below the clamped base.
        assert_eq!(
            model_lockout_ceiling(r#"{"maxCooldownMs":1000,"baseCooldownMs":300000}"#),
            Ok(300_000)
        );
        assert_eq!(
            model_lockout_ceiling(r#"{"maxCooldownMs":"9e9"}"#),
            Ok(3_600_000)
        );
        assert!(matches!(
            classify("hideNoThinkVariants", "true"),
            SettingClass::Equivalent { .. }
        ));
        assert_eq!(
            classify("hideNoThinkVariants", "false"),
            SettingClass::AtDefault
        );
        for (raw, class) in [
            (r#""enabled""#, SettingClass::AtDefault),
            (r#""bogus""#, SettingClass::AtDefault),
            (r#""bypass""#, SettingClass::Imported),
            (r#""bypass-strict""#, SettingClass::Imported),
        ] {
            assert_eq!(
                classify("antigravitySignatureCacheMode", raw),
                class,
                "{raw}"
            );
        }
        assert_eq!(
            classify("claudeClassifierCompat", r#""off""#),
            SettingClass::AtDefault
        );
        assert_eq!(
            classify("claudeClassifierCompat", r#""auto""#),
            SettingClass::Imported
        );
        assert_eq!(
            classify("claudeClassifierCompat", r#""always""#),
            SettingClass::Imported
        );
        assert_eq!(
            classify("credentialRedactionEnabled", "true"),
            SettingClass::Imported
        );
        assert_eq!(
            classify("credentialRedactionEnabled", "false"),
            SettingClass::AtDefault
        );
        assert_eq!(
            classify("comboAutoPromoteEnabled", "true"),
            SettingClass::Imported
        );
        assert_eq!(
            classify("comboAutoPromoteEnabled", "false"),
            SettingClass::AtDefault
        );
        // Ported from tests/unit/responses-state-policy.test.ts.
        for (raw, class) in [
            (r#""auto""#, SettingClass::AtDefault),
            (r#""bogus""#, SettingClass::AtDefault),
            (r#""preserve""#, SettingClass::Imported),
            (r#""strip""#, SettingClass::Imported),
        ] {
            assert_eq!(
                classify("responsesPreviousResponseIdMode", raw),
                class,
                "{raw}"
            );
        }
        // Ported from tests/unit/codex-fast-tier.test.ts and
        // codex-connection-defaults.test.ts.
        let codex = |rows: &[(&str, &str)]| {
            let rows: Vec<_> = rows
                .iter()
                .map(|(key, raw)| ((*key).to_owned(), (*raw).to_owned()))
                .collect();
            legacy_codex_service_tier(&rows)
        };
        assert_eq!(
            classify("codexServiceTier", r#"{"enabled":false}"#),
            SettingClass::AtDefault
        );
        assert_eq!(
            classify("codexServiceTier", r#"{"enabled":true}"#),
            SettingClass::Imported
        );
        assert_eq!(classify("codexServiceTier", "true"), SettingClass::Imported);
        assert_eq!(
            classify("codexFastServiceTier", "true"),
            SettingClass::Imported
        );
        assert_eq!(
            classify("codexFastServiceTier", "false"),
            SettingClass::AtDefault
        );
        assert!(matches!(
            classify(
                "codexConnectionDefaultsMigrationV1",
                r#"{"completedAt":"x"}"#
            ),
            SettingClass::Equivalent { .. }
        ));
        let flex = codex(&[
            (
                "codexServiceTier",
                r#"{"enabled":true,"tier":" Flex ","supportedModels":["gpt-5.5"," "]}"#,
            ),
            ("codexConnectionDefaultsMigrationV1", "{}"),
        ]);
        assert!(flex.enabled);
        assert_eq!(flex.tier.as_deref(), Some("flex"));
        assert_eq!(flex.supported_models, ["gpt-5.5"]);
        assert_eq!(flex.unmigrated_connection_tier, None);
        // The default model list is kept implicit.
        let listed = format!(
            r#"{{"enabled":true,"supportedModels":{}}}"#,
            serde_json::to_string(&crate::codex_request::FAST_TIER_DEFAULT_MODELS).unwrap()
        );
        assert!(codex(&[("codexServiceTier", listed.as_str())])
            .supported_models
            .is_empty());
        // The defaults migration gives connections priority unless it ran or
        // the tier is not the old Fast switch.
        assert_eq!(
            codex(&[("codexServiceTier", r#"{"enabled":true}"#)])
                .unmigrated_connection_tier
                .as_deref(),
            Some("priority")
        );
        assert_eq!(
            codex(&[("codexServiceTier", r#"{"enabled":true,"tier":"default"}"#)])
                .unmigrated_connection_tier,
            None
        );
        assert_eq!(
            codex(&[("codexServiceTier", "true")]).unmigrated_connection_tier,
            None
        );
        // The early flag applies only when the current row is not a setting.
        assert!(codex(&[("codexFastServiceTier", "true")]).enabled);
        assert!(
            !codex(&[
                ("codexServiceTier", "false"),
                ("codexFastServiceTier", "true")
            ])
            .enabled
        );
        assert!(
            codex(&[
                ("codexServiceTier", "null"),
                ("codexFastServiceTier", "true")
            ])
            .enabled
        );
        assert_eq!(classify("claudeFastMode", "true"), SettingClass::Imported);
        assert_eq!(
            classify(
                "claudeFastMode",
                r#"{"enabled":false,"supportedModels":["x"]}"#
            ),
            SettingClass::AtDefault
        );
        assert_eq!(
            legacy_claude_fast_mode(r#"{"enabled":true,"supportedModels":[" claude-x ",""]}"#),
            crate::global_settings::ClaudeFastMode {
                enabled: true,
                supported_models: vec!["claude-x".to_owned()],
            }
        );
        assert!(legacy_claude_fast_mode(
            r#"{"enabled":true,"supportedModels":["claude-fable-5","claude-opus-5","claude-opus-4-8","claude-opus-4-7","claude-opus-4-6"]}"#
        )
        .supported_models
        .is_empty());
        assert_eq!(
            classify("alwaysPreserveClientCache", "\"always\""),
            SettingClass::Imported
        );
        assert_eq!(
            classify("alwaysPreserveClientCache", "\"auto\""),
            SettingClass::AtDefault
        );
        assert_eq!(
            classify("alwaysPreserveClientCache", "\"odd\""),
            SettingClass::AtDefault
        );
        assert_eq!(classify("maxBodySizeMb", "25"), SettingClass::Imported);
        assert_eq!(classify("maxBodySizeMb", "0"), SettingClass::AtDefault);
        assert_eq!(
            classify("maxBodySizeMb", "\"abc\""),
            SettingClass::AtDefault
        );
        assert_eq!(
            classify("idempotencyWindowMs", "9000"),
            SettingClass::Imported
        );
        assert_eq!(
            classify("idempotencyWindowMs", "\"9000\""),
            SettingClass::AtDefault
        );
        assert_eq!(
            classify("autoRefreshProviderQuota", "true"),
            SettingClass::Dashboard
        );
        // Cloud sync is a real feature, still refused when enabled.
        assert!(matches!(
            classify("cloudEnabled", "true"),
            SettingClass::Refused { .. }
        ));
        assert_eq!(classify("logToolSources", "true"), SettingClass::Diagnostic);
        assert_eq!(
            classify("payloadRules", "{}"),
            SettingClass::Consumed {
                importer: "legacy_payload_rules"
            }
        );
        assert!(matches!(
            classify("somethingNew", "1"),
            SettingClass::Refused { .. }
        ));
    }

    #[test]
    fn resilience_settings_map_onto_native_runtime_settings() {
        // An empty object resolves to the legacy defaults, which the native
        // defaults match.
        let defaults = resilience_import("{}").unwrap();
        assert_eq!(
            defaults,
            ResilienceImport {
                quota_preflight_enabled: false,
                quota_preflight_threshold_percent: 2,
                cooldown: [(5_000, false, 8), (3_000, true, 5)],
                breaker: [(8, 5, 60_000), (12, 7, 30_000)],
            }
        );
        // Partial profiles merge with the defaults; values truncate and clamp
        // like the legacy normalizers, and numeric strings count.
        let mapped = resilience_import(
            r#"{"connectionCooldown":{"apikey":{"baseCooldownMs":"1500.9","maxBackoffSteps":-3}},
                "providerBreaker":{"oauth":{"failureThreshold":4,"degradationThreshold":9,"resetTimeoutMs":10}},
                "quotaPreflight":{"enabled":true,"defaultThresholdPercent":5}}"#,
        )
        .unwrap();
        assert_eq!(mapped.cooldown[1], (1_500, true, 0));
        assert_eq!(mapped.cooldown[0], (5_000, false, 8));
        assert_eq!(mapped.breaker[0], (4, 3, 1_000));
        assert!(mapped.quota_preflight_enabled);
        assert_eq!(mapped.quota_preflight_threshold_percent, 5);
        // A section without a native equivalent must stay at its default.
        assert!(resilience_import(r#"{"waitForCooldown":{"enabled":true}}"#).is_ok());
        assert!(resilience_import(r#"{"quotaShareConcurrencyLimit":{"enabled":false}}"#).is_ok());
        assert!(resilience_import(r#"{"requestQueue":{"requestsPerMinute":7}}"#).is_ok());
        assert!(resilience_import(r#"{"requestQueue":{"executionMaxWaitMs":5000}}"#).is_ok());
        assert_eq!(
            legacy_provider_quota_overrides(&serde_json::json!({
                "nvidia":{"rpm":"30","concurrency":2.9,"providerConcurrency":0},
                "groq":{"rpm":0},
                "bad":7
            }))
            .unwrap(),
            std::collections::BTreeMap::from([(
                "nvidia".to_owned(),
                crate::request_queue::ProviderQuotaOverride {
                    rpm: Some(30),
                    concurrency: Some(2),
                    provider_concurrency: Some(0),
                }
            )])
        );
        assert!(resilience_import(r#"{"providerQuotaOverrides":{"nvidia":{"rpm":30}}}"#).is_ok());
        // Old providerProfiles rows are the cooldown and breaker fallback.
        let profiles = serde_json::json!({
            "apikey":{"transientCooldown":2000,"rateLimitCooldown":4000,"maxBackoffLevel":3,"circuitBreakerThreshold":9,"circuitBreakerReset":20000}
        });
        let mapped = resilience_import_with("{}", Some(&profiles)).unwrap();
        // A non-zero rateLimitCooldown turns the upstream hints off and
        // raises the base to the larger cooldown.
        assert_eq!(mapped.cooldown[1], (4_000, false, 3));
        assert_eq!((mapped.breaker[1].0, mapped.breaker[1].2), (9, 20_000));
        assert_eq!(
            classify("providerProfiles", &profiles.to_string()),
            SettingClass::Imported
        );
        assert_eq!(classify("providerProfiles", "{}"), SettingClass::AtDefault);
        assert_eq!(
            legacy_request_queue(&[(
                "rateLimitDefaults".to_owned(),
                r#"{"requestsPerMinute":30,"minTimeBetweenRequests":100}"#.to_owned(),
            )])
            .unwrap(),
            crate::request_queue::RequestQueue {
                enabled: true,
                requests_per_minute: 30,
                min_time_between_requests_ms: 100,
                ..crate::request_queue::RequestQueue::default()
            }
        );
        assert_eq!(classify("rateLimitDefaults", "{}"), SettingClass::AtDefault);
        assert!(resilience_import(r#"{"requestQueue":{"globalConcurrentRequests":2}}"#).is_ok());
        assert_eq!(
            legacy_request_queue(&[]).unwrap(),
            crate::request_queue::RequestQueue {
                enabled: true,
                ..crate::request_queue::RequestQueue::default()
            }
        );
        assert_eq!(
            legacy_provider_cooldown(&[(
                "resilienceSettings".to_owned(),
                r#"{"providerCooldown":{"enabled":true,"minRetryCooldownMs":"2000","maxRetryCooldownMs":1}}"#.to_owned(),
            )]),
            crate::provider_cooldown::ProviderCooldown {
                enabled: true,
                min_retry_cooldown_ms: 2_000,
                // The ceiling is floored at the base cooldown.
                max_retry_cooldown_ms: 2_000,
            }
        );
        assert_eq!(
            resilience_import(r#"{"streamRecovery":{"enabled":true}}"#),
            Err("legacy resilience section has no native equivalent yet")
        );
        assert_eq!(
            resilience_import(r#"{"somethingNew":{}}"#),
            Err("legacy resilience section is not in the migration inventory")
        );
        assert_eq!(
            resilience_import(r#"{"connectionCooldown":{"oauth":{"baseCooldownMs":600000}}}"#),
            Err("legacy connection cooldown exceeds the native ceiling")
        );
        assert_eq!(
            resilience_import(
                r#"{"connectionCooldown":{"oauth":{"useUpstream429BreakerHints":true}}}"#
            ),
            Err("legacy upstream 429 breaker hints require migration")
        );
        assert!(resilience_import(
            r#"{"connectionCooldown":{"oauth":{"useUpstream429BreakerHints":null}}}"#
        )
        .is_ok());
        assert_eq!(
            resilience_import(r#"{"quotaPreflight":{"warnThresholdPercent":40}}"#),
            Err("legacy quota warning threshold has no native equivalent yet")
        );
        // A cutoff above the default warn moves the warn with it, as legacy.
        assert!(resilience_import(r#"{"quotaPreflight":{"defaultThresholdPercent":30}}"#).is_ok());
        assert_eq!(
            resilience_import(
                r#"{"quotaPreflight":{"providerWindowDefaults":{"codex":{"weekly":5}}}}"#
            ),
            Err("legacy per-window quota cutoffs require migration")
        );
        assert!(resilience_import("[]").is_err());
        assert_eq!(classify("resilienceSettings", "{}"), SettingClass::Imported);
        assert_eq!(
            classify("modelLockout", r#"{"enabled":false}"#),
            SettingClass::AtDefault
        );
        // The opt-in policy now imports onto model_lockout_policy.
        assert_eq!(
            classify("modelLockout", r#"{"enabled":true}"#),
            SettingClass::Imported
        );
    }

    #[test]
    fn the_seeded_detailed_logging_flag_imports_only_while_off() {
        for raw in ["0", "false", "1", "\"0\"", "null"] {
            assert!(
                matches!(
                    classify("call_log_pipeline_enabled", raw),
                    SettingClass::Equivalent { .. }
                ),
                "{raw}"
            );
        }
        for raw in ["true", "\"1\"", "\"true\""] {
            assert!(
                matches!(
                    classify("call_log_pipeline_enabled", raw),
                    SettingClass::Refused { .. }
                ),
                "{raw}"
            );
        }
    }

    #[test]
    fn the_combo_strategy_toggle_mirror_is_a_dashboard_preference() {
        for raw in [r#""round-robin""#, r#""fallback""#] {
            assert_eq!(classify("comboStrategy", raw), SettingClass::Dashboard);
        }
    }

    #[test]
    fn the_local_only_manage_scope_bypass_has_nothing_to_open_natively() {
        for (key, raw) in [
            ("localOnlyManageScopeBypassEnabled", "false"),
            ("localOnlyManageScopeBypassEnabled", "true"),
            (
                "localOnlyManageScopeBypassPrefixes",
                r#"["/api/mcp/","/api/custom/"]"#,
            ),
            ("localOnlyManageScopeBypassPrefixes", "[]"),
        ] {
            assert!(
                matches!(classify(key, raw), SettingClass::Equivalent { .. }),
                "{key}={raw}"
            );
        }
    }

    #[test]
    fn the_inventory_lists_are_disjoint_and_the_snapshot_loads() {
        assert!(DEFAULTS.len() >= 80);
        for (key, _) in CONSUMED {
            assert!(!DASHBOARD.contains(key), "{key}");
        }
    }
}
