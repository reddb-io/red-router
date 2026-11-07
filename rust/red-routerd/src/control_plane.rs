//! Authenticated Rust control plane for provider persistence and live reload.
use crate::{
    policy::{ClientPolicies, StoredPolicy},
    storage::{StoredClientKey, StoredProvider},
    LiveProvider, ProxyState,
};
use aes_gcm::aead::consts::U16;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    aes::Aes256,
    AesGcm, Nonce,
};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::RwLock;
use zeroize::{Zeroize, Zeroizing};

type ControlCipher = AesGcm<Aes256, U16>;

struct Inner {
    database: Arc<crate::storage::Database>,
    current: RwLock<Option<LiveProvider>>,
    clients: RwLock<ClientSnapshot>,
    admin_hash: [u8; 32],
    encryption_key: Zeroizing<String>,
    allow_private: bool,
}

enum ClientSnapshot {
    Legacy,
    Current(Arc<ClientPolicies>),
    Unavailable,
}

#[derive(Clone)]
pub struct ControlPlane(Arc<Inner>);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderInput {
    pub provider: String,
    pub upstream_url: String,
    pub api_key: String,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
pub struct ProviderView {
    pub id: String,
    pub provider: String,
    pub upstream_url: String,
    pub enabled: bool,
    pub revision: String,
    pub has_credential: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientKeyInput {
    pub label: String,
    pub api_key: Option<String>,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    pub expires_at_unix: Option<u64>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub allowed_endpoints: Vec<String>,
    #[serde(default)]
    pub allowed_models: Vec<String>,
    #[serde(default)]
    pub blocked_models: Vec<String>,
    #[serde(default)]
    pub allowed_provider_ids: Vec<String>,
    pub max_concurrent_requests: Option<u64>,
    pub max_requests_per_minute: Option<u64>,
    pub max_requests_per_day: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct ClientKeyView {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub expires_at_unix: Option<u64>,
    pub scopes: Vec<String>,
    pub allowed_endpoints: Vec<String>,
    pub allowed_models: Vec<String>,
    pub blocked_models: Vec<String>,
    pub allowed_provider_ids: Vec<String>,
    pub max_concurrent_requests: Option<u64>,
    pub max_requests_per_minute: Option<u64>,
    pub max_requests_per_day: Option<u64>,
    pub revision: String,
}

fn enabled_by_default() -> bool {
    true
}

impl ControlPlane {
    pub async fn new(
        database: Arc<crate::storage::Database>,
        admin_key: &str,
        encryption_key: &str,
        allow_private: bool,
    ) -> Result<Self, &'static str> {
        if !(32..=512).contains(&admin_key.len()) {
            return Err("RED_ROUTER_ADMIN_KEY must be 32-512 bytes");
        }
        if !(16..=512).contains(&encryption_key.len()) {
            return Err("STORAGE_ENCRYPTION_KEY must be 16-512 bytes");
        }
        let plane = Self(Arc::new(Inner {
            database,
            current: RwLock::new(None),
            clients: RwLock::new(ClientSnapshot::Unavailable),
            admin_hash: Sha256::digest(admin_key.as_bytes()).into(),
            encryption_key: Zeroizing::new(encryption_key.to_owned()),
            allow_private,
        }));
        plane.refresh().await?;
        plane.refresh_clients().await?;
        Ok(plane)
    }

    pub(crate) async fn current(&self) -> Option<LiveProvider> {
        self.0.current.read().await.clone()
    }

    pub(crate) async fn client_policies(
        &self,
    ) -> Result<Option<Arc<ClientPolicies>>, &'static str> {
        match &*self.0.clients.read().await {
            ClientSnapshot::Legacy => Ok(None),
            ClientSnapshot::Current(policies) => Ok(Some(policies.clone())),
            ClientSnapshot::Unavailable => Err("client key storage unavailable"),
        }
    }

    pub async fn has_active_provider(&self) -> Result<bool, &'static str> {
        self.0
            .database
            .active_provider()
            .await
            .map(|row| row.is_some())
    }

    pub(crate) async fn ready(&self) -> bool {
        let client_keys_ready = match &*self.0.clients.read().await {
            ClientSnapshot::Legacy => true,
            ClientSnapshot::Current(policies) => policies.has_active(),
            ClientSnapshot::Unavailable => false,
        };
        client_keys_ready
            && self
                .0
                .database
                .active_provider()
                .await
                .is_ok_and(|row| row.is_some())
            && self.0.current.read().await.is_some()
    }

