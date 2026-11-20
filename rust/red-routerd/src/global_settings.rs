//! Global gateway settings stored as JSON values (`global_settings_storage`).
//! Only the keys listed here are accepted; each has a typed value and a
//! default. Each control plane keeps a validated snapshot for the request
//! path, as the legacy router reads its cached settings.
//!
//! - `custom_system_prompt`: the legacy `customSystemPromptEnabled` and
//!   `customSystemPrompt`, injected into chat-like requests
//!   (`injectCustomSystemPrompt`, open-sse/services/systemPrompt.ts).
//! - `max_body_size_mb`: the legacy `maxBodySizeMb` (1-500 MiB), the
//!   configured client request body limit (`body_limits`).
//! - `idempotency_window_ms`: the legacy `idempotencyWindowMs`, the chat
//!   replay window (`idempotency`).
//! - `provider_strategies`: the legacy `fallbackStrategy`,
//!   `stickyRoundRobinLimit` and `providerStrategies`, the account selection
//!   inside a provider pool (`account_rotation`).
//! - `connection_max_cooldown_ms`: the legacy `modelLockout.maxCooldownMs`,
//!   the ceiling on scaled connection cooldowns (default 30 minutes).
//! - `cache_control_mode`: the legacy `alwaysPreserveClientCache` (auto,
//!   always, never).
//! - `claude_fast_mode`: the legacy `claudeFastMode`, which asks a paired
//!   CLIProxyAPI to route supported `claude` models to Anthropic Fast Mode.
//! - `wait_for_cooldown`: the legacy `waitForCooldown` resilience section
//!   (or its `requestRetry` and `maxRetryIntervalSec` fallback), the wait
//!   for a short cooldown on direct provider routes (`cooldown_retry`).
//! - `combo_cooldown_wait`: the legacy `comboCooldownWait` resilience
//!   section, the wait for a short rate-limit lockout or open circuit
//!   before a combo answers with its failure.
//! - `provider_cooldown`: the legacy opt-in `providerCooldown` section, the
//!   growing cooldown a failed combo target's connection gets
//!   (`provider_cooldown`).
//! - `combo_sticky_round_robin_limit`: the legacy `comboStickyRoundRobinLimit`,
//!   the batch a round-robin combo sends to one target before rotating
//!   (unset, the provider pools' `stickyRoundRobinLimit`).
//! - `prompt_cache_affinity`: the legacy `promptCacheAffinityEnabled` (on by
//!   default), the prompt-cache ranking of combo targets.
//! - `session_stickiness`: the negation of the legacy `disableSessionStickiness`,
//!   which sends a combo conversation back to the connection that served it.
//! - `request_queue`: the legacy `requestQueue` resilience section, the
//!   per-connection limiter of API-key accounts (`request_queue`).
//! - `request_queue_connections`: the legacy per-connection
//!   `rateLimitProtection` and `rateLimitOverrides`, by provider id.
//! - `provider_quota_overrides`: the legacy `providerQuotaOverrides`
//!   resilience section, by provider name.
//! - `codex_service_tier`: the legacy `codexServiceTier` (or
//!   `codexFastServiceTier`), the service tier Codex requests get.
//! - `antigravity_signature_cache_mode`: the legacy
//!   `antigravitySignatureCacheMode` (enabled, bypass, bypass-strict).
//! - `claude_classifier_compat`: the legacy `claudeClassifierCompat` (off,
//!   auto, always).
//! - `credential_redaction`: the legacy `credentialRedactionEnabled`, the
//!   credential masker guardrail (`credential_masker`).
//! - `combo_auto_promote`: the legacy `comboAutoPromoteEnabled`, which moves
//!   a combo's successful target to the front of the stored combo.
//! - `model_lockout_policy`: the legacy opt-in `modelLockout` policy
//!   (enabled, error codes, base cooldown, exponential backoff).
//! - `responses_previous_response_id_mode`: the legacy
//!   `responsesPreviousResponseIdMode` (auto, strip, preserve).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub(crate) const CUSTOM_SYSTEM_PROMPT: &str = "custom_system_prompt";
pub(crate) const MAX_BODY_SIZE_MB: &str = "max_body_size_mb";
pub(crate) const IDEMPOTENCY_WINDOW_MS: &str = "idempotency_window_ms";
pub(crate) const PROVIDER_STRATEGIES: &str = "provider_strategies";
pub(crate) const CONNECTION_MAX_COOLDOWN_MS: &str = "connection_max_cooldown_ms";
pub(crate) const CACHE_CONTROL_MODE: &str = "cache_control_mode";
pub(crate) const CLAUDE_FAST_MODE: &str = "claude_fast_mode";
pub(crate) const WAIT_FOR_COOLDOWN: &str = "wait_for_cooldown";
pub(crate) const COMBO_COOLDOWN_WAIT: &str = "combo_cooldown_wait";
pub(crate) const PROVIDER_COOLDOWN: &str = "provider_cooldown";
pub(crate) const COMBO_STICKY_ROUND_ROBIN_LIMIT: &str = "combo_sticky_round_robin_limit";
pub(crate) const PROMPT_CACHE_AFFINITY: &str = "prompt_cache_affinity";
pub(crate) const SESSION_STICKINESS: &str = "session_stickiness";
pub(crate) const REQUEST_QUEUE: &str = "request_queue";
pub(crate) const REQUEST_QUEUE_CONNECTIONS: &str = "request_queue_connections";
pub(crate) const PROVIDER_QUOTA_OVERRIDES: &str = "provider_quota_overrides";
pub(crate) const CODEX_SERVICE_TIER: &str = "codex_service_tier";
pub(crate) const MODEL_LOCKOUT_POLICY: &str = "model_lockout_policy";
pub(crate) const COMBO_AUTO_PROMOTE: &str = "combo_auto_promote";
pub(crate) const CREDENTIAL_REDACTION: &str = "credential_redaction";
pub(crate) const CLAUDE_CLASSIFIER_COMPAT: &str = "claude_classifier_compat";
pub(crate) const ANTIGRAVITY_SIGNATURE_CACHE_MODE: &str = "antigravity_signature_cache_mode";
pub(crate) const RESPONSES_PREVIOUS_RESPONSE_ID_MODE: &str = "responses_previous_response_id_mode";
const MAX_QUEUE_POLICIES: usize = 10_000;
/// Legacy `clampStickyRoundRobinTargetLimit` ceiling.
const MAX_COMBO_STICKY_LIMIT: u64 = 1_000;
/// Legacy `CLAUDE_FAST_MODE_DEFAULT_MODELS`.
pub(crate) const CLAUDE_FAST_MODE_DEFAULT_MODELS: &[&str] = &[
    "claude-fable-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
];
/// Legacy `MIN_REQUEST_BODY_LIMIT_MB` and `MAX_REQUEST_BODY_LIMIT_MB`.
pub(crate) const BODY_SIZE_MB_RANGE: std::ops::RangeInclusive<u64> = 1..=500;
/// The longest replay window accepted (a year).
const MAX_IDEMPOTENCY_WINDOW_MS: u64 = 365 * 24 * 60 * 60 * 1_000;
const MAX_PROMPT_LEN: usize = 100_000;

