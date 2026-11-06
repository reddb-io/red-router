//! Read-only, explicitly selected product credential. This is not policy parity.
use aes_gcm::aead::consts::U16;
use aes_gcm::{
    aead::{Aead, KeyInit},
    aes::Aes256,
    AesGcm, Nonce,
};
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Row, SqlitePool,
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, oneshot};
use zeroize::Zeroizing;

type ProductCipher = AesGcm<Aes256, U16>;

#[derive(Clone)]
pub struct ProductConnection {
    pool: SqlitePool,
    id: Arc<str>,
    stored_key: Arc<str>,
    updated_at: Arc<str>,
    provider: Arc<str>,
    path: Arc<PathBuf>,
    shared_rpm: Option<mpsc::Sender<RpmReservation>>,
    usage_pool: Option<SqlitePool>,
    auto_selection: bool,
}

pub(crate) struct ProductAccess {
    pub policies: crate::policy::ClientPolicies,
    pub key_id: String,
}

struct RpmReservation {
    key_id: String,
    reply: oneshot::Sender<Result<bool, &'static str>>,
}

impl ProductConnection {
    /// Pick the dashboard's fill-first connection at startup. More complex
    /// strategies and connection-level quota settings remain unsupported.
    pub async fn select_fill_first(path: &Path, provider: &str) -> Result<String, &'static str> {
        if !matches!(provider, "openai" | "openrouter") {
            return Err("unsupported automatic product provider");
        }
        let options = SqliteConnectOptions::new().filename(path).read_only(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(|_| "cannot open product SQLite database read-only")?;
        Self::select_from_pool(&pool, provider, None).await
    }

