use super::*;

pub(super) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_provider_models (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, namespace TEXT NOT NULL, config_json TEXT NOT NULL, revision BIGINT NOT NULL)";
pub(super) const INDEX: &str = "CREATE UNIQUE INDEX IF NOT EXISTS redrouter_provider_model_namespace ON redrouter_control_provider_models(namespace)";
const SELECT: &str = "SELECT config_json FROM redrouter_control_provider_models ORDER BY id";
const INSERT: &str = "INSERT INTO redrouter_control_provider_models (id,namespace,config_json,revision,tenant_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING";
const UPDATE: &str = "UPDATE redrouter_control_provider_models SET namespace=$2,config_json=$3,revision=$4 WHERE id=$1 AND tenant_id=$5 AND revision=$6";
const DELETE: &str =
    "DELETE FROM redrouter_control_provider_models WHERE id=$1 AND tenant_id=$2 AND revision=$3";

/// Tenant-owned model metadata overrides. Credentials and grants are separate.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredProviderModel {
    pub id: String,
    pub tenant_id: String,
    pub provider: String,
    pub metadata: crate::catalog::ModelMetadata,
    pub revision: i64,
}

impl Database {
    pub async fn provider_models(&self) -> Result<Vec<StoredProviderModel>, &'static str> {
        let documents: Vec<String> = match self {
            Self::Sql(pool) => sqlx::query_scalar(SELECT)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read provider models")?,
            _ => {
                let rows = match self {
                    Self::Remote(_) => self.remote_query(SELECT, &[]).await?.rows,
                    #[cfg(feature = "reddb-embedded")]
                    Self::Embedded { db, .. } => {
                        db.query(SELECT)
                            .await
                            .map_err(|_| "cannot read provider models")?
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
                            _ => Err("invalid provider model storage"),
                        }
                    })
                    .collect::<Result<_, _>>()?
            }
        };
        documents
            .iter()
            .map(|doc| serde_json::from_str(doc).map_err(|_| "invalid provider model storage"))
            .collect()
    }

    pub async fn upsert_provider_model(
        &self,
        model: &StoredProviderModel,
        expected_revision: Option<i64>,
    ) -> Result<(), &'static str> {
        let statement = if expected_revision.is_some() {
            UPDATE
        } else {
            INSERT
        };
        let namespace =
            serde_json::to_string(&(&model.tenant_id, &model.provider, &model.metadata.id))
                .map_err(|_| "invalid model identity")?;
        let document = serde_json::to_string(model).map_err(|_| "invalid provider model")?;
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
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider model (namespace may already exist)")?;
                if result.rows_affected() != 1 {
                    return Err("Provider model changed; reload and retry");
                }
            }
            Self::Remote(_) => {
                self.remote_query(statement, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(statement, params())
                    .await
                    .map_err(|_| "cannot write provider model")?;
            }
        }
        if !self.provider_models().await?.iter().any(|saved| {
            saved.id == model.id
                && saved.tenant_id == model.tenant_id
                && saved.revision == model.revision
        }) {
            return Err("Provider model changed; reload and retry");
        }
        Ok(())
    }

    pub async fn delete_provider_model(
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
                let result = sqlx::query(DELETE)
                    .bind(id)
                    .bind(tenant_id)
                    .bind(expected_revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete provider model")?;
                if result.rows_affected() != 1 {
                    return Err("Provider model changed; reload and retry");
                }
            }
            Self::Remote(_) => {
                self.remote_query(DELETE, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(DELETE, params())
                    .await
                    .map_err(|_| "cannot delete provider model")?;
            }
        }
        if self
            .provider_models()
            .await?
            .iter()
            .any(|model| model.id == id)
        {
            return Err("Provider model changed; reload and retry");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sqlite_replicas_cannot_replace_each_others_model_edits() {
        let directory = tempfile::tempdir().unwrap();
        let url = url::Url::from_file_path(directory.path().join("model-writes.sqlite"))
            .unwrap()
            .as_str()
            .replacen("file:", "sqlite:", 1)
            + "?mode=rwc";
        let first = Database::connect(Backend::Sqlite, &url).await.unwrap();
        let second = Database::connect(Backend::Sqlite, &url).await.unwrap();
        let original = StoredProviderModel {
            id: "shared-model".to_owned(),
            tenant_id: "red".to_owned(),
            provider: "private-api".to_owned(),
            metadata: serde_json::from_value(serde_json::json!({"id":"model","cost":{"input":1}}))
                .unwrap(),
            revision: 1,
        };
        first.upsert_provider_model(&original, None).await.unwrap();
        let mut a = original.clone();
        a.revision = 2;
        a.metadata.name = Some("First editor".to_owned());
        let mut b = original.clone();
        b.revision = 3;
        b.metadata.name = Some("Second editor".to_owned());
        let (a_result, b_result) = tokio::join!(
            first.upsert_provider_model(&a, Some(1)),
            second.upsert_provider_model(&b, Some(1)),
        );
        assert_ne!(a_result.is_ok(), b_result.is_ok());
        let saved = first.provider_models().await.unwrap().pop().unwrap();
        let winner = if a_result.is_ok() { &a } else { &b };
        assert_eq!(saved.revision, winner.revision);
        assert_eq!(saved.metadata, winner.metadata);
        assert!(second
            .delete_provider_model("shared-model", "red", 1)
            .await
            .is_err());
        second
            .delete_provider_model("shared-model", "red", saved.revision)
            .await
            .unwrap();
        // A stale edit cannot resurrect a row removed by the other replica.
        assert!(first
            .upsert_provider_model(&original, Some(saved.revision))
            .await
            .is_err());
        assert!(first.provider_models().await.unwrap().is_empty());
    }
}