    pub async fn configure_provider(
        &self,
        id: &str,
        input: ProviderInput,
    ) -> Result<ProviderView, &'static str> {
        validate_id(id)?;
        validate_provider(&input.provider)?;
        if !(1..=512).contains(&input.api_key.len()) {
            return Err("provider API key must be 1-512 bytes");
        }
        if input.upstream_url.len() > 2048 {
            return Err("provider upstream URL is too long");
        }
        // Resolve and pin DNS before changing durable or live configuration.
        let api_key = Zeroizing::new(input.api_key);
        let live =
            ProxyState::live_provider(&input.upstream_url, api_key.as_str(), self.0.allow_private)
                .await?;
        let revision = revision()?;
        let ciphertext = encrypt(api_key.as_str(), id, self.0.encryption_key.as_str())?;
        let stored = StoredProvider {
            id: id.to_owned(),
            provider: input.provider,
            upstream_url: input.upstream_url,
            credential_ciphertext: ciphertext,
            enabled: input.enabled,
            updated_at: revision,
        };
        self.0.database.upsert_provider(&stored).await?;
        // Refresh from the durable authority so concurrent writers converge on
        // the same latest enabled record rather than on local write order.
        if let Err(error) = self.refresh().await {
            *self.0.current.write().await = None;
            return Err(error);
        }
        // Avoid retaining an extra sensitive client/header graph for disabled rows.
        drop(live);
        Ok(view(&stored))
    }

    pub async fn disable(&self, id: &str) -> Result<(), &'static str> {
        validate_id(id)?;
        self.0.database.disable_provider(id, revision()?).await?;
        if let Err(error) = self.refresh().await {
            *self.0.current.write().await = None;
            return Err(error);
        }
        Ok(())
    }

    pub async fn configure_client_key(
        &self,
        id: &str,
        input: ClientKeyInput,
    ) -> Result<ClientKeyView, &'static str> {
        validate_id(id)?;
        validate_label(&input.label)?;
        validate_client_lists(&input)?;
        let existing = self
            .0
            .database
            .client_keys()
            .await?
            .into_iter()
            .find(|row| row.id == id);
        let key_hash = match input.api_key {
            Some(key) if (16..=512).contains(&key.len()) => {
                let key = Zeroizing::new(key);
                hex::encode(Sha256::digest(key.as_bytes()))
            }
            Some(_) => return Err("client API key must be 16-512 bytes"),
            None => existing
                .as_ref()
                .map(|row| row.key_hash.clone())
                .ok_or("client API key is required for a new key")?,
        };
        let expiry_unix = input
            .expires_at_unix
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "client key expiry is out of range")?
            .unwrap_or(0);
        let record = StoredClientKey {
            id: id.to_owned(),
            label: input.label,
            key_hash,
            enabled: input.enabled,
            expiry_unix,
            scopes_json: json_list(&input.scopes)?,
            allowed_endpoints_json: json_list(&input.allowed_endpoints)?,
            allowed_models_json: json_list(&input.allowed_models)?,
            blocked_models_json: json_list(&input.blocked_models)?,
            allowed_provider_ids_json: json_list(&input.allowed_provider_ids)?,
            max_concurrent: optional_limit(input.max_concurrent_requests, 65_535)?,
            max_rpm: optional_limit(input.max_requests_per_minute, 10_000)?,
            max_rpd: optional_limit(input.max_requests_per_day, 10_000_000)?,
            revision: revision()?,
        };
        self.0.database.upsert_client_key(&record).await?;
        if self.refresh_clients().await.is_err() {
            *self.0.clients.write().await = ClientSnapshot::Unavailable;
            return Err("cannot reload client key configuration");
        }
        client_view(&record)
    }

    pub async fn revoke_client_key(&self, id: &str) -> Result<(), &'static str> {
        validate_id(id)?;
        self.0.database.revoke_client_key(id, revision()?).await?;
        if self.refresh_clients().await.is_err() {
            *self.0.clients.write().await = ClientSnapshot::Unavailable;
            return Err("cannot reload client key configuration");
        }
        Ok(())
    }

    async fn refresh(&self) -> Result<(), &'static str> {
        let live = match self.0.database.active_provider().await? {
            Some(record) => {
                let credential = decrypt(
                    &record.credential_ciphertext,
                    &record.id,
                    self.0.encryption_key.as_str(),
                )?;
                let mut live = ProxyState::live_provider(
                    &record.upstream_url,
                    credential.as_str(),
                    self.0.allow_private,
                )
                .await?;
                live.provider_id = Some(Arc::from(record.id));
                Some(live)
            }
            None => None,
        };
        *self.0.current.write().await = live;
        Ok(())
    }

    async fn refresh_clients(&self) -> Result<(), &'static str> {
        let records = self.0.database.client_keys().await?;
        let snapshot = if records.is_empty() {
            ClientSnapshot::Legacy
        } else {
            let policies = records
                .iter()
                .map(stored_policy)
                .collect::<Result<Vec<_>, _>>()?;
            ClientSnapshot::Current(Arc::new(ClientPolicies::from_stored(policies)))
        };
        *self.0.clients.write().await = snapshot;
        Ok(())
    }

    async fn views(&self) -> Result<Vec<ProviderView>, &'static str> {
        self.0
            .database
            .providers()
            .await
            .map(|rows| rows.iter().map(view).collect())
    }

    async fn client_views(&self) -> Result<Vec<ClientKeyView>, &'static str> {
        self.0
            .database
            .client_keys()
            .await?
            .iter()
            .map(client_view)
            .collect()
    }

    fn authorized(&self, headers: &HeaderMap) -> bool {
        if headers.get_all(header::AUTHORIZATION).iter().count() != 1 {
            return false;
        }
        let Some(candidate) = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|value| (32..=512).contains(&value.len()))
        else {
            return false;
        };
        let digest: [u8; 32] = Sha256::digest(candidate.as_bytes()).into();
        bool::from(self.0.admin_hash.ct_eq(&digest))
    }
}

