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
const CREATE_ROUTE_PINS: &str = "CREATE TABLE IF NOT EXISTS redrouter_route_pins (combo_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model TEXT NOT NULL, revision BIGINT NOT NULL)";
const LIST_ROUTE_PINS: &str =
    "SELECT combo_id, provider_id, model, revision FROM redrouter_route_pins ORDER BY combo_id ASC";
const UPSERT_ROUTE_PIN: &str = "INSERT INTO redrouter_route_pins (combo_id, provider_id, model, revision) VALUES ($1,$2,$3,$4) ON CONFLICT (combo_id) DO UPDATE SET provider_id = $2, model = $3, revision = $4";
const DELETE_ROUTE_PIN: &str = "DELETE FROM redrouter_route_pins WHERE combo_id = $1";
const CREATE_PROVIDER_QUOTAS: &str = "CREATE TABLE IF NOT EXISTS redrouter_provider_quotas (provider_id TEXT PRIMARY KEY, session_remaining_ppm BIGINT NOT NULL, session_reset_unix_ms BIGINT NOT NULL, weekly_remaining_ppm BIGINT NOT NULL, weekly_reset_unix_ms BIGINT NOT NULL, limit_reached BIGINT NOT NULL, observed_at_unix_ms BIGINT NOT NULL, expires_at_unix_ms BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_PROVIDER_QUOTAS: &str = "SELECT provider_id, session_remaining_ppm, session_reset_unix_ms, weekly_remaining_ppm, weekly_reset_unix_ms, limit_reached, observed_at_unix_ms, expires_at_unix_ms, revision FROM redrouter_provider_quotas ORDER BY provider_id ASC";
const UPSERT_PROVIDER_QUOTA: &str = "INSERT INTO redrouter_provider_quotas (provider_id, session_remaining_ppm, session_reset_unix_ms, weekly_remaining_ppm, weekly_reset_unix_ms, limit_reached, observed_at_unix_ms, expires_at_unix_ms, revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (provider_id) DO UPDATE SET session_remaining_ppm = $2, session_reset_unix_ms = $3, weekly_remaining_ppm = $4, weekly_reset_unix_ms = $5, limit_reached = $6, observed_at_unix_ms = $7, expires_at_unix_ms = $8, revision = $9";
const DELETE_PROVIDER_QUOTA: &str = "DELETE FROM redrouter_provider_quotas WHERE provider_id = $1";
const CREATE_BREAKERS: &str = "CREATE TABLE IF NOT EXISTS redrouter_provider_breakers (provider_id TEXT PRIMARY KEY, breaker_state TEXT NOT NULL, failure_count BIGINT NOT NULL, last_failure_unix_ms BIGINT NOT NULL, open_cycle_count BIGINT NOT NULL, failure_threshold BIGINT NOT NULL, degradation_threshold BIGINT NOT NULL, reset_timeout_ms BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_BREAKERS: &str = "SELECT provider_id, breaker_state, failure_count, last_failure_unix_ms, open_cycle_count, failure_threshold, degradation_threshold, reset_timeout_ms, revision FROM redrouter_provider_breakers ORDER BY provider_id ASC";
const UPSERT_BREAKER: &str = "INSERT INTO redrouter_provider_breakers (provider_id, breaker_state, failure_count, last_failure_unix_ms, open_cycle_count, failure_threshold, degradation_threshold, reset_timeout_ms, revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (provider_id) DO UPDATE SET breaker_state = $2, failure_count = $3, last_failure_unix_ms = $4, open_cycle_count = $5, failure_threshold = $6, degradation_threshold = $7, reset_timeout_ms = $8, revision = $9";
const DELETE_BREAKER: &str = "DELETE FROM redrouter_provider_breakers WHERE provider_id = $1";
const CREATE_AVAILABILITY: &str = "CREATE TABLE IF NOT EXISTS redrouter_provider_availability (provider_id TEXT PRIMARY KEY, cooldown_until_unix_ms BIGINT NOT NULL, backoff_level BIGINT NOT NULL, last_status BIGINT NOT NULL, model_lockouts_json TEXT NOT NULL, revision BIGINT NOT NULL)";
const LIST_AVAILABILITY: &str = "SELECT provider_id, cooldown_until_unix_ms, backoff_level, last_status, model_lockouts_json, revision FROM redrouter_provider_availability ORDER BY provider_id ASC";
const UPSERT_AVAILABILITY: &str = "INSERT INTO redrouter_provider_availability (provider_id, cooldown_until_unix_ms, backoff_level, last_status, model_lockouts_json, revision) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provider_id) DO UPDATE SET cooldown_until_unix_ms = $2, backoff_level = $3, last_status = $4, model_lockouts_json = $5, revision = $6";
const DELETE_AVAILABILITY: &str =
    "DELETE FROM redrouter_provider_availability WHERE provider_id = $1";