/// One account selection choice; unset fields inherit (legacy
/// `providerOverride.x || settings.x`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StrategyChoice {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strategy: Option<crate::account_rotation::AccountStrategy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sticky_round_robin_limit: Option<u32>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderStrategies {
    #[serde(default)]
    pub default: StrategyChoice,
    #[serde(default)]
    pub providers: BTreeMap<String, StrategyChoice>,
}

impl ProviderStrategies {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        let limit_ok = |choice: &StrategyChoice| {
            choice
                .sticky_round_robin_limit
                .is_none_or(|limit| limit <= 10_000)
        };
        if !limit_ok(&self.default)
            || self.providers.len() > 1_000
            || self.providers.iter().any(|(provider, choice)| {
                provider.is_empty() || provider.len() > 128 || !limit_ok(choice)
            })
        {
            return Err("invalid provider strategies");
        }
        Ok(())
    }

    /// The strategy and sticky limit for one provider's pool.
    pub(crate) fn for_provider(
        &self,
        provider: &str,
    ) -> (crate::account_rotation::AccountStrategy, u32) {
        let own = self.providers.get(provider);
        let strategy = own
            .and_then(|choice| choice.strategy)
            .or(self.default.strategy)
            .unwrap_or_default();
        let limit = own
            .and_then(|choice| choice.sticky_round_robin_limit)
            .or(self.default.sticky_round_robin_limit)
            .unwrap_or(crate::account_rotation::DEFAULT_STICKY_LIMIT);
        (strategy, limit)
    }
}

/// Legacy `claudeFastMode`: off by default; an empty model list means the
/// default supported models.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaudeFastMode {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub supported_models: Vec<String>,
}

