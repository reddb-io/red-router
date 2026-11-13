//! SQLite persistence for connection-scoped model discovery snapshots.
//!
//! A ticket binds a probe to one connection generation and its discovery,
//! headers and reusable-node revisions. Publication is conditional on both
//! that binding and the latest probe generation, so late responses cannot
//! replace newer ones or survive credential/configuration changes.
use super::*;

pub(super) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_synced_models (provider_id TEXT PRIMARY KEY, generation BIGINT NOT NULL, probe_token TEXT NOT NULL, published_generation BIGINT, tenant_id TEXT, provider_revision BIGINT, discovery_revision BIGINT, headers_revision BIGINT, node_revision BIGINT, models_json TEXT, observed_at_unix_ms BIGINT)";

const BINDING: &str = "SELECT p.revision AS provider_revision, COALESCE(d.revision,0) AS discovery_revision, COALESCE(h.revision,0) AS headers_revision, COALESCE(n.revision,0) AS node_revision FROM redrouter_control_providers p LEFT JOIN redrouter_control_provider_ownership o ON o.provider_id=p.id LEFT JOIN redrouter_control_provider_discovery d ON d.provider_id=p.id LEFT JOIN redrouter_control_provider_headers h ON h.provider_id=p.id LEFT JOIN redrouter_control_provider_node_bindings b ON b.record_id=p.id || ':' || CAST(p.revision AS TEXT) LEFT JOIN redrouter_control_provider_nodes n ON n.id=b.node_id AND n.tenant_id=COALESCE(o.tenant_id,'red') WHERE p.id=$1 AND p.enabled=1 AND COALESCE(o.tenant_id,'red')=$2 AND (o.provider_id IS NULL OR o.revision=p.revision) AND (b.record_id IS NULL OR n.id IS NOT NULL)";
const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
const MAX_MODELS: usize = 10_000;
const MAX_FUTURE_CLOCK_SKEW_MS: i64 = 5 * 60 * 1_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncedModelBinding {
    pub provider_revision: i64,
    pub discovery_revision: i64,
    pub headers_revision: i64,
    pub node_revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncedModelTicket {
    pub provider_id: String,
    pub tenant_id: String,
    pub generation: i64,
    pub probe_token: String,
    pub binding: SyncedModelBinding,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncedModelSnapshot {
    pub models_json: String,
    pub observed_at_unix_ms: i64,
    pub generation: i64,
}

fn binding(row: &sqlx::any::AnyRow) -> Result<SyncedModelBinding, &'static str> {
    Ok(SyncedModelBinding {
        provider_revision: row
            .try_get("provider_revision")
            .map_err(|_| "invalid discovery binding")?,
        discovery_revision: row
            .try_get("discovery_revision")
            .map_err(|_| "invalid discovery binding")?,
        headers_revision: row
            .try_get("headers_revision")
            .map_err(|_| "invalid discovery binding")?,
        node_revision: row
            .try_get("node_revision")
            .map_err(|_| "invalid discovery binding")?,
    })
}

impl Database {
    /// Start a probe with a monotonically increasing, durable generation.
    pub async fn begin_synced_model_probe(
        &self,
        provider_id: &str,
        tenant_id: &str,
    ) -> Result<Option<SyncedModelTicket>, &'static str> {
        if !self.is_sqlite().await {
            return Err("synced model inventory requires SQLite");
        }
        let pool = self
            .sql_pool()
            .ok_or("synced model inventory requires SQLite")?;
        let mut transaction = begin_client_key_update(pool).await?;
        let row = sqlx::query(BINDING)
            .bind(provider_id)
            .bind(tenant_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| "cannot read discovery binding")?;
        let Some(row) = row else {
            transaction
                .rollback()
                .await
                .map_err(|_| "cannot close discovery transaction")?;
            return Ok(None);
        };
        let binding = binding(&row)?;
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| "cannot initialize discovery generation")?;
        let probe_token = hex::encode(random);
        let generation: i64 = sqlx::query_scalar("INSERT INTO redrouter_synced_models (provider_id,generation,probe_token) VALUES ($1,1,$2) ON CONFLICT (provider_id) DO UPDATE SET generation=generation+1,probe_token=$2 WHERE generation < 9223372036854775807 RETURNING generation")
            .bind(provider_id).bind(&probe_token).fetch_one(&mut *transaction).await.map_err(|_| "cannot start discovery generation")?;
        transaction
            .commit()
            .await
            .map_err(|_| "cannot commit discovery generation")?;
        Ok(Some(SyncedModelTicket {
            provider_id: provider_id.to_owned(),
            tenant_id: tenant_id.to_owned(),
            generation,
            probe_token,
            binding,
        }))
    }

    /// Publish only if the account binding and probe generation are unchanged.
    pub async fn publish_synced_models(
        &self,
        ticket: &SyncedModelTicket,
        models_json: &str,
        observed_at_unix_ms: i64,
    ) -> Result<bool, &'static str> {
        if !self.is_sqlite().await {
            return Err("synced model inventory requires SQLite");
        }
        if models_json.len() > MAX_SNAPSHOT_BYTES || observed_at_unix_ms < 0 {
            return Err("invalid synced model inventory");
        }
        let document: serde_json::Value =
            serde_json::from_str(models_json).map_err(|_| "invalid synced model inventory")?;
        if document
            .as_array()
            .is_none_or(|models| models.len() > MAX_MODELS)
        {
            return Err("invalid synced model inventory");
        }
        let pool = self
            .sql_pool()
            .ok_or("synced model inventory requires SQLite")?;
        let mut transaction = begin_client_key_update(pool).await?;
        let row = sqlx::query(BINDING)
            .bind(&ticket.provider_id)
            .bind(&ticket.tenant_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| "cannot read discovery binding")?;
        if row.as_ref().map(binding).transpose()?.as_ref() != Some(&ticket.binding) {
            transaction
                .rollback()
                .await
                .map_err(|_| "cannot close discovery transaction")?;
            return Ok(false);
        }
        let written = sqlx::query("UPDATE redrouter_synced_models SET tenant_id=$1, provider_revision=$2, discovery_revision=$3, headers_revision=$4, node_revision=$5, models_json=$6, observed_at_unix_ms=$7, published_generation=$8 WHERE provider_id=$9 AND generation=$8 AND probe_token=$10")
            .bind(&ticket.tenant_id).bind(ticket.binding.provider_revision).bind(ticket.binding.discovery_revision)
            .bind(ticket.binding.headers_revision).bind(ticket.binding.node_revision).bind(models_json)
            .bind(observed_at_unix_ms).bind(ticket.generation).bind(&ticket.provider_id).bind(&ticket.probe_token)
            .execute(&mut *transaction).await.map_err(|_| "cannot publish synced models")?.rows_affected() == 1;
        transaction
            .commit()
            .await
            .map_err(|_| "cannot commit synced models")?;
        Ok(written)
    }

    /// Return only a fresh snapshot still bound to the current connection.
    pub async fn synced_models(
        &self,
        provider_id: &str,
        tenant_id: &str,
        now_unix_ms: i64,
        max_age_ms: i64,
    ) -> Result<Option<SyncedModelSnapshot>, &'static str> {
        if !self.is_sqlite().await {
            return Err("synced model inventory requires SQLite");
        }
        if now_unix_ms < 0 || max_age_ms < 0 {
            return Err("invalid synced model age");
        }
        let pool = self
            .sql_pool()
            .ok_or("synced model inventory requires SQLite")?;
        let mut transaction = pool
            .begin()
            .await
            .map_err(|_| "cannot read synced models")?;
        let current = sqlx::query(BINDING)
            .bind(provider_id)
            .bind(tenant_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| "cannot read discovery binding")?;
        let Some(current) = current else {
            transaction
                .commit()
                .await
                .map_err(|_| "cannot close synced model snapshot")?;
            return Ok(None);
        };
        let current = binding(&current)?;
        let row = sqlx::query("SELECT tenant_id,provider_revision,discovery_revision,headers_revision,node_revision,models_json,observed_at_unix_ms,published_generation FROM redrouter_synced_models WHERE provider_id=$1 AND models_json IS NOT NULL")
            .bind(provider_id).fetch_optional(&mut *transaction).await.map_err(|_| "cannot read synced models")?;
        let Some(row) = row else {
            transaction
                .commit()
                .await
                .map_err(|_| "cannot close synced model snapshot")?;
            return Ok(None);
        };
        let owner: String = row
            .try_get("tenant_id")
            .map_err(|_| "invalid synced model inventory")?;
        let saved = binding(&row)?;
        let observed: i64 = row
            .try_get("observed_at_unix_ms")
            .map_err(|_| "invalid synced model inventory")?;
        if owner != tenant_id
            || saved != current
            || observed < now_unix_ms.saturating_sub(max_age_ms)
            || observed > now_unix_ms.saturating_add(MAX_FUTURE_CLOCK_SKEW_MS)
        {
            transaction
                .commit()
                .await
                .map_err(|_| "cannot close synced model snapshot")?;
            return Ok(None);
        }
        let models_json: String = row
            .try_get("models_json")
            .map_err(|_| "invalid synced model inventory")?;
        let generation: i64 = row
            .try_get("published_generation")
            .map_err(|_| "invalid synced model inventory")?;
        transaction
            .commit()
            .await
            .map_err(|_| "cannot close synced model snapshot")?;
        Ok(Some(SyncedModelSnapshot {
            models_json,
            observed_at_unix_ms: observed,
            generation,
        }))
    }

    pub async fn delete_synced_models(&self, provider_id: &str) -> Result<(), &'static str> {
        if !self.is_sqlite().await {
            return Err("synced model inventory requires SQLite");
        }
        let pool = self
            .sql_pool()
            .ok_or("synced model inventory requires SQLite")?;
        sqlx::query("DELETE FROM redrouter_synced_models WHERE provider_id=$1")
            .bind(provider_id)
            .execute(pool)
            .await
            .map_err(|_| "cannot delete synced models")?;
        Ok(())
    }
}