const CREATE_RESILIENCE: &str = "CREATE TABLE IF NOT EXISTS redrouter_provider_resilience (record_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, rate_limit_scope TEXT NOT NULL, revision BIGINT NOT NULL)";
const LIST_RESILIENCE: &str = "SELECT provider_id, rate_limit_scope, revision FROM redrouter_provider_resilience ORDER BY provider_id ASC, revision DESC";
const UPSERT_RESILIENCE: &str = "INSERT INTO redrouter_provider_resilience (record_id, provider_id, rate_limit_scope, revision) VALUES ($1,$2,$3,$4) ON CONFLICT (record_id) DO UPDATE SET rate_limit_scope = $3";
const DELETE_RESILIENCE: &str = "DELETE FROM redrouter_provider_resilience WHERE provider_id = $1";
const CREATE_OIDC: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_oidc (id INTEGER PRIMARY KEY, enabled BIGINT NOT NULL, issuer TEXT NOT NULL, audience TEXT NOT NULL, jwks_uri TEXT NOT NULL, required_claims_json TEXT NOT NULL, allowed_subjects_json TEXT NOT NULL, revision BIGINT NOT NULL)";
const READ_OIDC: &str = "SELECT enabled, issuer, audience, jwks_uri, required_claims_json, allowed_subjects_json, revision FROM redrouter_control_oidc WHERE id = 1";
const UPSERT_OIDC: &str = "INSERT INTO redrouter_control_oidc (id, enabled, issuer, audience, jwks_uri, required_claims_json, allowed_subjects_json, revision) VALUES (1,$1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET enabled = $1, issuer = $2, audience = $3, jwks_uri = $4, required_claims_json = $5, allowed_subjects_json = $6, revision = $7";
const DELETE_OIDC: &str = "DELETE FROM redrouter_control_oidc WHERE id = 1";
const CREATE_OIDC_BROWSER: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_oidc_browser (id INTEGER PRIMARY KEY, public_origin TEXT NOT NULL, client_id TEXT NOT NULL, client_secret_ciphertext TEXT NOT NULL, authorization_endpoint TEXT NOT NULL, token_endpoint TEXT NOT NULL, scopes_json TEXT NOT NULL, revision BIGINT NOT NULL)";
const READ_OIDC_BROWSER: &str = "SELECT public_origin, client_id, client_secret_ciphertext, authorization_endpoint, token_endpoint, scopes_json, revision FROM redrouter_control_oidc_browser WHERE id = 1";
const UPSERT_OIDC_BROWSER: &str = "INSERT INTO redrouter_control_oidc_browser (id, public_origin, client_id, client_secret_ciphertext, authorization_endpoint, token_endpoint, scopes_json, revision) VALUES (1,$1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET public_origin = $1, client_id = $2, client_secret_ciphertext = $3, authorization_endpoint = $4, token_endpoint = $5, scopes_json = $6, revision = $7";
const DELETE_OIDC_BROWSER: &str = "DELETE FROM redrouter_control_oidc_browser WHERE id = 1";

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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredRoutePin {
    pub combo_id: String,
    pub provider_id: String,
    pub model: String,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredProviderQuota {
    pub provider_id: String,
    /// Parts per million remaining, or -1 when the window is unknown.
    pub session_remaining_ppm: i64,
    pub session_reset_unix_ms: i64,
    /// Parts per million remaining, or -1 when the window is unknown.
    pub weekly_remaining_ppm: i64,
    pub weekly_reset_unix_ms: i64,
    pub limit_reached: bool,
    pub observed_at_unix_ms: i64,
    pub expires_at_unix_ms: i64,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredBreaker {
    pub provider_id: String,
    pub state: String,
    pub failure_count: i64,
    pub last_failure_unix_ms: i64,
    pub open_cycle_count: i64,
    pub failure_threshold: i64,
    pub degradation_threshold: i64,
    pub reset_timeout_ms: i64,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredAvailability {
    pub provider_id: String,
    pub cooldown_until_unix_ms: i64,
    pub backoff_level: i64,
    /// HTTP status, or 0 when no connection-level failure is active.
    pub last_status: i64,
    pub model_lockouts_json: String,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredResilience {
    pub provider_id: String,
    pub rate_limit_scope: String,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredOidcConfig {
    pub enabled: bool,
    pub issuer: String,
    pub audience: String,
    pub jwks_uri: String,
    pub required_claims_json: String,
    pub allowed_subjects_json: String,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredOidcBrowserConfig {
    pub public_origin: String,
    pub client_id: String,
    pub client_secret_ciphertext: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub scopes_json: String,
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
                    for statement in [
                        CREATE,
                        CREATE_PROVIDERS,
                        CREATE_CLIENT_KEYS,
                        CREATE_COMBOS,
                        CREATE_ROUTE_PINS,
                        CREATE_PROVIDER_QUOTAS,
                        CREATE_BREAKERS,
                        CREATE_AVAILABILITY,
                        CREATE_RESILIENCE,
                        CREATE_OIDC,
                        CREATE_OIDC_BROWSER,
                    ] {
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
                db.remote_schema_query(CREATE_ROUTE_PINS).await?;
                db.remote_schema_query(CREATE_PROVIDER_QUOTAS).await?;
                db.remote_schema_query(CREATE_BREAKERS).await?;
                db.remote_schema_query(CREATE_AVAILABILITY).await?;
                db.remote_schema_query(CREATE_RESILIENCE).await?;
                db.remote_schema_query(CREATE_OIDC).await?;
                db.remote_schema_query(CREATE_OIDC_BROWSER).await?;
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
                for statement in [
                    CREATE,
                    CREATE_PROVIDERS,
                    CREATE_CLIENT_KEYS,
                    CREATE_COMBOS,
                    CREATE_ROUTE_PINS,
                    CREATE_PROVIDER_QUOTAS,
                    CREATE_BREAKERS,
                    CREATE_AVAILABILITY,
                    CREATE_RESILIENCE,
                    CREATE_OIDC,
                    CREATE_OIDC_BROWSER,
                ] {
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

    pub async fn route_pins(&self) -> Result<Vec<StoredRoutePin>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_ROUTE_PINS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read route pin state")?
                .iter()
                .map(read_sql_route_pin)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_ROUTE_PINS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_route_pin)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_ROUTE_PINS)
                .await
                .map_err(|_| "cannot read route pin state")?
                .rows
                .iter()
                .map(read_reddb_route_pin)
                .collect(),
        }
    }

    pub async fn upsert_route_pin(&self, pin: &StoredRoutePin) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_ROUTE_PIN)
                    .bind(&pin.combo_id)
                    .bind(&pin.provider_id)
                    .bind(&pin.model)
                    .bind(pin.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write route pin state")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_ROUTE_PIN, &route_pin_params(pin))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_ROUTE_PIN, route_pin_params(pin))
                    .await
                    .map_err(|_| "cannot write route pin state")?;
            }
        }
        Ok(())
    }

    pub async fn delete_route_pin(&self, combo_id: &str) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE_ROUTE_PIN)
                    .bind(combo_id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete route pin state")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    DELETE_ROUTE_PIN,
                    &[reddb_client::Value::Text(combo_id.to_owned())],
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    DELETE_ROUTE_PIN,
                    vec![reddb_client::Value::Text(combo_id.to_owned())],
                )
                .await
                .map_err(|_| "cannot delete route pin state")?;
            }
        }
        Ok(())
    }

    pub async fn provider_quotas(&self) -> Result<Vec<StoredProviderQuota>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_PROVIDER_QUOTAS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read provider quota state")?
                .iter()
                .map(read_sql_provider_quota)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_PROVIDER_QUOTAS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_provider_quota)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_PROVIDER_QUOTAS)
                .await
                .map_err(|_| "cannot read provider quota state")?
                .rows
                .iter()
                .map(read_reddb_provider_quota)
                .collect(),
        }
    }

    pub async fn upsert_provider_quota(
        &self,
        quota: &StoredProviderQuota,
    ) -> Result<(), &'static str> {
        let limit_reached = if quota.limit_reached { 1_i64 } else { 0_i64 };
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_PROVIDER_QUOTA)
                    .bind(&quota.provider_id)
                    .bind(quota.session_remaining_ppm)
                    .bind(quota.session_reset_unix_ms)
                    .bind(quota.weekly_remaining_ppm)
                    .bind(quota.weekly_reset_unix_ms)
                    .bind(limit_reached)
                    .bind(quota.observed_at_unix_ms)
                    .bind(quota.expires_at_unix_ms)
                    .bind(quota.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider quota state")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    UPSERT_PROVIDER_QUOTA,
                    &provider_quota_params(quota, limit_reached),
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    UPSERT_PROVIDER_QUOTA,
                    provider_quota_params(quota, limit_reached),
                )
                .await
                .map_err(|_| "cannot write provider quota state")?;
            }
        }
        Ok(())
    }

    pub async fn delete_provider_quota(&self, provider_id: &str) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE_PROVIDER_QUOTA)
                    .bind(provider_id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete provider quota state")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    DELETE_PROVIDER_QUOTA,
                    &[reddb_client::Value::Text(provider_id.to_owned())],
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    DELETE_PROVIDER_QUOTA,
                    vec![reddb_client::Value::Text(provider_id.to_owned())],
                )
                .await
                .map_err(|_| "cannot delete provider quota state")?;
            }
        }
        Ok(())
    }

    pub async fn breakers(&self) -> Result<Vec<StoredBreaker>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_BREAKERS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read provider breaker state")?
                .iter()
                .map(read_sql_breaker)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_BREAKERS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_breaker)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_BREAKERS)
                .await
                .map_err(|_| "cannot read provider breaker state")?
                .rows
                .iter()
                .map(read_reddb_breaker)
                .collect(),
        }
    }

    pub async fn upsert_breaker(&self, breaker: &StoredBreaker) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_BREAKER)
                    .bind(&breaker.provider_id)
                    .bind(&breaker.state)
                    .bind(breaker.failure_count)
                    .bind(breaker.last_failure_unix_ms)
                    .bind(breaker.open_cycle_count)
                    .bind(breaker.failure_threshold)
                    .bind(breaker.degradation_threshold)
                    .bind(breaker.reset_timeout_ms)
                    .bind(breaker.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider breaker state")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_BREAKER, &breaker_params(breaker))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_BREAKER, breaker_params(breaker))
                    .await
                    .map_err(|_| "cannot write provider breaker state")?;
            }
        }
        Ok(())
    }

    pub async fn delete_breaker(&self, provider_id: &str) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE_BREAKER)
                    .bind(provider_id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot reset provider breaker")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    DELETE_BREAKER,
                    &[reddb_client::Value::Text(provider_id.to_owned())],
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    DELETE_BREAKER,
                    vec![reddb_client::Value::Text(provider_id.to_owned())],
                )
                .await
                .map_err(|_| "cannot reset provider breaker")?;
            }
        }
        Ok(())
    }

    pub async fn provider_availability(&self) -> Result<Vec<StoredAvailability>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_AVAILABILITY)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read provider availability state")?
                .iter()
                .map(read_sql_availability)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_AVAILABILITY, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_availability)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_AVAILABILITY)
                .await
                .map_err(|_| "cannot read provider availability state")?
                .rows
                .iter()
                .map(read_reddb_availability)
                .collect(),
        }
    }

    pub async fn upsert_provider_availability(
        &self,
        availability: &StoredAvailability,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_AVAILABILITY)
                    .bind(&availability.provider_id)
                    .bind(availability.cooldown_until_unix_ms)
                    .bind(availability.backoff_level)
                    .bind(availability.last_status)
                    .bind(&availability.model_lockouts_json)
                    .bind(availability.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider availability state")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_AVAILABILITY, &availability_params(availability))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_AVAILABILITY, availability_params(availability))
                    .await
                    .map_err(|_| "cannot write provider availability state")?;
            }
        }
        Ok(())
    }

    pub async fn delete_provider_availability(
        &self,
        provider_id: &str,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE_AVAILABILITY)
                    .bind(provider_id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot reset provider availability")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    DELETE_AVAILABILITY,
                    &[reddb_client::Value::Text(provider_id.to_owned())],
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    DELETE_AVAILABILITY,
                    vec![reddb_client::Value::Text(provider_id.to_owned())],
                )
                .await
                .map_err(|_| "cannot reset provider availability")?;
            }
        }
        Ok(())
    }

    pub async fn provider_resilience(&self) -> Result<Vec<StoredResilience>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_RESILIENCE)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read provider resilience configuration")?
                .iter()
                .map(read_sql_resilience)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_RESILIENCE, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_resilience)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_RESILIENCE)
                .await
                .map_err(|_| "cannot read provider resilience configuration")?
                .rows
                .iter()
                .map(read_reddb_resilience)
                .collect(),
        }
    }

    pub async fn upsert_provider_resilience(
        &self,
        resilience: &StoredResilience,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_RESILIENCE)
                    .bind(resilience_record_id(resilience))
                    .bind(&resilience.provider_id)
                    .bind(&resilience.rate_limit_scope)
                    .bind(resilience.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider resilience configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_RESILIENCE, &resilience_params(resilience))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_RESILIENCE, resilience_params(resilience))
                    .await
                    .map_err(|_| "cannot write provider resilience configuration")?;
            }
        }
        Ok(())
    }

    pub async fn delete_provider_resilience(&self, provider_id: &str) -> Result<(), &'static str> {
        let params = || vec![reddb_client::Value::Text(provider_id.to_owned())];
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE_RESILIENCE)
                    .bind(provider_id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete provider resilience configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE_RESILIENCE, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(DELETE_RESILIENCE, params())
                    .await
                    .map_err(|_| "cannot delete provider resilience configuration")?;
            }
        }
        Ok(())
    }

    pub async fn oidc_config(&self) -> Result<Option<StoredOidcConfig>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(READ_OIDC)
                .fetch_optional(pool)
                .await
                .map_err(|_| "cannot read OIDC configuration")?
                .as_ref()
                .map(read_sql_oidc)
                .transpose(),
            Self::Remote(_) => self
                .remote_query(READ_OIDC, &[])
                .await?
                .rows
                .first()
                .map(read_reddb_oidc)
                .transpose(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(READ_OIDC)
                .await
                .map_err(|_| "cannot read OIDC configuration")?
                .rows
                .first()
                .map(read_reddb_oidc)
                .transpose(),
        }
    }

    pub async fn upsert_oidc(&self, config: &StoredOidcConfig) -> Result<(), &'static str> {
        let enabled = if config.enabled { 1_i64 } else { 0_i64 };
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_OIDC)
                    .bind(enabled)
                    .bind(&config.issuer)
                    .bind(&config.audience)
                    .bind(&config.jwks_uri)
                    .bind(&config.required_claims_json)
                    .bind(&config.allowed_subjects_json)
                    .bind(config.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write OIDC configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_OIDC, &oidc_params(config, enabled))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_OIDC, oidc_params(config, enabled))
                    .await
                    .map_err(|_| "cannot write OIDC configuration")?;
            }
        }
        Ok(())
    }

    pub async fn oidc_browser_config(
        &self,
    ) -> Result<Option<StoredOidcBrowserConfig>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(READ_OIDC_BROWSER)
                .fetch_optional(pool)
                .await
                .map_err(|_| "cannot read OIDC browser configuration")?
                .as_ref()
                .map(read_sql_oidc_browser)
                .transpose(),
            Self::Remote(_) => self
                .remote_query(READ_OIDC_BROWSER, &[])
                .await?
                .rows
                .first()
                .map(read_reddb_oidc_browser)
                .transpose(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(READ_OIDC_BROWSER)
                .await
                .map_err(|_| "cannot read OIDC browser configuration")?
                .rows
                .first()
                .map(read_reddb_oidc_browser)
                .transpose(),
        }
    }

    pub async fn upsert_oidc_browser(
        &self,
        config: &StoredOidcBrowserConfig,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_OIDC_BROWSER)
                    .bind(&config.public_origin)
                    .bind(&config.client_id)
                    .bind(&config.client_secret_ciphertext)
                    .bind(&config.authorization_endpoint)
                    .bind(&config.token_endpoint)
                    .bind(&config.scopes_json)
                    .bind(config.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write OIDC browser configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_OIDC_BROWSER, &oidc_browser_params(config))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_OIDC_BROWSER, oidc_browser_params(config))
                    .await
                    .map_err(|_| "cannot write OIDC browser configuration")?;
            }
        }
        Ok(())
    }

    pub async fn delete_oidc(&self) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE_OIDC)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete OIDC configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE_OIDC, &[]).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query(DELETE_OIDC)
                    .await
                    .map_err(|_| "cannot delete OIDC configuration")?;
            }
        }
        Ok(())
    }

    pub async fn delete_oidc_browser(&self) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE_OIDC_BROWSER)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete OIDC browser configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE_OIDC_BROWSER, &[]).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query(DELETE_OIDC_BROWSER)
                    .await
                    .map_err(|_| "cannot delete OIDC browser configuration")?;
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

