//! Experimental persistence of the single configured upstream endpoint.
//!
//! Credentials stay in process configuration and are never written here. Each
//! process selects one database authority; connection errors never fall back.
use sqlx::{any::AnyPoolOptions, AnyPool, Row};
use std::sync::Once;

const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_proxy_config (id INTEGER PRIMARY KEY, upstream_url TEXT NOT NULL)";
const READ: &str = "SELECT upstream_url FROM redrouter_proxy_config WHERE id = 1";
const SEED: &str = "INSERT INTO redrouter_proxy_config (id, upstream_url) VALUES (1, $1) ON CONFLICT (id) DO NOTHING";
const SET: &str = "INSERT INTO redrouter_proxy_config (id, upstream_url) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET upstream_url = $1";

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
                    let db = reddb_client::Reddb::connect(url)
                        .await
                        .map_err(|_| "cannot open embedded RedDB")?;
                    db.query(CREATE)
                        .await
                        .map_err(|_| "cannot initialize database")?;
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
                for (name, value) in parsed.query_pairs() {
                    if name != "token" || token.is_some() || value.is_empty() {
                        return Err("invalid RedDB connection options");
                    }
                    token = Some(value.into_owned());
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
                    options = options.with_tls(TlsConfig::new());
                }
                let client = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    RedWireClient::connect(options),
                )
                .await
                .map_err(|_| "database connection timed out")?
                .map_err(|_| "cannot connect to selected database")?;
                let db = Self::Remote(tokio::sync::Mutex::new(Some(client)));
                db.remote_query(CREATE, &[]).await?;
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
                sqlx::query(CREATE)
                    .execute(&pool)
                    .await
                    .map_err(|_| "cannot initialize database")?;
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

pub fn embedded_default_url() -> Result<String, &'static str> {
    let path = std::env::current_dir()
        .map_err(|_| "cannot resolve database path")?
        .join("red-router.rdb");
    url::Url::from_file_path(path)
        .map(|url| url.to_string())
        .map_err(|_| "invalid database path")
}
