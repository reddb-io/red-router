//! SQLite persistence for connection-scoped model discovery snapshots.
//!
//! A ticket binds a probe to one connection generation and its discovery,
//! headers and reusable-node revisions. Publication is conditional on both
//! that binding and the latest probe generation, so late responses cannot
//! replace newer ones or survive credential/configuration changes.
use super::*;

pub(super) const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_synced_models (provider_id TEXT PRIMARY KEY, generation BIGINT NOT NULL, probe_token TEXT NOT NULL, published_generation BIGINT, tenant_id TEXT, provider_revision BIGINT, discovery_revision BIGINT, headers_revision BIGINT, node_revision BIGINT, models_json TEXT, observed_at_unix_ms BIGINT)";
// Imported inventories have an unknown observation date. Keep them visible,
// but do not use them as proof that a host does or does not serve a model.
pub(super) const CREATE_LEGACY_ORIGIN: &str = "CREATE TABLE IF NOT EXISTS redrouter_synced_model_legacy_origin (provider_id TEXT PRIMARY KEY, published_generation BIGINT NOT NULL)";

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
    pub binding: SyncedModelBinding,
    pub source_verified: bool,
}

pub(crate) struct LegacyInventoryAdoption<'a> {
    pub provider_id: &'a str,
    pub tenant_id: &'a str,
    pub provider_name: &'a str,
    pub binding: &'a SyncedModelBinding,
    pub staged_key: &'a str,
    pub staged_value: &'a str,
    pub staged_provider_ciphertext: &'a str,
    pub models_json: &'a str,
    pub observed_at_unix_ms: i64,
}

pub(crate) struct SyncedModelMarker {
    pub kind: String,
    pub provider_id: String,
    pub revision: i64,
    pub observed_at_unix_ms: i64,
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

// Before provenance existed, an adopted inventory and a first native probe
// had the same shape. On upgrade, conservatively mark first-generation rows
// from staged migrated accounts as unknown; a real probe clears the marker.
pub(super) async fn migrate_legacy_origins(pool: &sqlx::AnyPool) -> Result<(), &'static str> {
    let mut tx = begin_client_key_update(pool).await?;
    let first = sqlx::query("INSERT INTO redrouter_synced_model_legacy_origin(provider_id,published_generation) VALUES ('',0) ON CONFLICT(provider_id) DO NOTHING")
        .execute(&mut *tx).await.map_err(|_| "cannot initialize synced model origin")?.rows_affected() == 1;
    if first {
        let staged: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('redrouter_legacy_provider_records','redrouter_legacy_provider_migration')")
            .fetch_one(&mut *tx).await.map_err(|_| "cannot inspect legacy inventory origin")?;
        if staged == 2 {
            sqlx::query("INSERT INTO redrouter_synced_model_legacy_origin(provider_id,published_generation) SELECT s.provider_id,s.published_generation FROM redrouter_synced_models s JOIN redrouter_legacy_provider_records p ON p.provider_id=s.provider_id JOIN redrouter_legacy_provider_migration m ON m.provider_id=s.provider_id WHERE s.published_generation=1 AND s.models_json IS NOT NULL ON CONFLICT(provider_id) DO NOTHING")
                .execute(&mut *tx).await.map_err(|_| "cannot migrate legacy inventory origin")?;
        }
    }
    tx.commit()
        .await
        .map_err(|_| "cannot commit synced model origin")?;
    Ok(())
}