fn read_sql_route_pin(row: &sqlx::any::AnyRow) -> Result<StoredRoutePin, &'static str> {
    let text = |name| row.try_get(name).map_err(|_| "invalid route pin record");
    Ok(StoredRoutePin {
        combo_id: text("combo_id")?,
        provider_id: text("provider_id")?,
        model: text("model")?,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid route pin record")?,
    })
}

fn read_reddb_route_pin(row: &reddb_client::Row) -> Result<StoredRoutePin, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid route pin record"),
    };
    let revision = match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case("revision"))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid route pin record"),
    }?;
    Ok(StoredRoutePin {
        combo_id: text("combo_id")?,
        provider_id: text("provider_id")?,
        model: text("model")?,
        revision,
    })
}

fn route_pin_params(pin: &StoredRoutePin) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(pin.combo_id.clone()),
        reddb_client::Value::Text(pin.provider_id.clone()),
        reddb_client::Value::Text(pin.model.clone()),
        reddb_client::Value::Int(pin.revision),
    ]
}

fn read_sql_provider_quota(row: &sqlx::any::AnyRow) -> Result<StoredProviderQuota, &'static str> {
    let text = |name| {
        row.try_get(name)
            .map_err(|_| "invalid provider quota record")
    };
    let integer = |name| {
        row.try_get(name)
            .map_err(|_| "invalid provider quota record")
    };
    Ok(StoredProviderQuota {
        provider_id: text("provider_id")?,
        session_remaining_ppm: integer("session_remaining_ppm")?,
        session_reset_unix_ms: integer("session_reset_unix_ms")?,
        weekly_remaining_ppm: integer("weekly_remaining_ppm")?,
        weekly_reset_unix_ms: integer("weekly_reset_unix_ms")?,
        limit_reached: integer("limit_reached")? == 1,
        observed_at_unix_ms: integer("observed_at_unix_ms")?,
        expires_at_unix_ms: integer("expires_at_unix_ms")?,
        revision: integer("revision")?,
    })
}

