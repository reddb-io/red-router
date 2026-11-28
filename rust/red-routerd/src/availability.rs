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
        atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

const CONNECTION_BASE_MS: u64 = 3_000;
/// Largest configurable base connection cooldown.
const CONNECTION_MAX_MS: u64 = 5 * 60 * 1_000;
/// Legacy connection cooldown ceiling: `modelLockout.maxCooldownMs`, which
/// defaults to 30 minutes and ranges from 5 seconds to an hour.
pub(crate) const DEFAULT_CONNECTION_MAX_COOLDOWN_MS: u64 = 30 * 60 * 1_000;
pub(crate) const CONNECTION_MAX_COOLDOWN_RANGE: std::ops::RangeInclusive<u64> =
    5_000..=60 * 60 * 1_000;
const RETRY_HINT_MAX_MS: u64 = 24 * 60 * 60 * 1_000;
const MODEL_BASE_MS: u64 = 30_000;
const MODEL_MAX_MS: u64 = 10 * 60 * 1_000;
const MAX_BACKOFF_LEVEL: u32 = 16;
const MAX_MODEL_LOCKOUTS: usize = 1_024;
const AMBIGUOUS_AUTH_MAX_SOFT_STRIKES: u32 = crate::mistral_ambiguous_auth::MAX_SOFT_STRIKES;
const AMBIGUOUS_AUTH_STRIKE_WINDOW_MS: u64 = crate::mistral_ambiguous_auth::STRIKE_WINDOW_MS;
const TERMINAL_UNTIL_UNIX_MS: u64 = i64::MAX as u64;

/// Legacy `modelLockout` (`resolveModelLockoutSettings`): an opt-in lockout of
/// a combo target's model on the configured statuses. Its `maxCooldownMs` is
/// the connection cooldown ceiling; `maxBackoffSteps` is not read by the
/// legacy lockouts, which scale with the provider profile's steps.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelLockoutPolicy {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_lockout_codes")]
    pub error_codes: Vec<u16>,
    #[serde(default = "default_lockout_base_ms")]
    pub base_cooldown_ms: u64,
    #[serde(default = "default_true")]
    pub use_exponential_backoff: bool,
}

fn default_lockout_codes() -> Vec<u16> {
    vec![403, 404, 429, 502, 503, 504]
}

fn default_lockout_base_ms() -> u64 {
    120_000
}

fn default_true() -> bool {
    true
}

impl Default for ModelLockoutPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            error_codes: default_lockout_codes(),
            base_cooldown_ms: default_lockout_base_ms(),
            use_exponential_backoff: true,
        }
    }
}

