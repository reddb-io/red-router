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
    #[cfg(feature = "reddb-embedded")]
    Embedded(reddb_client::Reddb),
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
                    let db = reddb_client::Reddb::connect(url)
                        .await
                        .map_err(|_| "cannot open embedded RedDB")?;
                    db.query(CREATE)
                        .await
                        .map_err(|_| "cannot initialize database")?;
                    Ok(Self::Embedded(db))
                }
                #[cfg(not(feature = "reddb-embedded"))]
                {
                    Err("embedded RedDB is not included in this build")
                }
            }
            Backend::Sqlite | Backend::Postgres | Backend::ReddbRemote => {
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
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded(db) => {
                let result = db.query(READ).await.map_err(|_| "cannot read database")?;
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
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded(db) => {
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
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded(db) => db.close().await.map_err(|_| "cannot checkpoint database")?,
        }
        Ok(())
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
