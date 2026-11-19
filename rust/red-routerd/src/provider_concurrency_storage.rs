//! Revision-bound per-account concurrency cap (legacy
//! `provider_connections.max_concurrent`); missing records mean no cap.
use super::*;
use std::collections::HashMap;

pub(super) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_provider_concurrency (record_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, max_concurrent BIGINT NOT NULL, revision BIGINT NOT NULL)";
const SELECT: &str =
    "SELECT provider_id,max_concurrent,revision FROM redrouter_control_provider_concurrency";
const UPSERT: &str = "INSERT INTO redrouter_control_provider_concurrency (record_id,provider_id,max_concurrent,revision) VALUES ($1,$2,$3,$4) ON CONFLICT (record_id) DO UPDATE SET max_concurrent=$3";
const DELETE_REVISION: &str =
    "DELETE FROM redrouter_control_provider_concurrency WHERE record_id=$1";
const DELETE: &str = "DELETE FROM redrouter_control_provider_concurrency WHERE provider_id=$1";

/// The largest cap an account may declare.
pub(crate) const MAX_PROVIDER_CONCURRENCY: u32 = 1_000;

impl Database {
    pub(super) async fn provider_concurrency(
        &self,
    ) -> Result<HashMap<(String, i64), u32>, &'static str> {
        let cap = |value: i64| {
            u32::try_from(value)
                .ok()
                .filter(|value| (1..=MAX_PROVIDER_CONCURRENCY).contains(value))
                .ok_or("invalid provider concurrency")
        };
        let rows = match self {
            Self::Sql(pool) => {
                return sqlx::query(SELECT)
                    .fetch_all(pool)
                    .await
                    .map_err(|_| "cannot read provider concurrency")?
                    .iter()
                    .map(|row| {
                        let id: String = row
                            .try_get("provider_id")
                            .map_err(|_| "invalid provider concurrency")?;
                        let revision: i64 = row
                            .try_get("revision")
                            .map_err(|_| "invalid provider concurrency")?;
                        let value: i64 = row
                            .try_get("max_concurrent")
                            .map_err(|_| "invalid provider concurrency")?;
                        Ok(((id, revision), cap(value)?))
                    })
                    .collect();
            }
            Self::Remote(_) => self.remote_query(SELECT, &[]).await?.rows,
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query(SELECT)
                    .await
                    .map_err(|_| "cannot read provider concurrency")?
                    .rows
            }
        };
        rows.iter()
            .map(|row| {
                let field = |name: &str| {
                    row.iter()
                        .find(|(column, _)| column.eq_ignore_ascii_case(name))
                };
                let id = match field("provider_id") {
                    Some((_, reddb_client::ValueOut::String(value))) => value.clone(),
                    _ => return Err("invalid provider concurrency"),
                };
                let integer = |name: &str| match field(name) {
                    Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
                    _ => Err("invalid provider concurrency"),
                };
                Ok(((id, integer("revision")?), cap(integer("max_concurrent")?)?))
            })
            .collect()
    }

    pub(super) async fn upsert_provider_concurrency(
        &self,
        provider: &StoredProvider,
    ) -> Result<(), &'static str> {
        let record_id = format!("{}:{}", provider.id, provider.updated_at);
        let Some(max_concurrent) = provider.max_concurrent else {
            // No cap is the default; clear this exact revision.
            match self {
                Self::Sql(pool) => {
                    sqlx::query(DELETE_REVISION)
                        .bind(&record_id)
                        .execute(pool)
                        .await
                        .map_err(|_| "cannot clear provider concurrency")?;
                }
                Self::Remote(_) => {
                    self.remote_query(DELETE_REVISION, &[reddb_client::Value::Text(record_id)])
                        .await?;
                }
                #[cfg(feature = "reddb-embedded")]
                Self::Embedded { db, .. } => {
                    db.query_with(DELETE_REVISION, vec![reddb_client::Value::Text(record_id)])
                        .await
                        .map_err(|_| "cannot clear provider concurrency")?;
                }
            }
            return Ok(());
        };
        if !(1..=MAX_PROVIDER_CONCURRENCY).contains(&max_concurrent) {
            return Err("invalid provider concurrency");
        }
        let params = || {
            vec![
                reddb_client::Value::Text(record_id.clone()),
                reddb_client::Value::Text(provider.id.clone()),
                reddb_client::Value::Int(i64::from(max_concurrent)),
                reddb_client::Value::Int(provider.updated_at),
            ]
        };
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT)
                    .bind(&record_id)
                    .bind(&provider.id)
                    .bind(i64::from(max_concurrent))
                    .bind(provider.updated_at)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider concurrency")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT, params())
                    .await
                    .map_err(|_| "cannot write provider concurrency")?;
            }
        }
        Ok(())
    }

    pub(crate) async fn delete_provider_concurrency(&self, id: &str) -> Result<(), &'static str> {
        let params = || vec![reddb_client::Value::Text(id.to_owned())];
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE)
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete provider concurrency")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(DELETE, params())
                    .await
                    .map_err(|_| "cannot delete provider concurrency")?;
            }
        }
        Ok(())
    }
}