impl ModelLockoutPolicy {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.error_codes.is_empty()
            || self.error_codes.len() > 100
            || self
                .error_codes
                .iter()
                .any(|code| !(100..=599).contains(code))
            || !(5_000..=600_000).contains(&self.base_cooldown_ms)
        {
            return Err("invalid model lockout policy");
        }
        Ok(())
    }

    /// Whether a combo target failure with this status locks its model.
    pub(crate) fn applies(&self, status: StatusCode) -> bool {
        self.enabled && self.error_codes.contains(&status.as_u16())
    }

    /// Legacy `selectLockoutCooldownMs` and `recordModelLockoutFailure`: a
    /// retry hint longer than the base wins (an authoritative header hint is
    /// not capped); otherwise a fixed base, or the base doubled per repeated
    /// failure up to the profile's steps; both capped by the ceiling.
    pub(crate) fn cooldown_ms(
        &self,
        failure_count: u32,
        retry_hint_ms: Option<u64>,
        hint_authoritative: bool,
        max_backoff_steps: u32,
        max_cooldown_ms: u64,
    ) -> u64 {
        let exact = match retry_hint_ms {
            Some(hint) if hint > self.base_cooldown_ms => hint,
            _ if self.use_exponential_backoff => 0,
            _ => self.base_cooldown_ms,
        };
        if exact > 0 {
            return if hint_authoritative && exact > self.base_cooldown_ms {
                exact
            } else {
                exact.min(max_cooldown_ms)
            };
        }
        let exponent = failure_count
            .saturating_sub(1)
            .min(max_backoff_steps)
            .min(32);
        self.base_cooldown_ms
            .saturating_mul(1_u64 << exponent)
            .min(max_cooldown_ms)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ConnectionCooldownProfile {
    pub base_cooldown_ms: u64,
    pub use_upstream_retry_hints: bool,
    pub max_backoff_steps: u32,
    /// Ceiling on the scaled cooldown (an upstream retry hint may exceed it).
    pub max_cooldown_ms: u64,
}

impl ConnectionCooldownProfile {
    pub(crate) const fn oauth_default() -> Self {
        Self {
            base_cooldown_ms: 5_000,
            use_upstream_retry_hints: false,
            max_backoff_steps: 8,
            max_cooldown_ms: DEFAULT_CONNECTION_MAX_COOLDOWN_MS,
        }
    }

    pub(crate) const fn api_key_default() -> Self {
        Self {
            base_cooldown_ms: CONNECTION_BASE_MS,
            use_upstream_retry_hints: true,
            max_backoff_steps: 5,
            max_cooldown_ms: DEFAULT_CONNECTION_MAX_COOLDOWN_MS,
        }
    }
}

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
    ambiguous_auth_strikes: u32,
    ambiguous_auth_window_started_unix_ms: u64,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredAvailabilityState {
    version: u8,
    model_lockouts: Vec<StoredModelLockout>,
    ambiguous_auth_strikes: u32,
    ambiguous_auth_window_started_unix_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum StoredAvailabilityStateCompat {
    Legacy(Vec<StoredModelLockout>),
    Current(StoredAvailabilityState),
}

pub(crate) struct ProviderAvailability {
    provider_id: Arc<str>,
    database: Arc<Database>,
    inner: Mutex<Inner>,
    persistence_ok: AtomicBool,
    cooldown_until_unix_ms: AtomicU64,
    connection_generation: AtomicU64,
    has_model_lockouts: AtomicBool,
    /// How a quota failure groups this provider's models (legacy
    /// `getModelLockKey`): exact models, Codex scopes or Antigravity families.
    lock_family: AtomicU8,
    needs_recovery: AtomicBool,
    cooldown_base_ms: AtomicU64,
    cooldown_retry_hints: AtomicBool,
    cooldown_max_backoff_steps: AtomicU32,
    cooldown_max_ms: AtomicU64,
    /// The account's node clock (IANA timezone, local hour) for daily quota
    /// resets, and whether the account is OAuth (legacy provider category).
    daily_reset: std::sync::Mutex<(Option<String>, Option<u8>)>,
    oauth: AtomicBool,
}

#[derive(Clone, Copy)]
pub(crate) struct AvailabilityPermit {
    connection_generation: u64,
    model_generation: Option<u64>,
    /// The generation of the model's quota-family lockout, if any.
    family_generation: Option<u64>,
}

pub(crate) enum AvailabilityDecision {
    Permit(AvailabilityPermit),
    Blocked {
        retry_after_ms: u64,
        model_scope: bool,
        terminal_status: Option<TerminalStatus>,
        /// The failure status behind the cooldown or lockout.
        last_status: Option<u16>,
    },
}

#[derive(Debug, Serialize)]
pub(crate) struct AvailabilityStatus {
    pub connection_cooldown_until_unix_ms: u64,
    pub connection_retry_after_ms: u64,
    pub connection_backoff_level: u32,
    pub connection_last_status: Option<u16>,
    pub terminal_status: Option<TerminalStatus>,
    pub ambiguous_auth_strikes: u32,
    pub ambiguous_auth_retry_limit: u32,
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
                ambiguous_auth_strikes: 0,
                ambiguous_auth_window_started_unix_ms: 0,
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
                    // Fixed lockouts (moved endpoints) keep their own status.
                    .filter(|status| (400..=599).contains(status))
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
        let now = unix_ms()?;
        let stored =
            serde_json::from_str::<StoredAvailabilityStateCompat>(&record.model_lockouts_json)
                .map_err(|_| "invalid provider availability record")?;
        let (stored, ambiguous_auth_strikes, ambiguous_auth_window_started_unix_ms) = match stored {
            StoredAvailabilityStateCompat::Legacy(model_lockouts) => (model_lockouts, 0, 0),
            StoredAvailabilityStateCompat::Current(state)
                if state.version == 1
                    && state.ambiguous_auth_strikes <= AMBIGUOUS_AUTH_MAX_SOFT_STRIKES
                    && ((state.ambiguous_auth_strikes == 0
                        && state.ambiguous_auth_window_started_unix_ms == 0)
                        || (state.ambiguous_auth_strikes > 0
                            && state.ambiguous_auth_window_started_unix_ms > 0
                            && state.ambiguous_auth_window_started_unix_ms <= now)) =>
            {
                (
                    state.model_lockouts,
                    state.ambiguous_auth_strikes,
                    state.ambiguous_auth_window_started_unix_ms,
                )
            }
            StoredAvailabilityStateCompat::Current(_) => {
                return Err("invalid provider availability record")
            }
        };
        if stored.len() > MAX_MODEL_LOCKOUTS {
            return Err("invalid provider availability record");
        }
        let mut model_lockouts = HashMap::new();
        let mut seen_models = HashSet::new();
        for lockout in stored {
            validate_model(&lockout.model)?;
            if !seen_models.insert(lockout.model.clone())
                || !(matches!(lockout.status, 400 | 401 | 402 | 403 | 404 | 410 | 429)
                    || (500..=599).contains(&lockout.status))
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
                ambiguous_auth_strikes,
                ambiguous_auth_window_started_unix_ms,
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
            lock_family: AtomicU8::new(LOCK_FAMILY_EXACT),
            needs_recovery: AtomicBool::new(needs_recovery),
            cooldown_base_ms: AtomicU64::new(CONNECTION_BASE_MS),
            cooldown_retry_hints: AtomicBool::new(true),
            cooldown_max_backoff_steps: AtomicU32::new(5),
            cooldown_max_ms: AtomicU64::new(DEFAULT_CONNECTION_MAX_COOLDOWN_MS),
            daily_reset: std::sync::Mutex::new((None, None)),
            oauth: AtomicBool::new(false),
            inner: Mutex::new(inner),
            persistence_ok: AtomicBool::new(true),
        }
    }

    pub(crate) fn configure_cooldown(
        &self,
        profile: ConnectionCooldownProfile,
    ) -> Result<(), &'static str> {
        if profile.base_cooldown_ms > CONNECTION_MAX_MS
            || profile.max_backoff_steps > MAX_BACKOFF_LEVEL
            || !CONNECTION_MAX_COOLDOWN_RANGE.contains(&profile.max_cooldown_ms)
        {
            return Err("invalid connection cooldown profile");
        }
        self.cooldown_base_ms
            .store(profile.base_cooldown_ms, Ordering::Release);
        self.cooldown_retry_hints
            .store(profile.use_upstream_retry_hints, Ordering::Release);
        self.cooldown_max_backoff_steps
            .store(profile.max_backoff_steps, Ordering::Release);
        self.cooldown_max_ms
            .store(profile.max_cooldown_ms, Ordering::Release);
        Ok(())
    }

    /// Set the account's daily quota clock (from its provider node) and
    /// whether it is an OAuth account.
    pub(crate) fn configure_daily_reset(
        &self,
        timezone: Option<&str>,
        hour: Option<u8>,
        oauth: bool,
    ) -> Result<(), &'static str> {
        let mut clock = self
            .daily_reset
            .lock()
            .map_err(|_| "provider daily reset clock unavailable")?;
        *clock = (timezone.map(str::to_owned), hour);
        self.oauth.store(oauth, Ordering::Release);
        Ok(())
    }

    /// OAuth accounts keep quota semantics on a 429 (legacy
    /// `shouldPreserveQuotaSignals`).
    /// The ceiling of a scaled connection cooldown, which the legacy model
    /// lockout also takes as its `maxCooldownMs`.
    pub(crate) fn max_cooldown_ms(&self) -> u64 {
        self.cooldown_profile().max_cooldown_ms
    }

    /// Whether the connection's cooldown profile honors upstream retry hints.
    pub(crate) fn uses_upstream_retry_hints(&self) -> bool {
        self.cooldown_profile().use_upstream_retry_hints
    }

    pub(crate) fn preserves_quota_signals(&self) -> bool {
        self.oauth.load(Ordering::Acquire)
    }

    /// The legacy daily-quota cooldown. A TPD limit waits for the upstream
    /// reset hint, else the node clock, else nothing (the caller keeps the
    /// short 429 cooldown); other daily-quota text waits for the node clock,
    /// else the host's next midnight, capped at 24 hours.
    pub(crate) fn daily_quota_lockout_ms(
        &self,
        tpd: bool,
        reset_hint_ms: Option<u64>,
    ) -> Option<u64> {
        let now = i64::try_from(unix_ms().ok()?).ok()?;
        let (timezone, hour) = self.daily_reset.lock().ok()?.clone();
        let configured = crate::daily_quota_reset::next_configured_reset_ms(
            timezone.as_deref(),
            hour.map(i64::from),
            now,
        );
        if tpd {
            return reset_hint_ms.filter(|hint| *hint > 0).or(configured);
        }
        Some(
            configured
                .unwrap_or_else(|| crate::daily_quota_reset::ms_until_host_midnight(now))
                .min(24 * 60 * 60 * 1_000),
        )
    }

    fn cooldown_profile(&self) -> ConnectionCooldownProfile {
        ConnectionCooldownProfile {
            base_cooldown_ms: self.cooldown_base_ms.load(Ordering::Acquire),
            use_upstream_retry_hints: self.cooldown_retry_hints.load(Ordering::Acquire),
            max_backoff_steps: self.cooldown_max_backoff_steps.load(Ordering::Acquire),
            max_cooldown_ms: self.cooldown_max_ms.load(Ordering::Acquire),
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
            // The locked path reports the status behind an active cooldown.
            if cooldown_until > now {
                break;
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
                    family_generation: None,
                }));
            }
        }
        let inner = self.inner.lock().await;
        if inner.cooldown_until_unix_ms > now {
            return Ok(AvailabilityDecision::Blocked {
                retry_after_ms: inner.cooldown_until_unix_ms.saturating_sub(now),
                model_scope: false,
                terminal_status: inner.terminal_status,
                last_status: inner.last_status,
            });
        }
        let family = self.family_key(model);
        if let Some(lockout) = [Some(model), family.as_deref()]
            .into_iter()
            .flatten()
            .filter_map(|key| inner.model_lockouts.get(key))
            .filter(|lockout| lockout.until_unix_ms > now)
            .max_by_key(|lockout| lockout.until_unix_ms)
        {
            return Ok(AvailabilityDecision::Blocked {
                retry_after_ms: lockout.until_unix_ms.saturating_sub(now),
                model_scope: true,
                terminal_status: None,
                last_status: Some(lockout.status),
            });
        }
        Ok(AvailabilityDecision::Permit(AvailabilityPermit {
            connection_generation: inner.connection_generation,
            model_generation: inner
                .model_lockouts
                .get(model)
                .map(|lockout| lockout.generation),
            family_generation: family
                .as_deref()
                .and_then(|key| inner.model_lockouts.get(key))
                .map(|lockout| lockout.generation),
        }))
    }

    /// Sets the provider whose models this connection groups by quota family.
    pub(crate) fn set_lock_family(&self, provider: &str) {
        let family = match provider {
            "codex" => LOCK_FAMILY_CODEX,
            "antigravity" | "agy" => LOCK_FAMILY_ANTIGRAVITY,
            _ => LOCK_FAMILY_EXACT,
        };
        self.lock_family.store(family, Ordering::Release);
    }

    /// Legacy `getModelLockKey` without the exact-model cases: the Codex
    /// quota scope, or the Antigravity quota family.
    fn family_key(&self, model: &str) -> Option<String> {
        match self.lock_family.load(Ordering::Acquire) {
            LOCK_FAMILY_CODEX => Some(format!("scope:{}", codex_scope(model))),
            LOCK_FAMILY_ANTIGRAVITY => {
                antigravity_family(model).map(|family| format!("family:{family}"))
            }
            _ => None,
        }
    }

    /// Legacy `resolveLockoutScope`: a 402, 403 or 429 locks the model's
    /// quota family; a 404 (the model itself is missing) and other statuses
    /// lock the exact model. Returns the key and the permit generation that
    /// guards it.
    fn lock_key(
        &self,
        permit: AvailabilityPermit,
        model: &str,
        status: StatusCode,
    ) -> (String, Option<u64>) {
        if matches!(status.as_u16(), 402 | 403 | 429) {
            if let Some(family) = self.family_key(model) {
                return (family, permit.family_generation);
            }
        }
        (model.to_owned(), permit.model_generation)
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
        apply_connection_cooldown(
            &mut candidate,
            now,
            status,
            retry_hint_ms,
            self.cooldown_profile(),
        );
        self.persist(&candidate, now).await?;
        *inner = candidate;
        self.publish(&inner);
        Ok(())
    }

    /// Park the connection for a fixed window, whatever the cooldown profile,
    /// after a failure every retry repeats until an operator acts (a moved
    /// endpoint; legacy `checkFallbackError`).
    pub(crate) async fn record_connection_lockout(
        &self,
        permit: AvailabilityPermit,
        status: StatusCode,
        duration_ms: u64,
    ) -> Result<(), &'static str> {
        if !(status.is_client_error() || status.is_server_error()) {
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
        candidate.cooldown_until_unix_ms =
            now.saturating_add(duration_ms.clamp(1_000, RETRY_HINT_MAX_MS));
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

    /// A fixed connection cooldown that does not escalate the backoff (legacy
    /// `serviceSupervisorCooldown`, `newBackoffLevel: 0`): the embedded
    /// supervisor changing state is not the upstream failing, so a repeat must
    /// not make the next real failure wait longer.
    pub(crate) async fn record_fixed_connection_cooldown(
        &self,
        permit: AvailabilityPermit,
        status: StatusCode,
        duration_ms: u64,
    ) -> Result<(), &'static str> {
        if !(status.is_client_error() || status.is_server_error()) {
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
        candidate.cooldown_until_unix_ms =
            now.saturating_add(duration_ms.clamp(1_000, RETRY_HINT_MAX_MS));
        candidate.backoff_level = 0;
        candidate.last_status = Some(status.as_u16());
        candidate.connection_generation = candidate.connection_generation.wrapping_add(1);
        self.persist(&candidate, now).await?;
        *inner = candidate;
        self.publish(&inner);
        Ok(())
    }

    /// A bare Mistral 401 can mean either a revoked credential or exhausted
    /// quota. Give it three durable, bounded cooldowns in a one-hour window;
    /// the next identical failure converges to terminal expiry.
    pub(crate) async fn record_ambiguous_auth_failure(
        &self,
        permit: AvailabilityPermit,
        status: StatusCode,
        retry_hint_ms: Option<u64>,
    ) -> Result<(), &'static str> {
        if status != StatusCode::UNAUTHORIZED {
            return Err("invalid ambiguous provider authentication status");
        }
        let now = unix_ms()?;
        let mut inner = self.inner.lock().await;
        if permit.connection_generation != inner.connection_generation
            || inner.cooldown_until_unix_ms > now
        {
            return Ok(());
        }
        let mut candidate = inner.clone();
        let reset_window = candidate.ambiguous_auth_window_started_unix_ms == 0
            || now.saturating_sub(candidate.ambiguous_auth_window_started_unix_ms)
                >= AMBIGUOUS_AUTH_STRIKE_WINDOW_MS;
        if reset_window {
            if candidate.ambiguous_auth_strikes > 0 {
                candidate.backoff_level = 0;
            }
            candidate.ambiguous_auth_strikes = 0;
            candidate.ambiguous_auth_window_started_unix_ms = now;
        }
        if candidate.ambiguous_auth_strikes >= AMBIGUOUS_AUTH_MAX_SOFT_STRIKES {
            candidate.cooldown_until_unix_ms = TERMINAL_UNTIL_UNIX_MS;
            candidate.backoff_level = candidate.backoff_level.max(1);
            candidate.last_status = Some(StatusCode::UNAUTHORIZED.as_u16());
            candidate.terminal_status = Some(TerminalStatus::Expired);
            candidate.connection_generation = candidate.connection_generation.wrapping_add(1);
        } else {
            candidate.ambiguous_auth_strikes = candidate.ambiguous_auth_strikes.saturating_add(1);
            apply_connection_cooldown(
                &mut candidate,
                now,
                status,
                retry_hint_ms,
                self.cooldown_profile(),
            );
        }
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
        candidate.ambiguous_auth_strikes = 0;
        candidate.ambiguous_auth_window_started_unix_ms = 0;
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
        let (key, expected) = self.lock_key(permit, model, status);
        let model = key.as_str();
        let now = unix_ms()?;
        let mut inner = self.inner.lock().await;
        let current = inner.model_lockouts.get(model);
        if current.map(|lockout| lockout.generation) != expected
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

    /// The legacy opt-in model lockout of a combo target. A failure within the
    /// failure window after the previous lockout keeps escalating (legacy
    /// `modelFailureState`), counted on the lockout's backoff level.
    pub(crate) async fn record_policy_model_lockout(
        &self,
        permit: AvailabilityPermit,
        model: &str,
        status: StatusCode,
        policy: &ModelLockoutPolicy,
        retry_hint_ms: Option<u64>,
        failure_window_ms: u64,
    ) -> Result<(), &'static str> {
        validate_model(model)?;
        let (key, expected) = self.lock_key(permit, model, status);
        let model = key.as_str();
        let now = unix_ms()?;
        let profile = self.cooldown_profile();
        let mut inner = self.inner.lock().await;
        let current = inner.model_lockouts.get(model);
        if current.map(|lockout| lockout.generation) != expected
            || current.is_some_and(|lockout| lockout.until_unix_ms > now)
        {
            return Ok(());
        }
        if current.is_none() && inner.model_lockouts.len() >= MAX_MODEL_LOCKOUTS {
            return Err("provider model lockout capacity exceeded");
        }
        let failure_count = match current {
            Some(lockout) if now <= lockout.until_unix_ms.saturating_add(failure_window_ms) => {
                lockout.backoff_level.saturating_add(1)
            }
            _ => 1,
        }
        .min(MAX_BACKOFF_LEVEL);
        let duration = policy
            .cooldown_ms(
                failure_count,
                retry_hint_ms,
                true,
                profile.max_backoff_steps,
                profile.max_cooldown_ms,
            )
            .clamp(1_000, RETRY_HINT_MAX_MS);
        let generation = current.map_or(1, |lockout| lockout.generation.wrapping_add(1));
        let mut candidate = inner.clone();
        candidate.model_lockouts.insert(
            model.to_owned(),
            ModelLockout {
                until_unix_ms: now.saturating_add(duration),
                status: status.as_u16(),
                backoff_level: failure_count,
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
            candidate.ambiguous_auth_strikes = 0;
            candidate.ambiguous_auth_window_started_unix_ms = 0;
            candidate.connection_generation = candidate.connection_generation.wrapping_add(1);
            changed = true;
        }
        if candidate.model_lockouts.get(model).is_some_and(|lockout| {
            Some(lockout.generation) == permit.model_generation && lockout.until_unix_ms <= now
        }) {
            candidate.model_lockouts.remove(model);
            changed = true;
        }
        if let Some(family) = self.family_key(model) {
            if candidate
                .model_lockouts
                .get(&family)
                .is_some_and(|lockout| {
                    Some(lockout.generation) == permit.family_generation
                        && lockout.until_unix_ms <= now
                })
            {
                candidate.model_lockouts.remove(&family);
                changed = true;
            }
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
            ambiguous_auth_strikes: inner.ambiguous_auth_strikes,
            ambiguous_auth_retry_limit: AMBIGUOUS_AUTH_MAX_SOFT_STRIKES,
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
        inner.ambiguous_auth_strikes = 0;
        inner.ambiguous_auth_window_started_unix_ms = 0;
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
        let state = StoredAvailabilityState {
            version: 1,
            model_lockouts,
            ambiguous_auth_strikes: inner.ambiguous_auth_strikes,
            ambiguous_auth_window_started_unix_ms: inner.ambiguous_auth_window_started_unix_ms,
        };
        let record = StoredAvailability {
            provider_id: self.provider_id.to_string(),
            cooldown_until_unix_ms: to_i64(inner.cooldown_until_unix_ms)?,
            backoff_level: i64::from(inner.backoff_level),
            last_status: i64::from(inner.last_status.unwrap_or(0)),
            model_lockouts_json: serde_json::to_string(&state)
                .map_err(|_| "cannot encode provider availability state")?,
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
                || inner.ambiguous_auth_strikes > 0
                || !inner.model_lockouts.is_empty(),
            Ordering::Release,
        );
    }
}

fn apply_connection_cooldown(
    candidate: &mut Inner,
    now: u64,
    status: StatusCode,
    retry_hint_ms: Option<u64>,
    profile: ConnectionCooldownProfile,
) {
    let duration = connection_cooldown_duration(profile, candidate.backoff_level, retry_hint_ms);
    candidate.cooldown_until_unix_ms = now.saturating_add(duration);
    candidate.backoff_level = candidate
        .backoff_level
        .saturating_add(1)
        .min(MAX_BACKOFF_LEVEL);
    candidate.last_status = Some(status.as_u16());
    candidate.connection_generation = candidate.connection_generation.wrapping_add(1);
}

/// Legacy `capScaledCooldownMs` (#8396): an exponentially scaled cooldown is
/// bounded by the configured ceiling, else the fallback; it is never widened.
pub(crate) fn cap_scaled_cooldown_ms(
    cooldown_ms: u64,
    max_cooldown_ms: Option<u64>,
    fallback_max_ms: u64,
) -> u64 {
    cooldown_ms.min(
        max_cooldown_ms
            .filter(|cap| *cap > 0)
            .unwrap_or(fallback_max_ms),
    )
}

fn connection_cooldown_duration(
    profile: ConnectionCooldownProfile,
    backoff_level: u32,
    retry_hint_ms: Option<u64>,
) -> u64 {
    let exponent = backoff_level.min(profile.max_backoff_steps);
    let exponential = cap_scaled_cooldown_ms(
        profile.base_cooldown_ms.saturating_mul(1_u64 << exponent),
        Some(profile.max_cooldown_ms),
        DEFAULT_CONNECTION_MAX_COOLDOWN_MS,
    );
    let hinted = profile
        .use_upstream_retry_hints
        .then_some(retry_hint_ms)
        .flatten()
        .map(|hint| hint.clamp(1_000, RETRY_HINT_MAX_MS))
        .unwrap_or(0);
    hinted.max(exponential)
}

pub(crate) fn connection_failure_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 401 | 403 | 429)
}