fn read_reddb_provider_quota(row: &reddb_client::Row) -> Result<StoredProviderQuota, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid provider quota record"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid provider quota record"),
    };
    Ok(StoredProviderQuota {
        provider_id: text("provider_id")?,
        session_remaining_ppm: integer("session_remaining_ppm")?,
        session_reset_unix_ms: integer("session_reset_unix_ms")?,
        weekly_remaining_ppm: integer("weekly_remaining_ppm")?,
        weekly_reset_unix_ms: integer("weekly_reset_unix_ms")?,
        limit_reached: integer("limit_reached")? == 1,
        observed_at_unix_ms: integer("observed_at_unix_ms")?,
        expires_at_unix_ms: integer("expires_at_unix_ms")?,
        revision: integer("revision")?,
    })
}

fn provider_quota_params(
    quota: &StoredProviderQuota,
    limit_reached: i64,
) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(quota.provider_id.clone()),
        reddb_client::Value::Int(quota.session_remaining_ppm),
        reddb_client::Value::Int(quota.session_reset_unix_ms),
        reddb_client::Value::Int(quota.weekly_remaining_ppm),
        reddb_client::Value::Int(quota.weekly_reset_unix_ms),
        reddb_client::Value::Int(limit_reached),
        reddb_client::Value::Int(quota.observed_at_unix_ms),
        reddb_client::Value::Int(quota.expires_at_unix_ms),
        reddb_client::Value::Int(quota.revision),
    ]
}

