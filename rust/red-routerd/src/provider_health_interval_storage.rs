//! Revision-bound per-account credential health cadence (legacy
//! `provider_connections.healthCheckInterval`, minutes): 0 never probes the
//! account; a missing record follows the global sweep cadence.
use super::*;
use std::collections::HashMap;

pub(super) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_provider_health_intervals (record_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, interval_minutes BIGINT NOT NULL, revision BIGINT NOT NULL)";
const SELECT: &str =
    "SELECT provider_id,interval_minutes,revision FROM redrouter_control_provider_health_intervals";
const UPSERT: &str = "INSERT INTO redrouter_control_provider_health_intervals (record_id,provider_id,interval_minutes,revision) VALUES ($1,$2,$3,$4) ON CONFLICT (record_id) DO UPDATE SET interval_minutes=$3";
const DELETE_REVISION: &str =
    "DELETE FROM redrouter_control_provider_health_intervals WHERE record_id=$1";
const DELETE: &str = "DELETE FROM redrouter_control_provider_health_intervals WHERE provider_id=$1";

/// The longest per-account cadence (legacy schema `max(1440)`, a day).
pub(crate) const MAX_PROVIDER_HEALTH_INTERVAL_MINUTES: u32 = 1_440;

impl Database {
    pub(super) async fn provider_health_intervals(
        &self,
    ) -> Result<HashMap<(String, i64), u32>, &'static str> {
        let minutes = |value: i64| {
            u32::try_from(value)
                .ok()
                .filter(|value| *value <= MAX_PROVIDER_HEALTH_INTERVAL_MINUTES)
                .ok_or("invalid provider health interval")
        };
        let rows = match self {
            Self::Sql(pool) => {
                return sqlx::query(SELECT)
                    .fetch_all(pool)
                    .await
                    .map_err(|_| "cannot read provider health intervals")?
                    .iter()
                    .map(|row| {
                        let id: String = row
                            .try_get("provider_id")
                            .map_err(|_| "invalid provider health interval")?;
                        let revision: i64 = row
                            .try_get("revision")
                            .map_err(|_| "invalid provider health interval")?;
                        let value: i64 = row
                            .try_get("interval_minutes")
                            .map_err(|_| "invalid provider health interval")?;
                        Ok(((id, revision), minutes(value)?))
                    })
                    .collect();
            }
            Self::Remote(_) => self.remote_query(SELECT, &[]).await?.rows,
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query(SELECT)
                    .await
                    .map_err(|_| "cannot read provider health intervals")?
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
                    _ => return Err("invalid provider health interval"),
                };
                let integer = |name: &str| match field(name) {
                    Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
                    _ => Err("invalid provider health interval"),
                };
                Ok((
                    (id, integer("revision")?),
                    minutes(integer("interval_minutes")?)?,
                ))
            })
            .collect()
    }

    pub(super) async fn upsert_provider_health_interval(
        &self,
        provider: &StoredProvider,
    ) -> Result<(), &'static str> {
        let record_id = format!("{}:{}", provider.id, provider.updated_at);
        let Some(minutes) = provider.health_check_interval_minutes else {
            // Following the global cadence is the default; clear this revision.
            match self {
                Self::Sql(pool) => {
                    sqlx::query(DELETE_REVISION)
                        .bind(&record_id)
                        .execute(pool)
                        .await
                        .map_err(|_| "cannot clear provider health interval")?;
                }
                Self::Remote(_) => {
                    self.remote_query(DELETE_REVISION, &[reddb_client::Value::Text(record_id)])
                        .await?;
                }
                #[cfg(feature = "reddb-embedded")]
                Self::Embedded { db, .. } => {
                    db.query_with(DELETE_REVISION, vec![reddb_client::Value::Text(record_id)])
                        .await
                        .map_err(|_| "cannot clear provider health interval")?;
                }
            }
            return Ok(());
        };
        if minutes > MAX_PROVIDER_HEALTH_INTERVAL_MINUTES {
            return Err("invalid provider health interval");
        }
        let params = || {
            vec![
                reddb_client::Value::Text(record_id.clone()),
                reddb_client::Value::Text(provider.id.clone()),
                reddb_client::Value::Int(i64::from(minutes)),
                reddb_client::Value::Int(provider.updated_at),
            ]
        };
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT)
                    .bind(&record_id)
                    .bind(&provider.id)
                    .bind(i64::from(minutes))
                    .bind(provider.updated_at)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider health interval")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT, params())
                    .await
                    .map_err(|_| "cannot write provider health interval")?;
            }
        }
        Ok(())
    }

    pub(crate) async fn delete_provider_health_intervals(
        &self,
        id: &str,
    ) -> Result<(), &'static str> {
        let params = || vec![reddb_client::Value::Text(id.to_owned())];
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE)
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete provider health intervals")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(DELETE, params())
                    .await
                    .map_err(|_| "cannot delete provider health intervals")?;
            }
        }
        Ok(())
    }
}