    async fn select_from_pool(
        pool: &SqlitePool,
        provider: &str,
        expected: Option<(&str, &str, &str)>,
    ) -> Result<String, &'static str> {
        let settings = sqlx::query("SELECT key, value FROM key_value WHERE namespace = 'settings' AND key IN ('fallbackStrategy', 'providerStrategies')")
            .fetch_all(pool).await.map_err(|_| "product routing settings unavailable")?;
        let mut default_strategy = "fill-first".to_string();
        let mut override_strategy = None;
        for row in settings {
            let name: String = row.try_get("key").map_err(|_| "invalid routing settings")?;
            let value: String = row
                .try_get("value")
                .map_err(|_| "invalid routing settings")?;
            let parsed: serde_json::Value =
                serde_json::from_str(&value).map_err(|_| "invalid routing settings")?;
            match name.as_str() {
                "fallbackStrategy" => {
                    default_strategy = parsed
                        .as_str()
                        .ok_or("invalid routing strategy")?
                        .to_owned()
                }
                "providerStrategies" => {
                    let overrides = parsed
                        .as_object()
                        .ok_or("invalid provider routing strategies")?;
                    if let Some(entry) = overrides.get(provider) {
                        let entry = entry
                            .as_object()
                            .ok_or("invalid provider routing strategy")?;
                        if let Some(strategy) = entry.get("fallbackStrategy") {
                            override_strategy = Some(
                                strategy
                                    .as_str()
                                    .ok_or("invalid provider routing strategy")?
                                    .to_owned(),
                            );
                        }
                    }
                }
                _ => return Err("unsupported routing setting"),
            }
        }
        if override_strategy.as_deref().unwrap_or(&default_strategy) != "fill-first" {
            return Err("automatic product routing supports only fill-first");
        }
        let row = sqlx::query("SELECT id, api_key, updated_at, auth_type, tenant_id, rate_limited_until, test_status, per_key_proxy_enabled, max_concurrent, provider_specific_data, rate_limit_overrides_json FROM provider_connections WHERE provider = ? AND is_active = 1 ORDER BY priority ASC, updated_at DESC LIMIT 1")
            .bind(provider).fetch_optional(pool).await.map_err(|_| "product provider schema unavailable")?
            .ok_or("no active product provider connection")?;
        let id: String = row
            .try_get("id")
            .map_err(|_| "invalid product connection")?;
        if let Some((expected_id, expected_key, expected_updated)) = expected {
            let key: Option<String> = row
                .try_get("api_key")
                .map_err(|_| "invalid product connection")?;
            let updated: String = row
                .try_get("updated_at")
                .map_err(|_| "invalid product connection")?;
            if id != expected_id
                || key.as_deref() != Some(expected_key)
                || updated != expected_updated
            {
                return Err("product connection changed");
            }
        }
        let auth: Option<String> = row
            .try_get("auth_type")
            .map_err(|_| "invalid product connection")?;
        let tenant: String = row
            .try_get("tenant_id")
            .map_err(|_| "invalid product connection")?;
        let status: Option<String> = row
            .try_get("test_status")
            .map_err(|_| "invalid product connection")?;
        let cooldown: Option<String> = row
            .try_get("rate_limited_until")
            .map_err(|_| "invalid product connection")?;
        let proxy: Option<i64> = row
            .try_get("per_key_proxy_enabled")
            .map_err(|_| "invalid product connection")?;
        let concurrency: Option<i64> = row
            .try_get("max_concurrent")
            .map_err(|_| "invalid product connection")?;
        if auth.as_deref() != Some("apikey")
            || tenant != "red"
            || status.as_deref().is_some_and(|s| {
                matches!(
                    s.trim().to_ascii_lowercase().as_str(),
                    "banned" | "expired" | "credits_exhausted"
                )
            })
            || cooldown.as_deref().is_some_and(|s| !s.trim().is_empty())
            || proxy.unwrap_or(0) != 0
            || concurrency.is_some_and(|n| n > 0)
        {
            return Err("first product connection has unsupported routing state");
        }
        for field in ["provider_specific_data", "rate_limit_overrides_json"] {
            let value: Option<String> = row
                .try_get(field)
                .map_err(|_| "invalid product connection")?;
            if value
                .as_deref()
                .is_some_and(|s| !matches!(s.trim(), "" | "{}" | "null" | "[]"))
            {
                return Err("first product connection has unsupported configuration");
            }
        }
        let quota: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM provider_quota_state WHERE connection_id = ?)",
        )
        .bind(&id)
        .fetch_one(pool)
        .await
        .map_err(|_| "provider quota schema unavailable")?;
        if quota != 0 {
            return Err("first product connection has unsupported provider quota");
        }
        Ok(id)
    }

    /// The file is opened read-only and must already exist. No migrations occur.
    pub async fn open(
        path: &Path,
        id: &str,
        encryption_key: Option<&str>,
    ) -> Result<(Self, Zeroizing<String>), &'static str> {
        if id.is_empty() || id.len() > 512 {
            return Err("invalid product connection identifier");
        }
        let options = SqliteConnectOptions::new().filename(path).read_only(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .map_err(|_| "cannot open product SQLite database read-only")?;
        let row = sqlx::query("SELECT provider, auth_type, is_active, api_key, updated_at FROM provider_connections WHERE id = ?")
            .bind(id).fetch_optional(&pool).await
            .map_err(|_| "cannot read product provider connection")?
            .ok_or("product provider connection not found")?;
        let provider: String = row
            .try_get("provider")
            .map_err(|_| "invalid product provider")?;
        let auth: Option<String> = row
            .try_get("auth_type")
            .map_err(|_| "invalid product authentication")?;
        let active: i64 = row
            .try_get("is_active")
            .map_err(|_| "invalid product connection state")?;
        if !matches!(provider.as_str(), "openrouter" | "openai")
            || auth.as_deref() != Some("apikey")
            || active != 1
        {
            return Err(
                "selected connection must be an active OpenRouter or OpenAI API-key connection",
            );
        }
        let stored: String = row
            .try_get("api_key")
            .map_err(|_| "product provider credential is missing")?;
        let updated_at: String = row
            .try_get("updated_at")
            .map_err(|_| "product connection timestamp is missing")?;
        let credential = decrypt(&stored, encryption_key)?;
        Ok((
            Self {
                pool,
                id: Arc::from(id),
                stored_key: Arc::from(stored),
                updated_at: Arc::from(updated_at),
                provider: Arc::from(provider),
                path: Arc::new(path.to_path_buf()),
                shared_rpm: None,
                usage_pool: None,
                auto_selection: false,
            },
            credential,
        ))
    }

    pub fn with_auto_selection_guard(mut self) -> Self {
        self.auto_selection = true;
        self
    }

    /// Other explicitly compatible accounts of the same provider, in the
    /// dashboard's priority order. Health is rechecked before use.
    pub async fn fallback_ids(&self) -> Result<Vec<String>, &'static str> {
        if !self.auto_selection {
            return Err("account fallback requires automatic selection");
        }
        let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM provider_connections WHERE provider = ? AND is_active = 1 AND id <> ? ORDER BY priority ASC, updated_at DESC LIMIT 9")
            .bind(self.provider.as_ref()).bind(self.id.as_ref()).fetch_all(&self.pool).await
            .map_err(|_| "product provider schema unavailable")?;
        if ids.len() > 8 {
            return Err("too many fallback connections");
        }
        Ok(ids)
    }

    /// Share the same accounting queue, so fallback never charges twice.
    pub fn inherit_accounting(mut self, source: &Self) -> Result<Self, &'static str> {
        if !self.same_database(source) {
            return Err("accounting must use the same product database");
        }
        self.shared_rpm = source.shared_rpm.clone();
        self.usage_pool = source.usage_pool.clone();
        Ok(self)
    }

    /// Opt in to recording complete non-streaming chat responses. This does
    /// not enable token or spend quotas; those remain explicitly unsupported.
    pub async fn with_usage_accounting(mut self) -> Result<Self, &'static str> {
        let options = SqliteConnectOptions::new()
            .filename(self.path.as_ref())
            .read_only(false)
            .create_if_missing(false)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .map_err(|_| "cannot open product SQLite for usage accounting")?;
        sqlx::query("SELECT event_id, pricing_known, tenant_id FROM request_cost_ledger LIMIT 0")
            .execute(&pool)
            .await
            .map_err(|_| "product cost ledger schema unavailable")?;
        self.usage_pool = Some(pool);
        Ok(self)
    }

    pub(crate) fn usage_accounting_enabled(&self) -> bool {
        self.usage_pool.is_some()
    }

    pub(crate) async fn usage_prices(
        &self,
        model: &str,
    ) -> Result<crate::accounting::TokenPrices, &'static str> {
        let raw: String = sqlx::query_scalar(
            "SELECT value FROM key_value WHERE namespace = 'pricing' AND key = ?",
        )
        .bind(self.provider.as_ref())
        .fetch_optional(&self.pool)
        .await
        .map_err(|_| "pricing unavailable")?
        .ok_or("explicit product pricing required")?;
        let prices: serde_json::Value =
            serde_json::from_str(&raw).map_err(|_| "invalid product pricing")?;
        let record = prices
            .get(model)
            .and_then(serde_json::Value::as_object)
            .ok_or("explicit model pricing required")?;
        // All components must be explicit: inherited catalog prices can differ
        // and are not yet reproduced by the Rust data plane.
        for key in ["input", "output", "cached", "cache_creation", "reasoning"] {
            if !record.get(key).is_some_and(serde_json::Value::is_number) {
                return Err("complete explicit model pricing required");
            }
        }
        crate::accounting::TokenPrices::from_record(&serde_json::Value::Object(record.clone()))
    }

    pub(crate) async fn record_usage(
        &self,
        key_id: &str,
        model: &str,
        usage: &crate::accounting::ChatUsage,
        prices: &crate::accounting::TokenPrices,
    ) -> Result<(), &'static str> {
        let pool = self
            .usage_pool
            .as_ref()
            .ok_or("usage accounting unavailable")?;
        let event_id: String = sqlx::query_scalar("SELECT lower(hex(randomblob(16)))")
            .fetch_one(pool)
            .await
            .map_err(|_| "usage accounting unavailable")?;
        let timestamp_ms = i64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "invalid clock")?
                .as_millis(),
        )
        .map_err(|_| "invalid clock")?;
        crate::accounting::record_completed_usage(
            pool,
            &crate::accounting::CompletedUsage {
                event_id: &event_id,
                key_id,
                provider: &self.provider,
                model,
                usage,
                prices,
                timestamp_ms,
            },
        )
        .await?;
        Ok(())
    }

    pub(crate) fn same_provider_database(&self, source: &Self) -> bool {
        self.path == source.path && self.provider == source.provider
    }

    pub(crate) fn same_database(&self, source: &Self) -> bool {
        self.path == source.path
    }

    pub(crate) async fn fallback_eligible(&self) -> bool {
        let row = sqlx::query("SELECT auth_type, tenant_id, rate_limited_until, test_status, per_key_proxy_enabled, max_concurrent, provider_specific_data, rate_limit_overrides_json FROM provider_connections WHERE id = ? AND provider = ? AND is_active = 1")
            .bind(self.id.as_ref()).bind(self.provider.as_ref()).fetch_optional(&self.pool).await;
        let Ok(Some(row)) = row else { return false };
        let Ok(auth) = row.try_get::<Option<String>, _>("auth_type") else {
            return false;
        };
        let Ok(tenant) = row.try_get::<String, _>("tenant_id") else {
            return false;
        };
        let Ok(status) = row.try_get::<Option<String>, _>("test_status") else {
            return false;
        };
        let Ok(cooldown) = row.try_get::<Option<String>, _>("rate_limited_until") else {
            return false;
        };
        let Ok(proxy) = row.try_get::<Option<i64>, _>("per_key_proxy_enabled") else {
            return false;
        };
        let Ok(concurrency) = row.try_get::<Option<i64>, _>("max_concurrent") else {
            return false;
        };
        if auth.as_deref() != Some("apikey")
            || tenant != "red"
            || status.as_deref().is_some_and(|s| {
                matches!(
                    s.trim().to_ascii_lowercase().as_str(),
                    "banned" | "expired" | "credits_exhausted"
                )
            })
            || cooldown.as_deref().is_some_and(|s| !s.trim().is_empty())
            || proxy.unwrap_or(0) != 0
            || concurrency.is_some_and(|n| n > 0)
        {
            return false;
        }
        for field in ["provider_specific_data", "rate_limit_overrides_json"] {
            let Ok(value) = row.try_get::<Option<String>, _>(field) else {
                return false;
            };
            if value
                .as_deref()
                .is_some_and(|s| !matches!(s.trim(), "" | "{}" | "null" | "[]"))
            {
                return false;
            }
        }
        let quota: Result<i64, _> = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM provider_quota_state WHERE connection_id = ?)",
        )
        .bind(self.id.as_ref())
        .fetch_one(&self.pool)
        .await;
        matches!(quota, Ok(0)) && self.unchanged().await
    }

    /// Opt in to updating the existing product RPM counters. The database and
    /// counter table must already exist; this never creates or migrates them.
    pub async fn with_shared_rpm(mut self) -> Result<Self, &'static str> {
        let options = SqliteConnectOptions::new()
            .filename(self.path.as_ref())
            .read_only(false)
            .create_if_missing(false)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .map_err(|_| "cannot open product SQLite for quota accounting")?;
        sqlx::query("SELECT api_key_id, dimension_key, bucket_index, consumed, updated_at FROM api_key_quota_counters LIMIT 0")
            .execute(&pool).await.map_err(|_| "product quota counter schema unavailable")?;
        let (sender, mut receiver) = mpsc::channel::<RpmReservation>(256);
        tokio::spawn(async move {
            while let Some(first) = receiver.recv().await {
                let mut batch = vec![first];
                while batch.len() < 64 {
                    match receiver.try_recv() {
                        Ok(request) => batch.push(request),
                        Err(_) => break,
                    }
                }
                let result = reserve_batch(&pool, &batch).await;
                match result {
                    Ok(results) => {
                        for (request, allowed) in batch.into_iter().zip(results) {
                            let _ = request.reply.send(Ok(allowed));
                        }
                    }
                    Err(error) => {
                        for request in batch {
                            let _ = request.reply.send(Err(error));
                        }
                    }
                }
            }
        });
        self.shared_rpm = Some(sender);
        Ok(self)
    }

    /// Reserve one request before forwarding using the product's 60-second,
    /// weighted two-bucket RPM counter. Rust instances sharing this SQLite
    /// file serialize reservations through BEGIN IMMEDIATE.
    pub(crate) async fn reserve_rpm(&self, key_id: &str) -> Result<bool, &'static str> {
        let Some(sender) = &self.shared_rpm else {
            return Ok(true);
        };
        let (reply, response) = oneshot::channel();
        sender
            .send(RpmReservation {
                key_id: key_id.to_owned(),
                reply,
            })
            .await
            .map_err(|_| "quota accounting unavailable")?;
        response.await.map_err(|_| "quota accounting unavailable")?
    }

    /// Recheck revocation and edits before each request. In-flight requests can
    /// still finish after a change; restart to pick up a changed credential.
    pub async fn unchanged(&self) -> bool {
        if self.auto_selection {
            return Self::select_from_pool(
                &self.pool,
                self.provider.as_ref(),
                Some((&self.id, &self.stored_key, &self.updated_at)),
            )
            .await
            .is_ok();
        }
        let result = sqlx::query("SELECT 1 FROM provider_connections WHERE id = ? AND provider = ? AND auth_type = 'apikey' AND is_active = 1 AND api_key = ? AND updated_at = ?")
            .bind(self.id.as_ref()).bind(self.provider.as_ref()).bind(self.stored_key.as_ref()).bind(self.updated_at.as_ref())
            .fetch_optional(&self.pool).await;
        matches!(result, Ok(Some(_)))
    }

    pub fn upstream_url(&self) -> &'static str {
        match self.provider.as_ref() {
            "openai" => "https://api.openai.com/v1/chat/completions",
            _ => "https://openrouter.ai/api/v1/chat/completions",
        }
    }

    /// This conservative subset refuses policies whose shared accounting or
    /// routing semantics are not yet implemented by the Rust gateway.
    pub(crate) async fn client_policies(
        &self,
        candidate: &str,
        combo_name: Option<&str>,
    ) -> Result<Option<ProductAccess>, &'static str> {
        if !(16..=512).contains(&candidate.len()) {
            return Ok(None);
        }
        let hash = hex::encode(Sha256::digest(candidate.as_bytes()));
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| "product policy unavailable")?;
        let row = sqlx::query("SELECT *, CASE WHEN expires_at IS NULL OR trim(expires_at) = '' THEN 1 WHEN julianday(expires_at) > julianday('now') THEN 1 ELSE 0 END AS unexpired FROM api_keys WHERE key = ? OR key_hash = ? LIMIT 1")
            .bind(candidate).bind(hash).fetch_optional(&mut *tx).await
            .map_err(|_| "product key schema unavailable")?;
        let Some(row) = row else { return Ok(None) };
        let integer = |name: &str| {
            row.try_get::<Option<i64>, _>(name)
                .map_err(|_| "product key schema unavailable")
        };
        let string = |name: &str| {
            row.try_get::<Option<String>, _>(name)
                .map_err(|_| "product key schema unavailable")
        };
        if let (Some(name), Some(raw)) = (combo_name, string("allowed_combos")?) {
            let rules: Vec<String> =
                serde_json::from_str(&raw).map_err(|_| "invalid product combo policy")?;
            if !rules.iter().any(|rule| {
                rule == "combo/*" || rule == name || rule.strip_prefix("combo/") == Some(name)
            }) {
                return Ok(None);
            }
        }
        if integer("is_active")? != Some(1)
            || integer("is_banned")?.unwrap_or(0) != 0
            || string("revoked_at")?.is_some()
            || integer("unexpired")? != Some(1)
        {
            return Ok(None);
        }
        let key_id = string("id")?.ok_or("invalid product key")?;
        for name in [
            "max_requests_per_day",
            "max_requests_per_minute",
            "throttle_delay_ms",
            "max_sessions",
            "usage_limit_enabled",
            "disable_non_public_models",
            "auto_resolve",
        ] {
            if integer(name)?.unwrap_or(0) != 0 {
                return Err("unsupported product policy");
            }
        }
        for name in ["access_schedule", "proxy_id"] {
            if string(name)?.is_some_and(|v| !v.trim().is_empty()) {
                return Err("unsupported product policy");
            }
        }
        if string("tenant_id")?
            .as_deref()
            .is_some_and(|tenant| tenant != "red")
        {
            return Err("unsupported product tenant policy");
        }
        let parse_list = |name: &str| -> Result<Vec<String>, &'static str> {
            match string(name)? {
                None => Ok(Vec::new()),
                Some(value) if value.trim().is_empty() || value.trim() == "null" => Ok(Vec::new()),
                Some(value) => serde_json::from_str(&value).map_err(|_| "invalid product policy"),
            }
        };
        for name in ["ip_allowlist", "scopes", "rate_limits", "allowed_quotas"] {
            if !parse_list(name)?.is_empty() {
                return Err("unsupported product policy");
            }
        }
        let connections = parse_list("allowed_connections")?;
        if !connections.is_empty() && !connections.iter().any(|id| id == self.id.as_ref()) {
            return Ok(None);
        }
        let allowed = parse_list("allowed_models")?;
        let blocked = parse_list("blocked_models")?;
        // The product expands provider aliases and context suffixes before
        // deny-list matching. A direct string check could bypass a deny rule.
        if !blocked.is_empty() {
            return Err("product model deny-list requires alias resolution");
        }
        // A bare '*' has different semantics in the product matcher and must
        // not be widened to the environment policy matcher's global wildcard.
        if allowed.iter().any(|p| p == "*") {
            return Err("unsupported product model wildcard");
        }
        let endpoints = parse_list("allowed_endpoints")?;
        let mode = string("model_access_mode")?;
        if !matches!(mode.as_deref(), None | Some("all") | Some("restricted")) {
            return Err("unsupported product model policy");
        }
        let restricted = mode.as_deref() == Some("restricted") || !allowed.is_empty();
        let unsupported: i64 = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM domain_budgets WHERE api_key_id = ?)
              OR EXISTS(SELECT 1 FROM api_key_token_limits WHERE api_key_id = ? AND enabled = 1)
              OR EXISTS(SELECT 1 FROM api_key_quota_limits WHERE api_key_id = ? AND (COALESCE(tpm_limit,0)>0 OR (COALESCE(rpm_limit,0)>0 AND ? = 0) OR COALESCE(monthly_amount_usd,0)>0))
              OR EXISTS(SELECT 1 FROM api_key_daily_token_limits WHERE api_key_id = ?)
              OR EXISTS(SELECT 1 FROM key_group_members WHERE key_id = ?)
              OR EXISTS(SELECT 1 FROM budget_assignments)
              OR NOT EXISTS(SELECT 1 FROM provider_connections WHERE id = ? AND tenant_id = 'red')
              OR EXISTS(SELECT 1 FROM model_combo_mappings WHERE enabled = 1)"
        ).bind(&key_id).bind(&key_id).bind(&key_id).bind(i64::from(self.shared_rpm.is_some())).bind(&key_id).bind(&key_id).bind(self.id.as_ref())
            .fetch_one(&mut *tx).await.map_err(|_| "product quota schema unavailable")?;
        if unsupported != 0 {
            return Err("unsupported product quota or routing policy");
        }
        let disabled: Option<String> = sqlx::query_scalar(
            "SELECT value FROM key_value WHERE namespace = 'settings' AND key = 'disabledModels'",
        )
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| "product settings unavailable")?;
        if let Some(value) = disabled {
            let disabled: Vec<String> =
                serde_json::from_str(&value).map_err(|_| "invalid product disabled models")?;
            if !disabled.is_empty() {
                return Err("unsupported global model policy");
            }
        }
        tx.commit()
            .await
            .map_err(|_| "product policy unavailable")?;
        let mut config = serde_json::json!({"api_key_env":"PRODUCT_KEY", "blocked_models": blocked, "allowed_endpoints": endpoints});
        if restricted {
            config["allowed_routes"] = serde_json::json!(allowed);
            config["allowed_models"] = config["allowed_routes"].clone();
        }
        let config = serde_json::json!([config]).to_string();
        let policies =
            crate::policy::ClientPolicies::parse(&config, |_| Some(candidate.to_owned()))
                .map_err(|_| "unsupported product policy")?;
        Ok(Some(ProductAccess { policies, key_id }))
    }

    pub(crate) async fn direct_model(&self, model: &str) -> Result<Option<String>, &'static str> {
        if model.starts_with("auto/")
            || model.starts_with("qtSd/")
            || model.starts_with("combo/")
            || model.starts_with("quotaShared-")
        {
            return Ok(None);
        }
        let Some((provider, upstream_model)) = model.split_once('/') else {
            return Ok(None);
        };
        if provider != self.provider.as_ref()
            || upstream_model.is_empty()
            || upstream_model.trim() != upstream_model
        {
            return Ok(None);
        }
        let exists: i64 = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM combos WHERE name = ?)")
            .bind(model)
            .fetch_one(&self.pool)
            .await
            .map_err(|_| "product combo schema unavailable")?;
        Ok((exists == 0).then(|| upstream_model.to_owned()))
    }
}

