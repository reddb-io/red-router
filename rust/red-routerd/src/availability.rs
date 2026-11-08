//! Per-connection cooldown and per-model lockout state.
//!
//! This is intentionally separate from the provider-wide circuit breaker: an
//! account/key/model failure must not poison every credential for a provider.
use crate::storage::{Database, StoredAvailability};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

const CONNECTION_BASE_MS: u64 = 3_000;
const CONNECTION_MAX_MS: u64 = 5 * 60 * 1_000;
const RETRY_HINT_MAX_MS: u64 = 24 * 60 * 60 * 1_000;
const MODEL_BASE_MS: u64 = 30_000;
const MODEL_MAX_MS: u64 = 10 * 60 * 1_000;
const MAX_BACKOFF_LEVEL: u32 = 16;
const MAX_MODEL_LOCKOUTS: usize = 1_024;
const TERMINAL_UNTIL_UNIX_MS: u64 = i64::MAX as u64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TerminalStatus {
    Banned,
    Expired,
    CreditsExhausted,
}

impl TerminalStatus {
    const fn http_status(self) -> StatusCode {
        match self {
            Self::Banned => StatusCode::FORBIDDEN,
            Self::Expired => StatusCode::UNAUTHORIZED,
            Self::CreditsExhausted => StatusCode::PAYMENT_REQUIRED,
        }
    }

    fn from_http_status(status: u16) -> Option<Self> {
        match status {
            401 => Some(Self::Expired),
            402 => Some(Self::CreditsExhausted),
            403 => Some(Self::Banned),
            _ => None,
        }
    }
}

#[derive(Clone)]
struct Inner {
    cooldown_until_unix_ms: u64,
    backoff_level: u32,
    last_status: Option<u16>,
    terminal_status: Option<TerminalStatus>,
    connection_generation: u64,
    model_lockouts: HashMap<String, ModelLockout>,
}

#[derive(Clone)]
struct ModelLockout {
    until_unix_ms: u64,
    status: u16,
    backoff_level: u32,
    generation: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredModelLockout {
    model: String,
    until_unix_ms: u64,
    status: u16,
    backoff_level: u32,
}

pub(crate) struct ProviderAvailability {
    provider_id: Arc<str>,
    database: Arc<Database>,
    inner: Mutex<Inner>,
    persistence_ok: AtomicBool,
    cooldown_until_unix_ms: AtomicU64,
    connection_generation: AtomicU64,
    has_model_lockouts: AtomicBool,
    needs_recovery: AtomicBool,
}

#[derive(Clone, Copy)]
pub(crate) struct AvailabilityPermit {
    connection_generation: u64,
    model_generation: Option<u64>,
}

pub(crate) enum AvailabilityDecision {
    Permit(AvailabilityPermit),
    Blocked {
        retry_after_ms: u64,
        model_scope: bool,
        terminal_status: Option<TerminalStatus>,
    },
}

#[derive(Debug, Serialize)]
pub(crate) struct AvailabilityStatus {
    pub connection_cooldown_until_unix_ms: u64,
    pub connection_retry_after_ms: u64,
    pub connection_backoff_level: u32,
    pub connection_last_status: Option<u16>,
    pub terminal_status: Option<TerminalStatus>,
    pub model_lockouts: Vec<ModelLockoutStatus>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ModelLockoutStatus {
    pub model: String,
    pub status: u16,
    pub until_unix_ms: u64,
    pub retry_after_ms: u64,
    pub backoff_level: u32,
}

impl ProviderAvailability {
    pub(crate) fn new(provider_id: &str, database: Arc<Database>) -> Self {
        Self::from_inner(
            provider_id,
            database,
            Inner {
                cooldown_until_unix_ms: 0,
                backoff_level: 0,
                last_status: None,
                terminal_status: None,
                connection_generation: 0,
                model_lockouts: HashMap::new(),
            },
        )
    }