impl ClaudeFastMode {
    /// Legacy `shouldRequestClaudeFastMode`: enabled and the model equals a
    /// supported id or extends it with a dated suffix.
    pub(crate) fn applies_to(&self, model: &str) -> bool {
        let matches = |supported: &str| {
            model == supported
                || model
                    .strip_prefix(supported)
                    .is_some_and(|rest| rest.starts_with('-'))
        };
        self.enabled
            && !model.is_empty()
            && if self.supported_models.is_empty() {
                CLAUDE_FAST_MODE_DEFAULT_MODELS.iter().any(|m| matches(m))
            } else {
                self.supported_models.iter().any(|m| matches(m))
            }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomSystemPrompt {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub prompt: String,
}

impl CustomSystemPrompt {
    fn validate(&self) -> Result<(), &'static str> {
        if self.prompt.len() > MAX_PROMPT_LEN || self.prompt.contains('\0') {
            return Err("invalid custom system prompt");
        }
        Ok(())
    }
}

/// The validated settings a control plane serves from.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Snapshot {
    custom_system_prompt: CustomSystemPrompt,
    max_body_size_mb: Option<u64>,
    idempotency_window_ms: Option<u64>,
    provider_strategies: ProviderStrategies,
    connection_max_cooldown_ms: Option<u64>,
    cache_control_mode: crate::openai_content::CacheControlMode,
    claude_fast_mode: ClaudeFastMode,
    codex_service_tier: crate::codex_request::CodexServiceTier,
    model_lockout_policy: crate::availability::ModelLockoutPolicy,
    combo_auto_promote: bool,
    credential_redaction: bool,
    claude_classifier_compat: crate::claude_classifier_compat::ClaudeClassifierCompatMode,
    signature_cache_mode: crate::antigravity_translation::SignatureCacheMode,
    previous_response_id_mode: crate::responses_state::PreviousResponseIdMode,
    wait_for_cooldown: crate::cooldown_retry::WaitForCooldown,
    combo_cooldown_wait: crate::cooldown_retry::ComboCooldownWait,
    provider_cooldown: crate::provider_cooldown::ProviderCooldown,
    combo_sticky_round_robin_limit: Option<u32>,
    prompt_cache_affinity_disabled: bool,
    session_stickiness_disabled: bool,
    request_queue: crate::request_queue::RequestQueue,
    request_queue_connections: BTreeMap<String, crate::request_queue::ConnectionQueuePolicy>,
    provider_quota_overrides: BTreeMap<String, crate::request_queue::ProviderQuotaOverride>,
}

impl Snapshot {
    /// The prompt to inject, when enabled and non-empty.
    pub(crate) fn custom_system_prompt(&self) -> Option<&str> {
        let prompt = &self.custom_system_prompt;
        (prompt.enabled && !prompt.prompt.is_empty()).then_some(prompt.prompt.as_str())
    }

    /// The configured client request body limit, when set.
    pub(crate) fn max_body_size_bytes(&self) -> Option<usize> {
        self.max_body_size_mb
            .and_then(|mb| usize::try_from(mb.saturating_mul(1024 * 1024)).ok())
    }

    /// The account selection strategy and sticky limit for a provider.
    pub(crate) fn provider_strategy(
        &self,
        provider: &str,
    ) -> (crate::account_rotation::AccountStrategy, u32) {
        self.provider_strategies.for_provider(provider)
    }

    /// The cooldown wait policy for direct provider routes.
    pub(crate) fn wait_for_cooldown(&self) -> crate::cooldown_retry::WaitForCooldown {
        self.wait_for_cooldown
    }

    /// The cooldown wait policy for combos.
    pub(crate) fn combo_cooldown_wait(&self) -> crate::cooldown_retry::ComboCooldownWait {
        self.combo_cooldown_wait
    }

    /// Legacy `resolveComboStickyRoundRobinLimit` without a per-combo value:
    /// `comboStickyRoundRobinLimit`, else `stickyRoundRobinLimit`, clamped.
    pub(crate) fn combo_sticky_limit(&self) -> u32 {
        self.combo_sticky_round_robin_limit
            .or(self.provider_strategies.default.sticky_round_robin_limit)
            .unwrap_or(crate::account_rotation::DEFAULT_STICKY_LIMIT)
            .clamp(1, 1_000)
    }

    /// The gates a request to this connection and provider passes.
    pub(crate) fn request_admission(
        &self,
        provider_id: Option<&str>,
        provider: Option<&str>,
        api_key: bool,
    ) -> crate::request_queue::AdmissionPlan {
        let provider_override = provider
            .and_then(|provider| self.provider_quota_overrides.get(provider))
            .copied()
            .unwrap_or_default();
        let queue = provider_id.and_then(|id| {
            crate::request_queue::effective(
                &self.request_queue,
                self.request_queue_connections.get(id),
                api_key,
            )
        });
        let mut plan = crate::request_queue::AdmissionPlan::new(
            &self.request_queue,
            provider,
            provider_override,
            queue,
        );
        plan.queue_rpm_overridden = provider_id
            .and_then(|id| self.request_queue_connections.get(id))
            .is_some_and(|policy| policy.requests_per_minute.is_some());
        plan
    }