fn read_sql_breaker(row: &sqlx::any::AnyRow) -> Result<StoredBreaker, &'static str> {
    let text = |name| {
        row.try_get(name)
            .map_err(|_| "invalid provider breaker record")
    };
    let integer = |name| {
        row.try_get(name)
            .map_err(|_| "invalid provider breaker record")
    };
    Ok(StoredBreaker {
        provider_id: text("provider_id")?,
        state: text("breaker_state")?,
        failure_count: integer("failure_count")?,
        last_failure_unix_ms: integer("last_failure_unix_ms")?,
        open_cycle_count: integer("open_cycle_count")?,
        failure_threshold: integer("failure_threshold")?,
        degradation_threshold: integer("degradation_threshold")?,
        reset_timeout_ms: integer("reset_timeout_ms")?,
        revision: integer("revision")?,
    })
}

fn read_reddb_breaker(row: &reddb_client::Row) -> Result<StoredBreaker, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid provider breaker record"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid provider breaker record"),
    };
    Ok(StoredBreaker {
        provider_id: text("provider_id")?,
        state: text("breaker_state")?,
        failure_count: integer("failure_count")?,
        last_failure_unix_ms: integer("last_failure_unix_ms")?,
        open_cycle_count: integer("open_cycle_count")?,
        failure_threshold: integer("failure_threshold")?,
        degradation_threshold: integer("degradation_threshold")?,
        reset_timeout_ms: integer("reset_timeout_ms")?,
        revision: integer("revision")?,
    })
}

