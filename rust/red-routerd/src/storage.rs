//! Rust-owned persistence boundary for proxy and control-plane configuration.
//!
//! Each process selects one database authority; connection errors never fall
//! back. Provider credentials are accepted here only as encrypted ciphertext.
use sqlx::{any::AnyPoolOptions, AnyPool, Row};
use std::sync::Once;

const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_proxy_config (id INTEGER PRIMARY KEY, upstream_url TEXT NOT NULL)";
const READ: &str = "SELECT upstream_url FROM redrouter_proxy_config WHERE id = 1";
const SEED: &str = "INSERT INTO redrouter_proxy_config (id, upstream_url) VALUES (1, $1) ON CONFLICT (id) DO NOTHING";
const SET: &str = "INSERT INTO redrouter_proxy_config (id, upstream_url) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET upstream_url = $1";
const CREATE_PROVIDERS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_providers (id TEXT PRIMARY KEY, provider TEXT NOT NULL, upstream_url TEXT NOT NULL, credential_ciphertext TEXT NOT NULL, enabled BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_PROVIDERS: &str = "SELECT id, provider, upstream_url, credential_ciphertext, enabled, revision FROM redrouter_control_providers ORDER BY revision DESC, id ASC";
const ACTIVE_PROVIDER: &str = "SELECT id, provider, upstream_url, credential_ciphertext, enabled, revision FROM redrouter_control_providers WHERE enabled = 1 ORDER BY revision DESC, id ASC LIMIT 1";
const UPSERT_PROVIDER: &str = "INSERT INTO redrouter_control_providers (id, provider, upstream_url, credential_ciphertext, enabled, revision) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET provider = $2, upstream_url = $3, credential_ciphertext = $4, enabled = $5, revision = $6";
const DISABLE_PROVIDER: &str =
    "UPDATE redrouter_control_providers SET enabled = 0, revision = $2 WHERE id = $1";
const CREATE_CLIENT_KEYS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_client_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, key_hash TEXT NOT NULL, enabled BIGINT NOT NULL, expiry_unix BIGINT NOT NULL, scopes_json TEXT NOT NULL, allowed_endpoints_json TEXT NOT NULL, allowed_models_json TEXT NOT NULL, blocked_models_json TEXT NOT NULL, allowed_provider_ids_json TEXT NOT NULL, max_concurrent BIGINT NOT NULL, max_rpm BIGINT NOT NULL, max_rpd BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_CLIENT_KEYS: &str = "SELECT id, label, key_hash, enabled, expiry_unix, scopes_json, allowed_endpoints_json, allowed_models_json, blocked_models_json, allowed_provider_ids_json, max_concurrent, max_rpm, max_rpd, revision FROM redrouter_control_client_keys ORDER BY revision DESC, id ASC";
const UPSERT_CLIENT_KEY: &str = "INSERT INTO redrouter_control_client_keys (id, label, key_hash, enabled, expiry_unix, scopes_json, allowed_endpoints_json, allowed_models_json, blocked_models_json, allowed_provider_ids_json, max_concurrent, max_rpm, max_rpd, revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (id) DO UPDATE SET label = $2, key_hash = $3, enabled = $4, expiry_unix = $5, scopes_json = $6, allowed_endpoints_json = $7, allowed_models_json = $8, blocked_models_json = $9, allowed_provider_ids_json = $10, max_concurrent = $11, max_rpm = $12, max_rpd = $13, revision = $14";
const REVOKE_CLIENT_KEY: &str =
    "UPDATE redrouter_control_client_keys SET enabled = 0, revision = $2 WHERE id = $1";
const CREATE_COMBOS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_combos (id TEXT PRIMARY KEY, protocol TEXT NOT NULL, routing_strategy TEXT NOT NULL, fallback_enabled BIGINT NOT NULL, targets_json TEXT NOT NULL, enabled BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_COMBOS: &str = "SELECT id, protocol, routing_strategy, fallback_enabled, targets_json, enabled, revision FROM redrouter_control_combos ORDER BY revision DESC, id ASC";
const UPSERT_COMBO: &str = "INSERT INTO redrouter_control_combos (id, protocol, routing_strategy, fallback_enabled, targets_json, enabled, revision) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET protocol = $2, routing_strategy = $3, fallback_enabled = $4, targets_json = $5, enabled = $6, revision = $7";
const DISABLE_COMBO: &str =
    "UPDATE redrouter_control_combos SET enabled = 0, revision = $2 WHERE id = $1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredProvider {
    pub id: String,
    pub provider: String,
    pub upstream_url: String,
    pub credential_ciphertext: String,
    pub enabled: bool,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredClientKey {
    pub id: String,
    pub label: String,
    pub key_hash: String,
    pub enabled: bool,
    pub expiry_unix: i64,
    pub scopes_json: String,
    pub allowed_endpoints_json: String,
    pub allowed_models_json: String,
    pub blocked_models_json: String,
    pub allowed_provider_ids_json: String,
    pub max_concurrent: i64,
    pub max_rpm: i64,
    pub max_rpd: i64,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCombo {
    pub id: String,
    pub protocol: String,
    pub strategy: String,
    pub fallback: bool,
    pub targets_json: String,
    pub enabled: bool,
    pub revision: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    ReddbEmbedded,
    ReddbRemote,
    Sqlite,
    Postgres,
}

impl Backend {
    pub fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "reddb-embedded" => Ok(Self::ReddbEmbedded),
            "reddb-remote" => Ok(Self::ReddbRemote),
            "sqlite" => Ok(Self::Sqlite),
            "postgres" => Ok(Self::Postgres),
            _ => Err("invalid database backend"),
        }
    }
}

pub enum Database {
    Sql(AnyPool),
    Remote(tokio::sync::Mutex<Option<reddb_client::redwire::RedWireClient>>),
    #[cfg(feature = "reddb-embedded")]
    Embedded {
        db: reddb_client::Reddb,
        _lock: std::fs::File,
    },
}

impl Database {
    /// URL is kept private: errors never include driver messages or credentials.
    pub async fn connect(backend: Backend, url: &str) -> Result<Self, &'static str> {
        match backend {
            Backend::ReddbEmbedded => {
                if !url.starts_with("file://") {
                    return Err("embedded RedDB requires a file URL");
                }
                #[cfg(feature = "reddb-embedded")]
                {
                    let parsed = url::Url::parse(url).map_err(|_| "invalid embedded RedDB URL")?;
                    if parsed.query().is_some() || parsed.fragment().is_some() {
                        return Err("invalid embedded RedDB URL");
                    }
                    let path = parsed
                        .to_file_path()
                        .map_err(|_| "invalid embedded RedDB path")?;
                    let path = if path.exists() {
                        std::fs::canonicalize(&path)
                            .map_err(|_| "cannot resolve embedded database path")?
                    } else {
                        let parent = path.parent().ok_or("invalid embedded database path")?;
                        let name = path.file_name().ok_or("invalid embedded database path")?;
                        std::fs::canonicalize(parent)
                            .map_err(|_| "cannot resolve embedded database directory")?
                            .join(name)
                    };
                    let mut lock_path = path.as_os_str().to_os_string();
                    lock_path.push(".router.lock");
                    let lock = std::fs::OpenOptions::new()
                        .read(true)
                        .write(true)
                        .create(true)
                        .truncate(false)
                        .open(lock_path)
                        .map_err(|_| "cannot open embedded database lock")?;
                    fs2::FileExt::try_lock_exclusive(&lock)
                        .map_err(|_| "embedded database is already in use")?;
                    // The RedDB URI parser currently treats file URI escapes
                    // literally. Open the decoded OS path so spaces and Windows
                    // drive letters address the requested file.
                    let embedded = reddb_client::embedded::EmbeddedClient::open(path)
                        .map_err(|_| "cannot open embedded RedDB")?;
                    let db = reddb_client::Reddb::Embedded(embedded);
                    for statement in [CREATE, CREATE_PROVIDERS, CREATE_CLIENT_KEYS, CREATE_COMBOS] {
                        db.query(statement)
                            .await
                            .map_err(|_| "cannot initialize database")?;
                    }
                    Ok(Self::Embedded { db, _lock: lock })
                }
                #[cfg(not(feature = "reddb-embedded"))]
                {
                    Err("embedded RedDB is not included in this build")
                }
            }
            Backend::ReddbRemote => {
                use reddb_client::redwire::{Auth, ConnectOptions, RedWireClient, TlsConfig};
                let parsed = url::Url::parse(url).map_err(|_| "invalid database URL")?;
                if !matches!(parsed.scheme(), "red" | "reds")
                    || parsed.host_str().is_none()
                    || !matches!(parsed.path(), "" | "/")
                    || parsed.fragment().is_some()
                {
                    return Err("remote RedDB requires a red:// or reds:// URL");
                }
                let mut token = None;
                let mut ca = None;
                for (name, value) in parsed.query_pairs() {
                    match name.as_ref() {
                        "token" if token.is_none() && !value.is_empty() => {
                            token = Some(value.into_owned())
                        }
                        "ca" if ca.is_none() && !value.is_empty() => ca = Some(value.into_owned()),
                        _ => return Err("invalid RedDB connection options"),
                    }
                }
                let auth = if !parsed.username().is_empty() {
                    if token.is_some() {
                        return Err("conflicting RedDB credentials");
                    }
                    let password = parsed.password().ok_or("RedDB password is missing")?;
                    let decode = |value: &str| {
                        percent_encoding::percent_decode_str(value)
                            .decode_utf8()
                            .map(|value| value.into_owned())
                            .map_err(|_| "invalid RedDB credentials")
                    };
                    Auth::Basic {
                        user: decode(parsed.username())?,
                        pass: decode(password)?,
                    }
                } else if parsed.password().is_some() {
                    return Err("RedDB username is missing");
                } else if let Some(token) = token {
                    Auth::Bearer(token)
                } else {
                    Auth::Anonymous
                };
                let mut options = ConnectOptions::new(
                    parsed.host_str().ok_or("database host is missing")?,
                    parsed.port().unwrap_or(5050),
                )
                .with_auth(auth);
                if parsed.scheme() == "reds" {
                    let tls = if let Some(ca) = ca {
                        TlsConfig::from_files(Some(std::path::Path::new(&ca)), None, None)
                            .map_err(|_| "cannot load RedDB TLS CA")?
                    } else {
                        TlsConfig::new()
                    };
                    options = options.with_tls(tls);
                } else if ca.is_some() {
                    return Err("RedDB TLS CA requires reds://");
                }
                let client = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    RedWireClient::connect(options),
                )
                .await
                .map_err(|_| "database connection timed out")?
                .map_err(|_| "cannot connect to selected database")?;
                let db = Self::Remote(tokio::sync::Mutex::new(Some(client)));
                db.remote_schema_query(CREATE).await?;
                db.remote_schema_query(CREATE_PROVIDERS).await?;
                db.remote_schema_query(CREATE_CLIENT_KEYS).await?;
                db.remote_schema_query(CREATE_COMBOS).await?;
                Ok(db)
            }
            Backend::Sqlite | Backend::Postgres => {
                let parsed = url::Url::parse(url).map_err(|_| "invalid database URL")?;
                let scheme_ok = match backend {
                    Backend::Sqlite => parsed.scheme() == "sqlite",
                    _ => {
                        matches!(parsed.scheme(), "postgres" | "postgresql")
                            && parsed.host_str().is_some()
                    }
                };
                if !scheme_ok {
                    return Err("database URL does not match backend");
                }
                static INSTALL: Once = Once::new();
                INSTALL.call_once(sqlx::any::install_default_drivers);
                let pool = AnyPoolOptions::new()
                    .max_connections(if backend == Backend::Sqlite { 1 } else { 5 })
                    .acquire_timeout(std::time::Duration::from_secs(5))
                    .connect(url)
                    .await
                    .map_err(|_| "cannot connect to selected database")?;
                for statement in [CREATE, CREATE_PROVIDERS, CREATE_CLIENT_KEYS, CREATE_COMBOS] {
                    sqlx::query(statement)
                        .execute(&pool)
                        .await
                        .map_err(|_| "cannot initialize database")?;
                }
                Ok(Self::Sql(pool))
            }
        }
    }

    pub async fn upstream(&self) -> Result<Option<String>, &'static str> {
        match self {
            Self::Sql(pool) => {
                let row = sqlx::query(READ)
                    .fetch_optional(pool)
                    .await
                    .map_err(|_| "cannot read database")?;
                row.map(|row| {
                    row.try_get("upstream_url")
                        .map_err(|_| "invalid database record")
                })
                .transpose()
            }
            Self::Remote(_) => {
                let result = self.remote_query(READ, &[]).await?;
                read_reddb_row(&result)
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                let result = db.query(READ).await.map_err(|_| "cannot read database")?;
                read_reddb_row(&result)
            }
        }
    }

    pub async fn providers(&self) -> Result<Vec<StoredProvider>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_PROVIDERS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read provider configuration")?
                .iter()
                .map(read_sql_provider)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_PROVIDERS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_provider)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_PROVIDERS)
                .await
                .map_err(|_| "cannot read provider configuration")?
                .rows
                .iter()
                .map(read_reddb_provider)
                .collect(),
        }
    }

    pub async fn active_provider(&self) -> Result<Option<StoredProvider>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(ACTIVE_PROVIDER)
                .fetch_optional(pool)
                .await
                .map_err(|_| "cannot read active provider")?
                .as_ref()
                .map(read_sql_provider)
                .transpose(),
            Self::Remote(_) => self
                .remote_query(ACTIVE_PROVIDER, &[])
                .await?
                .rows
                .first()
                .map(read_reddb_provider)
                .transpose(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(ACTIVE_PROVIDER)
                .await
                .map_err(|_| "cannot read active provider")?
                .rows
                .first()
                .map(read_reddb_provider)
                .transpose(),
        }
    }

    pub async fn upsert_provider(&self, provider: &StoredProvider) -> Result<(), &'static str> {
        let enabled = if provider.enabled { 1_i64 } else { 0_i64 };
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_PROVIDER)
                    .bind(&provider.id)
                    .bind(&provider.provider)
                    .bind(&provider.upstream_url)
                    .bind(&provider.credential_ciphertext)
                    .bind(enabled)
                    .bind(provider.updated_at)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_PROVIDER, &provider_params(provider, enabled))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_PROVIDER, provider_params(provider, enabled))
                    .await
                    .map_err(|_| "cannot write provider configuration")?;
            }
        }
        Ok(())
    }

    pub async fn disable_provider(&self, id: &str, updated_at: i64) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(DISABLE_PROVIDER)
                    .bind(id)
                    .bind(updated_at)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot disable provider")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    DISABLE_PROVIDER,
                    &[
                        reddb_client::Value::Text(id.to_owned()),
                        reddb_client::Value::Int(updated_at),
                    ],
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    DISABLE_PROVIDER,
                    vec![
                        reddb_client::Value::Text(id.to_owned()),
                        reddb_client::Value::Int(updated_at),
                    ],
                )
                .await
                .map_err(|_| "cannot disable provider")?;
            }
        }
        Ok(())
    }

    pub async fn client_keys(&self) -> Result<Vec<StoredClientKey>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_CLIENT_KEYS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read client key configuration")?
                .iter()
                .map(read_sql_client_key)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_CLIENT_KEYS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_client_key)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_CLIENT_KEYS)
                .await
                .map_err(|_| "cannot read client key configuration")?
                .rows
                .iter()
                .map(read_reddb_client_key)
                .collect(),
        }
    }

    pub async fn upsert_client_key(&self, key: &StoredClientKey) -> Result<(), &'static str> {
        let enabled = if key.enabled { 1_i64 } else { 0_i64 };
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_CLIENT_KEY)
                    .bind(&key.id)
                    .bind(&key.label)
                    .bind(&key.key_hash)
                    .bind(enabled)
                    .bind(key.expiry_unix)
                    .bind(&key.scopes_json)
                    .bind(&key.allowed_endpoints_json)
                    .bind(&key.allowed_models_json)
                    .bind(&key.blocked_models_json)
                    .bind(&key.allowed_provider_ids_json)
                    .bind(key.max_concurrent)
                    .bind(key.max_rpm)
                    .bind(key.max_rpd)
                    .bind(key.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write client key configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_CLIENT_KEY, &client_key_params(key, enabled))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_CLIENT_KEY, client_key_params(key, enabled))
                    .await
                    .map_err(|_| "cannot write client key configuration")?;
            }
        }
        Ok(())
    }

    pub async fn revoke_client_key(&self, id: &str, revision: i64) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(REVOKE_CLIENT_KEY)
                    .bind(id)
                    .bind(revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot revoke client key")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    REVOKE_CLIENT_KEY,
                    &[
                        reddb_client::Value::Text(id.to_owned()),
                        reddb_client::Value::Int(revision),
                    ],
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    REVOKE_CLIENT_KEY,
                    vec![
                        reddb_client::Value::Text(id.to_owned()),
                        reddb_client::Value::Int(revision),
                    ],
                )
                .await
                .map_err(|_| "cannot revoke client key")?;
            }
        }
        Ok(())
    }

    pub async fn combos(&self) -> Result<Vec<StoredCombo>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_COMBOS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read combo configuration")?
                .iter()
                .map(read_sql_combo)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_COMBOS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_combo)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_COMBOS)
                .await
                .map_err(|_| "cannot read combo configuration")?
                .rows
                .iter()
                .map(read_reddb_combo)
                .collect(),
        }
    }

    pub async fn upsert_combo(&self, combo: &StoredCombo) -> Result<(), &'static str> {
        let fallback = if combo.fallback { 1_i64 } else { 0_i64 };
        let enabled = if combo.enabled { 1_i64 } else { 0_i64 };
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_COMBO)
                    .bind(&combo.id)
                    .bind(&combo.protocol)
                    .bind(&combo.strategy)
                    .bind(fallback)
                    .bind(&combo.targets_json)
                    .bind(enabled)
                    .bind(combo.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write combo configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_COMBO, &combo_params(combo, fallback, enabled))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_COMBO, combo_params(combo, fallback, enabled))
                    .await
                    .map_err(|_| "cannot write combo configuration")?;
            }
        }
        Ok(())
    }

    pub async fn disable_combo(&self, id: &str, revision: i64) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(DISABLE_COMBO)
                    .bind(id)
                    .bind(revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot disable combo")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    DISABLE_COMBO,
                    &[
                        reddb_client::Value::Text(id.to_owned()),
                        reddb_client::Value::Int(revision),
                    ],
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    DISABLE_COMBO,
                    vec![
                        reddb_client::Value::Text(id.to_owned()),
                        reddb_client::Value::Int(revision),
                    ],
                )
                .await
                .map_err(|_| "cannot disable combo")?;
            }
        }
        Ok(())
    }

    /// Insert only when no configuration exists. The existing authority wins.
    pub async fn seed(&self, value: &str) -> Result<(), &'static str> {
        self.write(SEED, value).await
    }

    /// Explicit operator update; running processes reload on restart.
    pub async fn set_upstream(&self, value: &str) -> Result<(), &'static str> {
        self.write(SET, value).await
    }

    async fn write(&self, sql: &str, value: &str) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(sql)
                    .bind(value)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write database")?;
            }
            Self::Remote(_) => {
                self.remote_query(sql, &[reddb_client::Value::Text(value.to_owned())])
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(sql, vec![reddb_client::Value::Text(value.to_owned())])
                    .await
                    .map_err(|_| "cannot write database")?;
            }
        }
        Ok(())
    }

    pub async fn close(&self) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => pool.close().await,
            Self::Remote(client) => {
                if let Some(client) = client.lock().await.take() {
                    tokio::time::timeout(std::time::Duration::from_secs(5), client.close())
                        .await
                        .map_err(|_| "database close timed out")?
                        .map_err(|_| "cannot close database")?;
                }
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.close().await.map_err(|_| "cannot checkpoint database")?
            }
        }
        Ok(())
    }

    async fn remote_query(
        &self,
        sql: &str,
        params: &[reddb_client::Value],
    ) -> Result<reddb_client::QueryResult, &'static str> {
        let Self::Remote(client) = self else {
            return Err("invalid database transport");
        };
        let mut guard = client.lock().await;
        let connection = guard.as_mut().ok_or("database connection is closed")?;
        match tokio::time::timeout(
            std::time::Duration::from_secs(5),
            connection.query_with(sql, params),
        )
        .await
        {
            Ok(Ok(result)) => Ok(result),
            _ => {
                *guard = None;
                Err("database operation failed")
            }
        }
    }

    /// Schema statements are static and never contain credentials, so retain
    /// the RedDB engine diagnostic in operator logs while keeping the public
    /// error free of connection strings and secrets.
    async fn remote_schema_query(&self, sql: &'static str) -> Result<(), &'static str> {
        let Self::Remote(client) = self else {
            return Err("invalid database transport");
        };
        let mut guard = client.lock().await;
        let connection = guard.as_mut().ok_or("database connection is closed")?;
        match tokio::time::timeout(
            std::time::Duration::from_secs(5),
            connection.query_with(sql, &[]),
        )
        .await
        {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => {
                eprintln!("RedDB schema initialization failed: {error}");
                *guard = None;
                Err("database operation failed")
            }
            Err(_) => {
                *guard = None;
                Err("database operation failed")
            }
        }
    }
}