async fn reserve_batch(
    pool: &SqlitePool,
    requests: &[RpmReservation],
) -> Result<Vec<bool>, &'static str> {
    let mut tx = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|_| "quota accounting unavailable")?;
    let mut results = Vec::with_capacity(requests.len());
    for request in requests {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| "system clock unavailable")?
            .as_millis();
        let now = i64::try_from(now).map_err(|_| "system clock unavailable")?;
        let bucket = now / 60_000;
        let key_id = &request.key_id;
        let limits = sqlx::query("SELECT rpm_limit, tpm_limit, monthly_amount_usd FROM api_key_quota_limits WHERE api_key_id = ?")
            .bind(key_id).fetch_optional(&mut *tx).await.map_err(|_| "quota limits unavailable")?;
        let rpm = if let Some(row) = limits {
            let tpm: Option<i64> = row
                .try_get("tpm_limit")
                .map_err(|_| "invalid quota limits")?;
            let monthly: Option<f64> = row
                .try_get("monthly_amount_usd")
                .map_err(|_| "invalid quota limits")?;
            if tpm.unwrap_or(0) > 0 || monthly.unwrap_or(0.0) > 0.0 {
                return Err("unsupported product quota");
            }
            row.try_get::<Option<i64>, _>("rpm_limit")
                .map_err(|_| "invalid quota limits")?
        } else {
            None
        };
        let row = sqlx::query("SELECT CAST(COALESCE(SUM(CASE WHEN bucket_index = ? THEN consumed ELSE 0 END), 0) AS REAL) AS current, CAST(COALESCE(SUM(CASE WHEN bucket_index = ? THEN consumed ELSE 0 END), 0) AS REAL) AS previous FROM api_key_quota_counters WHERE api_key_id = ? AND dimension_key = 'key-quota:rpm' AND bucket_index IN (?, ?)")
            .bind(bucket).bind(bucket - 1).bind(key_id).bind(bucket).bind(bucket - 1)
            .fetch_one(&mut *tx).await.map_err(|_| "quota counters unavailable")?;
        let current: f64 = row
            .try_get("current")
            .map_err(|_| "invalid quota counter")?;
        let previous: f64 = row
            .try_get("previous")
            .map_err(|_| "invalid quota counter")?;
        if !current.is_finite() || !previous.is_finite() || current < 0.0 || previous < 0.0 {
            return Err("invalid quota counter");
        }
        let effective = current + previous * (1.0 - (now % 60_000) as f64 / 60_000.0);
        if rpm.is_some_and(|limit| limit > 0 && effective >= limit as f64) {
            results.push(false);
            continue;
        }
        sqlx::query("INSERT INTO api_key_quota_counters (api_key_id, dimension_key, bucket_index, consumed, updated_at) VALUES (?, 'key-quota:rpm', ?, 1, ?) ON CONFLICT(api_key_id, dimension_key, bucket_index) DO UPDATE SET consumed = consumed + 1, updated_at = excluded.updated_at")
            .bind(key_id).bind(bucket).bind(now).execute(&mut *tx).await
            .map_err(|_| "quota accounting unavailable")?;
        results.push(true);
    }
    tx.commit()
        .await
        .map_err(|_| "quota accounting unavailable")?;
    Ok(results)
}