fn breaker_params(breaker: &StoredBreaker) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(breaker.provider_id.clone()),
        reddb_client::Value::Text(breaker.state.clone()),
        reddb_client::Value::Int(breaker.failure_count),
        reddb_client::Value::Int(breaker.last_failure_unix_ms),
        reddb_client::Value::Int(breaker.open_cycle_count),
        reddb_client::Value::Int(breaker.failure_threshold),
        reddb_client::Value::Int(breaker.degradation_threshold),
        reddb_client::Value::Int(breaker.reset_timeout_ms),
        reddb_client::Value::Int(breaker.revision),
    ]
}

fn read_sql_availability(row: &sqlx::any::AnyRow) -> Result<StoredAvailability, &'static str> {
    let text = |name| {
        row.try_get(name)
            .map_err(|_| "invalid provider availability record")
    };
    let integer = |name| {
        row.try_get(name)
            .map_err(|_| "invalid provider availability record")
    };
    Ok(StoredAvailability {
        provider_id: text("provider_id")?,
        cooldown_until_unix_ms: integer("cooldown_until_unix_ms")?,
        backoff_level: integer("backoff_level")?,
        last_status: integer("last_status")?,
        model_lockouts_json: text("model_lockouts_json")?,
        revision: integer("revision")?,
    })
}

