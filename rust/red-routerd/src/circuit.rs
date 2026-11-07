//! Rust-owned provider circuit breakers with durable transition state.
use crate::storage::{Database, StoredBreaker};
use axum::http::StatusCode;
use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

const MAX_FAILURE_COUNT: u64 = 1_000_000;
const MAX_RESET_MS: u64 = 24 * 60 * 60 * 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CircuitState {
    Closed,
    Degraded,
    Open,
    HalfOpen,
}

impl CircuitState {
    fn parse(value: &str) -> Result<Self, &'static str> {
        match value {
            "closed" => Ok(Self::Closed),
            "degraded" => Ok(Self::Degraded),
            "open" => Ok(Self::Open),
            "half_open" => Ok(Self::HalfOpen),
            _ => Err("invalid provider breaker state"),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Degraded => "degraded",
            Self::Open => "open",
            Self::HalfOpen => "half_open",
        }
    }
}

struct Inner {
    state: CircuitState,
    failure_count: u64,
    last_failure_unix_ms: u64,
    open_cycle_count: u64,
    failure_threshold: u64,
    degradation_threshold: u64,
    reset_timeout_ms: u64,
    half_open_probe: bool,
    generation: u64,
}

pub(crate) struct ProviderCircuit {
    provider_id: Arc<str>,
    database: Arc<Database>,
    inner: Mutex<Inner>,
    persistence_ok: AtomicBool,
    blocked: AtomicBool,
    needs_recovery: AtomicBool,
    in_flight: Arc<AtomicUsize>,
}

#[derive(Clone, Copy)]
pub(crate) struct CircuitPermit {
    probe_generation: Option<u64>,
}

pub(crate) enum CircuitDecision {
    Permit(CircuitPermit),
    Open { retry_after_ms: u64 },
}

#[derive(Debug, Serialize)]
pub(crate) struct BreakerStatus {
    pub provider_id: String,
    pub state: &'static str,
    pub failure_count: u64,
    pub retry_after_ms: u64,
    pub open_cycle_count: u64,
    pub failure_threshold: u64,
    pub degradation_threshold: u64,
    pub reset_timeout_ms: u64,
}