    /// Whether combos send a conversation back to its connection.
    pub(crate) fn session_stickiness(&self) -> bool {
        !self.session_stickiness_disabled
    }

    /// Whether combos rank their targets by prompt-cache affinity.
    pub(crate) fn prompt_cache_affinity(&self) -> bool {
        !self.prompt_cache_affinity_disabled
    }

    /// The combo provider cooldown policy.
    pub(crate) fn provider_cooldown(&self) -> crate::provider_cooldown::ProviderCooldown {
        self.provider_cooldown
    }

    /// The Claude Fast Mode request policy.
    pub(crate) fn claude_fast_mode(&self) -> &ClaudeFastMode {
        &self.claude_fast_mode
    }

    /// The Responses `previous_response_id` policy.
    pub(crate) fn previous_response_id_mode(
        &self,
    ) -> crate::responses_state::PreviousResponseIdMode {
        self.previous_response_id_mode
    }

    /// The Antigravity thought signature policy.
    pub(crate) fn signature_cache_mode(
        &self,
    ) -> crate::antigravity_translation::SignatureCacheMode {
        self.signature_cache_mode
    }

    /// The Claude Code classifier compat mode.
    pub(crate) fn claude_classifier_compat(
        &self,
    ) -> crate::claude_classifier_compat::ClaudeClassifierCompatMode {
        self.claude_classifier_compat
    }

    /// Whether the credential masker guardrail is on.
    pub(crate) fn credential_redaction(&self) -> bool {
        self.credential_redaction
    }

    /// Whether a combo's successful target moves to the front (legacy
    /// `comboAutoPromoteEnabled`).
    pub(crate) fn combo_auto_promote(&self) -> bool {
        self.combo_auto_promote
    }

    /// The opt-in combo model lockout policy.
    pub(crate) fn model_lockout_policy(&self) -> &crate::availability::ModelLockoutPolicy {
        &self.model_lockout_policy
    }

    /// The Codex service tier policy.
    pub(crate) fn codex_service_tier(&self) -> &crate::codex_request::CodexServiceTier {
        &self.codex_service_tier
    }

    /// The client cache-marker policy.
    pub(crate) fn cache_control_mode(&self) -> crate::openai_content::CacheControlMode {
        self.cache_control_mode
    }

    /// The ceiling on scaled connection cooldowns.
    pub(crate) fn connection_max_cooldown_ms(&self) -> u64 {
        self.connection_max_cooldown_ms
            .unwrap_or(crate::availability::DEFAULT_CONNECTION_MAX_COOLDOWN_MS)
    }

    /// The idempotent replay window (legacy default 5 s).
    pub(crate) fn idempotency_window_ms(&self) -> u64 {
        self.idempotency_window_ms
            .unwrap_or(crate::idempotency::WINDOW_MS)
    }
}