impl Database {
    pub(crate) async fn current_synced_binding(
        &self,
        provider_id: &str,
        tenant_id: &str,
    ) -> Result<Option<SyncedModelBinding>, &'static str> {
        if !self.is_sqlite().await {
            return Err("synced model inventory requires SQLite");
        }
        let pool = self
            .sql_pool()
            .ok_or("synced model inventory requires SQLite")?;
        sqlx::query(BINDING)
            .bind(provider_id)
            .bind(tenant_id)
            .fetch_optional(pool)
            .await
            .map_err(|_| "cannot read discovery binding")?
            .as_ref()
            .map(binding)
            .transpose()
    }

    /// Adopt only when no native discovery has started or published. The
    /// binding and staged source are checked again in the same write transaction.
    pub(crate) async fn adopt_legacy_inventory(
        &self,
        input: LegacyInventoryAdoption<'_>,
    ) -> Result<bool, &'static str> {
        if !self.is_sqlite().await {
            return Err("synced model inventory requires SQLite");
        }
        if input.models_json.len() > MAX_SNAPSHOT_BYTES || input.observed_at_unix_ms < 0 {
            return Err("invalid synced model inventory");
        }
        let value: serde_json::Value = serde_json::from_str(input.models_json)
            .map_err(|_| "invalid synced model inventory")?;
        if value
            .as_array()
            .is_none_or(|models| models.len() > MAX_MODELS)
        {
            return Err("invalid synced model inventory");
        }
        let pool = self
            .sql_pool()
            .ok_or("synced model inventory requires SQLite")?;
        let mut tx = begin_client_key_update(pool).await?;
        let current = sqlx::query(BINDING)
            .bind(input.provider_id)
            .bind(input.tenant_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(|_| "cannot read discovery binding")?;
        if current.as_ref().map(binding).transpose()?.as_ref() != Some(input.binding) {
            tx.rollback()
                .await
                .map_err(|_| "cannot close discovery transaction")?;
            return Ok(false);
        }
        let staged: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_legacy_synced_model_records m JOIN redrouter_legacy_provider_records p ON p.provider_id=$1 JOIN redrouter_legacy_provider_migration g ON g.provider_id=p.provider_id JOIN redrouter_control_providers cp ON cp.id=p.provider_id JOIN redrouter_control_model_activation_defaults a ON 1=1 WHERE m.legacy_key=$2 AND m.value=$3 AND p.encrypted_record=$4 AND a.tenant_id=$5 AND a.provider=$6 AND cp.provider=$6")
            .bind(input.provider_id).bind(input.staged_key).bind(input.staged_value).bind(input.staged_provider_ciphertext)
            .bind(input.tenant_id).bind(input.provider_name)
            .fetch_one(&mut *tx).await.map_err(|_| "cannot verify staged legacy inventory")?;
        if staged != 1 {
            tx.rollback()
                .await
                .map_err(|_| "cannot close discovery transaction")?;
            return Ok(false);
        }
        let mut random = [0_u8; 16];
        getrandom::fill(&mut random).map_err(|_| "cannot initialize discovery generation")?;
        let result = sqlx::query("INSERT INTO redrouter_synced_models (provider_id,generation,probe_token,published_generation,tenant_id,provider_revision,discovery_revision,headers_revision,node_revision,models_json,observed_at_unix_ms) VALUES ($1,1,$2,1,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(provider_id) DO NOTHING")
            .bind(input.provider_id).bind(hex::encode(random)).bind(input.tenant_id)
            .bind(input.binding.provider_revision).bind(input.binding.discovery_revision).bind(input.binding.headers_revision).bind(input.binding.node_revision)
            .bind(input.models_json).bind(input.observed_at_unix_ms).execute(&mut *tx).await.map_err(|_| "cannot adopt legacy inventory")?;
        let inserted = result.rows_affected() == 1;
        if inserted {
            sqlx::query("INSERT INTO redrouter_synced_model_legacy_origin(provider_id,published_generation) VALUES ($1,1) ON CONFLICT(provider_id) DO UPDATE SET published_generation=1")
                .bind(input.provider_id).execute(&mut *tx).await.map_err(|_| "cannot record legacy inventory origin")?;
        }
        tx.commit()
            .await
            .map_err(|_| "cannot commit legacy inventory adoption")?;
        Ok(inserted)
    }
    pub(crate) async fn synced_model_markers(
        &self,
    ) -> Result<Vec<SyncedModelMarker>, &'static str> {
        if !self.is_sqlite().await {
            return Ok(Vec::new());
        }
        let pool = self
            .sql_pool()
            .ok_or("synced model inventory requires SQLite")?;
        let rows = sqlx::query("SELECT 'path' AS kind,provider_id,revision,0 AS observed_at_unix_ms FROM redrouter_control_provider_discovery UNION ALL SELECT 'snapshot',provider_id,COALESCE(published_generation,0),COALESCE(observed_at_unix_ms,0) FROM redrouter_synced_models UNION ALL SELECT 'legacy-origin',provider_id,published_generation,0 FROM redrouter_synced_model_legacy_origin WHERE provider_id<>'' ORDER BY kind,provider_id")
            .fetch_all(pool).await.map_err(|_| "cannot read synced model markers")?;
        rows.iter()
            .map(|row| {
                Ok(SyncedModelMarker {
                    kind: row
                        .try_get("kind")
                        .map_err(|_| "invalid synced model marker")?,
                    provider_id: row
                        .try_get("provider_id")
                        .map_err(|_| "invalid synced model marker")?,
                    revision: row
                        .try_get("revision")
                        .map_err(|_| "invalid synced model marker")?,
                    observed_at_unix_ms: row
                        .try_get("observed_at_unix_ms")
                        .map_err(|_| "invalid synced model marker")?,
                })
            })
            .collect()
    }

    /// Confirm that a probe still describes the current account and is the
    /// newest probe before using its captured credentials for network I/O.
    pub async fn synced_model_probe_current(
        &self,
        ticket: &SyncedModelTicket,
    ) -> Result<bool, &'static str> {
        if !self.is_sqlite().await {
            return Err("synced model inventory requires SQLite");
        }
        let pool = self
            .sql_pool()
            .ok_or("synced model inventory requires SQLite")?;
        let mut transaction = pool
            .begin()
            .await
            .map_err(|_| "cannot read discovery binding")?;
        let row = sqlx::query(BINDING)
            .bind(&ticket.provider_id)
            .bind(&ticket.tenant_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| "cannot read discovery binding")?;
        let current = row.as_ref().map(binding).transpose()?;
        let matches: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_synced_models WHERE provider_id=$1 AND generation=$2 AND probe_token=$3")
            .bind(&ticket.provider_id).bind(ticket.generation).bind(&ticket.probe_token)
            .fetch_one(&mut *transaction).await.map_err(|_| "cannot read discovery generation")?;
        transaction
            .commit()
            .await
            .map_err(|_| "cannot close discovery snapshot")?;
        Ok(current.as_ref() == Some(&ticket.binding) && matches == 1)
    }

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
        if written {
            sqlx::query("DELETE FROM redrouter_synced_model_legacy_origin WHERE provider_id=$1")
                .bind(&ticket.provider_id)
                .execute(&mut *transaction)
                .await
                .map_err(|_| "cannot update synced model origin")?;
        }
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
        let row = sqlx::query("SELECT s.tenant_id,s.provider_revision,s.discovery_revision,s.headers_revision,s.node_revision,s.models_json,s.observed_at_unix_ms,s.published_generation, CASE WHEN EXISTS (SELECT 1 FROM redrouter_synced_model_legacy_origin o WHERE o.provider_id=s.provider_id AND o.published_generation=s.published_generation) THEN 0 ELSE 1 END AS source_verified FROM redrouter_synced_models s WHERE s.provider_id=$1 AND s.models_json IS NOT NULL")
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
        let source_verified: i64 = row
            .try_get("source_verified")
            .map_err(|_| "invalid synced model origin")?;
        transaction
            .commit()
            .await
            .map_err(|_| "cannot close synced model snapshot")?;
        Ok(Some(SyncedModelSnapshot {
            models_json,
            observed_at_unix_ms: observed,
            generation,
            binding: saved,
            source_verified: source_verified == 1,
        }))
    }

    pub async fn delete_synced_models(&self, provider_id: &str) -> Result<(), &'static str> {
        if !self.is_sqlite().await {
            return Err("synced model inventory requires SQLite");
        }
        let pool = self
            .sql_pool()
            .ok_or("synced model inventory requires SQLite")?;
        let mut transaction = begin_client_key_update(pool).await?;
        sqlx::query("DELETE FROM redrouter_synced_models WHERE provider_id=$1")
            .bind(provider_id)
            .execute(&mut *transaction)
            .await
            .map_err(|_| "cannot delete synced models")?;
        sqlx::query("DELETE FROM redrouter_synced_model_legacy_origin WHERE provider_id=$1")
            .bind(provider_id)
            .execute(&mut *transaction)
            .await
            .map_err(|_| "cannot delete synced model origin")?;
        transaction
            .commit()
            .await
            .map_err(|_| "cannot delete synced models")?;
        Ok(())
    }
}