impl ProviderCircuit {
    pub(crate) fn new(provider_id: &str, database: Arc<Database>, local: bool) -> Self {
        let (failure_threshold, degradation_threshold, reset_timeout_ms) = if local {
            (2, 1, 15_000)
        } else {
            (12, 7, 30_000)
        };
        Self {
            provider_id: Arc::from(provider_id),
            database,
            inner: Mutex::new(Inner {
                state: CircuitState::Closed,
                failure_count: 0,
                last_failure_unix_ms: 0,
                open_cycle_count: 0,
                failure_threshold,
                degradation_threshold,
                reset_timeout_ms,
                half_open_probe: false,
                generation: 0,
            }),
            persistence_ok: AtomicBool::new(true),
            blocked: AtomicBool::new(false),
            needs_recovery: AtomicBool::new(false),
            in_flight: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub(crate) fn from_stored(
        record: &StoredBreaker,
        database: Arc<Database>,
    ) -> Result<Self, &'static str> {
        let state = CircuitState::parse(&record.state)?;
        let failure_count = bounded(record.failure_count, 0, MAX_FAILURE_COUNT)?;
        let last_failure_unix_ms = bounded(record.last_failure_unix_ms, 0, i64::MAX as u64)?;
        let open_cycle_count = bounded(record.open_cycle_count, 0, MAX_FAILURE_COUNT)?;
        let failure_threshold = bounded(record.failure_threshold, 1, 1_000)?;
        let degradation_threshold = bounded(record.degradation_threshold, 1, failure_threshold)?;
        let reset_timeout_ms = bounded(record.reset_timeout_ms, 1_000, MAX_RESET_MS)?;
        if record.provider_id.is_empty()
            || record.provider_id.len() > 128
            || !record
                .provider_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            || (state != CircuitState::Closed && last_failure_unix_ms == 0)
            || (state == CircuitState::Closed && failure_count > degradation_threshold)
            || (state == CircuitState::Degraded
                && !(degradation_threshold..failure_threshold).contains(&failure_count))
        {
            return Err("invalid provider breaker record");
        }
        Ok(Self {
            provider_id: Arc::from(record.provider_id.as_str()),
            database,
            inner: Mutex::new(Inner {
                state,
                failure_count,
                last_failure_unix_ms,
                open_cycle_count,
                failure_threshold,
                degradation_threshold,
                reset_timeout_ms,
                half_open_probe: false,
                generation: 0,
            }),
            persistence_ok: AtomicBool::new(true),
            blocked: AtomicBool::new(matches!(state, CircuitState::Open | CircuitState::HalfOpen)),
            needs_recovery: AtomicBool::new(state != CircuitState::Closed || failure_count > 0),
            in_flight: Arc::new(AtomicUsize::new(0)),
        })
    }

    pub(crate) fn persistence_ready(&self) -> bool {
        self.persistence_ok.load(Ordering::Acquire)
    }

    pub(crate) fn in_flight(&self) -> Arc<AtomicUsize> {
        self.in_flight.clone()
    }

    pub(crate) async fn try_acquire(&self) -> Result<CircuitDecision, &'static str> {
        if !self.persistence_ready() {
            return Err("provider breaker storage unavailable");
        }
        if !self.blocked.load(Ordering::Acquire) {
            return Ok(CircuitDecision::Permit(CircuitPermit {
                probe_generation: None,
            }));
        }
        let now = unix_ms()?;
        let mut inner = self.inner.lock().await;
        if inner.state == CircuitState::Open {
            if now.saturating_sub(inner.last_failure_unix_ms) < effective_reset(&inner) {
                return Ok(CircuitDecision::Open {
                    retry_after_ms: retry_after(&inner, now),
                });
            }
            inner.state = CircuitState::HalfOpen;
            inner.half_open_probe = false;
            inner.generation = inner.generation.wrapping_add(1);
            self.persist(&inner, now).await?;
        }
        if inner.state == CircuitState::HalfOpen {
            if inner.half_open_probe {
                return Ok(CircuitDecision::Open {
                    retry_after_ms: inner.reset_timeout_ms,
                });
            }
            inner.half_open_probe = true;
            return Ok(CircuitDecision::Permit(CircuitPermit {
                probe_generation: Some(inner.generation),
            }));
        }
        Ok(CircuitDecision::Permit(CircuitPermit {
            probe_generation: None,
        }))
    }

