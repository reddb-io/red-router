//! Revision-bound transport configuration; readers never mix an old provider with
//! a newly prepared node_id. Legacy rows remain standalone accounts.
use super::*;
use std::collections::HashMap;

pub(super) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_provider_node_bindings (record_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, node_id TEXT NOT NULL, revision BIGINT NOT NULL)";
const SELECT: &str =
    "SELECT provider_id,node_id,revision FROM redrouter_control_provider_node_bindings";
const UPSERT: &str = "INSERT INTO redrouter_control_provider_node_bindings (record_id,provider_id,node_id,revision) VALUES ($1,$2,$3,$4) ON CONFLICT (record_id) DO UPDATE SET node_id=$3";
const DELETE_REVISION: &str =
    "DELETE FROM redrouter_control_provider_node_bindings WHERE record_id=$1";
const DELETE: &str = "DELETE FROM redrouter_control_provider_node_bindings WHERE provider_id=$1";

impl Database {
    pub(super) async fn provider_node_bindings(
        &self,
    ) -> Result<HashMap<(String, i64), String>, &'static str> {
        let rows = match self {
            Self::Sql(pool) => {
                return sqlx::query(SELECT)
                    .fetch_all(pool)
                    .await
                    .map_err(|_| "cannot read provider node_ids")?
                    .iter()
                    .map(|row| {
                        let id: String = row
                            .try_get("provider_id")
                            .map_err(|_| "invalid provider node_id")?;
                        let revision: i64 = row
                            .try_get("revision")
                            .map_err(|_| "invalid provider node_id")?;
                        let node_id: String = row
                            .try_get("node_id")
                            .map_err(|_| "invalid provider node_id")?;
                        Ok(((id, revision), node_id))
                    })
                    .collect();
            }
            Self::Remote(_) => self.remote_query(SELECT, &[]).await?.rows,
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query(SELECT)
                    .await
                    .map_err(|_| "cannot read provider node_ids")?
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
                    _ => Err("invalid provider node_id"),
                };
                let revision = match row
                    .iter()
                    .find(|(column, _)| column.eq_ignore_ascii_case("revision"))
                {
                    Some((_, reddb_client::ValueOut::Integer(value))) => *value,
                    _ => return Err("invalid provider node_id"),
                };
                Ok(((text("provider_id")?, revision), text("node_id")?))
            })
            .collect()
    }

    pub(super) async fn upsert_provider_node_binding(
        &self,
        provider: &StoredProvider,
    ) -> Result<(), &'static str> {
        let record_id = format!("{}:{}", provider.id, provider.updated_at);
        let node_id = provider.node_id.clone().unwrap_or_default();
        // Standalone accounts have no binding. An explicit reset also clears this revision.
        if node_id.is_empty() {
            match self {
                Self::Sql(pool) => {
                    sqlx::query(DELETE_REVISION)
                        .bind(&record_id)
                        .execute(pool)
                        .await
                        .map_err(|_| "cannot clear provider node_id")?;
                }
                Self::Remote(_) => {
                    self.remote_query(DELETE_REVISION, &[reddb_client::Value::Text(record_id)])
                        .await?;
                }
                #[cfg(feature = "reddb-embedded")]
                Self::Embedded { db, .. } => {
                    db.query_with(DELETE_REVISION, vec![reddb_client::Value::Text(record_id)])
                        .await
                        .map_err(|_| "cannot clear provider node_id")?;
                }
            }
            return Ok(());
        }
        let params = || {
            vec![
                reddb_client::Value::Text(record_id.clone()),
                reddb_client::Value::Text(provider.id.clone()),
                reddb_client::Value::Text(node_id.clone()),
                reddb_client::Value::Int(provider.updated_at),
            ]
        };
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT)
                    .bind(&record_id)
                    .bind(&provider.id)
                    .bind(&node_id)
                    .bind(provider.updated_at)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider node_id")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT, params())
                    .await
                    .map_err(|_| "cannot write provider node_id")?;
            }
        }
        Ok(())
    }

    pub(crate) async fn delete_provider_node_bindings(&self, id: &str) -> Result<(), &'static str> {
        let params = || vec![reddb_client::Value::Text(id.to_owned())];
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE)
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete provider node_ids")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(DELETE, params())
                    .await
                    .map_err(|_| "cannot delete provider node_ids")?;
            }
        }
        Ok(())
    }
}
