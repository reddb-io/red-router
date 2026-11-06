//! Read-only, explicitly selected product credential. This is not policy parity.
use aes_gcm::aead::consts::U16;
use aes_gcm::{
    aead::{Aead, KeyInit},
    aes::Aes256,
    AesGcm, Nonce,
};
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
        if provider != "openrouter" || auth.as_deref() != Some("apikey") || active != 1 {
            return Err("selected connection must be an active OpenRouter API-key connection");
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
            },
            credential,
        ))
    }

    /// Recheck revocation and edits before each request. In-flight requests can
    /// still finish after a change; restart to pick up a changed credential.
    pub async fn unchanged(&self) -> bool {
        let result = sqlx::query("SELECT 1 FROM provider_connections WHERE id = ? AND provider = 'openrouter' AND auth_type = 'apikey' AND is_active = 1 AND api_key = ? AND updated_at = ?")
            .bind(self.id.as_ref()).bind(self.stored_key.as_ref()).bind(self.updated_at.as_ref())
            .fetch_optional(&self.pool).await;
        matches!(result, Ok(Some(_)))
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
