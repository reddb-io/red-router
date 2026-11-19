use red_routerd::legacy_settings::{self, SettingClass};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use tempfile::TempDir;

#[tokio::test]
async fn settings_inventory_classifies_rows_without_exposing_or_modifying_them() {
    let directory = TempDir::new().unwrap();
    let path = directory.path().join("legacy.sqlite");
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let mut db = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::raw_sql(
        "CREATE TABLE key_value (namespace TEXT, key TEXT, value TEXT);
         INSERT INTO key_value VALUES
           ('settings','requestRetry','3'),
           ('settings','comboStrategy','\"round-robin\"'),
           ('settings','theme','\"secret-theme\"'),
           ('settings','payloadRules','{\"secret\":true}'),
           ('settings','unknownFutureSetting','\"secret-value\"'),
           ('settings','_internalCursor','\"skipped\"'),
           ('settings','nullValue',NULL),
           ('pricing','openai','{}');",
    )
    .execute(&mut db)
    .await
    .unwrap();
    db.close().await.unwrap();
    let before = tokio::fs::read(&path).await.unwrap();

    let report = legacy_settings::inspect(&path).await.unwrap();
    assert_eq!(report.settings["requestRetry"], SettingClass::AtDefault);
    assert_eq!(report.settings["theme"], SettingClass::Dashboard);
    assert_eq!(
        report.settings["payloadRules"],
        SettingClass::Consumed {
            importer: "legacy_payload_rules"
        }
    );
    assert!(matches!(
        report.settings["comboStrategy"],
        SettingClass::Refused { .. }
    ));
    // Internal and empty rows are skipped like the legacy loader does.
    assert!(!report.settings.contains_key("_internalCursor"));
    assert!(!report.settings.contains_key("nullValue"));
    let mut refused = report.refused().map(|(key, _)| key).collect::<Vec<_>>();
    refused.sort_unstable();
    assert_eq!(refused, ["comboStrategy", "unknownFutureSetting"]);
    // The report names keys only, never stored values.
    let encoded = serde_json::to_string(&report).unwrap();
    assert!(!encoded.contains("secret"));
    assert_eq!(before, tokio::fs::read(&path).await.unwrap());
}