pub(crate) fn model_failure_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 402 | 404 | 429)
}

const LOCK_FAMILY_EXACT: u8 = 0;
const LOCK_FAMILY_CODEX: u8 = 1;
const LOCK_FAMILY_ANTIGRAVITY: u8 = 2;

/// Legacy `getCodexModelScope`: Spark-scope models have their own quota.
fn codex_scope(model: &str) -> &'static str {
    let model = model.to_ascii_lowercase();
    if model.contains("spark") || model.contains("bengalfox") {
        "spark"
    } else {
        "codex"
    }
}

/// Legacy `getAntigravityQuotaFamily`: Gemini and Claude models share a
/// family quota; other models stay exact.
fn antigravity_family(model: &str) -> Option<&'static str> {
    let normalized = model.trim().to_ascii_lowercase();
    let normalized = normalized
        .strip_prefix("antigravity/")
        .or_else(|| normalized.strip_prefix("agy/"))
        .unwrap_or(&normalized);
    let bare = normalized
        .split_once('/')
        .map_or(normalized, |(_, rest)| rest);
    if bare.contains("gemini") {
        Some("gemini")
    } else if bare.starts_with("claude-")
        || bare.starts_with("cloud-")
        || bare.contains("/claude-")
        || bare.contains("/cloud-")
        || bare.contains("anthropic")
    {
        Some("claude")
    } else {
        None
    }
}