fn decrypt(stored: &str, encryption_key: Option<&str>) -> Result<Zeroizing<String>, &'static str> {
    if !stored.starts_with("enc:") {
        return Ok(Zeroizing::new(stored.to_owned()));
    }
    let secret = encryption_key
        .filter(|s| !s.trim().is_empty())
        .ok_or("STORAGE_ENCRYPTION_KEY is required")?;
    let parts: Vec<_> = stored.split(':').collect();
    if parts.len() != 5 || parts[0] != "enc" || parts[1] != "v1" || stored.len() > 4096 {
        return Err("unsupported encrypted provider credential");
    }
    let iv = hex::decode(parts[2]).map_err(|_| "invalid encrypted provider credential")?;
    let mut ciphertext =
        hex::decode(parts[3]).map_err(|_| "invalid encrypted provider credential")?;
    let tag = hex::decode(parts[4]).map_err(|_| "invalid encrypted provider credential")?;
    if iv.len() != 16 || tag.len() != 16 {
        return Err("invalid encrypted provider credential");
    }
    ciphertext.extend_from_slice(&tag);
    let mut key = Zeroizing::new([0u8; 32]);
    let params = scrypt::Params::new(14, 8, 1, 32).map_err(|_| "invalid encryption parameters")?;
    scrypt::scrypt(
        secret.as_bytes(),
        b"omniroute-field-encryption-v1",
        &params,
        key.as_mut(),
    )
    .map_err(|_| "could not derive storage encryption key")?;
    let cipher =
        ProductCipher::new_from_slice(key.as_ref()).map_err(|_| "invalid encryption key")?;
    let plaintext = cipher
        .decrypt(Nonce::<U16>::from_slice(&iv), ciphertext.as_ref())
        .map_err(|_| "cannot decrypt product provider credential")?;
    let plaintext = Zeroizing::new(plaintext);
    let value =
        std::str::from_utf8(&plaintext).map_err(|_| "invalid provider credential encoding")?;
    Ok(Zeroizing::new(value.to_owned()))
}
