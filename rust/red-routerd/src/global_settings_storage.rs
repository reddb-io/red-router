//! Global gateway settings without a dedicated schema, one JSON value per
//! key (see `global_settings` for the accepted keys). A missing row means the
//! key's default.
use super::*;

pub(super) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_global_settings (setting_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, revision BIGINT NOT NULL)";
const SELECT: &str = "SELECT setting_key, value_json FROM redrouter_control_global_settings";
const UPSERT: &str = "INSERT INTO redrouter_control_global_settings (setting_key, value_json, revision) VALUES ($1,$2,$3) ON CONFLICT (setting_key) DO UPDATE SET value_json = $2, revision = $3";

impl Database {
    pub async fn global_settings(
        &self,
    ) -> Result<std::collections::BTreeMap<String, serde_json::Value>, &'static str> {
        let rows: Vec<(String, String)> = match self {
            Self::Sql(pool) => sqlx::query(SELECT)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read global settings")?
                .iter()
                .map(|row| {
                    let invalid = |_| "invalid global setting";
                    Ok((
                        row.try_get("setting_key").map_err(invalid)?,
                        row.try_get("value_json").map_err(invalid)?,
                    ))
                })
                .collect::<Result<_, &'static str>>()?,
            Self::Remote(_) => reddb_rows(self.remote_query(SELECT, &[]).await?.rows)?,
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => reddb_rows(
                db.query(SELECT)
                    .await
                    .map_err(|_| "cannot read global settings")?
                    .rows,
            )?,
        };
        rows.into_iter()
            .map(|(key, raw)| {
                serde_json::from_str(&raw)
                    .map(|value| (key, value))
                    .map_err(|_| "invalid global setting")
            })
            .collect()
    }

    pub async fn upsert_global_setting(
        &self,
        key: &str,
        value: &serde_json::Value,
        revision: i64,
    ) -> Result<(), &'static str> {
        let json = serde_json::to_string(value).map_err(|_| "invalid global setting")?;
        let params = || {
            vec![
                reddb_client::Value::Text(key.to_owned()),
                reddb_client::Value::Text(json.clone()),
                reddb_client::Value::Int(revision),
            ]
        };
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT)
                    .bind(key)
                    .bind(&json)
                    .bind(revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write global setting")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT, params())
                    .await
                    .map_err(|_| "cannot write global setting")?;
            }
        }
        Ok(())
    }
}

fn reddb_rows(rows: Vec<reddb_client::Row>) -> Result<Vec<(String, String)>, &'static str> {
    rows.iter()
        .map(|row| {
            let text = |name: &str| match row
                .iter()
                .find(|(column, _)| column.eq_ignore_ascii_case(name))
            {
                Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
                _ => Err("invalid global setting"),
            };
            Ok((text("setting_key")?, text("value_json")?))
        })
        .collect()
}
