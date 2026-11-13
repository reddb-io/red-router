//! Revision-bound account priority configuration; missing records use legacy priority 0.
use super::*;
use std::collections::HashMap;

pub(super) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_provider_priorities (record_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, account_rank BIGINT NOT NULL, revision BIGINT NOT NULL)";
const SELECT: &str =
    "SELECT provider_id,account_rank,revision FROM redrouter_control_provider_priorities";
const UPSERT: &str = "INSERT INTO redrouter_control_provider_priorities (record_id,provider_id,account_rank,revision) VALUES ($1,$2,$3,$4) ON CONFLICT (record_id) DO UPDATE SET account_rank=$3";
const DELETE_REVISION: &str =
    "DELETE FROM redrouter_control_provider_priorities WHERE record_id=$1";
const DELETE: &str = "DELETE FROM redrouter_control_provider_priorities WHERE provider_id=$1";

impl Database {
    pub(super) async fn provider_priorities(
        &self,
    ) -> Result<HashMap<(String, i64), i64>, &'static str> {
        let rows = match self {
            Self::Sql(pool) => {
                return sqlx::query(SELECT)
                    .fetch_all(pool)
                    .await
                    .map_err(|_| "cannot read provider priorities")?
                    .iter()
                    .map(|row| {
                        let id: String = row
                            .try_get("provider_id")
                            .map_err(|_| "invalid provider priority")?;
                        let revision: i64 = row
                            .try_get("revision")
                            .map_err(|_| "invalid provider priority")?;
                        let priority: i64 = row
                            .try_get("account_rank")
                            .map_err(|_| "invalid provider priority")?;
                        Ok(((id, revision), priority))
                    })
                    .collect();
            }
            Self::Remote(_) => self.remote_query(SELECT, &[]).await?.rows,
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query(SELECT)
                    .await
                    .map_err(|_| "cannot read provider priorities")?
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
                    _ => Err("invalid provider priority"),
                };
                let revision = match row
                    .iter()
                    .find(|(column, _)| column.eq_ignore_ascii_case("revision"))
                {
                    Some((_, reddb_client::ValueOut::Integer(value))) => *value,
                    _ => return Err("invalid provider priority"),
                };
                let priority = match row
                    .iter()
                    .find(|(column, _)| column.eq_ignore_ascii_case("account_rank"))
                {
                    Some((_, reddb_client::ValueOut::Integer(value))) => *value,
                    _ => return Err("invalid provider priority"),
                };
                Ok(((text("provider_id")?, revision), priority))
            })
            .collect()
    }

    pub(super) async fn upsert_provider_priority(
        &self,
        provider: &StoredProvider,
    ) -> Result<(), &'static str> {
        let record_id = format!("{}:{}", provider.id, provider.updated_at);
        // Zero is the legacy default; remove any value for this exact revision.
        if provider.priority == 0 {
            match self {
                Self::Sql(pool) => {
                    sqlx::query(DELETE_REVISION)
                        .bind(&record_id)
                        .execute(pool)
                        .await
                        .map_err(|_| "cannot clear provider priority")?;
                }
                Self::Remote(_) => {
                    self.remote_query(DELETE_REVISION, &[reddb_client::Value::Text(record_id)])
                        .await?;
                }
                #[cfg(feature = "reddb-embedded")]
                Self::Embedded { db, .. } => {
                    db.query_with(DELETE_REVISION, vec![reddb_client::Value::Text(record_id)])
                        .await
                        .map_err(|_| "cannot clear provider priority")?;
                }
            }
            return Ok(());
        }
        let params = || {
            vec![
                reddb_client::Value::Text(record_id.clone()),
                reddb_client::Value::Text(provider.id.clone()),
                reddb_client::Value::Int(provider.priority),
                reddb_client::Value::Int(provider.updated_at),
            ]
        };
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT)
                    .bind(&record_id)
                    .bind(&provider.id)
                    .bind(provider.priority)
                    .bind(provider.updated_at)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider priority")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT, params())
                    .await
                    .map_err(|_| "cannot write provider priority")?;
            }
        }
        Ok(())
    }

    pub(crate) async fn delete_provider_priorities(&self, id: &str) -> Result<(), &'static str> {
        let params = || vec![reddb_client::Value::Text(id.to_owned())];
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE)
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete provider priorities")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(DELETE, params())
                    .await
                    .map_err(|_| "cannot delete provider priorities")?;
            }
        }
        Ok(())
    }
}