fn read_reddb_row(result: &reddb_client::QueryResult) -> Result<Option<String>, &'static str> {
    let Some(row) = result.rows.first() else {
        return Ok(None);
    };
    match row
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("upstream_url"))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(Some(value.clone())),
        _ => Err("invalid database record"),
    }
}

fn read_sql_provider(row: &sqlx::any::AnyRow) -> Result<StoredProvider, &'static str> {
    Ok(StoredProvider {
        id: row.try_get("id").map_err(|_| "invalid provider record")?,
        provider: row
            .try_get("provider")
            .map_err(|_| "invalid provider record")?,
        upstream_url: row
            .try_get("upstream_url")
            .map_err(|_| "invalid provider record")?,
        credential_ciphertext: row
            .try_get("credential_ciphertext")
            .map_err(|_| "invalid provider record")?,
        enabled: row
            .try_get::<i64, _>("enabled")
            .map_err(|_| "invalid provider record")?
            == 1,
        updated_at: row
            .try_get("revision")
            .map_err(|_| "invalid provider record")?,
    })
}

fn read_reddb_provider(row: &reddb_client::Row) -> Result<StoredProvider, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid provider record"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid provider record"),
    };
    Ok(StoredProvider {
        id: text("id")?,
        provider: text("provider")?,
        upstream_url: text("upstream_url")?,
        credential_ciphertext: text("credential_ciphertext")?,
        enabled: integer("enabled")? == 1,
        updated_at: integer("revision")?,
    })
}