fn view(record: &StoredProvider) -> ProviderView {
    ProviderView {
        id: record.id.clone(),
        provider: record.provider.clone(),
        upstream_url: record.upstream_url.clone(),
        enabled: record.enabled,
        revision: record.updated_at.to_string(),
        has_credential: !record.credential_ciphertext.is_empty(),
    }
}

fn client_view(record: &StoredClientKey) -> Result<ClientKeyView, &'static str> {
    let expires_at_unix = match record.expiry_unix {
        0 => None,
        value if value > 0 => Some(value as u64),
        _ => return Err("invalid client key expiry"),
    };
    Ok(ClientKeyView {
        id: record.id.clone(),
        label: record.label.clone(),
        enabled: record.enabled,
        expires_at_unix,
        scopes: parse_list(&record.scopes_json)?,
        allowed_endpoints: parse_list(&record.allowed_endpoints_json)?,
        allowed_models: parse_list(&record.allowed_models_json)?,
        blocked_models: parse_list(&record.blocked_models_json)?,
        allowed_provider_ids: parse_list(&record.allowed_provider_ids_json)?,
        max_concurrent_requests: positive_u64(record.max_concurrent)?,
        max_requests_per_minute: positive_u64(record.max_rpm)?,
        max_requests_per_day: positive_u64(record.max_rpd)?,
        revision: record.revision.to_string(),
    })
}

fn stored_policy(record: &StoredClientKey) -> Result<StoredPolicy, &'static str> {
    let decoded = hex::decode(&record.key_hash).map_err(|_| "invalid client key hash")?;
    let key_hash: [u8; 32] = decoded.try_into().map_err(|_| "invalid client key hash")?;
    let view = client_view(record)?;
    validate_scope_list(&view.scopes)?;
    validate_endpoint_list(&view.allowed_endpoints)?;
    validate_patterns(&view.allowed_models)?;
    validate_patterns(&view.blocked_models)?;
    for id in &view.allowed_provider_ids {
        validate_id(id)?;
    }
    Ok(StoredPolicy {
        key_hash,
        enabled: record.enabled,
        expires_at_unix: view.expires_at_unix,
        scopes: view.scopes,
        allowed_models: view.allowed_models,
        allowed_endpoints: view.allowed_endpoints,
        blocked_models: view.blocked_models,
        allowed_provider_ids: view.allowed_provider_ids,
        max_concurrent_requests: optional_usize(record.max_concurrent, 65_535)?,
        max_requests_per_minute: optional_usize(record.max_rpm, 10_000)?,
        max_requests_per_day: optional_usize(record.max_rpd, 10_000_000)?,
    })
}

fn validate_client_lists(input: &ClientKeyInput) -> Result<(), &'static str> {
    validate_scope_list(&input.scopes)?;
    validate_endpoint_list(&input.allowed_endpoints)?;
    validate_patterns(&input.allowed_models)?;
    validate_patterns(&input.blocked_models)?;
    if input.allowed_provider_ids.len() > 128 {
        return Err("too many allowed provider identifiers");
    }
    for id in &input.allowed_provider_ids {
        validate_id(id)?;
    }
    for list in [
        &input.scopes,
        &input.allowed_endpoints,
        &input.allowed_models,
        &input.blocked_models,
        &input.allowed_provider_ids,
    ] {
        if list
            .iter()
            .enumerate()
            .any(|(index, value)| list[..index].contains(value))
        {
            return Err("client key policy contains duplicate entries");
        }
    }
    Ok(())
}