fn read_reddb_availability(row: &reddb_client::Row) -> Result<StoredAvailability, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid provider availability record"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid provider availability record"),
    };
    Ok(StoredAvailability {
        provider_id: text("provider_id")?,
        cooldown_until_unix_ms: integer("cooldown_until_unix_ms")?,
        backoff_level: integer("backoff_level")?,
        last_status: integer("last_status")?,
        model_lockouts_json: text("model_lockouts_json")?,
        revision: integer("revision")?,
    })
}

fn availability_params(availability: &StoredAvailability) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(availability.provider_id.clone()),
        reddb_client::Value::Int(availability.cooldown_until_unix_ms),
        reddb_client::Value::Int(availability.backoff_level),
        reddb_client::Value::Int(availability.last_status),
        reddb_client::Value::Text(availability.model_lockouts_json.clone()),
        reddb_client::Value::Int(availability.revision),
    ]
}

fn read_sql_resilience(row: &sqlx::any::AnyRow) -> Result<StoredResilience, &'static str> {
    Ok(StoredResilience {
        provider_id: row
            .try_get("provider_id")
            .map_err(|_| "invalid provider resilience record")?,
        rate_limit_scope: row
            .try_get("rate_limit_scope")
            .map_err(|_| "invalid provider resilience record")?,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid provider resilience record")?,
    })
}