fn provider_params(provider: &StoredProvider, enabled: i64) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(provider.id.clone()),
        reddb_client::Value::Text(provider.provider.clone()),
        reddb_client::Value::Text(provider.upstream_url.clone()),
        reddb_client::Value::Text(provider.credential_ciphertext.clone()),
        reddb_client::Value::Int(enabled),
        reddb_client::Value::Int(provider.updated_at),
    ]
}

fn read_sql_client_key(row: &sqlx::any::AnyRow) -> Result<StoredClientKey, &'static str> {
    let text = |name| row.try_get(name).map_err(|_| "invalid client key record");
    let integer = |name| row.try_get(name).map_err(|_| "invalid client key record");
    Ok(StoredClientKey {
        id: text("id")?,
        label: text("label")?,
        key_hash: text("key_hash")?,
        enabled: row
            .try_get::<i64, _>("enabled")
            .map_err(|_| "invalid client key record")?
            == 1,
        expiry_unix: integer("expiry_unix")?,
        scopes_json: text("scopes_json")?,
        allowed_endpoints_json: text("allowed_endpoints_json")?,
        allowed_models_json: text("allowed_models_json")?,
        blocked_models_json: text("blocked_models_json")?,
        allowed_provider_ids_json: text("allowed_provider_ids_json")?,
        max_concurrent: integer("max_concurrent")?,
        max_rpm: integer("max_rpm")?,
        max_rpd: integer("max_rpd")?,
        revision: integer("revision")?,
    })
}

