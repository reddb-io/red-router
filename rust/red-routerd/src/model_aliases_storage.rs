use super::*;

pub(super) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_model_aliases (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, namespace TEXT NOT NULL, config_json TEXT NOT NULL, revision BIGINT NOT NULL)";
pub(super) const STATE: &str =
    "CREATE TABLE IF NOT EXISTS redrouter_model_alias_state (id TEXT PRIMARY KEY)";
const CONFIGURED: &str = "INSERT INTO redrouter_model_alias_state (id) VALUES ('configured') ON CONFLICT (id) DO NOTHING";
pub(super) const INDEX: &str = "CREATE UNIQUE INDEX IF NOT EXISTS redrouter_model_alias_namespace ON redrouter_control_model_aliases(namespace)";
const SELECT: &str = "SELECT config_json FROM redrouter_control_model_aliases ORDER BY id";
const INSERT: &str = "INSERT INTO redrouter_control_model_aliases (id,namespace,config_json,revision,tenant_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING";
const UPDATE: &str = "UPDATE redrouter_control_model_aliases SET namespace=$2,config_json=$3,revision=$4 WHERE id=$1 AND tenant_id=$5 AND revision=$6";
const DELETE: &str =
    "DELETE FROM redrouter_control_model_aliases WHERE id=$1 AND tenant_id=$2 AND revision=$3";

/// Tenant-owned public model names. Destination credentials remain provider-owned.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredModelAlias {
    pub id: String,
    pub tenant_id: String,
    pub provider: String,
    pub alias: String,
    pub model: String,
    pub protocol: String,
    pub enabled: bool,
    pub revision: i64,
}

impl Database {
    pub async fn alias_routing_configured(&self) -> Result<bool, &'static str> {
        const QUERY: &str = "SELECT id FROM redrouter_model_alias_state WHERE id='configured'";
        match self {
            Self::Sql(pool) => Ok(sqlx::query(QUERY)
                .fetch_optional(pool)
                .await
                .map_err(|_| "cannot read alias routing state")?
                .is_some()),
            Self::Remote(_) => Ok(!self.remote_query(QUERY, &[]).await?.rows.is_empty()),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => Ok(!db
                .query(QUERY)
                .await
                .map_err(|_| "cannot read alias routing state")?
                .rows
                .is_empty()),
        }
    }

    pub async fn model_aliases(&self) -> Result<Vec<StoredModelAlias>, &'static str> {
        let documents: Vec<String> = match self {
            Self::Sql(pool) => sqlx::query_scalar(SELECT)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read model aliases")?,
            _ => {
                let rows = match self {
                    Self::Remote(_) => self.remote_query(SELECT, &[]).await?.rows,
                    #[cfg(feature = "reddb-embedded")]
                    Self::Embedded { db, .. } => {
                        db.query(SELECT)
                            .await
                            .map_err(|_| "cannot read model aliases")?
                            .rows
                    }
                    Self::Sql(_) => unreachable!(),
                };
                rows.iter()
                    .map(|row| {
                        match row
                            .iter()
                            .find(|(name, _)| name.eq_ignore_ascii_case("config_json"))
                        {
                            Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
                            _ => Err("invalid model alias storage"),
                        }
                    })
                    .collect::<Result<_, _>>()?
            }
        };
        documents
            .iter()
            .map(|doc| serde_json::from_str(doc).map_err(|_| "invalid model alias storage"))
            .collect()
    }

    pub async fn upsert_model_alias(
        &self,
        model: &StoredModelAlias,
        expected_revision: Option<i64>,
    ) -> Result<(), &'static str> {
        let statement = if expected_revision.is_some() {
            UPDATE
        } else {
            INSERT
        };
        let namespace = serde_json::to_string(&(&model.tenant_id, &model.alias))
            .map_err(|_| "invalid model identity")?;
        let document = serde_json::to_string(model).map_err(|_| "invalid model alias")?;
        let params = || {
            let mut values = vec![
                reddb_client::Value::Text(model.id.clone()),
                reddb_client::Value::Text(namespace.clone()),
                reddb_client::Value::Text(document.clone()),
                reddb_client::Value::Int(model.revision),
                reddb_client::Value::Text(model.tenant_id.clone()),
            ];
            if let Some(revision) = expected_revision {
                values.push(reddb_client::Value::Int(revision));
            }
            values
        };
        match self {
            Self::Sql(pool) => {
                let mut transaction = pool.begin().await.map_err(|_| "cannot begin alias write")?;
                let query = sqlx::query(statement)
                    .bind(&model.id)
                    .bind(&namespace)
                    .bind(&document)
                    .bind(model.revision)
                    .bind(&model.tenant_id);
                let query = if let Some(revision) = expected_revision {
                    query.bind(revision)
                } else {
                    query
                };
                let result = query
                    .execute(&mut *transaction)
                    .await
                    .map_err(|_| "cannot write model alias (namespace may already exist)")?;
                if result.rows_affected() != 1 {
                    return Err("Model alias changed; reload and retry");
                }
                sqlx::query(CONFIGURED)
                    .execute(&mut *transaction)
                    .await
                    .map_err(|_| "cannot persist alias routing state")?;
                transaction
                    .commit()
                    .await
                    .map_err(|_| "cannot commit alias write")?;
            }
            Self::Remote(_) => {
                self.remote_query(CONFIGURED, &[]).await?;
                self.remote_query(statement, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query(CONFIGURED)
                    .await
                    .map_err(|_| "cannot persist alias routing state")?;
                db.query_with(statement, params())
                    .await
                    .map_err(|_| "cannot write model alias")?;
            }
        }
        if !self.model_aliases().await?.iter().any(|saved| {
            saved.id == model.id
                && saved.tenant_id == model.tenant_id
                && saved.revision == model.revision
        }) {
            return Err("Model alias changed; reload and retry");
        }
        Ok(())
    }

    pub async fn delete_model_alias(
        &self,
        id: &str,
        tenant_id: &str,
        expected_revision: i64,
    ) -> Result<(), &'static str> {
        let params = || {
            vec![
                reddb_client::Value::Text(id.to_owned()),
                reddb_client::Value::Text(tenant_id.to_owned()),
                reddb_client::Value::Int(expected_revision),
            ]
        };
        match self {
            Self::Sql(pool) => {
                let mut transaction = pool
                    .begin()
                    .await
                    .map_err(|_| "cannot begin alias deletion")?;
                sqlx::query(CONFIGURED)
                    .execute(&mut *transaction)
                    .await
                    .map_err(|_| "cannot persist alias routing state")?;
                let result = sqlx::query(DELETE)
                    .bind(id)
                    .bind(tenant_id)
                    .bind(expected_revision)
                    .execute(&mut *transaction)
                    .await
                    .map_err(|_| "cannot delete model alias")?;
                if result.rows_affected() != 1 {
                    return Err("Model alias changed; reload and retry");
                }
                transaction
                    .commit()
                    .await
                    .map_err(|_| "cannot commit alias deletion")?;
            }
            Self::Remote(_) => {
                self.remote_query(CONFIGURED, &[]).await?;
                self.remote_query(DELETE, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query(CONFIGURED)
                    .await
                    .map_err(|_| "cannot persist alias routing state")?;
                db.query_with(DELETE, params())
                    .await
                    .map_err(|_| "cannot delete model alias")?;
            }
        }
        if self
            .model_aliases()
            .await?
            .iter()
            .any(|model| model.id == id)
        {
            return Err("Model alias changed; reload and retry");
        }
        Ok(())
    }
}
