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
    let defaults = &SNAPSHOT.resilience_defaults;
    let Value::Object(stored) = parse_value(raw) else {
        return Err("legacy resilience settings are not an object");
    };
    for (section, value) in &stored {
        let Some(default) = defaults.get(section) else {
            return Err("legacy resilience section is not in the migration inventory");
        };
        if matches!(
            section.as_str(),
            "connectionCooldown" | "providerBreaker" | "quotaPreflight"
        ) {
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
        "customBannedSignals" => {
            return match custom_banned_signals(raw) {
                Ok(_) => SettingClass::Imported,
                Err(reason) => SettingClass::Refused { reason },
            };
        }
        "modelLockout" => {
            let default = &SNAPSHOT.model_lockout_defaults;
            return if merged(default, &parse_value(raw)) == *default {
                SettingClass::AtDefault
            } else {
                SettingClass::Refused {
                    reason: "legacy model lockout settings have no native equivalent yet",
                }
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
    let mapped = rows
        .iter()
        .find(|(key, _)| key == "resilienceSettings")
        .map(|(_, raw)| resilience_import(raw))
        .transpose()?;
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
    let Some(mapped) = mapped else {
        return Ok(SettingsImport {
            runtime_settings_imported: false,
            custom_banned_signals: signals.len(),
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
            SettingClass::AtDefault
        );
        // A raw string that is not JSON compares as a string, as legacy parses it.
        assert_eq!(
            classify("comboStrategy", "fallback"),
            SettingClass::AtDefault
        );
        assert!(matches!(
            classify("requestRetry", "5"),
            SettingClass::Refused { .. }
        ));
        assert_eq!(classify("theme", "\"dark\""), SettingClass::Dashboard);
        assert_eq!(classify("debugMode", "true"), SettingClass::Dashboard);
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
        assert_eq!(
            resilience_import(r#"{"waitForCooldown":{"enabled":false}}"#),
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
        assert!(matches!(
            classify("modelLockout", r#"{"enabled":true}"#),
            SettingClass::Refused { .. }
        ));
    }

    #[test]
    fn the_inventory_lists_are_disjoint_and_the_snapshot_loads() {
        assert!(DEFAULTS.len() >= 80);
        for (key, _) in CONSUMED {
            assert!(!DASHBOARD.contains(key), "{key}");
        }
    }
}