    pub(crate) async fn record_failure(&self, permit: CircuitPermit) -> Result<(), &'static str> {
        let now = unix_ms()?;
        let mut inner = self.inner.lock().await;
        if stale_probe(&inner, permit) {
            return Ok(());
        }
        inner.half_open_probe = false;
        self.needs_recovery.store(true, Ordering::Release);
        inner.failure_count = inner.failure_count.saturating_add(1).min(MAX_FAILURE_COUNT);
        inner.last_failure_unix_ms = now;
        if inner.state == CircuitState::HalfOpen {
            inner.open_cycle_count = inner
                .open_cycle_count
                .saturating_add(1)
                .min(MAX_FAILURE_COUNT);
            inner.state = CircuitState::Open;
            self.blocked.store(true, Ordering::Release);
            inner.generation = inner.generation.wrapping_add(1);
        } else if inner.failure_count >= inner.failure_threshold {
            inner.state = CircuitState::Open;
            self.blocked.store(true, Ordering::Release);
            inner.generation = inner.generation.wrapping_add(1);
        } else if inner.failure_count >= inner.degradation_threshold {
            inner.state = CircuitState::Degraded;
        }
        self.persist(&inner, now).await
    }

    pub(crate) async fn record_success(&self, permit: CircuitPermit) -> Result<(), &'static str> {
        if permit.probe_generation.is_none() && !self.needs_recovery.load(Ordering::Acquire) {
            return Ok(());
        }
        let now = unix_ms()?;
        let mut inner = self.inner.lock().await;
        if stale_probe(&inner, permit) {
            return Ok(());
        }
        inner.half_open_probe = false;
        let previous = (inner.state, inner.failure_count, inner.open_cycle_count);
        let should_unblock = matches!(inner.state, CircuitState::Open | CircuitState::HalfOpen);
        if matches!(inner.state, CircuitState::Open | CircuitState::HalfOpen) {
            inner.state = CircuitState::Closed;
            inner.failure_count = 0;
            inner.last_failure_unix_ms = 0;
            inner.open_cycle_count = 0;
            inner.generation = inner.generation.wrapping_add(1);
        } else if inner.failure_count > 0 {
            inner.failure_count -= 1;
            if inner.state == CircuitState::Degraded
                && inner.failure_count <= inner.degradation_threshold
            {
                inner.state = CircuitState::Closed;
            }
        }
        if previous == (inner.state, inner.failure_count, inner.open_cycle_count) {
            return Ok(());
        }
        self.persist(&inner, now).await?;
        if should_unblock {
            self.blocked.store(false, Ordering::Release);
        }
        self.needs_recovery.store(
            inner.state != CircuitState::Closed || inner.failure_count > 0,
            Ordering::Release,
        );
        Ok(())
    }

    pub(crate) async fn record_ignored(&self, permit: CircuitPermit) {
        if permit.probe_generation.is_none() {
            return;
        }
        let mut inner = self.inner.lock().await;
        if !stale_probe(&inner, permit) {
            inner.half_open_probe = false;
        }
    }

    pub(crate) async fn status(&self) -> Result<BreakerStatus, &'static str> {
        let now = unix_ms()?;
        let mut inner = self.inner.lock().await;
        if inner.state == CircuitState::Open
            && now.saturating_sub(inner.last_failure_unix_ms) >= effective_reset(&inner)
        {
            inner.state = CircuitState::HalfOpen;
            inner.half_open_probe = false;
            inner.generation = inner.generation.wrapping_add(1);
            self.persist(&inner, now).await?;
        }
        Ok(BreakerStatus {
            provider_id: self.provider_id.to_string(),
            state: inner.state.as_str(),
            failure_count: inner.failure_count,
            retry_after_ms: retry_after(&inner, now),
            open_cycle_count: inner.open_cycle_count,
            failure_threshold: inner.failure_threshold,
            degradation_threshold: inner.degradation_threshold,
            reset_timeout_ms: inner.reset_timeout_ms,
        })
    }

    pub(crate) async fn reset(&self) -> Result<(), &'static str> {
        let now = unix_ms()?;
        let mut inner = self.inner.lock().await;
        inner.state = CircuitState::Closed;
        inner.failure_count = 0;
        inner.last_failure_unix_ms = 0;
        inner.open_cycle_count = 0;
        inner.half_open_probe = false;
        inner.generation = inner.generation.wrapping_add(1);
        self.persist(&inner, now).await?;
        self.blocked.store(false, Ordering::Release);
        self.needs_recovery.store(false, Ordering::Release);
        self.persistence_ok.store(true, Ordering::Release);
        Ok(())
    }

    pub(crate) async fn configure(
        &self,
        failure_threshold: u64,
        degradation_threshold: u64,
        reset_timeout_ms: u64,
    ) -> Result<BreakerStatus, &'static str> {
        if !(1..=1_000).contains(&failure_threshold)
            || !(1..=failure_threshold).contains(&degradation_threshold)
            || !(1_000..=MAX_RESET_MS).contains(&reset_timeout_ms)
        {
            return Err("invalid provider breaker configuration");
        }
        let now = unix_ms()?;
        let mut inner = self.inner.lock().await;
        inner.failure_threshold = failure_threshold;
        inner.degradation_threshold = degradation_threshold;
        inner.reset_timeout_ms = reset_timeout_ms;
        if matches!(inner.state, CircuitState::Closed | CircuitState::Degraded) {
            if inner.failure_count >= failure_threshold {
                inner.state = CircuitState::Open;
                inner.last_failure_unix_ms = now;
                inner.half_open_probe = false;
                inner.generation = inner.generation.wrapping_add(1);
                self.blocked.store(true, Ordering::Release);
                self.needs_recovery.store(true, Ordering::Release);
            } else if inner.failure_count >= degradation_threshold {
                inner.state = CircuitState::Degraded;
                self.needs_recovery.store(true, Ordering::Release);
            } else {
                inner.state = CircuitState::Closed;
                self.blocked.store(false, Ordering::Release);
                self.needs_recovery
                    .store(inner.failure_count > 0, Ordering::Release);
            }
        }
        self.persist(&inner, now).await?;
        Ok(BreakerStatus {
            provider_id: self.provider_id.to_string(),
            state: inner.state.as_str(),
            failure_count: inner.failure_count,
            retry_after_ms: retry_after(&inner, now),
            open_cycle_count: inner.open_cycle_count,
            failure_threshold: inner.failure_threshold,
            degradation_threshold: inner.degradation_threshold,
            reset_timeout_ms: inner.reset_timeout_ms,
        })
    }

    async fn persist(&self, inner: &Inner, revision: u64) -> Result<(), &'static str> {
        let record = StoredBreaker {
            provider_id: self.provider_id.to_string(),
            state: inner.state.as_str().to_owned(),
            failure_count: to_i64(inner.failure_count)?,
            last_failure_unix_ms: to_i64(inner.last_failure_unix_ms)?,
            open_cycle_count: to_i64(inner.open_cycle_count)?,
            failure_threshold: to_i64(inner.failure_threshold)?,
            degradation_threshold: to_i64(inner.degradation_threshold)?,
            reset_timeout_ms: to_i64(inner.reset_timeout_ms)?,
            revision: to_i64(revision)?,
        };
        match self.database.upsert_breaker(&record).await {
            Ok(()) => {
                self.persistence_ok.store(true, Ordering::Release);
                Ok(())
            }
            Err(_) => {
                self.persistence_ok.store(false, Ordering::Release);
                Err("provider breaker storage unavailable")
            }
        }
    }
}