    pub(crate) fn from_stored(
        record: &StoredAvailability,
        database: Arc<Database>,
    ) -> Result<Self, &'static str> {
        validate_provider_id(&record.provider_id)?;
        let cooldown_until_unix_ms = non_negative(record.cooldown_until_unix_ms)?;
        let backoff_level = u32::try_from(record.backoff_level)
            .ok()
            .filter(|level| *level <= MAX_BACKOFF_LEVEL)
            .ok_or("invalid provider availability record")?;
        let last_status = match record.last_status {
            0 => None,
            value => Some(
                u16::try_from(value)
                    .ok()
                    .filter(|status| matches!(*status, 401 | 402 | 403 | 429))
                    .ok_or("invalid provider availability record")?,
            ),
        };
        let terminal_status = if cooldown_until_unix_ms == TERMINAL_UNTIL_UNIX_MS {
            last_status.and_then(TerminalStatus::from_http_status)
        } else {
            None
        };
        if (cooldown_until_unix_ms == 0) != last_status.is_none()
            || (last_status.is_some() && backoff_level == 0)
            || (last_status.is_none() && backoff_level != 0)
            || (cooldown_until_unix_ms == TERMINAL_UNTIL_UNIX_MS && terminal_status.is_none())
            || (cooldown_until_unix_ms != TERMINAL_UNTIL_UNIX_MS && last_status == Some(402))
        {
            return Err("invalid provider availability record");
        }
        let stored: Vec<StoredModelLockout> = serde_json::from_str(&record.model_lockouts_json)
            .map_err(|_| "invalid provider availability record")?;
        if stored.len() > MAX_MODEL_LOCKOUTS {
            return Err("invalid provider availability record");
        }
        let now = unix_ms()?;
        let mut model_lockouts = HashMap::new();
        let mut seen_models = HashSet::new();
        for lockout in stored {
            validate_model(&lockout.model)?;
            if !seen_models.insert(lockout.model.clone())
                || !matches!(lockout.status, 400 | 401 | 402 | 403 | 404 | 429)
                || !(1..=MAX_BACKOFF_LEVEL).contains(&lockout.backoff_level)
            {
                return Err("invalid provider availability record");
            }
            if lockout.until_unix_ms > now {
                model_lockouts.insert(
                    lockout.model,
                    ModelLockout {
                        until_unix_ms: lockout.until_unix_ms,
                        status: lockout.status,
                        backoff_level: lockout.backoff_level,
                        generation: 0,
                    },
                );
            }
        }
        Ok(Self::from_inner(
            &record.provider_id,
            database,
            Inner {
                cooldown_until_unix_ms,
                backoff_level,
                last_status,
                terminal_status,
                connection_generation: 0,
                model_lockouts,
            },
        ))
    }

    fn from_inner(provider_id: &str, database: Arc<Database>, inner: Inner) -> Self {
        let has_model_lockouts = !inner.model_lockouts.is_empty();
        let needs_recovery = inner.cooldown_until_unix_ms > 0
            || inner.terminal_status.is_some()
            || has_model_lockouts;
        Self {
            provider_id: Arc::from(provider_id),
            database,
            cooldown_until_unix_ms: AtomicU64::new(inner.cooldown_until_unix_ms),
            connection_generation: AtomicU64::new(inner.connection_generation),
            has_model_lockouts: AtomicBool::new(has_model_lockouts),
            needs_recovery: AtomicBool::new(needs_recovery),
            inner: Mutex::new(inner),
            persistence_ok: AtomicBool::new(true),
        }
    }

    pub(crate) fn persistence_ready(&self) -> bool {
        self.persistence_ok.load(Ordering::Acquire)
    }

    pub(crate) async fn try_acquire(
        &self,
        model: &str,
    ) -> Result<AvailabilityDecision, &'static str> {
        if !self.persistence_ready() {
            return Err("provider availability storage unavailable");
        }
        let now = unix_ms()?;
        loop {
            let generation = self.connection_generation.load(Ordering::Acquire);
            let cooldown_until = self.cooldown_until_unix_ms.load(Ordering::Acquire);
            if cooldown_until > now {
                if cooldown_until == TERMINAL_UNTIL_UNIX_MS {
                    break;
                }
                return Ok(AvailabilityDecision::Blocked {
                    retry_after_ms: cooldown_until.saturating_sub(now),
                    model_scope: false,
                    terminal_status: None,
                });
            }
            if self.has_model_lockouts.load(Ordering::Acquire) {
                break;
            }
            let observed_cooldown = self.cooldown_until_unix_ms.load(Ordering::Acquire);
            let observed_generation = self.connection_generation.load(Ordering::Acquire);
            if generation == observed_generation && observed_cooldown <= now {
                return Ok(AvailabilityDecision::Permit(AvailabilityPermit {
                    connection_generation: generation,
                    model_generation: None,
                }));
            }
        }
        let inner = self.inner.lock().await;
        if inner.cooldown_until_unix_ms > now {
            return Ok(AvailabilityDecision::Blocked {
                retry_after_ms: inner.cooldown_until_unix_ms.saturating_sub(now),
                model_scope: false,
                terminal_status: inner.terminal_status,
            });
        }
        if let Some(lockout) = inner
            .model_lockouts
            .get(model)
            .filter(|lockout| lockout.until_unix_ms > now)
        {
            return Ok(AvailabilityDecision::Blocked {
                retry_after_ms: lockout.until_unix_ms.saturating_sub(now),
                model_scope: true,
                terminal_status: None,
            });
        }
        Ok(AvailabilityDecision::Permit(AvailabilityPermit {
            connection_generation: inner.connection_generation,
            model_generation: inner
                .model_lockouts
                .get(model)
                .map(|lockout| lockout.generation),
        }))
    }

