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
}

static DEFAULTS: LazyLock<BTreeMap<String, Value>> = LazyLock::new(|| {
    serde_json::from_str::<Snapshot>(include_str!("legacy_settings_defaults.json"))
        .expect("the legacy settings defaults snapshot is valid JSON")
        .defaults
});

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
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "class")]
pub enum SettingClass {
    AtDefault,
    Consumed { importer: &'static str },
    Dashboard,
    Refused { reason: &'static str },
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
    let mut report = LegacySettingsReport::default();
    if has_table == 1 {
        let rows = sqlx::query("SELECT key, value FROM key_value WHERE namespace='settings'")
            .fetch_all(&mut connection)
            .await
            .map_err(|_| "cannot read legacy settings")?;
        for row in rows {
            let key: String = row.try_get("key").map_err(|_| "invalid legacy setting")?;
            let value: Option<String> =
                row.try_get("value").map_err(|_| "invalid legacy setting")?;
            // The legacy loader skips internal keys and rows without a value.
            let Some(value) = value.filter(|_| !key.starts_with('_')) else {
                continue;
            };
            report.settings.insert(key.clone(), classify(&key, &value));
        }
    }
    connection
        .close()
        .await
        .map_err(|_| "cannot close legacy database")?;
    Ok(report)
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
    fn the_inventory_lists_are_disjoint_and_the_snapshot_loads() {
        assert!(DEFAULTS.len() >= 80);
        for (key, _) in CONSUMED {
            assert!(!DASHBOARD.contains(key), "{key}");
        }
    }
}
