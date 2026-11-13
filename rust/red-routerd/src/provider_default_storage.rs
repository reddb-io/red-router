//! Revision-bound per-account default model; missing records mean no override.
use super::*;
use std::collections::HashMap;

pub(super) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_provider_defaults (record_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_name TEXT NOT NULL, revision BIGINT NOT NULL)";
const SELECT: &str =
    "SELECT provider_id,model_name,revision FROM redrouter_control_provider_defaults";
const UPSERT: &str = "INSERT INTO redrouter_control_provider_defaults (record_id,provider_id,model_name,revision) VALUES ($1,$2,$3,$4) ON CONFLICT (record_id) DO UPDATE SET model_name=$3";
const DELETE_REVISION: &str = "DELETE FROM redrouter_control_provider_defaults WHERE record_id=$1";
const DELETE: &str = "DELETE FROM redrouter_control_provider_defaults WHERE provider_id=$1";

impl Database {
    pub(super) async fn provider_defaults(
        &self,
    ) -> Result<HashMap<(String, i64), String>, &'static str> {
        let rows = match self {
            Self::Sql(pool) => {
                return sqlx::query(SELECT)
                    .fetch_all(pool)
                    .await
                    .map_err(|_| "cannot read provider defaults")?
                    .iter()
                    .map(|row| {
                        let id: String = row
                            .try_get("provider_id")
                            .map_err(|_| "invalid provider model_name")?;
                        let revision: i64 = row
                            .try_get("revision")
                            .map_err(|_| "invalid provider model_name")?;
                        let model_name: String = row
                            .try_get("model_name")
                            .map_err(|_| "invalid provider model_name")?;
                        Ok(((id, revision), model_name))
                    })
                    .collect();
            }
            Self::Remote(_) => self.remote_query(SELECT, &[]).await?.rows,
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query(SELECT)
                    .await
                    .map_err(|_| "cannot read provider defaults")?
                    .rows
            }
        };
        rows.iter()
            .map(|row| {
                let text = |name: &str| match row
                    .iter()
                    .find(|(column, _)| column.eq_ignore_ascii_case(name))
                {
                    Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
                    _ => Err("invalid provider model_name"),
                };
                let revision = match row
                    .iter()
                    .find(|(column, _)| column.eq_ignore_ascii_case("revision"))
                {
                    Some((_, reddb_client::ValueOut::Integer(value))) => *value,
                    _ => return Err("invalid provider model_name"),
                };
                Ok(((text("provider_id")?, revision), text("model_name")?))
            })
            .collect()
    }

    pub(super) async fn upsert_provider_default(
        &self,
        provider: &StoredProvider,
    ) -> Result<(), &'static str> {
        let record_id = format!("{}:{}", provider.id, provider.updated_at);
        // No override is the default; clear this exact revision.
        if provider.default_model.is_none() {
            match self {
                Self::Sql(pool) => {
                    sqlx::query(DELETE_REVISION)
                        .bind(&record_id)
                        .execute(pool)
                        .await
                        .map_err(|_| "cannot clear provider model_name")?;
                }
                Self::Remote(_) => {
                    self.remote_query(DELETE_REVISION, &[reddb_client::Value::Text(record_id)])
                        .await?;
                }
                #[cfg(feature = "reddb-embedded")]
                Self::Embedded { db, .. } => {
                    db.query_with(DELETE_REVISION, vec![reddb_client::Value::Text(record_id)])
                        .await
                        .map_err(|_| "cannot clear provider model_name")?;
                }
            }
            return Ok(());
        }
        let params = || {
            vec![
                reddb_client::Value::Text(record_id.clone()),
                reddb_client::Value::Text(provider.id.clone()),
                reddb_client::Value::Text(provider.default_model.clone().unwrap_or_default()),
                reddb_client::Value::Int(provider.updated_at),
            ]
        };
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT)
                    .bind(&record_id)
                    .bind(&provider.id)
                    .bind(provider.default_model.as_deref().unwrap_or_default())
                    .bind(provider.updated_at)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider model_name")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT, params())
                    .await
                    .map_err(|_| "cannot write provider model_name")?;
            }
        }
        Ok(())
    }

    pub(crate) async fn delete_provider_defaults(&self, id: &str) -> Result<(), &'static str> {
        let params = || vec![reddb_client::Value::Text(id.to_owned())];
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE)
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete provider defaults")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(DELETE, params())
                    .await
                    .map_err(|_| "cannot delete provider defaults")?;
            }
        }
        Ok(())
    }
}