fn validate_scope_list(values: &[String]) -> Result<(), &'static str> {
    if values.len() > 20
        || values.iter().any(|value| {
            !matches!(
                value.as_str(),
                "inference:*" | "inference:chat" | "inference:embeddings" | "inference:rerank"
            )
        })
    {
        return Err("invalid client key scopes");
    }
    Ok(())
}

fn validate_endpoint_list(values: &[String]) -> Result<(), &'static str> {
    if values.len() > 20
        || values
            .iter()
            .any(|value| !matches!(value.as_str(), "chat" | "embeddings" | "rerank"))
    {
        return Err("invalid client key endpoint grants");
    }
    Ok(())
}

fn validate_patterns(values: &[String]) -> Result<(), &'static str> {
    if values.len() > 128 {
        return Err("too many client key model patterns");
    }
    for pattern in values {
        if pattern.is_empty()
            || pattern.len() > 256
            || (pattern != "*"
                && pattern.contains('*')
                && !(pattern.ends_with("/*") && !pattern[..pattern.len() - 1].contains('*')))
        {
            return Err("invalid client key model pattern");
        }
    }
    Ok(())
}

fn validate_label(value: &str) -> Result<(), &'static str> {
    if value.trim().is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err("invalid client key label");
    }
    Ok(())
}

fn json_list(values: &[String]) -> Result<String, &'static str> {
    serde_json::to_string(values).map_err(|_| "cannot encode client key policy")
}

fn parse_list(value: &str) -> Result<Vec<String>, &'static str> {
    if value.len() > 256 * 1024 {
        return Err("invalid client key policy");
    }
    serde_json::from_str(value).map_err(|_| "invalid client key policy")
}

fn optional_limit(value: Option<u64>, maximum: u64) -> Result<i64, &'static str> {
    value
        .map(|value| {
            if value == 0 || value > maximum {
                return Err("invalid client key limit");
            }
            i64::try_from(value).map_err(|_| "invalid client key limit")
        })
        .transpose()
        .map(|value| value.unwrap_or(0))
}

fn optional_usize(value: i64, maximum: usize) -> Result<Option<usize>, &'static str> {
    if value == 0 {
        return Ok(None);
    }
    usize::try_from(value)
        .ok()
        .filter(|value| (1..=maximum).contains(value))
        .map(Some)
        .ok_or("invalid client key limit")
}

fn positive_u64(value: i64) -> Result<Option<u64>, &'static str> {
    match value {
        0 => Ok(None),
        value if value > 0 => Ok(Some(value as u64)),
        _ => Err("invalid client key limit"),
    }
}

fn validate_id(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid provider identifier");
    }
    Ok(())
}

fn validate_provider(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("invalid provider name");
    }
    if value != "openai-compatible" && crate::product_provider::chat_url(value).is_none() {
        return Err("provider is not OpenAI-compatible");
    }
    Ok(())
}

fn revision() -> Result<i64, &'static str> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is unavailable")?
        .as_nanos();
    i64::try_from(nanos).map_err(|_| "system clock is out of range")
}

fn derive_key(secret: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, &'static str> {
    let mut key = Zeroizing::new([0u8; 32]);
    let params = scrypt::Params::new(14, 8, 1, 32).map_err(|_| "invalid encryption parameters")?;
    scrypt::scrypt(secret.as_bytes(), salt, &params, key.as_mut())
        .map_err(|_| "could not derive storage encryption key")?;
    Ok(key)
}

fn encrypt(value: &str, id: &str, secret: &str) -> Result<String, &'static str> {
    let mut salt = Zeroizing::new([0u8; 16]);
    let mut nonce = Zeroizing::new([0u8; 16]);
    getrandom::fill(salt.as_mut()).map_err(|_| "cannot generate credential salt")?;
    getrandom::fill(nonce.as_mut()).map_err(|_| "cannot generate credential nonce")?;
    let key = derive_key(secret, salt.as_ref())?;
    let cipher =
        ControlCipher::new_from_slice(key.as_ref()).map_err(|_| "invalid encryption key")?;
    let mut ciphertext = cipher
        .encrypt(
            Nonce::<U16>::from_slice(nonce.as_ref()),
            Payload {
                msg: value.as_bytes(),
                aad: id.as_bytes(),
            },
        )
        .map_err(|_| "cannot encrypt provider credential")?;
    let encoded = format!(
        "rr:v1:{}:{}:{}",
        hex::encode(salt.as_ref()),
        hex::encode(nonce.as_ref()),
        hex::encode(&ciphertext)
    );
    ciphertext.zeroize();
    Ok(encoded)
}