fn read_reddb_resilience(row: &reddb_client::Row) -> Result<StoredResilience, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid provider resilience record"),
    };
    let revision = match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case("revision"))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => *value,
        _ => return Err("invalid provider resilience record"),
    };
    Ok(StoredResilience {
        provider_id: text("provider_id")?,
        rate_limit_scope: text("rate_limit_scope")?,
        revision,
    })
}

fn resilience_params(resilience: &StoredResilience) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(resilience_record_id(resilience)),
        reddb_client::Value::Text(resilience.provider_id.clone()),
        reddb_client::Value::Text(resilience.rate_limit_scope.clone()),
        reddb_client::Value::Int(resilience.revision),
    ]
}

fn resilience_record_id(resilience: &StoredResilience) -> String {
    format!("{}:{}", resilience.provider_id, resilience.revision)
}

fn read_sql_oidc(row: &sqlx::any::AnyRow) -> Result<StoredOidcConfig, &'static str> {
    let text = |name| row.try_get(name).map_err(|_| "invalid OIDC record");
    let integer = |name| row.try_get(name).map_err(|_| "invalid OIDC record");
    Ok(StoredOidcConfig {
        enabled: integer("enabled")? == 1,
        issuer: text("issuer")?,
        audience: text("audience")?,
        jwks_uri: text("jwks_uri")?,
        required_claims_json: text("required_claims_json")?,
        allowed_subjects_json: text("allowed_subjects_json")?,
        revision: integer("revision")?,
    })
}

fn read_reddb_oidc(row: &reddb_client::Row) -> Result<StoredOidcConfig, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid OIDC record"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid OIDC record"),
    };
    Ok(StoredOidcConfig {
        enabled: integer("enabled")? == 1,
        issuer: text("issuer")?,
        audience: text("audience")?,
        jwks_uri: text("jwks_uri")?,
        required_claims_json: text("required_claims_json")?,
        allowed_subjects_json: text("allowed_subjects_json")?,
        revision: integer("revision")?,
    })
}

fn oidc_params(config: &StoredOidcConfig, enabled: i64) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Int(enabled),
        reddb_client::Value::Text(config.issuer.clone()),
        reddb_client::Value::Text(config.audience.clone()),
        reddb_client::Value::Text(config.jwks_uri.clone()),
        reddb_client::Value::Text(config.required_claims_json.clone()),
        reddb_client::Value::Text(config.allowed_subjects_json.clone()),
        reddb_client::Value::Int(config.revision),
    ]
}

fn read_sql_oidc_browser(row: &sqlx::any::AnyRow) -> Result<StoredOidcBrowserConfig, &'static str> {
    let text = |name| row.try_get(name).map_err(|_| "invalid OIDC browser record");
    let integer = |name| row.try_get(name).map_err(|_| "invalid OIDC browser record");
    Ok(StoredOidcBrowserConfig {
        public_origin: text("public_origin")?,
        client_id: text("client_id")?,
        client_secret_ciphertext: text("client_secret_ciphertext")?,
        authorization_endpoint: text("authorization_endpoint")?,
        token_endpoint: text("token_endpoint")?,
        scopes_json: text("scopes_json")?,
        revision: integer("revision")?,
    })
}

fn read_reddb_oidc_browser(
    row: &reddb_client::Row,
) -> Result<StoredOidcBrowserConfig, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid OIDC browser record"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid OIDC browser record"),
    };
    Ok(StoredOidcBrowserConfig {
        public_origin: text("public_origin")?,
        client_id: text("client_id")?,
        client_secret_ciphertext: text("client_secret_ciphertext")?,
        authorization_endpoint: text("authorization_endpoint")?,
        token_endpoint: text("token_endpoint")?,
        scopes_json: text("scopes_json")?,
        revision: integer("revision")?,
    })
}

fn oidc_browser_params(config: &StoredOidcBrowserConfig) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(config.public_origin.clone()),
        reddb_client::Value::Text(config.client_id.clone()),
        reddb_client::Value::Text(config.client_secret_ciphertext.clone()),
        reddb_client::Value::Text(config.authorization_endpoint.clone()),
        reddb_client::Value::Text(config.token_endpoint.clone()),
        reddb_client::Value::Text(config.scopes_json.clone()),
        reddb_client::Value::Int(config.revision),
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