fn recordable_model_failure_status(status: StatusCode) -> bool {
    // 410 is a retired model's end-of-life answer.
    matches!(status.as_u16(), 400 | 401 | 402 | 403 | 404 | 410 | 429)
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
mod lockout_policy_tests {
    use super::*;

    // Ported from tests/unit/model-lockout-5xx-exact-scope.test.ts and the
    // Codex and Antigravity quota scope helpers.
    #[test]
    fn quota_failures_lock_the_model_family() {
        assert_eq!(codex_scope("gpt-5.5"), "codex");
        assert_eq!(codex_scope("gpt-5.3-codex-spark"), "spark");
        assert_eq!(antigravity_family("gemini-3-pro"), Some("gemini"));
        assert_eq!(
            antigravity_family("antigravity/claude-sonnet-4-5"),
            Some("claude")
        );
        assert_eq!(
            antigravity_family("google/gemini-2.5-flash"),
            Some("gemini")
        );
        assert_eq!(antigravity_family("gpt-oss-120b"), None);
    }

    // Ported from tests/unit/combo-model-lockout-honors-reset-1308.test.ts and
    // model-lockout-max-cooldown.test.ts: selectLockoutCooldownMs
    // and the recordModelLockoutFailure cooldown arithmetic.
    #[test]
    fn the_lockout_policy_scales_and_caps_its_cooldown() {
        let policy = ModelLockoutPolicy {
            enabled: true,
            ..ModelLockoutPolicy::default()
        };
        assert!(policy.applies(StatusCode::TOO_MANY_REQUESTS));
        assert!(policy.applies(StatusCode::BAD_GATEWAY));
        assert!(!policy.applies(StatusCode::INTERNAL_SERVER_ERROR));
        assert!(!ModelLockoutPolicy::default().applies(StatusCode::TOO_MANY_REQUESTS));
        let max = 1_800_000;
        // Exponential: base, doubled per repeated failure, up to the steps and cap.
        assert_eq!(policy.cooldown_ms(1, None, true, 5, max), 120_000);
        assert_eq!(policy.cooldown_ms(2, None, true, 5, max), 240_000);
        assert_eq!(policy.cooldown_ms(3, None, true, 1, max), 240_000);
        assert_eq!(policy.cooldown_ms(9, None, true, 8, max), max);
        // A longer authoritative hint wins over the cap; a short one does not count.
        assert_eq!(
            policy.cooldown_ms(1, Some(7_200_000), true, 5, max),
            7_200_000
        );
        assert_eq!(policy.cooldown_ms(1, Some(7_200_000), false, 5, max), max);
        assert_eq!(policy.cooldown_ms(1, Some(60_000), true, 5, max), 120_000);
        // Without exponential backoff the base is fixed and capped.
        let fixed = ModelLockoutPolicy {
            use_exponential_backoff: false,
            ..policy.clone()
        };
        assert_eq!(fixed.cooldown_ms(4, None, true, 5, max), 120_000);
        assert_eq!(fixed.cooldown_ms(4, None, true, 5, 60_000), 60_000);
        assert!(ModelLockoutPolicy {
            error_codes: vec![700],
            ..ModelLockoutPolicy::default()
        }
        .validate()
        .is_err());
        assert!(policy.validate().is_ok());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Backend;
    use tempfile::TempDir;
    use url::Url;

    // Ported from tests/unit/thundering-herd.test.ts and
    // tests/unit/error-classification.test.ts (#8396).
    #[test]
    fn scaled_cooldowns_are_capped_but_never_widened() {
        assert_eq!(
            cap_scaled_cooldown_ms(5_000 * (1 << 15), None, 120_000),
            120_000
        );
        assert_eq!(cap_scaled_cooldown_ms(5_000, Some(60_000), 120_000), 5_000);
        assert_eq!(
            cap_scaled_cooldown_ms(900_000, Some(60_000), 120_000),
            60_000
        );
        assert_eq!(cap_scaled_cooldown_ms(900_000, Some(0), 120_000), 120_000);
    }

    #[test]
    fn the_scaled_cooldown_reaches_the_legacy_ceiling() {
        // Legacy OAuth defaults back off to 5 s * 2^8 = 21m20s, under the
        // 30-minute ceiling; a configured ceiling caps it, a retry hint may
        // still exceed it.
        let mut oauth = ConnectionCooldownProfile::oauth_default();
        assert_eq!(connection_cooldown_duration(oauth, 8, None), 1_280_000);
        assert_eq!(connection_cooldown_duration(oauth, 16, None), 1_280_000);
        oauth.max_cooldown_ms = 60_000;
        assert_eq!(connection_cooldown_duration(oauth, 8, None), 60_000);
        let mut api_key = ConnectionCooldownProfile::api_key_default();
        api_key.max_cooldown_ms = 60_000;
        assert_eq!(
            connection_cooldown_duration(api_key, 5, Some(120_000)),
            120_000
        );
        assert!(!CONNECTION_MAX_COOLDOWN_RANGE.contains(&1_000));
    }

    #[test]
    fn connection_cooldown_profile_controls_hints_and_backoff() {
        let oauth = ConnectionCooldownProfile::oauth_default();
        assert_eq!(connection_cooldown_duration(oauth, 0, Some(60_000)), 5_000);
        assert_eq!(connection_cooldown_duration(oauth, 3, None), 40_000);

        let api_key = ConnectionCooldownProfile::api_key_default();
        assert_eq!(
            connection_cooldown_duration(api_key, 0, Some(60_000)),
            60_000
        );
        assert_eq!(connection_cooldown_duration(api_key, 10, None), 96_000);
    }

    // Ported from tests/unit/model-lockout-5xx-exact-scope.test.ts: a quota
    // failure locks the Codex scope, a missing model or a 5xx the exact model,
    // and a policy lockout on a 5xx survives a reload.
    #[tokio::test]
    async fn codex_quota_failures_lock_the_scope() {
        let directory = TempDir::new().unwrap();
        let file = Url::from_file_path(directory.path().join("family.sqlite")).unwrap();
        let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
        let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
        let availability = ProviderAvailability::new("codex-account", database.clone());
        availability.set_lock_family("codex");
        let permit = |decision| match decision {
            AvailabilityDecision::Permit(permit) => permit,
            AvailabilityDecision::Blocked { .. } => panic!("expected a permit"),
        };
        let blocked = |decision: AvailabilityDecision| {
            matches!(
                decision,
                AvailabilityDecision::Blocked {
                    model_scope: true,
                    ..
                }
            )
        };
        let first = permit(availability.try_acquire("gpt-5.5").await.unwrap());
        availability
            .record_model_failure(first, "gpt-5.5", StatusCode::TOO_MANY_REQUESTS, None)
            .await
            .unwrap();
        assert!(blocked(availability.try_acquire("gpt-5.5").await.unwrap()));
        assert!(blocked(
            availability.try_acquire("gpt-5.4-mini").await.unwrap()
        ));
        let spark = permit(
            availability
                .try_acquire("gpt-5.3-codex-spark")
                .await
                .unwrap(),
        );
        availability
            .record_model_failure(spark, "gpt-5.3-codex-spark", StatusCode::NOT_FOUND, None)
            .await
            .unwrap();
        assert!(blocked(
            availability
                .try_acquire("gpt-5.3-codex-spark")
                .await
                .unwrap()
        ));
        assert!(!blocked(
            availability
                .try_acquire("gpt-5.3-codex-spark-mini")
                .await
                .unwrap()
        ));
        let models: Vec<_> = availability
            .status()
            .await
            .unwrap()
            .model_lockouts
            .into_iter()
            .map(|lockout| lockout.model)
            .collect();
        assert_eq!(models, ["gpt-5.3-codex-spark", "scope:codex"]);

        // A policy lockout on a 5xx persists and reloads.
        let exact = ProviderAvailability::new("exact-account", database.clone());
        let policy = ModelLockoutPolicy {
            enabled: true,
            ..ModelLockoutPolicy::default()
        };
        let granted = permit(exact.try_acquire("model-a").await.unwrap());
        exact
            .record_policy_model_lockout(
                granted,
                "model-a",
                StatusCode::SERVICE_UNAVAILABLE,
                &policy,
                None,
                30_000,
            )
            .await
            .unwrap();
        let stored = database
            .provider_availability()
            .await
            .unwrap()
            .into_iter()
            .find(|record| record.provider_id == "exact-account")
            .unwrap();
        let restored = ProviderAvailability::from_stored(&stored, database.clone()).unwrap();
        let status = restored.status().await.unwrap();
        assert_eq!(status.model_lockouts[0].status, 503);
        assert!(status.model_lockouts[0].retry_after_ms > 100_000);
        database.close().await.unwrap();
    }

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

    #[tokio::test]
    async fn ambiguous_auth_strikes_are_bounded_concurrent_and_durable() {
        let directory = TempDir::new().unwrap();
        let file = Url::from_file_path(directory.path().join("ambiguous-auth.sqlite")).unwrap();
        let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
        let database = Arc::new(Database::connect(Backend::Sqlite, &url).await.unwrap());
        let legacy = StoredAvailability {
            provider_id: "legacy".into(),
            cooldown_until_unix_ms: 0,
            backoff_level: 0,
            last_status: 0,
            model_lockouts_json: "[]".into(),
            revision: 1,
        };
        let legacy = ProviderAvailability::from_stored(&legacy, database.clone()).unwrap();
        assert_eq!(legacy.status().await.unwrap().ambiguous_auth_strikes, 0);
        let mut availability = ProviderAvailability::new("mistral", database.clone());

        for expected_strikes in 1..=AMBIGUOUS_AUTH_MAX_SOFT_STRIKES {
            let AvailabilityDecision::Permit(permit) =
                availability.try_acquire("mistral-large").await.unwrap()
            else {
                panic!("expired cooldown must permit the next bounded probe");
            };
            if expected_strikes == 1 {
                let (one, two, three) = tokio::join!(
                    availability.record_ambiguous_auth_failure(
                        permit,
                        StatusCode::UNAUTHORIZED,
                        None
                    ),
                    availability.record_ambiguous_auth_failure(
                        permit,
                        StatusCode::UNAUTHORIZED,
                        None
                    ),
                    availability.record_ambiguous_auth_failure(
                        permit,
                        StatusCode::UNAUTHORIZED,
                        None
                    )
                );
                assert!(one.is_ok() && two.is_ok() && three.is_ok());
            } else {
                availability
                    .record_ambiguous_auth_failure(permit, StatusCode::UNAUTHORIZED, None)
                    .await
                    .unwrap();
            }
            let status = availability.status().await.unwrap();
            assert_eq!(status.ambiguous_auth_strikes, expected_strikes);
            assert_eq!(
                status.ambiguous_auth_retry_limit,
                AMBIGUOUS_AUTH_MAX_SOFT_STRIKES
            );
            assert_eq!(status.terminal_status, None);

            let mut stored = database.provider_availability().await.unwrap().remove(0);
            stored.cooldown_until_unix_ms = 1;
            availability = ProviderAvailability::from_stored(&stored, database.clone()).unwrap();
        }

        let AvailabilityDecision::Permit(permit) =
            availability.try_acquire("mistral-large").await.unwrap()
        else {
            panic!("the terminal probe must be admitted after its last cooldown");
        };
        availability
            .record_ambiguous_auth_failure(permit, StatusCode::UNAUTHORIZED, None)
            .await
            .unwrap();
        let status = availability.status().await.unwrap();
        assert_eq!(status.ambiguous_auth_strikes, 3);
        assert_eq!(status.terminal_status, Some(TerminalStatus::Expired));

        let records = database.provider_availability().await.unwrap();
        let restored = ProviderAvailability::from_stored(&records[0], database.clone()).unwrap();
        assert!(matches!(
            restored.try_acquire("mistral-large").await.unwrap(),
            AvailabilityDecision::Blocked {
                terminal_status: Some(TerminalStatus::Expired),
                model_scope: false,
                ..
            }
        ));
        restored.reset().await.unwrap();
        let status = restored.status().await.unwrap();
        assert_eq!(status.ambiguous_auth_strikes, 0);
        assert_eq!(status.terminal_status, None);
        database.close().await.unwrap();
    }
}