fn read_reddb_client_key(row: &reddb_client::Row) -> Result<StoredClientKey, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid client key record"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid client key record"),
    };
    Ok(StoredClientKey {
        id: text("id")?,
        label: text("label")?,
        key_hash: text("key_hash")?,
        enabled: integer("enabled")? == 1,
        expiry_unix: integer("expiry_unix")?,
        scopes_json: text("scopes_json")?,
        allowed_endpoints_json: text("allowed_endpoints_json")?,
        allowed_models_json: text("allowed_models_json")?,
        blocked_models_json: text("blocked_models_json")?,
        allowed_provider_ids_json: text("allowed_provider_ids_json")?,
        max_concurrent: integer("max_concurrent")?,
        max_rpm: integer("max_rpm")?,
        max_rpd: integer("max_rpd")?,
        revision: integer("revision")?,
    })
}

fn client_key_params(key: &StoredClientKey, enabled: i64) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(key.id.clone()),
        reddb_client::Value::Text(key.label.clone()),
        reddb_client::Value::Text(key.key_hash.clone()),
        reddb_client::Value::Int(enabled),
        reddb_client::Value::Int(key.expiry_unix),
        reddb_client::Value::Text(key.scopes_json.clone()),
        reddb_client::Value::Text(key.allowed_endpoints_json.clone()),
        reddb_client::Value::Text(key.allowed_models_json.clone()),
        reddb_client::Value::Text(key.blocked_models_json.clone()),
        reddb_client::Value::Text(key.allowed_provider_ids_json.clone()),
        reddb_client::Value::Int(key.max_concurrent),
        reddb_client::Value::Int(key.max_rpm),
        reddb_client::Value::Int(key.max_rpd),
        reddb_client::Value::Int(key.revision),
    ]
}