pub(crate) fn provider_failure_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 500 | 502 | 503 | 504)
}

fn stale_probe(inner: &Inner, permit: CircuitPermit) -> bool {
    permit
        .probe_generation
        .is_some_and(|generation| generation != inner.generation)
}

fn effective_reset(inner: &Inner) -> u64 {
    if inner.open_cycle_count <= 3 {
        return inner.reset_timeout_ms;
    }
    let shift = (inner.open_cycle_count - 3).min(2) as u32;
    inner
        .reset_timeout_ms
        .saturating_mul(1_u64 << shift)
        .min(inner.reset_timeout_ms.saturating_mul(4))
}

fn retry_after(inner: &Inner, now: u64) -> u64 {
    if !matches!(inner.state, CircuitState::Open | CircuitState::HalfOpen) {
        return 0;
    }
    effective_reset(inner).saturating_sub(now.saturating_sub(inner.last_failure_unix_ms))
}

fn unix_ms() -> Result<u64, &'static str> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is unavailable")?
        .as_millis();
    u64::try_from(millis).map_err(|_| "system clock is out of range")
}

fn bounded(value: i64, minimum: u64, maximum: u64) -> Result<u64, &'static str> {
    u64::try_from(value)
        .ok()
        .filter(|value| (*value >= minimum) && (*value <= maximum))
        .ok_or("invalid provider breaker record")
}

