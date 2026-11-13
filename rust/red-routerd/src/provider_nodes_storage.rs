use super::*;

pub(super) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_provider_nodes (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, namespace TEXT NOT NULL, config_json TEXT NOT NULL, revision BIGINT NOT NULL)";
pub(super) const INDEX: &str = "CREATE UNIQUE INDEX IF NOT EXISTS redrouter_provider_node_namespace ON redrouter_control_provider_nodes(namespace)";
const SELECT: &str = "SELECT config_json FROM redrouter_control_provider_nodes ORDER BY id";
const INSERT: &str = "INSERT INTO redrouter_control_provider_nodes (id,namespace,config_json,revision,tenant_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING";
const UPDATE: &str = "UPDATE redrouter_control_provider_nodes SET namespace=$2,config_json=$3,revision=$4 WHERE id=$1 AND tenant_id=$5 AND revision=$6";
const DELETE: &str = "DELETE FROM redrouter_control_provider_nodes WHERE id=$1 AND tenant_id=$2";

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredProviderNode {
    pub id: String,
    pub tenant_id: String,
    pub name: String,
    pub prefix: String,
    pub protocol: String,
    pub base_url: String,
    pub chat_path: String,
    pub upstream_url: String,
    pub models_path: Option<String>,
    pub revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_config: Option<StoredProviderNodeHeaders>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredProviderNodeHeaders {
    pub upstream_identity: String,
    pub ciphertext: String,
    pub revision: i64,
}

impl Database {
    pub async fn provider_nodes(&self) -> Result<Vec<StoredProviderNode>, &'static str> {
        let documents: Vec<String> = match self {
            Self::Sql(pool) => sqlx::query_scalar(SELECT)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read provider definitions")?,
            _ => {
                let rows = match self {
                    Self::Remote(_) => self.remote_query(SELECT, &[]).await?.rows,
                    #[cfg(feature = "reddb-embedded")]
                    Self::Embedded { db, .. } => {
                        db.query(SELECT)
                            .await
                            .map_err(|_| "cannot read provider definitions")?
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
                            _ => Err("invalid provider definition storage"),
                        }
                    })
                    .collect::<Result<_, _>>()?
            }
        };
        documents
            .iter()
            .map(|doc| serde_json::from_str(doc).map_err(|_| "invalid provider definition storage"))
            .collect()
    }

    pub async fn upsert_provider_node(
        &self,
        node: &StoredProviderNode,
        expected_revision: Option<i64>,
    ) -> Result<(), &'static str> {
        let statement = if expected_revision.is_some() {
            UPDATE
        } else {
            INSERT
        };
        let namespace = format!("{}:{}", node.tenant_id, node.prefix);
        let document = serde_json::to_string(node).map_err(|_| "invalid provider definition")?;
        let params = || {
            let mut values = vec![
                reddb_client::Value::Text(node.id.clone()),
                reddb_client::Value::Text(namespace.clone()),
                reddb_client::Value::Text(document.clone()),
                reddb_client::Value::Int(node.revision),
                reddb_client::Value::Text(node.tenant_id.clone()),
            ];
            if let Some(revision) = expected_revision {
                values.push(reddb_client::Value::Int(revision));
            }
            values
        };
        match self {
            Self::Sql(pool) => {
                let query = sqlx::query(statement)
                    .bind(&node.id)
                    .bind(&namespace)
                    .bind(&document)
                    .bind(node.revision)
                    .bind(&node.tenant_id);
                let query = if let Some(revision) = expected_revision {
                    query.bind(revision)
                } else {
                    query
                };
                let result = query.execute(pool).await.map_err(|_| {
                    "cannot write provider definition (namespace may already exist)"
                })?;
                if result.rows_affected() != 1 {
                    return Err("Provider definition changed; reload and retry");
                }
            }
            Self::Remote(_) => {
                self.remote_query(statement, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(statement, params())
                    .await
                    .map_err(|_| "cannot write provider definition")?;
            }
        }
        if !self.provider_nodes().await?.iter().any(|saved| {
            saved.id == node.id
                && saved.tenant_id == node.tenant_id
                && saved.revision == node.revision
        }) {
            return Err("Provider definition changed; reload and retry");
        }
        Ok(())
    }

    pub async fn delete_provider_node(
        &self,
        id: &str,
        tenant_id: &str,
    ) -> Result<(), &'static str> {
        let params = || {
            vec![
                reddb_client::Value::Text(id.to_owned()),
                reddb_client::Value::Text(tenant_id.to_owned()),
            ]
        };
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE)
                    .bind(id)
                    .bind(tenant_id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete provider definition")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(DELETE, params())
                    .await
                    .map_err(|_| "cannot delete provider definition")?;
            }
        }
        Ok(())
    }
}
