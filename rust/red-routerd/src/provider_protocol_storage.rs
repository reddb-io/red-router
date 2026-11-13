//! Revision-bound transport configuration; readers never mix an old provider with
//! a newly prepared protocol. Legacy rows without this setting retain URL detection.
use super::*;
use std::collections::HashMap;

pub(super) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_provider_protocols (record_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, protocol TEXT NOT NULL, revision BIGINT NOT NULL)";
const SELECT: &str =
    "SELECT provider_id,protocol,revision FROM redrouter_control_provider_protocols";
const UPSERT: &str = "INSERT INTO redrouter_control_provider_protocols (record_id,provider_id,protocol,revision) VALUES ($1,$2,$3,$4) ON CONFLICT (record_id) DO UPDATE SET protocol=$3";
const DELETE: &str = "DELETE FROM redrouter_control_provider_protocols WHERE provider_id=$1";

impl Database {
    pub(super) async fn provider_protocols(
        &self,
    ) -> Result<HashMap<(String, i64), String>, &'static str> {
        let rows = match self {
            Self::Sql(pool) => {
                return sqlx::query(SELECT)
                    .fetch_all(pool)
                    .await
                    .map_err(|_| "cannot read provider protocols")?
                    .iter()
                    .map(|row| {
                        let id: String = row
                            .try_get("provider_id")
                            .map_err(|_| "invalid provider protocol")?;
                        let revision: i64 = row
                            .try_get("revision")
                            .map_err(|_| "invalid provider protocol")?;
                        let protocol: String = row
                            .try_get("protocol")
                            .map_err(|_| "invalid provider protocol")?;
                        Ok(((id, revision), protocol))
                    })
                    .collect();
            }
            Self::Remote(_) => self.remote_query(SELECT, &[]).await?.rows,
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query(SELECT)
                    .await
                    .map_err(|_| "cannot read provider protocols")?
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
                    _ => Err("invalid provider protocol"),
                };
                let revision = match row
                    .iter()
                    .find(|(column, _)| column.eq_ignore_ascii_case("revision"))
                {
                    Some((_, reddb_client::ValueOut::Integer(value))) => *value,
                    _ => return Err("invalid provider protocol"),
                };
                Ok(((text("provider_id")?, revision), text("protocol")?))
            })
            .collect()
    }

    pub(super) async fn upsert_provider_protocol(
        &self,
        provider: &StoredProvider,
    ) -> Result<(), &'static str> {
        let record_id = format!("{}:{}", provider.id, provider.updated_at);
        let params = || {
            vec![
                reddb_client::Value::Text(record_id.clone()),
                reddb_client::Value::Text(provider.id.clone()),
                reddb_client::Value::Text(provider.protocol.clone()),
                reddb_client::Value::Int(provider.updated_at),
            ]
        };
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT)
                    .bind(&record_id)
                    .bind(&provider.id)
                    .bind(&provider.protocol)
                    .bind(provider.updated_at)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider protocol")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT, params())
                    .await
                    .map_err(|_| "cannot write provider protocol")?;
            }
        }
        Ok(())
    }

    pub(crate) async fn delete_provider_protocols(&self, id: &str) -> Result<(), &'static str> {
        let params = || vec![reddb_client::Value::Text(id.to_owned())];
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE)
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete provider protocols")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(DELETE, params())
                    .await
                    .map_err(|_| "cannot delete provider protocols")?;
            }
        }
        Ok(())
    }
}