fn decrypt(stored: &str, id: &str, secret: &str) -> Result<Zeroizing<String>, &'static str> {
    let parts: Vec<_> = stored.split(':').collect();
    if parts.len() != 5 || parts[0] != "rr" || parts[1] != "v1" || stored.len() > 8192 {
        return Err("unsupported Rust provider credential");
    }
    let salt =
        Zeroizing::new(hex::decode(parts[2]).map_err(|_| "invalid encrypted provider credential")?);
    let nonce =
        Zeroizing::new(hex::decode(parts[3]).map_err(|_| "invalid encrypted provider credential")?);
    let mut ciphertext =
        Zeroizing::new(hex::decode(parts[4]).map_err(|_| "invalid encrypted provider credential")?);
    if salt.len() != 16 || nonce.len() != 16 || ciphertext.len() < 16 {
        return Err("invalid encrypted provider credential");
    }
    let key = derive_key(secret, salt.as_ref())?;
    let cipher =
        ControlCipher::new_from_slice(key.as_ref()).map_err(|_| "invalid encryption key")?;
    let plaintext = cipher
        .decrypt(
            Nonce::<U16>::from_slice(nonce.as_ref()),
            Payload {
                msg: ciphertext.as_ref(),
                aad: id.as_bytes(),
            },
        )
        .map_err(|_| "cannot decrypt Rust provider credential")?;
    ciphertext.zeroize();
    let plaintext = Zeroizing::new(plaintext);
    let value = std::str::from_utf8(plaintext.as_ref())
        .map_err(|_| "invalid provider credential encoding")?;
    Ok(Zeroizing::new(value.to_owned()))
}

fn api_error(status: StatusCode, message: &'static str) -> Response {
    (
        status,
        Json(serde_json::json!({"error":{"message":message,"type":"control_plane_error"}})),
    )
        .into_response()
}

pub async fn list(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
    };
    if !control.authorized(&headers) {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    match control.views().await {
        Ok(providers) => Json(serde_json::json!({"providers":providers})).into_response(),
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider storage unavailable",
        ),
    }
}

pub async fn list_client_keys(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
    };
    if !control.authorized(&headers) {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    match control.client_views().await {
        Ok(keys) => Json(serde_json::json!({"client_keys":keys})).into_response(),
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Client key storage unavailable",
        ),
    }
}

pub async fn put_provider(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ProviderInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
    };
    if !control.authorized(&headers) {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    match control.configure_provider(&id, input).await {
        Ok(provider) => Json(serde_json::json!({"provider":provider})).into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider storage or runtime unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid provider configuration"),
    }
}

fn is_runtime_error(error: &str) -> bool {
    error.contains("database")
        || error.contains("provider configuration")
        || error.contains("active provider")
        || error.contains("encrypted provider credential")
        || error.contains("decrypt")
        || error.contains("storage encryption")
        || error.contains("cannot write")
        || error.contains("cannot read")
        || error.contains("cannot reload")
}

pub async fn delete_provider(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
    };
    if !control.authorized(&headers) {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    match control.disable(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) if is_runtime_error(error) || error == "cannot disable provider" => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid provider identifier"),
    }
}

pub async fn put_client_key(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ClientKeyInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
    };
    if !control.authorized(&headers) {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    match control.configure_client_key(&id, input).await {
        Ok(key) => Json(serde_json::json!({"client_key":key})).into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Client key storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid client key configuration"),
    }
}

pub async fn delete_client_key(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
    };
    if !control.authorized(&headers) {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    match control.revoke_client_key(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) if is_runtime_error(error) || error == "cannot revoke client key" => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Client key storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid client key identifier"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_credentials_are_bound_to_the_provider_id() {
        let secret = "fixture-storage-encryption-key";
        let encrypted = encrypt("provider-secret", "first", secret).unwrap();
        assert!(!encrypted.contains("provider-secret"));
        assert_eq!(
            decrypt(&encrypted, "first", secret).unwrap().as_str(),
            "provider-secret"
        );
        assert!(decrypt(&encrypted, "other", secret).is_err());
        assert!(decrypt(&encrypted, "first", "wrong-storage-key").is_err());
    }
}
