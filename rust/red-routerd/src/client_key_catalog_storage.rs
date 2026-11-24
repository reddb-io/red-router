//! Revision-bound client key catalog policy (see `client_key_catalog`).
//! A missing record means the default policy.
use super::*;

pub(super) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_client_key_catalog (key_id TEXT PRIMARY KEY, catalog_policy_json TEXT NOT NULL, revision BIGINT NOT NULL)";
const LIST: &str = "SELECT key_id, catalog_policy_json, revision FROM redrouter_control_client_key_catalog ORDER BY key_id ASC";
pub(super) const UPSERT: &str = "INSERT INTO redrouter_control_client_key_catalog (key_id, catalog_policy_json, revision) VALUES ($1,$2,$3) ON CONFLICT (key_id) DO UPDATE SET catalog_policy_json = $2, revision = $3";

pub(super) struct StoredClientKeyCatalog {
    pub key_id: String,
    pub catalog_policy_json: String,
    pub revision: i64,
}

impl Database {
    pub(super) async fn client_key_catalogs(
        &self,
    ) -> Result<Vec<StoredClientKeyCatalog>, &'static str> {
        let rows = match self {
            Self::Sql(pool) => {
                return sqlx::query(LIST)
                    .fetch_all(pool)
                    .await
                    .map_err(|_| "cannot read client key catalog policies")?
                    .iter()
                    .map(|row| {
                        let invalid = |_| "invalid client key catalog policy";
                        Ok(StoredClientKeyCatalog {
                            key_id: row.try_get("key_id").map_err(invalid)?,
                            catalog_policy_json: row
                                .try_get("catalog_policy_json")
                                .map_err(invalid)?,
                            revision: row.try_get("revision").map_err(invalid)?,
                        })
                    })
                    .collect();
            }
            Self::Remote(_) => self.remote_query(LIST, &[]).await?.rows,
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query(LIST)
                    .await
                    .map_err(|_| "cannot read client key catalog policies")?
                    .rows
            }
        };
        rows.iter()
            .map(|row| {
                let field = |name: &str| {
                    row.iter()
                        .find(|(column, _)| column.eq_ignore_ascii_case(name))
                };
                let text = |name: &str| match field(name) {
                    Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
                    _ => Err("invalid client key catalog policy"),
                };
                let revision = match field("revision") {
                    Some((_, reddb_client::ValueOut::Integer(value))) => *value,
                    _ => return Err("invalid client key catalog policy"),
                };
                Ok(StoredClientKeyCatalog {
                    key_id: text("key_id")?,
                    catalog_policy_json: text("catalog_policy_json")?,
                    revision,
                })
            })
            .collect()
    }

    /// Write the policy for RedDB backends; SQL writes it inside the key's
    /// transaction (see `upsert_client_key`).
    pub(super) async fn upsert_client_key_catalog(
        &self,
        key: &StoredClientKey,
    ) -> Result<(), &'static str> {
        let params = || {
            vec![
                reddb_client::Value::Text(key.id.clone()),
                reddb_client::Value::Text(key.catalog_policy_json.clone()),
                reddb_client::Value::Int(key.revision),
            ]
        };
        match self {
            Self::Sql(_) => Err("SQL client key catalog policies are written with the key"),
            Self::Remote(_) => {
                self.remote_query(UPSERT, &params()).await?;
                Ok(())
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT, params())
                    .await
                    .map_err(|_| "cannot write client key catalog policy")?;
                Ok(())
            }
        }
    }
}
