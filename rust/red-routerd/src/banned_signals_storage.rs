//! The operator's custom account-ban signals (legacy `customBannedSignals`),
//! one global row. A missing row means none.
use super::*;

pub(super) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_banned_signals (id BIGINT PRIMARY KEY, signals_json TEXT NOT NULL, revision BIGINT NOT NULL)";
const SELECT: &str = "SELECT signals_json FROM redrouter_control_banned_signals WHERE id = 1";
const UPSERT: &str = "INSERT INTO redrouter_control_banned_signals (id, signals_json, revision) VALUES (1,$1,$2) ON CONFLICT (id) DO UPDATE SET signals_json = $1, revision = $2";

impl Database {
    pub async fn custom_banned_signals(&self) -> Result<Vec<String>, &'static str> {
        let raw: Option<String> = match self {
            Self::Sql(pool) => sqlx::query_scalar(SELECT)
                .fetch_optional(pool)
                .await
                .map_err(|_| "cannot read custom banned signals")?,
            Self::Remote(_) => first_text(self.remote_query(SELECT, &[]).await?.rows)?,
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => first_text(
                db.query(SELECT)
                    .await
                    .map_err(|_| "cannot read custom banned signals")?
                    .rows,
            )?,
        };
        match raw {
            None => Ok(Vec::new()),
            Some(raw) => serde_json::from_str(&raw).map_err(|_| "invalid custom banned signals"),
        }
    }

    pub async fn upsert_custom_banned_signals(
        &self,
        signals: &[String],
        revision: i64,
    ) -> Result<(), &'static str> {
        let json = serde_json::to_string(signals).map_err(|_| "invalid custom banned signals")?;
        let params = || {
            vec![
                reddb_client::Value::Text(json.clone()),
                reddb_client::Value::Int(revision),
            ]
        };
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT)
                    .bind(&json)
                    .bind(revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write custom banned signals")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT, params())
                    .await
                    .map_err(|_| "cannot write custom banned signals")?;
            }
        }
        Ok(())
    }
}

fn first_text(rows: Vec<reddb_client::Row>) -> Result<Option<String>, &'static str> {
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case("signals_json"))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(Some(value.clone())),
        _ => Err("invalid custom banned signals"),
    }
}