    pub(crate) async fn record_connection_failure(
        &self,
        permit: AvailabilityPermit,
        status: StatusCode,
        retry_hint_ms: Option<u64>,
    ) -> Result<(), &'static str> {
        if !connection_failure_status(status) {
            return Err("invalid provider connection failure status");
        }
        let now = unix_ms()?;
        let mut inner = self.inner.lock().await;
        if permit.connection_generation != inner.connection_generation
            || inner.cooldown_until_unix_ms > now
        {
            return Ok(());
        }
        let mut candidate = inner.clone();
        let exponent = candidate.backoff_level.min(6);
        let exponential = CONNECTION_BASE_MS
            .saturating_mul(1_u64 << exponent)
            .min(CONNECTION_MAX_MS);
        let duration = retry_hint_ms
            .map(|hint| hint.clamp(1_000, RETRY_HINT_MAX_MS))
            .unwrap_or(0)
            .max(exponential);
        candidate.cooldown_until_unix_ms = now.saturating_add(duration);
        candidate.backoff_level = candidate
            .backoff_level
            .saturating_add(1)
            .min(MAX_BACKOFF_LEVEL);
        candidate.last_status = Some(status.as_u16());
        candidate.connection_generation = candidate.connection_generation.wrapping_add(1);
        self.persist(&candidate, now).await?;
        *inner = candidate;
        self.publish(&inner);
        Ok(())
    }

    pub(crate) async fn record_terminal_failure(
        &self,
        permit: AvailabilityPermit,
        terminal_status: TerminalStatus,
    ) -> Result<(), &'static str> {
        let now = unix_ms()?;
        let mut inner = self.inner.lock().await;
        if permit.connection_generation != inner.connection_generation
            || inner.terminal_status.is_some()
        {
            return Ok(());
        }
        let mut candidate = inner.clone();
        candidate.cooldown_until_unix_ms = TERMINAL_UNTIL_UNIX_MS;
        candidate.backoff_level = candidate.backoff_level.max(1);
        candidate.last_status = Some(terminal_status.http_status().as_u16());
        candidate.terminal_status = Some(terminal_status);
        candidate.connection_generation = candidate.connection_generation.wrapping_add(1);
        self.persist(&candidate, now).await?;
        *inner = candidate;
        self.publish(&inner);
        Ok(())
    }

    pub(crate) async fn record_model_failure(
        &self,
        permit: AvailabilityPermit,
        model: &str,
        status: StatusCode,
        retry_hint_ms: Option<u64>,
    ) -> Result<(), &'static str> {
        if !recordable_model_failure_status(status) {
            return Err("invalid provider model failure status");
        }
        validate_model(model)?;
        let now = unix_ms()?;
        let mut inner = self.inner.lock().await;
        let current = inner.model_lockouts.get(model);
        if current.map(|lockout| lockout.generation) != permit.model_generation
            || current.is_some_and(|lockout| lockout.until_unix_ms > now)
        {
            return Ok(());
        }
        if current.is_none() && inner.model_lockouts.len() >= MAX_MODEL_LOCKOUTS {
            return Err("provider model lockout capacity exceeded");
        }
        let mut candidate = inner.clone();
        let previous_level = current.map_or(0, |lockout| lockout.backoff_level);
        let exponential = MODEL_BASE_MS
            .saturating_mul(1_u64 << previous_level.min(4))
            .min(MODEL_MAX_MS);
        let duration = retry_hint_ms
            .map(|hint| hint.clamp(1_000, RETRY_HINT_MAX_MS))
            .unwrap_or(0)
            .max(exponential);
        let generation = current.map_or(1, |lockout| lockout.generation.wrapping_add(1));
        candidate.model_lockouts.insert(
            model.to_owned(),
            ModelLockout {
                until_unix_ms: now.saturating_add(duration),
                status: status.as_u16(),
                backoff_level: previous_level.saturating_add(1).min(MAX_BACKOFF_LEVEL),
                generation,
            },
        );
        self.persist(&candidate, now).await?;
        *inner = candidate;
        self.publish(&inner);
        Ok(())
    }

    pub(crate) async fn record_success(
        &self,
        permit: AvailabilityPermit,
        model: &str,
    ) -> Result<(), &'static str> {
        if !self.needs_recovery.load(Ordering::Acquire) {
            return Ok(());
        }
        let now = unix_ms()?;
        let mut inner = self.inner.lock().await;
        let mut candidate = inner.clone();
        let mut changed = false;
        if permit.connection_generation == candidate.connection_generation
            && candidate.cooldown_until_unix_ms <= now
            && (candidate.backoff_level > 0 || candidate.last_status.is_some())
        {
            candidate.cooldown_until_unix_ms = 0;
            candidate.backoff_level = 0;
            candidate.last_status = None;
            candidate.connection_generation = candidate.connection_generation.wrapping_add(1);
            changed = true;
        }
        if candidate.model_lockouts.get(model).is_some_and(|lockout| {
            Some(lockout.generation) == permit.model_generation && lockout.until_unix_ms <= now
        }) {
            candidate.model_lockouts.remove(model);
            changed = true;
        }
        if !changed {
            return Ok(());
        }
        self.persist(&candidate, now).await?;
        *inner = candidate;
        self.publish(&inner);
        Ok(())
    }

    pub(crate) async fn status(&self) -> Result<AvailabilityStatus, &'static str> {
        let now = unix_ms()?;
        let inner = self.inner.lock().await;
        let mut model_lockouts: Vec<_> = inner
            .model_lockouts
            .iter()
            .filter(|(_, lockout)| lockout.until_unix_ms > now)
            .map(|(model, lockout)| ModelLockoutStatus {
                model: model.clone(),
                status: lockout.status,
                until_unix_ms: lockout.until_unix_ms,
                retry_after_ms: lockout.until_unix_ms.saturating_sub(now),
                backoff_level: lockout.backoff_level,
            })
            .collect();
        model_lockouts.sort_by(|left, right| left.model.cmp(&right.model));
        Ok(AvailabilityStatus {
            connection_cooldown_until_unix_ms: inner.cooldown_until_unix_ms,
            connection_retry_after_ms: inner.cooldown_until_unix_ms.saturating_sub(now),
            connection_backoff_level: inner.backoff_level,
            connection_last_status: inner.last_status,
            terminal_status: inner.terminal_status,
            model_lockouts,
        })
    }

    pub(crate) async fn reset(&self) -> Result<(), &'static str> {
        let mut inner = self.inner.lock().await;
        if self
            .database
            .delete_provider_availability(&self.provider_id)
            .await
            .is_err()
        {
            self.persistence_ok.store(false, Ordering::Release);
            return Err("provider availability storage unavailable");
        }
        inner.cooldown_until_unix_ms = 0;
        inner.backoff_level = 0;
        inner.last_status = None;
        inner.terminal_status = None;
        inner.connection_generation = inner.connection_generation.wrapping_add(1);
        inner.model_lockouts.clear();
        self.persistence_ok.store(true, Ordering::Release);
        self.publish(&inner);
        Ok(())
    }

    async fn persist(&self, inner: &Inner, revision: u64) -> Result<(), &'static str> {
        let mut model_lockouts: Vec<_> = inner
            .model_lockouts
            .iter()
            .map(|(model, lockout)| StoredModelLockout {
                model: model.clone(),
                until_unix_ms: lockout.until_unix_ms,
                status: lockout.status,
                backoff_level: lockout.backoff_level,
            })
            .collect();
        model_lockouts.sort_by(|left, right| left.model.cmp(&right.model));
        let record = StoredAvailability {
            provider_id: self.provider_id.to_string(),
            cooldown_until_unix_ms: to_i64(inner.cooldown_until_unix_ms)?,
            backoff_level: i64::from(inner.backoff_level),
            last_status: i64::from(inner.last_status.unwrap_or(0)),
            model_lockouts_json: serde_json::to_string(&model_lockouts)
                .map_err(|_| "cannot encode provider model lockouts")?,
            revision: to_i64(revision)?,
        };
        match self.database.upsert_provider_availability(&record).await {
            Ok(()) => {
                self.persistence_ok.store(true, Ordering::Release);
                Ok(())
            }
            Err(_) => {
                self.persistence_ok.store(false, Ordering::Release);
                Err("provider availability storage unavailable")
            }
        }
    }

    fn publish(&self, inner: &Inner) {
        self.cooldown_until_unix_ms
            .store(inner.cooldown_until_unix_ms, Ordering::Release);
        self.connection_generation
            .store(inner.connection_generation, Ordering::Release);
        self.has_model_lockouts
            .store(!inner.model_lockouts.is_empty(), Ordering::Release);
        self.needs_recovery.store(
            inner.cooldown_until_unix_ms > 0
                || inner.terminal_status.is_some()
                || inner.backoff_level > 0
                || !inner.model_lockouts.is_empty(),
            Ordering::Release,
        );
    }
}