/// Validate one setting value, returning its normalized JSON.
pub(crate) fn validate(key: &str, value: Value) -> Result<Value, &'static str> {
    match key {
        CUSTOM_SYSTEM_PROMPT => {
            let prompt: CustomSystemPrompt =
                serde_json::from_value(value).map_err(|_| "invalid custom system prompt")?;
            prompt.validate()?;
            serde_json::to_value(prompt).map_err(|_| "invalid custom system prompt")
        }
        MAX_BODY_SIZE_MB => value
            .as_u64()
            .filter(|mb| BODY_SIZE_MB_RANGE.contains(mb))
            .map(Value::from)
            .ok_or("invalid request body limit"),
        IDEMPOTENCY_WINDOW_MS => value
            .as_u64()
            .filter(|ms| (1..=MAX_IDEMPOTENCY_WINDOW_MS).contains(ms))
            .map(Value::from)
            .ok_or("invalid idempotency window"),
        WAIT_FOR_COOLDOWN => {
            serde_json::from_value::<crate::cooldown_retry::WaitForCooldown>(value)
                .ok()
                .filter(crate::cooldown_retry::WaitForCooldown::valid)
                .and_then(|wait| serde_json::to_value(wait).ok())
                .ok_or("invalid cooldown wait")
        }
        COMBO_COOLDOWN_WAIT => {
            serde_json::from_value::<crate::cooldown_retry::ComboCooldownWait>(value)
                .ok()
                .filter(crate::cooldown_retry::ComboCooldownWait::valid)
                .and_then(|wait| serde_json::to_value(wait).ok())
                .ok_or("invalid combo cooldown wait")
        }
        PROVIDER_COOLDOWN => {
            serde_json::from_value::<crate::provider_cooldown::ProviderCooldown>(value)
                .ok()
                .filter(crate::provider_cooldown::ProviderCooldown::valid)
                .and_then(|cooldown| serde_json::to_value(cooldown).ok())
                .ok_or("invalid provider cooldown")
        }
        COMBO_STICKY_ROUND_ROBIN_LIMIT => value
            .as_u64()
            .filter(|limit| (1..=MAX_COMBO_STICKY_LIMIT).contains(limit))
            .map(Value::from)
            .ok_or("invalid combo sticky round-robin limit"),
        PROVIDER_QUOTA_OVERRIDES => serde_json::from_value::<
            BTreeMap<String, crate::request_queue::ProviderQuotaOverride>,
        >(value)
        .ok()
        .filter(|overrides| {
            overrides.len() <= MAX_QUEUE_POLICIES
                && overrides
                    .iter()
                    .all(|(provider, entry)| (1..=128).contains(&provider.len()) && entry.valid())
        })
        .and_then(|overrides| serde_json::to_value(overrides).ok())
        .ok_or("invalid provider quota overrides"),
        REQUEST_QUEUE_CONNECTIONS => serde_json::from_value::<
            BTreeMap<String, crate::request_queue::ConnectionQueuePolicy>,
        >(value)
        .ok()
        .filter(|policies| {
            policies.len() <= MAX_QUEUE_POLICIES
                && policies.iter().all(|(id, policy)| {
                    (1..=128).contains(&id.len())
                        && id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                        && policy.valid()
                })
        })
        .and_then(|policies| serde_json::to_value(policies).ok())
        .ok_or("invalid connection request queue policies"),
        REQUEST_QUEUE => serde_json::from_value::<crate::request_queue::RequestQueue>(value)
            .ok()
            .filter(crate::request_queue::RequestQueue::valid)
            .and_then(|queue| serde_json::to_value(queue).ok())
            .ok_or("invalid request queue"),
        SESSION_STICKINESS => value
            .is_boolean()
            .then_some(value)
            .ok_or("invalid session stickiness"),
        PROMPT_CACHE_AFFINITY => value
            .is_boolean()
            .then_some(value)
            .ok_or("invalid prompt cache affinity"),
        COMBO_AUTO_PROMOTE => value
            .is_boolean()
            .then_some(value)
            .ok_or("invalid combo auto promote"),
        CLAUDE_CLASSIFIER_COMPAT => serde_json::from_value::<
            crate::claude_classifier_compat::ClaudeClassifierCompatMode,
        >(value)
        .map_err(|_| "invalid Claude classifier compat mode")
        .and_then(|mode| {
            serde_json::to_value(mode).map_err(|_| "invalid Claude classifier compat mode")
        }),
        CREDENTIAL_REDACTION => value
            .is_boolean()
            .then_some(value)
            .ok_or("invalid credential redaction"),
        CLAUDE_FAST_MODE => {
            let mode: ClaudeFastMode =
                serde_json::from_value(value).map_err(|_| "invalid Claude fast mode")?;
            if mode.supported_models.len() > 100
                || mode
                    .supported_models
                    .iter()
                    .any(|model| model.trim().is_empty() || model.len() > 256)
            {
                return Err("invalid Claude fast mode");
            }
            serde_json::to_value(mode).map_err(|_| "invalid Claude fast mode")
        }
        RESPONSES_PREVIOUS_RESPONSE_ID_MODE => {
            serde_json::from_value::<crate::responses_state::PreviousResponseIdMode>(value)
                .map_err(|_| "invalid previous response id mode")
                .and_then(|mode| {
                    serde_json::to_value(mode).map_err(|_| "invalid previous response id mode")
                })
        }
        ANTIGRAVITY_SIGNATURE_CACHE_MODE => serde_json::from_value::<
            crate::antigravity_translation::SignatureCacheMode,
        >(value)
        .map_err(|_| "invalid signature cache mode")
        .and_then(|mode| serde_json::to_value(mode).map_err(|_| "invalid signature cache mode")),
        MODEL_LOCKOUT_POLICY => {
            let policy: crate::availability::ModelLockoutPolicy =
                serde_json::from_value(value).map_err(|_| "invalid model lockout policy")?;
            policy.validate()?;
            serde_json::to_value(policy).map_err(|_| "invalid model lockout policy")
        }
        CODEX_SERVICE_TIER => {
            let tier: crate::codex_request::CodexServiceTier =
                serde_json::from_value(value).map_err(|_| "invalid Codex service tier")?;
            tier.validate()?;
            serde_json::to_value(tier).map_err(|_| "invalid Codex service tier")
        }
        CACHE_CONTROL_MODE => {
            serde_json::from_value::<crate::openai_content::CacheControlMode>(value)
                .map_err(|_| "invalid cache control mode")
                .and_then(|mode| {
                    serde_json::to_value(mode).map_err(|_| "invalid cache control mode")
                })
        }
        CONNECTION_MAX_COOLDOWN_MS => value
            .as_u64()
            .filter(|ms| crate::availability::CONNECTION_MAX_COOLDOWN_RANGE.contains(ms))
            .map(Value::from)
            .ok_or("invalid connection cooldown ceiling"),
        PROVIDER_STRATEGIES => {
            let strategies: ProviderStrategies =
                serde_json::from_value(value).map_err(|_| "invalid provider strategies")?;
            strategies.validate()?;
            serde_json::to_value(strategies).map_err(|_| "invalid provider strategies")
        }
        _ => Err("unknown global setting"),
    }
}

