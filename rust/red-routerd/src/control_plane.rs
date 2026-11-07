//! Authenticated Rust control plane for provider persistence and live reload.
use crate::{storage::StoredProvider, LiveProvider, ProxyState};
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
    admin_hash: [u8; 32],
    encryption_key: Zeroizing<String>,
    allow_private: bool,
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
            admin_hash: Sha256::digest(admin_key.as_bytes()).into(),
            encryption_key: Zeroizing::new(encryption_key.to_owned()),
            allow_private,
        }));
        plane.refresh().await?;
        Ok(plane)
    }

    pub(crate) async fn current(&self) -> Option<LiveProvider> {
        self.0.current.read().await.clone()
    }

    pub async fn has_active_provider(&self) -> Result<bool, &'static str> {
        self.0
            .database
            .active_provider()
            .await
            .map(|row| row.is_some())
    }

    pub(crate) async fn ready(&self) -> bool {
        self.0
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

    async fn refresh(&self) -> Result<(), &'static str> {
        let live = match self.0.database.active_provider().await? {
            Some(record) => {
                let credential = decrypt(
                    &record.credential_ciphertext,
                    &record.id,
                    self.0.encryption_key.as_str(),
                )?;
                Some(
                    ProxyState::live_provider(
                        &record.upstream_url,
                        credential.as_str(),
                        self.0.allow_private,
                    )
                    .await?,
                )
            }
            None => None,
        };
        *self.0.current.write().await = live;
        Ok(())
    }

    async fn views(&self) -> Result<Vec<ProviderView>, &'static str> {
        self.0
            .database
            .providers()
            .await
            .map(|rows| rows.iter().map(view).collect())
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
