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
use std::{path::Path, sync::Arc};
use zeroize::Zeroizing;

type ProductCipher = AesGcm<Aes256, U16>;

#[derive(Clone)]
pub struct ProductConnection {
    pool: SqlitePool,
    id: Arc<str>,
    stored_key: Arc<str>,
    updated_at: Arc<str>,
    provider: Arc<str>,
}

impl ProductConnection {
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
            },
            credential,
        ))
    }

    /// Recheck revocation and edits before each request. In-flight requests can
    /// still finish after a change; restart to pick up a changed credential.
    pub async fn unchanged(&self) -> bool {
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
    ) -> Result<Option<crate::policy::ClientPolicies>, &'static str> {
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
              OR EXISTS(SELECT 1 FROM api_key_quota_limits WHERE api_key_id = ? AND (COALESCE(tpm_limit,0)>0 OR COALESCE(rpm_limit,0)>0 OR COALESCE(monthly_amount_usd,0)>0))
              OR EXISTS(SELECT 1 FROM api_key_daily_token_limits WHERE api_key_id = ?)
              OR EXISTS(SELECT 1 FROM key_group_members WHERE key_id = ?)
              OR EXISTS(SELECT 1 FROM budget_assignments)
              OR NOT EXISTS(SELECT 1 FROM provider_connections WHERE id = ? AND tenant_id = 'red')
              OR EXISTS(SELECT 1 FROM model_combo_mappings WHERE enabled = 1)"
        ).bind(&key_id).bind(&key_id).bind(&key_id).bind(&key_id).bind(&key_id).bind(self.id.as_ref())
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
        Ok(Some(policies))
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