/// Validate the stored settings into a snapshot. Unknown stored keys fail
/// closed.
pub(crate) fn snapshot(stored: &BTreeMap<String, Value>) -> Result<Snapshot, &'static str> {
    let mut snapshot = Snapshot::default();
    for (key, value) in stored {
        let value = validate(key, value.clone())?;
        match key.as_str() {
            CUSTOM_SYSTEM_PROMPT => {
                snapshot.custom_system_prompt =
                    serde_json::from_value(value).map_err(|_| "invalid custom system prompt")?;
            }
            MAX_BODY_SIZE_MB => snapshot.max_body_size_mb = value.as_u64(),
            IDEMPOTENCY_WINDOW_MS => snapshot.idempotency_window_ms = value.as_u64(),
            CONNECTION_MAX_COOLDOWN_MS => snapshot.connection_max_cooldown_ms = value.as_u64(),
            WAIT_FOR_COOLDOWN => {
                snapshot.wait_for_cooldown =
                    serde_json::from_value(value).map_err(|_| "invalid cooldown wait")?;
            }
            COMBO_COOLDOWN_WAIT => {
                snapshot.combo_cooldown_wait =
                    serde_json::from_value(value).map_err(|_| "invalid combo cooldown wait")?;
            }
            PROVIDER_COOLDOWN => {
                snapshot.provider_cooldown =
                    serde_json::from_value(value).map_err(|_| "invalid provider cooldown")?;
            }
            COMBO_STICKY_ROUND_ROBIN_LIMIT => {
                snapshot.combo_sticky_round_robin_limit =
                    value.as_u64().and_then(|limit| u32::try_from(limit).ok());
            }
            PROVIDER_QUOTA_OVERRIDES => {
                snapshot.provider_quota_overrides = serde_json::from_value(value)
                    .map_err(|_| "invalid provider quota overrides")?;
            }
            REQUEST_QUEUE_CONNECTIONS => {
                snapshot.request_queue_connections = serde_json::from_value(value)
                    .map_err(|_| "invalid connection request queue policies")?;
            }
            REQUEST_QUEUE => {
                snapshot.request_queue =
                    serde_json::from_value(value).map_err(|_| "invalid request queue")?;
            }
            SESSION_STICKINESS => {
                snapshot.session_stickiness_disabled = value == Value::Bool(false);
            }
            CLAUDE_CLASSIFIER_COMPAT => {
                snapshot.claude_classifier_compat = serde_json::from_value(value)
                    .map_err(|_| "invalid Claude classifier compat mode")?;
            }
            CREDENTIAL_REDACTION => {
                snapshot.credential_redaction = value == Value::Bool(true);
            }
            COMBO_AUTO_PROMOTE => {
                snapshot.combo_auto_promote = value == Value::Bool(true);
            }
            PROMPT_CACHE_AFFINITY => {
                snapshot.prompt_cache_affinity_disabled = value == Value::Bool(false);
            }
            CLAUDE_FAST_MODE => {
                snapshot.claude_fast_mode =
                    serde_json::from_value(value).map_err(|_| "invalid Claude fast mode")?;
            }
            RESPONSES_PREVIOUS_RESPONSE_ID_MODE => {
                snapshot.previous_response_id_mode = serde_json::from_value(value)
                    .map_err(|_| "invalid previous response id mode")?;
            }
            ANTIGRAVITY_SIGNATURE_CACHE_MODE => {
                snapshot.signature_cache_mode =
                    serde_json::from_value(value).map_err(|_| "invalid signature cache mode")?;
            }
            MODEL_LOCKOUT_POLICY => {
                snapshot.model_lockout_policy =
                    serde_json::from_value(value).map_err(|_| "invalid model lockout policy")?;
            }
            CODEX_SERVICE_TIER => {
                snapshot.codex_service_tier =
                    serde_json::from_value(value).map_err(|_| "invalid Codex service tier")?;
            }
            CACHE_CONTROL_MODE => {
                snapshot.cache_control_mode =
                    serde_json::from_value(value).map_err(|_| "invalid cache control mode")?;
            }
            PROVIDER_STRATEGIES => {
                snapshot.provider_strategies =
                    serde_json::from_value(value).map_err(|_| "invalid provider strategies")?;
            }
            _ => {}
        }
    }
    Ok(snapshot)
}

