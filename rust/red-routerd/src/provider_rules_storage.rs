use super::*;

pub(super) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_provider_model_rules (provider_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, patterns_json TEXT NOT NULL, revision BIGINT NOT NULL)";

#[derive(Clone, Debug)]
pub(crate) struct StoredProviderRules {
    pub provider_id: String,
    pub tenant_id: String,
    pub patterns: Vec<String>,
    pub revision: i64,
}

impl Database {
    pub(crate) async fn provider_model_rules(
        &self,
    ) -> Result<Vec<StoredProviderRules>, &'static str> {
        if !self.is_sqlite().await {
            return Ok(Vec::new());
        }
        let pool = self.sql_pool().ok_or("provider rules require SQLite")?;
        let rows = sqlx::query("SELECT provider_id,tenant_id,patterns_json,revision FROM redrouter_provider_model_rules ORDER BY provider_id")
            .fetch_all(pool).await.map_err(|_| "cannot read provider model rules")?;
        rows.iter()
            .map(|row| {
                let json: String = row
                    .try_get("patterns_json")
                    .map_err(|_| "invalid provider model rules")?;
                Ok(StoredProviderRules {
                    provider_id: row
                        .try_get("provider_id")
                        .map_err(|_| "invalid provider model rules")?,
                    tenant_id: row
                        .try_get("tenant_id")
                        .map_err(|_| "invalid provider model rules")?,
                    patterns: serde_json::from_str(&json)
                        .map_err(|_| "invalid provider model rules")?,
                    revision: row
                        .try_get("revision")
                        .map_err(|_| "invalid provider model rules")?,
                })
            })
            .collect()
    }

    pub(crate) async fn save_provider_model_rules(
        &self,
        entry: &StoredProviderRules,
        provider_revision: i64,
        expected: Option<i64>,
    ) -> Result<(), &'static str> {
        if !self.is_sqlite().await {
            return Err("provider rules require SQLite");
        }
        let pool = self.sql_pool().ok_or("provider rules require SQLite")?;
        let json =
            serde_json::to_string(&entry.patterns).map_err(|_| "invalid provider model rules")?;
        let mut tx = begin_client_key_update(pool).await?;
        let current: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_control_providers p LEFT JOIN redrouter_control_provider_ownership o ON o.provider_id=p.id WHERE p.id=$1 AND COALESCE(o.tenant_id,'red')=$2 AND p.revision=$3 AND (o.provider_id IS NULL OR o.revision=p.revision)")
            .bind(&entry.provider_id).bind(&entry.tenant_id).bind(provider_revision)
            .fetch_one(&mut *tx).await.map_err(|_| "cannot verify provider model rules")?;
        if current != 1 {
            return Err("provider changed; reload and retry");
        }
        let affected = if let Some(expected) = expected {
            sqlx::query("UPDATE redrouter_provider_model_rules SET patterns_json=$1,revision=$2 WHERE provider_id=$3 AND tenant_id=$4 AND revision=$5")
                .bind(json).bind(entry.revision).bind(&entry.provider_id).bind(&entry.tenant_id).bind(expected)
                .execute(&mut *tx).await.map_err(|_| "cannot save provider model rules")?.rows_affected()
        } else {
            sqlx::query("INSERT INTO redrouter_provider_model_rules(provider_id,tenant_id,patterns_json,revision) VALUES ($1,$2,$3,$4) ON CONFLICT(provider_id) DO NOTHING")
                .bind(&entry.provider_id).bind(&entry.tenant_id).bind(json).bind(entry.revision)
                .execute(&mut *tx).await.map_err(|_| "cannot save provider model rules")?.rows_affected()
        };
        if affected != 1 {
            return Err("provider model rules changed; reload and retry");
        }
        tx.commit()
            .await
            .map_err(|_| "cannot save provider model rules")?;
        Ok(())
    }

    pub(crate) async fn delete_provider_model_rules(&self, id: &str) -> Result<(), &'static str> {
        if !self.is_sqlite().await {
            return Ok(());
        }
        sqlx::query("DELETE FROM redrouter_provider_model_rules WHERE provider_id=$1")
            .bind(id)
            .execute(self.sql_pool().ok_or("provider rules require SQLite")?)
            .await
            .map_err(|_| "cannot delete provider model rules")?;
        Ok(())
    }
}