fn to_i64(value: u64) -> Result<i64, &'static str> {
    i64::try_from(value).map_err(|_| "provider breaker state is out of range")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Backend;
    use tempfile::TempDir;
    use url::Url;

    async fn database() -> (TempDir, Arc<Database>) {
        let directory = TempDir::new().unwrap();
        let file = Url::from_file_path(directory.path().join("breakers.sqlite")).unwrap();
        let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
        let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
        (directory, database)
    }

    #[tokio::test]
    async fn persists_transitions_and_allows_one_half_open_probe() {
        let (_directory, database) = database().await;
        let circuit = ProviderCircuit::new("local", database.clone(), true);

        circuit
            .record_failure(match circuit.try_acquire().await.unwrap() {
                CircuitDecision::Permit(permit) => permit,
                CircuitDecision::Open { .. } => panic!("closed circuit refused request"),
            })
            .await
            .unwrap();
        assert_eq!(circuit.status().await.unwrap().state, "degraded");
        circuit
            .record_failure(match circuit.try_acquire().await.unwrap() {
                CircuitDecision::Permit(permit) => permit,
                CircuitDecision::Open { .. } => panic!("degraded circuit refused request"),
            })
            .await
            .unwrap();
        let open = circuit.status().await.unwrap();
        assert_eq!(open.state, "open");
        assert_eq!(open.failure_count, 2);
        assert_eq!(database.breakers().await.unwrap()[0].state, "open");

        let mut stored = database.breakers().await.unwrap().remove(0);
        stored.last_failure_unix_ms = i64::try_from(unix_ms().unwrap() - 2_000).unwrap();
        stored.reset_timeout_ms = 1_000;
        database.upsert_breaker(&stored).await.unwrap();
        let restored = ProviderCircuit::from_stored(&stored, database.clone()).unwrap();
        let probe = match restored.try_acquire().await.unwrap() {
            CircuitDecision::Permit(permit) => permit,
            CircuitDecision::Open { .. } => panic!("expired circuit refused probe"),
        };
        assert_eq!(restored.status().await.unwrap().state, "half_open");
        assert!(matches!(
            restored.try_acquire().await.unwrap(),
            CircuitDecision::Open { .. }
        ));
        restored.record_ignored(probe).await;
        let successful_probe = match restored.try_acquire().await.unwrap() {
            CircuitDecision::Permit(permit) => permit,
            CircuitDecision::Open { .. } => panic!("released probe stayed blocked"),
        };
        restored.record_success(successful_probe).await.unwrap();
        assert_eq!(restored.status().await.unwrap().state, "closed");
        assert_eq!(database.breakers().await.unwrap()[0].state, "closed");

        restored.reset().await.unwrap();
        let reset = database.breakers().await.unwrap().remove(0);
        assert_eq!(reset.state, "closed");
        assert_eq!(reset.failure_count, 0);
        assert_eq!(reset.failure_threshold, 2);
        assert_eq!(reset.degradation_threshold, 1);
        assert_eq!(reset.reset_timeout_ms, 1_000);
    }

    #[tokio::test]
    async fn persists_operator_configuration_and_preserves_it_on_reset() {
        let (_directory, database) = database().await;
        let circuit = ProviderCircuit::new("configured", database.clone(), false);
        let configured = circuit.configure(5, 2, 45_000).await.unwrap();
        assert_eq!(configured.failure_threshold, 5);
        assert_eq!(configured.degradation_threshold, 2);
        assert_eq!(configured.reset_timeout_ms, 45_000);

        let record = database.breakers().await.unwrap().remove(0);
        let restored = ProviderCircuit::from_stored(&record, database.clone()).unwrap();
        let restored_status = restored.status().await.unwrap();
        assert_eq!(restored_status.failure_threshold, 5);
        assert_eq!(restored_status.degradation_threshold, 2);
        assert_eq!(restored_status.reset_timeout_ms, 45_000);

        restored.reset().await.unwrap();
        let reset = database.breakers().await.unwrap().remove(0);
        assert_eq!(reset.failure_threshold, 5);
        assert_eq!(reset.degradation_threshold, 2);
        assert_eq!(reset.reset_timeout_ms, 45_000);
    }

    #[tokio::test]
    async fn lowering_threshold_applies_to_accumulated_failures() {
        let (_directory, database) = database().await;
        let circuit = ProviderCircuit::new("lowered", database.clone(), false);
        let permit = match circuit.try_acquire().await.unwrap() {
            CircuitDecision::Permit(permit) => permit,
            CircuitDecision::Open { .. } => panic!("closed circuit refused request"),
        };
        circuit.record_failure(permit).await.unwrap();
        assert_eq!(circuit.status().await.unwrap().state, "closed");

        let configured = circuit.configure(1, 1, 60_000).await.unwrap();
        assert_eq!(configured.state, "open");
        assert_eq!(configured.failure_count, 1);
        assert!(matches!(
            circuit.try_acquire().await.unwrap(),
            CircuitDecision::Open { .. }
        ));

        let raised = circuit.configure(5, 2, 60_000).await.unwrap();
        assert_eq!(raised.state, "open");
        let record = database.breakers().await.unwrap().remove(0);
        assert!(ProviderCircuit::from_stored(&record, database).is_ok());
    }

    #[test]
    fn only_provider_wide_failures_trip_the_breaker() {
        for status in [408, 500, 502, 503, 504] {
            assert!(provider_failure_status(
                StatusCode::from_u16(status).unwrap()
            ));
        }
        for status in [400, 401, 403, 404, 409, 429, 501, 505] {
            assert!(!provider_failure_status(
                StatusCode::from_u16(status).unwrap()
            ));
        }
    }
}