/// JavaScript string concatenation of a message's prior content.
fn js_text(value: &Value) -> Option<String> {
    match value {
        Value::Null | Value::Bool(false) => None,
        Value::String(text) if text.is_empty() => None,
        Value::String(text) => Some(text.clone()),
        Value::Number(number) if number.as_f64() == Some(0.0) => None,
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(true) => Some("true".to_owned()),
        Value::Object(_) => Some("[object Object]".to_owned()),
        Value::Array(_) => None,
    }
}

/// Legacy `injectCustomSystemPrompt`: append to the first system/developer
/// message (a text part for array content), else prepend a system message,
/// except for Anthropic-shaped bodies, which take it in the top-level
/// `system` field.
pub(crate) fn inject_custom_system_prompt(body: &mut Value, prompt: &str) {
    let Some(request) = body.as_object_mut() else {
        return;
    };
    if prompt.is_empty() || request.contains_key("_skipSystemPrompt") {
        return;
    }
    let has_system = request.contains_key("system");
    if let Some(Value::Array(messages)) = request.get_mut("messages") {
        let index = messages.iter().position(|message| {
            matches!(
                message.get("role").and_then(Value::as_str),
                Some("system" | "developer")
            )
        });
        match index {
            Some(index) => {
                if let Some(message) = messages[index].as_object_mut() {
                    match message.get_mut("content") {
                        Some(Value::Array(parts)) => {
                            parts.push(serde_json::json!({"type":"text","text":prompt}));
                        }
                        content => {
                            let prior = content.as_deref().and_then(js_text);
                            message.insert(
                                "content".to_owned(),
                                Value::String(match prior {
                                    Some(prior) => format!("{prior}\n\n{prompt}"),
                                    None => prompt.to_owned(),
                                }),
                            );
                        }
                    }
                }
            }
            None if !has_system => {
                messages.insert(0, serde_json::json!({"role":"system","content":prompt}));
            }
            None => {}
        }
    }
    if let Some(system) = request.get_mut("system") {
        match system {
            Value::String(text) if !text.is_empty() => {
                *system = Value::String(format!("{text}\n\n{prompt}"));
            }
            Value::Array(parts) => {
                parts.push(serde_json::json!({"type":"text","text":prompt}));
            }
            // A malformed or empty `system` must not swallow the prompt.
            _ => *system = Value::String(prompt.to_owned()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_prompt_is_injected_like_the_legacy_helper() {
        let mut body = json!({"messages":[{"role":"user","content":"hi"}]});
        inject_custom_system_prompt(&mut body, "P");
        assert_eq!(body["messages"][0], json!({"role":"system","content":"P"}));

        let mut body =
            json!({"messages":[{"role":"user","content":"hi"},{"role":"developer","content":"D"}]});
        inject_custom_system_prompt(&mut body, "P");
        assert_eq!(body["messages"][1]["content"], "D\n\nP");
        assert_eq!(body["messages"].as_array().unwrap().len(), 2);

        let mut body =
            json!({"messages":[{"role":"system","content":[{"type":"text","text":"S"}]}]});
        inject_custom_system_prompt(&mut body, "P");
        assert_eq!(
            body["messages"][0]["content"][1],
            json!({"type":"text","text":"P"})
        );

        // Anthropic-shaped bodies use the top-level system field only.
        let mut body = json!({"system":"S","messages":[{"role":"user","content":"hi"}]});
        inject_custom_system_prompt(&mut body, "P");
        assert_eq!(body["system"], "S\n\nP");
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        let mut body = json!({"system":null,"messages":[]});
        inject_custom_system_prompt(&mut body, "P");
        assert_eq!(body["system"], "P");
        let mut body = json!({"system":[{"type":"text","text":"S"}]});
        inject_custom_system_prompt(&mut body, "P");
        assert_eq!(body["system"][1]["text"], "P");

        // A Responses body without messages is left alone.
        let mut body = json!({"input":"hi"});
        inject_custom_system_prompt(&mut body, "P");
        assert_eq!(body, json!({"input":"hi"}));
    }

    #[test]
    fn only_known_valid_settings_are_accepted() {
        assert_eq!(
            validate(CUSTOM_SYSTEM_PROMPT, json!({"enabled":true,"prompt":"P"})),
            Ok(json!({"enabled":true,"prompt":"P"}))
        );
        assert_eq!(
            validate(CUSTOM_SYSTEM_PROMPT, json!({})),
            Ok(json!({"enabled":false,"prompt":""}))
        );
        assert!(validate(CUSTOM_SYSTEM_PROMPT, json!({"other":1})).is_err());
        assert!(validate("unknown", json!(1)).is_err());
        assert_eq!(validate(MAX_BODY_SIZE_MB, json!(25)), Ok(json!(25)));
        assert!(validate(MAX_BODY_SIZE_MB, json!(0)).is_err());
        assert!(validate(MAX_BODY_SIZE_MB, json!(501)).is_err());
        assert_eq!(
            validate(IDEMPOTENCY_WINDOW_MS, json!(9000)),
            Ok(json!(9000))
        );
        assert!(validate(IDEMPOTENCY_WINDOW_MS, json!(0)).is_err());
        let stored = BTreeMap::from([
            (MAX_BODY_SIZE_MB.to_owned(), json!(25)),
            (IDEMPOTENCY_WINDOW_MS.to_owned(), json!(9000)),
        ]);
        let snapshot = snapshot(&stored).unwrap();
        assert_eq!(snapshot.max_body_size_bytes(), Some(25 * 1024 * 1024));
        assert_eq!(snapshot.idempotency_window_ms(), 9000);
        assert_eq!(Snapshot::default().max_body_size_bytes(), None);
        assert_eq!(Snapshot::default().idempotency_window_ms(), 5_000);
        let fast = ClaudeFastMode {
            enabled: true,
            supported_models: Vec::new(),
        };
        assert!(fast.applies_to("claude-opus-4-8"));
        assert!(fast.applies_to("claude-opus-4-8-20260528"));
        assert!(!fast.applies_to("claude-opus-4-80"));
        assert!(!fast.applies_to("claude-sonnet-4-6"));
        assert!(!ClaudeFastMode::default().applies_to("claude-opus-4-8"));
        let custom = ClaudeFastMode {
            enabled: true,
            supported_models: vec!["claude-x".to_owned()],
        };
        assert!(custom.applies_to("claude-x") && !custom.applies_to("claude-opus-4-8"));
        assert_eq!(Snapshot::default().combo_sticky_limit(), 3);
        assert!(Snapshot::default().prompt_cache_affinity());
        assert!(Snapshot::default().session_stickiness());
        assert!(validate(PROMPT_CACHE_AFFINITY, json!("off")).is_err());
        assert!(validate(COMBO_STICKY_ROUND_ROBIN_LIMIT, json!(1_001)).is_err());
        assert!(validate(COMBO_STICKY_ROUND_ROBIN_LIMIT, json!(0)).is_err());
        assert_eq!(
            Snapshot::default().wait_for_cooldown(),
            crate::cooldown_retry::WaitForCooldown::default()
        );
        assert!(validate(
            WAIT_FOR_COOLDOWN,
            json!({"enabled":true,"max_retries":5,"max_retry_wait_sec":90,"budget_ms":300000})
        )
        .is_ok());
        assert!(validate(
            WAIT_FOR_COOLDOWN,
            json!({"enabled":true,"max_retries":5,"max_retry_wait_sec":90,"budget_ms":1000})
        )
        .is_err());
        assert!(validate(
            CLAUDE_FAST_MODE,
            json!({"enabled":true,"supported_models":[" "]})
        )
        .is_err());
        use crate::account_rotation::AccountStrategy;
        let strategies = validate(
            PROVIDER_STRATEGIES,
            json!({
                "default":{"strategy":"round-robin","sticky_round_robin_limit":5},
                "providers":{"openai":{"strategy":"least-used"},"gemini":{"sticky_round_robin_limit":2}}
            }),
        )
        .unwrap();
        let snapshot = super::snapshot(&BTreeMap::from([(
            PROVIDER_STRATEGIES.to_owned(),
            strategies,
        )]))
        .unwrap();
        assert_eq!(
            snapshot.provider_strategy("openai"),
            (AccountStrategy::LeastUsed, 5)
        );
        assert_eq!(
            snapshot.provider_strategy("gemini"),
            (AccountStrategy::RoundRobin, 2)
        );
        assert_eq!(
            snapshot.provider_strategy("other"),
            (AccountStrategy::RoundRobin, 5)
        );
        assert_eq!(
            Snapshot::default().provider_strategy("any"),
            (AccountStrategy::FillFirst, 3)
        );
        assert!(validate(PROVIDER_STRATEGIES, json!({"default":{"strategy":"p2c"}})).is_err());
    }
}