pub(crate) fn connection_failure_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 401 | 403 | 429)
}

pub(crate) fn model_failure_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 402 | 404 | 429)
}

fn recordable_model_failure_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 400 | 401 | 402 | 403 | 404 | 429)
}

fn validate_provider_id(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("invalid provider availability record");
    }
    Ok(())
}

fn validate_model(value: &str) -> Result<(), &'static str> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err("invalid provider model lockout");
    }
    Ok(())
}

fn non_negative(value: i64) -> Result<u64, &'static str> {
    u64::try_from(value).map_err(|_| "invalid provider availability record")
}

fn to_i64(value: u64) -> Result<i64, &'static str> {
    i64::try_from(value).map_err(|_| "provider availability value is out of range")
}

fn unix_ms() -> Result<u64, &'static str> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before Unix epoch")?
        .as_millis()
        .try_into()
        .map_err(|_| "system clock is out of range")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Backend;
    use tempfile::TempDir;
    use url::Url;

    #[tokio::test]
    async fn concurrent_failures_advance_one_connection_generation() {
        let directory = TempDir::new().unwrap();
        let file = Url::from_file_path(directory.path().join("availability.sqlite")).unwrap();
        let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
        let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
        let availability = ProviderAvailability::new("provider", database.clone());
        let AvailabilityDecision::Permit(permit) = availability.try_acquire("model").await.unwrap()
        else {
            panic!("fresh availability state must permit a request");
        };
        let (one, two, three, four) = tokio::join!(
            availability.record_connection_failure(permit, StatusCode::TOO_MANY_REQUESTS, None),
            availability.record_connection_failure(permit, StatusCode::TOO_MANY_REQUESTS, None),
            availability.record_connection_failure(permit, StatusCode::TOO_MANY_REQUESTS, None),
            availability.record_connection_failure(permit, StatusCode::TOO_MANY_REQUESTS, None)
        );
        assert!(one.is_ok() && two.is_ok() && three.is_ok() && four.is_ok());
        let status = availability.status().await.unwrap();
        assert_eq!(status.connection_backoff_level, 1);
        assert_eq!(status.connection_last_status, Some(429));
        assert!(status.connection_retry_after_ms > 0);
        assert!(matches!(
            availability.try_acquire("model").await.unwrap(),
            AvailabilityDecision::Blocked {
                model_scope: false,
                ..
            }
        ));
        database.close().await.unwrap();
    }

    #[tokio::test]
    async fn terminal_failure_is_durable_until_operator_reset() {
        let directory = TempDir::new().unwrap();
        let file =
            Url::from_file_path(directory.path().join("terminal-availability.sqlite")).unwrap();
        let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
        let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
        let availability = ProviderAvailability::new("provider", database.clone());
        let AvailabilityDecision::Permit(permit) = availability.try_acquire("model").await.unwrap()
        else {
            panic!("fresh availability state must permit a request");
        };
        availability
            .record_terminal_failure(permit, TerminalStatus::CreditsExhausted)
            .await
            .unwrap();
        let status = availability.status().await.unwrap();
        assert_eq!(
            status.terminal_status,
            Some(TerminalStatus::CreditsExhausted)
        );
        assert_eq!(status.connection_last_status, Some(402));
        assert!(matches!(
            availability.try_acquire("model").await.unwrap(),
            AvailabilityDecision::Blocked {
                terminal_status: Some(TerminalStatus::CreditsExhausted),
                model_scope: false,
                ..
            }
        ));

        let records = database.provider_availability().await.unwrap();
        let restored = ProviderAvailability::from_stored(&records[0], database.clone()).unwrap();
        assert!(matches!(
            restored.try_acquire("model").await.unwrap(),
            AvailabilityDecision::Blocked {
                terminal_status: Some(TerminalStatus::CreditsExhausted),
                ..
            }
        ));
        restored.reset().await.unwrap();
        assert!(matches!(
            restored.try_acquire("model").await.unwrap(),
            AvailabilityDecision::Permit(_)
        ));
        database.close().await.unwrap();
    }
}
