use super::*;

pub(super) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_provider_discovery (provider_id TEXT PRIMARY KEY, models_path TEXT NOT NULL, revision BIGINT NOT NULL)";
const SELECT: &str =
    "SELECT models_path, revision FROM redrouter_control_provider_discovery WHERE provider_id = $1";
const UPSERT: &str = "INSERT INTO redrouter_control_provider_discovery (provider_id,models_path,revision) VALUES ($1,$2,$3) ON CONFLICT (provider_id) DO UPDATE SET models_path=$2, revision=$3";
const DELETE: &str = "DELETE FROM redrouter_control_provider_discovery WHERE provider_id = $1";

#[derive(Clone, Debug)]
pub struct StoredProviderDiscovery {
    pub provider_id: String,
    pub models_path: String,
    pub revision: i64,
}

impl Database {
    pub async fn provider_discovery(
        &self,
        id: &str,
    ) -> Result<Option<StoredProviderDiscovery>, &'static str> {
        let params = || vec![reddb_client::Value::Text(id.to_owned())];
        let rows = match self {
            Self::Sql(pool) => {
                return sqlx::query(SELECT)
                    .bind(id)
                    .fetch_optional(pool)
                    .await
                    .map_err(|_| "cannot read provider discovery")?
                    .map(|row| {
                        Ok(StoredProviderDiscovery {
                            provider_id: id.to_owned(),
                            models_path: row
                                .try_get("models_path")
                                .map_err(|_| "invalid discovery path")?,
                            revision: row
                                .try_get("revision")
                                .map_err(|_| "invalid discovery revision")?,
                        })
                    })
                    .transpose();
            }
            Self::Remote(_) => self.remote_query(SELECT, &params()).await?.rows,
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(SELECT, params())
                    .await
                    .map_err(|_| "cannot read provider discovery")?
                    .rows
            }
        };
        rows.first()
            .map(|row| {
                let models_path = match row
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case("models_path"))
                {
                    Some((_, reddb_client::ValueOut::String(value))) => value.clone(),
                    _ => return Err("invalid discovery path"),
                };
                let revision = match row
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case("revision"))
                {
                    Some((_, reddb_client::ValueOut::Integer(value))) => *value,
                    _ => return Err("invalid discovery revision"),
                };
                Ok(StoredProviderDiscovery {
                    provider_id: id.to_owned(),
                    models_path,
                    revision,
                })
            })
            .transpose()
    }

    pub async fn upsert_provider_discovery(
        &self,
        entry: &StoredProviderDiscovery,
    ) -> Result<(), &'static str> {
        let params = || {
            vec![
                reddb_client::Value::Text(entry.provider_id.clone()),
                reddb_client::Value::Text(entry.models_path.clone()),
                reddb_client::Value::Int(entry.revision),
            ]
        };
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT)
                    .bind(&entry.provider_id)
                    .bind(&entry.models_path)
                    .bind(entry.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider discovery")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT, params())
                    .await
                    .map_err(|_| "cannot write provider discovery")?;
            }
        }
        Ok(())
    }

    pub async fn delete_provider_discovery(&self, id: &str) -> Result<(), &'static str> {
        let params = || vec![reddb_client::Value::Text(id.to_owned())];
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE)
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete provider discovery")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(DELETE, params())
                    .await
                    .map_err(|_| "cannot delete provider discovery")?;
            }
        }
        Ok(())
    }
}