fn read_sql_combo(row: &sqlx::any::AnyRow) -> Result<StoredCombo, &'static str> {
    let text = |name| row.try_get(name).map_err(|_| "invalid combo record");
    let integer = |name| row.try_get(name).map_err(|_| "invalid combo record");
    Ok(StoredCombo {
        id: text("id")?,
        protocol: text("protocol")?,
        strategy: text("routing_strategy")?,
        fallback: integer("fallback_enabled")? == 1,
        targets_json: text("targets_json")?,
        enabled: integer("enabled")? == 1,
        revision: integer("revision")?,
    })
}

fn read_reddb_combo(row: &reddb_client::Row) -> Result<StoredCombo, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid combo record"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid combo record"),
    };
    Ok(StoredCombo {
        id: text("id")?,
        protocol: text("protocol")?,
        strategy: text("routing_strategy")?,
        fallback: integer("fallback_enabled")? == 1,
        targets_json: text("targets_json")?,
        enabled: integer("enabled")? == 1,
        revision: integer("revision")?,
    })
}

fn combo_params(combo: &StoredCombo, fallback: i64, enabled: i64) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(combo.id.clone()),
        reddb_client::Value::Text(combo.protocol.clone()),
        reddb_client::Value::Text(combo.strategy.clone()),
        reddb_client::Value::Int(fallback),
        reddb_client::Value::Text(combo.targets_json.clone()),
        reddb_client::Value::Int(enabled),
        reddb_client::Value::Int(combo.revision),
    ]
}

pub fn embedded_default_url() -> Result<String, &'static str> {
    let path = std::env::current_dir()
        .map_err(|_| "cannot resolve database path")?
        .join("red-router.rdb");
    url::Url::from_file_path(path)
        .map(|url| url.to_string())
        .map_err(|_| "invalid database path")
}

pub fn sqlite_default_url() -> Result<String, &'static str> {
    let path = std::env::current_dir()
        .map_err(|_| "cannot resolve database path")?
        .join("red-router.sqlite");
    let url = url::Url::from_file_path(path).map_err(|_| "invalid database path")?;
    Ok(format!(
        "{}?mode=rwc",
        url.as_str().replacen("file:", "sqlite:", 1)
    ))
}
