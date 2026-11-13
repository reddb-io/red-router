//! Authenticated Rust control plane for provider persistence and live reload.
pub use crate::policy::AccessScheduleConfig;
#[path = "credential_crypto.rs"]
mod credential_crypto;
#[path = "model_aliases.rs"]
pub mod model_aliases;
#[path = "provider_discovery.rs"]
pub mod provider_discovery;
#[path = "provider_models.rs"]
pub mod provider_models;
#[path = "provider_nodes.rs"]
pub mod provider_nodes;
pub(crate) use credential_crypto::{decrypt_async, encrypt_async};
#[path = "provider_headers.rs"]
pub mod provider_headers;

use crate::{
    availability::{AvailabilityStatus, ConnectionCooldownProfile, ProviderAvailability},
    circuit::{BreakerStatus, CircuitProfile, ProviderCircuit},
    policy::{ClientPolicies, ClientPolicy, StoredPolicy},
    resilience::RateLimitScope,
    storage::{
        StoredAuditEvent, StoredBreakerOverride, StoredClientKey, StoredCombo,
        StoredContextRelayHandoff, StoredContextRelaySession, StoredIdentityBinding,
        StoredModelCatalogSnapshot, StoredOidcBrowserConfig, StoredOidcConfig, StoredProvider,
        StoredProviderAuth, StoredProviderModelQuota, StoredProviderOAuth,
        StoredProviderOAuthStatus, StoredProviderQuota, StoredProviderSession, StoredResilience,
        StoredRoutePin, StoredRuntimeSettings, StoredTenant, StoredUsageExport,
    },
    LiveProvider, ModelRoute, ProviderAuthScheme, ProviderProtocol, ProxyState, RouteStrategy,
    TargetQuota,
};
use aes_gcm::aead::consts::U16;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    aes::Aes256,
    AesGcm, Nonce,
};
use axum::{
    body::to_bytes,
    extract::{Path, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    io::{Cursor, Read},
    path::Path as FilePath,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::RwLock;
use zeroize::{Zeroize, Zeroizing};

type ControlCipher = AesGcm<Aes256, U16>;
const MODEL_CATALOG_SYNC_INTERVAL: Duration = Duration::from_secs(5);
const MODEL_CATALOG_AUTO_INITIAL_DELAY: Duration = Duration::from_secs(15 * 60);
const MODEL_CATALOG_AUTO_RETRY: Duration = Duration::from_secs(5 * 60);
const MODEL_CATALOG_AUTO_TIMEOUT: Duration = Duration::from_secs(90);
const MODEL_CATALOG_AUTO_LEASE_MS: i64 = 120_000;
const MODEL_CATALOG_AUTO_DAY_MS: i64 = 24 * 60 * 60 * 1_000;
const CLIENT_POLICY_SYNC_INTERVAL: Duration = Duration::from_secs(2);
const CONTROL_SNAPSHOT_SYNC_INTERVAL: Duration = Duration::from_secs(2);
const PROVIDER_DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(30);
const PROVIDER_DIAGNOSTIC_MAX_BODY_BYTES: usize = 1024 * 1024;
const OAUTH_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const OAUTH_REFRESH_LEAD_SECONDS: i64 = 300;
const OAUTH_REFRESH_LEASE_MS: i64 = 45_000;
const OAUTH_REFRESH_SETTLE_MS: i64 = 2_000;
const OAUTH_REFRESH_MAX_BODY_BYTES: usize = 1024 * 1024;
const PROVIDER_QUOTA_POLL_INTERVAL: Duration = Duration::from_secs(60);
const PROVIDER_QUOTA_POLL_GAP: Duration = Duration::from_millis(500);
const PROVIDER_QUOTA_LEASE_MS: i64 = 15_000;
const PROVIDER_QUOTA_TTL_SECONDS: u64 = 180;
const PROVIDER_QUOTA_MAX_BODY_BYTES: usize = 512 * 1024;
const USAGE_MAINTENANCE_INTERVAL: Duration = Duration::from_secs(60 * 60);
const USAGE_MAINTENANCE_BATCH_SIZE: i64 = 10_000;
const CONTEXT_RELAY_GENERATION_LEASE_MS: i64 = 60_000;
const CONTEXT_RELAY_USAGE_KEY_ID: &str = "redrouter-context-relay";
const CONTEXT_RELAY_USAGE_KEY_NAME: &str = "Red Router context relay";
const CODEX_OAUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CLAUDE_OAUTH_TOKEN_URL: &str = "https://api.anthropic.com/v1/oauth/token";
const AGY_OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GITHUB_COPILOT_TOKEN_URL: &str = "https://api.github.com/copilot_internal/v2/token";
const XAI_OAUTH_TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";
const XAI_OAUTH_AUTHORIZE_URL: &str = "https://auth.x.ai/oauth2/authorize";
const XAI_OAUTH_REDIRECT_URI: &str = "http://127.0.0.1:56121/callback";
const XAI_OAUTH_SCOPES: &str = "openid profile email offline_access grok-cli:access api:access";
const XAI_PROVIDER_URL: &str = "https://api.x.ai/v1/chat/completions";
const OPENFERENCE_OAUTH_TOKEN_URL: &str = "https://openference.com/oauth/token";
const OPENFERENCE_OAUTH_AUTHORIZE_URL: &str = "https://openference.com/app/oauth/authorize";
const OPENFERENCE_OAUTH_USERINFO_URL: &str = "https://openference.com/oauth/userinfo";
const OPENFERENCE_OAUTH_REDIRECT_URI: &str = "http://127.0.0.1:56123/callback";
const OPENFERENCE_OAUTH_SCOPES: &str = "openid profile email model:invoke offline_access";
const OPENFERENCE_PROVIDER_URL: &str = "https://api.openference.com/v1/chat/completions";
const CODEX_OAUTH_AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
const CLAUDE_OAUTH_AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
const AGY_OAUTH_AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
pub(crate) const CODEX_PROVIDER_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
pub(crate) const CLAUDE_PROVIDER_URL: &str = "https://api.anthropic.com/v1/messages";
pub(crate) const AGY_PROVIDER_URL: &str =
    "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent";
const AGY_USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v1/userinfo";
const AGY_LOAD_CODE_ASSIST_URL: &str =
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const CLAUDE_BOOTSTRAP_URL: &str = "https://api.anthropic.com/api/claude_cli/bootstrap";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const AGY_QUOTA_URLS: [&str; 2] = [
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
];
const AGY_QUOTA_SUMMARY_URLS: [&str; 2] = [
    "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
];
const CODEX_OAUTH_REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const CLAUDE_OAUTH_REDIRECT_URI: &str = "https://platform.claude.com/oauth/code/callback";
const PROVIDER_OAUTH_FLOW_SECONDS: u64 = 10 * 60;
const AGY_OAUTH_SCOPES: &str = "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs";
const THOUGHT_SIGNATURE_MEMORY_TTL_MS: i64 = 60 * 60 * 1_000;
const THOUGHT_SIGNATURE_PERSISTED_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
const MAX_THOUGHT_SIGNATURES_IN_MEMORY: usize = 1_000;
const CLAUDE_CLI_USER_AGENT: &str = "claude-cli/2.1.301 (external, cli)";
const CLAUDE_USAGE_USER_AGENT: &str = "claude-code/2.1.301";
const CODEX_USAGE_USER_AGENT: &str = "codex_cli_rs/0.163.0";
const CODEX_USAGE_VERSION: &str = "0.163.0";
const AGY_QUOTA_USER_AGENT: &str =
    "antigravity/cli/1.1.5 (aidev_client; os_type=darwin; arch=arm64; auth_method=consumer)";
const CODEX_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CLAUDE_OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const PUBLIC_CREDENTIAL_MASK: &[u8] = b"omniroute-public-v1";
const XAI_OAUTH_CLIENT_ID_MASKED: &[u8] = &[
    13, 92, 15, 89, 66, 91, 76, 70, 72, 29, 71, 70, 3, 65, 93, 84, 72, 23, 28, 87, 92, 88, 15, 95,
    91, 22, 71, 87, 20, 66, 67, 86, 13, 81, 81, 21,
];
const OPENFERENCE_OAUTH_CLIENT_ID_MASKED: &[u8] = &[0, 0, 0, 0, 0, 0, 0, 0, 0];
const AUTH_ZIP_BODY_LIMIT_BYTES: usize = 11 * 1024 * 1024;
const AUTH_ZIP_MAX_ENTRIES: usize = 1_024;
const AUTH_ZIP_MAX_JSON_FILES: usize = 50;
const AUTH_ZIP_MAX_FILE_BYTES: usize = 256 * 1024;
const AUTH_ZIP_MAX_TOTAL_BYTES: usize = 10 * 1024 * 1024;
const SQLITE_CONTROL_MARKER: &str = "SELECT kind, record_id, revision, generation FROM (
SELECT 'provider' AS kind, id AS record_id, revision, 0 AS generation FROM redrouter_control_providers
UNION ALL SELECT 'provider-ownership', provider_id, revision, 0 FROM redrouter_control_provider_ownership
UNION ALL SELECT 'provider-auth', record_id, revision, 0 FROM redrouter_control_provider_auth
UNION ALL SELECT 'provider-oauth', provider_id, revision, generation FROM redrouter_control_provider_oauth
UNION ALL SELECT 'provider-headers', provider_id, revision, 0 FROM redrouter_control_provider_headers
UNION ALL SELECT 'provider-protocol', record_id, revision, 0 FROM redrouter_control_provider_protocols
UNION ALL SELECT 'provider-node', id, revision, 0 FROM redrouter_control_provider_nodes
UNION ALL SELECT 'provider-model', id, revision, 0 FROM redrouter_control_provider_models
UNION ALL SELECT 'model-alias', id, revision, 0 FROM redrouter_control_model_aliases
UNION ALL SELECT 'model-alias-state', id, 1, 0 FROM redrouter_model_alias_state
UNION ALL SELECT 'provider-node-binding', record_id, revision, 0 FROM redrouter_control_provider_node_bindings
UNION ALL SELECT 'provider-session', provider_id, revision, 0 FROM redrouter_control_provider_sessions
UNION ALL SELECT 'provider-resilience', record_id, revision, 0 FROM redrouter_provider_resilience
UNION ALL SELECT 'provider-breaker-override', provider_id, revision, 0 FROM redrouter_provider_breaker_overrides
UNION ALL SELECT 'runtime-settings-legacy', CAST(id AS TEXT), revision, 0 FROM redrouter_runtime_settings
UNION ALL SELECT 'runtime-settings', CAST(id AS TEXT), revision, 0 FROM redrouter_runtime_settings_v2
UNION ALL SELECT 'provider-quota', provider_id, revision, 0 FROM redrouter_provider_quotas
UNION ALL SELECT 'provider-model-quota', record_id, revision, 0 FROM redrouter_provider_model_quotas
UNION ALL SELECT 'combo', id, revision, 0 FROM redrouter_control_combos
UNION ALL SELECT 'combo-ownership', combo_id, revision, 0 FROM redrouter_control_combo_ownership
UNION ALL SELECT 'route-pin', combo_id, revision, 0 FROM redrouter_route_pins
UNION ALL SELECT 'oidc', CAST(id AS TEXT), revision, 0 FROM redrouter_control_oidc
UNION ALL SELECT 'oidc-browser', CAST(id AS TEXT), revision, 0 FROM redrouter_control_oidc_browser
) marker ORDER BY kind, record_id";

struct Inner {
    database: Arc<crate::storage::Database>,
    current: RwLock<Option<LiveProvider>>,
    clients: RwLock<ClientSnapshot>,
    routes: RwLock<RouteSnapshot>,
    quotas: RwLock<HashMap<String, Arc<TargetQuota>>>,
    model_quotas: RwLock<HashMap<(String, String), Arc<TargetQuota>>>,
    breakers: RwLock<HashMap<String, Arc<ProviderCircuit>>>,
    breaker_overrides: RwLock<HashMap<String, CircuitProfile>>,
    oauth_provider_ids: RwLock<HashSet<String>>,
    availability: RwLock<HashMap<String, Arc<ProviderAvailability>>>,
    runtime_settings: RwLock<RuntimeSettingsView>,
    oidc: RwLock<Option<Arc<crate::oidc::OidcVerifier>>>,
    oidc_browser: RwLock<Option<Arc<crate::oidc::OidcBrowserConfig>>>,
    sqlite_changes: Option<tokio::sync::Mutex<SqliteChangeWatcher>>,
    provider_snapshot_signature: RwLock<[u8; 32]>,
    oidc_snapshot_signature: RwLock<[u8; 32]>,
    catalog: RwLock<CatalogState>,
    provider_models: RwLock<Option<Arc<provider_models::ModelOverrides>>>,
    model_aliases: RwLock<Option<Arc<model_aliases::AliasSnapshot>>>,
    catalog_refresh: tokio::sync::Mutex<()>,
    catalog_client: reqwest::Client,
    catalog_source: reqwest::Url,
    oauth_refresh_client: reqwest::Client,
    oauth_refresh: OAuthRefreshConfig,
    native_usage: RwLock<Option<crate::native_usage::NativeUsage>>,
    thought_signatures: StdMutex<HashMap<(String, String), (String, i64)>>,
    claude_sessions: StdMutex<HashMap<String, Arc<str>>>,
    context_relay_generations: StdMutex<HashSet<String>>,
    mutation: tokio::sync::Mutex<()>,
    node_header_cache: tokio::sync::Mutex<HashMap<String, (String, HeaderMap)>>,
    admin_hash: [u8; 32],
    encryption_key: Zeroizing<String>,
    allow_private: bool,
}

#[derive(Clone)]
struct OAuthRefreshConfig {
    codex_endpoint: reqwest::Url,
    codex_client_id: String,
    claude_endpoint: reqwest::Url,
    claude_client_id: String,
    agy_endpoint: reqwest::Url,
    github_endpoint: reqwest::Url,
    xai_endpoint: reqwest::Url,
    xai_client_id: String,
    xai_provider_endpoint: reqwest::Url,
    openference_endpoint: reqwest::Url,
    openference_client_id: String,
    openference_provider_endpoint: reqwest::Url,
    openference_userinfo_endpoint: reqwest::Url,
    agy_client_id: Option<String>,
    agy_client_secret: Option<Zeroizing<String>>,
    agy_redirect_uri: Option<String>,
    codex_provider_endpoint: reqwest::Url,
    claude_provider_endpoint: reqwest::Url,
    claude_bootstrap_endpoint: reqwest::Url,
    codex_quota_endpoint: reqwest::Url,
    claude_quota_endpoint: reqwest::Url,
    agy_quota_endpoints: Vec<reqwest::Url>,
    agy_quota_summary_endpoints: Vec<reqwest::Url>,
    agy_provider_endpoint: reqwest::Url,
    agy_userinfo_endpoint: reqwest::Url,
    agy_load_code_assist_endpoint: reqwest::Url,
}

struct OAuthRefreshRuntime {
    cadence: Duration,
    quota_cadence: Duration,
    snapshot_cadence: Duration,
    config: OAuthRefreshConfig,
}

struct SqliteChangeWatcher {
    connection: sqlx::AnyConnection,
    version: i64,
    control_marker: [u8; 32],
    pending: Option<(i64, [u8; 32])>,
}

impl SqliteChangeWatcher {
    fn supports(pool: &sqlx::AnyPool) -> bool {
        let options = pool.connect_options();
        let url = &options.database_url;
        let path = percent_encoding::percent_decode_str(url.path()).decode_utf8_lossy();
        !path.trim_matches('/').is_empty()
            && path.trim_matches('/') != ":memory:"
            && !url
                .query_pairs()
                .any(|(key, value)| key == "mode" && value == "memory")
    }

    async fn new(pool: &sqlx::AnyPool) -> Result<Self, &'static str> {
        // data_version belongs to a physical connection, and does not advance
        // for its own commits. A pool may return the writer (or a different
        // connection each time), so keep a separate read-only observer lifetime.
        // Do not acquire and retain a pooled slot: SQLite's write pool has one.
        let mut connection = sqlx::AnyConnection::connect_with(pool.connect_options().as_ref())
            .await
            .map_err(|_| "cannot initialize control snapshot watcher")?;
        sqlx::query("PRAGMA busy_timeout = 5000")
            .execute(&mut connection)
            .await
            .map_err(|_| "cannot initialize control snapshot watcher")?;
        sqlx::query("PRAGMA query_only = ON")
            .execute(&mut connection)
            .await
            .map_err(|_| "cannot initialize control snapshot watcher")?;
        let version = sqlx::query_scalar::<_, i64>("PRAGMA data_version")
            .fetch_one(&mut connection)
            .await
            .map_err(|_| "cannot initialize control snapshot watcher")?;
        let control_marker = sqlite_control_marker(&mut connection).await?;
        Ok(Self {
            connection,
            version,
            control_marker,
            pending: None,
        })
    }

    async fn changed(&mut self) -> Result<bool, &'static str> {
        // Do not forget a relevant durable change until both provider and
        // OIDC snapshots have been rebuilt successfully. This also makes a
        // transient SQLite read failure retryable without requiring another
        // writer to bump data_version.
        if self.pending.is_some() {
            return Ok(true);
        }
        let version = sqlx::query_scalar::<_, i64>("PRAGMA data_version")
            .fetch_one(&mut self.connection)
            .await
            .map_err(|_| "control snapshot watcher unavailable")?;
        if version == self.version {
            return Ok(false);
        }
        let control_marker = sqlite_control_marker(&mut self.connection).await?;
        let changed = control_marker != self.control_marker;
        if changed {
            self.pending = Some((version, control_marker));
        } else {
            // Non-control-plane writes do not require a snapshot rebuild.
            self.version = version;
        }
        Ok(changed)
    }

    fn acknowledge(&mut self) {
        if let Some((version, control_marker)) = self.pending.take() {
            self.version = version;
            self.control_marker = control_marker;
        }
    }
}

async fn sqlite_control_marker(
    connection: &mut sqlx::AnyConnection,
) -> Result<[u8; 32], &'static str> {
    let rows = sqlx::query(SQLITE_CONTROL_MARKER)
        .fetch_all(connection)
        .await
        .map_err(|_| "control snapshot watcher unavailable")?;
    let mut digest = Sha256::new();
    signature_text(&mut digest, "redrouter-sqlite-control-marker-v1");
    for row in rows {
        let kind: String = row
            .try_get("kind")
            .map_err(|_| "invalid control snapshot marker")?;
        let record_id: String = row
            .try_get("record_id")
            .map_err(|_| "invalid control snapshot marker")?;
        let revision: i64 = row
            .try_get("revision")
            .map_err(|_| "invalid control snapshot marker")?;
        let generation: i64 = row
            .try_get("generation")
            .map_err(|_| "invalid control snapshot marker")?;
        signature_text(&mut digest, &kind);
        signature_text(&mut digest, &record_id);
        signature_i64(&mut digest, revision);
        signature_i64(&mut digest, generation);
    }
    Ok(digest.finalize().into())
}

struct OAuthTokenPair {
    access_token: Zeroizing<String>,
    refresh_token: Zeroizing<String>,
    expires_at_unix: i64,
}

enum OAuthExchangeFailure {
    Terminal {
        code: String,
        status: u16,
    },
    Transient {
        category: &'static str,
        status: Option<u16>,
    },
}

struct CatalogState {
    catalog: Arc<crate::catalog::ModelCatalog>,
    source: &'static str,
    revision: Option<i64>,
    rejected_revision: Option<i64>,
    last_error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CatalogRuntimeView {
    pub source: &'static str,
    pub revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CatalogRefreshView {
    pub changed: bool,
    pub source: &'static str,
    pub revision: Option<String>,
    pub manifest: crate::catalog::CatalogManifest,
}

enum ClientSnapshot {
    Legacy,
    Current(Arc<ClientPolicies>),
    Unavailable,
}

struct DirectAccount {
    record: StoredProvider,
    auth: StoredProviderAuth,
    rate_limit_scope: RateLimitScope,
    antigravity_project: Option<Arc<str>>,
    claude_identity: Option<Arc<crate::ClaudeIdentity>>,
    quota: Arc<TargetQuota>,
    live: tokio::sync::OnceCell<LiveProvider>,
}

type DirectPools = HashMap<(String, String), Vec<Arc<DirectAccount>>>;

enum RouteSnapshot {
    Legacy(Arc<DirectPools>),
    Current(Arc<HashMap<String, Arc<ModelRoute>>>, Arc<DirectPools>),
    Unavailable,
}

struct ManagementScope {
    actor: String,
    tenant_id: Option<String>,
}

struct AuthenticatedActor {
    subjects: Vec<String>,
}

struct AuditContext<'a> {
    action: &'a str,
    actor: &'a str,
    tenant_id: &'a str,
    target: &'a str,
    resource_type: &'a str,
}

impl AuthenticatedActor {
    fn bound(subject: String) -> Self {
        Self {
            subjects: vec![subject],
        }
    }

    fn matches(&self, subject: &str) -> bool {
        self.subjects.iter().any(|candidate| candidate == subject)
    }
}

#[derive(Clone)]
pub struct ControlPlane(Arc<Inner>);

pub(crate) struct ContextRelayGenerationGuard {
    inner: Arc<Inner>,
    record_id: String,
}

pub(crate) struct ContextRelayGenerationLease {
    _local: ContextRelayGenerationGuard,
    record_id: String,
    owner: String,
}

pub(crate) struct ContextRelayUsageAttempt {
    event_id: String,
    prices: Option<crate::accounting::TokenPrices>,
}

pub(crate) struct NativeUsageRecord<'a> {
    pub(crate) provider: &'a str,
    pub(crate) model: &'a str,
    pub(crate) usage: &'a crate::accounting::ChatUsage,
    pub(crate) prices: Option<&'a crate::accounting::TokenPrices>,
    pub(crate) attribution: &'a crate::native_usage::UsageAttribution,
}

pub(crate) struct NativeRerankUsageRecord<'a> {
    pub(crate) provider: &'a str,
    pub(crate) model: &'a str,
    pub(crate) search_units: u64,
    pub(crate) price: Option<&'a crate::native_usage::RerankPrice>,
    pub(crate) attribution: &'a crate::native_usage::UsageAttribution,
}

impl Drop for ContextRelayGenerationGuard {
    fn drop(&mut self) {
        if let Ok(mut generations) = self.inner.context_relay_generations.lock() {
            generations.remove(&self.record_id);
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderInput {
    #[serde(default, deserialize_with = "provider_nodes::present_node_id")]
    pub node_id: Option<Option<String>>,
    pub protocol: Option<String>,
    pub priority: Option<i64>,
    #[serde(default, deserialize_with = "provider_nodes::present_node_id")]
    pub default_model: Option<Option<String>>,
    pub tenant_id: Option<String>,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub upstream_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    #[serde(default = "auto_rate_limit_scope")]
    pub rate_limit_scope: String,
    #[serde(default = "auto_auth_scheme")]
    pub auth_scheme: String,
    pub label: Option<String>,
    pub account_email: Option<String>,
    pub expires_at_unix: Option<u64>,
    #[serde(default = "static_credential_type")]
    pub credential_type: String,
    pub oauth_provider: Option<String>,
    pub refresh_token: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProviderView {
    pub node_id: Option<String>,
    pub protocol: String,
    pub priority: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    pub id: String,
    pub tenant_id: String,
    pub provider: String,
    pub upstream_url: String,
    pub enabled: bool,
    pub revision: String,
    pub has_credential: bool,
    pub rate_limit_scope: String,
    pub auth_scheme: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_unix: Option<u64>,
    pub credential_expired: bool,
    pub credential_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_generation: Option<String>,
    pub refreshable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_refresh_state: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_error_code: Option<String>,
    pub reauth_required: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderOAuthRotationInput {
    pub expected_generation: String,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at_unix: u64,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ProviderAuthImportSource {
    Json { json: serde_json::Value },
    Text { text: String },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderAuthImportInput {
    pub source: ProviderAuthImportSource,
    pub name: Option<String>,
    pub email: Option<String>,
    #[serde(default, rename = "overwriteExisting")]
    pub overwrite_existing: bool,
}

#[derive(Deserialize)]
pub struct ProviderOAuthAuthorizeQuery {
    pub redirect_uri: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderOAuthExchangeInput {
    pub code: String,
    #[serde(rename = "redirectUri")]
    pub redirect_uri: String,
    #[serde(rename = "codeVerifier")]
    pub code_verifier: String,
    pub state: Option<String>,
    #[serde(rename = "connectionId")]
    pub connection_id: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct ProviderOAuthFlowState {
    provider: String,
    redirect_uri: String,
    verifier_hash: String,
    actor: String,
    tenant_id: String,
    expires_at: u64,
    nonce: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodexAuthBulkEntry {
    pub json: serde_json::Value,
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodexAuthBulkImportInput {
    pub entries: Vec<CodexAuthBulkEntry>,
    #[serde(default, rename = "overwriteExisting")]
    pub overwrite_existing: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaudeAuthBulkEntry {
    pub json: serde_json::Value,
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaudeAuthBulkImportInput {
    pub entries: Vec<ClaudeAuthBulkEntry>,
    #[serde(default, rename = "overwriteExisting")]
    pub overwrite_existing: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgyAuthBulkEntry {
    pub json: serde_json::Value,
    pub name: Option<String>,
    pub email: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgyAuthBulkImportInput {
    pub entries: Vec<AgyAuthBulkEntry>,
    #[serde(default, rename = "overwriteExisting")]
    pub overwrite_existing: bool,
}

#[derive(Debug, Serialize)]
struct ProviderAuthImportView {
    connection: ProviderView,
    created: bool,
}

struct ProviderAuthExport {
    file_name: String,
    content: String,
}

pub(crate) struct ParsedCodexAuth {
    pub(crate) access_token: Zeroizing<String>,
    pub(crate) refresh_token: Zeroizing<String>,
    pub(crate) session_metadata: Zeroizing<String>,
    pub(crate) account_id: String,
    pub(crate) user_id: Option<String>,
    pub(crate) email: Option<String>,
    pub(crate) expires_at_unix: u64,
}

pub(crate) struct ParsedClaudeAuth {
    pub(crate) access_token: Zeroizing<String>,
    pub(crate) refresh_token: Zeroizing<String>,
    pub(crate) session_metadata: Zeroizing<String>,
    pub(crate) expires_at_unix: u64,
}

pub(crate) struct ParsedAgyAuth {
    pub(crate) access_token: Zeroizing<String>,
    pub(crate) refresh_token: Zeroizing<String>,
    pub(crate) session_metadata: Zeroizing<String>,
    pub(crate) expires_at_unix: u64,
}

#[derive(Default)]
struct AgyBootstrapIdentity {
    email: Option<String>,
    project_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct AuthZipEntry {
    name: String,
    json: Option<serde_json::Value>,
    #[serde(rename = "parseError")]
    parse_error: Option<&'static str>,
}

#[derive(Debug)]
enum AuthZipError {
    InvalidArchive,
    TooManyEntries,
    NoJsonFiles,
    TooManyJsonFiles,
    UnsafeEntry,
    UnsupportedEntry,
    EncryptedEntry,
    FileTooLarge,
    TotalTooLarge,
}

impl AuthZipError {
    fn message(&self) -> &'static str {
        match self {
            Self::InvalidArchive => {
                "Could not parse ZIP archive - file may be corrupt or not a valid ZIP"
            }
            Self::TooManyEntries => "ZIP archive contains too many entries",
            Self::NoJsonFiles => "ZIP archive contains no .json files",
            Self::TooManyJsonFiles => "ZIP archive contains more than 50 .json files",
            Self::UnsafeEntry => "ZIP archive contains an unsafe entry path",
            Self::UnsupportedEntry => "ZIP archive contains an unsupported non-file entry",
            Self::EncryptedEntry => "Encrypted ZIP entries are not supported",
            Self::FileTooLarge => "ZIP entry exceeds the 256 KB size limit",
            Self::TotalTooLarge => "ZIP archive total uncompressed size exceeds the 10 MB limit",
        }
    }
}

struct ClaudeBootstrapIdentity {
    account_id: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ProviderOAuthRefreshView {
    pub provider_id: String,
    pub ok: bool,
    pub category: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_status: Option<u16>,
    pub generation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at_unix: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderDiagnosticInput {
    pub model: String,
}

#[derive(Debug, Serialize)]
pub struct ProviderDiagnosticView {
    pub provider_id: String,
    pub model: String,
    pub ok: bool,
    pub category: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream_status: Option<u16>,
    pub latency_ms: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientKeyInput {
    pub label: String,
    pub api_key: Option<String>,
    pub tenant_id: Option<String>,
    pub model_id_format: Option<String>,
    pub model_access_mode: Option<String>,
    #[serde(default, deserialize_with = "present_combo_grants")]
    pub allowed_combos: Option<Option<Vec<String>>>,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    pub expires_at_unix: Option<u64>,
    pub access_schedule: Option<AccessScheduleConfig>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub allowed_endpoints: Vec<String>,
    #[serde(default)]
    pub allowed_models: Vec<String>,
    #[serde(default)]
    pub blocked_models: Vec<String>,
    #[serde(default)]
    pub allowed_provider_ids: Vec<String>,
    pub max_concurrent_requests: Option<u64>,
    pub max_requests_per_minute: Option<u64>,
    pub max_requests_per_day: Option<u64>,
    pub max_tokens_per_minute: Option<u64>,
    pub max_tokens_per_day: Option<u64>,
    pub max_spend_per_month_usd: Option<f64>,
    pub reservation_tokens: Option<u64>,
    pub reservation_spend_usd: Option<f64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientKeyIssueInput {
    pub label: String,
    pub tenant_id: Option<String>,
    pub model_id_format: Option<String>,
    pub model_access_mode: Option<String>,
    #[serde(default, deserialize_with = "present_combo_grants")]
    pub allowed_combos: Option<Option<Vec<String>>>,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    pub expires_at_unix: Option<u64>,
    pub access_schedule: Option<AccessScheduleConfig>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub allowed_endpoints: Vec<String>,
    #[serde(default)]
    pub allowed_models: Vec<String>,
    #[serde(default)]
    pub blocked_models: Vec<String>,
    #[serde(default)]
    pub allowed_provider_ids: Vec<String>,
    pub max_concurrent_requests: Option<u64>,
    pub max_requests_per_minute: Option<u64>,
    pub max_requests_per_day: Option<u64>,
    pub max_tokens_per_minute: Option<u64>,
    pub max_tokens_per_day: Option<u64>,
    pub max_spend_per_month_usd: Option<f64>,
    pub reservation_tokens: Option<u64>,
    pub reservation_spend_usd: Option<f64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TokenLimitInput {
    pub id: Option<String>,
    pub api_key_id: String,
    pub scope_type: String,
    pub scope_value: String,
    pub token_limit: i64,
    pub reset_interval: String,
    pub reset_time: Option<String>,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenLimitQuery {
    pub api_key_id: Option<String>,
    pub id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UsageReportQuery {
    pub tenant_id: Option<String>,
    pub key_id: Option<String>,
    pub from_unix_ms: Option<i64>,
    pub to_unix_ms: Option<i64>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LegacyUsageQuery {
    pub tenant_id: Option<String>,
    pub key_id: Option<String>,
    pub cursor: Option<i64>,
    pub limit: Option<i64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageExportConfigInput {
    pub url: Option<String>,
    pub secret: Option<String>,
    pub queue: Option<String>,
    pub token: Option<String>,
    pub tenant: Option<String>,
    pub queue_url: Option<String>,
    pub region: Option<String>,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub session_token: Option<String>,
    pub brokers: Option<String>,
    pub topic: Option<String>,
    pub client_id: Option<String>,
    pub ssl: Option<bool>,
    pub sasl_mechanism: Option<String>,
    pub sasl_username: Option<String>,
    pub sasl_password: Option<String>,
    pub project_id: Option<String>,
    pub dataset_id: Option<String>,
    pub table_id: Option<String>,
    pub service_account_json: Option<String>,
    pub batch_size: Option<UnsignedInput>,
    pub interval_seconds: Option<UnsignedInput>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum UnsignedInput {
    Number(u64),
    Text(String),
}

impl UnsignedInput {
    fn value(self) -> Result<u64, &'static str> {
        match self {
            Self::Number(value) => Ok(value),
            Self::Text(value) => value
                .parse()
                .map_err(|_| "invalid unsigned configuration value"),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageExportCreateInput {
    pub name: String,
    pub tenant_id: Option<String>,
    #[serde(rename = "type", default = "bigquery_export_type")]
    pub export_type: String,
    pub mode: String,
    pub window_sec: Option<i64>,
    #[serde(default)]
    pub api_key_ids: Vec<String>,
    pub config: UsageExportConfigInput,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageExportUpdateInput {
    pub name: Option<String>,
    pub mode: Option<String>,
    pub window_sec: Option<i64>,
    pub api_key_ids: Option<Vec<String>>,
    pub config: Option<UsageExportConfigInput>,
    pub enabled: Option<bool>,
}

fn bigquery_export_type() -> String {
    "bigquery".to_owned()
}

impl ClientKeyIssueInput {
    fn with_secret(self, api_key: String) -> ClientKeyInput {
        ClientKeyInput {
            label: self.label,
            api_key: Some(api_key),
            tenant_id: self.tenant_id,
            model_id_format: self.model_id_format,
            model_access_mode: self.model_access_mode,
            allowed_combos: self.allowed_combos,
            enabled: self.enabled,
            expires_at_unix: self.expires_at_unix,
            access_schedule: self.access_schedule,
            scopes: self.scopes,
            allowed_endpoints: self.allowed_endpoints,
            allowed_models: self.allowed_models,
            blocked_models: self.blocked_models,
            allowed_provider_ids: self.allowed_provider_ids,
            max_concurrent_requests: self.max_concurrent_requests,
            max_requests_per_minute: self.max_requests_per_minute,
            max_requests_per_day: self.max_requests_per_day,
            max_tokens_per_minute: self.max_tokens_per_minute,
            max_tokens_per_day: self.max_tokens_per_day,
            max_spend_per_month_usd: self.max_spend_per_month_usd,
            reservation_tokens: self.reservation_tokens,
            reservation_spend_usd: self.reservation_spend_usd,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ClientKeyView {
    pub model_matching: &'static str,
    pub id: String,
    pub label: String,
    pub tenant_id: String,
    pub created_by: String,
    pub model_id_format: String,
    pub model_access_mode: String,
    pub allowed_combos: Option<Vec<String>>,
    pub enabled: bool,
    pub expires_at_unix: Option<u64>,
    pub access_schedule: Option<AccessScheduleConfig>,
    pub scopes: Vec<String>,
    pub allowed_endpoints: Vec<String>,
    pub allowed_models: Vec<String>,
    pub blocked_models: Vec<String>,
    pub allowed_provider_ids: Vec<String>,
    pub max_concurrent_requests: Option<u64>,
    pub max_requests_per_minute: Option<u64>,
    pub max_requests_per_day: Option<u64>,
    pub max_tokens_per_minute: Option<u64>,
    pub max_tokens_per_day: Option<u64>,
    pub max_spend_per_month_usd: Option<f64>,
    pub reservation_tokens: Option<u64>,
    pub reservation_spend_usd: Option<f64>,
    pub revision: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TenantInput {
    pub slug: String,
    pub name: String,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
pub struct TenantView {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub enabled: bool,
    pub revision: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdentityBindingInput {
    pub subject: Option<String>,
    pub oidc_issuer: Option<String>,
    pub oidc_subject: Option<String>,
    pub tenant_id: String,
    pub role: String,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
pub struct IdentityBindingView {
    pub id: String,
    pub subject: String,
    pub tenant_id: String,
    pub role: String,
    pub enabled: bool,
    pub revision: String,
}

#[derive(Default, Deserialize)]
pub struct AuditQuery {
    pub action: Option<String>,
    pub actor: Option<String>,
    pub target: Option<String>,
    #[serde(alias = "resourceType")]
    pub resource_type: Option<String>,
    pub status: Option<String>,
    #[serde(alias = "requestId")]
    pub request_id: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEventView {
    pub id: String,
    pub timestamp: String,
    pub created_at: String,
    pub action: String,
    pub actor: String,
    pub tenant_id: String,
    pub target: String,
    pub resource_type: String,
    pub status: String,
    pub request_id: String,
    pub details: serde_json::Value,
    pub metadata: serde_json::Value,
    pub ip: Option<String>,
    pub ip_address: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ComboTarget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "comboName")]
    pub combo_id: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub provider_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_cost_per_million: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_cost_per_million: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<u64>,
}

impl ComboTarget {
    fn combo_reference(&self) -> Option<&str> {
        if self.kind.as_deref() == Some("combo-ref") {
            self.combo_id.as_deref()
        } else {
            None
        }
    }

    fn is_combo_reference(&self) -> bool {
        self.kind.as_deref() == Some("combo-ref")
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ComboAutoWeights {
    pub quota: f64,
    pub cost: f64,
    pub context: f64,
    pub load: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ComboAutoConfig {
    pub weights: ComboAutoWeights,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ComboContextRelayConfig {
    #[serde(default = "default_handoff_threshold")]
    pub handoff_threshold: f64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub handoff_model: String,
    #[serde(default = "default_handoff_providers")]
    pub handoff_providers: Vec<String>,
    #[serde(default = "default_max_messages_for_summary")]
    pub max_messages_for_summary: u32,
    #[serde(default = "standard_relay_mode")]
    pub relay_mode: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ComboFusionConfig {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub judge_model: String,
    #[serde(default = "default_fusion_min_panel")]
    pub min_panel: u32,
    #[serde(default = "default_fusion_straggler_grace_ms")]
    pub straggler_grace_ms: u64,
    #[serde(default = "default_fusion_panel_timeout_ms")]
    pub panel_timeout_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ComboPipelineConfig {
    #[serde(default)]
    pub max_retries: u32,
    #[serde(default = "default_pipeline_retry_delay_ms")]
    pub retry_delay_ms: u64,
}

impl Default for ComboPipelineConfig {
    fn default() -> Self {
        Self {
            max_retries: 0,
            retry_delay_ms: default_pipeline_retry_delay_ms(),
        }
    }
}

impl Default for ComboFusionConfig {
    fn default() -> Self {
        Self {
            judge_model: String::new(),
            min_panel: default_fusion_min_panel(),
            straggler_grace_ms: default_fusion_straggler_grace_ms(),
            panel_timeout_ms: default_fusion_panel_timeout_ms(),
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ContextRelayHandoff {
    pub summary: String,
    pub key_decisions: Vec<String>,
    pub task_progress: String,
    pub active_entities: Vec<String>,
    pub message_count: usize,
    pub source_model: String,
}

impl Default for ComboContextRelayConfig {
    fn default() -> Self {
        Self {
            handoff_threshold: default_handoff_threshold(),
            handoff_model: String::new(),
            handoff_providers: default_handoff_providers(),
            max_messages_for_summary: default_max_messages_for_summary(),
            relay_mode: standard_relay_mode(),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ComboInput {
    pub tenant_id: Option<String>,
    #[serde(default = "openai_protocol")]
    pub protocol: String,
    #[serde(default = "priority_strategy")]
    pub strategy: String,
    #[serde(default)]
    pub fallback: bool,
    pub targets: Vec<ComboTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto: Option<ComboAutoConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_relay: Option<ComboContextRelayConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fusion: Option<ComboFusionConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<ComboPipelineConfig>,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

#[derive(Debug, Serialize)]
pub struct ComboView {
    pub id: String,
    pub tenant_id: String,
    pub protocol: String,
    pub strategy: String,
    pub fallback: bool,
    pub targets: Vec<ComboTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto: Option<ComboAutoConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_relay: Option<ComboContextRelayConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fusion: Option<ComboFusionConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<ComboPipelineConfig>,
    pub enabled: bool,
    pub revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_known_good: Option<RoutePinView>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredComboPayload {
    targets: Vec<ComboTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auto: Option<ComboAutoConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context_relay: Option<ComboContextRelayConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fusion: Option<ComboFusionConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pipeline: Option<ComboPipelineConfig>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StoredComboPayloadCompat {
    Legacy(Vec<ComboTarget>),
    Current(StoredComboPayload),
}

#[derive(Clone, Debug, Serialize)]
pub struct RoutePinView {
    pub provider_id: String,
    pub model: String,
    pub revision: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuotaWindowInput {
    pub remaining_percent: f64,
    pub reset_at_unix_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderQuotaInput {
    pub session: Option<QuotaWindowInput>,
    pub weekly: Option<QuotaWindowInput>,
    #[serde(default)]
    pub limit_reached: bool,
    #[serde(default = "default_quota_ttl_seconds")]
    pub ttl_seconds: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderHealthInput {
    pub failure_threshold: u64,
    pub degradation_threshold: u64,
    pub reset_timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeSettingsInput {
    pub quota_preflight_enabled: bool,
    pub quota_preflight_threshold_percent: f64,
    #[serde(default = "default_oauth_cooldown_settings")]
    pub oauth_connection_cooldown: ConnectionCooldownProfileSettings,
    #[serde(default = "default_apikey_cooldown_settings")]
    pub apikey_connection_cooldown: ConnectionCooldownProfileSettings,
    #[serde(default = "default_oauth_breaker_settings")]
    pub oauth_provider_breaker: ProviderBreakerProfileSettings,
    #[serde(default = "default_apikey_breaker_settings")]
    pub apikey_provider_breaker: ProviderBreakerProfileSettings,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ConnectionCooldownProfileSettings {
    pub base_cooldown_ms: u64,
    pub use_upstream_retry_hints: bool,
    pub max_backoff_steps: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderBreakerProfileSettings {
    pub failure_threshold: u64,
    pub degradation_threshold: u64,
    pub reset_timeout_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct RuntimeSettingsView {
    pub quota_preflight_enabled: bool,
    pub quota_preflight_threshold_percent: f64,
    pub oauth_connection_cooldown: ConnectionCooldownProfileSettings,
    pub apikey_connection_cooldown: ConnectionCooldownProfileSettings,
    pub oauth_provider_breaker: ProviderBreakerProfileSettings,
    pub apikey_provider_breaker: ProviderBreakerProfileSettings,
    pub revision: String,
}

impl Default for RuntimeSettingsView {
    fn default() -> Self {
        Self {
            quota_preflight_enabled: false,
            quota_preflight_threshold_percent: 2.0,
            oauth_connection_cooldown: default_oauth_cooldown_settings(),
            apikey_connection_cooldown: default_apikey_cooldown_settings(),
            oauth_provider_breaker: default_oauth_breaker_settings(),
            apikey_provider_breaker: default_apikey_breaker_settings(),
            revision: "0".to_owned(),
        }
    }
}

fn default_oauth_cooldown_settings() -> ConnectionCooldownProfileSettings {
    cooldown_profile_settings(ConnectionCooldownProfile::oauth_default())
}

fn default_apikey_cooldown_settings() -> ConnectionCooldownProfileSettings {
    cooldown_profile_settings(ConnectionCooldownProfile::api_key_default())
}

fn default_oauth_breaker_settings() -> ProviderBreakerProfileSettings {
    breaker_profile_settings(CircuitProfile::oauth_default())
}

fn default_apikey_breaker_settings() -> ProviderBreakerProfileSettings {
    breaker_profile_settings(CircuitProfile::api_key_default())
}

#[derive(Debug, Serialize)]
struct ProviderHealthView {
    #[serde(flatten)]
    breaker: BreakerStatus,
    #[serde(flatten)]
    availability: AvailabilityStatus,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OidcInput {
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    pub issuer: String,
    pub audience: String,
    pub jwks_uri: String,
    #[serde(default)]
    pub required_claims: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub allowed_subjects: Vec<String>,
    pub browser: Option<OidcBrowserInput>,
    #[serde(default)]
    pub clear_browser: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OidcBrowserInput {
    pub public_origin: String,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default = "default_oidc_scopes")]
    pub scopes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OidcDiscoveryInput {
    pub issuer: String,
}

#[derive(Debug, Serialize)]
pub struct OidcView {
    pub enabled: bool,
    pub issuer: String,
    pub audience: String,
    pub jwks_uri: String,
    pub required_claims: BTreeMap<String, Vec<String>>,
    pub allowed_subjects: Vec<String>,
    pub revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser: Option<OidcBrowserView>,
}

#[derive(Debug, Serialize)]
pub struct OidcBrowserView {
    pub public_origin: String,
    pub client_id: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub scopes: Vec<String>,
    pub has_client_secret: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OidcLoginQuery {
    pub test: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OidcCallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LocalAdminLoginInput {
    admin_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct OidcFlowState {
    state: String,
    nonce: String,
    verifier: String,
    expires_at: u64,
    revision: i64,
    test: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct AdminSession {
    subject: String,
    csrf_hash: String,
    expires_at: u64,
    revision: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bootstrap_hash: Option<String>,
}

const OIDC_FLOW_COOKIE: &str = "redrouter_oidc_flow";
const ADMIN_SESSION_COOKIE: &str = "redrouter_admin_session";
const ADMIN_CSRF_COOKIE: &str = "redrouter_admin_csrf";
const ADMIN_CSRF_HEADER: &str = "x-red-router-csrf";
const OIDC_FLOW_SECONDS: u64 = 10 * 60;
const ADMIN_SESSION_SECONDS: u64 = 12 * 60 * 60;

struct BrowserLogin {
    location: String,
    flow_cookie: String,
    secure: bool,
}

struct LocalAdminSession {
    session_cookie: String,
    csrf: String,
    secure: bool,
}

enum BrowserCallback {
    Session {
        location: String,
        session_cookie: String,
        csrf: String,
        secure: bool,
    },
    Test {
        location: String,
        secure: bool,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct QuotaWindowView {
    pub remaining_percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_at_unix_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct ProviderQuotaView {
    pub provider_id: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ProviderModelQuotaView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<QuotaWindowView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weekly: Option<QuotaWindowView>,
    pub limit_reached: bool,
    pub observed_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub revision: String,
}

#[derive(Debug, Serialize)]
pub struct ProviderModelQuotaView {
    pub model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<QuotaWindowView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weekly: Option<QuotaWindowView>,
    pub limit_reached: bool,
    pub observed_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub revision: String,
}

#[derive(Debug, Serialize)]
pub struct ProviderQuotaRefreshView {
    pub provider_id: String,
    pub refreshed: bool,
    pub category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota: Option<ProviderQuotaView>,
}

fn enabled_by_default() -> bool {
    true
}

fn openai_protocol() -> String {
    "openai".to_owned()
}

fn auto_rate_limit_scope() -> String {
    "auto".to_owned()
}

fn auto_auth_scheme() -> String {
    "auto".to_owned()
}

fn static_credential_type() -> String {
    "static".to_owned()
}

fn priority_strategy() -> String {
    "priority".to_owned()
}

fn default_handoff_threshold() -> f64 {
    0.85
}

fn default_handoff_providers() -> Vec<String> {
    vec!["codex".to_owned()]
}

fn default_max_messages_for_summary() -> u32 {
    30
}

fn standard_relay_mode() -> String {
    "standard".to_owned()
}

fn default_fusion_min_panel() -> u32 {
    2
}

fn default_fusion_straggler_grace_ms() -> u64 {
    8_000
}

fn default_fusion_panel_timeout_ms() -> u64 {
    90_000
}

fn default_pipeline_retry_delay_ms() -> u64 {
    1_000
}

fn default_quota_ttl_seconds() -> u64 {
    360
}

fn default_oidc_scopes() -> Vec<String> {
    vec![
        "openid".to_owned(),
        "profile".to_owned(),
        "email".to_owned(),
    ]
}

fn validate_catalog_source(value: &str, allow_private: bool) -> Result<reqwest::Url, &'static str> {
    let url = reqwest::Url::parse(value).map_err(|_| "invalid models.dev source URL")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || (value != crate::catalog::EXPECTED_SOURCE
            && !(allow_private
                && url.scheme() == "http"
                && url
                    .host_str()
                    .and_then(|host| host.parse::<std::net::IpAddr>().ok())
                    .is_some_and(|address| address.is_loopback())))
    {
        return Err("invalid models.dev source URL");
    }
    Ok(url)
}

impl OAuthRefreshConfig {
    fn production() -> Result<Self, &'static str> {
        let codex_client_id = std::env::var("CODEX_OAUTH_CLIENT_ID")
            .unwrap_or_else(|_| CODEX_OAUTH_CLIENT_ID.to_owned());
        let claude_client_id = std::env::var("CLAUDE_OAUTH_CLIENT_ID")
            .unwrap_or_else(|_| CLAUDE_OAUTH_CLIENT_ID.to_owned());
        let xai_client_id = std::env::var("GROK_OAUTH_CLIENT_ID")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(embedded_xai_oauth_client_id);
        let openference_client_id = std::env::var("OPENFERENCE_OAUTH_CLIENT_ID")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(embedded_openference_oauth_client_id);
        let agy_client_id = std::env::var("ANTIGRAVITY_OAUTH_CLIENT_ID")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let agy_client_secret = std::env::var("ANTIGRAVITY_OAUTH_CLIENT_SECRET")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(Zeroizing::new);
        let agy_redirect_uri = std::env::var("ANTIGRAVITY_OAUTH_REDIRECT_URI")
            .ok()
            .filter(|value| !value.trim().is_empty());
        validate_oauth_client_id(&codex_client_id)?;
        validate_oauth_client_id(&claude_client_id)?;
        validate_oauth_client_id(&xai_client_id)?;
        validate_oauth_client_id(&openference_client_id)?;
        if let Some(client_id) = agy_client_id.as_deref() {
            validate_oauth_client_id(client_id)?;
        }
        if agy_client_secret
            .as_deref()
            .is_some_and(|secret| secret.len() > 8192 || secret.chars().any(char::is_control))
        {
            return Err("invalid Antigravity OAuth client secret");
        }
        if let Some(redirect_uri) = agy_redirect_uri.as_deref() {
            validate_agy_oauth_redirect_uri(redirect_uri, Some(redirect_uri))?;
        }
        Ok(Self {
            codex_endpoint: reqwest::Url::parse(CODEX_OAUTH_TOKEN_URL)
                .map_err(|_| "invalid Codex OAuth token URL")?,
            codex_client_id,
            claude_endpoint: reqwest::Url::parse(CLAUDE_OAUTH_TOKEN_URL)
                .map_err(|_| "invalid Claude OAuth token URL")?,
            claude_client_id,
            agy_endpoint: reqwest::Url::parse(AGY_OAUTH_TOKEN_URL)
                .map_err(|_| "invalid Antigravity OAuth token URL")?,
            github_endpoint: reqwest::Url::parse(GITHUB_COPILOT_TOKEN_URL)
                .map_err(|_| "invalid GitHub Copilot token URL")?,
            xai_endpoint: reqwest::Url::parse(XAI_OAUTH_TOKEN_URL)
                .map_err(|_| "invalid xAI OAuth token URL")?,
            xai_client_id,
            xai_provider_endpoint: reqwest::Url::parse(XAI_PROVIDER_URL)
                .map_err(|_| "invalid xAI provider URL")?,
            openference_endpoint: reqwest::Url::parse(OPENFERENCE_OAUTH_TOKEN_URL)
                .map_err(|_| "invalid Openference OAuth token URL")?,
            openference_client_id,
            openference_provider_endpoint: reqwest::Url::parse(OPENFERENCE_PROVIDER_URL)
                .map_err(|_| "invalid Openference provider URL")?,
            openference_userinfo_endpoint: reqwest::Url::parse(OPENFERENCE_OAUTH_USERINFO_URL)
                .map_err(|_| "invalid Openference userinfo URL")?,
            agy_client_id,
            agy_client_secret,
            agy_redirect_uri,
            codex_provider_endpoint: reqwest::Url::parse(CODEX_PROVIDER_URL)
                .map_err(|_| "invalid Codex provider URL")?,
            claude_provider_endpoint: reqwest::Url::parse(CLAUDE_PROVIDER_URL)
                .map_err(|_| "invalid Claude provider URL")?,
            claude_bootstrap_endpoint: reqwest::Url::parse(CLAUDE_BOOTSTRAP_URL)
                .map_err(|_| "invalid Claude bootstrap URL")?,
            codex_quota_endpoint: reqwest::Url::parse(CODEX_USAGE_URL)
                .map_err(|_| "invalid Codex usage URL")?,
            claude_quota_endpoint: reqwest::Url::parse(CLAUDE_USAGE_URL)
                .map_err(|_| "invalid Claude usage URL")?,
            agy_quota_endpoints: AGY_QUOTA_URLS
                .into_iter()
                .map(reqwest::Url::parse)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "invalid Antigravity quota URL")?,
            agy_quota_summary_endpoints: AGY_QUOTA_SUMMARY_URLS
                .into_iter()
                .map(reqwest::Url::parse)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| "invalid Antigravity quota summary URL")?,
            agy_provider_endpoint: reqwest::Url::parse(AGY_PROVIDER_URL)
                .map_err(|_| "invalid Antigravity provider URL")?,
            agy_userinfo_endpoint: reqwest::Url::parse(AGY_USERINFO_URL)
                .map_err(|_| "invalid Antigravity userinfo URL")?,
            agy_load_code_assist_endpoint: reqwest::Url::parse(AGY_LOAD_CODE_ASSIST_URL)
                .map_err(|_| "invalid Antigravity bootstrap URL")?,
        })
    }

    fn testing(codex_endpoint: reqwest::Url, claude_endpoint: reqwest::Url) -> Self {
        let mut codex_provider_endpoint = codex_endpoint.clone();
        codex_provider_endpoint.set_path("/responses");
        codex_provider_endpoint.set_query(None);
        codex_provider_endpoint.set_fragment(None);
        let mut claude_provider_endpoint = claude_endpoint.clone();
        claude_provider_endpoint.set_path("/messages");
        claude_provider_endpoint.set_query(None);
        claude_provider_endpoint.set_fragment(None);
        let mut claude_bootstrap_endpoint = claude_endpoint.clone();
        claude_bootstrap_endpoint.set_path("/bootstrap");
        claude_bootstrap_endpoint.set_query(None);
        claude_bootstrap_endpoint.set_fragment(None);
        let mut codex_quota_endpoint = codex_endpoint.clone();
        codex_quota_endpoint.set_path("/codex-usage");
        codex_quota_endpoint.set_query(None);
        codex_quota_endpoint.set_fragment(None);
        let mut claude_quota_endpoint = claude_endpoint.clone();
        claude_quota_endpoint.set_path("/claude-usage");
        claude_quota_endpoint.set_query(None);
        claude_quota_endpoint.set_fragment(None);
        let mut agy_quota_endpoint = codex_endpoint.clone();
        agy_quota_endpoint.set_path("/agy-quota");
        agy_quota_endpoint.set_query(None);
        agy_quota_endpoint.set_fragment(None);
        let mut agy_quota_summary_endpoint = codex_endpoint.clone();
        agy_quota_summary_endpoint.set_path("/agy-quota-summary");
        agy_quota_summary_endpoint.set_query(None);
        agy_quota_summary_endpoint.set_fragment(None);
        let mut agy_provider_endpoint = codex_endpoint.clone();
        agy_provider_endpoint.set_path("/v1internal:streamGenerateContent");
        agy_provider_endpoint.set_query(None);
        agy_provider_endpoint.set_fragment(None);
        let mut agy_userinfo_endpoint = codex_endpoint.clone();
        agy_userinfo_endpoint.set_path("/userinfo");
        agy_userinfo_endpoint.set_query(None);
        agy_userinfo_endpoint.set_fragment(None);
        let mut agy_load_code_assist_endpoint = codex_endpoint.clone();
        agy_load_code_assist_endpoint.set_path("/load-code-assist");
        agy_load_code_assist_endpoint.set_query(None);
        agy_load_code_assist_endpoint.set_fragment(None);
        let mut github_endpoint = codex_endpoint.clone();
        github_endpoint.set_path("/copilot-token");
        github_endpoint.set_query(None);
        github_endpoint.set_fragment(None);
        let mut xai_endpoint = codex_endpoint.clone();
        xai_endpoint.set_path("/xai-token");
        xai_endpoint.set_query(None);
        xai_endpoint.set_fragment(None);
        let mut xai_provider_endpoint = codex_endpoint.clone();
        xai_provider_endpoint.set_path("/xai/chat/completions");
        xai_provider_endpoint.set_query(None);
        xai_provider_endpoint.set_fragment(None);
        let mut openference_endpoint = codex_endpoint.clone();
        openference_endpoint.set_path("/openference-token");
        openference_endpoint.set_query(None);
        openference_endpoint.set_fragment(None);
        let mut openference_provider_endpoint = codex_endpoint.clone();
        openference_provider_endpoint.set_path("/openference/chat/completions");
        openference_provider_endpoint.set_query(None);
        openference_provider_endpoint.set_fragment(None);
        let mut openference_userinfo_endpoint = codex_endpoint.clone();
        openference_userinfo_endpoint.set_path("/openference-userinfo");
        openference_userinfo_endpoint.set_query(None);
        openference_userinfo_endpoint.set_fragment(None);
        Self {
            codex_provider_endpoint,
            codex_endpoint: codex_endpoint.clone(),
            codex_client_id: CODEX_OAUTH_CLIENT_ID.to_owned(),
            claude_provider_endpoint,
            claude_bootstrap_endpoint,
            codex_quota_endpoint,
            claude_quota_endpoint,
            agy_quota_endpoints: vec![agy_quota_endpoint],
            agy_quota_summary_endpoints: vec![agy_quota_summary_endpoint],
            claude_endpoint,
            claude_client_id: CLAUDE_OAUTH_CLIENT_ID.to_owned(),
            agy_endpoint: codex_endpoint,
            github_endpoint,
            xai_endpoint,
            xai_client_id: "test-xai-client".to_owned(),
            xai_provider_endpoint,
            openference_endpoint,
            openference_client_id: "omniroute".to_owned(),
            openference_provider_endpoint,
            openference_userinfo_endpoint,
            agy_client_id: Some("test-antigravity-client".to_owned()),
            agy_client_secret: Some(Zeroizing::new("test-antigravity-secret".to_owned())),
            agy_redirect_uri: None,
            agy_provider_endpoint,
            agy_userinfo_endpoint,
            agy_load_code_assist_endpoint,
        }
    }
}

fn embedded_xai_oauth_client_id() -> String {
    decode_public_credential(XAI_OAUTH_CLIENT_ID_MASKED)
}

fn embedded_openference_oauth_client_id() -> String {
    decode_public_credential(OPENFERENCE_OAUTH_CLIENT_ID_MASKED)
}

fn decode_public_credential(masked: &[u8]) -> String {
    masked
        .iter()
        .enumerate()
        .map(|(index, byte)| {
            char::from(*byte ^ PUBLIC_CREDENTIAL_MASK[index % PUBLIC_CREDENTIAL_MASK.len()])
        })
        .collect()
}

fn validate_oauth_client_id(value: &str) -> Result<(), &'static str> {
    if !(1..=512).contains(&value.len()) || value.chars().any(char::is_control) {
        return Err("invalid OAuth client identifier");
    }
    Ok(())
}

fn validate_agy_oauth_redirect_uri(
    value: &str,
    configured_public_uri: Option<&str>,
) -> Result<(), &'static str> {
    let url = reqwest::Url::parse(value).map_err(|_| "invalid Antigravity OAuth redirect URI")?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("invalid Antigravity OAuth redirect URI");
    }
    let loopback = match url.host() {
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        None => false,
    };
    if (url.scheme() == "http" && loopback)
        || (url.scheme() == "https" && configured_public_uri == Some(value))
    {
        Ok(())
    } else {
        Err("invalid Antigravity OAuth redirect URI")
    }
}

impl ControlPlane {
    pub async fn new(
        database: Arc<crate::storage::Database>,
        admin_key: &str,
        encryption_key: &str,
        allow_private: bool,
    ) -> Result<Self, &'static str> {
        Self::new_with_model_catalog_source(
            database,
            admin_key,
            encryption_key,
            allow_private,
            crate::catalog::EXPECTED_SOURCE,
        )
        .await
    }

    #[doc(hidden)]
    pub async fn new_with_model_catalog_source(
        database: Arc<crate::storage::Database>,
        admin_key: &str,
        encryption_key: &str,
        allow_private: bool,
        catalog_source: &str,
    ) -> Result<Self, &'static str> {
        Self::new_with_model_catalog_source_and_poll_interval(
            database,
            admin_key,
            encryption_key,
            allow_private,
            catalog_source,
            MODEL_CATALOG_SYNC_INTERVAL,
        )
        .await
    }

    #[doc(hidden)]
    pub async fn new_with_model_catalog_source_and_poll_interval(
        database: Arc<crate::storage::Database>,
        admin_key: &str,
        encryption_key: &str,
        allow_private: bool,
        catalog_source: &str,
        catalog_poll_interval: Duration,
    ) -> Result<Self, &'static str> {
        Self::new_with_runtime_options(
            database,
            admin_key,
            encryption_key,
            allow_private,
            catalog_source,
            catalog_poll_interval,
            OAuthRefreshRuntime {
                cadence: OAUTH_REFRESH_INTERVAL,
                quota_cadence: PROVIDER_QUOTA_POLL_INTERVAL,
                snapshot_cadence: CONTROL_SNAPSHOT_SYNC_INTERVAL,
                config: OAuthRefreshConfig::production()?,
            },
        )
        .await
    }

    #[doc(hidden)]
    pub async fn new_with_oauth_refresh_endpoints(
        database: Arc<crate::storage::Database>,
        admin_key: &str,
        encryption_key: &str,
        allow_private: bool,
        codex_endpoint: reqwest::Url,
        claude_endpoint: reqwest::Url,
    ) -> Result<Self, &'static str> {
        if codex_endpoint.scheme() != "http"
            || claude_endpoint.scheme() != "http"
            || !codex_endpoint.host_str().is_some_and(|host| {
                host.parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
            })
            || !claude_endpoint.host_str().is_some_and(|host| {
                host.parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
            })
        {
            return Err("test OAuth endpoints must be loopback HTTP URLs");
        }
        Self::new_with_runtime_options(
            database,
            admin_key,
            encryption_key,
            allow_private,
            crate::catalog::EXPECTED_SOURCE,
            MODEL_CATALOG_SYNC_INTERVAL,
            OAuthRefreshRuntime {
                cadence: Duration::from_secs(3_600),
                quota_cadence: Duration::from_secs(3_600),
                snapshot_cadence: Duration::from_millis(100),
                config: OAuthRefreshConfig::testing(codex_endpoint, claude_endpoint),
            },
        )
        .await
    }

    async fn new_with_runtime_options(
        database: Arc<crate::storage::Database>,
        admin_key: &str,
        encryption_key: &str,
        allow_private: bool,
        catalog_source: &str,
        catalog_poll_interval: Duration,
        oauth_refresh: OAuthRefreshRuntime,
    ) -> Result<Self, &'static str> {
        if !(32..=512).contains(&admin_key.len()) {
            return Err("RED_ROUTER_ADMIN_KEY must be 32-512 bytes");
        }
        if !(16..=512).contains(&encryption_key.len()) {
            return Err("STORAGE_ENCRYPTION_KEY must be 16-512 bytes");
        }
        if !(Duration::from_millis(10)..=Duration::from_secs(3_600))
            .contains(&catalog_poll_interval)
        {
            return Err("invalid model catalog poll interval");
        }
        if !(Duration::from_secs(1)..=Duration::from_secs(3_600)).contains(&oauth_refresh.cadence) {
            return Err("invalid OAuth refresh interval");
        }
        if !(Duration::from_secs(10)..=Duration::from_secs(3_600))
            .contains(&oauth_refresh.quota_cadence)
        {
            return Err("invalid provider quota refresh interval");
        }
        if !(Duration::from_millis(10)..=Duration::from_secs(3_600))
            .contains(&oauth_refresh.snapshot_cadence)
        {
            return Err("invalid control snapshot interval");
        }
        let OAuthRefreshRuntime {
            cadence: oauth_refresh_cadence,
            quota_cadence,
            snapshot_cadence,
            config: oauth_refresh_config,
        } = oauth_refresh;
        let mut breakers = HashMap::new();
        for record in database.breakers().await? {
            let id = record.provider_id.clone();
            if breakers
                .insert(
                    id,
                    Arc::new(ProviderCircuit::from_stored(&record, database.clone())?),
                )
                .is_some()
            {
                return Err("duplicate provider breaker state");
            }
        }
        let mut quotas = HashMap::new();
        for record in database.provider_quotas().await? {
            validate_stored_quota(&record)?;
            let state = Arc::new(TargetQuota::default());
            state.update(&record);
            if quotas.insert(record.provider_id.clone(), state).is_some() {
                return Err("duplicate provider quota state");
            }
        }
        let mut model_quotas = HashMap::new();
        for record in database.provider_model_quotas().await? {
            validate_stored_model_quota(&record)?;
            let state = Arc::new(TargetQuota::default());
            state.update_model(&record);
            if model_quotas
                .insert((record.provider_id.clone(), record.model_id.clone()), state)
                .is_some()
            {
                return Err("duplicate provider model quota state");
            }
        }
        let mut availability = HashMap::new();
        for record in database.provider_availability().await? {
            let id = record.provider_id.clone();
            if availability
                .insert(
                    id,
                    Arc::new(ProviderAvailability::from_stored(
                        &record,
                        database.clone(),
                    )?),
                )
                .is_some()
            {
                return Err("duplicate provider availability state");
            }
        }
        let runtime_settings = database
            .runtime_settings()
            .await?
            .as_ref()
            .map(runtime_settings_view)
            .transpose()?
            .unwrap_or_default();
        let mut breaker_overrides = HashMap::new();
        for record in database.breaker_overrides().await? {
            let id = record.provider_id.clone();
            if breaker_overrides
                .insert(id, stored_breaker_profile(&record)?)
                .is_some()
            {
                return Err("duplicate provider breaker override");
            }
        }
        let oauth_provider_ids = database
            .provider_oauth()
            .await?
            .into_iter()
            .map(|record| record.provider_id)
            .collect();
        let stored_oidc = database.oidc_config().await?;
        let oidc = stored_oidc
            .as_ref()
            .map(|record| crate::oidc::OidcVerifier::from_stored(record, allow_private))
            .transpose()?
            .map(Arc::new);
        let oidc_browser = match (stored_oidc.as_ref(), database.oidc_browser_config().await?) {
            (Some(policy), Some(browser)) if policy.revision == browser.revision => Some(Arc::new(
                crate::oidc::OidcBrowserConfig::from_stored(&browser)?,
            )),
            _ => None,
        };
        let provider_models = provider_models::ModelOverrides::load(&database).await?;
        let model_aliases = model_aliases::AliasSnapshot::load(&database).await?;
        let bundled_catalog = crate::catalog::bundled_catalog()?;
        let stored_catalog = database.model_catalog_snapshot().await?;
        let (catalog, source, catalog_revision, rejected_revision, catalog_error) =
            match stored_catalog {
                Some(snapshot) => {
                    match crate::catalog::ModelCatalog::from_snapshot(&snapshot.snapshot_json)
                        .and_then(|catalog| catalog.validate_all())
                        .and_then(|()| {
                            // Validate with a disposable catalog so the active instance
                            // starts with empty per-provider caches.
                            crate::catalog::ModelCatalog::from_snapshot(&snapshot.snapshot_json)
                        }) {
                        Ok(catalog) => (
                            Arc::new(catalog),
                            "persisted",
                            Some(snapshot.revision),
                            None,
                            None,
                        ),
                        Err(_) => (
                            bundled_catalog,
                            "bundled",
                            None,
                            Some(snapshot.revision),
                            Some("persisted snapshot rejected".to_owned()),
                        ),
                    }
                }
                None => (bundled_catalog, "bundled", None, None, None),
            };
        let catalog_source = validate_catalog_source(catalog_source, allow_private)?;
        let catalog_client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .map_err(|_| "cannot initialize models.dev client")?;
        let oauth_refresh_client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "cannot initialize OAuth refresh client")?;
        let sqlite = database.is_sqlite().await;
        // An anonymous/temporary in-memory database cannot be reopened through
        // another physical connection. It uses the regular signature polling
        // path instead; durable SQLite files get the dedicated observer.
        let sqlite_changes = if sqlite
            && database
                .sql_pool()
                .is_some_and(SqliteChangeWatcher::supports)
        {
            Some(tokio::sync::Mutex::new(
                SqliteChangeWatcher::new(
                    database
                        .sql_pool()
                        .ok_or("cannot initialize control snapshot watcher")?,
                )
                .await?,
            ))
        } else {
            None
        };
        let native_usage = if sqlite {
            Some(crate::native_usage::NativeUsage::new(database.clone())?)
        } else {
            None
        };
        let plane = Self(Arc::new(Inner {
            provider_models: RwLock::new(Some(Arc::new(provider_models))),
            model_aliases: RwLock::new(Some(Arc::new(model_aliases))),
            database,
            current: RwLock::new(None),
            clients: RwLock::new(ClientSnapshot::Unavailable),
            routes: RwLock::new(RouteSnapshot::Unavailable),
            quotas: RwLock::new(quotas),
            model_quotas: RwLock::new(model_quotas),
            breakers: RwLock::new(breakers),
            breaker_overrides: RwLock::new(breaker_overrides),
            oauth_provider_ids: RwLock::new(oauth_provider_ids),
            availability: RwLock::new(availability),
            runtime_settings: RwLock::new(runtime_settings),
            oidc: RwLock::new(oidc),
            oidc_browser: RwLock::new(oidc_browser),
            sqlite_changes,
            provider_snapshot_signature: RwLock::new([0; 32]),
            oidc_snapshot_signature: RwLock::new([0; 32]),
            catalog: RwLock::new(CatalogState {
                catalog,
                source,
                revision: catalog_revision,
                rejected_revision,
                last_error: catalog_error,
            }),
            catalog_refresh: tokio::sync::Mutex::new(()),
            catalog_client,
            catalog_source,
            oauth_refresh_client,
            oauth_refresh: oauth_refresh_config,
            native_usage: RwLock::new(native_usage),
            thought_signatures: StdMutex::new(HashMap::new()),
            claude_sessions: StdMutex::new(HashMap::new()),
            context_relay_generations: StdMutex::new(HashSet::new()),
            mutation: tokio::sync::Mutex::new(()),
            node_header_cache: tokio::sync::Mutex::new(HashMap::new()),
            admin_hash: Sha256::digest(admin_key.as_bytes()).into(),
            encryption_key: Zeroizing::new(encryption_key.to_owned()),
            allow_private,
        }));
        plane.refresh().await?;
        plane.refresh_clients().await?;
        plane.refresh_routes().await?;
        plane.refresh_availability_profiles().await?;
        plane.refresh_breaker_profiles().await?;
        *plane.0.provider_snapshot_signature.write().await =
            plane.provider_runtime_signature().await?;
        *plane.0.oidc_snapshot_signature.write().await = plane.oidc_runtime_signature().await?;
        plane.spawn_model_catalog_sync(catalog_poll_interval);
        plane.spawn_client_policy_sync(CLIENT_POLICY_SYNC_INTERVAL);
        plane.spawn_control_snapshot_sync(snapshot_cadence);
        if sqlite {
            plane.spawn_model_catalog_auto_refresh();
            plane.spawn_oauth_refresh_sync(oauth_refresh_cadence);
            plane.spawn_provider_quota_sync(quota_cadence);
            plane.spawn_usage_maintenance(USAGE_MAINTENANCE_INTERVAL);
        }
        Ok(plane)
    }

    /// Enable Rust-owned token and spend accounting. The SQL storage selected
    /// by the caller must be SQLite; other backends remain fail-closed until
    /// they gain an equivalent atomic reservation implementation.
    pub async fn enable_sqlite_usage(&self) -> Result<(), &'static str> {
        let usage = crate::native_usage::NativeUsage::new(self.0.database.clone())?;
        *self.0.native_usage.write().await = Some(usage);
        // Existing quota-bearing keys must become visible only after their
        // enforcement store is ready.
        self.refresh_clients().await
    }

    fn spawn_client_policy_sync(&self, cadence: Duration) {
        let weak = Arc::downgrade(&self.0);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(cadence);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let plane = ControlPlane(inner);
                let _mutation = plane.0.mutation.lock().await;
                if plane.refresh_clients().await.is_err() {
                    *plane.0.clients.write().await = ClientSnapshot::Unavailable;
                }
            }
        });
    }

    fn spawn_usage_maintenance(&self, cadence: Duration) {
        let weak = Arc::downgrade(&self.0);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(cadence);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // Startup must not contend with schema initialization, exporters or
            // the first inference burst. The first maintenance pass is delayed.
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let plane = ControlPlane(inner);
                if let Err(error) = plane.maintain_native_usage(None).await {
                    eprintln!("Rust usage maintenance failed: {error}");
                }
            }
        });
    }

    fn spawn_control_snapshot_sync(&self, cadence: Duration) {
        let weak = Arc::downgrade(&self.0);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(cadence);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let plane = ControlPlane(inner);
                match plane.control_snapshot_changed().await {
                    Ok(true) => {}
                    Ok(false) => continue,
                    // The watcher has not acknowledged this data version, so a
                    // transient SQLite read failure will be retried next tick.
                    // Keep the last complete snapshot available meanwhile.
                    Err(_) => continue,
                }
                let provider = plane.sync_provider_snapshot().await;
                let oidc = plane.sync_oidc_snapshot().await;
                if provider.is_ok() && oidc.is_ok() {
                    plane.acknowledge_control_snapshot().await;
                }
            }
        });
    }

    async fn control_snapshot_changed(&self) -> Result<bool, &'static str> {
        match &self.0.sqlite_changes {
            Some(watcher) => watcher.lock().await.changed().await,
            None => Ok(true),
        }
    }

    async fn acknowledge_control_snapshot(&self) {
        if let Some(watcher) = &self.0.sqlite_changes {
            watcher.lock().await.acknowledge();
        }
    }

    async fn sync_provider_snapshot(&self) -> Result<(), &'static str> {
        // The watcher also observes writes from this instance. Read signatures
        // under the mutation lock so an in-progress local multi-record update
        // cannot clear a valid runtime or prime a second OIDC verifier.
        let _mutation = self.0.mutation.lock().await;
        let latest = match self.provider_runtime_signature().await {
            Ok(signature) => signature,
            Err(error) => {
                *self.0.current.write().await = None;
                *self.0.routes.write().await = RouteSnapshot::Unavailable;
                return Err(error);
            }
        };
        if *self.0.provider_snapshot_signature.read().await == latest {
            return Ok(());
        }
        if let Err(error) = self.refresh_model_aliases().await {
            *self.0.current.write().await = None;
            *self.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        if let Err(error) = self.refresh_provider_models().await {
            *self.0.current.write().await = None;
            *self.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        if let Err(error) = self.refresh().await {
            *self.0.current.write().await = None;
            *self.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        if let Err(error) = self.refresh_quotas().await {
            *self.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        self.refresh_runtime_settings().await?;
        if let Err(error) = self.refresh_routes().await {
            *self.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        self.refresh_availability_profiles().await?;
        *self.0.provider_snapshot_signature.write().await = latest;
        Ok(())
    }

    async fn refresh_runtime_settings(&self) -> Result<(), &'static str> {
        let settings = self
            .0
            .database
            .runtime_settings()
            .await?
            .as_ref()
            .map(runtime_settings_view)
            .transpose()?
            .unwrap_or_default();
        *self.0.runtime_settings.write().await = settings;
        Ok(())
    }

    async fn refresh_availability_profiles(&self) -> Result<(), &'static str> {
        let oauth_provider_ids: HashSet<_> = self
            .0
            .database
            .provider_oauth()
            .await?
            .into_iter()
            .map(|record| record.provider_id)
            .collect();
        let settings = self.0.runtime_settings.read().await.clone();
        for (provider_id, availability) in self.0.availability.read().await.iter() {
            let configured = if oauth_provider_ids.contains(provider_id) {
                &settings.oauth_connection_cooldown
            } else {
                &settings.apikey_connection_cooldown
            };
            availability.configure_cooldown(connection_cooldown_profile(configured)?)?;
        }
        Ok(())
    }

    async fn refresh_breaker_profiles(&self) -> Result<(), &'static str> {
        let oauth_provider_ids: HashSet<_> = self
            .0
            .database
            .provider_oauth()
            .await?
            .into_iter()
            .map(|record| record.provider_id)
            .collect();
        let overrides: HashMap<_, _> = self
            .0
            .database
            .breaker_overrides()
            .await?
            .into_iter()
            .map(|record| {
                let profile = stored_breaker_profile(&record)?;
                Ok((record.provider_id, profile))
            })
            .collect::<Result<_, &'static str>>()?;
        let local_provider_ids: HashSet<_> = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .filter(|provider| local_endpoint(&provider.upstream_url))
            .map(|provider| provider.id)
            .collect();
        let settings = self.0.runtime_settings.read().await.clone();
        let circuits: Vec<_> = self
            .0
            .breakers
            .read()
            .await
            .iter()
            .map(|(id, circuit)| (id.clone(), circuit.clone()))
            .collect();
        for (provider_id, circuit) in circuits {
            let profile = if let Some(profile) = overrides.get(&provider_id).copied() {
                profile
            } else if local_provider_ids.contains(&provider_id) {
                CircuitProfile::local_default()
            } else if oauth_provider_ids.contains(&provider_id) {
                breaker_profile(&settings.oauth_provider_breaker)?
            } else {
                breaker_profile(&settings.apikey_provider_breaker)?
            };
            circuit
                .configure(
                    profile.failure_threshold,
                    profile.degradation_threshold,
                    profile.reset_timeout_ms,
                )
                .await?;
        }
        *self.0.oauth_provider_ids.write().await = oauth_provider_ids;
        *self.0.breaker_overrides.write().await = overrides;
        Ok(())
    }

    async fn sync_oidc_snapshot(&self) -> Result<(), &'static str> {
        // The watcher also observes writes from this instance. Read signatures
        // under the mutation lock so an in-progress local multi-record update
        // cannot clear a valid runtime or prime a second OIDC verifier.
        let _mutation = self.0.mutation.lock().await;
        let latest = match self.oidc_runtime_signature().await {
            Ok(signature) => signature,
            Err(error) => {
                self.clear_oidc_runtime().await;
                return Err(error);
            }
        };
        if *self.0.oidc_snapshot_signature.read().await == latest {
            return Ok(());
        }
        if let Err(error) = self.refresh_oidc().await {
            self.clear_oidc_runtime().await;
            return Err(error);
        }
        *self.0.oidc_snapshot_signature.write().await = latest;
        Ok(())
    }

    fn spawn_oauth_refresh_sync(&self, cadence: Duration) {
        let weak = Arc::downgrade(&self.0);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(cadence);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let plane = ControlPlane(inner);
                let Ok(now) = unix_time_seconds()
                    .and_then(|value| i64::try_from(value).map_err(|_| "system clock is invalid"))
                else {
                    continue;
                };
                let Ok(providers) = plane.0.database.providers().await else {
                    continue;
                };
                let Ok(auth) = plane.auth_settings().await else {
                    continue;
                };
                let Ok(oauth) = plane.oauth_settings().await else {
                    continue;
                };
                let Ok(statuses) = plane.oauth_status_settings().await else {
                    continue;
                };
                for provider in providers {
                    let key = (provider.id.clone(), provider.updated_at);
                    let Some(provider_auth) = auth.get(&key) else {
                        continue;
                    };
                    let Some(provider_oauth) = oauth.get(&key) else {
                        continue;
                    };
                    if !provider.enabled
                        || provider_auth.expires_at_unix > now + OAUTH_REFRESH_LEAD_SECONDS
                        || statuses
                            .get(&(
                                provider.id.clone(),
                                provider.updated_at,
                                provider_oauth.generation,
                            ))
                            .is_some_and(|status| status.refresh_state == "reauth_required")
                    {
                        continue;
                    }
                    let _ = plane
                        .refresh_provider_oauth_as(&provider.id, None, None)
                        .await;
                }
            }
        });
    }

    fn spawn_provider_quota_sync(&self, cadence: Duration) {
        let weak = Arc::downgrade(&self.0);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(cadence);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let plane = ControlPlane(inner);
                let Ok(providers) = plane.0.database.providers().await else {
                    continue;
                };
                let Ok(oauth) = plane.oauth_settings().await else {
                    continue;
                };
                let mut attempted = false;
                for provider in providers {
                    let Some(settings) = oauth.get(&(provider.id.clone(), provider.updated_at))
                    else {
                        continue;
                    };
                    if !provider.enabled
                        || !matches!(settings.oauth_provider.as_str(), "codex" | "claude" | "agy")
                    {
                        continue;
                    }
                    if attempted {
                        tokio::time::sleep(PROVIDER_QUOTA_POLL_GAP).await;
                    }
                    attempted = true;
                    let _ = plane
                        .refresh_provider_quota_as(&provider.id, None, None)
                        .await;
                }
            }
        });
    }

    async fn refresh_provider_quota_as(
        &self,
        id: &str,
        actor: Option<&str>,
        enforced_tenant: Option<&str>,
    ) -> Result<ProviderQuotaRefreshView, &'static str> {
        validate_id(id)?;
        if let Some(actor) = actor {
            validate_actor(actor)?;
        }
        let (provider, auth, oauth) = self.provider_oauth_records(id, enforced_tenant).await?;
        if !matches!(oauth.oauth_provider.as_str(), "codex" | "claude" | "agy") {
            return Ok(quota_refresh_view(id, false, "unsupported_provider", None));
        }
        let now_seconds =
            i64::try_from(unix_time_seconds()?).map_err(|_| "system clock is invalid")?;
        if auth.expires_at_unix <= now_seconds {
            return Ok(quota_refresh_view(id, false, "credential_expired", None));
        }
        let owner = random_token(18)?;
        let now_ms = unix_time_ms()?;
        let lease_until = now_ms
            .checked_add(PROVIDER_QUOTA_LEASE_MS)
            .ok_or("system clock is invalid")?;
        let lease_group = format!("quota:{id}");
        if !self
            .0
            .database
            .acquire_oauth_refresh_lease(&lease_group, &owner, now_ms, lease_until)
            .await?
        {
            return Ok(quota_refresh_view(id, false, "refresh_in_progress", None));
        }
        let fetched = self.fetch_provider_quota(&provider, &oauth).await;
        let next_allowed = now_ms
            .checked_add(i64::try_from(PROVIDER_QUOTA_POLL_INTERVAL.as_millis()).unwrap_or(60_000))
            .ok_or("system clock is invalid")?;
        self.0
            .database
            .release_oauth_refresh_lease(&lease_group, &owner, next_allowed)
            .await?;
        let observation = match fetched {
            Ok(observation) => observation,
            Err(category) => return Ok(quota_refresh_view(id, false, category, None)),
        };
        let _mutation = self.0.mutation.lock().await;
        let current = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|candidate| candidate.id == id)
            .ok_or("provider does not exist")?;
        if current.updated_at != provider.updated_at || !current.enabled {
            return Ok(quota_refresh_view(id, false, "superseded", None));
        }
        let observed_at_unix_ms = unix_time_ms()?;
        let ttl_ms = i64::try_from(PROVIDER_QUOTA_TTL_SECONDS * 1_000)
            .map_err(|_| "provider quota TTL is out of range")?;
        let record =
            automatic_quota_record(id, observation.aggregate, observed_at_unix_ms, ttl_ms)?;
        let model_records = observation
            .models
            .into_iter()
            .map(|model| {
                automatic_model_quota_record(
                    id,
                    &model.model_id,
                    model.quota,
                    observed_at_unix_ms,
                    ttl_ms,
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        let before = self
            .0
            .database
            .provider_quotas()
            .await?
            .into_iter()
            .find(|quota| quota.provider_id == id)
            .map(|quota| quota_view(&quota))
            .transpose()?;
        self.0.database.upsert_provider_quota(&record).await?;
        self.0
            .database
            .replace_provider_model_quotas(id, &model_records)
            .await?;
        self.quota_state(id).await.update(&record);
        self.replace_model_quota_states(id, &model_records).await;
        let mut quota = quota_view(&record)?;
        quota.models = model_records
            .iter()
            .map(model_quota_view)
            .collect::<Result<Vec<_>, _>>()?;
        if let Some(actor) = actor {
            self.record_audit_event(
                AuditContext {
                    action: "provider_quota.refresh",
                    actor,
                    tenant_id: &provider.tenant_id,
                    target: id,
                    resource_type: "provider_quota",
                },
                before.as_ref(),
                Some(&quota),
            )
            .await;
        }
        Ok(quota_refresh_view(id, true, "refreshed", Some(quota)))
    }

    async fn fetch_provider_quota(
        &self,
        provider: &StoredProvider,
        oauth: &StoredProviderOAuth,
    ) -> Result<crate::provider_quota::Observation, &'static str> {
        let access_token = decrypt_async(
            &provider.credential_ciphertext,
            &provider.id,
            self.0.encryption_key.as_str(),
        )
        .await
        .map_err(|_| "credential_unavailable")?;
        if oauth.oauth_provider == "agy" {
            return self.fetch_agy_quota(provider, access_token.as_str()).await;
        }
        let request = match oauth.oauth_provider.as_str() {
            "codex" => {
                let account_id = self
                    .codex_quota_account_id(provider)
                    .await
                    .map_err(|_| "session_unavailable")?;
                self.0
                    .oauth_refresh_client
                    .get(self.0.oauth_refresh.codex_quota_endpoint.clone())
                    .bearer_auth(access_token.as_str())
                    .header(header::ACCEPT, "application/json")
                    .header(header::USER_AGENT, CODEX_USAGE_USER_AGENT)
                    .header("originator", "codex_cli_rs")
                    .header("version", CODEX_USAGE_VERSION)
                    .header("chatgpt-account-id", account_id)
            }
            "claude" => self
                .0
                .oauth_refresh_client
                .get(self.0.oauth_refresh.claude_quota_endpoint.clone())
                .bearer_auth(access_token.as_str())
                .header(header::ACCEPT, "application/json, text/plain, */*")
                .header(header::USER_AGENT, CLAUDE_USAGE_USER_AGENT)
                .header("anthropic-beta", "oauth-2025-04-20"),
            _ => return Err("unsupported_provider"),
        };
        let response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                "timeout"
            } else {
                "unavailable"
            }
        })?;
        let status = response.status();
        if !status.is_success() {
            return Err(if status == StatusCode::TOO_MANY_REQUESTS {
                "rate_limited"
            } else if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
                "authorization_failed"
            } else if status.is_server_error() {
                "upstream_error"
            } else {
                "request_rejected"
            });
        }
        let body = read_bounded_response(response, PROVIDER_QUOTA_MAX_BODY_BYTES)
            .await
            .map_err(|_| "invalid_response")?;
        let value: serde_json::Value =
            serde_json::from_slice(&body).map_err(|_| "invalid_response")?;
        let aggregate = match oauth.oauth_provider.as_str() {
            "codex" => crate::provider_quota::parse_codex(
                &value,
                u64::try_from(unix_time_ms()?).map_err(|_| "invalid_response")?,
            )
            .map_err(|_| "invalid_response"),
            "claude" => crate::provider_quota::parse_claude(&value).map_err(|_| "invalid_response"),
            _ => Err("unsupported_provider"),
        }?;
        Ok(crate::provider_quota::Observation {
            aggregate,
            models: Vec::new(),
        })
    }

    async fn fetch_agy_quota(
        &self,
        provider: &StoredProvider,
        access_token: &str,
    ) -> Result<crate::provider_quota::Observation, &'static str> {
        let project = self
            .agy_quota_project_id(provider)
            .await
            .map_err(|_| "session_unavailable")?;
        let user_quota = self
            .fetch_agy_quota_value(
                &self.0.oauth_refresh.agy_quota_endpoints,
                access_token,
                &project,
            )
            .await?;
        // The summary RPC is undocumented and absent for some account tiers.
        // Session telemetry remains useful when this optional weekly source is
        // unavailable, so do not discard a valid model-bucket observation.
        let summary = self
            .fetch_agy_quota_value(
                &self.0.oauth_refresh.agy_quota_summary_endpoints,
                access_token,
                &project,
            )
            .await
            .ok();
        crate::provider_quota::parse_antigravity_observation(&user_quota, summary.as_ref())
            .map_err(|_| "invalid_response")
    }

    async fn fetch_agy_quota_value(
        &self,
        endpoints: &[reqwest::Url],
        access_token: &str,
        project: &str,
    ) -> Result<serde_json::Value, &'static str> {
        let body = serde_json::json!({"project":project}).to_string();
        let mut last_error = "unavailable";
        for endpoint in endpoints {
            let response = self
                .0
                .oauth_refresh_client
                .post(endpoint.clone())
                .bearer_auth(access_token)
                .header(header::ACCEPT, "application/json")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::USER_AGENT, AGY_QUOTA_USER_AGENT)
                .header("x-goog-user-project", project)
                .body(body.clone())
                .send()
                .await;
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    last_error = if error.is_timeout() {
                        "timeout"
                    } else {
                        "unavailable"
                    };
                    continue;
                }
            };
            let status = response.status();
            if status == StatusCode::TOO_MANY_REQUESTS {
                return Err("rate_limited");
            }
            if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
                return Err("authorization_failed");
            }
            if status.is_server_error() {
                last_error = "upstream_error";
                continue;
            }
            if !status.is_success() {
                return Err("request_rejected");
            }
            let bytes = match read_bounded_response(response, PROVIDER_QUOTA_MAX_BODY_BYTES).await {
                Ok(bytes) => bytes,
                Err(_) => {
                    last_error = "invalid_response";
                    continue;
                }
            };
            match serde_json::from_slice(&bytes) {
                Ok(value) => return Ok(value),
                Err(_) => last_error = "invalid_response",
            }
        }
        Err(last_error)
    }

    async fn agy_quota_project_id(
        &self,
        provider: &StoredProvider,
    ) -> Result<String, &'static str> {
        let session = self
            .0
            .database
            .provider_sessions()
            .await?
            .into_iter()
            .find(|session| {
                session.provider_id == provider.id
                    && session.revision == provider.updated_at
                    && session.provider == "agy"
            })
            .ok_or("session_unavailable")?;
        let aad = format!("{}:oauth-session", provider.id);
        let metadata = decrypt_async(
            &session.session_ciphertext,
            &aad,
            self.0.encryption_key.as_str(),
        )
        .await?;
        let metadata: serde_json::Value =
            serde_json::from_str(metadata.as_str()).map_err(|_| "session_unavailable")?;
        let project =
            json_non_empty_string(metadata.get("projectId")).ok_or("session_unavailable")?;
        if project.len() > 256 || project.chars().any(char::is_control) {
            return Err("session_unavailable");
        }
        Ok(project.to_owned())
    }

    async fn codex_quota_account_id(
        &self,
        provider: &StoredProvider,
    ) -> Result<String, &'static str> {
        let session = self
            .0
            .database
            .provider_sessions()
            .await?
            .into_iter()
            .find(|session| {
                session.provider_id == provider.id
                    && session.revision == provider.updated_at
                    && session.provider == "codex"
            })
            .ok_or("session_unavailable")?;
        let aad = format!("{}:oauth-session", provider.id);
        let metadata = decrypt_async(
            &session.session_ciphertext,
            &aad,
            self.0.encryption_key.as_str(),
        )
        .await?;
        let metadata: serde_json::Value =
            serde_json::from_str(metadata.as_str()).map_err(|_| "session_unavailable")?;
        let id_token =
            json_non_empty_string(metadata.get("id_token")).ok_or("session_unavailable")?;
        let claims = decode_unverified_jwt_payload(id_token).ok_or("session_unavailable")?;
        let auth = claims
            .get("https://api.openai.com/auth")
            .and_then(serde_json::Value::as_object);
        let account_id = auth
            .and_then(|auth| json_non_empty_string(auth.get("chatgpt_account_id")))
            .or_else(|| auth.and_then(|auth| json_non_empty_string(auth.get("account_id"))))
            .ok_or("session_unavailable")?;
        if account_id.len() > 512 || account_id.chars().any(char::is_control) {
            return Err("session_unavailable");
        }
        Ok(account_id.to_owned())
    }

    async fn refresh_provider_oauth_as(
        &self,
        id: &str,
        actor: Option<&str>,
        enforced_tenant: Option<&str>,
    ) -> Result<ProviderOAuthRefreshView, &'static str> {
        validate_id(id)?;
        if let Some(actor) = actor {
            validate_actor(actor)?;
        }
        let (provider, auth, oauth) = self.provider_oauth_records(id, enforced_tenant).await?;
        if let Some(status) = self.oauth_status_settings().await?.get(&(
            id.to_owned(),
            provider.updated_at,
            oauth.generation,
        )) {
            if status.refresh_state == "reauth_required" {
                let refresh = oauth_refresh_view(
                    id,
                    false,
                    "reauth_required",
                    None,
                    oauth.generation,
                    auth.expires_at_unix,
                );
                self.record_provider_oauth_refresh_audit(actor, &provider.tenant_id, id, &refresh)
                    .await;
                return Ok(refresh);
            }
        }
        let rotation_group = oauth_rotation_group(&oauth.oauth_provider)?;
        let owner = random_token(18)?;
        let now_ms = unix_time_ms()?;
        let lease_until = now_ms
            .checked_add(OAUTH_REFRESH_LEASE_MS)
            .ok_or("system clock is invalid")?;
        if !self
            .0
            .database
            .acquire_oauth_refresh_lease(rotation_group, &owner, now_ms, lease_until)
            .await?
        {
            let refresh = oauth_refresh_view(
                id,
                false,
                "refresh_in_progress",
                None,
                oauth.generation,
                auth.expires_at_unix,
            );
            self.record_provider_oauth_refresh_audit(actor, &provider.tenant_id, id, &refresh)
                .await;
            return Ok(refresh);
        }

        // A different replica may have completed a rotation immediately before
        // this lease was acquired. Re-read the durable generation and token.
        let records = self.provider_oauth_records(id, enforced_tenant).await;
        let outcome = match records {
            Ok((fresh_provider, fresh_auth, fresh_oauth)) => {
                match self.oauth_status_settings().await {
                    Ok(statuses) => {
                        if statuses
                            .get(&(
                                id.to_owned(),
                                fresh_provider.updated_at,
                                fresh_oauth.generation,
                            ))
                            .is_some_and(|status| status.refresh_state == "reauth_required")
                        {
                            Ok(oauth_refresh_view(
                                id,
                                false,
                                "reauth_required",
                                None,
                                fresh_oauth.generation,
                                fresh_auth.expires_at_unix,
                            ))
                        } else {
                            self.exchange_and_persist_oauth(fresh_provider, fresh_auth, fresh_oauth)
                                .await
                        }
                    }
                    Err(error) => Err(error),
                }
            }
            Err(error) => Err(error),
        };
        let next_allowed = unix_time_ms()
            .unwrap_or(now_ms)
            .saturating_add(OAUTH_REFRESH_SETTLE_MS);
        let _ = self
            .0
            .database
            .release_oauth_refresh_lease(rotation_group, &owner, next_allowed)
            .await;
        if let Ok(refresh) = &outcome {
            self.record_provider_oauth_refresh_audit(actor, &provider.tenant_id, id, refresh)
                .await;
        }
        outcome
    }

    async fn record_provider_oauth_refresh_audit(
        &self,
        actor: Option<&str>,
        tenant_id: &str,
        provider_id: &str,
        refresh: &ProviderOAuthRefreshView,
    ) {
        let Some(actor) = actor else {
            return;
        };
        self.record_audit_event(
            AuditContext {
                action: "provider_oauth.refresh",
                actor,
                tenant_id,
                target: provider_id,
                resource_type: "provider_oauth",
            },
            Option::<&ProviderOAuthRefreshView>::None,
            Some(refresh),
        )
        .await;
    }

    async fn provider_oauth_records(
        &self,
        id: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<(StoredProvider, StoredProviderAuth, StoredProviderOAuth), &'static str> {
        let provider = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|record| record.id == id)
            .ok_or("provider configuration not found")?;
        if enforced_tenant.is_some_and(|tenant| tenant != provider.tenant_id) {
            return Err("provider tenant is unavailable");
        }
        if !provider.enabled {
            return Err("provider is disabled");
        }
        let key = (provider.id.clone(), provider.updated_at);
        let auth = self
            .auth_settings()
            .await?
            .remove(&key)
            .ok_or("provider authentication configuration not found")?;
        let oauth = self
            .oauth_settings()
            .await?
            .remove(&key)
            .ok_or("provider OAuth configuration not found")?;
        Ok((provider, auth, oauth))
    }

    async fn exchange_and_persist_oauth(
        &self,
        provider: StoredProvider,
        auth: StoredProviderAuth,
        oauth: StoredProviderOAuth,
    ) -> Result<ProviderOAuthRefreshView, &'static str> {
        let aad = format!("{}:oauth-refresh", provider.id);
        let refresh_token = decrypt_async(
            &oauth.refresh_token_ciphertext,
            &aad,
            self.0.encryption_key.as_str(),
        )
        .await?;
        match self
            .exchange_oauth_token(&oauth.oauth_provider, refresh_token.as_str())
            .await
        {
            Ok(tokens) => {
                let access_ciphertext = encrypt_async(
                    tokens.access_token.as_str(),
                    &provider.id,
                    self.0.encryption_key.as_str(),
                )
                .await?;
                let refresh_ciphertext = encrypt_async(
                    tokens.refresh_token.as_str(),
                    &aad,
                    self.0.encryption_key.as_str(),
                )
                .await?;
                let rotated = self
                    .0
                    .database
                    .rotate_provider_oauth_credentials(
                        &provider.id,
                        provider.updated_at,
                        oauth.generation,
                        &access_ciphertext,
                        &refresh_ciphertext,
                        tokens.expires_at_unix,
                    )
                    .await?;
                if !rotated {
                    return Ok(oauth_refresh_view(
                        &provider.id,
                        false,
                        "superseded",
                        None,
                        oauth.generation,
                        auth.expires_at_unix,
                    ));
                }
                let _mutation = self.0.mutation.lock().await;
                if let Err(error) = self.refresh().await {
                    *self.0.current.write().await = None;
                    return Err(error);
                }
                if let Err(error) = self.refresh_routes().await {
                    *self.0.routes.write().await = RouteSnapshot::Unavailable;
                    return Err(error);
                }
                Ok(oauth_refresh_view(
                    &provider.id,
                    true,
                    "refreshed",
                    None,
                    oauth.generation.saturating_add(1),
                    tokens.expires_at_unix,
                ))
            }
            Err(OAuthExchangeFailure::Terminal { code, status }) => {
                let marked = self
                    .0
                    .database
                    .mark_provider_oauth_reauth_required(&StoredProviderOAuthStatus {
                        provider_id: provider.id.clone(),
                        revision: provider.updated_at,
                        generation: oauth.generation,
                        refresh_state: "reauth_required".to_owned(),
                        error_code: code,
                        observed_at_unix: i64::try_from(unix_time_seconds()?)
                            .map_err(|_| "system clock is invalid")?,
                    })
                    .await?;
                if !marked {
                    return Ok(oauth_refresh_view(
                        &provider.id,
                        false,
                        "superseded",
                        Some(status),
                        oauth.generation,
                        auth.expires_at_unix,
                    ));
                }
                Ok(oauth_refresh_view(
                    &provider.id,
                    false,
                    "reauth_required",
                    Some(status),
                    oauth.generation,
                    auth.expires_at_unix,
                ))
            }
            Err(OAuthExchangeFailure::Transient { category, status }) => Ok(oauth_refresh_view(
                &provider.id,
                false,
                category,
                status,
                oauth.generation,
                auth.expires_at_unix,
            )),
        }
    }

    async fn exchange_oauth_token(
        &self,
        oauth_provider: &str,
        refresh_token: &str,
    ) -> Result<OAuthTokenPair, OAuthExchangeFailure> {
        if oauth_provider == "github" {
            return self.exchange_github_copilot_token(refresh_token).await;
        }
        let (endpoint, client_id, client_secret, claude) = match oauth_provider {
            "codex" => (
                &self.0.oauth_refresh.codex_endpoint,
                self.0.oauth_refresh.codex_client_id.as_str(),
                None,
                false,
            ),
            "claude" => (
                &self.0.oauth_refresh.claude_endpoint,
                self.0.oauth_refresh.claude_client_id.as_str(),
                None,
                true,
            ),
            "agy" => {
                let Some(client_id) = self.0.oauth_refresh.agy_client_id.as_deref() else {
                    return Err(OAuthExchangeFailure::Transient {
                        category: "oauth_client_unconfigured",
                        status: None,
                    });
                };
                let Some(client_secret) = self.0.oauth_refresh.agy_client_secret.as_deref() else {
                    return Err(OAuthExchangeFailure::Transient {
                        category: "oauth_client_unconfigured",
                        status: None,
                    });
                };
                (
                    &self.0.oauth_refresh.agy_endpoint,
                    client_id,
                    Some(client_secret),
                    false,
                )
            }
            "xai-oauth" => (
                &self.0.oauth_refresh.xai_endpoint,
                self.0.oauth_refresh.xai_client_id.as_str(),
                None,
                false,
            ),
            "openference" => (
                &self.0.oauth_refresh.openference_endpoint,
                self.0.oauth_refresh.openference_client_id.as_str(),
                None,
                false,
            ),
            _ => {
                return Err(OAuthExchangeFailure::Transient {
                    category: "unsupported_provider",
                    status: None,
                })
            }
        };
        let form = {
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            serializer.append_pair("grant_type", "refresh_token");
            serializer.append_pair("client_id", client_id);
            if let Some(client_secret) = client_secret {
                serializer.append_pair("client_secret", client_secret);
            }
            serializer.append_pair("refresh_token", refresh_token);
            serializer.finish()
        };
        let mut request = self
            .0
            .oauth_refresh_client
            .post(endpoint.clone())
            .header(
                header::CONTENT_TYPE.as_str(),
                "application/x-www-form-urlencoded",
            )
            .body(form);
        if claude {
            request = request.header("anthropic-beta", "oauth-2025-04-20");
        }
        let response = request
            .send()
            .await
            .map_err(|error| OAuthExchangeFailure::Transient {
                category: if error.is_timeout() {
                    "timeout"
                } else {
                    "unavailable"
                },
                status: None,
            })?;
        let status = response.status().as_u16();
        let body = read_bounded_response(response, OAUTH_REFRESH_MAX_BODY_BYTES)
            .await
            .map_err(|category| OAuthExchangeFailure::Transient {
                category,
                status: Some(status),
            })?;
        let value: serde_json::Value = match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(_) if !(200..300).contains(&status) => serde_json::Value::Null,
            Err(_) => {
                return Err(OAuthExchangeFailure::Transient {
                    category: "invalid_response",
                    status: Some(status),
                })
            }
        };
        if !(200..300).contains(&status) {
            let code = oauth_error_code(&value);
            if oauth_terminal_error(oauth_provider, status, &code) {
                return Err(OAuthExchangeFailure::Terminal { code, status });
            }
            return Err(OAuthExchangeFailure::Transient {
                category: if status == 429 {
                    "rate_limited"
                } else if status >= 500 {
                    "upstream_error"
                } else {
                    "request_rejected"
                },
                status: Some(status),
            });
        }
        let access_token = oauth_token_field(&value, "access_token")?;
        let refresh_token = match value
            .get("refresh_token")
            .and_then(serde_json::Value::as_str)
        {
            Some(value) => validate_oauth_token(value)?,
            None => validate_oauth_token(refresh_token)?,
        };
        let expires_in = value
            .get("expires_in")
            .and_then(serde_json::Value::as_i64)
            .filter(|value| (1..=2_678_400).contains(value))
            .ok_or(OAuthExchangeFailure::Transient {
                category: "invalid_response",
                status: Some(status),
            })?;
        let now = unix_time_seconds()
            .ok()
            .and_then(|value| i64::try_from(value).ok())
            .ok_or(OAuthExchangeFailure::Transient {
                category: "invalid_response",
                status: Some(status),
            })?;
        Ok(OAuthTokenPair {
            access_token: Zeroizing::new(access_token),
            refresh_token: Zeroizing::new(refresh_token),
            expires_at_unix: now.saturating_add(expires_in),
        })
    }

    async fn exchange_github_copilot_token(
        &self,
        github_token: &str,
    ) -> Result<OAuthTokenPair, OAuthExchangeFailure> {
        let github_token = validate_oauth_token(github_token)?;
        let request = self
            .0
            .oauth_refresh_client
            .get(self.0.oauth_refresh.github_endpoint.clone())
            .bearer_auth(&github_token);
        let response = crate::github_copilot_refresh_headers(request)
            .send()
            .await
            .map_err(|error| OAuthExchangeFailure::Transient {
                category: if error.is_timeout() {
                    "timeout"
                } else {
                    "unavailable"
                },
                status: None,
            })?;
        let status = response.status().as_u16();
        let body = read_bounded_response(response, OAUTH_REFRESH_MAX_BODY_BYTES)
            .await
            .map_err(|category| OAuthExchangeFailure::Transient {
                category,
                status: Some(status),
            })?;
        let value: serde_json::Value = match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(_) if !(200..300).contains(&status) => serde_json::Value::Null,
            Err(_) => {
                return Err(OAuthExchangeFailure::Transient {
                    category: "invalid_response",
                    status: Some(status),
                })
            }
        };
        if !(200..300).contains(&status) {
            let code = oauth_error_code(&value);
            if oauth_terminal_error("github", status, &code) {
                return Err(OAuthExchangeFailure::Terminal { code, status });
            }
            return Err(OAuthExchangeFailure::Transient {
                category: if status == 429 {
                    "rate_limited"
                } else if status >= 500 {
                    "upstream_error"
                } else {
                    "request_rejected"
                },
                status: Some(status),
            });
        }
        let access_token = value
            .get("token")
            .and_then(serde_json::Value::as_str)
            .ok_or(OAuthExchangeFailure::Transient {
                category: "invalid_response",
                status: Some(status),
            })
            .and_then(validate_oauth_token)?;
        let now = unix_time_seconds()
            .ok()
            .and_then(|value| i64::try_from(value).ok())
            .ok_or(OAuthExchangeFailure::Transient {
                category: "invalid_response",
                status: Some(status),
            })?;
        let expires_at_unix = value
            .get("expires_at")
            .and_then(serde_json::Value::as_i64)
            .filter(|value| *value > now && *value <= now.saturating_add(2_678_400))
            .ok_or(OAuthExchangeFailure::Transient {
                category: "invalid_response",
                status: Some(status),
            })?;
        Ok(OAuthTokenPair {
            access_token: Zeroizing::new(access_token),
            refresh_token: Zeroizing::new(github_token),
            expires_at_unix,
        })
    }

    fn spawn_model_catalog_sync(&self, cadence: Duration) {
        let weak = Arc::downgrade(&self.0);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(cadence);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // Tokio intervals tick immediately. Consume that tick so startup
            // does not duplicate the snapshot validation above.
            ticker.tick().await;
            loop {
                ticker.tick().await;
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let (active_revision, rejected_revision) = {
                    let active = inner.catalog.read().await;
                    (active.revision, active.rejected_revision)
                };
                let database = inner.database.clone();
                drop(inner);
                let Ok(Some(database_revision)) = database.model_catalog_revision().await else {
                    continue;
                };
                if active_revision == Some(database_revision)
                    || rejected_revision == Some(database_revision)
                {
                    continue;
                }
                let Ok(Some(snapshot)) = database.model_catalog_snapshot().await else {
                    continue;
                };
                let snapshot_revision = snapshot.revision;
                let catalog = tokio::task::spawn_blocking(move || {
                    crate::catalog::ModelCatalog::from_snapshot(&snapshot.snapshot_json)
                        .and_then(|catalog| catalog.validate_all())
                        .and_then(|()| {
                            crate::catalog::ModelCatalog::from_snapshot(&snapshot.snapshot_json)
                        })
                })
                .await;
                let Ok(Ok(catalog)) = catalog else {
                    if let Some(inner) = weak.upgrade() {
                        let mut active = inner.catalog.write().await;
                        active.rejected_revision = Some(snapshot_revision);
                        active.last_error = Some("persisted snapshot rejected".to_owned());
                    }
                    continue;
                };
                // A writer may publish again while validation is running. Do
                // not replace a newer generation with the stale row we read.
                if database.model_catalog_revision().await.ok().flatten() != Some(snapshot_revision)
                {
                    continue;
                }
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let mut active = inner.catalog.write().await;
                if active.revision != Some(snapshot_revision) {
                    *active = CatalogState {
                        catalog: Arc::new(catalog),
                        source: "persisted",
                        revision: Some(snapshot_revision),
                        rejected_revision: None,
                        last_error: None,
                    };
                }
            }
        });
    }

    fn spawn_model_catalog_auto_refresh(&self) {
        let weak = Arc::downgrade(&self.0);
        tokio::spawn(async move {
            // Avoid delaying startup or triggering network I/O in short-lived
            // command invocations. Every SQLite replica shares one schedule.
            tokio::time::sleep(MODEL_CATALOG_AUTO_INITIAL_DELAY).await;
            loop {
                let Some(inner) = weak.upgrade() else { return };
                let control = ControlPlane(inner);
                if let Err(error) = control.refresh_model_catalog_if_due().await {
                    eprintln!("Automatic model catalog refresh failed: {error}");
                }
                drop(control);
                tokio::time::sleep(MODEL_CATALOG_AUTO_RETRY).await;
            }
        });
    }

    /// Execute one scheduled attempt. A durable lease suppresses duplicate
    /// refreshes across SQLite replicas and retries errors without replacing
    /// the last usable catalog.
    #[doc(hidden)]
    pub async fn refresh_model_catalog_if_due(&self) -> Result<bool, &'static str> {
        let now = unix_time_ms()?;
        let owner = random_token(18)?;
        if !self
            .0
            .database
            .acquire_model_catalog_refresh_lease(
                &owner,
                now,
                now.saturating_add(MODEL_CATALOG_AUTO_LEASE_MS),
            )
            .await?
        {
            return Ok(false);
        }
        let result =
            tokio::time::timeout(MODEL_CATALOG_AUTO_TIMEOUT, self.refresh_model_catalog()).await;
        if result.is_err() {
            self.0.catalog.write().await.last_error =
                Some("models.dev refresh timed out".to_owned());
        }
        let success = matches!(&result, Ok(Ok(_)));
        let delay = if success {
            MODEL_CATALOG_AUTO_DAY_MS
        } else {
            MODEL_CATALOG_AUTO_RETRY.as_millis() as i64
        };
        let next = unix_time_ms()?.saturating_add(delay);
        if !self
            .0
            .database
            .finish_model_catalog_refresh_lease(&owner, next)
            .await?
        {
            return Err("catalog refresh lease was lost");
        }
        match result {
            Ok(Ok(_)) => Ok(true),
            Ok(Err(error)) => Err(error),
            Err(_) => Err("model catalog refresh timed out"),
        }
    }

    pub(crate) async fn model_catalog(&self) -> Arc<crate::catalog::ModelCatalog> {
        self.0.catalog.read().await.catalog.clone()
    }

    async fn model_catalog_snapshot(
        &self,
    ) -> (Arc<crate::catalog::ModelCatalog>, CatalogRuntimeView) {
        let catalog = self.0.catalog.read().await;
        (
            catalog.catalog.clone(),
            CatalogRuntimeView {
                source: catalog.source,
                revision: catalog.revision.map(|revision| revision.to_string()),
                last_error: catalog.last_error.clone(),
            },
        )
    }

    pub async fn refresh_model_catalog(&self) -> Result<CatalogRefreshView, &'static str> {
        let _refresh = self.0.catalog_refresh.lock().await;
        let (etag, schema_ref) = {
            let active = self.0.catalog.read().await;
            (
                if active.rejected_revision.is_some() {
                    None
                } else {
                    active.catalog.manifest().etag.clone()
                },
                active.catalog.manifest().upstream_schema_ref.clone(),
            )
        };
        let refresh = crate::catalog::refresh_from_source(
            &self.0.catalog_client,
            &self.0.catalog_source,
            etag.as_deref(),
            &schema_ref,
        )
        .await;
        let refresh = match refresh {
            Ok(refresh) => refresh,
            Err(error) => {
                self.0.catalog.write().await.last_error =
                    Some("models.dev refresh failed".to_owned());
                return Err(error);
            }
        };
        match refresh {
            crate::catalog::CatalogRefresh::NotModified => {
                let mut active = self.0.catalog.write().await;
                active.last_error = None;
                Ok(CatalogRefreshView {
                    changed: false,
                    source: active.source,
                    revision: active.revision.map(|revision| revision.to_string()),
                    manifest: active.catalog.manifest().clone(),
                })
            }
            crate::catalog::CatalogRefresh::Updated {
                catalog,
                snapshot_json,
            } => {
                let revision = revision()?;
                let stored = StoredModelCatalogSnapshot {
                    snapshot_json,
                    revision,
                };
                if self
                    .0
                    .database
                    .upsert_model_catalog_snapshot(&stored)
                    .await
                    .is_err()
                {
                    self.0.catalog.write().await.last_error =
                        Some("model catalog storage unavailable".to_owned());
                    return Err("model catalog storage unavailable");
                }
                let manifest = catalog.manifest().clone();
                *self.0.catalog.write().await = CatalogState {
                    catalog,
                    source: "persisted",
                    revision: Some(revision),
                    rejected_revision: None,
                    last_error: None,
                };
                Ok(CatalogRefreshView {
                    changed: true,
                    source: "persisted",
                    revision: Some(revision.to_string()),
                    manifest,
                })
            }
        }
    }

    pub(crate) async fn current(&self) -> Option<LiveProvider> {
        self.0.current.read().await.clone()
    }

    pub(crate) async fn client_policies(
        &self,
    ) -> Result<Option<Arc<ClientPolicies>>, &'static str> {
        match &*self.0.clients.read().await {
            ClientSnapshot::Legacy => Ok(None),
            ClientSnapshot::Current(policies) => Ok(Some(policies.clone())),
            ClientSnapshot::Unavailable => Err("client key storage unavailable"),
        }
    }

    pub(crate) async fn admit_client_request(
        &self,
        identity: &crate::policy::ClientIdentity,
    ) -> Result<Option<bool>, &'static str> {
        let usage = self.0.native_usage.read().await.clone();
        let Some(usage) = usage else {
            return Ok(None);
        };
        let minute = identity
            .max_requests_per_minute
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "invalid client request rate limit")?
            .unwrap_or(0);
        let day = identity
            .max_requests_per_day
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "invalid client request rate limit")?
            .unwrap_or(0);
        if minute == 0 && day == 0 {
            return Ok(Some(true));
        }
        usage
            .admit_request(&identity.id, minute, day, unix_time_ms()?)
            .await
            .map(Some)
    }

    pub(crate) async fn maintain_native_usage(
        &self,
        actor: Option<&str>,
    ) -> Result<crate::native_usage::UsageMaintenanceReport, &'static str> {
        if let Some(actor) = actor {
            validate_actor(actor)?;
        }
        let usage = self
            .0
            .native_usage
            .read()
            .await
            .clone()
            .ok_or("native usage storage unavailable")?;
        let report = usage
            .prune_operational_state(unix_time_ms()?, USAGE_MAINTENANCE_BATCH_SIZE)
            .await?;
        if let Some(actor) = actor {
            let audit_details = serde_json::to_value(&report)
                .map_err(|_| "cannot encode usage maintenance audit")?;
            self.record_audit_event(
                AuditContext {
                    action: "usage.maintenance",
                    actor,
                    tenant_id: "red",
                    target: "operational-counters",
                    resource_type: "usage",
                },
                Option::<&serde_json::Value>::None,
                Some(&audit_details),
            )
            .await;
        }
        Ok(report)
    }

    pub(crate) async fn shared_budget_views(
        &self,
        tenant_id: Option<&str>,
    ) -> Result<Vec<crate::shared_budget::BudgetView>, &'static str> {
        crate::shared_budget::list(&self.0.database, tenant_id, unix_time_ms()?).await
    }

    pub(crate) async fn configure_shared_budget_as(
        &self,
        id: Option<&str>,
        input: crate::shared_budget::BudgetInput,
        actor: &str,
        tenant_scope: Option<&str>,
    ) -> Result<crate::shared_budget::BudgetView, &'static str> {
        validate_actor(actor)?;
        let requested_tenant = input
            .tenant_id
            .clone()
            .unwrap_or_else(|| tenant_scope.unwrap_or("red").to_owned());
        let tenant_id = tenant_scope.unwrap_or(&requested_tenant).to_owned();
        if tenant_scope.is_some_and(|scope| scope != requested_tenant.as_str()) {
            return Err("shared budget tenant mismatch");
        }
        if !self
            .0
            .database
            .tenants()
            .await?
            .iter()
            .any(|tenant| tenant.id == tenant_id && tenant.enabled)
        {
            return Err("shared budget tenant not found");
        }
        if !input.key_ids.is_empty() {
            let keys = self.client_views(Some(&tenant_id)).await?;
            if input
                .key_ids
                .iter()
                .any(|id| !keys.iter().any(|key| key.id == *id))
            {
                return Err("shared budget client key not found");
            }
        }
        let id = id
            .map(str::to_owned)
            .unwrap_or(format!("budget_{}", random_token(12)?));
        let view =
            crate::shared_budget::upsert(&self.0.database, &id, &tenant_id, input, revision()?)
                .await?;
        let details = serde_json::to_value(&view).map_err(|_| "cannot encode shared budget")?;
        self.record_audit_event(
            AuditContext {
                action: "budget.upsert",
                actor,
                tenant_id: &tenant_id,
                target: &id,
                resource_type: "budget",
            },
            Option::<&serde_json::Value>::None,
            Some(&details),
        )
        .await;
        Ok(view)
    }

    pub(crate) async fn delete_shared_budget_as(
        &self,
        id: &str,
        actor: &str,
        tenant_scope: Option<&str>,
    ) -> Result<bool, &'static str> {
        validate_actor(actor)?;
        let existing = self
            .shared_budget_views(tenant_scope)
            .await?
            .into_iter()
            .find(|budget| budget.id == id);
        let Some(existing) = existing else {
            return Ok(false);
        };
        let deleted = crate::shared_budget::delete(&self.0.database, id, tenant_scope).await?;
        if deleted {
            let details =
                serde_json::to_value(&existing).map_err(|_| "cannot encode shared budget")?;
            self.record_audit_event(
                AuditContext {
                    action: "budget.delete",
                    actor,
                    tenant_id: &existing.tenant_id,
                    target: id,
                    resource_type: "budget",
                },
                Some(&details),
                Option::<&serde_json::Value>::None,
            )
            .await;
        }
        Ok(deleted)
    }

    pub(crate) async fn begin_native_usage(
        &self,
        identity: &crate::policy::ClientIdentity,
        provider: &str,
        model: &str,
        quota_model: Option<&str>,
        attribution: &crate::native_usage::UsageAttribution,
    ) -> Result<(String, Option<crate::accounting::TokenPrices>), &'static str> {
        let usage = self
            .0
            .native_usage
            .read()
            .await
            .clone()
            .ok_or("native usage storage unavailable")?;
        let prices = self
            .native_usage_prices(&identity.tenant_id, provider, model)
            .await?;
        let shared_reservation = usage
            .shared_budget_reservation(&identity.tenant_id, &identity.id, attribution)
            .await?;
        if (identity
            .usage_quota
            .is_some_and(|quota| quota.max_monthly_microusd > 0)
            || shared_reservation.is_some())
            && prices.is_none()
        {
            return Err("native spend budget requires catalog pricing");
        }
        let event_id = format!("usage_{}", random_token(16)?);
        if identity.usage_quota.is_some() || shared_reservation.is_some() {
            let quota = identity
                .usage_quota
                .unwrap_or(crate::native_usage::NativeQuota {
                    max_tokens_per_minute: 0,
                    max_tokens_per_day: 0,
                    max_monthly_microusd: 0,
                    reservation_tokens: 0,
                    reservation_microusd: 0,
                });
            let allowed = usage
                .reserve_attributed_for_model(
                    &crate::native_usage::Reservation {
                        event_id: &event_id,
                        key_id: &identity.id,
                        tenant_id: &identity.tenant_id,
                        provider,
                        model,
                        quota,
                        reserved_tokens: quota.reservation_tokens,
                        reserved_microusd: quota
                            .reservation_microusd
                            .max(shared_reservation.unwrap_or(0)),
                        now_ms: unix_time_ms()?,
                    },
                    attribution,
                    quota_model,
                )
                .await?;
            if !allowed {
                return Err("native usage quota exceeded");
            }
        }
        Ok((event_id, prices))
    }

    pub(crate) async fn record_native_usage(
        &self,
        event_id: &str,
        identity: &crate::policy::ClientIdentity,
        record: NativeUsageRecord<'_>,
    ) -> Result<(), &'static str> {
        let store = self
            .0
            .native_usage
            .read()
            .await
            .clone()
            .ok_or("native usage storage unavailable")?;
        store
            .settle_attributed(
                &crate::native_usage::UsageEvent {
                    event_id,
                    key_id: &identity.id,
                    key_name: &identity.name,
                    tenant_id: &identity.tenant_id,
                    provider: record.provider,
                    model: record.model,
                    usage: record.usage,
                    prices: record.prices,
                    kind: crate::native_usage::UsageKind::Tokens,
                    search_units: 0,
                    rerank_price: None,
                    now_ms: unix_time_ms()?,
                    reserved: identity.usage_quota.is_some(),
                },
                record.attribution,
            )
            .await?;
        Ok(())
    }

    pub(crate) async fn begin_native_rerank_usage(
        &self,
        identity: &crate::policy::ClientIdentity,
        provider: &str,
        model: &str,
        attribution: &crate::native_usage::UsageAttribution,
    ) -> Result<(String, Option<crate::native_usage::RerankPrice>), &'static str> {
        let usage = self
            .0
            .native_usage
            .read()
            .await
            .clone()
            .ok_or("native usage storage unavailable")?;
        let price = self.native_rerank_price(provider, model).await?;
        let shared_reservation = usage
            .shared_budget_reservation(&identity.tenant_id, &identity.id, attribution)
            .await?;
        if (identity
            .usage_quota
            .is_some_and(|quota| quota.max_monthly_microusd > 0)
            || shared_reservation.is_some())
            && price.is_none()
        {
            return Err("native spend budget requires rerank pricing");
        }
        let event_id = format!("usage_{}", random_token(16)?);
        if identity.usage_quota.is_some() || shared_reservation.is_some() {
            let quota = identity
                .usage_quota
                .unwrap_or(crate::native_usage::NativeQuota {
                    max_tokens_per_minute: 0,
                    max_tokens_per_day: 0,
                    max_monthly_microusd: 0,
                    reservation_tokens: 0,
                    reservation_microusd: 0,
                });
            let allowed = usage
                .reserve_attributed(
                    &crate::native_usage::Reservation {
                        event_id: &event_id,
                        key_id: &identity.id,
                        tenant_id: &identity.tenant_id,
                        provider,
                        model,
                        quota,
                        reserved_tokens: 0,
                        reserved_microusd: quota
                            .reservation_microusd
                            .max(shared_reservation.unwrap_or(0)),
                        now_ms: unix_time_ms()?,
                    },
                    attribution,
                )
                .await?;
            if !allowed {
                return Err("native usage quota exceeded");
            }
        }
        Ok((event_id, price))
    }

    pub(crate) async fn record_native_rerank_usage(
        &self,
        event_id: &str,
        identity: &crate::policy::ClientIdentity,
        record: NativeRerankUsageRecord<'_>,
    ) -> Result<(), &'static str> {
        let store = self
            .0
            .native_usage
            .read()
            .await
            .clone()
            .ok_or("native usage storage unavailable")?;
        let zero = crate::accounting::ChatUsage {
            input: 0,
            output: 0,
            reasoning: 0,
            cache_read: 0,
            cache_creation: 0,
        };
        store
            .settle_attributed(
                &crate::native_usage::UsageEvent {
                    event_id,
                    key_id: &identity.id,
                    key_name: &identity.name,
                    tenant_id: &identity.tenant_id,
                    provider: record.provider,
                    model: record.model,
                    usage: &zero,
                    prices: None,
                    kind: crate::native_usage::UsageKind::Rerank,
                    search_units: record.search_units,
                    rerank_price: record.price,
                    now_ms: unix_time_ms()?,
                    reserved: identity.usage_quota.is_some(),
                },
                record.attribution,
            )
            .await?;
        Ok(())
    }

    pub(crate) async fn begin_context_relay_usage(
        &self,
        tenant: &str,
        provider: &str,
        model: &str,
    ) -> Result<Option<ContextRelayUsageAttempt>, &'static str> {
        if self.0.native_usage.read().await.is_none() {
            return Ok(None);
        }
        Ok(Some(ContextRelayUsageAttempt {
            event_id: format!("relay_usage_{}", random_token(16)?),
            prices: self.native_usage_prices(tenant, provider, model).await?,
        }))
    }

    pub(crate) async fn record_context_relay_usage(
        &self,
        attempt: ContextRelayUsageAttempt,
        tenant_id: &str,
        provider: &str,
        model: &str,
        usage_event: &crate::accounting::ChatUsage,
    ) -> Result<(), &'static str> {
        let store = self
            .0
            .native_usage
            .read()
            .await
            .clone()
            .ok_or("native usage storage unavailable")?;
        store
            .settle(&crate::native_usage::UsageEvent {
                event_id: &attempt.event_id,
                key_id: CONTEXT_RELAY_USAGE_KEY_ID,
                key_name: CONTEXT_RELAY_USAGE_KEY_NAME,
                tenant_id,
                provider,
                model,
                usage: usage_event,
                prices: attempt.prices.as_ref(),
                kind: crate::native_usage::UsageKind::Tokens,
                search_units: 0,
                rerank_price: None,
                now_ms: unix_time_ms()?,
                reserved: false,
            })
            .await?;
        Ok(())
    }

    async fn native_usage_prices(
        &self,
        tenant: &str,
        provider: &str,
        model: &str,
    ) -> Result<Option<crate::accounting::TokenPrices>, &'static str> {
        let Some(metadata) = self.effective_model(tenant, provider, model).await? else {
            return Ok(None);
        };
        let Some(cost) = metadata.cost else {
            return Ok(None);
        };
        let (Some(input), Some(output)) = (cost.input, cost.output) else {
            return Ok(None);
        };
        crate::accounting::TokenPrices::from_record(&serde_json::json!({
            "input": input,
            "output": output,
            "cached": cost.cache_read,
            "cache_creation": cost.cache_write,
            "reasoning": cost.reasoning,
        }))
        .map(Some)
    }

    async fn native_rerank_price(
        &self,
        provider: &str,
        model: &str,
    ) -> Result<Option<crate::native_usage::RerankPrice>, &'static str> {
        let pool = self
            .0
            .database
            .sql_pool()
            .ok_or("native rerank pricing requires SQLite storage")?;
        let rows = sqlx::query("SELECT namespace,value FROM key_value WHERE namespace IN ('pricing','models_dev_pricing','pricing_synced') AND lower(key) = lower($1) ORDER BY CASE namespace WHEN 'pricing' THEN 1 WHEN 'models_dev_pricing' THEN 2 ELSE 3 END")
            .bind(provider)
            .fetch_all(pool)
            .await
            .map_err(|_| "rerank pricing unavailable")?;
        for row in rows {
            let namespace: String = row
                .try_get("namespace")
                .map_err(|_| "invalid rerank pricing")?;
            let raw: String = row.try_get("value").map_err(|_| "invalid rerank pricing")?;
            let Ok(models) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            let Some(record) = models.get(model).and_then(serde_json::Value::as_object) else {
                continue;
            };
            let value = record
                .get("search_unit_cost")
                .or_else(|| record.get("input_cost_per_query"));
            let Some(value) = value else {
                continue;
            };
            let per_search_unit = value
                .as_f64()
                .filter(|price| price.is_finite() && *price >= 0.0)
                .ok_or("invalid rerank pricing")?;
            let source = match namespace.as_str() {
                "pricing" => "dashboard-user",
                "models_dev_pricing" => "models.dev",
                "pricing_synced" => "litellm",
                _ => return Err("invalid rerank pricing"),
            };
            return Ok(Some(crate::native_usage::RerankPrice {
                per_search_unit,
                source,
            }));
        }
        Ok(None)
    }

    pub(crate) async fn routes(
        &self,
    ) -> Result<Option<Arc<HashMap<String, Arc<ModelRoute>>>>, &'static str> {
        match &*self.0.routes.read().await {
            RouteSnapshot::Legacy(_) => Ok(None),
            RouteSnapshot::Current(routes, _) => Ok(Some(routes.clone())),
            RouteSnapshot::Unavailable => Err("combo route storage unavailable"),
        }
    }

    /// List descriptive catalog and operator models only for eligible chat
    /// accounts. Catalog membership never creates an inference grant.
    pub(crate) async fn direct_discovery_models(
        &self,
        policy: &ClientPolicy,
        catalog: &crate::catalog::ModelCatalog,
        overrides: &provider_models::ModelOverrides,
    ) -> Result<Vec<(String, crate::catalog::ModelMetadata)>, &'static str> {
        if !policy.endpoint_allowed("chat") {
            return Ok(Vec::new());
        }
        let tenant = policy
            .identity()
            .map_or("red", |identity| identity.tenant_id.as_ref());
        let pools = {
            let snapshot = self.0.routes.read().await;
            match &*snapshot {
                RouteSnapshot::Legacy(pools) | RouteSnapshot::Current(_, pools) => pools.clone(),
                RouteSnapshot::Unavailable => return Err("provider route snapshot unavailable"),
            }
        };
        let mut models = Vec::new();
        for ((owner, provider), accounts) in pools.iter() {
            if owner != tenant
                || crate::model_permissions::legacy_provider_id(provider)
                    .is_some_and(|canonical| canonical != provider.as_str())
            {
                continue;
            }
            let protocols: Vec<_> = accounts
                .iter()
                .filter(|account| policy.provider_allowed(Some(&account.record.id)))
                .filter_map(|account| {
                    ProviderProtocol::from_configuration(
                        &account.record.upstream_url,
                        &account.record.protocol,
                    )
                    .ok()
                })
                .filter(|protocol| {
                    matches!(
                        protocol,
                        ProviderProtocol::OpenAi
                            | ProviderProtocol::Anthropic
                            | ProviderProtocol::Antigravity
                    )
                })
                .collect();
            if protocols.is_empty() {
                continue;
            }
            let catalog_models = catalog.models_for_provider(provider)?;
            let mut candidates: BTreeSet<&str> = catalog_models.keys().copied().collect();
            for configured in overrides.configured_models(tenant, provider) {
                candidates.insert(&configured.id);
            }
            for id in candidates {
                let public = format!("{provider}/{id}");
                if !model_aliases::valid_model_name(id)
                    || !policy.model_alias_target_allowed(&public, id, Some(provider))
                    || !protocols.iter().any(|protocol| {
                        *protocol != ProviderProtocol::Antigravity || crate::valid_gemini_model(id)
                    })
                {
                    continue;
                }
                let metadata = overrides
                    .model(catalog, tenant, provider, id)?
                    .ok_or("configured model metadata unavailable")?;
                if metadata
                    .r#type
                    .as_deref()
                    .is_some_and(|kind| kind != "chat")
                    || metadata.status.as_deref() == Some("retired")
                    || metadata.modalities.as_ref().is_some_and(|modalities| {
                        !modalities.output.is_empty()
                            && !modalities.output.iter().any(|value| value == "text")
                    })
                {
                    continue;
                }
                if models.len() >= 10_000 {
                    return Err("provider model inventory exceeds its limit");
                }
                models.push((public, metadata));
            }
        }
        models.sort_unstable_by(|left, right| left.0.cmp(&right.0));
        Ok(models)
    }

    async fn direct_account_live<'a>(
        &'a self,
        account: &'a DirectAccount,
    ) -> Result<&'a LiveProvider, &'static str> {
        account
            .live
            .get_or_try_init(|| async {
                let provider = &account.record;
                let auth_scheme = ProviderAuthScheme::parse(&account.auth.auth_scheme)?;
                let credential = decrypt_async(
                    &provider.credential_ciphertext,
                    &provider.id,
                    self.0.encryption_key.as_str(),
                )
                .await?;
                let mut runtime = ProxyState::live_provider(
                    &provider.upstream_url,
                    credential.as_str(),
                    self.0.allow_private,
                    auth_scheme,
                    account.auth.expires_at_unix,
                    &provider.protocol,
                    provider.node_id.is_some(),
                )
                .await?;
                runtime.custom_headers = self.request_headers(provider).await?;
                runtime.provider_id = Some(Arc::from(provider.id.clone()));
                runtime.provider_name = Some(Arc::from(provider.provider.clone()));
                runtime.tenant_id = Arc::from(provider.tenant_id.clone());
                runtime.rate_limit_scope = account.rate_limit_scope;
                runtime.antigravity_project = account.antigravity_project.clone();
                runtime.claude_identity = account.claude_identity.clone();
                let circuit = self.circuit_for(&provider.id, &provider.upstream_url).await;
                runtime.in_flight = circuit.in_flight();
                runtime.circuit = Some(circuit);
                runtime.availability = Some(self.availability_for(&provider.id).await);
                Ok(runtime)
            })
            .await
    }

    /// Compile a provider/model request against the current tenant's account
    /// pool. Provider clients are cached per snapshot, not recreated per call.
    pub(crate) async fn direct_provider_route(
        &self,
        tenant: &str,
        requested: &str,
        request_protocol: ProviderProtocol,
        policy: &ClientPolicy,
    ) -> Result<Option<Arc<ModelRoute>>, &'static str> {
        let Some((prefix, model)) = requested.split_once('/') else {
            return Ok(None);
        };
        if !crate::valid_model_identifier(requested)
            || requested.trim() != requested
            || !model_aliases::valid_model_name(model)
        {
            return Err("invalid provider model");
        }
        let registered = crate::model_permissions::legacy_provider_id(prefix);
        let provider = registered.unwrap_or(prefix);
        if validate_provider(provider).is_err() {
            return Ok(None);
        }
        let accounts = {
            let snapshot = self.0.routes.read().await;
            let pools = match &*snapshot {
                RouteSnapshot::Legacy(pools) | RouteSnapshot::Current(_, pools) => pools,
                RouteSnapshot::Unavailable => return Err("provider route snapshot unavailable"),
            };
            match pools.get(&(tenant.to_owned(), provider.to_owned())) {
                Some(accounts) => accounts.clone(),
                None if registered.is_some()
                    || crate::product_provider::chat_url(provider).is_some() =>
                {
                    return Err("provider route has no available accounts");
                }
                None => return Ok(None),
            }
        };
        if accounts.is_empty() {
            return Err("provider route has no available accounts");
        }
        if !policy.model_alias_target_allowed(requested, model, Some(provider)) {
            return Err("provider route forbidden");
        }
        let accounts: Vec<_> = accounts
            .into_iter()
            .filter(|account| policy.provider_allowed(Some(&account.record.id)))
            .collect();
        if accounts.is_empty() {
            return Err("provider route forbidden");
        }
        let metadata = self.effective_model(tenant, provider, model).await?;
        let cost = metadata.as_ref().and_then(|entry| entry.cost.as_ref());
        let context = metadata
            .as_ref()
            .and_then(|entry| entry.limit.as_ref())
            .and_then(|limit| limit.context);
        let mut initialized = futures_util::stream::iter(accounts.into_iter().enumerate())
            .map(|(index, account)| async move {
                let configured = ProviderProtocol::from_configuration(
                    &account.record.upstream_url,
                    &account.record.protocol,
                )
                .ok()?;
                let protocol = match (request_protocol, configured) {
                    (ProviderProtocol::OpenAi, ProviderProtocol::Anthropic) => {
                        ProviderProtocol::OpenAiToAnthropic
                    }
                    (ProviderProtocol::OpenAi, ProviderProtocol::Antigravity) => {
                        ProviderProtocol::OpenAiToAntigravity
                    }
                    (requested, actual) if requested == actual => requested,
                    _ => return None,
                };
                if matches!(
                    protocol,
                    ProviderProtocol::Gemini
                        | ProviderProtocol::Antigravity
                        | ProviderProtocol::OpenAiToAntigravity
                ) && !crate::valid_gemini_model(model)
                {
                    return None;
                }
                let live = self.direct_account_live(&account).await.ok()?.clone();
                Some((index, account, live, protocol))
            })
            .buffer_unordered(16)
            .filter_map(|item| async move { item })
            .collect::<Vec<_>>()
            .await;
        initialized.sort_by_key(|(index, _, _, _)| *index);
        let model_quotas = self.0.model_quotas.read().await;
        let targets = initialized
            .into_iter()
            .map(|(_, account, live, protocol)| {
                let model_quota = model_quotas
                    .get(&(account.record.id.clone(), model.to_owned()))
                    .cloned();
                ProxyState::control_target(
                    &live,
                    crate::ControlTargetConfig {
                        protocol,
                        model: model.to_owned(),
                        weight: 1,
                        input_cost_per_million: cost.and_then(|cost| cost.input),
                        output_cost_per_million: cost.and_then(|cost| cost.output),
                        context_window_tokens: context,
                        prompt: None,
                    },
                    account.quota.clone(),
                    model_quota,
                )
            })
            .collect::<Vec<_>>();
        if targets.is_empty() {
            return Err("provider route has no available accounts");
        }
        Ok(Some(Arc::new(ModelRoute {
            public_model_alias: None,
            provider_direct: true,
            tenant_id: Arc::from(tenant),
            targets,
            protocol: request_protocol,
            strategy: RouteStrategy::Priority,
            auto_weights: crate::AutoRouteWeights::default(),
            context_relay: ComboContextRelayConfig::default(),
            fusion: ComboFusionConfig::default(),
            pipeline: ComboPipelineConfig::default(),
            fallback: true,
            cursor: std::sync::atomic::AtomicUsize::new(0),
            seed: crate::route_seed(requested),
            last_good: std::sync::atomic::AtomicUsize::new(crate::NO_ROUTE_TARGET),
        })))
    }

    pub async fn has_active_provider(&self) -> Result<bool, &'static str> {
        self.0
            .database
            .active_provider()
            .await
            .map(|row| row.is_some())
    }

    pub(crate) async fn antigravity_thought_signatures(
        &self,
        provider_id: &str,
        tool_call_ids: &[String],
    ) -> Result<HashMap<String, String>, &'static str> {
        if provider_id.is_empty()
            || provider_id.len() > 512
            || tool_call_ids.len() > crate::antigravity_translation::MAX_TOOL_CALLS
            || tool_call_ids
                .iter()
                .any(|id| id.is_empty() || id.len() > 512 || id.chars().any(char::is_control))
        {
            return Err("invalid Antigravity thought signature key");
        }
        let now = unix_time_ms()?;
        let mut resolved = HashMap::new();
        let mut misses = Vec::new();
        {
            let mut cache = self
                .0
                .thought_signatures
                .lock()
                .map_err(|_| "Antigravity thought signature cache unavailable")?;
            cache.retain(|_, (_, expires)| *expires > now);
            for id in tool_call_ids {
                let key = (provider_id.to_owned(), id.clone());
                if let Some((signature, _)) = cache.get(&key) {
                    resolved.insert(id.clone(), signature.clone());
                } else {
                    misses.push(id.clone());
                }
            }
        }
        for id in misses {
            if let Some(signature) = self
                .0
                .database
                .antigravity_thought_signature(provider_id, &id, now)
                .await?
            {
                if signature.is_empty() || signature.len() > 65_536 {
                    return Err("invalid persisted Antigravity thought signature");
                }
                resolved.insert(id.clone(), signature.clone());
                self.cache_antigravity_thought_signature(
                    provider_id,
                    &id,
                    signature,
                    now + THOUGHT_SIGNATURE_MEMORY_TTL_MS,
                )?;
            }
        }
        Ok(resolved)
    }

    pub(crate) async fn store_antigravity_thought_signatures(
        &self,
        provider_id: &str,
        signatures: &[(String, String)],
    ) -> Result<(), &'static str> {
        if provider_id.is_empty()
            || provider_id.len() > 512
            || signatures.len() > crate::antigravity_translation::MAX_TOOL_CALLS
        {
            return Err("invalid Antigravity thought signatures");
        }
        let now = unix_time_ms()?;
        let persisted_expiry = now
            .checked_add(THOUGHT_SIGNATURE_PERSISTED_TTL_MS)
            .ok_or("invalid Antigravity thought signature expiry")?;
        for (tool_call_id, signature) in signatures {
            if tool_call_id.is_empty()
                || tool_call_id.len() > 512
                || tool_call_id.chars().any(char::is_control)
                || signature.is_empty()
                || signature.len() > 65_536
            {
                return Err("invalid Antigravity thought signature");
            }
            self.0
                .database
                .upsert_antigravity_thought_signature(
                    provider_id,
                    tool_call_id,
                    signature,
                    now,
                    persisted_expiry,
                )
                .await?;
            self.cache_antigravity_thought_signature(
                provider_id,
                tool_call_id,
                signature.clone(),
                now + THOUGHT_SIGNATURE_MEMORY_TTL_MS,
            )?;
        }
        self.0
            .database
            .delete_expired_antigravity_thought_signatures(now)
            .await
    }

    fn cache_antigravity_thought_signature(
        &self,
        provider_id: &str,
        tool_call_id: &str,
        signature: String,
        expires_at_unix_ms: i64,
    ) -> Result<(), &'static str> {
        let mut cache = self
            .0
            .thought_signatures
            .lock()
            .map_err(|_| "Antigravity thought signature cache unavailable")?;
        let key = (provider_id.to_owned(), tool_call_id.to_owned());
        if !cache.contains_key(&key) && cache.len() >= MAX_THOUGHT_SIGNATURES_IN_MEMORY {
            let oldest = cache
                .iter()
                .min_by_key(|(_, (_, expires))| *expires)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                cache.remove(&oldest);
            }
        }
        cache.insert(key, (signature, expires_at_unix_ms));
        Ok(())
    }

    pub(crate) async fn ready(&self) -> bool {
        let client_keys_ready = match &*self.0.clients.read().await {
            ClientSnapshot::Legacy => true,
            ClientSnapshot::Current(policies) => policies.has_active(),
            ClientSnapshot::Unavailable => false,
        };
        let routes_ready = match &*self.0.routes.read().await {
            RouteSnapshot::Legacy(_) => true,
            RouteSnapshot::Current(routes, pools) => {
                !routes.is_empty() || pools.values().any(|accounts| !accounts.is_empty())
            }
            RouteSnapshot::Unavailable => false,
        };
        let breakers_ready = self
            .0
            .breakers
            .read()
            .await
            .values()
            .all(|breaker| breaker.persistence_ready());
        let availability_ready = self
            .0
            .availability
            .read()
            .await
            .values()
            .all(|availability| availability.persistence_ready());
        client_keys_ready
            && routes_ready
            && breakers_ready
            && availability_ready
            && self.0.database.provider_resilience().await.is_ok()
            && self.0.database.runtime_settings().await.is_ok()
            && self.0.database.provider_auth().await.is_ok()
            && self.0.database.provider_oauth().await.is_ok()
            && self.0.database.provider_sessions().await.is_ok()
            && self.0.database.provider_oauth_status().await.is_ok()
            && self
                .0
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
        self.configure_provider_as(id, input, None, "bootstrap-admin", None)
            .await
    }

    async fn start_provider_oauth_as(
        &self,
        provider: &str,
        requested_redirect_uri: Option<&str>,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<serde_json::Value, &'static str> {
        validate_actor(actor)?;
        let tenant_id = enforced_tenant.unwrap_or("red");
        validate_id(tenant_id)?;
        let redirect_uri = match provider {
            "codex" => {
                if requested_redirect_uri
                    .is_some_and(|value| value.trim() != CODEX_OAUTH_REDIRECT_URI)
                {
                    return Err("invalid Codex OAuth redirect URI");
                }
                CODEX_OAUTH_REDIRECT_URI
            }
            "claude" => CLAUDE_OAUTH_REDIRECT_URI,
            "agy" => {
                let redirect_uri =
                    requested_redirect_uri.ok_or("Antigravity OAuth redirect URI is required")?;
                validate_agy_oauth_redirect_uri(
                    redirect_uri,
                    self.0.oauth_refresh.agy_redirect_uri.as_deref(),
                )?;
                redirect_uri
            }
            "xai-oauth" => {
                if requested_redirect_uri
                    .is_some_and(|value| value.trim() != XAI_OAUTH_REDIRECT_URI)
                {
                    return Err("invalid xAI OAuth redirect URI");
                }
                XAI_OAUTH_REDIRECT_URI
            }
            "openference" => {
                if requested_redirect_uri
                    .is_some_and(|value| value.trim() != OPENFERENCE_OAUTH_REDIRECT_URI)
                {
                    return Err("invalid Openference OAuth redirect URI");
                }
                OPENFERENCE_OAUTH_REDIRECT_URI
            }
            _ => return Err("unsupported browser OAuth provider"),
        };
        if requested_redirect_uri.is_some_and(|value| {
            value.len() > 2048 || value.is_empty() || value.chars().any(char::is_control)
        }) {
            return Err("invalid provider OAuth redirect URI");
        }
        let code_verifier = random_token(32)?;
        let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
        let now = unix_time_seconds()?;
        let oauth_nonce = random_token(16)?;
        let flow = ProviderOAuthFlowState {
            provider: provider.to_owned(),
            redirect_uri: redirect_uri.to_owned(),
            verifier_hash: hex::encode(Sha256::digest(code_verifier.as_bytes())),
            actor: actor.to_owned(),
            tenant_id: tenant_id.to_owned(),
            expires_at: now
                .checked_add(PROVIDER_OAUTH_FLOW_SECONDS)
                .ok_or("system clock is out of range")?,
            nonce: oauth_nonce.clone(),
        };
        let flow =
            serde_json::to_string(&flow).map_err(|_| "cannot encode provider OAuth state")?;
        let state = encrypt_async(
            &flow,
            "provider-oauth-browser-flow",
            self.0.encryption_key.as_str(),
        )
        .await?;
        let (authorize_url, client_id) = match provider {
            "codex" => (
                CODEX_OAUTH_AUTHORIZE_URL,
                self.0.oauth_refresh.codex_client_id.as_str(),
            ),
            "claude" => (
                CLAUDE_OAUTH_AUTHORIZE_URL,
                self.0.oauth_refresh.claude_client_id.as_str(),
            ),
            "agy" => (
                AGY_OAUTH_AUTHORIZE_URL,
                self.0
                    .oauth_refresh
                    .agy_client_id
                    .as_deref()
                    .ok_or("Antigravity OAuth client is not configured")?,
            ),
            "xai-oauth" => (
                XAI_OAUTH_AUTHORIZE_URL,
                self.0.oauth_refresh.xai_client_id.as_str(),
            ),
            "openference" => (
                OPENFERENCE_OAUTH_AUTHORIZE_URL,
                self.0.oauth_refresh.openference_client_id.as_str(),
            ),
            _ => return Err("unsupported browser OAuth provider"),
        };
        let mut auth_url = reqwest::Url::parse(authorize_url)
            .map_err(|_| "invalid provider OAuth authorization URL")?;
        {
            let mut query = auth_url.query_pairs_mut();
            query
                .append_pair("response_type", "code")
                .append_pair("client_id", client_id)
                .append_pair("redirect_uri", redirect_uri)
                .append_pair("state", &state);
            if provider != "agy" {
                query
                    .append_pair("code_challenge", &code_challenge)
                    .append_pair("code_challenge_method", "S256");
                if !matches!(provider, "xai-oauth" | "openference") {
                    query.append_pair("prompt", "login");
                }
            }
            if provider == "codex" {
                query
                    .append_pair("scope", "openid profile email offline_access")
                    .append_pair("id_token_add_organizations", "true")
                    .append_pair("codex_cli_simplified_flow", "true")
                    .append_pair("originator", "codex_cli_rs");
            } else if provider == "claude" {
                query.append_pair(
                    "scope",
                    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers",
                );
            } else if provider == "agy" {
                query
                    .append_pair("scope", AGY_OAUTH_SCOPES)
                    .append_pair("access_type", "offline")
                    .append_pair("prompt", "consent");
            } else if provider == "xai-oauth" {
                query
                    .append_pair("scope", XAI_OAUTH_SCOPES)
                    .append_pair("nonce", &oauth_nonce)
                    .append_pair("plan", "generic")
                    .append_pair("referrer", "cli-proxy-api");
            } else {
                query.append_pair("scope", OPENFERENCE_OAUTH_SCOPES);
            }
        }
        let mut view = serde_json::json!({
            "authUrl":auth_url.to_string(),
            "state":state,
            "codeVerifier":code_verifier,
            "codeChallenge":code_challenge,
            "redirectUri":redirect_uri,
            "flowType":if provider == "agy" { "authorization_code" } else { "authorization_code_pkce" },
            "callbackPath":if provider == "codex" { "/auth/callback" } else { "/callback" },
            "callbackHost":if matches!(provider, "xai-oauth" | "openference") { "127.0.0.1" } else { "localhost" }
        });
        if provider == "codex" {
            view["fixedPort"] = serde_json::json!(1455);
        } else if provider == "xai-oauth" {
            view["fixedPort"] = serde_json::json!(56121);
        } else if provider == "openference" {
            view["fixedPort"] = serde_json::json!(56123);
        }
        Ok(view)
    }

    async fn exchange_provider_browser_tokens(
        &self,
        provider: &str,
        code: &str,
        redirect_uri: &str,
        code_verifier: &str,
        state: &str,
    ) -> Result<serde_json::Value, &'static str> {
        let (endpoint, client_id) = match provider {
            "codex" => (
                &self.0.oauth_refresh.codex_endpoint,
                self.0.oauth_refresh.codex_client_id.as_str(),
            ),
            "claude" => (
                &self.0.oauth_refresh.claude_endpoint,
                self.0.oauth_refresh.claude_client_id.as_str(),
            ),
            "agy" => (
                &self.0.oauth_refresh.agy_endpoint,
                self.0
                    .oauth_refresh
                    .agy_client_id
                    .as_deref()
                    .ok_or("Antigravity OAuth client is not configured")?,
            ),
            "xai-oauth" => (
                &self.0.oauth_refresh.xai_endpoint,
                self.0.oauth_refresh.xai_client_id.as_str(),
            ),
            "openference" => (
                &self.0.oauth_refresh.openference_endpoint,
                self.0.oauth_refresh.openference_client_id.as_str(),
            ),
            _ => return Err("unsupported browser OAuth provider"),
        };
        let request = if matches!(provider, "codex" | "agy" | "xai-oauth" | "openference") {
            let form = {
                let mut serializer = url::form_urlencoded::Serializer::new(String::new());
                serializer
                    .append_pair("grant_type", "authorization_code")
                    .append_pair("client_id", client_id)
                    .append_pair("code", code)
                    .append_pair("redirect_uri", redirect_uri);
                if matches!(provider, "codex" | "xai-oauth" | "openference") {
                    serializer.append_pair("code_verifier", code_verifier);
                } else if let Some(secret) = self.0.oauth_refresh.agy_client_secret.as_deref() {
                    serializer.append_pair("client_secret", secret);
                }
                serializer.finish()
            };
            self.0
                .oauth_refresh_client
                .post(endpoint.clone())
                .header(
                    header::CONTENT_TYPE.as_str(),
                    "application/x-www-form-urlencoded",
                )
                .header(header::ACCEPT, "application/json")
                .body(form)
        } else {
            self.0
                .oauth_refresh_client
                .post(endpoint.clone())
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ACCEPT, "application/json")
                .header("anthropic-beta", "oauth-2025-04-20")
                .body(
                    serde_json::json!({
                        "code":code,
                        "state":state,
                        "grant_type":"authorization_code",
                        "client_id":client_id,
                        "redirect_uri":redirect_uri,
                        "code_verifier":code_verifier,
                    })
                    .to_string(),
                )
        };
        let response = request
            .send()
            .await
            .map_err(|_| "provider OAuth exchange unavailable")?;
        let success = response.status().is_success();
        let body = read_bounded_response(response, OAUTH_REFRESH_MAX_BODY_BYTES)
            .await
            .map_err(|_| "provider OAuth response is invalid")?;
        if !success {
            return Err("provider OAuth exchange rejected");
        }
        serde_json::from_slice(&body).map_err(|_| "provider OAuth response is invalid")
    }

    async fn openference_userinfo(&self, access_token: &str) -> Option<serde_json::Value> {
        let response = self
            .0
            .oauth_refresh_client
            .get(self.0.oauth_refresh.openference_userinfo_endpoint.clone())
            .bearer_auth(access_token)
            .header(header::ACCEPT, "application/json")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let body = read_bounded_response(response, OAUTH_REFRESH_MAX_BODY_BYTES)
            .await
            .ok()?;
        serde_json::from_slice(&body).ok()
    }

    async fn finish_provider_oauth_as(
        &self,
        provider: &str,
        input: ProviderOAuthExchangeInput,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<ProviderAuthImportView, &'static str> {
        validate_actor(actor)?;
        let tenant_id = enforced_tenant.unwrap_or("red");
        validate_id(tenant_id)?;
        if !(1..=8192).contains(&input.code.len())
            || input.code.chars().any(char::is_control)
            || !(43..=128).contains(&input.code_verifier.len())
            || input.code_verifier.chars().any(char::is_control)
            || !(1..=2048).contains(&input.redirect_uri.len())
            || input.redirect_uri.chars().any(char::is_control)
            || input.connection_id.as_deref().is_some_and(|value| {
                value.is_empty() || value.len() > 512 || value.chars().any(char::is_control)
            })
        {
            return Err("invalid provider OAuth exchange");
        }
        let (code, embedded_state) = if provider == "claude" {
            input
                .code
                .split_once('#')
                .map_or((input.code.as_str(), None), |(code, state)| {
                    (code, Some(state))
                })
        } else {
            (input.code.as_str(), None)
        };
        if code.is_empty() || embedded_state.is_some_and(str::is_empty) {
            return Err("invalid provider OAuth exchange");
        }
        if embedded_state
            .zip(input.state.as_deref())
            .is_some_and(|(embedded, supplied)| embedded != supplied)
        {
            return Err("invalid provider OAuth state");
        }
        let returned_state = embedded_state
            .or(input.state.as_deref())
            .filter(|value| !value.is_empty() && value.len() <= 8192)
            .ok_or("invalid provider OAuth state")?;
        let flow = decrypt_async(
            returned_state,
            "provider-oauth-browser-flow",
            self.0.encryption_key.as_str(),
        )
        .await
        .map_err(|_| "invalid provider OAuth state")?;
        let flow: ProviderOAuthFlowState =
            serde_json::from_str(&flow).map_err(|_| "invalid provider OAuth state")?;
        let verifier_hash = hex::encode(Sha256::digest(input.code_verifier.as_bytes()));
        let now = unix_time_seconds()?;
        if flow.provider != provider
            || flow.redirect_uri != input.redirect_uri
            || flow.verifier_hash.len() != verifier_hash.len()
            || !bool::from(
                flow.verifier_hash
                    .as_bytes()
                    .ct_eq(verifier_hash.as_bytes()),
            )
            || flow.actor != actor
            || flow.tenant_id != tenant_id
            || flow.expires_at < now
            || flow.nonce.len() != 22
        {
            return Err("invalid provider OAuth state");
        }
        let token_data = self
            .exchange_provider_browser_tokens(
                provider,
                code,
                &input.redirect_uri,
                &input.code_verifier,
                returned_state,
            )
            .await?;
        let access_token = browser_oauth_token_field(&token_data, "access_token")?;
        let refresh_token = browser_oauth_token_field(&token_data, "refresh_token")?;
        let expires_in = token_data
            .get("expires_in")
            .and_then(serde_json::Value::as_u64)
            .filter(|value| (1..=2_678_400).contains(value))
            .ok_or("provider OAuth response is invalid")?;
        let expires_at = now
            .checked_add(expires_in)
            .ok_or("provider OAuth response is invalid")?;
        match provider {
            "codex" => {
                let id_token = browser_oauth_token_field(&token_data, "id_token")?;
                self.import_codex_auth_as(
                    ProviderAuthImportInput {
                        source: ProviderAuthImportSource::Json {
                            json: serde_json::json!({
                                "auth_mode":"chatgpt",
                                "tokens":{
                                    "id_token":id_token,
                                    "access_token":access_token,
                                    "refresh_token":refresh_token
                                }
                            }),
                        },
                        name: None,
                        email: None,
                        overwrite_existing: true,
                    },
                    actor,
                    enforced_tenant,
                    input.connection_id.as_deref(),
                )
                .await
            }
            "claude" => {
                let scopes = token_data
                    .get("scope")
                    .and_then(serde_json::Value::as_str)
                    .map(|value| value.split_whitespace().collect::<Vec<_>>())
                    .unwrap_or_default();
                self.import_claude_auth_as(
                    ProviderAuthImportInput {
                        source: ProviderAuthImportSource::Json {
                            json: serde_json::json!({
                                "claudeAiOauth":{
                                    "accessToken":access_token,
                                    "refreshToken":refresh_token,
                                    "expiresAt":expires_at.saturating_mul(1_000),
                                    "scopes":scopes,
                                    "subscriptionType":token_data.get("subscription_type"),
                                    "rateLimitTier":token_data.get("rate_limit_tier")
                                }
                            }),
                        },
                        name: None,
                        email: None,
                        overwrite_existing: true,
                    },
                    actor,
                    enforced_tenant,
                    input.connection_id.as_deref(),
                )
                .await
            }
            "agy" => {
                self.import_agy_auth_as(
                    ProviderAuthImportInput {
                        source: ProviderAuthImportSource::Json {
                            json: serde_json::json!({
                                "token":{
                                    "access_token":access_token,
                                    "refresh_token":refresh_token,
                                    "expiry":expires_at,
                                    "token_type":token_data
                                        .get("token_type")
                                        .and_then(serde_json::Value::as_str)
                                        .unwrap_or("Bearer"),
                                    "scope":token_data.get("scope")
                                },
                                "auth_method":"oauth"
                            }),
                        },
                        name: None,
                        email: None,
                        overwrite_existing: true,
                    },
                    actor,
                    enforced_tenant,
                    input.connection_id.as_deref(),
                )
                .await
            }
            "xai-oauth" => {
                let claims = token_data
                    .get("id_token")
                    .and_then(serde_json::Value::as_str)
                    .and_then(decode_unverified_jwt_payload);
                let email = claims
                    .as_ref()
                    .and_then(|claims| {
                        json_non_empty_string(claims.get("email"))
                            .or_else(|| json_non_empty_string(claims.get("preferred_username")))
                    })
                    .filter(|value| {
                        value.len() <= 320
                            && value.trim() == *value
                            && !value.chars().any(char::is_control)
                    })
                    .map(str::to_owned);
                let identity = claims.as_ref().and_then(|claims| {
                    json_non_empty_string(claims.get("sub"))
                        .filter(|value| value.len() <= 512 && !value.chars().any(char::is_control))
                        .map(str::to_owned)
                });
                let provider_id = match input.connection_id.as_deref() {
                    Some(value) => value.to_owned(),
                    None => identity.as_deref().map_or_else(
                        || random_token(12).map(|token| format!("xai-{token}")),
                        |identity| Ok(provider_import_id("xai", tenant_id, identity)),
                    )?,
                };
                validate_id(&provider_id)?;
                let existing = self
                    .0
                    .database
                    .providers()
                    .await?
                    .into_iter()
                    .find(|provider| provider.id == provider_id);
                if existing
                    .as_ref()
                    .is_some_and(|provider| provider.provider != "xai-oauth")
                {
                    return Err("xAI OAuth connection conflicts with another provider");
                }
                let created = existing.is_none();
                let connection = self
                    .configure_provider_as(
                        &provider_id,
                        ProviderInput {
                            node_id: None,
                            protocol: None,
                            priority: None,
                            default_model: None,
                            tenant_id: Some(tenant_id.to_owned()),
                            provider: "xai-oauth".to_owned(),
                            upstream_url: self.0.oauth_refresh.xai_provider_endpoint.to_string(),
                            api_key: access_token,
                            enabled: true,
                            rate_limit_scope: "model".to_owned(),
                            auth_scheme: "bearer".to_owned(),
                            label: Some(email.clone().unwrap_or_else(|| "xAI OAuth".to_owned())),
                            account_email: email,
                            expires_at_unix: Some(expires_at),
                            credential_type: "oauth".to_owned(),
                            oauth_provider: Some("xai-oauth".to_owned()),
                            refresh_token: Some(refresh_token),
                        },
                        None,
                        actor,
                        enforced_tenant,
                    )
                    .await?;
                self.record_audit_event(
                    AuditContext {
                        action: "provider.credentials.imported",
                        actor,
                        tenant_id,
                        target: &provider_id,
                        resource_type: "provider_credentials",
                    },
                    Option::<&serde_json::Value>::None,
                    Some(&serde_json::json!({
                        "provider":"xai-oauth",
                        "created":created,
                        "browser_oauth":true,
                    })),
                )
                .await;
                Ok(ProviderAuthImportView {
                    connection,
                    created,
                })
            }
            "openference" => {
                let claims = token_data
                    .get("id_token")
                    .and_then(serde_json::Value::as_str)
                    .and_then(decode_unverified_jwt_payload);
                let userinfo = self.openference_userinfo(&access_token).await;
                let email = claims
                    .as_ref()
                    .and_then(|claims| {
                        json_non_empty_string(claims.get("email"))
                            .or_else(|| json_non_empty_string(claims.get("preferred_username")))
                    })
                    .or_else(|| {
                        userinfo.as_ref().and_then(|value| {
                            json_non_empty_string(value.get("email"))
                                .or_else(|| json_non_empty_string(value.get("preferred_username")))
                        })
                    })
                    .filter(|value| {
                        value.len() <= 320
                            && value.trim() == *value
                            && !value.chars().any(char::is_control)
                    })
                    .map(str::to_owned);
                let identity = claims
                    .as_ref()
                    .and_then(|claims| json_non_empty_string(claims.get("sub")))
                    .or_else(|| {
                        userinfo
                            .as_ref()
                            .and_then(|value| json_non_empty_string(value.get("sub")))
                    })
                    .filter(|value| value.len() <= 512 && !value.chars().any(char::is_control))
                    .map(str::to_owned);
                let provider_id = match input.connection_id.as_deref() {
                    Some(value) => value.to_owned(),
                    None => identity.as_deref().map_or_else(
                        || random_token(12).map(|token| format!("openference-{token}")),
                        |identity| Ok(provider_import_id("openference", tenant_id, identity)),
                    )?,
                };
                validate_id(&provider_id)?;
                let existing = self
                    .0
                    .database
                    .providers()
                    .await?
                    .into_iter()
                    .find(|provider| provider.id == provider_id);
                if existing
                    .as_ref()
                    .is_some_and(|provider| provider.provider != "openference")
                {
                    return Err("Openference OAuth connection conflicts with another provider");
                }
                let created = existing.is_none();
                let connection = self
                    .configure_provider_as(
                        &provider_id,
                        ProviderInput {
                            node_id: None,
                            protocol: None,
                            priority: None,
                            default_model: None,
                            tenant_id: Some(tenant_id.to_owned()),
                            provider: "openference".to_owned(),
                            upstream_url: self
                                .0
                                .oauth_refresh
                                .openference_provider_endpoint
                                .to_string(),
                            api_key: access_token,
                            enabled: true,
                            rate_limit_scope: "model".to_owned(),
                            auth_scheme: "bearer".to_owned(),
                            label: Some(
                                email
                                    .clone()
                                    .unwrap_or_else(|| "Openference OAuth".to_owned()),
                            ),
                            account_email: email,
                            expires_at_unix: Some(expires_at),
                            credential_type: "oauth".to_owned(),
                            oauth_provider: Some("openference".to_owned()),
                            refresh_token: Some(refresh_token),
                        },
                        None,
                        actor,
                        enforced_tenant,
                    )
                    .await?;
                self.record_audit_event(
                    AuditContext {
                        action: "provider.credentials.imported",
                        actor,
                        tenant_id,
                        target: &provider_id,
                        resource_type: "provider_credentials",
                    },
                    Option::<&serde_json::Value>::None,
                    Some(&serde_json::json!({
                        "provider":"openference",
                        "created":created,
                        "browser_oauth":true,
                    })),
                )
                .await;
                Ok(ProviderAuthImportView {
                    connection,
                    created,
                })
            }
            _ => Err("unsupported browser OAuth provider"),
        }
    }

    async fn import_codex_auth_as(
        &self,
        input: ProviderAuthImportInput,
        actor: &str,
        enforced_tenant: Option<&str>,
        expected_connection_id: Option<&str>,
    ) -> Result<ProviderAuthImportView, &'static str> {
        validate_actor(actor)?;
        let tenant_id = enforced_tenant.unwrap_or("red");
        validate_id(tenant_id)?;
        let raw = match input.source {
            ProviderAuthImportSource::Json { json } => json,
            ProviderAuthImportSource::Text { text } => {
                if text.len() > 256 * 1024 {
                    return Err("Codex auth file is too large");
                }
                serde_json::from_str(&text).map_err(|_| "invalid Codex auth JSON")?
            }
        };
        let parsed = parse_codex_auth(raw)?;
        let provider_id =
            codex_import_provider_id(tenant_id, &parsed.account_id, parsed.user_id.as_deref());
        if expected_connection_id.is_some_and(|expected| expected != provider_id) {
            return Err("invalid provider OAuth connection");
        }
        let existing = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|provider| provider.id == provider_id);
        if existing.is_some() && !input.overwrite_existing {
            return Err("Codex account already exists");
        }
        if existing
            .as_ref()
            .is_some_and(|provider| provider.provider != "codex")
        {
            return Err("Codex account identifier conflicts with another provider");
        }
        let created = existing.is_none();
        let email = input.email.or(parsed.email);
        let label = input
            .name
            .or_else(|| email.clone())
            .unwrap_or_else(|| "Codex (imported)".to_owned());
        let connection = self
            .configure_provider_as(
                &provider_id,
                ProviderInput {
                    node_id: None,
                    protocol: None,
                    priority: None,
                    default_model: None,
                    tenant_id: Some(tenant_id.to_owned()),
                    provider: "codex".to_owned(),
                    upstream_url: self.0.oauth_refresh.codex_provider_endpoint.to_string(),
                    api_key: parsed.access_token.to_string(),
                    enabled: true,
                    rate_limit_scope: "connection".to_owned(),
                    auth_scheme: "bearer".to_owned(),
                    label: Some(label),
                    account_email: email,
                    expires_at_unix: Some(parsed.expires_at_unix),
                    credential_type: "oauth".to_owned(),
                    oauth_provider: Some("codex".to_owned()),
                    refresh_token: Some(parsed.refresh_token.to_string()),
                },
                Some(parsed.session_metadata),
                actor,
                enforced_tenant,
            )
            .await?;
        self.record_audit_event(
            AuditContext {
                action: "provider.credentials.imported",
                actor,
                tenant_id,
                target: &provider_id,
                resource_type: "provider_credentials",
            },
            Option::<&serde_json::Value>::None,
            Some(&serde_json::json!({
                "provider": "codex",
                "created": created,
                "has_email": connection.account_email.is_some(),
            })),
        )
        .await;
        Ok(ProviderAuthImportView {
            connection,
            created,
        })
    }

    async fn import_claude_auth_as(
        &self,
        input: ProviderAuthImportInput,
        actor: &str,
        enforced_tenant: Option<&str>,
        expected_connection_id: Option<&str>,
    ) -> Result<ProviderAuthImportView, &'static str> {
        validate_actor(actor)?;
        let tenant_id = enforced_tenant.unwrap_or("red");
        validate_id(tenant_id)?;
        let raw = match input.source {
            ProviderAuthImportSource::Json { json } => json,
            ProviderAuthImportSource::Text { text } => {
                if text.len() > 256 * 1024 {
                    return Err("Claude auth file is too large");
                }
                serde_json::from_str(&text).map_err(|_| "invalid Claude auth JSON")?
            }
        };
        let parsed = parse_claude_auth(raw)?;
        let bootstrap = self
            .claude_bootstrap_identity(parsed.access_token.as_str())
            .await;
        let email = input.email.or(bootstrap.email);
        let account_id = bootstrap
            .account_id
            .filter(|value| valid_uuid(value))
            .ok_or("Claude account identity could not be verified")?;
        let identity = format!("account:{account_id}");
        let mut session: serde_json::Value = serde_json::from_str(parsed.session_metadata.as_str())
            .map_err(|_| "invalid Claude session metadata")?;
        let session = session
            .as_object_mut()
            .ok_or("invalid Claude session metadata")?;
        let mut device = Zeroizing::new([0_u8; 32]);
        getrandom::fill(device.as_mut()).map_err(|_| "cannot generate Claude device identity")?;
        session.insert(
            "accountUUID".to_owned(),
            serde_json::Value::String(account_id),
        );
        session.insert(
            "cliUserID".to_owned(),
            serde_json::Value::String(hex::encode(device.as_slice())),
        );
        let session = Zeroizing::new(serde_json::Value::Object(session.clone()).to_string());
        let provider_id = provider_import_id("claude", tenant_id, &identity);
        if expected_connection_id.is_some_and(|expected| expected != provider_id) {
            return Err("invalid provider OAuth connection");
        }
        let existing = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|provider| provider.id == provider_id);
        if existing.is_some() && !input.overwrite_existing {
            return Err("Claude account already exists");
        }
        if existing
            .as_ref()
            .is_some_and(|provider| provider.provider != "claude")
        {
            return Err("Claude account identifier conflicts with another provider");
        }
        let created = existing.is_none();
        let label = input
            .name
            .or_else(|| email.clone())
            .unwrap_or_else(|| "Claude (imported)".to_owned());
        let connection = self
            .configure_provider_as(
                &provider_id,
                ProviderInput {
                    node_id: None,
                    protocol: None,
                    priority: None,
                    default_model: None,
                    tenant_id: Some(tenant_id.to_owned()),
                    provider: "claude".to_owned(),
                    upstream_url: self.0.oauth_refresh.claude_provider_endpoint.to_string(),
                    api_key: parsed.access_token.to_string(),
                    enabled: true,
                    rate_limit_scope: "connection".to_owned(),
                    auth_scheme: "bearer".to_owned(),
                    label: Some(label),
                    account_email: email,
                    expires_at_unix: Some(parsed.expires_at_unix),
                    credential_type: "oauth".to_owned(),
                    oauth_provider: Some("claude".to_owned()),
                    refresh_token: Some(parsed.refresh_token.to_string()),
                },
                Some(session),
                actor,
                enforced_tenant,
            )
            .await?;
        self.record_audit_event(
            AuditContext {
                action: "provider.credentials.imported",
                actor,
                tenant_id,
                target: &provider_id,
                resource_type: "provider_credentials",
            },
            Option::<&serde_json::Value>::None,
            Some(&serde_json::json!({
                "provider": "claude",
                "created": created,
                "has_email": connection.account_email.is_some(),
                "identity_verified": true,
            })),
        )
        .await;
        Ok(ProviderAuthImportView {
            connection,
            created,
        })
    }

    async fn import_agy_auth_as(
        &self,
        input: ProviderAuthImportInput,
        actor: &str,
        enforced_tenant: Option<&str>,
        expected_connection_id: Option<&str>,
    ) -> Result<ProviderAuthImportView, &'static str> {
        validate_actor(actor)?;
        let tenant_id = enforced_tenant.unwrap_or("red");
        validate_id(tenant_id)?;
        let raw = match input.source {
            ProviderAuthImportSource::Json { json } => json,
            ProviderAuthImportSource::Text { text } => {
                if text.len() > 256 * 1024 {
                    return Err("Antigravity auth file is too large");
                }
                serde_json::from_str(&text).map_err(|_| "invalid Antigravity auth JSON")?
            }
        };
        let mut parsed = parse_agy_auth(raw)?;
        let bootstrap = self
            .agy_bootstrap_identity(parsed.access_token.as_str())
            .await;
        let email = input.email.or(bootstrap.email);
        let identity = email
            .as_deref()
            .map(|value| format!("email:{}", value.to_ascii_lowercase()));
        if identity.is_none() && !input.overwrite_existing {
            return Err("Antigravity account identity could not be verified");
        }
        let identity = identity.unwrap_or_else(|| {
            let mut digest = Sha256::new();
            digest.update(parsed.refresh_token.as_bytes());
            format!("token:{}", hex::encode(digest.finalize()))
        });
        let metadata = serde_json::from_str::<serde_json::Value>(parsed.session_metadata.as_str())
            .map_err(|_| "invalid Antigravity session metadata")?;
        parsed.session_metadata = Zeroizing::new(
            serde_json::json!({
                "clientProfile": "cli",
                "tokenType": metadata.get("tokenType").cloned().unwrap_or(serde_json::json!("Bearer")),
                "authMethod": metadata.get("authMethod").cloned().unwrap_or(serde_json::Value::Null),
                "projectId": bootstrap.project_id,
            })
            .to_string(),
        );
        let provider_id = provider_import_id("agy", tenant_id, &identity);
        if expected_connection_id.is_some_and(|expected| expected != provider_id) {
            return Err("invalid provider OAuth connection");
        }
        let existing = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|provider| provider.id == provider_id);
        if existing.is_some() && !input.overwrite_existing {
            return Err("Antigravity account already exists");
        }
        if existing
            .as_ref()
            .is_some_and(|provider| provider.provider != "agy")
        {
            return Err("Antigravity account identifier conflicts with another provider");
        }
        let created = existing.is_none();
        let label = input
            .name
            .or_else(|| email.clone())
            .unwrap_or_else(|| "Antigravity CLI (imported)".to_owned());
        let connection = self
            .configure_provider_as(
                &provider_id,
                ProviderInput {
                    node_id: None,
                    protocol: None,
                    priority: None,
                    default_model: None,
                    tenant_id: Some(tenant_id.to_owned()),
                    provider: "agy".to_owned(),
                    upstream_url: self.0.oauth_refresh.agy_provider_endpoint.to_string(),
                    api_key: parsed.access_token.to_string(),
                    enabled: true,
                    rate_limit_scope: "connection".to_owned(),
                    auth_scheme: "bearer".to_owned(),
                    label: Some(label),
                    account_email: email,
                    expires_at_unix: Some(parsed.expires_at_unix),
                    credential_type: "oauth".to_owned(),
                    oauth_provider: Some("agy".to_owned()),
                    refresh_token: Some(parsed.refresh_token.to_string()),
                },
                Some(parsed.session_metadata),
                actor,
                enforced_tenant,
            )
            .await?;
        self.record_audit_event(
            AuditContext {
                action: "provider.credentials.imported",
                actor,
                tenant_id,
                target: &provider_id,
                resource_type: "provider_credentials",
            },
            Option::<&serde_json::Value>::None,
            Some(&serde_json::json!({
                "provider": "agy",
                "created": created,
                "has_email": connection.account_email.is_some(),
                "identity_verified": !identity.starts_with("token:"),
            })),
        )
        .await;
        Ok(ProviderAuthImportView {
            connection,
            created,
        })
    }

    async fn export_provider_auth_as(
        &self,
        id: &str,
        expected_provider: &str,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<ProviderAuthExport, &'static str> {
        validate_id(id)?;
        validate_actor(actor)?;
        if !matches!(expected_provider, "codex" | "claude") {
            return Err("unsupported provider session export");
        }
        let (_, auth, _) = self.provider_oauth_records(id, enforced_tenant).await?;
        let now = i64::try_from(unix_time_seconds()?).map_err(|_| "system clock is invalid")?;
        if auth.expires_at_unix <= now.saturating_add(OAUTH_REFRESH_LEAD_SECONDS) {
            let refreshed = self
                .refresh_provider_oauth_as(id, Some(actor), enforced_tenant)
                .await?;
            if !refreshed.ok {
                return Err(if refreshed.category == "reauth_required" {
                    "provider session requires reauthentication"
                } else {
                    "provider session refresh is unavailable"
                });
            }
        }
        let (provider, auth, oauth) = self.provider_oauth_records(id, enforced_tenant).await?;
        if provider.provider != expected_provider || oauth.oauth_provider != expected_provider {
            return Err("provider session type does not match export");
        }
        let session = self
            .0
            .database
            .provider_sessions()
            .await?
            .into_iter()
            .find(|session| session.provider_id == id)
            .ok_or("provider session export requires reauthentication")?;
        if session.revision != provider.updated_at || session.provider != expected_provider {
            return Err("provider session revision mismatch");
        }
        let access_token = decrypt_async(
            &provider.credential_ciphertext,
            id,
            self.0.encryption_key.as_str(),
        )
        .await?;
        let refresh_aad = format!("{id}:oauth-refresh");
        let refresh_token = decrypt_async(
            &oauth.refresh_token_ciphertext,
            &refresh_aad,
            self.0.encryption_key.as_str(),
        )
        .await?;
        let session_aad = format!("{id}:oauth-session");
        let metadata = decrypt_async(
            &session.session_ciphertext,
            &session_aad,
            self.0.encryption_key.as_str(),
        )
        .await?;
        let metadata: serde_json::Value = serde_json::from_str(metadata.as_str())
            .map_err(|_| "provider session metadata is invalid")?;
        let label = if auth.account_email.is_empty() {
            auth.label.as_str()
        } else {
            auth.account_email.as_str()
        };
        let file_label = sanitize_auth_file_name(label);
        let (file_name, payload) = if expected_provider == "codex" {
            let id_token = json_non_empty_string(metadata.get("id_token"))
                .ok_or("Codex session requires reauthentication")?;
            let parsed = parse_codex_auth(serde_json::json!({
                "auth_mode":"chatgpt",
                "tokens":{
                    "id_token":id_token,
                    "access_token":access_token.as_str(),
                    "refresh_token":refresh_token.as_str(),
                }
            }))?;
            let last_refresh = ::time::OffsetDateTime::now_utc()
                .format(&::time::format_description::well_known::Rfc3339)
                .map_err(|_| "system clock is invalid")?;
            (
                format!("auth-{file_label}.json"),
                serde_json::json!({
                    "auth_mode":"chatgpt",
                    "OPENAI_API_KEY":serde_json::Value::Null,
                    "tokens":{
                        "id_token":id_token,
                        "access_token":access_token.as_str(),
                        "refresh_token":refresh_token.as_str(),
                        "account_id":parsed.account_id,
                    },
                    "last_refresh":last_refresh,
                }),
            )
        } else {
            let expires_at = auth
                .expires_at_unix
                .checked_mul(1_000)
                .ok_or("provider credential expiry is invalid")?;
            let mut claude = serde_json::json!({
                "accessToken":access_token.as_str(),
                "refreshToken":refresh_token.as_str(),
                "expiresAt":expires_at,
                "scopes":metadata.get("scopes").cloned().unwrap_or_else(|| serde_json::json!([])),
            });
            if let Some(value) = metadata
                .get("subscriptionType")
                .and_then(serde_json::Value::as_str)
            {
                claude["subscriptionType"] = serde_json::Value::String(value.to_owned());
            }
            if let Some(value) = metadata
                .get("rateLimitTier")
                .and_then(serde_json::Value::as_str)
            {
                claude["rateLimitTier"] = serde_json::Value::String(value.to_owned());
            }
            (
                format!("claude-auth-{file_label}.json"),
                serde_json::json!({"claudeAiOauth":claude}),
            )
        };
        self.record_audit_event(
            AuditContext {
                action: "provider.credentials.exported",
                actor,
                tenant_id: &provider.tenant_id,
                target: id,
                resource_type: "provider_credentials",
            },
            Option::<&serde_json::Value>::None,
            Some(&serde_json::json!({"provider":expected_provider})),
        )
        .await;
        let mut content = serde_json::to_string_pretty(&payload)
            .map_err(|_| "cannot encode provider session export")?;
        content.push('\n');
        Ok(ProviderAuthExport { file_name, content })
    }

    async fn claude_bootstrap_identity(&self, access_token: &str) -> ClaudeBootstrapIdentity {
        let request = self
            .0
            .oauth_refresh_client
            .get(self.0.oauth_refresh.claude_bootstrap_endpoint.clone())
            .bearer_auth(access_token)
            .header("anthropic-version", "2023-06-01")
            .header("anthropic-beta", "oauth-2025-04-20")
            .header(header::USER_AGENT, CLAUDE_CLI_USER_AGENT)
            .header(header::CONTENT_TYPE, "application/json");
        let Ok(response) = request.send().await else {
            return ClaudeBootstrapIdentity {
                account_id: None,
                email: None,
            };
        };
        if !response.status().is_success() {
            return ClaudeBootstrapIdentity {
                account_id: None,
                email: None,
            };
        }
        let Ok(body) = read_bounded_response(response, OAUTH_REFRESH_MAX_BODY_BYTES).await else {
            return ClaudeBootstrapIdentity {
                account_id: None,
                email: None,
            };
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) else {
            return ClaudeBootstrapIdentity {
                account_id: None,
                email: None,
            };
        };
        let account = value
            .get("oauth_account")
            .and_then(serde_json::Value::as_object);
        let account_id = account
            .and_then(|account| json_non_empty_string(account.get("account_uuid")))
            .or_else(|| json_non_empty_string(value.get("account_uuid")))
            .filter(|value| value.len() <= 512 && !value.chars().any(char::is_control))
            .map(str::to_owned);
        let email = account
            .and_then(|account| json_non_empty_string(account.get("account_email")))
            .or_else(|| json_non_empty_string(value.get("account_email")))
            .filter(|value| validate_provider_account_email(value).is_ok())
            .map(str::to_owned);
        ClaudeBootstrapIdentity { account_id, email }
    }

    async fn agy_bootstrap_identity(&self, access_token: &str) -> AgyBootstrapIdentity {
        let mut identity = AgyBootstrapIdentity::default();
        let mut userinfo = self.0.oauth_refresh.agy_userinfo_endpoint.clone();
        userinfo.set_query(Some("alt=json"));
        let userinfo_request = self
            .0
            .oauth_refresh_client
            .get(userinfo)
            .bearer_auth(access_token);
        if let Some(value) = bounded_json_response(userinfo_request).await {
            identity.email = json_non_empty_string(value.get("email"))
                .filter(|value| validate_provider_account_email(value).is_ok())
                .map(str::to_owned);
        }
        let platform = if cfg!(target_os = "windows") {
            5
        } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            2
        } else if cfg!(target_os = "macos") {
            1
        } else if cfg!(target_arch = "aarch64") {
            4
        } else if cfg!(target_os = "linux") {
            3
        } else {
            0
        };
        let request = self
            .0
            .oauth_refresh_client
            .post(self.0.oauth_refresh.agy_load_code_assist_endpoint.clone())
            .bearer_auth(access_token)
            .header(header::CONTENT_TYPE, "application/json")
            .header(
                header::USER_AGENT,
                "antigravity/cli/1.1.5 (aidev_client; os_type=darwin; arch=arm64; auth_method=consumer)",
            )
            .body(
                serde_json::json!({"metadata":{"ideType":9,"platform":platform,"pluginType":2}})
                    .to_string(),
            );
        if let Some(value) = bounded_json_response(request).await {
            identity.project_id = match value.get("cloudaicompanionProject") {
                Some(serde_json::Value::String(value)) => Some(value.as_str()),
                Some(serde_json::Value::Object(value)) => {
                    value.get("id").and_then(serde_json::Value::as_str)
                }
                _ => None,
            }
            .filter(|value| {
                !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
            })
            .map(str::to_owned);
        }
        identity
    }

    async fn configure_provider_as(
        &self,
        id: &str,
        mut input: ProviderInput,
        mut session_metadata: Option<Zeroizing<String>>,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<ProviderView, &'static str> {
        validate_id(id)?;
        validate_actor(actor)?;
        if input
            .priority
            .is_some_and(|value| !valid_provider_priority(value))
        {
            return Err("provider priority must be a safe integer");
        }
        let _mutation = self.0.mutation.lock().await;
        let existing = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|provider| provider.id == id);
        let default_model = input.default_model.take().unwrap_or_else(|| {
            existing
                .as_ref()
                .and_then(|provider| provider.default_model.clone())
        });
        if default_model
            .as_ref()
            .is_some_and(|value| !model_aliases::valid_model_name(value))
        {
            return Err("invalid provider default model");
        }
        let node_id = input.node_id.take().unwrap_or_else(|| {
            existing
                .as_ref()
                .and_then(|provider| provider.node_id.clone())
        });
        if let Some(node_id) = node_id.as_deref() {
            if input.credential_type != "static" {
                return Err("Provider definitions require API credentials");
            }
            let tenant_id = input
                .tenant_id
                .as_deref()
                .or_else(|| {
                    existing
                        .as_ref()
                        .map(|provider| provider.tenant_id.as_str())
                })
                .or(enforced_tenant)
                .unwrap_or("red");
            let node = self.provider_node(node_id, tenant_id).await?;
            input.provider = node.prefix;
            input.upstream_url = node.upstream_url;
            input.protocol = Some(node.protocol);
        }
        validate_provider(&input.provider)?;
        if input.upstream_url.len() > 2048 {
            return Err("provider upstream URL is too long");
        }
        let existing_oauth = self
            .0
            .database
            .provider_oauth()
            .await?
            .into_iter()
            .find(|oauth| {
                oauth.provider_id == id
                    && existing
                        .as_ref()
                        .is_some_and(|provider| oauth.revision == provider.updated_at)
            });
        let existing_auth = self
            .0
            .database
            .provider_auth()
            .await?
            .into_iter()
            .find(|auth| {
                auth.provider_id == id
                    && existing
                        .as_ref()
                        .is_some_and(|provider| auth.revision == provider.updated_at)
            });
        let existing_session =
            self.0
                .database
                .provider_sessions()
                .await?
                .into_iter()
                .find(|session| {
                    session.provider_id == id
                        && existing
                            .as_ref()
                            .is_some_and(|provider| session.revision == provider.updated_at)
                });
        let protocol = input.protocol.take().unwrap_or_else(|| {
            existing
                .as_ref()
                .map(|provider| provider.protocol.clone())
                .unwrap_or_else(|| "auto".to_owned())
        });
        ProviderProtocol::from_configuration(&input.upstream_url, &protocol)?;
        if input.credential_type == "oauth" && protocol != "auto" {
            return Err("OAuth connections own their upstream protocol");
        }
        let auth_scheme = ProviderAuthScheme::parse(&input.auth_scheme)?;
        let unauthenticated = auth_scheme == ProviderAuthScheme::None;
        if unauthenticated
            && (input.credential_type != "static"
                || !input.api_key.is_empty()
                || input.expires_at_unix.is_some_and(|expiry| expiry != 0))
        {
            return Err("Unauthenticated providers require an empty credential and no expiry");
        }
        let replacing_access_token = !input.api_key.is_empty();
        let api_key = if unauthenticated {
            Zeroizing::new(String::new())
        } else if replacing_access_token {
            if input.api_key.len() > 8192 {
                return Err("provider credential must be 1-8192 bytes");
            }
            Zeroizing::new(std::mem::take(&mut input.api_key))
        } else {
            let existing = existing
                .as_ref()
                .ok_or("provider credential must be 1-8192 bytes")?;
            decrypt_async(
                &existing.credential_ciphertext,
                id,
                self.0.encryption_key.as_str(),
            )
            .await?
        };
        let rate_limit_scope = RateLimitScope::parse(&input.rate_limit_scope)?;
        if !replacing_access_token && !unauthenticated {
            let existing = existing
                .as_ref()
                .ok_or("provider credential must be 1-8192 bytes")?;
            let existing_auth_scheme = existing_auth
                .as_ref()
                .map(|auth| auth.auth_scheme.as_str())
                .unwrap_or("auto");
            if existing.provider != input.provider
                || existing.upstream_url != input.upstream_url
                || existing.protocol != protocol
                || existing.node_id != node_id
                || existing_auth_scheme != auth_scheme.as_str()
                || (input.credential_type == "oauth") != existing_oauth.is_some()
            {
                return Err(
                    "provider credential is required when changing upstream or authentication",
                );
            }
        }
        let label = input.label.as_deref().unwrap_or(id).trim();
        validate_provider_label(label)?;
        let account_email = input.account_email.as_deref().unwrap_or("").trim();
        validate_provider_account_email(account_email)?;
        let expires_at_unix = input
            .expires_at_unix
            .map(|value| i64::try_from(value).map_err(|_| "provider credential expiry is invalid"))
            .transpose()?
            .unwrap_or(0);
        let oauth_provider = match input.credential_type.as_str() {
            "static" => {
                if input.oauth_provider.is_some() || input.refresh_token.is_some() {
                    return Err("static provider credential cannot include OAuth fields");
                }
                None
            }
            "oauth" => {
                let oauth_provider = input
                    .oauth_provider
                    .as_deref()
                    .ok_or("OAuth provider is required")?;
                if !matches!(
                    oauth_provider,
                    "codex" | "claude" | "agy" | "github" | "xai-oauth" | "openference"
                ) {
                    return Err("unsupported OAuth provider");
                }
                if input.provider != oauth_provider {
                    return Err("OAuth provider must match provider type");
                }
                if auth_scheme != ProviderAuthScheme::Bearer {
                    return Err("OAuth provider authentication must use bearer");
                }
                if let Some(refresh_token) = input.refresh_token.as_deref() {
                    if !(1..=8192).contains(&refresh_token.len()) {
                        return Err("OAuth refresh token must be 1-8192 bytes");
                    }
                } else if !existing_oauth
                    .as_ref()
                    .is_some_and(|oauth| oauth.oauth_provider == oauth_provider)
                {
                    return Err("OAuth refresh token is required");
                }
                if expires_at_unix <= 0 {
                    return Err("OAuth credential expiry is required");
                }
                Some(oauth_provider.to_owned())
            }
            _ => return Err("unsupported provider credential type"),
        };
        if oauth_provider.as_deref() == Some("claude") {
            if let Some(metadata) = session_metadata.as_deref() {
                validate_claude_session_metadata(metadata)?;
            } else if replacing_access_token || input.refresh_token.is_some() {
                // A raw Claude token pair is not a complete CLI identity. Verify the
                // account with Anthropic before writing anything and bind a stable
                // per-connection device identity to the encrypted session record.
                let bootstrap = self.claude_bootstrap_identity(api_key.as_str()).await;
                let account_uuid = bootstrap
                    .account_id
                    .filter(|value| valid_uuid(value))
                    .ok_or("Claude account identity could not be verified")?;
                let existing_metadata = match existing_session.as_ref() {
                    Some(session) => {
                        let aad = format!("{id}:oauth-session");
                        decrypt_async(
                            &session.session_ciphertext,
                            &aad,
                            self.0.encryption_key.as_str(),
                        )
                        .await
                        .ok()
                    }
                    None => None,
                };
                let existing_identity = existing_metadata
                    .and_then(|metadata| claude_session_identity(metadata.as_str()).ok())
                    .filter(|(_, account)| account.eq_ignore_ascii_case(&account_uuid));
                let cli_user_id = if let Some((device, _)) = existing_identity {
                    device
                } else {
                    let mut device = Zeroizing::new([0_u8; 32]);
                    getrandom::fill(device.as_mut())
                        .map_err(|_| "cannot generate Claude device identity")?;
                    hex::encode(device.as_slice())
                };
                session_metadata = Some(Zeroizing::new(
                    serde_json::json!({
                        "accountUUID": account_uuid,
                        "cliUserID": cli_user_id,
                    })
                    .to_string(),
                ));
            } else {
                let existing_session = existing_session
                    .as_ref()
                    .ok_or("Claude OAuth requires a verified CLI session")?;
                let aad = format!("{id}:oauth-session");
                let metadata = decrypt_async(
                    &existing_session.session_ciphertext,
                    &aad,
                    self.0.encryption_key.as_str(),
                )
                .await?;
                validate_claude_session_metadata(metadata.as_str())?;
            }
        }
        if input.enabled
            && expires_at_unix > 0
            && expires_at_unix <= i64::try_from(unix_time_seconds()?).unwrap_or(i64::MAX)
        {
            return Err("provider credential is already expired");
        }
        // Resolve and pin DNS before changing durable or live configuration.
        let live = ProxyState::live_provider(
            &input.upstream_url,
            api_key.as_str(),
            self.0.allow_private,
            auth_scheme,
            expires_at_unix,
            &protocol,
            node_id.is_some(),
        )
        .await?;
        let tenant_id = input
            .tenant_id
            .as_deref()
            .or_else(|| {
                existing
                    .as_ref()
                    .map(|provider| provider.tenant_id.as_str())
            })
            .or(enforced_tenant)
            .unwrap_or("red");
        validate_id(tenant_id)?;
        if existing
            .as_ref()
            .is_some_and(|provider| provider.tenant_id != tenant_id)
            || enforced_tenant.is_some_and(|required| required != tenant_id)
        {
            return Err("provider tenant cannot be changed");
        }
        if !self
            .0
            .database
            .tenants()
            .await?
            .iter()
            .any(|tenant| tenant.id == tenant_id && tenant.enabled)
        {
            return Err("provider tenant is unavailable");
        }
        if input.enabled {
            self.ensure_provider_protocol_compatible(id, tenant_id, live.protocol)
                .await?;
        } else {
            self.ensure_provider_not_in_enabled_combo(id, tenant_id)
                .await?;
        }
        let revision = revision()?;
        let ciphertext =
            encrypt_async(api_key.as_str(), id, self.0.encryption_key.as_str()).await?;
        let stored = StoredProvider {
            node_id,
            protocol,
            priority: input
                .priority
                .or_else(|| existing.as_ref().map(|record| record.priority))
                .unwrap_or(0),
            default_model,
            id: id.to_owned(),
            tenant_id: tenant_id.to_owned(),
            provider: input.provider,
            upstream_url: input.upstream_url,
            credential_ciphertext: ciphertext,
            enabled: input.enabled,
            updated_at: revision,
        };
        let resilience = StoredResilience {
            provider_id: id.to_owned(),
            rate_limit_scope: rate_limit_scope.as_str().to_owned(),
            revision,
        };
        let provider_auth = StoredProviderAuth {
            provider_id: id.to_owned(),
            auth_scheme: auth_scheme.as_str().to_owned(),
            label: label.to_owned(),
            account_email: account_email.to_owned(),
            expires_at_unix,
            revision,
        };
        self.0
            .database
            .upsert_provider_resilience(&resilience)
            .await?;
        self.0.database.upsert_provider_auth(&provider_auth).await?;
        self.0.database.upsert_provider(&stored).await?;
        let provider_oauth = if let Some(oauth_provider) = oauth_provider {
            let oauth = if let Some(refresh_token) = input.refresh_token.as_deref() {
                let refresh_token = Zeroizing::new(refresh_token.to_owned());
                let aad = format!("{id}:oauth-refresh");
                StoredProviderOAuth {
                    provider_id: id.to_owned(),
                    oauth_provider,
                    refresh_token_ciphertext: encrypt_async(
                        refresh_token.as_str(),
                        &aad,
                        self.0.encryption_key.as_str(),
                    )
                    .await?,
                    generation: existing_oauth
                        .as_ref()
                        .map_or(0, |oauth| oauth.generation.saturating_add(1)),
                    revision,
                }
            } else {
                let existing_oauth = existing_oauth
                    .as_ref()
                    .ok_or("OAuth refresh token is required")?;
                StoredProviderOAuth {
                    provider_id: id.to_owned(),
                    oauth_provider,
                    refresh_token_ciphertext: existing_oauth.refresh_token_ciphertext.clone(),
                    generation: existing_oauth.generation,
                    revision,
                }
            };
            self.0.database.upsert_provider_oauth(&oauth).await?;
            Some(oauth)
        } else {
            self.0.database.delete_provider_oauth(id).await?;
            None
        };
        if let Some(session_metadata) = session_metadata {
            if provider_oauth.is_none() {
                return Err("provider session requires OAuth credentials");
            }
            let aad = format!("{id}:oauth-session");
            self.0
                .database
                .upsert_provider_session(&StoredProviderSession {
                    provider_id: id.to_owned(),
                    provider: stored.provider.clone(),
                    session_ciphertext: encrypt_async(
                        session_metadata.as_str(),
                        &aad,
                        self.0.encryption_key.as_str(),
                    )
                    .await?,
                    revision,
                })
                .await?;
        } else if provider_oauth.is_some()
            && !replacing_access_token
            && input.refresh_token.is_none()
            && existing_session
                .as_ref()
                .is_some_and(|session| session.provider == stored.provider)
        {
            let existing_session = existing_session
                .as_ref()
                .ok_or("provider session metadata is unavailable")?;
            self.0
                .database
                .upsert_provider_session(&StoredProviderSession {
                    provider_id: id.to_owned(),
                    provider: stored.provider.clone(),
                    session_ciphertext: existing_session.session_ciphertext.clone(),
                    revision,
                })
                .await?;
        } else {
            self.0.database.delete_provider_session(id).await?;
        }
        self.0.database.delete_provider_oauth_status(id).await?;
        let before = existing.as_ref().map(provider_audit_snapshot);
        let mut after = provider_audit_snapshot(&stored);
        after["auth_scheme"] = auth_scheme.as_str().into();
        after["has_credential"] = (!unauthenticated).into();
        self.record_audit_event(
            AuditContext {
                action: if before.is_some() {
                    "provider.update"
                } else {
                    "provider.create"
                },
                actor,
                tenant_id: &stored.tenant_id,
                target: id,
                resource_type: "provider",
            },
            before.as_ref(),
            Some(&after),
        )
        .await;
        // Refresh from the durable authority so concurrent writers converge on
        // the same latest enabled record rather than on local write order.
        if let Err(error) = self.refresh().await {
            *self.0.current.write().await = None;
            return Err(error);
        }
        if let Err(error) = self.refresh_routes().await {
            *self.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        self.availability_for(id).await.reset().await?;
        // Avoid retaining an extra sensitive client/header graph for disabled rows.
        drop(live);
        view(
            &stored,
            rate_limit_scope,
            Some(&provider_auth),
            provider_oauth.as_ref(),
            None,
        )
    }

    async fn diagnose_provider_as(
        &self,
        id: &str,
        input: ProviderDiagnosticInput,
        enforced_tenant: Option<&str>,
    ) -> Result<ProviderDiagnosticView, &'static str> {
        validate_id(id)?;
        validate_diagnostic_model(&input.model)?;
        let provider = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|provider| provider.id == id)
            .ok_or("provider does not exist")?;
        if enforced_tenant.is_some_and(|tenant| tenant != provider.tenant_id) {
            return Err("provider tenant is unavailable");
        }
        let auth = self
            .auth_settings()
            .await?
            .remove(&(provider.id.clone(), provider.updated_at))
            .unwrap_or_else(|| default_provider_auth(&provider));
        if auth.expires_at_unix > 0
            && auth.expires_at_unix <= i64::try_from(unix_time_seconds()?).unwrap_or(i64::MAX)
        {
            return Ok(ProviderDiagnosticView {
                provider_id: provider.id,
                model: input.model,
                ok: false,
                category: "credential_expired",
                upstream_status: None,
                latency_ms: 0,
            });
        }
        let credential = decrypt_async(
            &provider.credential_ciphertext,
            &provider.id,
            self.0.encryption_key.as_str(),
        )
        .await?;
        let live = ProxyState::live_provider(
            &provider.upstream_url,
            credential.as_str(),
            self.0.allow_private,
            ProviderAuthScheme::parse(&auth.auth_scheme)?,
            auth.expires_at_unix,
            &provider.protocol,
            provider.node_id.is_some(),
        )
        .await?;
        let mut live = live;
        live.custom_headers = self.request_headers(&provider).await?;
        probe_provider(&live, provider.id, input.model).await
    }

    async fn rotate_provider_oauth_as(
        &self,
        id: &str,
        input: ProviderOAuthRotationInput,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<ProviderView, &'static str> {
        validate_id(id)?;
        validate_actor(actor)?;
        if !(1..=8192).contains(&input.access_token.len())
            || !(1..=8192).contains(&input.refresh_token.len())
        {
            return Err("OAuth tokens must be 1-8192 bytes");
        }
        let expected_generation = input
            .expected_generation
            .parse::<i64>()
            .ok()
            .filter(|value| *value >= 0)
            .ok_or("provider OAuth generation is invalid")?;
        let expires_at_unix = i64::try_from(input.expires_at_unix)
            .map_err(|_| "provider credential expiry is invalid")?;
        if expires_at_unix <= i64::try_from(unix_time_seconds()?).unwrap_or(i64::MAX) {
            return Err("provider credential is already expired");
        }
        let access_token = Zeroizing::new(input.access_token);
        let refresh_token = Zeroizing::new(input.refresh_token);
        let _mutation = self.0.mutation.lock().await;
        let provider = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|provider| provider.id == id)
            .ok_or("provider configuration not found")?;
        if enforced_tenant.is_some_and(|tenant| tenant != provider.tenant_id) {
            return Err("provider tenant is unavailable");
        }
        let auth = self
            .auth_settings()
            .await?
            .remove(&(provider.id.clone(), provider.updated_at))
            .ok_or("provider authentication configuration not found")?;
        let oauth = self
            .oauth_settings()
            .await?
            .remove(&(provider.id.clone(), provider.updated_at))
            .ok_or("provider OAuth configuration not found")?;
        if oauth.generation != expected_generation {
            return Err("provider OAuth generation conflict");
        }
        let access_ciphertext =
            encrypt_async(access_token.as_str(), id, self.0.encryption_key.as_str()).await?;
        let aad = format!("{id}:oauth-refresh");
        let refresh_ciphertext =
            encrypt_async(refresh_token.as_str(), &aad, self.0.encryption_key.as_str()).await?;
        let rotated = self
            .0
            .database
            .rotate_provider_oauth_credentials(
                id,
                provider.updated_at,
                expected_generation,
                &access_ciphertext,
                &refresh_ciphertext,
                expires_at_unix,
            )
            .await?;
        if !rotated {
            return Err("provider OAuth generation conflict");
        }
        let before = provider_oauth_audit_snapshot(
            id,
            &oauth.oauth_provider,
            oauth.generation,
            auth.expires_at_unix,
        );
        let after = provider_oauth_audit_snapshot(
            id,
            &oauth.oauth_provider,
            oauth.generation.saturating_add(1),
            expires_at_unix,
        );
        self.record_audit_event(
            AuditContext {
                action: "provider_oauth.rotate",
                actor,
                tenant_id: &provider.tenant_id,
                target: id,
                resource_type: "provider_oauth",
            },
            Some(&before),
            Some(&after),
        )
        .await;
        if let Err(error) = self.refresh().await {
            *self.0.current.write().await = None;
            return Err(error);
        }
        if let Err(error) = self.refresh_routes().await {
            *self.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        self.views(enforced_tenant)
            .await?
            .into_iter()
            .find(|view| view.id == id)
            .ok_or("provider configuration not found")
    }

    pub async fn oidc_view(&self) -> Option<OidcView> {
        let (verifier, browser) = self.oidc_runtime_snapshot().await;
        let verifier = verifier?;
        Some(oidc_view(verifier.policy(), browser.as_deref()))
    }

    async fn oidc_browser_enabled(&self) -> bool {
        let (verifier, browser) = self.oidc_runtime_snapshot().await;
        matches!((verifier, browser), (Some(verifier), Some(browser))
            if verifier.policy().enabled && verifier.policy().revision == browser.revision)
    }

    async fn oidc_runtime_snapshot(
        &self,
    ) -> (
        Option<Arc<crate::oidc::OidcVerifier>>,
        Option<Arc<crate::oidc::OidcBrowserConfig>>,
    ) {
        // Writers publish the verifier and confidential browser client while
        // holding this mutex. Readers take the same mutex so they can never
        // observe the deliberate browser=None transition between revisions.
        let _mutation = self.0.mutation.lock().await;
        let verifier = self.0.oidc.read().await.clone();
        let browser = self.0.oidc_browser.read().await.clone();
        (verifier, browser)
    }

    pub async fn configure_oidc(&self, mut input: OidcInput) -> Result<OidcView, &'static str> {
        if input.clear_browser && input.browser.is_some() {
            return Err("OIDC browser configuration is ambiguous");
        }
        for allowed in input.required_claims.values_mut() {
            for value in allowed {
                *value = value.trim().to_owned();
            }
        }
        for subject in &mut input.allowed_subjects {
            *subject = subject.trim().to_owned();
        }
        crate::oidc::validate_claim_policy(&input.required_claims)?;
        crate::oidc::validate_subjects(&input.allowed_subjects)?;
        let mut record = StoredOidcConfig {
            enabled: input.enabled,
            issuer: input.issuer,
            audience: input.audience,
            jwks_uri: input.jwks_uri,
            required_claims_json: serde_json::to_string(&input.required_claims)
                .map_err(|_| "cannot encode OIDC claim policy")?,
            allowed_subjects_json: serde_json::to_string(&input.allowed_subjects)
                .map_err(|_| "cannot encode OIDC subject policy")?,
            revision: 0,
        };
        let mut candidate = crate::oidc::OidcVerifier::from_stored(&record, self.0.allow_private)?;
        candidate.prime().await?;
        let _mutation = self.0.mutation.lock().await;
        record.revision = revision()?;
        candidate.set_revision(record.revision);
        let browser_record = if input.clear_browser {
            None
        } else if let Some(browser) = input.browser {
            let existing = self.0.database.oidc_browser_config().await?;
            let client_secret_ciphertext = match browser.client_secret {
                Some(mut secret) => {
                    if secret.is_empty() || secret.len() > 4096 {
                        secret.zeroize();
                        return Err("invalid OIDC client secret");
                    }
                    let encrypted = encrypt_async(
                        &secret,
                        "oidc-browser-client-secret",
                        self.0.encryption_key.as_str(),
                    )
                    .await?;
                    secret.zeroize();
                    encrypted
                }
                None => existing
                    .map(|stored| stored.client_secret_ciphertext)
                    .ok_or("OIDC client secret is required")?,
            };
            let stored = StoredOidcBrowserConfig {
                public_origin: browser.public_origin,
                client_id: browser.client_id,
                client_secret_ciphertext,
                authorization_endpoint: browser.authorization_endpoint,
                token_endpoint: browser.token_endpoint,
                scopes_json: serde_json::to_string(&browser.scopes)
                    .map_err(|_| "cannot encode OIDC browser scopes")?,
                revision: record.revision,
            };
            crate::oidc::OidcBrowserConfig::from_stored(&stored)?;
            Some(stored)
        } else {
            self.0
                .database
                .oidc_browser_config()
                .await?
                .map(|mut stored| {
                    stored.revision = record.revision;
                    stored
                })
        };
        // Publish the authorization policy before its browser client. A peer
        // that observes the two writes separately will disable browser login
        // until revisions match instead of retaining the older verifier.
        self.0.database.upsert_oidc(&record).await?;
        if let Some(browser) = &browser_record {
            self.0.database.upsert_oidc_browser(browser).await?;
        } else if input.clear_browser {
            self.0.database.delete_oidc_browser().await?;
        }
        let stored = self
            .0
            .database
            .oidc_config()
            .await?
            .ok_or("cannot reload OIDC configuration")?;
        let verifier = if stored == record {
            candidate
        } else {
            let verifier = crate::oidc::OidcVerifier::from_stored(&stored, self.0.allow_private)?;
            verifier.prime().await?;
            verifier
        };
        let stored_browser = self.0.database.oidc_browser_config().await?;
        let browser = stored_browser
            .as_ref()
            .filter(|browser| browser.revision == stored.revision)
            .map(crate::oidc::OidcBrowserConfig::from_stored)
            .transpose()?
            .map(Arc::new);
        *self.0.oidc_browser.write().await = None;
        *self.0.oidc.write().await = Some(Arc::new(verifier));
        *self.0.oidc_browser.write().await = browser.clone();
        *self.0.oidc_snapshot_signature.write().await = self.oidc_runtime_signature().await?;
        oidc_stored_view(&stored, browser.as_deref())
    }

    pub async fn delete_oidc(&self) -> Result<(), &'static str> {
        let _mutation = self.0.mutation.lock().await;
        self.clear_oidc_runtime().await;
        self.0.database.delete_oidc_browser().await?;
        self.0.database.delete_oidc().await?;
        *self.0.oidc_snapshot_signature.write().await = self.oidc_runtime_signature().await?;
        Ok(())
    }

    async fn start_oidc_login(&self, test: bool) -> Result<BrowserLogin, &'static str> {
        let (verifier, browser) = self.oidc_runtime_snapshot().await;
        let verifier = verifier.ok_or("OIDC is disabled")?;
        let browser = browser.ok_or("OIDC browser login is disabled")?;
        if !verifier.policy().enabled || browser.revision != verifier.policy().revision {
            return Err("OIDC browser login is disabled");
        }
        let now = unix_time_seconds()?;
        let state = random_token(24)?;
        let nonce = random_token(24)?;
        let verifier_value = random_token(32)?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier_value.as_bytes()));
        let flow = OidcFlowState {
            state: state.clone(),
            nonce: nonce.clone(),
            verifier: verifier_value,
            expires_at: now
                .checked_add(OIDC_FLOW_SECONDS)
                .ok_or("system clock is out of range")?,
            revision: browser.revision,
            test,
        };
        let flow = serde_json::to_string(&flow).map_err(|_| "cannot encode OIDC login state")?;
        let flow_cookie = encrypt_async(
            &flow,
            "oidc-browser-login-flow",
            self.0.encryption_key.as_str(),
        )
        .await?;
        let mut location = browser.authorization_endpoint.clone();
        location
            .query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &browser.client_id)
            .append_pair("redirect_uri", &browser.callback_uri())
            .append_pair("scope", &browser.scopes.join(" "))
            .append_pair("state", &state)
            .append_pair("nonce", &nonce)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        Ok(BrowserLogin {
            location: location.to_string(),
            flow_cookie,
            secure: browser.secure_cookies(),
        })
    }

    async fn complete_oidc_login(
        &self,
        flow_cookie: &str,
        code: &str,
        returned_state: &str,
    ) -> Result<BrowserCallback, &'static str> {
        if flow_cookie.len() > 8192 || code.is_empty() || returned_state.is_empty() {
            return Err("invalid OIDC authorization response");
        }
        let flow = decrypt_async(
            flow_cookie,
            "oidc-browser-login-flow",
            self.0.encryption_key.as_str(),
        )
        .await?;
        let flow: OidcFlowState =
            serde_json::from_str(&flow).map_err(|_| "invalid OIDC login state")?;
        let now = unix_time_seconds()?;
        if flow.expires_at < now
            || flow.state.len() != returned_state.len()
            || !bool::from(flow.state.as_bytes().ct_eq(returned_state.as_bytes()))
        {
            return Err("invalid OIDC login state");
        }
        let (verifier, browser) = self.oidc_runtime_snapshot().await;
        let verifier = verifier.ok_or("OIDC is disabled")?;
        let browser = browser.ok_or("OIDC browser login is disabled")?;
        if !verifier.policy().enabled
            || flow.revision != verifier.policy().revision
            || flow.revision != browser.revision
        {
            return Err("OIDC login state is stale");
        }
        let secret = decrypt_async(
            &browser.client_secret_ciphertext,
            "oidc-browser-client-secret",
            self.0.encryption_key.as_str(),
        )
        .await?;
        let identity = verifier
            .exchange_browser_code(&browser, code, &flow.verifier, &flow.nonce, &secret)
            .await?;
        if flow.test {
            return Ok(BrowserCallback::Test {
                location: browser
                    .public_origin
                    .join("/dashboard/settings?tab=security&oidc_test=ok")
                    .map_err(|_| "invalid OIDC public origin")?
                    .to_string(),
                secure: browser.secure_cookies(),
            });
        }
        let bindings = self.0.database.identity_bindings().await?;
        let binding = identity
            .binding_subjects()
            .find_map(|subject| {
                bindings.iter().find(|binding| {
                    binding.enabled && binding.subject == subject && binding.role == "admin"
                })
            })
            .ok_or("OIDC subject has no dashboard authorization")?;
        if !self
            .0
            .database
            .tenants()
            .await?
            .iter()
            .any(|tenant| tenant.enabled && tenant.id == binding.tenant_id)
        {
            return Err("OIDC subject tenant is unavailable");
        }
        let csrf = random_token(32)?;
        let session = AdminSession {
            subject: binding.subject.clone(),
            csrf_hash: hex::encode(Sha256::digest(csrf.as_bytes())),
            expires_at: now
                .checked_add(ADMIN_SESSION_SECONDS)
                .ok_or("system clock is out of range")?,
            revision: browser.revision,
            origin: Some(browser.public_origin.origin().ascii_serialization()),
            bootstrap_hash: None,
        };
        let session = serde_json::to_string(&session).map_err(|_| "cannot encode admin session")?;
        let session_cookie = encrypt_async(
            &session,
            "oidc-browser-admin-session",
            self.0.encryption_key.as_str(),
        )
        .await?;
        Ok(BrowserCallback::Session {
            location: browser
                .public_origin
                .join("/dashboard")
                .map_err(|_| "invalid OIDC public origin")?
                .to_string(),
            session_cookie,
            csrf,
            secure: browser.secure_cookies(),
        })
    }

    async fn create_local_admin_session(
        &self,
        candidate: &str,
        origin: String,
        secure: bool,
    ) -> Result<LocalAdminSession, &'static str> {
        if !(32..=512).contains(&candidate.len()) {
            return Err("invalid admin authentication");
        }
        let digest: [u8; 32] = Sha256::digest(candidate.as_bytes()).into();
        if !bool::from(self.0.admin_hash.ct_eq(&digest)) {
            return Err("invalid admin authentication");
        }
        let now = unix_time_seconds()?;
        let csrf = random_token(32)?;
        let session = AdminSession {
            subject: "bootstrap-admin".to_owned(),
            csrf_hash: hex::encode(Sha256::digest(csrf.as_bytes())),
            expires_at: now
                .checked_add(ADMIN_SESSION_SECONDS)
                .ok_or("system clock is out of range")?,
            revision: 0,
            origin: Some(origin),
            bootstrap_hash: Some(hex::encode(self.0.admin_hash)),
        };
        let session = serde_json::to_string(&session).map_err(|_| "cannot encode admin session")?;
        let session_cookie = encrypt_async(
            &session,
            "oidc-browser-admin-session",
            self.0.encryption_key.as_str(),
        )
        .await?;
        Ok(LocalAdminSession {
            session_cookie,
            csrf,
            secure,
        })
    }

    pub async fn disable(&self, id: &str) -> Result<(), &'static str> {
        self.disable_as(id, "bootstrap-admin", None).await
    }

    async fn ensure_provider_protocol_compatible(
        &self,
        id: &str,
        tenant_id: &str,
        protocol: ProviderProtocol,
    ) -> Result<(), &'static str> {
        let records = self.0.database.combos().await?;
        for combo in records
            .iter()
            .filter(|combo| combo.enabled && combo.tenant_id == tenant_id)
        {
            if ProviderProtocol::parse(&combo.protocol)?.accepts_provider(protocol) {
                continue;
            }
            let view = combo_view(combo)?;
            let targets = resolve_nested_combo_targets(
                &combo.id,
                &combo.tenant_id,
                &combo.protocol,
                &view.targets,
                &records,
            )?;
            if targets.iter().any(|target| target.provider_id == id) {
                return Err("provider protocol is incompatible with an enabled combo");
            }
        }
        Ok(())
    }

    async fn ensure_provider_not_in_enabled_combo(
        &self,
        id: &str,
        tenant_id: &str,
    ) -> Result<(), &'static str> {
        for combo in self
            .0
            .database
            .combos()
            .await?
            .into_iter()
            .filter(|combo| combo.enabled && combo.tenant_id == tenant_id)
        {
            if combo_view(&combo)?
                .targets
                .iter()
                .any(|target| target.provider_id == id)
            {
                return Err("provider is referenced by an enabled combo");
            }
        }
        Ok(())
    }

    async fn disable_as(
        &self,
        id: &str,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<(), &'static str> {
        validate_id(id)?;
        validate_actor(actor)?;
        let _mutation = self.0.mutation.lock().await;
        let provider = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|provider| provider.id == id)
            .ok_or("provider configuration not found")?;
        if enforced_tenant.is_some_and(|tenant| tenant != provider.tenant_id) {
            return Err("provider tenant is unavailable");
        }
        self.ensure_provider_not_in_enabled_combo(id, &provider.tenant_id)
            .await?;
        let scope = self
            .resilience_settings()
            .await?
            .get(&(provider.id.clone(), provider.updated_at))
            .copied()
            .unwrap_or_default();
        let auth = self
            .auth_settings()
            .await?
            .remove(&(provider.id.clone(), provider.updated_at))
            .unwrap_or_else(|| default_provider_auth(&provider));
        let oauth = self
            .oauth_settings()
            .await?
            .remove(&(provider.id.clone(), provider.updated_at));
        let session = self
            .0
            .database
            .provider_sessions()
            .await?
            .into_iter()
            .find(|session| session.provider_id == provider.id);
        if session
            .as_ref()
            .is_some_and(|session| session.revision != provider.updated_at)
        {
            return Err("provider session revision mismatch");
        }
        let revision = revision()?;
        self.0
            .database
            .upsert_provider_resilience(&StoredResilience {
                provider_id: id.to_owned(),
                rate_limit_scope: scope.as_str().to_owned(),
                revision,
            })
            .await?;
        self.0
            .database
            .upsert_provider_auth(&StoredProviderAuth { revision, ..auth })
            .await?;
        if let Some(oauth) = oauth {
            self.0
                .database
                .upsert_provider_oauth(&StoredProviderOAuth { revision, ..oauth })
                .await?;
        }
        if let Some(session) = session {
            self.0
                .database
                .upsert_provider_session(&StoredProviderSession {
                    revision,
                    ..session
                })
                .await?;
        }
        self.0.database.disable_provider(id, revision).await?;
        let before = provider_audit_snapshot(&provider);
        let mut disabled = provider.clone();
        disabled.enabled = false;
        disabled.updated_at = revision;
        let after = provider_audit_snapshot(&disabled);
        self.record_audit_event(
            AuditContext {
                action: "provider.disable",
                actor,
                tenant_id: &provider.tenant_id,
                target: id,
                resource_type: "provider",
            },
            Some(&before),
            Some(&after),
        )
        .await;
        if let Err(error) = self.refresh().await {
            *self.0.current.write().await = None;
            return Err(error);
        }
        if let Err(error) = self.refresh_routes().await {
            *self.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        self.availability_for(id).await.reset().await?;
        Ok(())
    }

    async fn purge_provider_as(
        &self,
        id: &str,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<(), &'static str> {
        validate_id(id)?;
        validate_actor(actor)?;
        let _mutation = self.0.mutation.lock().await;
        let provider = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|provider| provider.id == id)
            .ok_or("provider configuration not found")?;
        if enforced_tenant.is_some_and(|tenant| tenant != provider.tenant_id) {
            return Err("provider tenant is unavailable");
        }
        if provider.enabled {
            return Err("provider must be disabled before removal");
        }
        self.ensure_provider_not_in_enabled_combo(id, &provider.tenant_id)
            .await?;
        for pin in self
            .0
            .database
            .route_pins()
            .await?
            .into_iter()
            .filter(|pin| pin.provider_id == id)
        {
            self.0.database.delete_route_pin(&pin.combo_id).await?;
        }

        self.0.database.delete_provider_header(id).await?;
        self.0.database.delete_provider_discovery(id).await?;
        self.0.database.delete_provider_auth(id).await?;
        self.0.database.delete_provider_oauth(id).await?;
        self.0.database.delete_provider_session(id).await?;
        self.0.database.delete_provider_oauth_status(id).await?;
        self.0.database.delete_provider_quota(id).await?;
        self.0
            .database
            .replace_provider_model_quotas(id, &[])
            .await?;
        self.0.database.delete_breaker(id).await?;
        self.0.database.delete_breaker_override(id).await?;
        self.0.database.delete_provider_availability(id).await?;
        self.0.database.delete_provider_resilience(id).await?;
        self.0
            .database
            .delete_provider_thought_signatures(id)
            .await?;
        self.0.database.delete_provider(id).await?;
        self.0.breaker_overrides.write().await.remove(id);
        self.0.oauth_provider_ids.write().await.remove(id);

        self.record_audit_event(
            AuditContext {
                action: "provider.delete",
                actor,
                tenant_id: &provider.tenant_id,
                target: id,
                resource_type: "provider",
            },
            Some(&provider_audit_snapshot(&provider)),
            None,
        )
        .await;
        if let Err(error) = self.refresh().await {
            *self.0.current.write().await = None;
            return Err(error);
        }
        if let Err(error) = self.refresh_routes().await {
            *self.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        if let Some(quota) = self.0.quotas.write().await.remove(id) {
            quota.clear();
        }
        self.replace_model_quota_states(id, &[]).await;
        self.0
            .model_quotas
            .write()
            .await
            .retain(|(provider_id, _), _| provider_id != id);
        self.0.breakers.write().await.remove(id);
        self.0.availability.write().await.remove(id);
        self.0
            .thought_signatures
            .lock()
            .map_err(|_| "Antigravity thought signature cache unavailable")?
            .retain(|(provider_id, _), _| provider_id != id);
        Ok(())
    }

    pub async fn configure_combo(
        &self,
        id: &str,
        input: ComboInput,
    ) -> Result<ComboView, &'static str> {
        self.configure_combo_as(id, input, "bootstrap-admin", None)
            .await
    }

    async fn configure_combo_as(
        &self,
        id: &str,
        mut input: ComboInput,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<ComboView, &'static str> {
        validate_id(id)?;
        if id.starts_with("model-alias-") {
            return Err("Reserved model alias route identifier");
        }
        validate_actor(actor)?;
        let _mutation = self.0.mutation.lock().await;
        let providers = self.0.database.providers().await?;
        let combo_records = self.0.database.combos().await?;
        let existing = combo_records.iter().find(|combo| combo.id == id).cloned();
        let tenant_id = input
            .tenant_id
            .as_deref()
            .or_else(|| existing.as_ref().map(|combo| combo.tenant_id.as_str()))
            .or(enforced_tenant)
            .unwrap_or("red")
            .to_owned();
        validate_id(&tenant_id)?;
        if self
            .0
            .database
            .model_aliases()
            .await?
            .iter()
            .any(|alias| alias.tenant_id == tenant_id && alias.alias == id)
        {
            return Err("A model alias already exists with this name");
        }

        if existing
            .as_ref()
            .is_some_and(|combo| combo.tenant_id != tenant_id)
            || enforced_tenant.is_some_and(|required| required != tenant_id)
        {
            return Err("combo tenant cannot be changed");
        }
        if !self
            .0
            .database
            .tenants()
            .await?
            .iter()
            .any(|tenant| tenant.id == tenant_id && tenant.enabled)
        {
            return Err("combo tenant is unavailable");
        }
        let catalog = self.model_catalog().await;
        enrich_combo_metadata(&mut input, &providers, &catalog)?;
        normalize_context_relay_config(&mut input);
        normalize_fusion_config(&mut input);
        normalize_pipeline_config(&mut input);
        validate_combo(&input)?;
        resolve_nested_combo_targets(
            id,
            &tenant_id,
            &input.protocol,
            &input.targets,
            &combo_records,
        )?;
        if input.enabled {
            let protocol = ProviderProtocol::parse(&input.protocol)?;
            if !input.targets.iter().all(|target| {
                if target.is_combo_reference() {
                    return true;
                }
                providers
                    .iter()
                    .find(|provider| {
                        provider.id == target.provider_id
                            && provider.tenant_id == tenant_id
                            && provider.enabled
                    })
                    .and_then(|provider| {
                        ProviderProtocol::from_configuration(
                            &provider.upstream_url,
                            &provider.protocol,
                        )
                        .ok()
                    })
                    .is_some_and(|provider| protocol.accepts_provider(provider))
            }) {
                return Err("combo targets require enabled providers with the same protocol");
            }
        }
        let targets_json = if input.auto.is_some()
            || input.context_relay.is_some()
            || input.fusion.is_some()
            || input.pipeline.is_some()
        {
            serde_json::to_string(&StoredComboPayload {
                targets: input.targets.clone(),
                auto: input.auto.clone(),
                context_relay: input.context_relay.clone(),
                fusion: input.fusion.clone(),
                pipeline: input.pipeline.clone(),
            })
        } else {
            serde_json::to_string(&input.targets)
        }
        .map_err(|_| "cannot encode combo targets")?;
        let record = StoredCombo {
            id: id.to_owned(),
            tenant_id,
            protocol: input.protocol,
            strategy: input.strategy,
            fallback: input.fallback,
            targets_json,
            enabled: input.enabled,
            revision: revision()?,
        };
        let mut prospective = combo_records.clone();
        prospective.retain(|combo| combo.id != id);
        prospective.push(record.clone());
        validate_combo_graphs(&prospective)?;
        self.0.database.upsert_combo(&record).await?;
        let before = existing.as_ref().map(combo_view).transpose()?;
        let after_view = combo_view(&record)?;
        self.record_audit_event(
            AuditContext {
                action: if before.is_some() {
                    "combo.update"
                } else {
                    "combo.create"
                },
                actor,
                tenant_id: &record.tenant_id,
                target: id,
                resource_type: "combo",
            },
            before.as_ref(),
            Some(&after_view),
        )
        .await;
        if let Err(error) = self.refresh_routes().await {
            *self.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        Ok(after_view)
    }

    pub async fn disable_combo(&self, id: &str) -> Result<(), &'static str> {
        self.disable_combo_as(id, "bootstrap-admin", None).await
    }

    async fn disable_combo_as(
        &self,
        id: &str,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<(), &'static str> {
        validate_id(id)?;
        validate_actor(actor)?;
        let _mutation = self.0.mutation.lock().await;
        let mut prospective = self.0.database.combos().await?;
        let combo = prospective
            .iter()
            .find(|combo| combo.id == id)
            .cloned()
            .ok_or("combo configuration not found")?;
        if enforced_tenant.is_some_and(|tenant| tenant != combo.tenant_id) {
            return Err("combo tenant is unavailable");
        }
        let before = combo_view(&combo)?;
        let disabled_revision = revision()?;
        let mut disabled = combo.clone();
        disabled.enabled = false;
        disabled.revision = disabled_revision;
        if let Some(candidate) = prospective.iter_mut().find(|candidate| candidate.id == id) {
            *candidate = disabled.clone();
        }
        validate_combo_graphs(&prospective)?;
        self.0.database.disable_combo(id, disabled_revision).await?;
        let after = combo_view(&disabled)?;
        self.record_audit_event(
            AuditContext {
                action: "combo.disable",
                actor,
                tenant_id: &combo.tenant_id,
                target: id,
                resource_type: "combo",
            },
            Some(&before),
            Some(&after),
        )
        .await;
        if let Err(error) = self.refresh_routes().await {
            *self.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        Ok(())
    }

    pub async fn configure_provider_quota(
        &self,
        provider_id: &str,
        input: ProviderQuotaInput,
    ) -> Result<ProviderQuotaView, &'static str> {
        self.configure_provider_quota_as(provider_id, input, "bootstrap-admin", None)
            .await
    }

    async fn native_usage_report(
        &self,
        tenant_id: Option<&str>,
        key_id: Option<&str>,
        from_unix_ms: i64,
        to_unix_ms: i64,
        limit: i64,
        cursor: Option<&str>,
    ) -> Result<crate::native_usage::UsageReport, &'static str> {
        let usage = self
            .0
            .native_usage
            .read()
            .await
            .clone()
            .ok_or("native usage storage unavailable")?;
        usage
            .report(tenant_id, key_id, from_unix_ms, to_unix_ms, limit, cursor)
            .await
    }

    async fn configure_provider_quota_as(
        &self,
        provider_id: &str,
        input: ProviderQuotaInput,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<ProviderQuotaView, &'static str> {
        validate_id(provider_id)?;
        validate_actor(actor)?;
        validate_quota_input(&input)?;
        let _mutation = self.0.mutation.lock().await;
        let provider = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|provider| provider.id == provider_id)
            .ok_or("provider does not exist")?;
        if enforced_tenant.is_some_and(|tenant| tenant != provider.tenant_id) {
            return Err("provider tenant is unavailable");
        }
        let observed_at_unix_ms = unix_time_ms()?;
        let ttl_ms = i64::try_from(input.ttl_seconds)
            .ok()
            .and_then(|value| value.checked_mul(1_000))
            .ok_or("provider quota TTL is out of range")?;
        let record = StoredProviderQuota {
            provider_id: provider_id.to_owned(),
            session_remaining_ppm: quota_remaining_ppm(input.session.as_ref()),
            session_reset_unix_ms: quota_reset_ms(input.session.as_ref())?,
            weekly_remaining_ppm: quota_remaining_ppm(input.weekly.as_ref()),
            weekly_reset_unix_ms: quota_reset_ms(input.weekly.as_ref())?,
            limit_reached: input.limit_reached,
            observed_at_unix_ms,
            expires_at_unix_ms: observed_at_unix_ms
                .checked_add(ttl_ms)
                .ok_or("provider quota TTL is out of range")?,
            revision: revision()?,
        };
        let before = self
            .0
            .database
            .provider_quotas()
            .await?
            .into_iter()
            .find(|quota| quota.provider_id == provider_id)
            .map(|quota| quota_view(&quota))
            .transpose()?;
        self.0.database.upsert_provider_quota(&record).await?;
        self.0
            .database
            .replace_provider_model_quotas(provider_id, &[])
            .await?;
        self.replace_model_quota_states(provider_id, &[]).await;
        self.quota_state(provider_id).await.update(&record);
        let after = quota_view(&record)?;
        self.record_audit_event(
            AuditContext {
                action: if before.is_some() {
                    "provider_quota.update"
                } else {
                    "provider_quota.create"
                },
                actor,
                tenant_id: &provider.tenant_id,
                target: provider_id,
                resource_type: "provider_quota",
            },
            before.as_ref(),
            Some(&after),
        )
        .await;
        Ok(after)
    }

    pub async fn clear_provider_quota(&self, provider_id: &str) -> Result<(), &'static str> {
        self.clear_provider_quota_as(provider_id, "bootstrap-admin", None)
            .await
    }

    async fn clear_provider_quota_as(
        &self,
        provider_id: &str,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<(), &'static str> {
        validate_id(provider_id)?;
        validate_actor(actor)?;
        let _mutation = self.0.mutation.lock().await;
        let provider = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|provider| provider.id == provider_id)
            .ok_or("provider does not exist")?;
        if enforced_tenant.is_some_and(|tenant| tenant != provider.tenant_id) {
            return Err("provider tenant is unavailable");
        }
        let before = self
            .0
            .database
            .provider_quotas()
            .await?
            .into_iter()
            .find(|quota| quota.provider_id == provider_id)
            .map(|quota| quota_view(&quota))
            .transpose()?;
        self.0.database.delete_provider_quota(provider_id).await?;
        self.0
            .database
            .replace_provider_model_quotas(provider_id, &[])
            .await?;
        self.replace_model_quota_states(provider_id, &[]).await;
        self.record_audit_event(
            AuditContext {
                action: "provider_quota.clear",
                actor,
                tenant_id: &provider.tenant_id,
                target: provider_id,
                resource_type: "provider_quota",
            },
            before.as_ref(),
            Option::<&ProviderQuotaView>::None,
        )
        .await;
        if let Some(state) = self.0.quotas.read().await.get(provider_id).cloned() {
            state.clear();
        }
        Ok(())
    }

    pub async fn configure_client_key(
        &self,
        id: &str,
        input: ClientKeyInput,
    ) -> Result<ClientKeyView, &'static str> {
        self.configure_client_key_as(id, input, "bootstrap-admin", None)
            .await
    }

    async fn configure_client_key_as(
        &self,
        id: &str,
        input: ClientKeyInput,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<ClientKeyView, &'static str> {
        validate_id(id)?;
        validate_label(&input.label)?;
        validate_actor(actor)?;
        let _mutation = self.0.mutation.lock().await;
        let existing = self
            .0
            .database
            .client_keys()
            .await?
            .into_iter()
            .find(|row| row.id == id);
        let before = existing.as_ref().map(client_view).transpose()?;
        let model_matching = existing
            .as_ref()
            .map(|key| {
                crate::model_permissions::decode(&key.allowed_models_json)
                    .map(|(_, matching)| matching)
            })
            .transpose()?
            .unwrap_or_default();
        validate_client_lists(&input, model_matching)?;
        let tenant_id = input
            .tenant_id
            .as_deref()
            .or_else(|| existing.as_ref().map(|row| row.tenant_id.as_str()))
            .or(enforced_tenant)
            .unwrap_or("red");
        if enforced_tenant.is_some_and(|required| {
            required != tenant_id
                || existing
                    .as_ref()
                    .is_some_and(|record| record.tenant_id != required)
        }) {
            return Err("client key tenant cannot be changed by this identity");
        }
        validate_id(tenant_id)?;
        if !self
            .0
            .database
            .tenants()
            .await?
            .iter()
            .any(|tenant| tenant.id == tenant_id && tenant.enabled)
        {
            return Err("client key tenant is unavailable");
        }
        // Imported keys remain disabled until their historical consumption and
        // unresolved reservations have been adopted into native accounting.
        let mut imported_key = false;
        if self.0.native_usage.read().await.is_some() {
            let pool = self
                .0
                .database
                .sql_pool()
                .ok_or("legacy key migration state unavailable")?;
            let has_marker: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='redrouter_legacy_key_migration'")
                .fetch_one(pool).await.map_err(|_| "legacy key migration state unavailable")?;
            if has_marker != 0 {
                let marker = sqlx::query("SELECT source_is_banned,source_revoked_at FROM redrouter_legacy_key_migration WHERE key_id=$1")
                    .bind(id).fetch_optional(pool).await.map_err(|_| "legacy key migration state unavailable")?;
                if let Some(marker) = marker {
                    imported_key = true;
                    if input.enabled {
                        let banned: i64 = marker
                            .try_get("source_is_banned")
                            .map_err(|_| "invalid legacy key migration state")?;
                        let revoked: Option<String> = marker
                            .try_get("source_revoked_at")
                            .map_err(|_| "invalid legacy key migration state")?;
                        if banned != 0 || revoked.is_some() {
                            return Err("revoked or banned legacy keys cannot be enabled");
                        }
                        let adopted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_legacy_quota_baselines WHERE key_id=$1 AND tenant_id=$2")
                            .bind(id).bind(tenant_id).fetch_one(pool).await.map_err(|_| "legacy key migration state unavailable")?;
                        if adopted != 1 {
                            return Err(
                                "legacy accounting adoption is required before enabling this key",
                            );
                        }
                    }
                }
            }
        }
        let key_hash = match input.api_key {
            Some(key) if (16..=512).contains(&key.len()) => {
                let key = Zeroizing::new(key);
                hex::encode(Sha256::digest(key.as_bytes()))
            }
            Some(_) => return Err("client API key must be 16-512 bytes"),
            None => existing
                .as_ref()
                .map(|row| row.key_hash.clone())
                .ok_or("client API key is required for a new key")?,
        };
        let expiry_unix = input
            .expires_at_unix
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "client key expiry is out of range")?
            .unwrap_or(0);
        let preserve_micros = |value: Option<f64>, previous: i64| {
            if imported_key && previous > 0 && value == Some(previous as f64 / 1_000_000.0) {
                Ok(previous)
            } else {
                optional_usd_micros(value)
            }
        };
        let native_quota = crate::native_usage::NativeQuota {
            max_tokens_per_minute: optional_limit(
                input.max_tokens_per_minute,
                9_007_199_254_740_991,
            )?,
            max_tokens_per_day: optional_limit(input.max_tokens_per_day, 9_007_199_254_740_991)?,
            max_monthly_microusd: preserve_micros(
                input.max_spend_per_month_usd,
                existing.as_ref().map_or(0, |old| old.max_monthly_microusd),
            )?,
            reservation_tokens: optional_limit(input.reservation_tokens, 9_007_199_254_740_991)?,
            reservation_microusd: preserve_micros(
                input.reservation_spend_usd,
                existing.as_ref().map_or(0, |old| old.reservation_microusd),
            )?,
        }
        .validate()?;
        if native_quota.enabled() && self.0.native_usage.read().await.is_none() {
            return Err("native usage quotas require SQLite storage");
        }
        if self.0.database.is_sqlite().await {
            let pool = self
                .0
                .database
                .sql_pool()
                .ok_or("model quota unavailable")?;
            let minimum: Option<i64> = sqlx::query_scalar(
                "SELECT MIN(token_limit) FROM redrouter_client_model_token_limits WHERE key_id=$1",
            )
            .bind(id)
            .fetch_one(pool)
            .await
            .map_err(|_| "model quota unavailable")?;
            if minimum.is_some_and(|limit| {
                !native_quota.enabled()
                    || native_quota.reservation_tokens <= 0
                    || native_quota.reservation_tokens > limit
            }) {
                return Err("model quotas require a compatible global reservation");
            }
        }
        let record = StoredClientKey {
            id: id.to_owned(),
            label: input.label,
            key_hash,
            enabled: input.enabled,
            expiry_unix,
            scopes_json: json_list(&input.scopes)?,
            allowed_endpoints_json: json_list(&input.allowed_endpoints)?,
            allowed_models_json: crate::model_permissions::encode(
                input.allowed_models.clone(),
                model_matching,
            )?,
            allowed_combos_json: match &input.allowed_combos {
                Some(value) => serde_json::to_string(value).map_err(|_| "invalid combo grants")?,
                None => existing
                    .as_ref()
                    .map_or_else(|| "null".to_owned(), |key| key.allowed_combos_json.clone()),
            },
            model_access_mode: effective_model_access_mode(
                input
                    .model_access_mode
                    .as_deref()
                    .or_else(|| before.as_ref().map(|row| row.model_access_mode.as_str()))
                    .unwrap_or("all"),
                !input.allowed_models.is_empty(),
            )?
            .to_owned(),
            blocked_models_json: json_list(&input.blocked_models)?,
            allowed_provider_ids_json: json_list(&input.allowed_provider_ids)?,
            max_concurrent: optional_limit(input.max_concurrent_requests, 65_535)?,
            max_rpm: optional_limit(input.max_requests_per_minute, 10_000)?,
            max_rpd: optional_limit(input.max_requests_per_day, 10_000_000)?,
            model_id_format: validate_model_id_format(
                input
                    .model_id_format
                    .as_deref()
                    .or_else(|| existing.as_ref().map(|row| row.model_id_format.as_str()))
                    .unwrap_or("prefixed"),
            )?
            .to_owned(),
            access_schedule_json: encode_access_schedule(input.access_schedule.as_ref())?,
            tenant_id: tenant_id.to_owned(),
            created_by: existing
                .as_ref()
                .map(|row| row.created_by.clone())
                .unwrap_or_else(|| actor.to_owned()),
            max_tokens_per_minute: native_quota.max_tokens_per_minute,
            max_tokens_per_day: native_quota.max_tokens_per_day,
            max_monthly_microusd: native_quota.max_monthly_microusd,
            reservation_tokens: native_quota.reservation_tokens,
            reservation_microusd: native_quota.reservation_microusd,
            revision: revision()?,
        };
        if imported_key
            && existing.as_ref().is_some_and(|old| {
                old.expiry_unix != record.expiry_unix
                    || old.max_rpm != record.max_rpm
                    || old.max_rpd != record.max_rpd
                    || old.max_tokens_per_minute != record.max_tokens_per_minute
                    || old.max_tokens_per_day != record.max_tokens_per_day
                    || old.max_monthly_microusd != record.max_monthly_microusd
                    || old.reservation_tokens != record.reservation_tokens
                    || old.reservation_microusd != record.reservation_microusd
            })
        {
            return Err("migrated key expiry or quota changes require explicit reconciliation");
        }
        self.0.database.upsert_client_key(&record).await?;
        let after = client_view(&record)?;
        self.record_audit_event(
            AuditContext {
                action: if before.is_some() {
                    "client_key.update"
                } else {
                    "client_key.create"
                },
                actor,
                tenant_id: &record.tenant_id,
                target: id,
                resource_type: "client_key",
            },
            before.as_ref(),
            Some(&after),
        )
        .await;
        if self.refresh_clients().await.is_err() {
            *self.0.clients.write().await = ClientSnapshot::Unavailable;
            return Err("cannot reload client key configuration");
        }
        Ok(after)
    }

    pub async fn issue_client_key(
        &self,
        input: ClientKeyIssueInput,
    ) -> Result<(ClientKeyView, Zeroizing<String>), &'static str> {
        self.issue_client_key_as(input, "bootstrap-admin", None)
            .await
    }

    async fn issue_client_key_as(
        &self,
        input: ClientKeyIssueInput,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<(ClientKeyView, Zeroizing<String>), &'static str> {
        let mut id_bytes = Zeroizing::new([0_u8; 16]);
        getrandom::fill(id_bytes.as_mut()).map_err(|_| "cannot generate client key identifier")?;
        let id = format!("key_{}", hex::encode(id_bytes.as_ref()));
        let secret = Zeroizing::new(format!("rrk_{}", random_token(32)?));
        let view = self
            .configure_client_key_as(
                &id,
                input.with_secret(secret.to_string()),
                actor,
                enforced_tenant,
            )
            .await?;
        Ok((view, secret))
    }

    pub async fn configure_tenant(
        &self,
        id: &str,
        input: TenantInput,
    ) -> Result<TenantView, &'static str> {
        self.configure_tenant_as(id, input, "bootstrap-admin").await
    }

    async fn configure_tenant_as(
        &self,
        id: &str,
        input: TenantInput,
        actor: &str,
    ) -> Result<TenantView, &'static str> {
        validate_id(id)?;
        validate_actor(actor)?;
        validate_tenant_slug(&input.slug)?;
        validate_tenant_name(&input.name)?;
        if id == "red" && !input.enabled {
            return Err("default tenant cannot be disabled");
        }
        let _mutation = self.0.mutation.lock().await;
        let tenants = self.0.database.tenants().await?;
        let before = tenants
            .iter()
            .find(|tenant| tenant.id == id)
            .map(tenant_view);
        if tenants
            .iter()
            .any(|tenant| tenant.id != id && tenant.slug == input.slug)
        {
            return Err("tenant slug is already in use");
        }
        let record = StoredTenant {
            id: id.to_owned(),
            slug: input.slug,
            name: input.name,
            enabled: input.enabled,
            revision: revision()?,
        };
        self.0.database.upsert_tenant(&record).await?;
        let after = tenant_view(&record);
        self.record_audit_event(
            AuditContext {
                action: if before.is_some() {
                    "tenant.update"
                } else {
                    "tenant.create"
                },
                actor,
                tenant_id: &record.id,
                target: id,
                resource_type: "tenant",
            },
            before.as_ref(),
            Some(&after),
        )
        .await;
        if self.refresh_clients().await.is_err() {
            *self.0.clients.write().await = ClientSnapshot::Unavailable;
            return Err("cannot reload client key configuration");
        }
        Ok(after)
    }

    pub async fn configure_identity_binding(
        &self,
        id: &str,
        input: IdentityBindingInput,
    ) -> Result<IdentityBindingView, &'static str> {
        self.configure_identity_binding_as(id, input, "bootstrap-admin")
            .await
    }

    async fn configure_identity_binding_as(
        &self,
        id: &str,
        input: IdentityBindingInput,
        actor: &str,
    ) -> Result<IdentityBindingView, &'static str> {
        validate_id(id)?;
        validate_actor(actor)?;
        let subject = match (
            input.subject.as_deref(),
            input.oidc_issuer.as_deref(),
            input.oidc_subject.as_deref(),
        ) {
            (Some(subject), None, None) => {
                validate_bound_subject(subject)?;
                subject.to_owned()
            }
            (None, Some(issuer), Some(oidc_subject)) => {
                crate::oidc::canonical_subject(issuer, oidc_subject)?
            }
            _ => return Err("identity binding must use subject or OIDC issuer and subject"),
        };
        validate_id(&input.tenant_id)?;
        validate_identity_role(&input.role)?;
        let _mutation = self.0.mutation.lock().await;
        if !self
            .0
            .database
            .tenants()
            .await?
            .iter()
            .any(|tenant| tenant.id == input.tenant_id && tenant.enabled)
        {
            return Err("identity tenant is unavailable");
        }
        let bindings = self.0.database.identity_bindings().await?;
        let before = bindings
            .iter()
            .find(|binding| binding.id == id)
            .map(identity_binding_view);
        if bindings
            .iter()
            .any(|binding| binding.id != id && binding.subject == subject)
        {
            return Err("identity subject is already bound");
        }
        let record = StoredIdentityBinding {
            id: id.to_owned(),
            subject,
            tenant_id: input.tenant_id,
            role: input.role,
            enabled: input.enabled,
            revision: revision()?,
        };
        self.0.database.upsert_identity_binding(&record).await?;
        let after = identity_binding_view(&record);
        self.record_audit_event(
            AuditContext {
                action: if before.is_some() {
                    "identity_binding.update"
                } else {
                    "identity_binding.create"
                },
                actor,
                tenant_id: &record.tenant_id,
                target: id,
                resource_type: "identity_binding",
            },
            before.as_ref(),
            Some(&after),
        )
        .await;
        Ok(after)
    }

    pub async fn delete_identity_binding(&self, id: &str) -> Result<(), &'static str> {
        self.delete_identity_binding_as(id, "bootstrap-admin").await
    }

    async fn delete_identity_binding_as(&self, id: &str, actor: &str) -> Result<(), &'static str> {
        validate_id(id)?;
        validate_actor(actor)?;
        let _mutation = self.0.mutation.lock().await;
        let binding = self
            .0
            .database
            .identity_bindings()
            .await?
            .into_iter()
            .find(|binding| binding.id == id)
            .ok_or("identity binding configuration not found")?;
        let before = identity_binding_view(&binding);
        self.0.database.delete_identity_binding(id).await?;
        self.record_audit_event(
            AuditContext {
                action: "identity_binding.delete",
                actor,
                tenant_id: &binding.tenant_id,
                target: id,
                resource_type: "identity_binding",
            },
            Some(&before),
            Option::<&IdentityBindingView>::None,
        )
        .await;
        Ok(())
    }

    async fn usage_export_views(
        &self,
        tenant_id: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, &'static str> {
        let keys = self.0.database.client_keys().await?;
        self.0
            .database
            .usage_exports()
            .await?
            .iter()
            .filter(|export| tenant_id.is_none_or(|tenant| export.tenant_id == tenant))
            .map(|export| usage_export_view(export, &keys))
            .collect()
    }

    async fn create_usage_export_as(
        &self,
        input: UsageExportCreateInput,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<serde_json::Value, &'static str> {
        let id = format!("usage-{}", random_token(12)?);
        let tenant_id = input
            .tenant_id
            .as_deref()
            .or(enforced_tenant)
            .unwrap_or("red")
            .to_owned();
        if enforced_tenant.is_some_and(|required| required != tenant_id) {
            return Err("usage export tenant cannot be changed");
        }
        let record = self
            .resolve_usage_export(
                &id,
                tenant_id,
                input.name,
                input.export_type,
                input.mode,
                input.window_sec,
                input.api_key_ids,
                input.config,
                input.enabled,
                None,
            )
            .await?;
        let _mutation = self.0.mutation.lock().await;
        self.0.database.upsert_usage_export(&record).await?;
        let view = usage_export_view(&record, &self.0.database.client_keys().await?)?;
        self.record_audit_event(
            AuditContext {
                action: "usage_export.create",
                actor,
                tenant_id: &record.tenant_id,
                target: &record.id,
                resource_type: "usage_export",
            },
            Option::<&serde_json::Value>::None,
            Some(&view),
        )
        .await;
        Ok(view)
    }

    async fn update_usage_export_as(
        &self,
        id: &str,
        input: UsageExportUpdateInput,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<serde_json::Value, &'static str> {
        validate_id(id)?;
        let _mutation = self.0.mutation.lock().await;
        let current = self
            .0
            .database
            .usage_exports()
            .await?
            .into_iter()
            .find(|export| export.id == id)
            .ok_or("usage export configuration not found")?;
        if enforced_tenant.is_some_and(|tenant| tenant != current.tenant_id) {
            return Err("usage export tenant is unavailable");
        }
        let api_key_ids = match input.api_key_ids {
            Some(value) => value,
            None => serde_json::from_str(&current.api_key_ids_json)
                .map_err(|_| "invalid usage export key filters")?,
        };
        let config = input.config.unwrap_or(UsageExportConfigInput {
            url: None,
            secret: None,
            queue: None,
            token: None,
            tenant: None,
            queue_url: None,
            region: None,
            access_key_id: None,
            secret_access_key: None,
            session_token: None,
            brokers: None,
            topic: None,
            client_id: None,
            ssl: None,
            sasl_mechanism: None,
            sasl_username: None,
            sasl_password: None,
            project_id: None,
            dataset_id: None,
            table_id: None,
            service_account_json: None,
            batch_size: None,
            interval_seconds: None,
        });
        let record = self
            .resolve_usage_export(
                id,
                current.tenant_id.clone(),
                input.name.unwrap_or_else(|| current.name.clone()),
                current.export_type.clone(),
                input.mode.unwrap_or_else(|| current.mode.clone()),
                input.window_sec.or(Some(current.window_sec)),
                api_key_ids,
                config,
                input.enabled.unwrap_or(current.enabled),
                Some(&current),
            )
            .await?;
        let before = usage_export_view(&current, &self.0.database.client_keys().await?)?;
        self.0
            .database
            .update_usage_export(&record, current.revision)
            .await?;
        let after = usage_export_view(&record, &self.0.database.client_keys().await?)?;
        self.record_audit_event(
            AuditContext {
                action: "usage_export.update",
                actor,
                tenant_id: &record.tenant_id,
                target: &record.id,
                resource_type: "usage_export",
            },
            Some(&before),
            Some(&after),
        )
        .await;
        Ok(after)
    }

    #[allow(clippy::too_many_arguments)]
    async fn resolve_usage_export(
        &self,
        id: &str,
        tenant_id: String,
        name: String,
        export_type: String,
        mode: String,
        window_sec: Option<i64>,
        mut api_key_ids: Vec<String>,
        config: UsageExportConfigInput,
        enabled: bool,
        current: Option<&StoredUsageExport>,
    ) -> Result<StoredUsageExport, &'static str> {
        if !self.0.database.is_sqlite().await {
            return Err("usage exports currently require SQLite storage");
        }
        validate_id(id)?;
        validate_id(&tenant_id)?;
        let name = name.trim().to_owned();
        if name.is_empty() || name.len() > 200 || name.chars().any(char::is_control) {
            return Err("invalid usage export name");
        }
        if !matches!(
            export_type.as_str(),
            "bigquery" | "webhook" | "reddb" | "sqs" | "kafka"
        ) {
            return Err("unsupported usage export type");
        }
        let window_sec = match mode.as_str() {
            "instant" if window_sec.is_none_or(|value| value == 0) => 0,
            "window" if export_type != "bigquery" => {
                let value = window_sec.unwrap_or(900);
                if !matches!(value, 300 | 900 | 1_800 | 3_600) {
                    return Err("unsupported usage export window size");
                }
                value
            }
            "window" => return Err("BigQuery usage exports support instant mode only"),
            _ => return Err("invalid usage export mode"),
        };
        if api_key_ids.len() > 200 {
            return Err("too many usage export key filters");
        }
        api_key_ids.sort();
        api_key_ids.dedup();
        if api_key_ids.iter().any(|key| validate_id(key).is_err()) {
            return Err("invalid usage export key filter");
        }
        let tenants = self.0.database.tenants().await?;
        if !tenants
            .iter()
            .any(|tenant| tenant.id == tenant_id && tenant.enabled)
        {
            return Err("usage export tenant is unavailable");
        }
        let keys = self.0.database.client_keys().await?;
        if !api_key_ids.iter().all(|id| {
            keys.iter()
                .any(|key| key.id == *id && key.tenant_id == tenant_id)
        }) {
            return Err("usage export key filter is unavailable");
        }
        let (
            project_id,
            dataset_id,
            table_id,
            service_account_ciphertext,
            config_json,
            secret_ciphertext,
            batch_size,
            interval_seconds,
        ) = match export_type.as_str() {
            "bigquery" => {
                if config.url.is_some()
                    || config.secret.is_some()
                    || config.queue.is_some()
                    || config.token.is_some()
                    || config.tenant.is_some()
                    || config.queue_url.is_some()
                    || config.region.is_some()
                    || config.access_key_id.is_some()
                    || config.secret_access_key.is_some()
                    || config.session_token.is_some()
                {
                    return Err("invalid BigQuery usage export fields");
                }
                let project_id = config
                    .project_id
                    .or_else(|| current.map(|value| value.project_id.clone()))
                    .ok_or("BigQuery project ID is required")?;
                let dataset_id = config
                    .dataset_id
                    .or_else(|| current.map(|value| value.dataset_id.clone()))
                    .ok_or("BigQuery dataset ID is required")?;
                let table_id = config
                    .table_id
                    .or_else(|| current.map(|value| value.table_id.clone()))
                    .ok_or("BigQuery table ID is required")?;
                let batch_size = match config.batch_size {
                    Some(value) => usize::try_from(value.value()?)
                        .map_err(|_| "invalid BigQuery batch size")?,
                    None => current
                        .and_then(|value| usize::try_from(value.batch_size).ok())
                        .unwrap_or(500),
                };
                let interval_seconds = match config.interval_seconds {
                    Some(value) => value.value()?,
                    None => current
                        .and_then(|value| u64::try_from(value.interval_seconds).ok())
                        .unwrap_or(10),
                };
                let aad = format!("usage-export:{id}:service-account");
                let (ciphertext, service_account_json) = match config.service_account_json {
                    Some(value) if value != "__stored__" => {
                        let secret = Zeroizing::new(value);
                        let ciphertext =
                            encrypt_async(secret.as_str(), &aad, self.0.encryption_key.as_str())
                                .await?;
                        (ciphertext, secret)
                    }
                    _ => {
                        let stored = current.ok_or("BigQuery service account JSON is required")?;
                        let secret = decrypt_async(
                            &stored.service_account_ciphertext,
                            &aad,
                            self.0.encryption_key.as_str(),
                        )
                        .await?;
                        (stored.service_account_ciphertext.clone(), secret)
                    }
                };
                let runtime = crate::audit_export::BigQueryAuditConfig {
                    sink_id: format!("managed-{id}"),
                    project_id: project_id.clone(),
                    dataset_id: dataset_id.clone(),
                    table_id: table_id.clone(),
                    service_account_json,
                    batch_size,
                    interval: Duration::from_secs(interval_seconds),
                    tenant_id: Some(tenant_id.clone()),
                    api_key_ids: api_key_ids.clone(),
                };
                crate::audit_export::BigQueryAuditSink::new(runtime)?;
                (
                    project_id,
                    dataset_id,
                    table_id,
                    ciphertext,
                    "{}".to_owned(),
                    String::new(),
                    batch_size,
                    interval_seconds,
                )
            }
            "webhook" => {
                if config.project_id.is_some()
                    || config.dataset_id.is_some()
                    || config.table_id.is_some()
                    || config.service_account_json.is_some()
                    || config.batch_size.is_some()
                    || config.interval_seconds.is_some()
                    || config.queue.is_some()
                    || config.token.is_some()
                    || config.tenant.is_some()
                    || config.queue_url.is_some()
                    || config.region.is_some()
                    || config.access_key_id.is_some()
                    || config.secret_access_key.is_some()
                    || config.session_token.is_some()
                {
                    return Err("invalid webhook usage export fields");
                }
                let stored_url = current
                    .map(|value| webhook_usage_url(&value.config_json))
                    .transpose()?;
                let url = config.url.or(stored_url).ok_or("Webhook URL is required")?;
                let aad = format!("usage-export:{id}:secret");
                let (secret_ciphertext, secret) = match config.secret {
                    Some(value) if value != "__stored__" => {
                        let secret = Zeroizing::new(value);
                        if !(16..=1024).contains(&secret.len()) {
                            return Err("Webhook secret is invalid");
                        }
                        let ciphertext =
                            encrypt_async(secret.as_str(), &aad, self.0.encryption_key.as_str())
                                .await?;
                        (ciphertext, secret)
                    }
                    _ => {
                        let stored = current.ok_or("Webhook secret is required")?;
                        if stored.secret_ciphertext.is_empty() {
                            return Err("Webhook secret is required");
                        }
                        let secret = decrypt_async(
                            &stored.secret_ciphertext,
                            &aad,
                            self.0.encryption_key.as_str(),
                        )
                        .await?;
                        (stored.secret_ciphertext.clone(), secret)
                    }
                };
                let url =
                    crate::audit_export::validate_usage_webhook(&url, secret.as_str()).await?;
                (
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    serde_json::to_string(&serde_json::json!({"url": url}))
                        .map_err(|_| "cannot encode webhook configuration")?,
                    secret_ciphertext,
                    8,
                    1,
                )
            }
            "reddb" => {
                if config.secret.is_some()
                    || config.project_id.is_some()
                    || config.dataset_id.is_some()
                    || config.table_id.is_some()
                    || config.service_account_json.is_some()
                    || config.batch_size.is_some()
                    || config.interval_seconds.is_some()
                    || config.queue_url.is_some()
                    || config.region.is_some()
                    || config.access_key_id.is_some()
                    || config.secret_access_key.is_some()
                    || config.session_token.is_some()
                {
                    return Err("invalid RedDB usage export fields");
                }
                let stored = current
                    .map(|value| reddb_usage_config(&value.config_json))
                    .transpose()?;
                let url = config
                    .url
                    .or_else(|| stored.as_ref().map(|value| value.0.clone()))
                    .ok_or("RedDB URL is required")?;
                let queue = config
                    .queue
                    .or_else(|| stored.as_ref().map(|value| value.1.clone()))
                    .ok_or("RedDB queue is required")?;
                let tenant = config
                    .tenant
                    .or_else(|| stored.as_ref().and_then(|value| value.2.clone()));
                let aad = format!("usage-export:{id}:secret");
                let (secret_ciphertext, token) = match config.token {
                    Some(value) if value != "__stored__" => {
                        let token = value.trim().to_owned();
                        if token.len() > 2048 || token.chars().any(char::is_control) {
                            return Err("RedDB token is invalid");
                        }
                        if token.is_empty() {
                            (String::new(), None)
                        } else {
                            let token = Zeroizing::new(token);
                            let ciphertext =
                                encrypt_async(token.as_str(), &aad, self.0.encryption_key.as_str())
                                    .await?;
                            (ciphertext, Some(token))
                        }
                    }
                    _ => match current {
                        Some(stored) if !stored.secret_ciphertext.is_empty() => (
                            stored.secret_ciphertext.clone(),
                            Some(
                                decrypt_async(
                                    &stored.secret_ciphertext,
                                    &aad,
                                    self.0.encryption_key.as_str(),
                                )
                                .await?,
                            ),
                        ),
                        _ => (String::new(), None),
                    },
                };
                let config_json = serde_json::to_string(&serde_json::json!({
                    "url": url.trim_end_matches('/'),
                    "queue": queue.trim(),
                    "tenant": tenant.as_deref().map(str::trim).filter(|value| !value.is_empty()),
                }))
                .map_err(|_| "cannot encode RedDB usage configuration")?;
                crate::audit_export::validate_usage_reddb(
                    &config_json,
                    token,
                    self.0.allow_private,
                )
                .await?;
                (
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    config_json,
                    secret_ciphertext,
                    8,
                    1,
                )
            }
            "sqs" => {
                if config.url.is_some()
                    || config.secret.is_some()
                    || config.queue.is_some()
                    || config.token.is_some()
                    || config.tenant.is_some()
                    || config.project_id.is_some()
                    || config.dataset_id.is_some()
                    || config.table_id.is_some()
                    || config.service_account_json.is_some()
                    || config.batch_size.is_some()
                    || config.interval_seconds.is_some()
                {
                    return Err("invalid SQS usage export fields");
                }
                let stored = current
                    .map(|value| sqs_usage_config(&value.config_json))
                    .transpose()?;
                let queue_url = config
                    .queue_url
                    .or_else(|| stored.as_ref().map(|value| value.0.clone()))
                    .ok_or("SQS queue URL is required")?;
                let region = config
                    .region
                    .or_else(|| stored.as_ref().map(|value| value.1.clone()))
                    .or_else(|| sqs_region_from_url(&queue_url))
                    .ok_or("SQS region is required")?;
                let access_key_id = config
                    .access_key_id
                    .or_else(|| stored.as_ref().map(|value| value.2.clone()))
                    .ok_or("SQS access key ID is required")?;
                let aad = format!("usage-export:{id}:secret");
                let (secret_ciphertext, secret_json, has_session_token) = match config
                    .secret_access_key
                {
                    Some(value) if value != "__stored__" => {
                        if value.is_empty() || value.len() > 1024 {
                            return Err("SQS secret access key is invalid");
                        }
                        let session_token = config
                            .session_token
                            .map(|value| value.trim().to_owned())
                            .filter(|value| !value.is_empty());
                        if session_token.as_ref().is_some_and(|value| {
                            value.len() > 4096 || value.chars().any(char::is_control)
                        }) {
                            return Err("SQS session token is invalid");
                        }
                        let has_session_token = session_token.is_some();
                        let secret_json = Zeroizing::new(
                            serde_json::to_string(&serde_json::json!({
                                "secretAccessKey":value,
                                "sessionToken":session_token,
                            }))
                            .map_err(|_| "cannot encode SQS usage credentials")?,
                        );
                        let ciphertext = encrypt_async(
                            secret_json.as_str(),
                            &aad,
                            self.0.encryption_key.as_str(),
                        )
                        .await?;
                        (ciphertext, secret_json, has_session_token)
                    }
                    _ => {
                        let stored = current.ok_or("SQS secret access key is required")?;
                        if stored.secret_ciphertext.is_empty() {
                            return Err("SQS secret access key is required");
                        }
                        let secret_json = decrypt_async(
                            &stored.secret_ciphertext,
                            &aad,
                            self.0.encryption_key.as_str(),
                        )
                        .await?;
                        let (_, _, _, has_session_token) = sqs_usage_config(&stored.config_json)?;
                        (
                            stored.secret_ciphertext.clone(),
                            secret_json,
                            has_session_token,
                        )
                    }
                };
                let config_json = serde_json::to_string(&serde_json::json!({
                    "queueUrl":queue_url.trim_end_matches('/'),
                    "region":region.trim(),
                    "accessKeyId":access_key_id.trim(),
                    "hasSessionToken":has_session_token,
                }))
                .map_err(|_| "cannot encode SQS usage configuration")?;
                crate::audit_export::validate_usage_sqs(
                    &config_json,
                    secret_json.as_str(),
                    self.0.allow_private,
                )
                .await?;
                (
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    config_json,
                    secret_ciphertext,
                    8,
                    1,
                )
            }
            "kafka" => {
                if config.url.is_some()
                    || config.secret.is_some()
                    || config.queue.is_some()
                    || config.token.is_some()
                    || config.tenant.is_some()
                    || config.queue_url.is_some()
                    || config.region.is_some()
                    || config.access_key_id.is_some()
                    || config.secret_access_key.is_some()
                    || config.session_token.is_some()
                    || config.project_id.is_some()
                    || config.dataset_id.is_some()
                    || config.table_id.is_some()
                    || config.service_account_json.is_some()
                    || config.batch_size.is_some()
                    || config.interval_seconds.is_some()
                {
                    return Err("invalid Kafka usage export fields");
                }
                let stored = current
                    .map(|value| kafka_usage_config(&value.config_json))
                    .transpose()?;
                let brokers = config
                    .brokers
                    .map(|value| parse_kafka_brokers(&value))
                    .or_else(|| stored.as_ref().map(|value| value.0.clone()))
                    .filter(|value| !value.is_empty())
                    .ok_or("Kafka brokers are required")?;
                let topic = config
                    .topic
                    .or_else(|| stored.as_ref().map(|value| value.1.clone()))
                    .ok_or("Kafka topic is required")?;
                let client_id = config
                    .client_id
                    .map(|value| value.trim().to_owned())
                    .filter(|value| !value.is_empty())
                    .or_else(|| stored.as_ref().map(|value| value.2.clone()))
                    .unwrap_or_else(|| "red-router".to_owned());
                let ssl = config
                    .ssl
                    .or_else(|| stored.as_ref().map(|value| value.3))
                    .unwrap_or(false);
                let sasl_mechanism = config
                    .sasl_mechanism
                    .or_else(|| stored.as_ref().map(|value| value.4.clone()))
                    .unwrap_or_default()
                    .trim()
                    .to_owned();
                let sasl_username = config
                    .sasl_username
                    .or_else(|| stored.as_ref().and_then(|value| value.5.clone()))
                    .map(|value| value.trim().to_owned())
                    .filter(|value| !value.is_empty());
                let aad = format!("usage-export:{id}:secret");
                let (secret_ciphertext, password) = match config.sasl_password {
                    Some(value) if value != "__stored__" => {
                        if value.is_empty()
                            || value.len() > 1024
                            || value.chars().any(char::is_control)
                        {
                            return Err("Kafka SASL password is invalid");
                        }
                        let password = Zeroizing::new(value);
                        let ciphertext =
                            encrypt_async(password.as_str(), &aad, self.0.encryption_key.as_str())
                                .await?;
                        (ciphertext, Some(password))
                    }
                    _ => match current {
                        Some(stored) if !stored.secret_ciphertext.is_empty() => (
                            stored.secret_ciphertext.clone(),
                            Some(
                                decrypt_async(
                                    &stored.secret_ciphertext,
                                    &aad,
                                    self.0.encryption_key.as_str(),
                                )
                                .await?,
                            ),
                        ),
                        _ => (String::new(), None),
                    },
                };
                let has_sasl_password = password.is_some();
                let config_json = serde_json::to_string(&serde_json::json!({
                    "brokers":brokers,
                    "topic":topic.trim(),
                    "clientId":client_id.trim(),
                    "ssl":ssl,
                    "saslMechanism":sasl_mechanism,
                    "saslUsername":sasl_username,
                    "hasSaslPassword":has_sasl_password,
                }))
                .map_err(|_| "cannot encode Kafka usage configuration")?;
                crate::audit_export::validate_usage_kafka(
                    &config_json,
                    password,
                    self.0.allow_private,
                )
                .await?;
                (
                    String::new(),
                    String::new(),
                    String::new(),
                    String::new(),
                    config_json,
                    secret_ciphertext,
                    8,
                    1,
                )
            }
            _ => unreachable!("usage export type was validated"),
        };
        Ok(StoredUsageExport {
            id: id.to_owned(),
            tenant_id,
            name,
            export_type,
            mode,
            window_sec,
            api_key_ids_json: serde_json::to_string(&api_key_ids)
                .map_err(|_| "cannot encode usage export key filters")?,
            project_id,
            dataset_id,
            table_id,
            service_account_ciphertext,
            config_json,
            secret_ciphertext,
            batch_size: i64::try_from(batch_size).map_err(|_| "invalid usage export batch size")?,
            interval_seconds: i64::try_from(interval_seconds)
                .map_err(|_| "invalid usage export interval")?,
            enabled,
            revision: revision()?,
        })
    }

    async fn delete_usage_export_as(
        &self,
        id: &str,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<bool, &'static str> {
        validate_id(id)?;
        let _mutation = self.0.mutation.lock().await;
        let current = self
            .0
            .database
            .usage_exports()
            .await?
            .into_iter()
            .find(|export| export.id == id);
        let Some(current) = current else {
            return Ok(false);
        };
        if enforced_tenant.is_some_and(|tenant| tenant != current.tenant_id) {
            return Err("usage export tenant is unavailable");
        }
        let before = usage_export_view(&current, &self.0.database.client_keys().await?)?;
        self.0
            .database
            .delete_usage_export(id, current.revision)
            .await?;
        self.record_audit_event(
            AuditContext {
                action: "usage_export.delete",
                actor,
                tenant_id: &current.tenant_id,
                target: id,
                resource_type: "usage_export",
            },
            Some(&before),
            Option::<&serde_json::Value>::None,
        )
        .await;
        Ok(true)
    }

    async fn test_usage_export_as(
        &self,
        id: &str,
        input: UsageExportUpdateInput,
        enforced_tenant: Option<&str>,
    ) -> Result<u64, &'static str> {
        validate_id(id)?;
        let current = self
            .0
            .database
            .usage_exports()
            .await?
            .into_iter()
            .find(|export| export.id == id)
            .ok_or("usage export configuration not found")?;
        if enforced_tenant.is_some_and(|tenant| tenant != current.tenant_id) {
            return Err("usage export tenant is unavailable");
        }
        let api_key_ids = match input.api_key_ids {
            Some(value) => value,
            None => serde_json::from_str(&current.api_key_ids_json)
                .map_err(|_| "invalid usage export key filters")?,
        };
        let config = input.config.unwrap_or(UsageExportConfigInput {
            url: None,
            secret: None,
            queue: None,
            token: None,
            tenant: None,
            queue_url: None,
            region: None,
            access_key_id: None,
            secret_access_key: None,
            session_token: None,
            brokers: None,
            topic: None,
            client_id: None,
            ssl: None,
            sasl_mechanism: None,
            sasl_username: None,
            sasl_password: None,
            project_id: None,
            dataset_id: None,
            table_id: None,
            service_account_json: None,
            batch_size: None,
            interval_seconds: None,
        });
        let record = self
            .resolve_usage_export(
                id,
                current.tenant_id.clone(),
                input.name.unwrap_or_else(|| current.name.clone()),
                current.export_type.clone(),
                input.mode.unwrap_or_else(|| current.mode.clone()),
                input.window_sec.or(Some(current.window_sec)),
                api_key_ids,
                config,
                input.enabled.unwrap_or(current.enabled),
                Some(&current),
            )
            .await?;
        let started = Instant::now();
        let now = unix_time_ms()?;
        let event = crate::storage::StoredUsageExportEvent {
            event_id: format!("test-{}", random_token(12)?),
            created_at_unix_ms: now,
            tenant_id: record.tenant_id.clone(),
            key_id: "test".to_owned(),
            key_name: "Red Router destination test".to_owned(),
            end_user: None,
            tags: Vec::new(),
            provider: "red-router".to_owned(),
            model: "destination-test".to_owned(),
            usage_kind: "tokens".to_owned(),
            search_units: 0,
            tokens_input: 0,
            tokens_output: 0,
            tokens_cache_read: 0,
            tokens_cache_creation: 0,
            tokens_reasoning: 0,
            amount_microusd: 0,
            pricing_known: false,
            pricing_snapshot: None,
        };
        match record.export_type.as_str() {
            "bigquery" => {
                let aad = format!("usage-export:{id}:service-account");
                let service_account_json = decrypt_async(
                    &record.service_account_ciphertext,
                    &aad,
                    self.0.encryption_key.as_str(),
                )
                .await?;
                let sink = crate::audit_export::BigQueryAuditSink::new(
                    crate::audit_export::BigQueryAuditConfig {
                        sink_id: format!("managed-{id}"),
                        project_id: record.project_id,
                        dataset_id: record.dataset_id,
                        table_id: record.table_id,
                        service_account_json,
                        batch_size: usize::try_from(record.batch_size)
                            .map_err(|_| "invalid BigQuery batch size")?,
                        interval: Duration::from_secs(
                            u64::try_from(record.interval_seconds)
                                .map_err(|_| "invalid BigQuery interval")?,
                        ),
                        tenant_id: Some(record.tenant_id),
                        api_key_ids: Vec::new(),
                    },
                )?;
                sink.send_usage(&[event]).await?;
            }
            "webhook" => {
                let aad = format!("usage-export:{id}:secret");
                let secret = decrypt_async(
                    &record.secret_ciphertext,
                    &aad,
                    self.0.encryption_key.as_str(),
                )
                .await?;
                let url = webhook_usage_url(&record.config_json)?;
                if record.mode == "window" {
                    crate::audit_export::send_usage_webhook_window_test(
                        id,
                        &record.name,
                        &url,
                        secret.as_str(),
                        &event,
                        record.window_sec,
                    )
                    .await?;
                } else {
                    crate::audit_export::send_usage_webhook_test(
                        id,
                        &record.name,
                        &url,
                        secret.as_str(),
                        &event,
                    )
                    .await?;
                }
            }
            "reddb" => {
                let token = if record.secret_ciphertext.is_empty() {
                    None
                } else {
                    let aad = format!("usage-export:{id}:secret");
                    Some(
                        decrypt_async(
                            &record.secret_ciphertext,
                            &aad,
                            self.0.encryption_key.as_str(),
                        )
                        .await?,
                    )
                };
                if record.mode == "window" {
                    crate::audit_export::send_usage_reddb_window_test(
                        id,
                        &record.name,
                        &record.config_json,
                        token,
                        &event,
                        record.window_sec,
                        self.0.allow_private,
                    )
                    .await?;
                } else {
                    crate::audit_export::send_usage_reddb_test(
                        id,
                        &record.name,
                        &record.config_json,
                        token,
                        &event,
                        self.0.allow_private,
                    )
                    .await?;
                }
            }
            "sqs" => {
                let aad = format!("usage-export:{id}:secret");
                let secret_json = decrypt_async(
                    &record.secret_ciphertext,
                    &aad,
                    self.0.encryption_key.as_str(),
                )
                .await?;
                if record.mode == "window" {
                    crate::audit_export::send_usage_sqs_window_test(
                        id,
                        &record.config_json,
                        secret_json.as_str(),
                        &event,
                        record.window_sec,
                        self.0.allow_private,
                    )
                    .await?;
                } else {
                    crate::audit_export::send_usage_sqs_test(
                        id,
                        &record.config_json,
                        secret_json.as_str(),
                        &event,
                        self.0.allow_private,
                    )
                    .await?;
                }
            }
            "kafka" => {
                let password = if record.secret_ciphertext.is_empty() {
                    None
                } else {
                    let aad = format!("usage-export:{id}:secret");
                    Some(
                        decrypt_async(
                            &record.secret_ciphertext,
                            &aad,
                            self.0.encryption_key.as_str(),
                        )
                        .await?,
                    )
                };
                if record.mode == "window" {
                    crate::audit_export::send_usage_kafka_window_test(
                        id,
                        &record.config_json,
                        password,
                        &event,
                        record.window_sec,
                        self.0.allow_private,
                    )
                    .await?;
                } else {
                    crate::audit_export::send_usage_kafka_test(
                        id,
                        &record.config_json,
                        password,
                        &event,
                        self.0.allow_private,
                    )
                    .await?;
                }
            }
            _ => return Err("unsupported usage export type"),
        }
        Ok(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX))
    }

    pub async fn revoke_client_key(&self, id: &str) -> Result<(), &'static str> {
        self.revoke_client_key_as(id, "bootstrap-admin", None).await
    }

    async fn revoke_client_key_as(
        &self,
        id: &str,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<(), &'static str> {
        validate_id(id)?;
        validate_actor(actor)?;
        let _mutation = self.0.mutation.lock().await;
        let key = self
            .0
            .database
            .client_keys()
            .await?
            .into_iter()
            .find(|key| key.id == id)
            .ok_or("client key configuration not found")?;
        if enforced_tenant.is_some_and(|tenant| tenant != key.tenant_id) {
            return Err("client key tenant is unavailable");
        }
        let before = client_view(&key)?;
        let revoked_revision = revision()?;
        self.0
            .database
            .revoke_client_key(id, revoked_revision)
            .await?;
        let mut revoked = key;
        revoked.enabled = false;
        revoked.revision = revoked_revision;
        let after = client_view(&revoked)?;
        self.record_audit_event(
            AuditContext {
                action: "client_key.revoke",
                actor,
                tenant_id: &revoked.tenant_id,
                target: id,
                resource_type: "client_key",
            },
            Some(&before),
            Some(&after),
        )
        .await;
        if self.refresh_clients().await.is_err() {
            *self.0.clients.write().await = ClientSnapshot::Unavailable;
            return Err("cannot reload client key configuration");
        }
        Ok(())
    }

    async fn record_audit_event<T: Serialize>(
        &self,
        context: AuditContext<'_>,
        before: Option<&T>,
        after: Option<&T>,
    ) {
        let request_id = match random_token(16) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("Rust audit event generation failed: {error}");
                return;
            }
        };
        let details_json = match serde_json::to_string(&serde_json::json!({
            "before": before,
            "after": after
        })) {
            Ok(value) => value,
            Err(_) => {
                eprintln!("Rust audit event serialization failed");
                return;
            }
        };
        if details_json.len() > 256 * 1024 {
            eprintln!("Rust audit event exceeds the bounded snapshot size");
            return;
        }
        let created_at_unix_ms = match unix_time_ms() {
            Ok(value) => value,
            Err(error) => {
                eprintln!("Rust audit event clock failed: {error}");
                return;
            }
        };
        let event = StoredAuditEvent {
            id: format!("audit-{request_id}"),
            created_at_unix_ms,
            action: context.action.to_owned(),
            actor: context.actor.to_owned(),
            tenant_id: context.tenant_id.to_owned(),
            target: context.target.to_owned(),
            resource_type: context.resource_type.to_owned(),
            status: "success".to_owned(),
            request_id,
            details_json,
        };
        if let Err(error) = self.0.database.insert_audit_event(&event).await {
            eprintln!("Rust audit event persistence failed: {error}");
        }
    }

    async fn provider_runtime_signature(&self) -> Result<[u8; 32], &'static str> {
        let mut digest = Sha256::new();
        signature_text(&mut digest, "redrouter-provider-runtime-v3");
        for record in self.0.database.providers().await? {
            signature_text(&mut digest, &record.id);
            signature_text(&mut digest, &record.tenant_id);
            signature_text(&mut digest, &record.provider);
            signature_text(&mut digest, &record.upstream_url);
            signature_text(&mut digest, &record.protocol);
            signature_i64(&mut digest, record.priority);
            signature_text(&mut digest, record.default_model.as_deref().unwrap_or(""));
            signature_text(&mut digest, record.node_id.as_deref().unwrap_or(""));
            signature_text(&mut digest, &record.credential_ciphertext);
            signature_bool(&mut digest, record.enabled);
            signature_i64(&mut digest, record.updated_at);
        }
        for record in self.0.database.provider_auth().await? {
            signature_text(&mut digest, &record.provider_id);
            signature_text(&mut digest, &record.auth_scheme);
            signature_text(&mut digest, &record.label);
            signature_text(&mut digest, &record.account_email);
            signature_i64(&mut digest, record.expires_at_unix);
            signature_i64(&mut digest, record.revision);
        }
        for record in self.0.database.provider_oauth().await? {
            signature_text(&mut digest, &record.provider_id);
            signature_text(&mut digest, &record.oauth_provider);
            signature_text(&mut digest, &record.refresh_token_ciphertext);
            signature_i64(&mut digest, record.generation);
            signature_i64(&mut digest, record.revision);
        }
        signature_i64(
            &mut digest,
            i64::from(self.0.database.alias_routing_configured().await?),
        );
        for alias in self.0.database.model_aliases().await? {
            signature_text(&mut digest, &alias.id);
            signature_i64(&mut digest, alias.revision);
        }
        for model in self.0.database.provider_models().await? {
            signature_text(&mut digest, &model.id);
            signature_i64(&mut digest, model.revision);
        }
        for node in self.0.database.provider_nodes().await? {
            signature_text(&mut digest, &node.id);
            signature_i64(&mut digest, node.revision);
        }
        for record in self.0.database.provider_headers().await? {
            signature_text(&mut digest, &record.provider_id);
            signature_text(&mut digest, &record.upstream_identity);
            signature_text(&mut digest, &record.headers_ciphertext);
            signature_i64(&mut digest, record.revision);
        }
        for record in self.0.database.provider_sessions().await? {
            signature_text(&mut digest, &record.provider_id);
            signature_text(&mut digest, &record.provider);
            signature_text(&mut digest, &record.session_ciphertext);
            signature_i64(&mut digest, record.revision);
        }
        for record in self.0.database.provider_resilience().await? {
            signature_text(&mut digest, &record.provider_id);
            signature_text(&mut digest, &record.rate_limit_scope);
            signature_i64(&mut digest, record.revision);
        }
        for record in self.0.database.breaker_overrides().await? {
            signature_text(&mut digest, &record.provider_id);
            signature_i64(&mut digest, record.failure_threshold);
            signature_i64(&mut digest, record.degradation_threshold);
            signature_i64(&mut digest, record.reset_timeout_ms);
            signature_i64(&mut digest, record.revision);
        }
        if let Some(record) = self.0.database.runtime_settings().await? {
            signature_bool(&mut digest, record.quota_preflight_enabled);
            signature_i64(&mut digest, record.quota_preflight_threshold_ppm);
            signature_i64(&mut digest, record.oauth_cooldown_base_ms);
            signature_bool(&mut digest, record.oauth_cooldown_retry_hints);
            signature_i64(&mut digest, record.oauth_cooldown_max_backoff_steps);
            signature_i64(&mut digest, record.apikey_cooldown_base_ms);
            signature_bool(&mut digest, record.apikey_cooldown_retry_hints);
            signature_i64(&mut digest, record.apikey_cooldown_max_backoff_steps);
            signature_i64(&mut digest, record.oauth_breaker_failure_threshold);
            signature_i64(&mut digest, record.oauth_breaker_degradation_threshold);
            signature_i64(&mut digest, record.oauth_breaker_reset_timeout_ms);
            signature_i64(&mut digest, record.apikey_breaker_failure_threshold);
            signature_i64(&mut digest, record.apikey_breaker_degradation_threshold);
            signature_i64(&mut digest, record.apikey_breaker_reset_timeout_ms);
            signature_i64(&mut digest, record.revision);
        }
        for record in self.0.database.provider_quotas().await? {
            signature_text(&mut digest, &record.provider_id);
            signature_i64(&mut digest, record.session_remaining_ppm);
            signature_i64(&mut digest, record.session_reset_unix_ms);
            signature_i64(&mut digest, record.weekly_remaining_ppm);
            signature_i64(&mut digest, record.weekly_reset_unix_ms);
            signature_bool(&mut digest, record.limit_reached);
            signature_i64(&mut digest, record.observed_at_unix_ms);
            signature_i64(&mut digest, record.expires_at_unix_ms);
            signature_i64(&mut digest, record.revision);
        }
        for record in self.0.database.provider_model_quotas().await? {
            signature_text(&mut digest, &record.provider_id);
            signature_text(&mut digest, &record.model_id);
            signature_i64(&mut digest, record.session_remaining_ppm);
            signature_i64(&mut digest, record.session_reset_unix_ms);
            signature_i64(&mut digest, record.weekly_remaining_ppm);
            signature_i64(&mut digest, record.weekly_reset_unix_ms);
            signature_bool(&mut digest, record.limit_reached);
            signature_i64(&mut digest, record.observed_at_unix_ms);
            signature_i64(&mut digest, record.expires_at_unix_ms);
            signature_i64(&mut digest, record.revision);
        }
        for record in self.0.database.combos().await? {
            signature_text(&mut digest, &record.id);
            signature_text(&mut digest, &record.tenant_id);
            signature_text(&mut digest, &record.protocol);
            signature_text(&mut digest, &record.strategy);
            signature_bool(&mut digest, record.fallback);
            signature_text(&mut digest, &record.targets_json);
            signature_bool(&mut digest, record.enabled);
            signature_i64(&mut digest, record.revision);
        }
        for record in self.0.database.route_pins().await? {
            signature_text(&mut digest, &record.combo_id);
            signature_text(&mut digest, &record.provider_id);
            signature_text(&mut digest, &record.model);
            signature_i64(&mut digest, record.revision);
        }
        Ok(digest.finalize().into())
    }

    async fn oidc_runtime_signature(&self) -> Result<[u8; 32], &'static str> {
        let mut digest = Sha256::new();
        signature_text(&mut digest, "redrouter-oidc-runtime-v1");
        if let Some(record) = self.0.database.oidc_config().await? {
            signature_bool(&mut digest, true);
            signature_bool(&mut digest, record.enabled);
            signature_text(&mut digest, &record.issuer);
            signature_text(&mut digest, &record.audience);
            signature_text(&mut digest, &record.jwks_uri);
            signature_text(&mut digest, &record.required_claims_json);
            signature_text(&mut digest, &record.allowed_subjects_json);
            signature_i64(&mut digest, record.revision);
        } else {
            signature_bool(&mut digest, false);
        }
        if let Some(record) = self.0.database.oidc_browser_config().await? {
            signature_bool(&mut digest, true);
            signature_text(&mut digest, &record.public_origin);
            signature_text(&mut digest, &record.client_id);
            signature_text(&mut digest, &record.client_secret_ciphertext);
            signature_text(&mut digest, &record.authorization_endpoint);
            signature_text(&mut digest, &record.token_endpoint);
            signature_text(&mut digest, &record.scopes_json);
            signature_i64(&mut digest, record.revision);
        } else {
            signature_bool(&mut digest, false);
        }
        Ok(digest.finalize().into())
    }

    async fn refresh_oidc(&self) -> Result<(), &'static str> {
        let stored = self.0.database.oidc_config().await?;
        let verifier = stored
            .as_ref()
            .map(|record| crate::oidc::OidcVerifier::from_stored(record, self.0.allow_private))
            .transpose()?
            .map(Arc::new);
        let browser = match (
            stored.as_ref(),
            self.0.database.oidc_browser_config().await?,
        ) {
            (Some(policy), Some(browser)) if policy.revision == browser.revision => Some(Arc::new(
                crate::oidc::OidcBrowserConfig::from_stored(&browser)?,
            )),
            _ => None,
        };
        // Disable browser login while the verifier changes so no request can
        // observe policy and confidential-client records from different revisions.
        *self.0.oidc_browser.write().await = None;
        *self.0.oidc.write().await = verifier;
        *self.0.oidc_browser.write().await = browser;
        Ok(())
    }

    async fn clear_oidc_runtime(&self) {
        *self.0.oidc_browser.write().await = None;
        *self.0.oidc.write().await = None;
    }

    async fn refresh(&self) -> Result<(), &'static str> {
        let resilience = self.resilience_settings().await?;
        let auth = self.auth_settings().await?;
        let antigravity_projects = self.antigravity_projects().await?;
        let claude_identities = self.claude_identities().await?;
        let live = match self.0.database.active_provider().await? {
            Some(record) => {
                let rate_limit_scope = resilience
                    .get(&(record.id.clone(), record.updated_at))
                    .copied()
                    .unwrap_or_default();
                let provider_auth = auth
                    .get(&(record.id.clone(), record.updated_at))
                    .cloned()
                    .unwrap_or_else(|| default_provider_auth(&record));
                let auth_scheme = ProviderAuthScheme::parse(&provider_auth.auth_scheme)?;
                let credential = decrypt_async(
                    &record.credential_ciphertext,
                    &record.id,
                    self.0.encryption_key.as_str(),
                )
                .await?;
                let mut live = ProxyState::live_provider(
                    &record.upstream_url,
                    credential.as_str(),
                    self.0.allow_private,
                    auth_scheme,
                    provider_auth.expires_at_unix,
                    &record.protocol,
                    record.node_id.is_some(),
                )
                .await?;
                let circuit = self.circuit_for(&record.id, &record.upstream_url).await;
                live.in_flight = circuit.in_flight();
                live.circuit = Some(circuit);
                live.availability = Some(self.availability_for(&record.id).await);
                live.antigravity_project = antigravity_projects
                    .get(&(record.id.clone(), record.updated_at))
                    .cloned();
                live.claude_identity = claude_identities
                    .get(&(record.id.clone(), record.updated_at))
                    .cloned();
                live.custom_headers = self.request_headers(&record).await?;
                live.provider_id = Some(Arc::from(record.id));
                live.provider_name = Some(Arc::from(record.provider));
                live.tenant_id = Arc::from(record.tenant_id);
                live.rate_limit_scope = rate_limit_scope;
                Some(live)
            }
            None => None,
        };
        *self.0.current.write().await = live;
        Ok(())
    }

    async fn refresh_clients(&self) -> Result<(), &'static str> {
        let records = self.0.database.client_keys().await?;
        let snapshot = if records.is_empty() {
            ClientSnapshot::Legacy
        } else {
            let enabled_tenants: HashSet<_> = self
                .0
                .database
                .tenants()
                .await?
                .into_iter()
                .filter(|tenant| tenant.enabled)
                .map(|tenant| tenant.id)
                .collect();
            let policies = records
                .iter()
                .filter(|record| enabled_tenants.contains(&record.tenant_id))
                .map(stored_policy)
                .collect::<Result<Vec<_>, _>>()?;
            if policies.iter().any(|policy| policy.usage_quota.is_some())
                && self.0.native_usage.read().await.is_none()
            {
                return Err("native usage quotas require SQLite storage");
            }
            ClientSnapshot::Current(Arc::new(ClientPolicies::from_stored(policies)?))
        };
        *self.0.clients.write().await = snapshot;
        Ok(())
    }

    async fn refresh_routes(&self) -> Result<(), &'static str> {
        let mut records = self.0.database.combos().await?;
        let providers = self.0.database.providers().await?;
        let provider_index: HashMap<_, _> = providers
            .iter()
            .map(|provider| (provider.id.as_str(), provider))
            .collect();
        let combo_ids: HashSet<_> = records.iter().map(|record| record.id.as_str()).collect();
        let combo_names: HashSet<_> = records
            .iter()
            .map(|record| (record.tenant_id.as_str(), record.id.as_str()))
            .collect();
        let aliases = self.model_aliases_snapshot().await?;
        for alias in &aliases.records {
            if combo_ids.contains(alias.id.as_str())
                || combo_names.contains(&(alias.tenant_id.as_str(), alias.alias.as_str()))
            {
                return Err("Model alias conflicts with a combo");
            }
        }
        records.extend(aliases.virtual_combos(&providers)?);
        let legacy_routes = records.is_empty() && !aliases.configured;
        let resilience = self.resilience_settings().await?;
        let auth = self.auth_settings().await?;
        let antigravity_projects = self.antigravity_projects().await?;
        let claude_identities = self.claude_identities().await?;
        let pins: HashMap<_, _> = self
            .0
            .database
            .route_pins()
            .await?
            .into_iter()
            .map(|pin| (pin.combo_id.clone(), pin))
            .collect();
        let mut retained_pins = Vec::new();
        let mut live = HashMap::<String, LiveProvider>::new();
        let mut routes = HashMap::new();
        for record in records.iter().filter(|record| record.enabled) {
            let view = if aliases.public_name(&record.id).is_some() {
                model_aliases::route_view(record)?
            } else {
                combo_view(record)?
            };
            let concrete_targets = if aliases.public_name(&record.id).is_some() {
                view.targets.clone()
            } else {
                resolve_nested_combo_targets(
                    &record.id,
                    &record.tenant_id,
                    &record.protocol,
                    &view.targets,
                    &records,
                )?
            };
            let auto_weights =
                view.auto
                    .as_ref()
                    .map_or_else(crate::AutoRouteWeights::default, |config| {
                        crate::AutoRouteWeights {
                            quota: config.weights.quota,
                            cost: config.weights.cost,
                            context: config.weights.context,
                            load: config.weights.load,
                        }
                    });
            let context_relay = view.context_relay.clone().unwrap_or_default();
            let fusion = view.fusion.clone().unwrap_or_default();
            let pipeline = view.pipeline.clone().unwrap_or_default();
            let protocol = ProviderProtocol::parse(&record.protocol)?;
            let mut targets = Vec::new();
            for target in concrete_targets {
                let Some(provider) = provider_index
                    .get(target.provider_id.as_str())
                    .copied()
                    .filter(|provider| provider.tenant_id == record.tenant_id && provider.enabled)
                else {
                    continue;
                };
                if !live.contains_key(&provider.id) {
                    let provider_auth = auth
                        .get(&(provider.id.clone(), provider.updated_at))
                        .cloned()
                        .unwrap_or_else(|| default_provider_auth(provider));
                    let auth_scheme = ProviderAuthScheme::parse(&provider_auth.auth_scheme)?;
                    let credential = decrypt_async(
                        &provider.credential_ciphertext,
                        &provider.id,
                        self.0.encryption_key.as_str(),
                    )
                    .await?;
                    let mut runtime = ProxyState::live_provider(
                        &provider.upstream_url,
                        credential.as_str(),
                        self.0.allow_private,
                        auth_scheme,
                        provider_auth.expires_at_unix,
                        &provider.protocol,
                        provider.node_id.is_some(),
                    )
                    .await?;
                    runtime.custom_headers = self.request_headers(provider).await?;
                    runtime.provider_id = Some(Arc::from(provider.id.clone()));
                    runtime.provider_name = Some(Arc::from(provider.provider.clone()));
                    runtime.antigravity_project = antigravity_projects
                        .get(&(provider.id.clone(), provider.updated_at))
                        .cloned();
                    runtime.claude_identity = claude_identities
                        .get(&(provider.id.clone(), provider.updated_at))
                        .cloned();
                    runtime.tenant_id = Arc::from(provider.tenant_id.clone());
                    runtime.rate_limit_scope = resilience
                        .get(&(provider.id.clone(), provider.updated_at))
                        .copied()
                        .unwrap_or_default();
                    let circuit = self.circuit_for(&provider.id, &provider.upstream_url).await;
                    runtime.in_flight = circuit.in_flight();
                    runtime.circuit = Some(circuit);
                    runtime.availability = Some(self.availability_for(&provider.id).await);
                    live.insert(provider.id.clone(), runtime);
                }
                if live
                    .get(&provider.id)
                    .is_none_or(|provider| !protocol.accepts_provider(provider.protocol))
                {
                    if aliases.public_name(&record.id).is_some() {
                        continue;
                    }
                    return Err("combo provider protocol changed");
                }
                let quota = self.quota_state(&provider.id).await;
                let model_quota = self.model_quota_state(&provider.id, &target.model).await;
                let metadata = self
                    .effective_model(&record.tenant_id, &provider.provider, &target.model)
                    .await?;
                let catalog_cost = metadata.as_ref().and_then(|model| model.cost.as_ref());
                let catalog_context = metadata
                    .as_ref()
                    .and_then(|model| model.limit.as_ref())
                    .and_then(|limit| limit.context);
                targets.push(ProxyState::control_target(
                    live.get(&provider.id).ok_or("combo provider unavailable")?,
                    crate::ControlTargetConfig {
                        protocol,
                        model: target.model,
                        weight: target.weight.unwrap_or(1),
                        input_cost_per_million: target
                            .input_cost_per_million
                            .or_else(|| catalog_cost.and_then(|cost| cost.input)),
                        output_cost_per_million: target
                            .output_cost_per_million
                            .or_else(|| catalog_cost.and_then(|cost| cost.output)),
                        context_window_tokens: target.context_window_tokens.or(catalog_context),
                        prompt: target.prompt,
                    },
                    quota,
                    Some(model_quota),
                ));
            }
            if targets.is_empty() {
                if aliases.public_name(&record.id).is_some() {
                    continue;
                }
                return Err("combo has no enabled provider targets");
            }
            let strategy = match record.strategy.as_str() {
                "priority" => RouteStrategy::Priority,
                "auto" => RouteStrategy::Auto,
                "round-robin" => RouteStrategy::RoundRobin,
                "weighted" => RouteStrategy::Weighted,
                "random" => RouteStrategy::Random,
                "least-used" => RouteStrategy::LeastUsed,
                "p2c" => RouteStrategy::P2c,
                "fill-first" => RouteStrategy::FillFirst,
                "strict-random" => RouteStrategy::StrictRandom,
                "cost-optimized" => RouteStrategy::CostOptimized,
                "context-optimized" => RouteStrategy::ContextOptimized,
                "cache-optimized" => RouteStrategy::CacheOptimized,
                "context-relay" => RouteStrategy::ContextRelay,
                "fusion" => RouteStrategy::Fusion,
                "pipeline" => RouteStrategy::Pipeline,
                "reset-aware" => RouteStrategy::ResetAware,
                "reset-window" => RouteStrategy::ResetWindow,
                "headroom" => RouteStrategy::Headroom,
                "quota-weighted" => RouteStrategy::QuotaWeighted,
                "lkgp" => RouteStrategy::Lkgp,
                _ => return Err("unsupported combo strategy"),
            };
            let last_good = if strategy == RouteStrategy::Lkgp {
                pins.get(&record.id).and_then(|pin| {
                    targets.iter().position(|target| {
                        target.provider_id.as_deref() == Some(pin.provider_id.as_str())
                            && target.model == pin.model
                    })
                })
            } else {
                None
            };
            if last_good.is_some() {
                retained_pins.push(record.id.clone());
            }
            routes.insert(
                record.id.clone(),
                Arc::new(ModelRoute {
                    public_model_alias: aliases.public_name(&record.id).map(Arc::from),
                    provider_direct: false,
                    tenant_id: Arc::from(record.tenant_id.clone()),
                    targets,
                    protocol,
                    strategy,
                    auto_weights,
                    context_relay,
                    fusion,
                    pipeline,
                    fallback: record.fallback,
                    cursor: std::sync::atomic::AtomicUsize::new(0),
                    seed: if strategy == RouteStrategy::StrictRandom {
                        crate::secure_route_seed(&record.id)?
                    } else {
                        crate::route_seed(&record.id)
                    },
                    last_good: std::sync::atomic::AtomicUsize::new(
                        last_good.unwrap_or(crate::NO_ROUTE_TARGET),
                    ),
                }),
            );
        }
        if !legacy_routes {
            for combo_id in pins.keys() {
                if !retained_pins.contains(combo_id) {
                    self.0.database.delete_route_pin(combo_id).await?;
                }
            }
        }
        // Keep encrypted account records in the same immutable snapshot as
        // configured routes. Unused accounts build their validated client only
        // on first use; concurrent requests share that initialization.
        let mut ordered: Vec<_> = providers.iter().collect();
        ordered.sort_by(|a, b| model_aliases::compare_accounts(a, b));
        let mut direct_pools: DirectPools = HashMap::new();
        // A definition without active accounts must remain distinguishable
        // from an unknown model prefix; it must never fall through to a
        // different provider's credentials.
        for node in self.0.database.provider_nodes().await? {
            direct_pools
                .entry((node.tenant_id, node.prefix))
                .or_default();
        }
        for provider in ordered {
            let pool = direct_pools
                .entry((provider.tenant_id.clone(), provider.provider.clone()))
                .or_default();
            if !provider.enabled {
                continue;
            }
            let key = (provider.id.clone(), provider.updated_at);
            let account = DirectAccount {
                record: provider.clone(),
                auth: auth
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| default_provider_auth(provider)),
                rate_limit_scope: resilience.get(&key).copied().unwrap_or_default(),
                antigravity_project: antigravity_projects.get(&key).cloned(),
                claude_identity: claude_identities.get(&key).cloned(),
                quota: self.quota_state(&provider.id).await,
                live: tokio::sync::OnceCell::new_with(live.get(&provider.id).cloned()),
            };
            pool.push(Arc::new(account));
        }
        let direct_pools = Arc::new(direct_pools);
        *self.0.routes.write().await = if legacy_routes {
            RouteSnapshot::Legacy(direct_pools)
        } else {
            RouteSnapshot::Current(Arc::new(routes), direct_pools)
        };
        Ok(())
    }

    async fn refresh_quotas(&self) -> Result<(), &'static str> {
        let records = self.0.database.provider_quotas().await?;
        for record in &records {
            validate_stored_quota(record)?;
        }
        let active: HashSet<_> = records
            .iter()
            .map(|record| record.provider_id.clone())
            .collect();
        let existing = self.0.quotas.read().await.clone();
        for (provider_id, state) in existing {
            if !active.contains(provider_id.as_str()) {
                state.clear();
            }
        }
        for record in records {
            self.quota_state(&record.provider_id).await.update(&record);
        }
        let model_records = self.0.database.provider_model_quotas().await?;
        for record in &model_records {
            validate_stored_model_quota(record)?;
        }
        let active_models = model_records
            .iter()
            .map(|record| (record.provider_id.clone(), record.model_id.clone()))
            .collect::<HashSet<_>>();
        let existing_models = self.0.model_quotas.read().await.clone();
        for (key, state) in existing_models {
            if !active_models.contains(&key) {
                state.clear();
            }
        }
        for record in model_records {
            self.model_quota_state(&record.provider_id, &record.model_id)
                .await
                .update_model(&record);
        }
        Ok(())
    }

    pub(crate) async fn record_route_success(
        &self,
        combo_id: &str,
        target: &crate::ModelTarget,
    ) -> Result<(), &'static str> {
        let Some(provider_id) = target.provider_id.as_deref() else {
            return Ok(());
        };
        let _mutation = self.0.mutation.lock().await;
        let route = match &*self.0.routes.read().await {
            RouteSnapshot::Current(routes, _) => routes.get(combo_id).cloned(),
            _ => None,
        };
        let Some(route) = route else {
            return Ok(());
        };
        let Some(index) = route.target_index(provider_id, &target.model) else {
            return Ok(());
        };
        if !route.set_last_good_index(index) {
            return Ok(());
        }
        self.0
            .database
            .upsert_route_pin(&StoredRoutePin {
                combo_id: combo_id.to_owned(),
                provider_id: provider_id.to_owned(),
                model: target.model.clone(),
                revision: revision()?,
            })
            .await
    }

    pub(crate) async fn record_route_failure(
        &self,
        combo_id: &str,
        target: &crate::ModelTarget,
    ) -> Result<(), &'static str> {
        let Some(provider_id) = target.provider_id.as_deref() else {
            return Ok(());
        };
        let _mutation = self.0.mutation.lock().await;
        let route = match &*self.0.routes.read().await {
            RouteSnapshot::Current(routes, _) => routes.get(combo_id).cloned(),
            _ => None,
        };
        let Some(route) = route else {
            return Ok(());
        };
        let Some(index) = route.target_index(provider_id, &target.model) else {
            return Ok(());
        };
        if route.clear_last_good_index(index) {
            self.0.database.delete_route_pin(combo_id).await?;
        }
        Ok(())
    }

    pub(crate) async fn context_relay_session(
        &self,
        combo_id: &str,
        session_id: &str,
    ) -> Result<Option<(String, String)>, &'static str> {
        let record_id = context_relay_record_id(combo_id, session_id);
        self.0
            .database
            .context_relay_session(&record_id)
            .await
            .map(|record| record.map(|record| (record.provider_id, record.model)))
    }

    pub(crate) async fn record_context_relay_session(
        &self,
        combo_id: &str,
        session_id: &str,
        target: &crate::ModelTarget,
    ) -> Result<(), &'static str> {
        let provider_id = target
            .provider_id
            .as_deref()
            .ok_or("context relay provider identity unavailable")?;
        self.0
            .database
            .upsert_context_relay_session(&StoredContextRelaySession {
                record_id: context_relay_record_id(combo_id, session_id),
                combo_id: combo_id.to_owned(),
                provider_id: provider_id.to_owned(),
                model: target.model.clone(),
                updated_at_unix_ms: unix_time_ms()?,
            })
            .await
    }

    pub(crate) async fn context_relay_handoff(
        &self,
        combo_id: &str,
        session_id: &str,
    ) -> Result<Option<ContextRelayHandoff>, &'static str> {
        let record = self
            .0
            .database
            .context_relay_handoff(&context_relay_record_id(combo_id, session_id))
            .await?;
        let Some(record) = record else {
            return Ok(None);
        };
        if record.combo_id != combo_id || record.expires_at_unix_ms <= unix_time_ms()? {
            return Ok(None);
        }
        if record.summary.is_empty()
            || record.summary.chars().count() > 2_000
            || record.task_progress.chars().count() > 1_200
            || record.message_count < 0
            || record.message_count > 100_000
            || record.source_model.is_empty()
            || record.source_model.chars().count() > 256
            || record.summary_model.is_empty()
            || record.summary_model.chars().count() > 256
        {
            return Err("invalid context relay handoff");
        }
        let key_decisions = parse_context_relay_list(&record.key_decisions_json, 8)?;
        let active_entities = parse_context_relay_list(&record.active_entities_json, 10)?;
        Ok(Some(ContextRelayHandoff {
            summary: record.summary,
            key_decisions,
            task_progress: record.task_progress,
            active_entities,
            message_count: usize::try_from(record.message_count)
                .map_err(|_| "invalid context relay handoff")?,
            source_model: record.source_model,
        }))
    }

    fn begin_context_relay_generation_local(
        &self,
        combo_id: &str,
        session_id: &str,
    ) -> Result<Option<ContextRelayGenerationGuard>, &'static str> {
        let record_id = context_relay_record_id(combo_id, session_id);
        let mut generations = self
            .0
            .context_relay_generations
            .lock()
            .map_err(|_| "context relay generation state unavailable")?;
        if !generations.insert(record_id.clone()) {
            return Ok(None);
        }
        Ok(Some(ContextRelayGenerationGuard {
            inner: self.0.clone(),
            record_id,
        }))
    }

    pub(crate) async fn acquire_context_relay_generation(
        &self,
        combo_id: &str,
        session_id: &str,
    ) -> Result<Option<ContextRelayGenerationLease>, &'static str> {
        let Some(local) = self.begin_context_relay_generation_local(combo_id, session_id)? else {
            return Ok(None);
        };
        let now_unix_ms = unix_time_ms()?;
        let lease_until_unix_ms = now_unix_ms
            .checked_add(CONTEXT_RELAY_GENERATION_LEASE_MS)
            .ok_or("invalid context relay generation lease")?;
        let owner = random_token(18)?;
        let record_id = context_relay_record_id(combo_id, session_id);
        if !self
            .0
            .database
            .acquire_context_relay_generation_lease(
                &record_id,
                &owner,
                now_unix_ms,
                lease_until_unix_ms,
            )
            .await?
        {
            return Ok(None);
        }
        Ok(Some(ContextRelayGenerationLease {
            _local: local,
            record_id,
            owner,
        }))
    }

    pub(crate) async fn release_context_relay_generation(
        &self,
        lease: &ContextRelayGenerationLease,
    ) -> Result<(), &'static str> {
        self.0
            .database
            .release_context_relay_generation_lease(&lease.record_id, &lease.owner)
            .await
    }

    pub(crate) async fn record_context_relay_handoff(
        &self,
        combo_id: &str,
        session_id: &str,
        handoff: &ContextRelayHandoff,
        summary_model: &str,
        expires_at_unix_ms: i64,
    ) -> Result<(), &'static str> {
        if handoff.summary.is_empty()
            || handoff.summary.chars().count() > 2_000
            || handoff.task_progress.chars().count() > 1_200
            || handoff.key_decisions.len() > 8
            || handoff.active_entities.len() > 10
            || handoff
                .key_decisions
                .iter()
                .chain(&handoff.active_entities)
                .any(|value| value.is_empty() || value.chars().count() > 240)
            || handoff.message_count > 100_000
            || handoff.source_model.is_empty()
            || handoff.source_model.chars().count() > 256
            || summary_model.is_empty()
            || summary_model.chars().count() > 256
        {
            return Err("invalid context relay handoff");
        }
        let generated_at_unix_ms = unix_time_ms()?;
        if expires_at_unix_ms <= generated_at_unix_ms {
            return Err("invalid context relay handoff expiry");
        }
        self.0
            .database
            .upsert_context_relay_handoff(&StoredContextRelayHandoff {
                record_id: context_relay_record_id(combo_id, session_id),
                combo_id: combo_id.to_owned(),
                summary: handoff.summary.clone(),
                key_decisions_json: serde_json::to_string(&handoff.key_decisions)
                    .map_err(|_| "cannot encode context relay handoff")?,
                task_progress: handoff.task_progress.clone(),
                active_entities_json: serde_json::to_string(&handoff.active_entities)
                    .map_err(|_| "cannot encode context relay handoff")?,
                message_count: i64::try_from(handoff.message_count)
                    .map_err(|_| "invalid context relay handoff")?,
                source_model: handoff.source_model.clone(),
                summary_model: summary_model.to_owned(),
                generated_at_unix_ms,
                expires_at_unix_ms,
            })
            .await
    }

    async fn clear_route_pin(
        &self,
        combo_id: &str,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<(), &'static str> {
        validate_id(combo_id)?;
        validate_actor(actor)?;
        let _mutation = self.0.mutation.lock().await;
        let combo = self
            .0
            .database
            .combos()
            .await?
            .into_iter()
            .find(|combo| combo.id == combo_id)
            .ok_or("combo configuration not found")?;
        if enforced_tenant.is_some_and(|tenant| tenant != combo.tenant_id) {
            return Err("combo tenant is unavailable");
        }
        if let RouteSnapshot::Current(routes, _) = &*self.0.routes.read().await {
            if let Some(route) = routes.get(combo_id) {
                route.clear_last_good_any();
            }
        }
        let before = self
            .0
            .database
            .route_pins()
            .await?
            .into_iter()
            .find(|pin| pin.combo_id == combo_id)
            .map(route_pin_view);
        self.0.database.delete_route_pin(combo_id).await?;
        self.record_audit_event(
            AuditContext {
                action: "combo.route_pin.clear",
                actor,
                tenant_id: &combo.tenant_id,
                target: combo_id,
                resource_type: "route_pin",
            },
            before.as_ref(),
            Option::<&RoutePinView>::None,
        )
        .await;
        Ok(())
    }

    async fn views(&self, tenant_id: Option<&str>) -> Result<Vec<ProviderView>, &'static str> {
        let resilience = self.resilience_settings().await?;
        let auth = self.auth_settings().await?;
        let oauth = self.oauth_settings().await?;
        let oauth_status = self.oauth_status_settings().await?;
        self.0.database.providers().await.and_then(|rows| {
            rows.iter()
                .filter(|record| tenant_id.is_none_or(|tenant| tenant == record.tenant_id))
                .map(|record| {
                    let provider_oauth = oauth.get(&(record.id.clone(), record.updated_at));
                    let status = provider_oauth.and_then(|provider_oauth| {
                        oauth_status.get(&(
                            record.id.clone(),
                            record.updated_at,
                            provider_oauth.generation,
                        ))
                    });
                    view(
                        record,
                        resilience
                            .get(&(record.id.clone(), record.updated_at))
                            .copied()
                            .unwrap_or_default(),
                        auth.get(&(record.id.clone(), record.updated_at)),
                        provider_oauth,
                        status,
                    )
                })
                .collect()
        })
    }

    async fn auth_settings(
        &self,
    ) -> Result<HashMap<(String, i64), StoredProviderAuth>, &'static str> {
        self.0
            .database
            .provider_auth()
            .await?
            .into_iter()
            .map(|record| {
                ProviderAuthScheme::parse(&record.auth_scheme)?;
                validate_provider_label(&record.label)?;
                validate_provider_account_email(&record.account_email)?;
                if record.expires_at_unix < 0 {
                    return Err("provider credential expiry is invalid");
                }
                Ok(((record.provider_id.clone(), record.revision), record))
            })
            .collect()
    }

    async fn oauth_settings(
        &self,
    ) -> Result<HashMap<(String, i64), StoredProviderOAuth>, &'static str> {
        self.0
            .database
            .provider_oauth()
            .await?
            .into_iter()
            .map(|record| {
                if !matches!(
                    record.oauth_provider.as_str(),
                    "codex" | "claude" | "agy" | "github" | "xai-oauth" | "openference"
                ) || record.generation < 0
                    || record.refresh_token_ciphertext.is_empty()
                {
                    return Err("invalid provider OAuth configuration");
                }
                Ok(((record.provider_id.clone(), record.revision), record))
            })
            .collect()
    }

    async fn antigravity_projects(&self) -> Result<HashMap<(String, i64), Arc<str>>, &'static str> {
        let mut projects = HashMap::new();
        for record in self.0.database.provider_sessions().await? {
            if record.provider != "agy" {
                continue;
            }
            let aad = format!("{}:oauth-session", record.provider_id);
            let metadata = decrypt_async(
                &record.session_ciphertext,
                &aad,
                self.0.encryption_key.as_str(),
            )
            .await?;
            let metadata: serde_json::Value = serde_json::from_str(metadata.as_str())
                .map_err(|_| "invalid Antigravity session metadata")?;
            let Some(project) = json_non_empty_string(metadata.get("projectId")) else {
                continue;
            };
            if project.len() > 256 || project.chars().any(char::is_control) {
                return Err("invalid Antigravity project identifier");
            }
            if projects
                .insert(
                    (record.provider_id, record.revision),
                    Arc::from(project.to_owned()),
                )
                .is_some()
            {
                return Err("duplicate Antigravity session metadata");
            }
        }
        Ok(projects)
    }

    async fn claude_identities(
        &self,
    ) -> Result<HashMap<(String, i64), Arc<crate::ClaudeIdentity>>, &'static str> {
        let mut identities = HashMap::new();
        for record in self.0.database.provider_sessions().await? {
            if record.provider != "claude" {
                continue;
            }
            let aad = format!("{}:oauth-session", record.provider_id);
            let metadata = decrypt_async(
                &record.session_ciphertext,
                &aad,
                self.0.encryption_key.as_str(),
            )
            .await?;
            let (device, account) = claude_session_identity(metadata.as_str())?;
            let session_id = {
                let mut sessions = self
                    .0
                    .claude_sessions
                    .lock()
                    .map_err(|_| "Claude session identity unavailable")?;
                if let Some(session) = sessions.get(&record.provider_id) {
                    session.clone()
                } else {
                    let session: Arc<str> = Arc::from(random_uuid_v4()?);
                    sessions.insert(record.provider_id.clone(), session.clone());
                    session
                }
            };
            let identity = Arc::new(crate::ClaudeIdentity {
                device_id: Arc::from(device),
                account_uuid: Arc::from(account),
                session_id,
            });
            if identities
                .insert((record.provider_id, record.revision), identity)
                .is_some()
            {
                return Err("duplicate Claude session metadata");
            }
        }
        Ok(identities)
    }

    async fn oauth_status_settings(
        &self,
    ) -> Result<HashMap<(String, i64, i64), StoredProviderOAuthStatus>, &'static str> {
        self.0
            .database
            .provider_oauth_status()
            .await?
            .into_iter()
            .map(|record| {
                if record.revision < 0
                    || record.generation < 0
                    || record.refresh_state != "reauth_required"
                    || record.observed_at_unix < 0
                    || record.error_code.is_empty()
                    || record.error_code.len() > 64
                    || !record
                        .error_code
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                {
                    return Err("invalid provider OAuth refresh status");
                }
                Ok((
                    (
                        record.provider_id.clone(),
                        record.revision,
                        record.generation,
                    ),
                    record,
                ))
            })
            .collect()
    }

    async fn resilience_settings(
        &self,
    ) -> Result<HashMap<(String, i64), RateLimitScope>, &'static str> {
        self.0
            .database
            .provider_resilience()
            .await?
            .into_iter()
            .map(|record| {
                RateLimitScope::parse(&record.rate_limit_scope)
                    .map(|scope| ((record.provider_id, record.revision), scope))
            })
            .collect()
    }

    async fn client_views(
        &self,
        tenant_id: Option<&str>,
    ) -> Result<Vec<ClientKeyView>, &'static str> {
        self.0
            .database
            .client_keys()
            .await?
            .iter()
            .filter(|record| tenant_id.is_none_or(|tenant| tenant == record.tenant_id))
            .map(client_view)
            .collect()
    }

    async fn token_limit_views(
        &self,
        key_id: &str,
        tenant_id: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, &'static str> {
        validate_id(key_id)?;
        let pool = self
            .0
            .database
            .sql_pool()
            .ok_or("token limits require SQLite storage")?;
        let owner: Option<String> = sqlx::query_scalar(
            "SELECT tenant_id FROM redrouter_control_client_key_ownership WHERE key_id=$1",
        )
        .bind(key_id)
        .fetch_optional(pool)
        .await
        .map_err(|_| "token limit storage unavailable")?;
        let owner = owner.ok_or("client key not found")?;
        if tenant_id.is_some_and(|tenant| tenant != owner) {
            return Err("client key not found");
        }
        let now = unix_time_ms()?;
        let rows = sqlx::query("SELECT model,reset_interval,reset_minutes,token_limit FROM redrouter_client_model_token_limits WHERE key_id=$1 ORDER BY model,reset_interval")
            .bind(key_id).fetch_all(pool).await.map_err(|_| "token limit storage unavailable")?;
        let mut views = Vec::with_capacity(rows.len());
        for row in rows {
            let model: String = row.try_get("model").map_err(|_| "invalid token limit")?;
            let interval: String = row
                .try_get("reset_interval")
                .map_err(|_| "invalid token limit")?;
            let reset: i64 = row
                .try_get("reset_minutes")
                .map_err(|_| "invalid token limit")?;
            let limit: i64 = row
                .try_get("token_limit")
                .map_err(|_| "invalid token limit")?;
            let start = crate::native_usage::model_window_start(now, &interval, reset)?;
            let mut used: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(tokens_input+tokens_output+tokens_reasoning),0) FROM redrouter_usage_ledger WHERE key_id=$1 AND (model=$2 OR quota_model=$2) AND created_at_unix_ms >= $3")
                .bind(key_id).bind(&model).bind(start).fetch_one(pool).await.map_err(|_| "token limit ledger unavailable")?;
            if let Some(baseline) = sqlx::query("SELECT window_start_unix_ms,tokens_used FROM redrouter_legacy_model_token_baselines WHERE key_id=$1 AND model=$2 AND reset_interval=$3")
                .bind(key_id).bind(&model).bind(&interval).fetch_optional(pool).await.map_err(|_| "legacy model quota baseline unavailable")?
            {
                let baseline_start: i64 = baseline.try_get("window_start_unix_ms").map_err(|_| "invalid legacy model quota baseline")?;
                let baseline_used: i64 = baseline.try_get("tokens_used").map_err(|_| "invalid legacy model quota baseline")?;
                if baseline_start > start || baseline_used < 0 { return Err("invalid legacy model quota baseline"); }
                if baseline_start == start { used = used.checked_add(baseline_used).ok_or("usage counter overflow")?; }
            }
            let id = token_limit_id(key_id, &model, &interval);
            views.push(serde_json::json!({
                "id":id,"apiKeyId":key_id,"scopeType":"model","scopeValue":model,
                "tokenLimit":limit,"resetInterval":interval,"resetTime":format!("{:02}:{:02}",reset/60,reset%60),
                "enabled":true,"tokensUsed":used,"windowStart":start.to_string(),"periodStartAt":start,
                "nextResetAt":next_token_window(start,&interval)?,"remaining":limit.saturating_sub(used).max(0)
            }));
        }
        Ok(views)
    }

    async fn upsert_token_limit_as(
        &self,
        input: TokenLimitInput,
        actor: &str,
        tenant_id: Option<&str>,
    ) -> Result<serde_json::Value, &'static str> {
        validate_actor(actor)?;
        validate_id(&input.api_key_id)?;
        if input.scope_type != "model"
            || input.scope_value.trim() != input.scope_value
            || input.scope_value.is_empty()
            || input.scope_value.len() > 256
            || input.scope_value.chars().any(char::is_control)
            || !matches!(
                input.reset_interval.as_str(),
                "daily" | "weekly" | "monthly"
            )
            || !(1..=9_007_199_254_740_991).contains(&input.token_limit)
            || !input.enabled
        {
            return Err("invalid token limit");
        }
        let reset = parse_reset_minutes(input.reset_time.as_deref().unwrap_or("00:00"))?;
        let expected = token_limit_id(&input.api_key_id, &input.scope_value, &input.reset_interval);
        if input.id.as_deref().is_some_and(|id| id != expected) {
            return Err("token limit identifier does not match its scope");
        }
        let before = self
            .token_limit_views(&input.api_key_id, tenant_id)
            .await?
            .into_iter()
            .find(|limit| limit["id"] == expected);
        let pool = self
            .0
            .database
            .sql_pool()
            .ok_or("token limits require SQLite storage")?;
        let mut db = pool
            .acquire()
            .await
            .map_err(|_| "token limit storage unavailable")?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *db)
            .await
            .map_err(|_| "token limit storage unavailable")?;
        let result: Result<(), &'static str> = async {
            let row = sqlx::query("SELECT k.enabled,q.reservation_tokens,q.max_tokens_per_minute,q.max_tokens_per_day,q.max_monthly_microusd,o.tenant_id FROM redrouter_control_client_keys k JOIN redrouter_control_client_key_quotas q ON q.key_id=k.id AND q.revision=k.revision JOIN redrouter_control_client_key_ownership o ON o.key_id=k.id AND o.revision=k.revision WHERE k.id=$1")
                .bind(&input.api_key_id).fetch_optional(&mut *db).await.map_err(|_| "client quota unavailable")?.ok_or("client key not found")?;
            let owner: String = row.try_get("tenant_id").map_err(|_| "invalid client quota")?;
            if tenant_id.is_some_and(|tenant| tenant != owner) { return Err("client key not found"); }
            let enabled: i64 = row.try_get("enabled").map_err(|_| "invalid client quota")?;
            let reservation: i64 = row.try_get("reservation_tokens").map_err(|_| "invalid client quota")?;
            let has_global = ["max_tokens_per_minute","max_tokens_per_day","max_monthly_microusd"].iter().try_fold(false,|found,field| row.try_get::<i64,_>(*field).map(|value|found||value>0).map_err(|_|"invalid client quota"))?;
            if enabled != 0 || !has_global || reservation <= 0 || reservation > input.token_limit { return Err("disable the key and configure a compatible reservation first"); }
            // SQLite resolves every table referenced by a statement before it
            // evaluates CASE branches. Keep the optional legacy table out of
            // the second statement entirely when a native database has never
            // run the legacy importer.
            let migration_table: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='redrouter_legacy_key_migration'")
                .fetch_one(&mut *db).await.map_err(|_| "migration state unavailable")?;
            let migrated: i64 = if migration_table == 0 {
                0
            } else {
                sqlx::query_scalar("SELECT COUNT(*) FROM redrouter_legacy_key_migration WHERE key_id=$1")
                    .bind(&input.api_key_id).fetch_one(&mut *db).await.map_err(|_| "migration state unavailable")?
            };
            if migrated != 0 { return Err("legacy model quota baseline requires migration"); }
            sqlx::query("INSERT INTO redrouter_client_model_token_limits (key_id,model,reset_interval,reset_minutes,token_limit) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(key_id,model,reset_interval) DO UPDATE SET reset_minutes=$4,token_limit=$5")
                .bind(&input.api_key_id).bind(&input.scope_value).bind(&input.reset_interval).bind(reset).bind(input.token_limit)
                .execute(&mut *db).await.map_err(|_| "cannot configure token limit")?;
            Ok(())
        }.await;
        match result {
            Ok(()) => sqlx::query("COMMIT")
                .execute(&mut *db)
                .await
                .map(|_| ())
                .map_err(|_| "cannot commit token limit")?,
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *db).await;
                return Err(error);
            }
        }
        // SQLite uses a single pooled connection so every proxy process sees
        // one serialized quota authority. COMMIT ends the transaction but the
        // PoolConnection remains checked out until it is dropped; release it
        // before rebuilding the response and recording the audit event.
        drop(db);
        let after = self
            .token_limit_views(&input.api_key_id, tenant_id)
            .await?
            .into_iter()
            .find(|limit| {
                limit["id"]
                    == token_limit_id(&input.api_key_id, &input.scope_value, &input.reset_interval)
            })
            .ok_or("token limit unavailable")?;
        let owner: String = sqlx::query_scalar(
            "SELECT tenant_id FROM redrouter_control_client_key_ownership WHERE key_id=$1",
        )
        .bind(&input.api_key_id)
        .fetch_one(pool)
        .await
        .map_err(|_| "token limit storage unavailable")?;
        self.record_audit_event(
            AuditContext {
                action: "client_key.token_limit.upsert",
                actor,
                tenant_id: &owner,
                target: &expected,
                resource_type: "client_key_token_limit",
            },
            before.as_ref(),
            Some(&after),
        )
        .await;
        Ok(after)
    }

    async fn delete_token_limit_as(
        &self,
        id: &str,
        actor: &str,
        tenant_id: Option<&str>,
    ) -> Result<bool, &'static str> {
        validate_actor(actor)?;
        if id.is_empty() || id.len() > 64 {
            return Err("invalid token limit identifier");
        }
        let pool = self
            .0
            .database
            .sql_pool()
            .ok_or("token limits require SQLite storage")?;
        let rows = sqlx::query("SELECT l.key_id,l.model,l.reset_interval,o.tenant_id FROM redrouter_client_model_token_limits l JOIN redrouter_control_client_key_ownership o ON o.key_id=l.key_id")
            .fetch_all(pool).await.map_err(|_| "token limit storage unavailable")?;
        for row in rows {
            let key: String = row.try_get("key_id").map_err(|_| "invalid token limit")?;
            let model: String = row.try_get("model").map_err(|_| "invalid token limit")?;
            let interval: String = row
                .try_get("reset_interval")
                .map_err(|_| "invalid token limit")?;
            let tenant: String = row
                .try_get("tenant_id")
                .map_err(|_| "invalid token limit")?;
            if token_limit_id(&key, &model, &interval) == id {
                if tenant_id.is_some_and(|expected| expected != tenant) {
                    return Ok(false);
                }
                let before = self
                    .token_limit_views(&key, tenant_id)
                    .await?
                    .into_iter()
                    .find(|limit| limit["id"] == id);
                let mut db = pool
                    .acquire()
                    .await
                    .map_err(|_| "cannot delete token limit")?;
                sqlx::query("BEGIN IMMEDIATE")
                    .execute(&mut *db)
                    .await
                    .map_err(|_| "cannot delete token limit")?;
                let result: Result<u64, &'static str> = async {
                    sqlx::query("DELETE FROM redrouter_legacy_model_token_baselines WHERE key_id=$1 AND model=$2 AND reset_interval=$3")
                        .bind(&key).bind(&model).bind(&interval).execute(&mut *db).await.map_err(|_| "cannot delete token limit baseline")?;
                    sqlx::query("DELETE FROM redrouter_client_model_token_limits WHERE key_id=$1 AND model=$2 AND reset_interval=$3")
                        .bind(&key).bind(&model).bind(&interval).execute(&mut *db).await.map(|result| result.rows_affected()).map_err(|_|"cannot delete token limit")
                }.await;
                let affected = match result {
                    Ok(affected) => {
                        sqlx::query("COMMIT")
                            .execute(&mut *db)
                            .await
                            .map_err(|_| "cannot commit token limit deletion")?;
                        affected
                    }
                    Err(error) => {
                        let _ = sqlx::query("ROLLBACK").execute(&mut *db).await;
                        return Err(error);
                    }
                };
                // Release the single SQLite connection before the audit
                // writer starts its own transaction.
                drop(db);
                if affected == 1 {
                    self.record_audit_event(
                        AuditContext {
                            action: "client_key.token_limit.delete",
                            actor,
                            tenant_id: &tenant,
                            target: id,
                            resource_type: "client_key_token_limit",
                        },
                        before.as_ref(),
                        Option::<&serde_json::Value>::None,
                    )
                    .await;
                    return Ok(true);
                }
                return Ok(false);
            }
        }
        Ok(false)
    }

    async fn tenant_views(&self) -> Result<Vec<TenantView>, &'static str> {
        Ok(self
            .0
            .database
            .tenants()
            .await?
            .iter()
            .map(tenant_view)
            .collect())
    }

    async fn identity_binding_views(&self) -> Result<Vec<IdentityBindingView>, &'static str> {
        Ok(self
            .0
            .database
            .identity_bindings()
            .await?
            .iter()
            .map(identity_binding_view)
            .collect())
    }

    async fn audit_event_views(
        &self,
        tenant_id: Option<&str>,
        query: &AuditQuery,
    ) -> Result<(Vec<AuditEventView>, usize), &'static str> {
        for value in [
            query.action.as_deref(),
            query.actor.as_deref(),
            query.target.as_deref(),
            query.resource_type.as_deref(),
            query.status.as_deref(),
            query.request_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
                return Err("invalid audit filter");
            }
        }
        let limit = query.limit.unwrap_or(50).clamp(1, 500);
        let offset = query.offset.unwrap_or(0).min(10_000);
        let filtered = self
            .0
            .database
            .audit_events(tenant_id)
            .await?
            .into_iter()
            .filter(|event| {
                query
                    .action
                    .as_deref()
                    .is_none_or(|value| event.action == value)
                    && query
                        .actor
                        .as_deref()
                        .is_none_or(|value| event.actor == value)
                    && query
                        .target
                        .as_deref()
                        .is_none_or(|value| event.target == value)
                    && query
                        .resource_type
                        .as_deref()
                        .is_none_or(|value| event.resource_type == value)
                    && query
                        .status
                        .as_deref()
                        .is_none_or(|value| event.status == value)
                    && query
                        .request_id
                        .as_deref()
                        .is_none_or(|value| event.request_id == value)
            })
            .collect::<Vec<_>>();
        let total = filtered.len();
        let events = filtered
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(audit_event_view)
            .collect::<Result<Vec<_>, _>>()?;
        Ok((events, total))
    }

    async fn combo_views(&self, tenant_id: Option<&str>) -> Result<Vec<ComboView>, &'static str> {
        let pins: HashMap<_, _> = self
            .0
            .database
            .route_pins()
            .await?
            .into_iter()
            .map(|pin| (pin.combo_id.clone(), pin))
            .collect();
        self.0
            .database
            .combos()
            .await?
            .iter()
            .filter(|record| tenant_id.is_none_or(|tenant| tenant == record.tenant_id))
            .map(|record| {
                let mut view = combo_view(record)?;
                view.last_known_good = pins.get(&record.id).map(|pin| RoutePinView {
                    provider_id: pin.provider_id.clone(),
                    model: pin.model.clone(),
                    revision: pin.revision.to_string(),
                });
                Ok(view)
            })
            .collect()
    }

    async fn quota_views(
        &self,
        tenant_id: Option<&str>,
    ) -> Result<Vec<ProviderQuotaView>, &'static str> {
        let providers: HashSet<_> = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .filter(|provider| tenant_id.is_none_or(|tenant| tenant == provider.tenant_id))
            .map(|provider| provider.id)
            .collect();
        let mut models = HashMap::<String, Vec<ProviderModelQuotaView>>::new();
        for record in self.0.database.provider_model_quotas().await? {
            if providers.contains(&record.provider_id) {
                models
                    .entry(record.provider_id.clone())
                    .or_default()
                    .push(model_quota_view(&record)?);
            }
        }
        self.0
            .database
            .provider_quotas()
            .await?
            .iter()
            .filter(|quota| providers.contains(&quota.provider_id))
            .map(|quota| {
                let mut view = quota_view(quota)?;
                view.models = models.remove(&quota.provider_id).unwrap_or_default();
                Ok(view)
            })
            .collect()
    }

    async fn quota_state(&self, provider_id: &str) -> Arc<TargetQuota> {
        if let Some(state) = self.0.quotas.read().await.get(provider_id).cloned() {
            return state;
        }
        let mut quotas = self.0.quotas.write().await;
        quotas
            .entry(provider_id.to_owned())
            .or_insert_with(|| Arc::new(TargetQuota::default()))
            .clone()
    }

    async fn model_quota_state(&self, provider_id: &str, model_id: &str) -> Arc<TargetQuota> {
        let key = (provider_id.to_owned(), model_id.to_owned());
        if let Some(state) = self.0.model_quotas.read().await.get(&key).cloned() {
            return state;
        }
        let mut quotas = self.0.model_quotas.write().await;
        quotas
            .entry(key)
            .or_insert_with(|| Arc::new(TargetQuota::default()))
            .clone()
    }

    async fn replace_model_quota_states(
        &self,
        provider_id: &str,
        records: &[StoredProviderModelQuota],
    ) {
        let active = records
            .iter()
            .map(|record| record.model_id.as_str())
            .collect::<HashSet<_>>();
        let existing = self.0.model_quotas.read().await.clone();
        for ((owner, model), state) in existing {
            if owner == provider_id && !active.contains(model.as_str()) {
                state.clear();
            }
        }
        for record in records {
            self.model_quota_state(provider_id, &record.model_id)
                .await
                .update_model(record);
        }
    }

    async fn breaker_views(
        &self,
        tenant_id: Option<&str>,
    ) -> Result<Vec<ProviderHealthView>, &'static str> {
        let providers = self.0.database.providers().await?;
        let mut statuses = Vec::with_capacity(providers.len());
        for provider in providers
            .into_iter()
            .filter(|provider| tenant_id.is_none_or(|tenant| tenant == provider.tenant_id))
        {
            statuses.push(ProviderHealthView {
                breaker: self
                    .circuit_for(&provider.id, &provider.upstream_url)
                    .await
                    .status()
                    .await?,
                availability: self.availability_for(&provider.id).await.status().await?,
            });
        }
        statuses.sort_by(|left, right| left.breaker.provider_id.cmp(&right.breaker.provider_id));
        Ok(statuses)
    }

    pub(crate) async fn quota_preflight_threshold_ppm(&self) -> Option<i64> {
        let settings = self.0.runtime_settings.read().await;
        settings
            .quota_preflight_enabled
            .then(|| (settings.quota_preflight_threshold_percent * 10_000.0).round() as i64)
    }

    async fn runtime_settings_view(&self) -> RuntimeSettingsView {
        self.0.runtime_settings.read().await.clone()
    }

    async fn configure_runtime_settings_as(
        &self,
        input: RuntimeSettingsInput,
        actor: &str,
    ) -> Result<RuntimeSettingsView, &'static str> {
        validate_actor(actor)?;
        validate_runtime_settings_input(&input)?;
        let _mutation = self.0.mutation.lock().await;
        let before = self.runtime_settings_view().await;
        let record = StoredRuntimeSettings {
            quota_preflight_enabled: input.quota_preflight_enabled,
            quota_preflight_threshold_ppm: (input.quota_preflight_threshold_percent * 10_000.0)
                .round() as i64,
            oauth_cooldown_base_ms: input.oauth_connection_cooldown.base_cooldown_ms as i64,
            oauth_cooldown_retry_hints: input.oauth_connection_cooldown.use_upstream_retry_hints,
            oauth_cooldown_max_backoff_steps: i64::from(
                input.oauth_connection_cooldown.max_backoff_steps,
            ),
            apikey_cooldown_base_ms: input.apikey_connection_cooldown.base_cooldown_ms as i64,
            apikey_cooldown_retry_hints: input.apikey_connection_cooldown.use_upstream_retry_hints,
            apikey_cooldown_max_backoff_steps: i64::from(
                input.apikey_connection_cooldown.max_backoff_steps,
            ),
            oauth_breaker_failure_threshold: input.oauth_provider_breaker.failure_threshold as i64,
            oauth_breaker_degradation_threshold: input.oauth_provider_breaker.degradation_threshold
                as i64,
            oauth_breaker_reset_timeout_ms: input.oauth_provider_breaker.reset_timeout_ms as i64,
            apikey_breaker_failure_threshold: input.apikey_provider_breaker.failure_threshold
                as i64,
            apikey_breaker_degradation_threshold: input
                .apikey_provider_breaker
                .degradation_threshold as i64,
            apikey_breaker_reset_timeout_ms: input.apikey_provider_breaker.reset_timeout_ms as i64,
            revision: revision()?,
        };
        self.0.database.upsert_runtime_settings(&record).await?;
        let after = runtime_settings_view(&record)?;
        *self.0.runtime_settings.write().await = after.clone();
        self.refresh_availability_profiles().await?;
        self.refresh_breaker_profiles().await?;
        self.record_audit_event(
            AuditContext {
                action: "runtime_settings.configure",
                actor,
                tenant_id: "red",
                target: "global",
                resource_type: "runtime_settings",
            },
            Some(&before),
            Some(&after),
        )
        .await;
        Ok(after)
    }

    async fn provider_health_snapshot(
        &self,
        provider: &StoredProvider,
    ) -> Result<ProviderHealthView, &'static str> {
        Ok(ProviderHealthView {
            breaker: self
                .circuit_for(&provider.id, &provider.upstream_url)
                .await
                .status()
                .await?,
            availability: self.availability_for(&provider.id).await.status().await?,
        })
    }

    async fn reset_breaker_as(
        &self,
        id: &str,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<(), &'static str> {
        validate_id(id)?;
        validate_actor(actor)?;
        let _mutation = self.0.mutation.lock().await;
        let provider = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|provider| provider.id == id)
            .ok_or("provider does not exist")?;
        if enforced_tenant.is_some_and(|tenant| tenant != provider.tenant_id) {
            return Err("provider tenant is unavailable");
        }
        let before = self.provider_health_snapshot(&provider).await?;
        self.availability_for(&provider.id).await.reset().await?;
        self.circuit_for(&provider.id, &provider.upstream_url)
            .await
            .reset()
            .await?;
        let after = self.provider_health_snapshot(&provider).await?;
        self.record_audit_event(
            AuditContext {
                action: "provider_health.reset",
                actor,
                tenant_id: &provider.tenant_id,
                target: id,
                resource_type: "provider_health",
            },
            Some(&before),
            Some(&after),
        )
        .await;
        Ok(())
    }

    async fn configure_breaker_as(
        &self,
        id: &str,
        input: ProviderHealthInput,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<BreakerStatus, &'static str> {
        validate_id(id)?;
        validate_actor(actor)?;
        let _mutation = self.0.mutation.lock().await;
        let provider = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|provider| provider.id == id)
            .ok_or("provider does not exist")?;
        if enforced_tenant.is_some_and(|tenant| tenant != provider.tenant_id) {
            return Err("provider tenant is unavailable");
        }
        let profile = breaker_profile(&ProviderBreakerProfileSettings {
            failure_threshold: input.failure_threshold,
            degradation_threshold: input.degradation_threshold,
            reset_timeout_ms: input.reset_timeout_ms,
        })?;
        let before = self.provider_health_snapshot(&provider).await?;
        let revision = revision()?;
        let override_record = StoredBreakerOverride {
            provider_id: provider.id.clone(),
            failure_threshold: i64::try_from(profile.failure_threshold)
                .map_err(|_| "invalid provider breaker configuration")?,
            degradation_threshold: i64::try_from(profile.degradation_threshold)
                .map_err(|_| "invalid provider breaker configuration")?,
            reset_timeout_ms: i64::try_from(profile.reset_timeout_ms)
                .map_err(|_| "invalid provider breaker configuration")?,
            revision,
        };
        self.0
            .database
            .upsert_breaker_override(&override_record)
            .await?;
        self.0.breaker_overrides.write().await.insert(
            provider.id.clone(),
            stored_breaker_profile(&override_record)?,
        );
        self.circuit_for(&provider.id, &provider.upstream_url)
            .await
            .configure(
                profile.failure_threshold,
                profile.degradation_threshold,
                profile.reset_timeout_ms,
            )
            .await?;
        let after = self.provider_health_snapshot(&provider).await?;
        self.record_audit_event(
            AuditContext {
                action: "provider_health.configure",
                actor,
                tenant_id: &provider.tenant_id,
                target: id,
                resource_type: "provider_health",
            },
            Some(&before),
            Some(&after),
        )
        .await;
        Ok(after.breaker)
    }

    async fn circuit_for(&self, id: &str, upstream_url: &str) -> Arc<ProviderCircuit> {
        if let Some(circuit) = self.0.breakers.read().await.get(id).cloned() {
            return circuit;
        }
        let profile = if let Some(profile) = self.0.breaker_overrides.read().await.get(id).copied()
        {
            profile
        } else if local_endpoint(upstream_url) {
            CircuitProfile::local_default()
        } else {
            let oauth = self.0.oauth_provider_ids.read().await.contains(id);
            let settings = self.0.runtime_settings.read().await;
            if oauth {
                breaker_profile(&settings.oauth_provider_breaker)
                    .unwrap_or_else(|_| CircuitProfile::oauth_default())
            } else {
                breaker_profile(&settings.apikey_provider_breaker)
                    .unwrap_or_else(|_| CircuitProfile::api_key_default())
            }
        };
        let created = Arc::new(ProviderCircuit::new(id, self.0.database.clone(), profile));
        let mut breakers = self.0.breakers.write().await;
        breakers.entry(id.to_owned()).or_insert(created).clone()
    }

    async fn availability_for(&self, id: &str) -> Arc<ProviderAvailability> {
        if let Some(availability) = self.0.availability.read().await.get(id).cloned() {
            return availability;
        }
        let created = Arc::new(ProviderAvailability::new(id, self.0.database.clone()));
        let mut availability = self.0.availability.write().await;
        availability.entry(id.to_owned()).or_insert(created).clone()
    }

    async fn authorized(&self, headers: &HeaderMap) -> bool {
        self.authorized_admin_actor(headers).await.is_some()
    }

    async fn authorized_admin_actor(&self, headers: &HeaderMap) -> Option<String> {
        let scope = self.management_scope(headers).await?;
        scope.tenant_id.is_none().then_some(scope.actor)
    }

    async fn management_scope(&self, headers: &HeaderMap) -> Option<ManagementScope> {
        let actor = self.authorized_actor(headers).await?;
        if actor.matches("bootstrap-admin") {
            return Some(ManagementScope {
                actor: "bootstrap-admin".to_owned(),
                tenant_id: None,
            });
        }
        let bindings = self.0.database.identity_bindings().await.ok()?;
        let binding = actor.subjects.iter().find_map(|subject| {
            bindings.iter().find(|binding| {
                binding.enabled
                    && binding.subject.as_str() == subject.as_str()
                    && matches!(binding.role.as_str(), "admin" | "tenant-admin")
            })
        })?;
        if self
            .0
            .database
            .tenants()
            .await
            .ok()?
            .iter()
            .any(|tenant| tenant.enabled && tenant.id == binding.tenant_id)
        {
            Some(ManagementScope {
                actor: binding.subject.clone(),
                tenant_id: (binding.role == "tenant-admin").then(|| binding.tenant_id.clone()),
            })
        } else {
            None
        }
    }

    async fn authorized_tenant_issuer(
        &self,
        headers: &HeaderMap,
        tenant_id: &str,
    ) -> Option<String> {
        let actor = self.authorized_actor(headers).await?;
        if actor.matches("bootstrap-admin") {
            return Some("bootstrap-admin".to_owned());
        }
        let bindings = self.0.database.identity_bindings().await.ok()?;
        let binding = actor.subjects.iter().find_map(|subject| {
            bindings.iter().find(|binding| {
                binding.enabled
                    && binding.subject.as_str() == subject.as_str()
                    && binding.tenant_id == tenant_id
                    && matches!(binding.role.as_str(), "admin" | "tenant-admin" | "issuer")
            })
        })?;
        if self
            .0
            .database
            .tenants()
            .await
            .ok()?
            .iter()
            .any(|tenant| tenant.enabled && tenant.id == binding.tenant_id)
        {
            Some(binding.subject.clone())
        } else {
            None
        }
    }

    async fn authorized_actor(&self, headers: &HeaderMap) -> Option<AuthenticatedActor> {
        let authorization_count = headers.get_all(header::AUTHORIZATION).iter().count();
        if authorization_count > 0 {
            if authorization_count != 1 {
                return None;
            }
            let candidate = headers
                .get(header::AUTHORIZATION)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
                .filter(|value| !value.is_empty() && value.len() <= 16 * 1024)?;
            if (32..=512).contains(&candidate.len()) {
                let digest: [u8; 32] = Sha256::digest(candidate.as_bytes()).into();
                if bool::from(self.0.admin_hash.ct_eq(&digest)) {
                    return Some(AuthenticatedActor::bound("bootstrap-admin".to_owned()));
                }
            }
            let (verifier, _) = self.oidc_runtime_snapshot().await;
            return match verifier {
                Some(verifier) => {
                    verifier
                        .verify(candidate)
                        .await
                        .ok()
                        .map(|identity| AuthenticatedActor {
                            subjects: identity.binding_subjects().map(str::to_owned).collect(),
                        })
                }
                None => None,
            };
        }

        let session_cookie = unique_cookie(headers, ADMIN_SESSION_COOKIE)?;
        let csrf_cookie = unique_cookie(headers, ADMIN_CSRF_COOKIE)?;
        let origin_count = headers.get_all(header::ORIGIN).iter().count();
        let fetch_site_count = headers.get_all("sec-fetch-site").iter().count();
        if headers.get_all(ADMIN_CSRF_HEADER).iter().count() != 1
            || origin_count > 1
            || fetch_site_count > 1
        {
            return None;
        }
        let csrf_header = headers
            .get(ADMIN_CSRF_HEADER)
            .and_then(|value| value.to_str().ok())
            .filter(|value| value.len() <= 256)?;
        if csrf_cookie.len() != csrf_header.len()
            || !bool::from(csrf_cookie.as_bytes().ct_eq(csrf_header.as_bytes()))
        {
            return None;
        }
        let Ok(session) = decrypt_async(
            &session_cookie,
            "oidc-browser-admin-session",
            self.0.encryption_key.as_str(),
        )
        .await
        else {
            return None;
        };
        let Ok(session) = serde_json::from_str::<AdminSession>(&session) else {
            return None;
        };
        let Ok(now) = unix_time_seconds() else {
            return None;
        };
        if session.subject.is_empty() || session.subject.len() > 512 || session.expires_at < now {
            return None;
        }
        let expected_origin = if let Some(bootstrap_hash) = session.bootstrap_hash.as_deref() {
            let current_hash = hex::encode(self.0.admin_hash);
            if session.subject != "bootstrap-admin"
                || session.revision != 0
                || bootstrap_hash.len() != current_hash.len()
                || !bool::from(bootstrap_hash.as_bytes().ct_eq(current_hash.as_bytes()))
            {
                return None;
            }
            session.origin.clone()?
        } else {
            let (verifier, browser) = self.oidc_runtime_snapshot().await;
            let (Some(browser), Some(verifier)) = (browser, verifier) else {
                return None;
            };
            if session.revision != verifier.policy().revision
                || session.revision != browser.revision
            {
                return None;
            }
            let configured_origin = browser.public_origin.origin().ascii_serialization();
            if session
                .origin
                .as_deref()
                .is_some_and(|origin| origin != configured_origin)
            {
                return None;
            }
            session.origin.clone().unwrap_or(configured_origin)
        };
        let fetch_site = headers
            .get("sec-fetch-site")
            .and_then(|value| value.to_str().ok());
        let same_origin = fetch_site.is_none_or(|site| site == "same-origin")
            && match headers.get(header::ORIGIN) {
                Some(origin) => origin.to_str().ok() == Some(expected_origin.as_str()),
                None => fetch_site == Some("same-origin"),
            };
        if !same_origin {
            return None;
        }
        let csrf_hash = hex::encode(Sha256::digest(csrf_cookie.as_bytes()));
        if csrf_hash.len() == session.csrf_hash.len()
            && bool::from(csrf_hash.as_bytes().ct_eq(session.csrf_hash.as_bytes()))
        {
            Some(AuthenticatedActor::bound(session.subject))
        } else {
            None
        }
    }
}

fn oidc_view(
    policy: &crate::oidc::OidcPolicy,
    browser: Option<&crate::oidc::OidcBrowserConfig>,
) -> OidcView {
    OidcView {
        enabled: policy.enabled,
        issuer: policy.issuer.clone(),
        audience: policy.audience.clone(),
        jwks_uri: policy.jwks_uri.to_string(),
        required_claims: policy.required_claims.clone(),
        allowed_subjects: policy.allowed_subjects.clone(),
        revision: policy.revision.to_string(),
        browser: browser.map(|browser| OidcBrowserView {
            public_origin: browser
                .public_origin
                .to_string()
                .trim_end_matches('/')
                .to_owned(),
            client_id: browser.client_id.clone(),
            authorization_endpoint: browser.authorization_endpoint.to_string(),
            token_endpoint: browser.token_endpoint.to_string(),
            scopes: browser.scopes.clone(),
            has_client_secret: !browser.client_secret_ciphertext.is_empty(),
        }),
    }
}

fn oidc_stored_view(
    stored: &StoredOidcConfig,
    browser: Option<&crate::oidc::OidcBrowserConfig>,
) -> Result<OidcView, &'static str> {
    let verifier = crate::oidc::OidcVerifier::from_stored(stored, false)?;
    Ok(oidc_view(verifier.policy(), browser))
}

async fn probe_provider(
    provider: &LiveProvider,
    provider_id: String,
    model: String,
) -> Result<ProviderDiagnosticView, &'static str> {
    let started = Instant::now();
    let deadline = tokio::time::Instant::now() + PROVIDER_DIAGNOSTIC_TIMEOUT;
    let mut target = provider.upstream.clone();
    let body = match provider.protocol {
        ProviderProtocol::OpenAi => serde_json::json!({
            "model":&model,
            "messages":[{"role":"user","content":"Reply with OK."}],
            "max_tokens":1,
            "stream":false
        }),
        ProviderProtocol::OpenAiResponses => serde_json::json!({
            "model":&model,
            "input":"Reply with OK.",
            "max_output_tokens":1,
            "stream":false
        }),
        ProviderProtocol::OpenAiEmbeddings => serde_json::json!({
            "model":&model,
            "input":"RedRouter connection test"
        }),
        ProviderProtocol::CohereRerank => serde_json::json!({
            "model":&model,
            "query":"RedRouter connection test",
            "documents":["RedRouter connection test"],
            "top_n":1
        }),
        ProviderProtocol::Anthropic => serde_json::json!({
            "model":&model,
            "messages":[{"role":"user","content":"Reply with OK."}],
            "max_tokens":1,
            "stream":false
        }),
        ProviderProtocol::Gemini => {
            let path = target.path().trim_end_matches('/').to_owned();
            target.set_path(&format!("{path}/{model}:generateContent"));
            serde_json::json!({
                "contents":[{"role":"user","parts":[{"text":"Reply with OK."}]}],
                "generationConfig":{"maxOutputTokens":1}
            })
        }
        ProviderProtocol::Antigravity => {
            return Err("Antigravity diagnostics require persisted project metadata")
        }
        ProviderProtocol::OpenAiToAnthropic | ProviderProtocol::OpenAiToAntigravity => {
            return Err("translated providers cannot be diagnosed directly")
        }
    };
    let mut request = provider
        .client
        .post(target)
        .header(header::CONTENT_TYPE, "application/json")
        .body(body.to_string());
    request = match provider.auth_scheme {
        ProviderAuthScheme::Bearer => {
            request.header(header::AUTHORIZATION, provider.provider_key.clone())
        }
        ProviderAuthScheme::XApiKey => request.header("x-api-key", provider.provider_key.clone()),
        ProviderAuthScheme::XGoogApiKey => {
            request.header("x-goog-api-key", provider.provider_key.clone())
        }
        ProviderAuthScheme::None => request,
        ProviderAuthScheme::Auto => return Err("provider authentication is unresolved"),
    };
    request = crate::github_copilot_headers(
        request,
        provider.provider_name.as_deref(),
        provider.provider_id.as_deref(),
    );
    if provider.protocol == ProviderProtocol::Anthropic {
        request = request.header("anthropic-version", "2023-06-01");
    }
    let request = request.headers(provider.custom_headers.clone());
    let response = match tokio::time::timeout_at(deadline, request.send()).await {
        Ok(Ok(response)) => response,
        Ok(Err(_)) => {
            return Ok(diagnostic_view(
                provider_id,
                model,
                false,
                "unavailable",
                None,
                started,
            ))
        }
        Err(_) => {
            return Ok(diagnostic_view(
                provider_id,
                model,
                false,
                "timeout",
                None,
                started,
            ))
        }
    };
    let status = response.status();
    let mut size = 0usize;
    let mut stream = response.bytes_stream();
    loop {
        match tokio::time::timeout_at(deadline, stream.next()).await {
            Ok(Some(Ok(chunk))) => {
                size = size.saturating_add(chunk.len());
                if size > PROVIDER_DIAGNOSTIC_MAX_BODY_BYTES {
                    return Ok(diagnostic_view(
                        provider_id,
                        model,
                        false,
                        "response_too_large",
                        Some(status.as_u16()),
                        started,
                    ));
                }
            }
            Ok(Some(Err(_))) => {
                return Ok(diagnostic_view(
                    provider_id,
                    model,
                    false,
                    "invalid_response",
                    Some(status.as_u16()),
                    started,
                ));
            }
            Ok(None) => break,
            Err(_) => {
                return Ok(diagnostic_view(
                    provider_id,
                    model,
                    false,
                    "timeout",
                    Some(status.as_u16()),
                    started,
                ));
            }
        }
    }
    let (ok, category) = match status.as_u16() {
        200..=299 => (true, "ok"),
        401 | 403 => (false, "authentication"),
        402 => (false, "credits_exhausted"),
        404 => (false, "model_unavailable"),
        429 => (false, "rate_limited"),
        400..=499 => (false, "request_rejected"),
        _ => (false, "upstream_error"),
    };
    Ok(diagnostic_view(
        provider_id,
        model,
        ok,
        category,
        Some(status.as_u16()),
        started,
    ))
}

fn diagnostic_view(
    provider_id: String,
    model: String,
    ok: bool,
    category: &'static str,
    upstream_status: Option<u16>,
    started: Instant,
) -> ProviderDiagnosticView {
    ProviderDiagnosticView {
        provider_id,
        model,
        ok,
        category,
        upstream_status,
        latency_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    }
}

fn default_provider_auth(record: &StoredProvider) -> StoredProviderAuth {
    StoredProviderAuth {
        provider_id: record.id.clone(),
        auth_scheme: "auto".to_owned(),
        label: record.id.clone(),
        account_email: String::new(),
        expires_at_unix: 0,
        revision: record.updated_at,
    }
}

fn view(
    record: &StoredProvider,
    rate_limit_scope: RateLimitScope,
    auth: Option<&StoredProviderAuth>,
    oauth: Option<&StoredProviderOAuth>,
    oauth_status: Option<&StoredProviderOAuthStatus>,
) -> Result<ProviderView, &'static str> {
    let fallback;
    let auth = match auth {
        Some(auth) => auth,
        None => {
            fallback = default_provider_auth(record);
            &fallback
        }
    };
    let expires_at_unix = match auth.expires_at_unix {
        0 => None,
        value if value > 0 => Some(value as u64),
        _ => return Err("provider credential expiry is invalid"),
    };
    Ok(ProviderView {
        node_id: record.node_id.clone(),
        protocol: record.protocol.clone(),
        priority: record.priority,
        default_model: record.default_model.clone(),
        id: record.id.clone(),
        tenant_id: record.tenant_id.clone(),
        provider: record.provider.clone(),
        upstream_url: record.upstream_url.clone(),
        enabled: record.enabled,
        revision: record.updated_at.to_string(),
        has_credential: auth.auth_scheme != "none" && !record.credential_ciphertext.is_empty(),
        rate_limit_scope: rate_limit_scope.as_str().to_owned(),
        auth_scheme: auth.auth_scheme.clone(),
        label: auth.label.clone(),
        account_email: (!auth.account_email.is_empty()).then(|| auth.account_email.clone()),
        expires_at_unix,
        credential_expired: expires_at_unix
            .is_some_and(|expiry| unix_time_seconds().map_or(true, |now| expiry <= now)),
        credential_type: if oauth.is_some() { "oauth" } else { "static" },
        oauth_provider: oauth.map(|value| value.oauth_provider.clone()),
        oauth_generation: oauth.map(|value| value.generation.to_string()),
        refreshable: oauth.is_some(),
        oauth_refresh_state: oauth.map(|_| {
            if oauth_status.is_some() {
                "reauth_required"
            } else {
                "ready"
            }
        }),
        oauth_error_code: oauth_status.map(|status| status.error_code.clone()),
        reauth_required: oauth_status.is_some(),
    })
}

fn client_view(record: &StoredClientKey) -> Result<ClientKeyView, &'static str> {
    let (allowed_models, model_matching) =
        crate::model_permissions::decode(&record.allowed_models_json)?;
    let expires_at_unix = match record.expiry_unix {
        0 => None,
        value if value > 0 => Some(value as u64),
        _ => return Err("invalid client key expiry"),
    };
    Ok(ClientKeyView {
        model_matching: model_matching.name(),
        id: record.id.clone(),
        label: record.label.clone(),
        tenant_id: record.tenant_id.clone(),
        created_by: record.created_by.clone(),
        model_id_format: validate_model_id_format(&record.model_id_format)?.to_owned(),
        model_access_mode: effective_model_access_mode(
            &record.model_access_mode,
            !allowed_models.is_empty(),
        )?
        .to_owned(),
        enabled: record.enabled,
        expires_at_unix,
        access_schedule: decode_access_schedule(&record.access_schedule_json)?,
        scopes: parse_list(&record.scopes_json)?,
        allowed_endpoints: parse_list(&record.allowed_endpoints_json)?,
        allowed_models,
        allowed_combos: decode_combo_grants(&record.allowed_combos_json)?,
        blocked_models: parse_list(&record.blocked_models_json)?,
        allowed_provider_ids: parse_list(&record.allowed_provider_ids_json)?,
        max_concurrent_requests: positive_u64(record.max_concurrent)?,
        max_requests_per_minute: positive_u64(record.max_rpm)?,
        max_requests_per_day: positive_u64(record.max_rpd)?,
        max_tokens_per_minute: positive_u64(record.max_tokens_per_minute)?,
        max_tokens_per_day: positive_u64(record.max_tokens_per_day)?,
        max_spend_per_month_usd: positive_micros_usd(record.max_monthly_microusd)?,
        reservation_tokens: positive_u64(record.reservation_tokens)?,
        reservation_spend_usd: positive_micros_usd(record.reservation_microusd)?,
        revision: record.revision.to_string(),
    })
}

fn tenant_view(record: &StoredTenant) -> TenantView {
    TenantView {
        id: record.id.clone(),
        slug: record.slug.clone(),
        name: record.name.clone(),
        enabled: record.enabled,
        revision: record.revision.to_string(),
    }
}

fn identity_binding_view(record: &StoredIdentityBinding) -> IdentityBindingView {
    IdentityBindingView {
        id: record.id.clone(),
        subject: record.subject.clone(),
        tenant_id: record.tenant_id.clone(),
        role: record.role.clone(),
        enabled: record.enabled,
        revision: record.revision.to_string(),
    }
}

fn audit_event_view(record: StoredAuditEvent) -> Result<AuditEventView, &'static str> {
    if record.details_json.len() > 256 * 1024 {
        return Err("invalid audit event details");
    }
    let details: serde_json::Value =
        serde_json::from_str(&record.details_json).map_err(|_| "invalid audit event details")?;
    let timestamp = ::time::OffsetDateTime::from_unix_timestamp_nanos(
        i128::from(record.created_at_unix_ms)
            .checked_mul(1_000_000)
            .ok_or("invalid audit event timestamp")?,
    )
    .map_err(|_| "invalid audit event timestamp")?
    .format(&::time::format_description::well_known::Rfc3339)
    .map_err(|_| "invalid audit event timestamp")?;
    Ok(AuditEventView {
        id: record.id,
        timestamp: timestamp.clone(),
        created_at: timestamp,
        action: record.action,
        actor: record.actor,
        tenant_id: record.tenant_id,
        target: record.target,
        resource_type: record.resource_type,
        status: record.status,
        request_id: record.request_id,
        metadata: details.clone(),
        details,
        ip: None,
        ip_address: None,
    })
}

fn usage_export_view(
    record: &StoredUsageExport,
    keys: &[StoredClientKey],
) -> Result<serde_json::Value, &'static str> {
    let api_key_ids: Vec<String> = serde_json::from_str(&record.api_key_ids_json)
        .map_err(|_| "invalid usage export key filters")?;
    if api_key_ids.len() > 200 {
        return Err("invalid usage export key filters");
    }
    let created_at = ::time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(record.revision))
        .map_err(|_| "invalid usage export revision")?
        .format(&::time::format_description::well_known::Rfc3339)
        .map_err(|_| "invalid usage export revision")?;
    let filter_keys = api_key_ids
        .iter()
        .map(|id| {
            keys.iter()
                .find(|key| key.id == *id && key.tenant_id == record.tenant_id)
                .map_or_else(
                    || serde_json::json!({"id": id, "name": null, "deleted": true}),
                    |key| serde_json::json!({"id": id, "name": key.label}),
                )
        })
        .collect::<Vec<_>>();
    let (type_label, config, summary) = match record.export_type.as_str() {
        "bigquery" => (
            "Google BigQuery",
            serde_json::json!({
                "projectId": record.project_id,
                "datasetId": record.dataset_id,
                "tableId": record.table_id,
                "serviceAccountJson": "__stored__",
                "batchSize": record.batch_size,
                "intervalSeconds": record.interval_seconds,
            }),
            format!(
                "{}.{}.{}",
                record.project_id, record.dataset_id, record.table_id
            ),
        ),
        "webhook" => {
            let url = webhook_usage_url(&record.config_json)?;
            (
                "Webhook (HTTPS POST, signed)",
                serde_json::json!({"url": url, "secret": "__stored__"}),
                format!("POST {url}"),
            )
        }
        "reddb" => {
            let (url, queue, tenant) = reddb_usage_config(&record.config_json)?;
            let mut config = serde_json::json!({
                "url": url,
                "queue": queue,
                "tenant": tenant,
            });
            if !record.secret_ciphertext.is_empty() {
                config["token"] = serde_json::Value::String("__stored__".to_owned());
            }
            ("RedDB queue", config, format!("QUEUE {queue} @ {url}"))
        }
        "sqs" => {
            let (queue_url, region, access_key_id, has_session_token) =
                sqs_usage_config(&record.config_json)?;
            let mut config = serde_json::json!({
                "queueUrl":queue_url,
                "region":region,
                "accessKeyId":access_key_id,
                "secretAccessKey":"__stored__",
            });
            if has_session_token {
                config["sessionToken"] = serde_json::Value::String("__stored__".to_owned());
            }
            (
                "Amazon SQS",
                config,
                format!(
                    "SQS {} ({region})",
                    queue_url.rsplit('/').next().unwrap_or("?")
                ),
            )
        }
        "kafka" => {
            let (brokers, topic, client_id, ssl, sasl_mechanism, sasl_username, has_password) =
                kafka_usage_config(&record.config_json)?;
            let mut config = serde_json::json!({
                "brokers":brokers.join(", "),
                "topic":topic.clone(),
                "clientId":client_id,
                "ssl":ssl,
                "saslMechanism":sasl_mechanism,
                "saslUsername":sasl_username,
            });
            if has_password {
                config["saslPassword"] = serde_json::Value::String("__stored__".to_owned());
            }
            (
                "Kafka",
                config,
                format!(
                    "Kafka {topic} @ {}{}",
                    brokers.first().map(String::as_str).unwrap_or("?"),
                    if brokers.len() > 1 {
                        format!(" +{}", brokers.len() - 1)
                    } else {
                        String::new()
                    }
                ),
            )
        }
        _ => return Err("invalid usage export configuration"),
    };
    let next_window_end = if record.mode == "window" && record.window_sec > 0 {
        let window_ms = record
            .window_sec
            .checked_mul(1_000)
            .ok_or("invalid usage export window")?;
        let now = unix_time_ms()?;
        let next = now
            .div_euclid(window_ms)
            .saturating_add(1)
            .saturating_mul(window_ms);
        serde_json::Value::String(
            ::time::OffsetDateTime::from_unix_timestamp_nanos(
                i128::from(next).saturating_mul(1_000_000),
            )
            .map_err(|_| "invalid usage export window")?
            .format(&::time::format_description::well_known::Rfc3339)
            .map_err(|_| "invalid usage export window")?,
        )
    } else {
        serde_json::Value::Null
    };
    Ok(serde_json::json!({
        "id": record.id,
        "tenantId": record.tenant_id,
        "name": record.name,
        "type": record.export_type,
        "typeLabel": type_label,
        "mode": record.mode,
        "windowSec": if record.window_sec == 0 { serde_json::Value::Null } else { serde_json::json!(record.window_sec) },
        "apiKeyIds": api_key_ids,
        "filterKeys": filter_keys,
        "config": config,
        "summary": summary,
        "enabled": record.enabled,
        "cursorId": 0,
        "nextWindowEnd": next_window_end,
        "createdAt": created_at,
        "updatedAt": created_at,
        "source": "redrouter_usage_ledger",
        "coverage": "verified-terminal-usage",
        "deliveries": {"pending": 0, "delivered": 0, "dead": 0},
        "deliveryHistory": false,
    }))
}

fn webhook_usage_url(config_json: &str) -> Result<String, &'static str> {
    if config_json.len() > 8 * 1024 {
        return Err("invalid webhook configuration");
    }
    serde_json::from_str::<serde_json::Value>(config_json)
        .ok()
        .and_then(|value| {
            value
                .get("url")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .filter(|url| !url.is_empty() && url.len() <= 2048)
        .ok_or("invalid webhook configuration")
}

fn reddb_usage_config(config_json: &str) -> Result<(String, String, Option<String>), &'static str> {
    if config_json.len() > 8 * 1024 {
        return Err("invalid RedDB usage configuration");
    }
    let value: serde_json::Value =
        serde_json::from_str(config_json).map_err(|_| "invalid RedDB usage configuration")?;
    let url = value
        .get("url")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 2048)
        .ok_or("invalid RedDB usage configuration")?
        .to_owned();
    let queue = value
        .get("queue")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| {
            let mut bytes = value.bytes();
            matches!(bytes.next(), Some(byte) if byte.is_ascii_alphabetic() || byte == b'_')
                && value.len() <= 128
                && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        })
        .ok_or("invalid RedDB usage configuration")?
        .to_owned();
    let tenant = value
        .get("tenant")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if tenant
        .as_ref()
        .is_some_and(|value| value.len() > 128 || value.chars().any(char::is_control))
    {
        return Err("invalid RedDB usage configuration");
    }
    Ok((url, queue, tenant))
}

fn sqs_region_from_url(queue_url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(queue_url).ok()?;
    let host = parsed.host_str()?;
    let rest = host.strip_prefix("sqs.")?;
    rest.strip_suffix(".amazonaws.com")
        .or_else(|| rest.strip_suffix(".amazonaws.com.cn"))
        .filter(|region| !region.is_empty())
        .map(str::to_owned)
}

fn sqs_usage_config(config_json: &str) -> Result<(String, String, String, bool), &'static str> {
    if config_json.len() > 8 * 1024 {
        return Err("invalid SQS usage configuration");
    }
    let value: serde_json::Value =
        serde_json::from_str(config_json).map_err(|_| "invalid SQS usage configuration")?;
    let field = |name| {
        value
            .get(name)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or("invalid SQS usage configuration")
    };
    let queue_url = field("queueUrl")?;
    let region = field("region")?;
    let access_key_id = field("accessKeyId")?;
    let has_session_token = value
        .get("hasSessionToken")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if queue_url.len() > 2048
        || region.len() > 32
        || !region
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        || access_key_id.len() > 128
        || access_key_id.chars().any(char::is_control)
    {
        return Err("invalid SQS usage configuration");
    }
    Ok((queue_url, region, access_key_id, has_session_token))
}

fn parse_kafka_brokers(value: &str) -> Vec<String> {
    value
        .split(|character: char| character == ',' || character.is_whitespace())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

type KafkaUsageConfig = (
    Vec<String>,
    String,
    String,
    bool,
    String,
    Option<String>,
    bool,
);

fn kafka_usage_config(config_json: &str) -> Result<KafkaUsageConfig, &'static str> {
    if config_json.len() > 16 * 1024 {
        return Err("invalid Kafka usage configuration");
    }
    let value: serde_json::Value =
        serde_json::from_str(config_json).map_err(|_| "invalid Kafka usage configuration")?;
    let brokers = value
        .get("brokers")
        .and_then(serde_json::Value::as_array)
        .ok_or("invalid Kafka usage configuration")?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.len() <= 260)
                .map(str::to_owned)
                .ok_or("invalid Kafka usage configuration")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let string = |name| {
        value
            .get(name)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .map(str::to_owned)
            .ok_or("invalid Kafka usage configuration")
    };
    let topic = string("topic")?;
    let client_id = string("clientId")?;
    let sasl_mechanism = string("saslMechanism")?;
    let sasl_username = value
        .get("saslUsername")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let ssl = value
        .get("ssl")
        .and_then(serde_json::Value::as_bool)
        .ok_or("invalid Kafka usage configuration")?;
    let has_password = value
        .get("hasSaslPassword")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if brokers.is_empty()
        || brokers.len() > 20
        || topic.is_empty()
        || client_id.is_empty()
        || client_id.len() > 128
        || !matches!(
            sasl_mechanism.as_str(),
            "" | "plain" | "scram-sha-256" | "scram-sha-512"
        )
        || (sasl_mechanism.is_empty() != sasl_username.is_none())
        || (sasl_mechanism.is_empty() != !has_password)
    {
        return Err("invalid Kafka usage configuration");
    }
    Ok((
        brokers,
        topic,
        client_id,
        ssl,
        sasl_mechanism,
        sasl_username,
        has_password,
    ))
}

fn combo_view(record: &StoredCombo) -> Result<ComboView, &'static str> {
    let payload = if record.targets_json.len() <= 256 * 1024 {
        serde_json::from_str::<StoredComboPayloadCompat>(&record.targets_json)
            .map_err(|_| "invalid combo targets")?
    } else {
        return Err("invalid combo targets");
    };
    let (targets, auto, context_relay, fusion, pipeline) = match payload {
        StoredComboPayloadCompat::Legacy(targets) => (targets, None, None, None, None),
        StoredComboPayloadCompat::Current(payload) => (
            payload.targets,
            payload.auto,
            payload.context_relay,
            payload.fusion,
            payload.pipeline,
        ),
    };
    let input = ComboInput {
        tenant_id: Some(record.tenant_id.clone()),
        protocol: record.protocol.clone(),
        strategy: record.strategy.clone(),
        fallback: record.fallback,
        targets: targets.clone(),
        auto: auto.clone(),
        context_relay: context_relay.clone(),
        fusion: fusion.clone(),
        pipeline: pipeline.clone(),
        enabled: record.enabled,
    };
    validate_combo(&input)?;
    Ok(ComboView {
        id: record.id.clone(),
        tenant_id: record.tenant_id.clone(),
        protocol: record.protocol.clone(),
        strategy: record.strategy.clone(),
        fallback: record.fallback,
        targets,
        auto,
        context_relay,
        fusion,
        pipeline,
        enabled: record.enabled,
        revision: record.revision.to_string(),
        last_known_good: None,
    })
}

const MAX_COMBO_NESTING_DEPTH: usize = 3;

fn resolve_nested_combo_targets(
    root_id: &str,
    tenant_id: &str,
    protocol: &str,
    root_targets: &[ComboTarget],
    records: &[StoredCombo],
) -> Result<Vec<ComboTarget>, &'static str> {
    struct Expansion<'a> {
        tenant_id: &'a str,
        protocol: &'a str,
        records: &'a [StoredCombo],
        visiting: HashSet<String>,
        resolved: Vec<ComboTarget>,
    }

    fn expand(
        combo_id: &str,
        targets: &[ComboTarget],
        depth: usize,
        state: &mut Expansion<'_>,
    ) -> Result<(), &'static str> {
        if !state.visiting.insert(combo_id.to_owned()) {
            return Err("circular combo reference");
        }
        for target in targets {
            let Some(nested_id) = target.combo_reference() else {
                if state.resolved.iter().any(|existing| {
                    existing.provider_id == target.provider_id && existing.model == target.model
                }) {
                    return Err("nested combo expansion contains duplicate targets");
                }
                if state.resolved.len() == 8 {
                    return Err("nested combo expansion exceeds eight targets");
                }
                state.resolved.push(target.clone());
                continue;
            };
            if depth >= MAX_COMBO_NESTING_DEPTH {
                return Err("maximum combo nesting depth exceeded");
            }
            let nested = state
                .records
                .iter()
                .find(|record| record.id == nested_id)
                .ok_or("nested combo not found")?;
            if !nested.enabled {
                return Err("nested combo is disabled");
            }
            if nested.tenant_id != state.tenant_id || nested.protocol != state.protocol {
                return Err("nested combo tenant or protocol mismatch");
            }
            let view = combo_view(nested)?;
            expand(nested_id, &view.targets, depth + 1, state)?;
        }
        state.visiting.remove(combo_id);
        Ok(())
    }

    let mut state = Expansion {
        tenant_id,
        protocol,
        records,
        visiting: HashSet::new(),
        resolved: Vec::new(),
    };
    expand(root_id, root_targets, 0, &mut state)?;
    if state.resolved.is_empty() {
        return Err("combo has no concrete targets");
    }
    Ok(state.resolved)
}

fn validate_combo_graphs(records: &[StoredCombo]) -> Result<(), &'static str> {
    for record in records.iter().filter(|record| record.enabled) {
        let view = combo_view(record)?;
        resolve_nested_combo_targets(
            &record.id,
            &record.tenant_id,
            &record.protocol,
            &view.targets,
            records,
        )?;
    }
    Ok(())
}

fn provider_audit_snapshot(record: &StoredProvider) -> serde_json::Value {
    serde_json::json!({
        "id": record.id,
        "tenant_id": record.tenant_id,
        "provider": record.provider,
        "protocol": record.protocol,
        "node_id": record.node_id,
        "enabled": record.enabled,
        "revision": record.updated_at.to_string(),
        "has_encrypted_record": !record.credential_ciphertext.is_empty()
    })
}

fn provider_oauth_audit_snapshot(
    provider_id: &str,
    oauth_provider: &str,
    generation: i64,
    expires_at_unix: i64,
) -> serde_json::Value {
    serde_json::json!({
        "provider_id": provider_id,
        "oauth_provider": oauth_provider,
        "generation": generation.to_string(),
        "expires_at_unix": (expires_at_unix > 0).then_some(expires_at_unix as u64),
        "has_access_token": true,
        "has_refresh_token": true
    })
}

fn route_pin_view(record: StoredRoutePin) -> RoutePinView {
    RoutePinView {
        provider_id: record.provider_id,
        model: record.model,
        revision: record.revision.to_string(),
    }
}

fn validate_runtime_settings_input(input: &RuntimeSettingsInput) -> Result<(), &'static str> {
    if !input.quota_preflight_threshold_percent.is_finite()
        || !(0.0..=100.0).contains(&input.quota_preflight_threshold_percent)
    {
        return Err("invalid runtime settings");
    }
    validate_connection_cooldown_profile(&input.oauth_connection_cooldown)?;
    validate_connection_cooldown_profile(&input.apikey_connection_cooldown)?;
    breaker_profile(&input.oauth_provider_breaker)?;
    breaker_profile(&input.apikey_provider_breaker)?;
    Ok(())
}

fn validate_connection_cooldown_profile(
    profile: &ConnectionCooldownProfileSettings,
) -> Result<(), &'static str> {
    if profile.base_cooldown_ms > 300_000 || profile.max_backoff_steps > 16 {
        return Err("invalid connection cooldown profile");
    }
    Ok(())
}

fn connection_cooldown_profile(
    settings: &ConnectionCooldownProfileSettings,
) -> Result<ConnectionCooldownProfile, &'static str> {
    validate_connection_cooldown_profile(settings)?;
    Ok(ConnectionCooldownProfile {
        base_cooldown_ms: settings.base_cooldown_ms,
        use_upstream_retry_hints: settings.use_upstream_retry_hints,
        max_backoff_steps: settings.max_backoff_steps,
    })
}

fn cooldown_profile_settings(
    profile: ConnectionCooldownProfile,
) -> ConnectionCooldownProfileSettings {
    ConnectionCooldownProfileSettings {
        base_cooldown_ms: profile.base_cooldown_ms,
        use_upstream_retry_hints: profile.use_upstream_retry_hints,
        max_backoff_steps: profile.max_backoff_steps,
    }
}

fn breaker_profile(
    settings: &ProviderBreakerProfileSettings,
) -> Result<CircuitProfile, &'static str> {
    if !(1..=1_000).contains(&settings.failure_threshold)
        || !(1..=settings.failure_threshold).contains(&settings.degradation_threshold)
        || !(1_000..=86_400_000).contains(&settings.reset_timeout_ms)
    {
        return Err("invalid provider breaker configuration");
    }
    Ok(CircuitProfile {
        failure_threshold: settings.failure_threshold,
        degradation_threshold: settings.degradation_threshold,
        reset_timeout_ms: settings.reset_timeout_ms,
    })
}

fn stored_breaker_profile(record: &StoredBreakerOverride) -> Result<CircuitProfile, &'static str> {
    breaker_profile(&ProviderBreakerProfileSettings {
        failure_threshold: u64::try_from(record.failure_threshold)
            .map_err(|_| "invalid provider breaker override")?,
        degradation_threshold: u64::try_from(record.degradation_threshold)
            .map_err(|_| "invalid provider breaker override")?,
        reset_timeout_ms: u64::try_from(record.reset_timeout_ms)
            .map_err(|_| "invalid provider breaker override")?,
    })
    .map_err(|_| "invalid provider breaker override")
}

fn breaker_profile_settings(profile: CircuitProfile) -> ProviderBreakerProfileSettings {
    ProviderBreakerProfileSettings {
        failure_threshold: profile.failure_threshold,
        degradation_threshold: profile.degradation_threshold,
        reset_timeout_ms: profile.reset_timeout_ms,
    }
}

fn runtime_settings_view(
    record: &StoredRuntimeSettings,
) -> Result<RuntimeSettingsView, &'static str> {
    let oauth_connection_cooldown = ConnectionCooldownProfileSettings {
        base_cooldown_ms: u64::try_from(record.oauth_cooldown_base_ms)
            .map_err(|_| "invalid runtime settings record")?,
        use_upstream_retry_hints: record.oauth_cooldown_retry_hints,
        max_backoff_steps: u32::try_from(record.oauth_cooldown_max_backoff_steps)
            .map_err(|_| "invalid runtime settings record")?,
    };
    let apikey_connection_cooldown = ConnectionCooldownProfileSettings {
        base_cooldown_ms: u64::try_from(record.apikey_cooldown_base_ms)
            .map_err(|_| "invalid runtime settings record")?,
        use_upstream_retry_hints: record.apikey_cooldown_retry_hints,
        max_backoff_steps: u32::try_from(record.apikey_cooldown_max_backoff_steps)
            .map_err(|_| "invalid runtime settings record")?,
    };
    let oauth_provider_breaker = ProviderBreakerProfileSettings {
        failure_threshold: u64::try_from(record.oauth_breaker_failure_threshold)
            .map_err(|_| "invalid runtime settings record")?,
        degradation_threshold: u64::try_from(record.oauth_breaker_degradation_threshold)
            .map_err(|_| "invalid runtime settings record")?,
        reset_timeout_ms: u64::try_from(record.oauth_breaker_reset_timeout_ms)
            .map_err(|_| "invalid runtime settings record")?,
    };
    let apikey_provider_breaker = ProviderBreakerProfileSettings {
        failure_threshold: u64::try_from(record.apikey_breaker_failure_threshold)
            .map_err(|_| "invalid runtime settings record")?,
        degradation_threshold: u64::try_from(record.apikey_breaker_degradation_threshold)
            .map_err(|_| "invalid runtime settings record")?,
        reset_timeout_ms: u64::try_from(record.apikey_breaker_reset_timeout_ms)
            .map_err(|_| "invalid runtime settings record")?,
    };
    if !(0..=1_000_000).contains(&record.quota_preflight_threshold_ppm)
        || record.revision < 0
        || validate_connection_cooldown_profile(&oauth_connection_cooldown).is_err()
        || validate_connection_cooldown_profile(&apikey_connection_cooldown).is_err()
        || breaker_profile(&oauth_provider_breaker).is_err()
        || breaker_profile(&apikey_provider_breaker).is_err()
    {
        return Err("invalid runtime settings record");
    }
    Ok(RuntimeSettingsView {
        quota_preflight_enabled: record.quota_preflight_enabled,
        quota_preflight_threshold_percent: record.quota_preflight_threshold_ppm as f64 / 10_000.0,
        oauth_connection_cooldown,
        apikey_connection_cooldown,
        oauth_provider_breaker,
        apikey_provider_breaker,
        revision: record.revision.to_string(),
    })
}

fn validate_quota_input(input: &ProviderQuotaInput) -> Result<(), &'static str> {
    if input.session.is_none() && input.weekly.is_none() && !input.limit_reached {
        return Err("provider quota requires a window or exhausted state");
    }
    if !(1..=86_400).contains(&input.ttl_seconds) {
        return Err("provider quota TTL must be 1-86400 seconds");
    }
    for window in [&input.session, &input.weekly].into_iter().flatten() {
        if !window.remaining_percent.is_finite()
            || !(0.0..=100.0).contains(&window.remaining_percent)
            || window
                .reset_at_unix_ms
                .is_some_and(|value| value > i64::MAX as u64)
        {
            return Err("invalid provider quota window");
        }
    }
    Ok(())
}

fn validate_stored_quota(record: &StoredProviderQuota) -> Result<(), &'static str> {
    validate_id(&record.provider_id)?;
    if !matches!(record.session_remaining_ppm, -1..=1_000_000)
        || !matches!(record.weekly_remaining_ppm, -1..=1_000_000)
        || record.session_reset_unix_ms < 0
        || record.weekly_reset_unix_ms < 0
        || record.observed_at_unix_ms < 0
        || record.expires_at_unix_ms <= record.observed_at_unix_ms
        || record.revision < 0
    {
        return Err("invalid provider quota record");
    }
    Ok(())
}

fn validate_stored_model_quota(record: &StoredProviderModelQuota) -> Result<(), &'static str> {
    validate_diagnostic_model(&record.model_id)?;
    validate_stored_quota(&StoredProviderQuota {
        provider_id: record.provider_id.clone(),
        session_remaining_ppm: record.session_remaining_ppm,
        session_reset_unix_ms: record.session_reset_unix_ms,
        weekly_remaining_ppm: record.weekly_remaining_ppm,
        weekly_reset_unix_ms: record.weekly_reset_unix_ms,
        limit_reached: record.limit_reached,
        observed_at_unix_ms: record.observed_at_unix_ms,
        expires_at_unix_ms: record.expires_at_unix_ms,
        revision: record.revision,
    })
}

fn quota_remaining_ppm(window: Option<&QuotaWindowInput>) -> i64 {
    window.map_or(-1, |window| {
        (window.remaining_percent * 10_000.0).round() as i64
    })
}

fn quota_reset_ms(window: Option<&QuotaWindowInput>) -> Result<i64, &'static str> {
    window
        .and_then(|window| window.reset_at_unix_ms)
        .map(i64::try_from)
        .transpose()
        .map_err(|_| "provider quota reset is out of range")
        .map(|value| value.unwrap_or(0))
}

fn quota_window_view(remaining_ppm: i64, reset_at_unix_ms: i64) -> Option<QuotaWindowView> {
    (remaining_ppm >= 0).then_some(QuotaWindowView {
        remaining_percent: remaining_ppm as f64 / 10_000.0,
        reset_at_unix_ms: (reset_at_unix_ms > 0).then_some(reset_at_unix_ms as u64),
    })
}

fn quota_view(record: &StoredProviderQuota) -> Result<ProviderQuotaView, &'static str> {
    validate_stored_quota(record)?;
    Ok(ProviderQuotaView {
        provider_id: record.provider_id.clone(),
        models: Vec::new(),
        session: quota_window_view(record.session_remaining_ppm, record.session_reset_unix_ms),
        weekly: quota_window_view(record.weekly_remaining_ppm, record.weekly_reset_unix_ms),
        limit_reached: record.limit_reached,
        observed_at_unix_ms: record.observed_at_unix_ms as u64,
        expires_at_unix_ms: record.expires_at_unix_ms as u64,
        revision: record.revision.to_string(),
    })
}

fn model_quota_view(
    record: &StoredProviderModelQuota,
) -> Result<ProviderModelQuotaView, &'static str> {
    validate_stored_model_quota(record)?;
    Ok(ProviderModelQuotaView {
        model_id: record.model_id.clone(),
        session: quota_window_view(record.session_remaining_ppm, record.session_reset_unix_ms),
        weekly: quota_window_view(record.weekly_remaining_ppm, record.weekly_reset_unix_ms),
        limit_reached: record.limit_reached,
        observed_at_unix_ms: record.observed_at_unix_ms as u64,
        expires_at_unix_ms: record.expires_at_unix_ms as u64,
        revision: record.revision.to_string(),
    })
}

fn quota_refresh_view(
    provider_id: &str,
    refreshed: bool,
    category: &str,
    quota: Option<ProviderQuotaView>,
) -> ProviderQuotaRefreshView {
    ProviderQuotaRefreshView {
        provider_id: provider_id.to_owned(),
        refreshed,
        category: category.to_owned(),
        quota,
    }
}

fn automatic_quota_record(
    provider_id: &str,
    snapshot: crate::provider_quota::Snapshot,
    observed_at_unix_ms: i64,
    ttl_ms: i64,
) -> Result<StoredProviderQuota, &'static str> {
    let ppm = |window: Option<crate::provider_quota::Window>| {
        window.map_or(-1, |window| {
            (window.remaining_percent * 10_000.0).round() as i64
        })
    };
    let reset = |window: Option<crate::provider_quota::Window>| {
        window
            .and_then(|window| window.reset_at_unix_ms)
            .map(i64::try_from)
            .transpose()
            .map_err(|_| "provider quota reset is out of range")
            .map(|value| value.unwrap_or(0))
    };
    let record = StoredProviderQuota {
        provider_id: provider_id.to_owned(),
        session_remaining_ppm: ppm(snapshot.session),
        session_reset_unix_ms: reset(snapshot.session)?,
        weekly_remaining_ppm: ppm(snapshot.weekly),
        weekly_reset_unix_ms: reset(snapshot.weekly)?,
        limit_reached: snapshot.limit_reached,
        observed_at_unix_ms,
        expires_at_unix_ms: observed_at_unix_ms
            .checked_add(ttl_ms)
            .ok_or("provider quota TTL is out of range")?,
        revision: revision()?,
    };
    validate_stored_quota(&record)?;
    Ok(record)
}

fn automatic_model_quota_record(
    provider_id: &str,
    model_id: &str,
    snapshot: crate::provider_quota::Snapshot,
    observed_at_unix_ms: i64,
    ttl_ms: i64,
) -> Result<StoredProviderModelQuota, &'static str> {
    let aggregate = automatic_quota_record(provider_id, snapshot, observed_at_unix_ms, ttl_ms)?;
    let record = StoredProviderModelQuota {
        provider_id: aggregate.provider_id,
        model_id: model_id.to_owned(),
        session_remaining_ppm: aggregate.session_remaining_ppm,
        session_reset_unix_ms: aggregate.session_reset_unix_ms,
        weekly_remaining_ppm: aggregate.weekly_remaining_ppm,
        weekly_reset_unix_ms: aggregate.weekly_reset_unix_ms,
        limit_reached: aggregate.limit_reached,
        observed_at_unix_ms: aggregate.observed_at_unix_ms,
        expires_at_unix_ms: aggregate.expires_at_unix_ms,
        revision: aggregate.revision,
    };
    validate_stored_model_quota(&record)?;
    Ok(record)
}

fn stored_policy(record: &StoredClientKey) -> Result<StoredPolicy, &'static str> {
    let decoded = hex::decode(&record.key_hash).map_err(|_| "invalid client key hash")?;
    let key_hash: [u8; 32] = decoded.try_into().map_err(|_| "invalid client key hash")?;
    let view = client_view(record)?;
    let (_, model_matching) = crate::model_permissions::decode(&record.allowed_models_json)?;
    validate_scope_list(&view.scopes)?;
    validate_endpoint_list(&view.allowed_endpoints)?;
    model_matching.validate(&view.allowed_models)?;
    model_matching.validate(&view.blocked_models)?;
    for id in &view.allowed_provider_ids {
        validate_id(id)?;
    }
    Ok(StoredPolicy {
        model_matching,
        id: record.id.clone(),
        name: record.label.clone(),
        tenant_id: record.tenant_id.clone(),
        model_id_format: view.model_id_format,
        model_access_restricted: view.model_access_mode == "restricted",
        allowed_combos: view.allowed_combos,
        key_hash,
        enabled: record.enabled,
        expires_at_unix: view.expires_at_unix,
        access_schedule: view.access_schedule,
        scopes: view.scopes,
        allowed_models: view.allowed_models,
        allowed_endpoints: view.allowed_endpoints,
        blocked_models: view.blocked_models,
        allowed_provider_ids: view.allowed_provider_ids,
        max_concurrent_requests: optional_usize(record.max_concurrent, 65_535)?,
        max_requests_per_minute: optional_usize(record.max_rpm, 10_000)?,
        max_requests_per_day: optional_usize(record.max_rpd, 10_000_000)?,
        usage_quota: {
            let quota = crate::native_usage::NativeQuota {
                max_tokens_per_minute: record.max_tokens_per_minute,
                max_tokens_per_day: record.max_tokens_per_day,
                max_monthly_microusd: record.max_monthly_microusd,
                reservation_tokens: record.reservation_tokens,
                reservation_microusd: record.reservation_microusd,
            }
            .validate()?;
            quota.enabled().then_some(quota)
        },
    })
}

fn validate_client_lists(
    input: &ClientKeyInput,
    matching: crate::model_permissions::ModelMatching,
) -> Result<(), &'static str> {
    if let Some(Some(grants)) = &input.allowed_combos {
        crate::policy::validate_combo_grants(grants)?;
    }
    validate_scope_list(&input.scopes)?;
    validate_endpoint_list(&input.allowed_endpoints)?;
    matching.validate(&input.allowed_models)?;
    matching.validate(&input.blocked_models)?;
    if input.allowed_provider_ids.len() > 128 {
        return Err("too many allowed provider identifiers");
    }
    for id in &input.allowed_provider_ids {
        validate_id(id)?;
    }
    for list in [
        &input.scopes,
        &input.allowed_endpoints,
        &input.allowed_models,
        &input.blocked_models,
        &input.allowed_provider_ids,
    ] {
        if list
            .iter()
            .enumerate()
            .any(|(index, value)| list[..index].contains(value))
        {
            return Err("client key policy contains duplicate entries");
        }
    }
    Ok(())
}

// Preserve an omitted field on PUT, but allow explicit null to restore model-based access.
fn present_combo_grants<'de, D>(deserializer: D) -> Result<Option<Option<Vec<String>>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<Vec<String>>::deserialize(deserializer).map(Some)
}

fn decode_combo_grants(raw: &str) -> Result<Option<Vec<String>>, &'static str> {
    let grants: Option<Vec<String>> =
        serde_json::from_str(raw).map_err(|_| "invalid combo grants")?;
    if let Some(grants) = &grants {
        crate::policy::validate_combo_grants(grants)?;
    }
    Ok(grants)
}

// Legacy lists always restrict access, including stale records marked "all".
// An explicitly restricted empty list denies every model.
fn effective_model_access_mode(value: &str, has_models: bool) -> Result<&str, &'static str> {
    match value {
        "all" | "restricted" if has_models => Ok("restricted"),
        "all" | "restricted" => Ok(value),
        _ => Err("client key model access mode must be all or restricted"),
    }
}

fn validate_model_id_format(value: &str) -> Result<&str, &'static str> {
    match value {
        "prefixed" | "flat" => Ok(value),
        _ => Err("client key model ID format must be prefixed or flat"),
    }
}

fn parse_reset_minutes(value: &str) -> Result<i64, &'static str> {
    let (hour, minute) = value
        .split_once(':')
        .ok_or("invalid token limit reset time")?;
    if hour.len() != 2 || minute.len() != 2 {
        return Err("invalid token limit reset time");
    }
    let hour: i64 = hour.parse().map_err(|_| "invalid token limit reset time")?;
    let minute: i64 = minute
        .parse()
        .map_err(|_| "invalid token limit reset time")?;
    if !(0..24).contains(&hour) || !(0..60).contains(&minute) {
        return Err("invalid token limit reset time");
    }
    Ok(hour * 60 + minute)
}

fn token_limit_id(key: &str, model: &str, interval: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"redrouter-model-limit\0");
    digest.update(key.as_bytes());
    digest.update([0]);
    digest.update(model.as_bytes());
    digest.update([0]);
    digest.update(interval.as_bytes());
    format!("mtl_{}", hex::encode(&digest.finalize()[..12]))
}

fn next_token_window(start_ms: i64, interval: &str) -> Result<i64, &'static str> {
    let start = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(start_ms) * 1_000_000)
        .map_err(|_| "invalid token limit window")?;
    let next = match interval {
        "daily" => start.checked_add(time::Duration::days(1)),
        "weekly" => start.checked_add(time::Duration::days(7)),
        "monthly" => {
            let date = start.date();
            let (year, month) = if date.month() == time::Month::December {
                (date.year() + 1, time::Month::January)
            } else {
                (date.year(), date.month().next())
            };
            time::Date::from_calendar_date(year, month, 1)
                .ok()
                .map(|date| date.with_time(start.time()).assume_utc())
        }
        _ => None,
    }
    .ok_or("invalid token limit window")?;
    i64::try_from(next.unix_timestamp_nanos() / 1_000_000).map_err(|_| "invalid token limit window")
}

fn encode_access_schedule(value: Option<&AccessScheduleConfig>) -> Result<String, &'static str> {
    let Some(schedule) = value else {
        return Ok(String::new());
    };
    schedule.validate()?;
    serde_json::to_string(schedule).map_err(|_| "invalid client key access schedule")
}

fn decode_access_schedule(value: &str) -> Result<Option<AccessScheduleConfig>, &'static str> {
    if value.is_empty() {
        return Ok(None);
    }
    let schedule = serde_json::from_str::<AccessScheduleConfig>(value)
        .map_err(|_| "invalid client key access schedule")?;
    schedule.validate()?;
    Ok(Some(schedule))
}

fn validate_scope_list(values: &[String]) -> Result<(), &'static str> {
    if values.len() > 20
        || values.iter().any(|value| {
            !matches!(
                value.as_str(),
                "inference:*" | "inference:chat" | "inference:embeddings" | "inference:rerank"
            )
        })
    {
        return Err("invalid client key scopes");
    }
    Ok(())
}

fn validate_endpoint_list(values: &[String]) -> Result<(), &'static str> {
    if values.len() > 20
        || values
            .iter()
            .any(|value| !matches!(value.as_str(), "chat" | "embeddings" | "rerank"))
    {
        return Err("invalid client key endpoint grants");
    }
    Ok(())
}

fn validate_label(value: &str) -> Result<(), &'static str> {
    if value.trim().is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err("invalid client key label");
    }
    Ok(())
}

fn validate_tenant_slug(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 64
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        })
    {
        return Err("invalid tenant slug");
    }
    Ok(())
}

fn validate_tenant_name(value: &str) -> Result<(), &'static str> {
    if value.trim().is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err("invalid tenant name");
    }
    Ok(())
}

fn validate_actor(value: &str) -> Result<(), &'static str> {
    if value.is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err("invalid authenticated actor");
    }
    Ok(())
}

fn validate_bound_subject(value: &str) -> Result<(), &'static str> {
    if !value.starts_with("oidc:")
        || value.len() <= "oidc:".len()
        || value.len() > 512
        || value.chars().any(char::is_control)
    {
        return Err("invalid identity subject");
    }
    Ok(())
}

fn validate_identity_role(value: &str) -> Result<(), &'static str> {
    if !matches!(value, "admin" | "tenant-admin" | "issuer") {
        return Err("invalid identity role");
    }
    Ok(())
}

fn validate_combo(input: &ComboInput) -> Result<(), &'static str> {
    let protocol = ProviderProtocol::parse(&input.protocol)?;
    if !matches!(
        input.strategy.as_str(),
        "priority"
            | "auto"
            | "round-robin"
            | "weighted"
            | "random"
            | "least-used"
            | "p2c"
            | "fill-first"
            | "strict-random"
            | "cost-optimized"
            | "context-optimized"
            | "cache-optimized"
            | "context-relay"
            | "fusion"
            | "pipeline"
            | "reset-aware"
            | "reset-window"
            | "headroom"
            | "quota-weighted"
            | "lkgp"
    ) {
        return Err("unsupported combo strategy");
    }
    match (input.strategy.as_str(), input.auto.as_ref()) {
        ("auto", Some(config)) => {
            let weights = [
                config.weights.quota,
                config.weights.cost,
                config.weights.context,
                config.weights.load,
            ];
            if weights
                .iter()
                .any(|weight| !weight.is_finite() || !(0.0..=1.0).contains(weight))
                || weights.iter().sum::<f64>() <= 0.0
            {
                return Err("invalid auto strategy weights");
            }
        }
        ("auto", None) | (_, None) => {}
        (_, Some(_)) => return Err("auto configuration requires the auto strategy"),
    }
    match (input.strategy.as_str(), input.context_relay.as_ref()) {
        ("context-relay", Some(config)) => {
            if !config.handoff_threshold.is_finite()
                || !(0.5..=0.94).contains(&config.handoff_threshold)
                || config.handoff_model.len() > 200
                || config.handoff_model.chars().any(char::is_control)
                || config.handoff_providers.len() > 10
                || config.handoff_providers.iter().any(|provider| {
                    provider.is_empty()
                        || provider.len() > 100
                        || provider.chars().any(char::is_control)
                })
                || !(5..=100).contains(&config.max_messages_for_summary)
                || !matches!(config.relay_mode.as_str(), "standard" | "schema-locked")
            {
                return Err("invalid context relay configuration");
            }
        }
        ("context-relay", None) | (_, None) => {}
        (_, Some(_)) => {
            return Err("context relay configuration requires the context-relay strategy")
        }
    }
    match (input.strategy.as_str(), input.fusion.as_ref()) {
        ("fusion", Some(config)) => {
            if config.judge_model.len() > 256
                || config.judge_model.chars().any(char::is_control)
                || !(1..=8).contains(&config.min_panel)
                || !(100..=30_000).contains(&config.straggler_grace_ms)
                || !(1_000..=120_000).contains(&config.panel_timeout_ms)
                || config.straggler_grace_ms >= config.panel_timeout_ms
            {
                return Err("invalid fusion configuration");
            }
            if !config.judge_model.is_empty()
                && !input.targets.iter().any(|target| {
                    target.model == config.judge_model
                        || format!("{}/{}", target.provider_id, target.model) == config.judge_model
                })
            {
                return Err("fusion judge must be one of the combo targets");
            }
        }
        ("fusion", None) | (_, None) => {}
        (_, Some(_)) => return Err("fusion configuration requires the fusion strategy"),
    }
    match (input.strategy.as_str(), input.pipeline.as_ref()) {
        ("pipeline", Some(config)) => {
            if config.max_retries > 10 || config.retry_delay_ms > 60_000 {
                return Err("invalid pipeline configuration");
            }
        }
        ("pipeline", None) | (_, None) => {}
        (_, Some(_)) => return Err("pipeline configuration requires the pipeline strategy"),
    }
    if matches!(
        input.strategy.as_str(),
        "context-relay" | "fusion" | "pipeline"
    ) && matches!(
        protocol,
        ProviderProtocol::OpenAiEmbeddings | ProviderProtocol::CohereRerank
    ) {
        return Err("strategy requires a conversational protocol");
    }
    if input.targets.is_empty() || input.targets.len() > 8 {
        return Err("combo targets must contain 1-8 entries");
    }
    for target in &input.targets {
        if target.is_combo_reference() {
            let combo_id = target
                .combo_reference()
                .ok_or("invalid nested combo reference")?;
            validate_id(combo_id)?;
            if !target.provider_id.is_empty()
                || !target.model.is_empty()
                || target.prompt.is_some()
                || target.weight.is_some()
                || target.input_cost_per_million.is_some()
                || target.output_cost_per_million.is_some()
                || target.context_window_tokens.is_some()
            {
                return Err("invalid nested combo reference");
            }
            if input.strategy == "weighted" {
                return Err("weighted combos cannot contain nested combo references");
            }
            continue;
        }
        if target.kind.is_some() || target.combo_id.is_some() {
            return Err("invalid nested combo reference");
        }
        validate_id(&target.provider_id)?;
        if target.model.is_empty()
            || target.model.len() > 256
            || target.model.chars().any(char::is_control)
            || (matches!(
                protocol,
                ProviderProtocol::Gemini
                    | ProviderProtocol::Antigravity
                    | ProviderProtocol::OpenAiToAntigravity
            ) && !crate::valid_gemini_model(&target.model))
        {
            return Err("invalid combo target model");
        }
        if target.prompt.as_ref().is_some_and(|prompt| {
            prompt.is_empty() || prompt.len() > 20_000 || prompt.contains('\0')
        }) {
            return Err("invalid combo target prompt");
        }
        match (input.strategy.as_str(), target.weight) {
            ("weighted", Some(1..=100)) => {}
            ("weighted", _) => return Err("weighted combo targets require weights"),
            (_, None) => {}
            (_, Some(_)) => return Err("combo target weights require the weighted strategy"),
        }
        for cost in [
            target.input_cost_per_million,
            target.output_cost_per_million,
        ]
        .into_iter()
        .flatten()
        {
            if !cost.is_finite() || !(0.0..=1_000_000.0).contains(&cost) {
                return Err("invalid combo target cost metadata");
            }
        }
        if target
            .context_window_tokens
            .is_some_and(|value| !(1..=10_000_000).contains(&value))
        {
            return Err("invalid combo target context metadata");
        }
        if input.strategy == "cost-optimized"
            && (target.input_cost_per_million.is_none() || target.output_cost_per_million.is_none())
        {
            return Err("cost-optimized targets require input and output costs");
        }
        if input.strategy == "context-optimized" && target.context_window_tokens.is_none() {
            return Err("context-optimized targets require context windows");
        }
    }
    if input.strategy == "weighted"
        && input
            .targets
            .iter()
            .filter_map(|target| target.weight)
            .sum::<u32>()
            != 100
    {
        return Err("weighted combo target weights must total 100");
    }
    if input.targets.iter().enumerate().any(|(index, target)| {
        input.targets[..index].iter().any(|other| {
            if let Some(combo_id) = target.combo_reference() {
                other.combo_reference() == Some(combo_id)
            } else {
                !other.is_combo_reference()
                    && other.provider_id == target.provider_id
                    && other.model == target.model
            }
        })
    }) {
        return Err("combo contains duplicate targets");
    }
    Ok(())
}

fn normalize_context_relay_config(input: &mut ComboInput) {
    let Some(config) = input.context_relay.as_mut() else {
        return;
    };
    config.handoff_model = config.handoff_model.trim().to_owned();
    let mut providers = Vec::new();
    for provider in &config.handoff_providers {
        let provider = provider.trim().to_ascii_lowercase();
        if !provider.is_empty() && !providers.contains(&provider) {
            providers.push(provider);
        }
    }
    config.handoff_providers = providers;
}

fn normalize_fusion_config(input: &mut ComboInput) {
    if let Some(config) = input.fusion.as_mut() {
        config.judge_model = config.judge_model.trim().to_owned();
    }
}

fn normalize_pipeline_config(input: &mut ComboInput) {
    for target in &mut input.targets {
        if let Some(prompt) = target.prompt.as_mut() {
            *prompt = prompt.trim().to_owned();
        }
    }
}

fn enrich_combo_metadata(
    input: &mut ComboInput,
    providers: &[StoredProvider],
    catalog: &crate::catalog::ModelCatalog,
) -> Result<(), &'static str> {
    for target in &mut input.targets {
        if target.is_combo_reference() {
            continue;
        }
        let Some(provider) = providers
            .iter()
            .find(|provider| provider.id == target.provider_id)
        else {
            continue;
        };
        let Some(metadata) = catalog.model(&provider.provider, &target.model)? else {
            continue;
        };
        if let Some(cost) = metadata.cost {
            target.input_cost_per_million = target.input_cost_per_million.or(cost.input);
            target.output_cost_per_million = target.output_cost_per_million.or(cost.output);
        }
        if let Some(limit) = metadata.limit {
            target.context_window_tokens = target.context_window_tokens.or(limit.context);
        }
    }
    Ok(())
}

fn json_list(values: &[String]) -> Result<String, &'static str> {
    serde_json::to_string(values).map_err(|_| "cannot encode client key policy")
}

fn parse_list(value: &str) -> Result<Vec<String>, &'static str> {
    if value.len() > 256 * 1024 {
        return Err("invalid client key policy");
    }
    serde_json::from_str(value).map_err(|_| "invalid client key policy")
}

fn optional_limit(value: Option<u64>, maximum: u64) -> Result<i64, &'static str> {
    value
        .map(|value| {
            if value == 0 || value > maximum {
                return Err("invalid client key limit");
            }
            i64::try_from(value).map_err(|_| "invalid client key limit")
        })
        .transpose()
        .map(|value| value.unwrap_or(0))
}

fn optional_usd_micros(value: Option<f64>) -> Result<i64, &'static str> {
    value
        .map(|value| {
            let micros = value * 1_000_000.0;
            if !micros.is_finite() || value <= 0.0 || value > 1_000_000.0 {
                return Err("invalid client spend limit");
            }
            Ok(micros.ceil() as i64)
        })
        .transpose()
        .map(|value| value.unwrap_or(0))
}

fn optional_usize(value: i64, maximum: usize) -> Result<Option<usize>, &'static str> {
    if value == 0 {
        return Ok(None);
    }
    usize::try_from(value)
        .ok()
        .filter(|value| (1..=maximum).contains(value))
        .map(Some)
        .ok_or("invalid client key limit")
}

fn positive_u64(value: i64) -> Result<Option<u64>, &'static str> {
    match value {
        0 => Ok(None),
        value if value > 0 => Ok(Some(value as u64)),
        _ => Err("invalid client key limit"),
    }
}

fn positive_micros_usd(value: i64) -> Result<Option<f64>, &'static str> {
    match value {
        0 => Ok(None),
        value if value > 0 => Ok(Some(value as f64 / 1_000_000.0)),
        _ => Err("invalid client spend limit"),
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

pub(crate) fn valid_provider_priority(value: i64) -> bool {
    (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&value)
}

pub(crate) fn validate_provider(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("invalid provider name");
    }
    Ok(())
}

pub(crate) fn validate_provider_label(value: &str) -> Result<(), &'static str> {
    // Match the legacy Zod/HTML limit (UTF-16 units), not UTF-8 bytes.
    if value.is_empty() || value.encode_utf16().count() > 200 || value.chars().any(char::is_control)
    {
        return Err("provider connection label must be 1-200 characters");
    }
    Ok(())
}

fn validate_provider_account_email(value: &str) -> Result<(), &'static str> {
    if value.len() > 320 || value.chars().any(char::is_control) {
        return Err("provider account email is invalid");
    }
    Ok(())
}

fn validate_diagnostic_model(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 256
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err("provider diagnostic model is invalid");
    }
    Ok(())
}

fn local_endpoint(value: &str) -> bool {
    reqwest::Url::parse(value)
        .ok()
        .and_then(|url| match url.host()? {
            url::Host::Ipv4(ip) => Some(ip.is_loopback()),
            url::Host::Ipv6(ip) => Some(ip.is_loopback()),
            url::Host::Domain(_) => Some(false),
        })
        .unwrap_or(false)
}

fn oauth_rotation_group(provider: &str) -> Result<&'static str, &'static str> {
    match provider {
        "codex" => Ok("openai-auth0"),
        "claude" => Ok("anthropic-oauth"),
        "agy" => Ok("google-antigravity-oauth"),
        "github" => Ok("github-copilot-oauth"),
        "xai-oauth" => Ok("xai-oauth"),
        "openference" => Ok("openference-oauth"),
        _ => Err("unsupported OAuth provider"),
    }
}

fn oauth_refresh_view(
    provider_id: &str,
    ok: bool,
    category: &'static str,
    upstream_status: Option<u16>,
    generation: i64,
    expires_at_unix: i64,
) -> ProviderOAuthRefreshView {
    ProviderOAuthRefreshView {
        provider_id: provider_id.to_owned(),
        ok,
        category,
        upstream_status,
        generation: generation.to_string(),
        expires_at_unix: (expires_at_unix > 0).then_some(expires_at_unix as u64),
    }
}

fn validate_oauth_token(value: &str) -> Result<String, OAuthExchangeFailure> {
    if !(1..=8192).contains(&value.len()) || value.chars().any(char::is_control) {
        return Err(OAuthExchangeFailure::Transient {
            category: "invalid_response",
            status: None,
        });
    }
    Ok(value.to_owned())
}

fn sanitize_auth_file_name(value: &str) -> String {
    let mut output = String::with_capacity(value.len().min(128));
    let mut pending_dash = false;
    for character in value.trim().chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '@') {
            if pending_dash && !output.is_empty() {
                output.push('-');
            }
            pending_dash = false;
            output.push(character);
        } else if character == '-' {
            if !output.is_empty() {
                pending_dash = true;
            }
        } else if !output.is_empty() {
            pending_dash = true;
        }
        if output.len() >= 128 {
            break;
        }
    }
    if output.is_empty() {
        "account".to_owned()
    } else {
        output
    }
}

pub(crate) fn parse_codex_auth(raw: serde_json::Value) -> Result<ParsedCodexAuth, &'static str> {
    let document = raw.as_object().ok_or("invalid Codex auth file")?;
    if document
        .get("auth_mode")
        .is_some_and(|value| !value.is_null() && value.as_str() != Some("chatgpt"))
    {
        return Err("invalid Codex auth mode");
    }
    let tokens = document
        .get("tokens")
        .and_then(serde_json::Value::as_object)
        .ok_or("Codex auth tokens are missing")?;
    let id_token =
        json_non_empty_string(tokens.get("id_token")).ok_or("Codex id token is missing")?;
    let access_token =
        json_non_empty_string(tokens.get("access_token")).ok_or("Codex access token is missing")?;
    let refresh_token = json_non_empty_string(tokens.get("refresh_token"))
        .ok_or("Codex refresh token is missing")?;
    for token in [id_token, access_token, refresh_token] {
        if token.len() > 8192 || token.chars().any(char::is_control) {
            return Err("Codex auth token is invalid");
        }
    }
    let id_claims =
        decode_unverified_jwt_payload(id_token).ok_or("Codex id token payload is invalid")?;
    let access_claims = decode_unverified_jwt_payload(access_token);
    let auth_claims = id_claims
        .get("https://api.openai.com/auth")
        .and_then(serde_json::Value::as_object);
    let account_id = json_non_empty_string(tokens.get("account_id"))
        .or_else(|| {
            auth_claims.and_then(|claims| json_non_empty_string(claims.get("chatgpt_account_id")))
        })
        .or_else(|| auth_claims.and_then(|claims| json_non_empty_string(claims.get("account_id"))))
        .ok_or("Codex account identifier is missing")?;
    if account_id.len() > 512 || account_id.chars().any(char::is_control) {
        return Err("Codex account identifier is invalid");
    }
    let user_id = auth_claims
        .and_then(|claims| json_non_empty_string(claims.get("chatgpt_user_id")))
        .or_else(|| auth_claims.and_then(|claims| json_non_empty_string(claims.get("user_id"))))
        .or_else(|| json_non_empty_string(id_claims.get("sub")))
        .map(str::to_owned);
    let email = json_non_empty_string(id_claims.get("email")).map(str::to_owned);
    let expires_at_unix = access_claims
        .as_ref()
        .and_then(|claims| claims.get("exp"))
        .and_then(serde_json::Value::as_u64)
        .or_else(|| id_claims.get("exp").and_then(serde_json::Value::as_u64))
        .ok_or("Codex token expiry is missing")?;
    Ok(ParsedCodexAuth {
        access_token: Zeroizing::new(access_token.to_owned()),
        refresh_token: Zeroizing::new(refresh_token.to_owned()),
        session_metadata: Zeroizing::new(serde_json::json!({"id_token": id_token}).to_string()),
        account_id: account_id.to_owned(),
        user_id,
        email,
        expires_at_unix,
    })
}

pub(crate) fn parse_claude_auth(raw: serde_json::Value) -> Result<ParsedClaudeAuth, &'static str> {
    let document = raw.as_object().ok_or("invalid Claude auth file")?;
    let oauth = document
        .get("claudeAiOauth")
        .and_then(serde_json::Value::as_object)
        .ok_or("Claude OAuth credentials are missing")?;
    let access_token =
        json_non_empty_string(oauth.get("accessToken")).ok_or("Claude access token is missing")?;
    let refresh_token = json_non_empty_string(oauth.get("refreshToken"))
        .ok_or("Claude refresh token is missing")?;
    for token in [access_token, refresh_token] {
        if token.len() > 8192 || token.chars().any(char::is_control) {
            return Err("Claude auth token is invalid");
        }
    }
    let expires_at_unix = parse_claude_expiry(oauth.get("expiresAt"))?;
    let scopes = match oauth.get("scopes") {
        None => Vec::new(),
        Some(serde_json::Value::Array(values)) if values.len() <= 64 => values
            .iter()
            .map(|value| {
                let value =
                    json_non_empty_string(Some(value)).ok_or("Claude OAuth scope is invalid")?;
                if value.len() > 256 || value.chars().any(char::is_control) {
                    return Err("Claude OAuth scope is invalid");
                }
                Ok(value.to_owned())
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err("Claude OAuth scopes are invalid"),
    };
    let optional_metadata = |name: &str| -> Result<Option<String>, &'static str> {
        let Some(value) = oauth.get(name) else {
            return Ok(None);
        };
        if value.is_null() {
            return Ok(None);
        }
        let value = json_non_empty_string(Some(value)).ok_or("Claude OAuth metadata is invalid")?;
        if value.len() > 256 || value.chars().any(char::is_control) {
            return Err("Claude OAuth metadata is invalid");
        }
        Ok(Some(value.to_owned()))
    };
    let session_metadata = serde_json::json!({
        "scopes": scopes,
        "subscriptionType": optional_metadata("subscriptionType")?,
        "rateLimitTier": optional_metadata("rateLimitTier")?,
    });
    Ok(ParsedClaudeAuth {
        access_token: Zeroizing::new(access_token.to_owned()),
        refresh_token: Zeroizing::new(refresh_token.to_owned()),
        session_metadata: Zeroizing::new(session_metadata.to_string()),
        expires_at_unix,
    })
}

pub(crate) fn parse_agy_auth(raw: serde_json::Value) -> Result<ParsedAgyAuth, &'static str> {
    let document = raw.as_object().ok_or("invalid Antigravity auth file")?;
    let token = document
        .get("token")
        .and_then(serde_json::Value::as_object)
        .unwrap_or(document);
    let access_token = json_non_empty_string(token.get("access_token"))
        .ok_or("Antigravity access token is missing")?;
    let refresh_token = json_non_empty_string(token.get("refresh_token"))
        .ok_or("Antigravity refresh token is missing")?;
    for value in [access_token, refresh_token] {
        if value.len() > 8192 || value.chars().any(char::is_control) {
            return Err("Antigravity auth token is invalid");
        }
    }
    let expiry = token
        .get("expiry")
        .or_else(|| token.get("expires_at"))
        .or_else(|| token.get("expiry_date"))
        .ok_or("Antigravity token expiry is missing")?;
    let expires_at_unix = if let Some(raw) = expiry.as_u64() {
        if raw >= 10_000_000_000 {
            raw / 1_000
        } else {
            raw
        }
    } else if let Some(raw) = expiry.as_str() {
        let raw = raw.trim();
        if let Ok(value) = raw.parse::<u64>() {
            if value >= 10_000_000_000 {
                value / 1_000
            } else {
                value
            }
        } else {
            let parsed =
                time::OffsetDateTime::parse(raw, &time::format_description::well_known::Rfc3339)
                    .map_err(|_| "Antigravity token expiry is invalid")?;
            u64::try_from(parsed.unix_timestamp())
                .map_err(|_| "Antigravity token expiry is invalid")?
        }
    } else {
        return Err("Antigravity token expiry is invalid");
    };
    if !(1..=32_503_680_000).contains(&expires_at_unix) {
        return Err("Antigravity token expiry is invalid");
    }
    let optional_text =
        |value: Option<&serde_json::Value>| -> Result<Option<String>, &'static str> {
            match value {
                None | Some(serde_json::Value::Null) => Ok(None),
                Some(value) => {
                    let value = json_non_empty_string(Some(value))
                        .ok_or("Antigravity token metadata is invalid")?;
                    if value.len() > 256 || value.chars().any(char::is_control) {
                        return Err("Antigravity token metadata is invalid");
                    }
                    Ok(Some(value.to_owned()))
                }
            }
        };
    let token_type = optional_text(token.get("token_type"))?.unwrap_or_else(|| "Bearer".to_owned());
    if !token_type.eq_ignore_ascii_case("bearer") {
        return Err("Antigravity token type is unsupported");
    }
    let auth_method = optional_text(
        document
            .get("auth_method")
            .or_else(|| token.get("auth_method")),
    )?;
    Ok(ParsedAgyAuth {
        access_token: Zeroizing::new(access_token.to_owned()),
        refresh_token: Zeroizing::new(refresh_token.to_owned()),
        session_metadata: Zeroizing::new(
            serde_json::json!({"tokenType":token_type,"authMethod":auth_method}).to_string(),
        ),
        expires_at_unix,
    })
}

fn parse_claude_expiry(value: Option<&serde_json::Value>) -> Result<u64, &'static str> {
    let value = value.ok_or("Claude token expiry is missing")?;
    let raw = if let Some(value) = value.as_u64() {
        value
    } else if let Some(value) = value.as_str() {
        let value = value.trim();
        if let Ok(epoch) = value.parse::<u64>() {
            epoch
        } else {
            let parsed =
                time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
                    .map_err(|_| "Claude token expiry is invalid")?;
            u64::try_from(parsed.unix_timestamp()).map_err(|_| "Claude token expiry is invalid")?
        }
    } else {
        return Err("Claude token expiry is invalid");
    };
    // Claude Code writes epoch milliseconds. Accept seconds too for exported
    // compatibility records, but reject values outside the useful timestamp range.
    let seconds = if raw >= 10_000_000_000 {
        raw / 1_000
    } else {
        raw
    };
    if !(1..=32_503_680_000).contains(&seconds) {
        return Err("Claude token expiry is invalid");
    }
    Ok(seconds)
}

fn unsafe_auth_zip_entry_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    name.is_empty()
        || name.contains("..")
        || name.contains('\\')
        || name.chars().any(char::is_control)
        || name.starts_with('/')
        || bytes.get(1) == Some(&b':')
}

fn extract_auth_zip(body: Vec<u8>) -> Result<Vec<AuthZipEntry>, AuthZipError> {
    let reader = Cursor::new(body);
    let mut archive = zip::ZipArchive::new(reader).map_err(|_| AuthZipError::InvalidArchive)?;
    if archive.len() > AUTH_ZIP_MAX_ENTRIES {
        return Err(AuthZipError::TooManyEntries);
    }

    let mut entries = Vec::new();
    let mut total_bytes = 0usize;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|_| AuthZipError::InvalidArchive)?;
        let raw_name = file
            .name()
            .map_err(|_| AuthZipError::UnsafeEntry)?
            .into_owned();
        if !raw_name.to_ascii_lowercase().ends_with(".json") {
            continue;
        }
        if entries.len() >= AUTH_ZIP_MAX_JSON_FILES {
            return Err(AuthZipError::TooManyJsonFiles);
        }
        if unsafe_auth_zip_entry_name(&raw_name) || file.enclosed_name().is_none() {
            return Err(AuthZipError::UnsafeEntry);
        }
        if !file.is_file() {
            return Err(AuthZipError::UnsupportedEntry);
        }
        if file.encrypted() {
            return Err(AuthZipError::EncryptedEntry);
        }
        if file.size() > AUTH_ZIP_MAX_FILE_BYTES as u64 {
            return Err(AuthZipError::FileTooLarge);
        }
        let declared_size = usize::try_from(file.size()).map_err(|_| AuthZipError::FileTooLarge)?;
        if total_bytes
            .checked_add(declared_size)
            .is_none_or(|size| size > AUTH_ZIP_MAX_TOTAL_BYTES)
        {
            return Err(AuthZipError::TotalTooLarge);
        }
        let base_name = FilePath::new(&raw_name)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or(AuthZipError::UnsafeEntry)?
            .to_owned();
        let mut content = Vec::with_capacity(declared_size.min(AUTH_ZIP_MAX_FILE_BYTES));
        file.by_ref()
            .take((AUTH_ZIP_MAX_FILE_BYTES + 1) as u64)
            .read_to_end(&mut content)
            .map_err(|_| AuthZipError::InvalidArchive)?;
        if content.len() > AUTH_ZIP_MAX_FILE_BYTES {
            return Err(AuthZipError::FileTooLarge);
        }
        total_bytes = total_bytes
            .checked_add(content.len())
            .filter(|size| *size <= AUTH_ZIP_MAX_TOTAL_BYTES)
            .ok_or(AuthZipError::TotalTooLarge)?;
        match serde_json::from_slice(&content) {
            Ok(json) => entries.push(AuthZipEntry {
                name: base_name,
                json: Some(json),
                parse_error: None,
            }),
            Err(_) => entries.push(AuthZipEntry {
                name: base_name,
                json: None,
                parse_error: Some("Not valid JSON"),
            }),
        }
    }
    if entries.is_empty() {
        return Err(AuthZipError::NoJsonFiles);
    }
    Ok(entries)
}

fn json_non_empty_string(value: Option<&serde_json::Value>) -> Option<&str> {
    value
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn claude_session_identity(metadata: &str) -> Result<(String, String), &'static str> {
    if metadata.len() > 64 * 1024 {
        return Err("invalid Claude session metadata");
    }
    let metadata: serde_json::Value =
        serde_json::from_str(metadata).map_err(|_| "invalid Claude session metadata")?;
    let device = json_non_empty_string(metadata.get("cliUserID"))
        .ok_or("Claude device identity is missing")?;
    let account = json_non_empty_string(metadata.get("accountUUID"))
        .ok_or("Claude account identity is missing")?;
    if device.len() != 64 || !device.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid Claude device identity");
    }
    if !valid_uuid(account) {
        return Err("invalid Claude account identity");
    }
    Ok((device.to_ascii_lowercase(), account.to_ascii_lowercase()))
}

fn validate_claude_session_metadata(metadata: &str) -> Result<(), &'static str> {
    claude_session_identity(metadata).map(|_| ())
}

fn browser_oauth_token_field(
    value: &serde_json::Value,
    field: &str,
) -> Result<String, &'static str> {
    json_non_empty_string(value.get(field))
        .filter(|token| token.len() <= 8192 && !token.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or("provider OAuth response is invalid")
}

fn decode_unverified_jwt_payload(
    token: &str,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let mut parts = token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let _signature = parts.next()?;
    if parts.next().is_some() || payload.len() > 16 * 1024 {
        return None;
    }
    let decoded = URL_SAFE_NO_PAD.decode(payload.as_bytes()).ok()?;
    if decoded.len() > 16 * 1024 {
        return None;
    }
    serde_json::from_slice::<serde_json::Value>(&decoded)
        .ok()?
        .as_object()
        .cloned()
}

fn codex_import_provider_id(tenant_id: &str, account_id: &str, user_id: Option<&str>) -> String {
    let mut digest = Sha256::new();
    digest.update(tenant_id.as_bytes());
    digest.update([0]);
    digest.update(account_id.as_bytes());
    digest.update([0]);
    digest.update(user_id.unwrap_or("").as_bytes());
    let suffix = hex::encode(digest.finalize());
    format!("codex-{}", &suffix[..24])
}

fn provider_import_id(provider: &str, tenant_id: &str, identity: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(tenant_id.as_bytes());
    digest.update([0]);
    digest.update(identity.as_bytes());
    let suffix = hex::encode(digest.finalize());
    format!("{provider}-{}", &suffix[..24])
}

fn oauth_token_field(
    value: &serde_json::Value,
    field: &str,
) -> Result<String, OAuthExchangeFailure> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .ok_or(OAuthExchangeFailure::Transient {
            category: "invalid_response",
            status: None,
        })
        .and_then(validate_oauth_token)
}

fn oauth_error_code(value: &serde_json::Value) -> String {
    let raw = value
        .get("error")
        .and_then(|error| {
            error.as_str().or_else(|| {
                error
                    .as_object()
                    .and_then(|object| object.get("code"))
                    .and_then(serde_json::Value::as_str)
            })
        })
        .or_else(|| value.get("code").and_then(serde_json::Value::as_str))
        .unwrap_or("oauth_error");
    let normalized = raw.trim().to_ascii_lowercase().replace(' ', "_");
    if !normalized.is_empty()
        && normalized.len() <= 64
        && normalized
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        normalized
    } else {
        "oauth_error".to_owned()
    }
}

fn oauth_terminal_error(provider: &str, status: u16, code: &str) -> bool {
    match provider {
        "codex" => {
            status == 401
                || matches!(
                    code,
                    "refresh_token_reused" | "invalid_grant" | "token_expired" | "invalid_token"
                )
        }
        "claude" => matches!(code, "invalid_grant" | "invalid_request"),
        "agy" => matches!(
            code,
            "invalid_grant" | "invalid_client" | "unauthorized_client"
        ),
        "github" => status == 401 || status == 403 || code == "invalid_token",
        "xai-oauth" => {
            status == 401
                || status == 403
                || matches!(
                    code,
                    "invalid_grant" | "invalid_client" | "unauthorized_client"
                )
        }
        "openference" => {
            status == 401 || matches!(code, "invalid_grant" | "token_expired" | "invalid_token")
        }
        _ => false,
    }
}

async fn read_bounded_response(
    response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, &'static str> {
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "invalid_response")?;
        if body.len().saturating_add(chunk.len()) > limit {
            return Err("response_too_large");
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

async fn bounded_json_response(request: reqwest::RequestBuilder) -> Option<serde_json::Value> {
    let response = request.send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = read_bounded_response(response, OAUTH_REFRESH_MAX_BODY_BYTES)
        .await
        .ok()?;
    serde_json::from_slice(&body).ok()
}

fn signature_text(digest: &mut Sha256, value: &str) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value.as_bytes());
}

fn signature_i64(digest: &mut Sha256, value: i64) {
    digest.update(value.to_be_bytes());
}

fn signature_bool(digest: &mut Sha256, value: bool) {
    digest.update([u8::from(value)]);
}

fn revision() -> Result<i64, &'static str> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is unavailable")?
        .as_nanos();
    i64::try_from(nanos).map_err(|_| "system clock is out of range")
}

fn unix_time_ms() -> Result<i64, &'static str> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is unavailable")?
        .as_millis();
    i64::try_from(millis).map_err(|_| "system clock is out of range")
}

fn context_relay_record_id(combo_id: &str, session_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"redrouter-context-relay-v1\0");
    digest.update(combo_id.as_bytes());
    digest.update(b"\0");
    digest.update(session_id.as_bytes());
    hex::encode(digest.finalize())
}

fn parse_context_relay_list(value: &str, maximum: usize) -> Result<Vec<String>, &'static str> {
    if value.len() > 16 * 1024 {
        return Err("invalid context relay handoff");
    }
    let values: Vec<String> =
        serde_json::from_str(value).map_err(|_| "invalid context relay handoff")?;
    if values.len() > maximum
        || values
            .iter()
            .any(|value| value.is_empty() || value.chars().count() > 240)
    {
        return Err("invalid context relay handoff");
    }
    Ok(values)
}

fn unix_time_seconds() -> Result<u64, &'static str> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is unavailable")
        .map(|duration| duration.as_secs())
}

fn random_token(bytes: usize) -> Result<String, &'static str> {
    let mut value = Zeroizing::new(vec![0u8; bytes]);
    getrandom::fill(value.as_mut()).map_err(|_| "cannot generate OIDC login state")?;
    Ok(URL_SAFE_NO_PAD.encode(value.as_slice()))
}

fn random_uuid_v4() -> Result<String, &'static str> {
    let mut value = [0_u8; 16];
    getrandom::fill(&mut value).map_err(|_| "cannot generate Claude session identity")?;
    value[6] = (value[6] & 0x0f) | 0x40;
    value[8] = (value[8] & 0x3f) | 0x80;
    let hex = hex::encode(value);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn unique_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let mut found = None;
    for header in headers.get_all(header::COOKIE) {
        let value = header.to_str().ok()?;
        if value.len() > 16 * 1024 {
            return None;
        }
        for pair in value.split(';') {
            let (candidate_name, candidate_value) = pair.trim().split_once('=')?;
            if candidate_name == name {
                if found.is_some() || candidate_value.is_empty() || candidate_value.len() > 8192 {
                    return None;
                }
                found = Some(candidate_value.to_owned());
            }
        }
    }
    found
}

fn cookie(
    name: &str,
    value: &str,
    max_age: u64,
    http_only: bool,
    secure: bool,
    same_site: &str,
) -> String {
    let mut cookie = format!("{name}={value}; Path=/; Max-Age={max_age}; SameSite={same_site}");
    if http_only {
        cookie.push_str("; HttpOnly");
    }
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

fn redirect_response(status: StatusCode, location: String, cookies: &[String]) -> Response {
    let Ok(location) = HeaderValue::from_str(&location) else {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, "Invalid redirect target");
    };
    let mut response = status.into_response();
    response.headers_mut().insert(header::LOCATION, location);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    for value in cookies {
        let Ok(value) = HeaderValue::from_str(value) else {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, "Invalid session cookie");
        };
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    response
}

fn derive_key(secret: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, &'static str> {
    let mut key = Zeroizing::new([0u8; 32]);
    let params = scrypt::Params::new(14, 8, 1, 32).map_err(|_| "invalid encryption parameters")?;
    scrypt::scrypt(secret.as_bytes(), salt, &params, key.as_mut())
        .map_err(|_| "could not derive storage encryption key")?;
    Ok(key)
}

pub(crate) fn encrypt(value: &str, id: &str, secret: &str) -> Result<String, &'static str> {
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

pub(crate) fn decrypt(
    stored: &str,
    id: &str,
    secret: &str,
) -> Result<Zeroizing<String>, &'static str> {
    let parts: Vec<_> = stored.split(':').collect();
    if parts.len() != 5 || parts[0] != "rr" || parts[1] != "v1" || stored.len() > 20_000 {
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

fn api_error_code(status: StatusCode, message: &'static str, code: &'static str) -> Response {
    (
        status,
        Json(serde_json::json!({"error":message,"code":code})),
    )
        .into_response()
}

fn local_login_origin(headers: &HeaderMap) -> Option<(String, bool)> {
    if headers.get_all(header::ORIGIN).iter().count() != 1
        || headers.get_all("sec-fetch-site").iter().count() > 1
        || headers
            .get("sec-fetch-site")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value != "same-origin")
    {
        return None;
    }
    let raw = headers.get(header::ORIGIN)?.to_str().ok()?;
    let parsed = reqwest::Url::parse(raw).ok()?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    let origin = parsed.origin().ascii_serialization();
    if origin == "null" {
        return None;
    }
    Some((origin, parsed.scheme() == "https"))
}

pub async fn auth_config(State(state): State<ProxyState>) -> Response {
    let (control_plane_enabled, oidc_browser_login) = match &state.control_plane {
        Some(control) => (true, control.oidc_browser_enabled().await),
        None => (false, false),
    };
    let mut response = Json(serde_json::json!({
        "backend":"rust",
        "control_plane_enabled":control_plane_enabled,
        "oidc_browser_login":oidc_browser_login,
        "password_login":control_plane_enabled
    }))
    .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );
    response
}

pub async fn local_admin_login(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Json(input): Json<LocalAdminLoginInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some((origin, secure)) = local_login_origin(&headers) else {
        return api_error(StatusCode::FORBIDDEN, "Invalid dashboard login origin");
    };
    let admin_key = Zeroizing::new(input.admin_key);
    let session = match control
        .create_local_admin_session(admin_key.as_str(), origin, secure)
        .await
    {
        Ok(session) => session,
        Err(_) => return api_error(StatusCode::UNAUTHORIZED, "Invalid admin authentication"),
    };
    let mut response = StatusCode::NO_CONTENT.into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );
    for value in [
        cookie(
            ADMIN_SESSION_COOKIE,
            &session.session_cookie,
            ADMIN_SESSION_SECONDS,
            true,
            session.secure,
            "Strict",
        ),
        cookie(
            ADMIN_CSRF_COOKIE,
            &session.csrf,
            ADMIN_SESSION_SECONDS,
            false,
            session.secure,
            "Strict",
        ),
    ] {
        let Ok(value) = HeaderValue::from_str(&value) else {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, "Invalid session cookie");
        };
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    response
}

pub async fn oidc_login(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Query(query): Query<OidcLoginQuery>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let test = match query.test.as_deref() {
        None => false,
        Some("1") => true,
        _ => return api_error(StatusCode::BAD_REQUEST, "Invalid OIDC login request"),
    };
    if test && !control.authorized(&headers).await {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin authentication");
    }
    match control.start_oidc_login(test).await {
        Ok(login) => redirect_response(
            StatusCode::TEMPORARY_REDIRECT,
            login.location,
            &[cookie(
                OIDC_FLOW_COOKIE,
                &login.flow_cookie,
                OIDC_FLOW_SECONDS,
                true,
                login.secure,
                "Lax",
            )],
        ),
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "OIDC browser login unavailable",
        ),
    }
}

pub async fn oidc_callback(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Query(query): Query<OidcCallbackQuery>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let secure = control
        .0
        .oidc_browser
        .read()
        .await
        .as_ref()
        .is_some_and(|browser| browser.secure_cookies());
    let clear_flow = cookie(OIDC_FLOW_COOKIE, "", 0, true, secure, "Lax");
    if query.error.is_some() {
        let mut response = api_error(StatusCode::UNAUTHORIZED, "OIDC authorization was denied");
        if let Ok(value) = HeaderValue::from_str(&clear_flow) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
        return response;
    }
    let (Some(code), Some(returned_state), Some(flow_cookie)) = (
        query.code.as_deref(),
        query.state.as_deref(),
        unique_cookie(&headers, OIDC_FLOW_COOKIE),
    ) else {
        let mut response = api_error(
            StatusCode::BAD_REQUEST,
            "Invalid OIDC authorization response",
        );
        if let Ok(value) = HeaderValue::from_str(&clear_flow) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
        return response;
    };
    match control
        .complete_oidc_login(&flow_cookie, code, returned_state)
        .await
    {
        Ok(BrowserCallback::Test { location, secure }) => redirect_response(
            StatusCode::SEE_OTHER,
            location,
            &[cookie(OIDC_FLOW_COOKIE, "", 0, true, secure, "Lax")],
        ),
        Ok(BrowserCallback::Session {
            location,
            session_cookie,
            csrf,
            secure,
        }) => redirect_response(
            StatusCode::SEE_OTHER,
            location,
            &[
                cookie(OIDC_FLOW_COOKIE, "", 0, true, secure, "Lax"),
                cookie(
                    ADMIN_SESSION_COOKIE,
                    &session_cookie,
                    ADMIN_SESSION_SECONDS,
                    true,
                    secure,
                    "Strict",
                ),
                cookie(
                    ADMIN_CSRF_COOKIE,
                    &csrf,
                    ADMIN_SESSION_SECONDS,
                    false,
                    secure,
                    "Strict",
                ),
            ],
        ),
        Err(_) => {
            let mut response = api_error(StatusCode::UNAUTHORIZED, "OIDC authentication failed");
            if let Ok(value) = HeaderValue::from_str(&clear_flow) {
                response.headers_mut().append(header::SET_COOKIE, value);
            }
            response
        }
    }
}

pub async fn oidc_logout(State(state): State<ProxyState>) -> Response {
    let secure = match &state.control_plane {
        Some(control) => control
            .0
            .oidc_browser
            .read()
            .await
            .as_ref()
            .is_some_and(|browser| browser.secure_cookies()),
        None => false,
    };
    let mut response = StatusCode::NO_CONTENT.into_response();
    for value in [
        cookie(ADMIN_SESSION_COOKIE, "", 0, true, secure, "Strict"),
        cookie(ADMIN_CSRF_COOKIE, "", 0, false, secure, "Strict"),
        cookie(OIDC_FLOW_COOKIE, "", 0, true, secure, "Lax"),
    ] {
        if let Ok(value) = HeaderValue::from_str(&value) {
            response.headers_mut().append(header::SET_COOKIE, value);
        }
    }
    response
}

pub async fn get_oidc(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    if !control.authorized(&headers).await {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin authentication");
    }
    Json(serde_json::json!({"oidc":control.oidc_view().await})).into_response()
}

pub async fn discover_oidc(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Json(input): Json<OidcDiscoveryInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    if !control.authorized(&headers).await {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin authentication");
    }
    match crate::oidc::discover(&input.issuer, control.0.allow_private).await {
        Ok(discovery) => Json(serde_json::json!({"discovery":discovery})).into_response(),
        Err(error)
            if error.contains("request")
                || error.contains("DNS")
                || error.contains("unavailable")
                || error.contains("timed out") =>
        {
            api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "OIDC discovery unavailable",
            )
        }
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid OIDC discovery document"),
    }
}

pub async fn put_oidc(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Json(input): Json<OidcInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    if !control.authorized(&headers).await {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin authentication");
    }
    match control.configure_oidc(input).await {
        Ok(oidc) => Json(serde_json::json!({"oidc":oidc})).into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "OIDC storage or JWKS unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid OIDC configuration"),
    }
}

pub async fn delete_oidc(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    if !control.authorized(&headers).await {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin authentication");
    }
    match control.delete_oidc().await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(_) => api_error(StatusCode::SERVICE_UNAVAILABLE, "OIDC storage unavailable"),
    }
}

pub async fn list(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control.views(scope.tenant_id.as_deref()).await {
        Ok(providers) => Json(serde_json::json!({"providers":providers})).into_response(),
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider storage unavailable",
        ),
    }
}

pub async fn list_client_keys(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control.client_views(scope.tenant_id.as_deref()).await {
        Ok(keys) => Json(serde_json::json!({"client_keys":keys})).into_response(),
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Client key storage unavailable",
        ),
    }
}

pub async fn list_shared_budgets(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .shared_budget_views(scope.tenant_id.as_deref())
        .await
    {
        Ok(budgets) => Json(serde_json::json!({"budgets":budgets})).into_response(),
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Shared budget storage unavailable",
        ),
    }
}

pub async fn create_shared_budget(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Json(input): Json<crate::shared_budget::BudgetInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .configure_shared_budget_as(None, input, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(budget) => (
            StatusCode::CREATED,
            Json(serde_json::json!({"budget":budget})),
        )
            .into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Shared budget storage unavailable",
        ),
        Err(error) => api_error(StatusCode::BAD_REQUEST, error),
    }
}

pub async fn put_shared_budget(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<crate::shared_budget::BudgetInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .configure_shared_budget_as(Some(&id), input, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(budget) => Json(serde_json::json!({"budget":budget})).into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Shared budget storage unavailable",
        ),
        Err(error) => api_error(StatusCode::BAD_REQUEST, error),
    }
}

pub async fn delete_shared_budget(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .delete_shared_budget_as(&id, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => api_error(StatusCode::NOT_FOUND, "Shared budget not found"),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Shared budget storage unavailable",
        ),
        Err(error) => api_error(StatusCode::BAD_REQUEST, error),
    }
}

pub async fn token_limits(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Query(query): Query<TokenLimitQuery>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    let Some(key) = query.api_key_id.as_deref() else {
        return api_error(StatusCode::BAD_REQUEST, "apiKeyId query param is required");
    };
    match control
        .token_limit_views(key, scope.tenant_id.as_deref())
        .await
    {
        Ok(limits) => Json(serde_json::json!({"apiKeyId":key,"limits":limits})).into_response(),
        Err("client key not found") => api_error(StatusCode::NOT_FOUND, "Client key not found"),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Token limit storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid token limit query"),
    }
}

pub async fn put_token_limit(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Json(input): Json<TokenLimitInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .upsert_token_limit_as(input, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(limit) => Json(serde_json::json!({"success":true,"limit":limit})).into_response(),
        Err("client key not found") => api_error(StatusCode::NOT_FOUND, "Client key not found"),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Token limit storage unavailable",
        ),
        Err(error) => api_error(StatusCode::BAD_REQUEST, error),
    }
}

pub async fn delete_token_limit(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Query(query): Query<TokenLimitQuery>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    let Some(id) = query.id.as_deref() else {
        return api_error(StatusCode::BAD_REQUEST, "id query param is required");
    };
    match control
        .delete_token_limit_as(id, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(true) => Json(serde_json::json!({"success":true})).into_response(),
        Ok(false) => api_error(StatusCode::NOT_FOUND, "Token limit not found"),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Token limit storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid token limit identifier"),
    }
}

pub async fn usage_export_types(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    if control.management_scope(&headers).await.is_none() {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    Json(serde_json::json!({
        "types": [
            {
                "type": "webhook",
                "label": "Webhook (HTTPS POST, signed)",
                "description": "Sends each attributed usage event with a stable ID and Standard Webhooks HMAC signature.",
                "modes": ["instant", "window"],
                "fields": [
                    {"key":"url","labelFallback":"Webhook URL","type":"text","required":true,"placeholder":"https://billing.example.com/hooks/redrouter","helpFallback":"Public HTTPS only; credentials, query strings, redirects and private addresses are refused."},
                    {"key":"secret","labelFallback":"Signing secret","type":"password","required":true,"secret":true,"placeholder":"whsec_...","helpFallback":"Write-only and encrypted at rest. Used for webhook-signature HMAC-SHA256."}
                ]
            },
            {
                "type": "bigquery",
                "label": "Google BigQuery",
                "description": "Exports attributed token and spend reports from the usage ledger.",
                "modes": ["instant"],
                "fields": [
                    {"key":"projectId","labelFallback":"Project ID","type":"text","required":true},
                    {"key":"datasetId","labelFallback":"Dataset ID","type":"text","required":true},
                    {"key":"tableId","labelFallback":"Table ID","type":"text","required":true},
                    {"key":"serviceAccountJson","labelFallback":"Service account JSON","type":"textarea","required":true,"secret":true,"helpFallback":"Write-only; the credential is encrypted at rest."},
                    {"key":"batchSize","labelFallback":"Batch size","type":"number","placeholder":"500"},
                    {"key":"intervalSeconds","labelFallback":"Interval (seconds)","type":"number","placeholder":"10"}
                ]
            },
            {
                "type": "reddb",
                "label": "RedDB queue",
                "description": "Publishes attributed usage with the delivery ID as the queue DEDUP key.",
                "modes": ["instant", "window"],
                "fields": [
                    {"key":"url","labelFallback":"RedDB URL","type":"text","required":true,"placeholder":"http://127.0.0.1:5000","helpFallback":"Private addresses require RED_ROUTER_ALLOW_PRIVATE_UPSTREAM=1; cloud metadata is always refused."},
                    {"key":"queue","labelFallback":"Queue","type":"text","required":true,"placeholder":"usage_events","helpFallback":"Create it once with a DEDUP window, for example: CREATE QUEUE IF NOT EXISTS usage_events WITH DEDUP_WINDOW 1h"},
                    {"key":"token","labelFallback":"Token (optional)","type":"password","secret":true,"placeholder":"rdb_k_...","helpFallback":"Write-only and encrypted at rest."},
                    {"key":"tenant","labelFallback":"RedDB tenant (optional)","type":"text"}
                ]
            },
            {
                "type": "sqs",
                "label": "Amazon SQS",
                "description": "Publishes attributed usage through SendMessage; FIFO queues use the delivery ID for deduplication.",
                "modes": ["instant", "window"],
                "fields": [
                    {"key":"queueUrl","labelFallback":"Queue URL","type":"text","required":true,"placeholder":"https://sqs.us-east-1.amazonaws.com/123456789012/usage"},
                    {"key":"region","labelFallback":"Region","type":"text","placeholder":"Read from the AWS queue URL"},
                    {"key":"accessKeyId","labelFallback":"Access key ID","type":"text","required":true},
                    {"key":"secretAccessKey","labelFallback":"Secret access key","type":"password","required":true,"secret":true,"helpFallback":"Write-only and encrypted at rest; requires sqs:SendMessage."},
                    {"key":"sessionToken","labelFallback":"Session token (optional)","type":"password","secret":true,"helpFallback":"For temporary AWS credentials."}
                ]
            },
            {
                "type": "kafka",
                "label": "Kafka",
                "description": "Publishes attributed usage keyed by sink ID; the delivery ID is included as a record header for consumer deduplication.",
                "modes": ["instant", "window"],
                "fields": [
                    {"key":"brokers","labelFallback":"Brokers","type":"text","required":true,"placeholder":"broker1:9092, broker2:9092","helpFallback":"Every resolved bootstrap and metadata-discovered broker is checked by the egress policy."},
                    {"key":"topic","labelFallback":"Topic","type":"text","required":true,"placeholder":"redrouter.usage","helpFallback":"The topic must already exist."},
                    {"key":"clientId","labelFallback":"Client ID","type":"text","placeholder":"red-router"},
                    {"key":"ssl","labelFallback":"Connect over TLS","type":"boolean"},
                    {"key":"saslMechanism","labelFallback":"SASL","type":"select","options":[
                        {"value":"","labelFallback":"None"},
                        {"value":"plain","labelFallback":"PLAIN"},
                        {"value":"scram-sha-256","labelFallback":"SCRAM-SHA-256"},
                        {"value":"scram-sha-512","labelFallback":"SCRAM-SHA-512"}
                    ]},
                    {"key":"saslUsername","labelFallback":"SASL username","type":"text"},
                    {"key":"saslPassword","labelFallback":"SASL password","type":"password","secret":true,"helpFallback":"Write-only and encrypted at rest."}
                ]
            }
        ],
        "windowSizesSec": [300, 900, 1800, 3600]
    }))
    .into_response()
}

pub async fn list_usage_exports(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control.usage_export_views(scope.tenant_id.as_deref()).await {
        Ok(sinks) => Json(serde_json::json!({"sinks": sinks})).into_response(),
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Usage export storage unavailable",
        ),
    }
}

pub async fn create_usage_export(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Json(input): Json<UsageExportCreateInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .create_usage_export_as(input, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(sink) => (StatusCode::CREATED, Json(serde_json::json!({"sink": sink}))).into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Usage export storage unavailable",
        ),
        Err(_) => api_error(
            StatusCode::BAD_REQUEST,
            "Invalid usage export configuration",
        ),
    }
}

pub async fn get_usage_export(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control.usage_export_views(scope.tenant_id.as_deref()).await {
        Ok(sinks) => match sinks
            .into_iter()
            .find(|sink| sink.get("id").and_then(serde_json::Value::as_str) == Some(id.as_str()))
        {
            Some(sink) => Json(serde_json::json!({"sink": sink, "deliveries": []})).into_response(),
            None => api_error(StatusCode::NOT_FOUND, "Usage sink not found"),
        },
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Usage export storage unavailable",
        ),
    }
}

pub async fn update_usage_export(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<UsageExportUpdateInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .update_usage_export_as(&id, input, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(sink) => Json(serde_json::json!({"sink": sink})).into_response(),
        Err("usage export configuration not found") => {
            api_error(StatusCode::NOT_FOUND, "Usage sink not found")
        }
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Usage export storage unavailable",
        ),
        Err(_) => api_error(
            StatusCode::BAD_REQUEST,
            "Invalid usage export configuration",
        ),
    }
}

pub async fn delete_usage_export(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .delete_usage_export_as(&id, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(true) => Json(serde_json::json!({"deleted": true})).into_response(),
        Ok(false) => api_error(StatusCode::NOT_FOUND, "Usage sink not found"),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Usage export storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid usage export identifier"),
    }
}

pub async fn test_usage_export(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<UsageExportUpdateInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .test_usage_export_as(&id, input, scope.tenant_id.as_deref())
        .await
    {
        Ok(latency_ms) => Json(serde_json::json!({
            "valid": true,
            "error": null,
            "latencyMs": latency_ms,
            "probe": {"method":"POST","url":null,"status":200,"statusText":"OK","bytes":null,"durationMs":latency_ms,"error":null},
            "requests": []
        }))
        .into_response(),
        Err("usage export configuration not found") => {
            api_error(StatusCode::NOT_FOUND, "Usage sink not found")
        }
        Err(error) => Json(serde_json::json!({
            "valid": false,
            "error": error,
            "latencyMs": null,
            "probe": {"method":"POST","url":null,"status":null,"statusText":null,"bytes":null,"durationMs":null,"error":error},
            "requests": []
        }))
        .into_response(),
    }
}

pub async fn get_legacy_usage_report(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Query(query): Query<LegacyUsageQuery>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    let tenant = match (scope.tenant_id.as_deref(), query.tenant_id.as_deref()) {
        (Some(tenant), Some(requested)) if tenant != requested => {
            return api_error(StatusCode::BAD_REQUEST, "Invalid legacy usage query")
        }
        (Some(tenant), _) => Some(tenant),
        (None, requested) => requested,
    };
    if tenant.is_some_and(|value| validate_id(value).is_err()) {
        return api_error(StatusCode::BAD_REQUEST, "Invalid legacy usage query");
    }
    match crate::legacy_archive::usage_page(
        &control.0.database,
        tenant,
        query.key_id.as_deref(),
        query.cursor,
        query.limit.unwrap_or(50),
    )
    .await
    {
        Ok(page) => {
            let mut response = Json(serde_json::json!({"legacy_usage": page})).into_response();
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store, max-age=0"),
            );
            response
        }
        Err("invalid legacy usage query") => {
            api_error(StatusCode::BAD_REQUEST, "Invalid legacy usage query")
        }
        Err(_) => api_error(StatusCode::SERVICE_UNAVAILABLE, "Legacy usage unavailable"),
    }
}

pub async fn get_usage_report(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Query(query): Query<UsageReportQuery>,
) -> Response {
    const REPORT_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    let tenant_id = match (scope.tenant_id.as_deref(), query.tenant_id.as_deref()) {
        (Some(tenant), Some(requested)) if tenant != requested => {
            return api_error(StatusCode::BAD_REQUEST, "Invalid usage report query");
        }
        (Some(tenant), _) => Some(tenant),
        (None, requested) => requested,
    };
    let now = match unix_time_ms() {
        Ok(now) => now,
        Err(_) => {
            return api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Usage reporting unavailable",
            );
        }
    };
    let to_unix_ms = query.to_unix_ms.unwrap_or_else(|| now.saturating_add(1));
    let from_unix_ms = query
        .from_unix_ms
        .unwrap_or_else(|| to_unix_ms.saturating_sub(REPORT_WINDOW_MS));
    match control
        .native_usage_report(
            tenant_id,
            query.key_id.as_deref(),
            from_unix_ms,
            to_unix_ms,
            query.limit.unwrap_or(50),
            query.cursor.as_deref(),
        )
        .await
    {
        Ok(report) => {
            let mut response = Json(serde_json::json!({"usage":report})).into_response();
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store, max-age=0"),
            );
            response
        }
        Err("invalid usage report query") => {
            api_error(StatusCode::BAD_REQUEST, "Invalid usage report query")
        }
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Usage reporting unavailable",
        ),
    }
}

pub async fn maintain_usage(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    if scope.tenant_id.is_some() {
        return api_error(
            StatusCode::FORBIDDEN,
            "Global administrator access is required",
        );
    }
    match control.maintain_native_usage(Some(&scope.actor)).await {
        Ok(report) => {
            let mut response = Json(serde_json::json!({"maintenance":report})).into_response();
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store, max-age=0"),
            );
            response
        }
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Usage maintenance unavailable",
        ),
    }
}

pub async fn list_tenants(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    if control.authorized_admin_actor(&headers).await.is_none() {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    match control.tenant_views().await {
        Ok(tenants) => Json(serde_json::json!({"tenants":tenants})).into_response(),
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Tenant storage unavailable",
        ),
    }
}

pub async fn list_identity_bindings(
    State(state): State<ProxyState>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    if control.authorized_admin_actor(&headers).await.is_none() {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    match control.identity_binding_views().await {
        Ok(bindings) => Json(serde_json::json!({"identity_bindings":bindings})).into_response(),
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Identity binding storage unavailable",
        ),
    }
}

pub async fn list_audit_events(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Query(query): Query<AuditQuery>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .audit_event_views(scope.tenant_id.as_deref(), &query)
        .await
    {
        Ok((events, total)) => {
            let mut response = Json(events).into_response();
            if let Ok(value) = HeaderValue::from_str(&total.to_string()) {
                response.headers_mut().insert("x-total-count", value);
            }
            response
        }
        Err(error) if is_runtime_error(error) => {
            api_error(StatusCode::SERVICE_UNAVAILABLE, "Audit storage unavailable")
        }
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid audit query"),
    }
}

pub async fn issue_client_key(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Json(input): Json<ClientKeyIssueInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .issue_client_key_as(input, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok((client_key, secret)) => {
            let mut response = (
                StatusCode::CREATED,
                Json(serde_json::json!({
                    "client_key": client_key,
                    "key": secret.as_str(),
                    "warning": "Store this key securely; it will not be shown again."
                })),
            )
                .into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Client key storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid client key configuration"),
    }
}

pub async fn list_combos(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control.combo_views(scope.tenant_id.as_deref()).await {
        Ok(combos) => Json(serde_json::json!({"combos":combos})).into_response(),
        Err(_) => api_error(StatusCode::SERVICE_UNAVAILABLE, "Combo storage unavailable"),
    }
}

pub async fn list_model_catalog(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    if control.management_scope(&headers).await.is_none() {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    let (catalog, runtime) = control.model_catalog_snapshot().await;
    let response: Result<serde_json::Value, &'static str> = (|| {
        Ok(serde_json::json!({
            "manifest": catalog.manifest(),
            "providers": catalog.provider_summaries()?,
            "snapshot": runtime,
        }))
    })();
    match response {
        Ok(response) => Json(response).into_response(),
        Err(_) => api_error(StatusCode::SERVICE_UNAVAILABLE, "Model catalog unavailable"),
    }
}

pub async fn search_model_catalog(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Query(query): Query<crate::catalog::CatalogSearch>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Control plane is disabled");
    };
    if control.management_scope(&headers).await.is_none() {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    if query.validate().is_err() {
        return api_error(StatusCode::BAD_REQUEST, "Invalid catalog search");
    }
    let catalog = control.model_catalog().await;
    if query
        .snapshot
        .as_ref()
        .is_some_and(|snapshot| snapshot != &catalog.manifest().content_sha256)
    {
        return api_error(
            StatusCode::CONFLICT,
            "Catalog changed; reload the catalog and search again",
        );
    }
    static SEARCH_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
    let Ok(permit) = SEARCH_SLOTS.try_acquire() else {
        let mut response = api_error(
            StatusCode::TOO_MANY_REQUESTS,
            "Catalog search is busy; retry shortly",
        );
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
        return response;
    };
    // Keep the permit in the worker even if the HTTP client disconnects. Neither
    // repeated cancellation nor concurrent searches may exhaust the blocking pool.
    match tokio::task::spawn_blocking(move || {
        let _permit = permit;
        catalog.search(&query)
    })
    .await
    {
        Ok(Ok(page)) => Json(page).into_response(),
        _ => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Catalog search unavailable",
        ),
    }
}

pub async fn get_model_catalog_provider(
    State(state): State<ProxyState>,
    Path(provider): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    if control.management_scope(&headers).await.is_none() {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    let catalog = control.model_catalog().await;
    match catalog.provider(&provider) {
        Ok(Some(provider)) => Json(serde_json::json!({"provider":provider})).into_response(),
        Ok(None) => api_error(StatusCode::NOT_FOUND, "Catalog provider not found"),
        Err(_) => api_error(StatusCode::SERVICE_UNAVAILABLE, "Model catalog unavailable"),
    }
}

pub async fn refresh_model_catalog(
    State(state): State<ProxyState>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    if !control.authorized(&headers).await {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    match control.refresh_model_catalog().await {
        Ok(snapshot) => Json(serde_json::json!({"snapshot":snapshot})).into_response(),
        Err(error) if error.contains("request") || error.contains("timed out") => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "models.dev catalog refresh unavailable",
        ),
        Err(error) if error.contains("write") || error.contains("storage") => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Model catalog storage unavailable",
        ),
        Err(_) => api_error(
            StatusCode::BAD_GATEWAY,
            "models.dev returned an invalid catalog",
        ),
    }
}

pub async fn list_provider_health(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control.breaker_views(scope.tenant_id.as_deref()).await {
        Ok(breakers) => Json(serde_json::json!({"provider_health":breakers})).into_response(),
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider health storage unavailable",
        ),
    }
}

pub async fn get_runtime_settings(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    if control.authorized_admin_actor(&headers).await.is_none() {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    Json(serde_json::json!({"runtime_settings": control.runtime_settings_view().await}))
        .into_response()
}

pub async fn put_runtime_settings(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Json(input): Json<RuntimeSettingsInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(actor) = control.authorized_admin_actor(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control.configure_runtime_settings_as(input, &actor).await {
        Ok(settings) => Json(serde_json::json!({"runtime_settings": settings})).into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Runtime settings storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid runtime settings"),
    }
}

pub async fn list_provider_quotas(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control.quota_views(scope.tenant_id.as_deref()).await {
        Ok(quotas) => Json(serde_json::json!({"provider_quotas":quotas})).into_response(),
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider quota storage unavailable",
        ),
    }
}

pub async fn delete_provider_health(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .reset_breaker_as(&id, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider health storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid provider identifier"),
    }
}

pub async fn put_provider_health(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ProviderHealthInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .configure_breaker_as(&id, input, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(health) => Json(serde_json::json!({"provider_health":health})).into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider health storage unavailable",
        ),
        Err(_) => api_error(
            StatusCode::BAD_REQUEST,
            "Invalid provider health configuration",
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
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .configure_provider_as(&id, input, None, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(provider) => Json(serde_json::json!({"provider":provider})).into_response(),
        Err("provider is referenced by an enabled combo") => api_error(
            StatusCode::CONFLICT,
            "Provider is referenced by an enabled combo",
        ),
        Err("provider protocol is incompatible with an enabled combo") => api_error(
            StatusCode::CONFLICT,
            "Provider protocol is incompatible with an enabled combo",
        ),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider storage or runtime unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid provider configuration"),
    }
}

pub async fn authorize_provider_oauth(
    State(state): State<ProxyState>,
    Path(provider): Path<String>,
    headers: HeaderMap,
    Query(query): Query<ProviderOAuthAuthorizeQuery>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .start_provider_oauth_as(
            &provider,
            query.redirect_uri.as_deref(),
            &scope.actor,
            scope.tenant_id.as_deref(),
        )
        .await
    {
        Ok(view) => {
            let mut response = Json(view).into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(_) => api_error_code(
            StatusCode::BAD_REQUEST,
            "Invalid or unsupported provider OAuth authorization request",
            "invalid_oauth_flow",
        ),
    }
}

pub async fn exchange_provider_oauth(
    State(state): State<ProxyState>,
    Path(provider): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ProviderOAuthExchangeInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .finish_provider_oauth_as(&provider, input, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(imported) => {
            let mut response = Json(serde_json::json!({
                "success":true,
                "connection":{
                    "id":imported.connection.id,
                    "provider":imported.connection.provider,
                    "email":imported.connection.account_email,
                    "displayName":imported.connection.label,
                }
            }))
            .into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider storage or runtime unavailable",
        ),
        Err(error)
            if error.starts_with("invalid provider OAuth")
                || error == "unsupported browser OAuth provider"
                || error.ends_with("OAuth redirect URI") =>
        {
            api_error_code(
                StatusCode::BAD_REQUEST,
                "Invalid provider OAuth exchange",
                "invalid_oauth_flow",
            )
        }
        Err(_) => api_error_code(
            StatusCode::BAD_GATEWAY,
            "Provider OAuth token exchange failed",
            "oauth_exchange_failed",
        ),
    }
}

async fn extract_auth_zip_response(state: ProxyState, request: Request) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    if control.management_scope(request.headers()).await.is_none() {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    if request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|size| size > AUTH_ZIP_BODY_LIMIT_BYTES)
    {
        return api_error_code(
            StatusCode::PAYLOAD_TOO_LARGE,
            "ZIP file exceeds the 10 MB size limit",
            "file_too_large",
        );
    }
    let body = match to_bytes(request.into_body(), AUTH_ZIP_BODY_LIMIT_BYTES).await {
        Ok(body) => body.to_vec(),
        Err(_) => {
            return api_error_code(
                StatusCode::PAYLOAD_TOO_LARGE,
                "ZIP file exceeds the 10 MB size limit",
                "file_too_large",
            )
        }
    };
    match tokio::task::spawn_blocking(move || extract_auth_zip(body)).await {
        Ok(Ok(entries)) => {
            let mut response = Json(serde_json::json!({"entries":entries})).into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Ok(Err(error)) => {
            api_error_code(StatusCode::BAD_REQUEST, error.message(), "extract_failed")
        }
        Err(_) => api_error_code(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to extract ZIP",
            "extract_failed",
        ),
    }
}

pub async fn extract_codex_auth_zip(State(state): State<ProxyState>, request: Request) -> Response {
    extract_auth_zip_response(state, request).await
}

pub async fn extract_claude_auth_zip(
    State(state): State<ProxyState>,
    request: Request,
) -> Response {
    extract_auth_zip_response(state, request).await
}

pub async fn extract_agy_auth_zip(State(state): State<ProxyState>, request: Request) -> Response {
    extract_auth_zip_response(state, request).await
}

pub async fn import_codex_auth(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Json(input): Json<ProviderAuthImportInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .import_codex_auth_as(input, &scope.actor, scope.tenant_id.as_deref(), None)
        .await
    {
        Ok(imported) => {
            let mut response = Json(imported).into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err("Codex account already exists") => api_error_code(
            StatusCode::CONFLICT,
            "A Codex connection for this account already exists",
            "duplicate_account",
        ),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider storage or runtime unavailable",
        ),
        Err(_) => api_error_code(
            StatusCode::BAD_REQUEST,
            "Invalid Codex auth file",
            "invalid_auth_file",
        ),
    }
}

pub async fn import_codex_auth_bulk(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Json(input): Json<CodexAuthBulkImportInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    if input.entries.is_empty() || input.entries.len() > 50 {
        return api_error_code(
            StatusCode::BAD_REQUEST,
            "Codex bulk import requires 1-50 entries",
            "invalid_request",
        );
    }
    let total = input.entries.len();
    let mut success = 0usize;
    let mut errors = Vec::new();
    for (index, entry) in input.entries.into_iter().enumerate() {
        let display_name = entry
            .name
            .clone()
            .or_else(|| entry.email.clone())
            .unwrap_or_else(|| format!("entry {}", index + 1));
        let imported = control
            .import_codex_auth_as(
                ProviderAuthImportInput {
                    source: ProviderAuthImportSource::Json { json: entry.json },
                    name: entry.name,
                    email: entry.email,
                    overwrite_existing: input.overwrite_existing,
                },
                &scope.actor,
                scope.tenant_id.as_deref(),
                None,
            )
            .await;
        match imported {
            Ok(_) => success += 1,
            Err(error) => errors.push(serde_json::json!({
                "index": index,
                "name": display_name,
                "message": if error == "Codex account already exists" {
                    "Account already exists"
                } else if is_runtime_error(error) {
                    "Provider storage or runtime unavailable"
                } else {
                    "Invalid Codex auth file"
                },
            })),
        }
    }
    let mut response = Json(serde_json::json!({
        "success": success,
        "failed": total - success,
        "total": total,
        "errors": errors,
    }))
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub async fn import_claude_auth(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Json(input): Json<ProviderAuthImportInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .import_claude_auth_as(input, &scope.actor, scope.tenant_id.as_deref(), None)
        .await
    {
        Ok(imported) => {
            let mut response = Json(imported).into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err("Claude account already exists") => api_error_code(
            StatusCode::CONFLICT,
            "A Claude connection for this account already exists",
            "duplicate_account",
        ),
        Err("Claude account identity could not be verified") => api_error_code(
            StatusCode::CONFLICT,
            "Claude account identity could not be verified",
            "identity_unverified",
        ),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider storage or runtime unavailable",
        ),
        Err(_) => api_error_code(
            StatusCode::BAD_REQUEST,
            "Invalid Claude auth file",
            "invalid_auth_file",
        ),
    }
}

pub async fn import_agy_auth(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Json(input): Json<ProviderAuthImportInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .import_agy_auth_as(input, &scope.actor, scope.tenant_id.as_deref(), None)
        .await
    {
        Ok(imported) => {
            let mut response = Json(imported).into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err("Antigravity account already exists") => api_error_code(
            StatusCode::CONFLICT,
            "An Antigravity CLI connection for this account already exists",
            "duplicate_account",
        ),
        Err("Antigravity account identity could not be verified") => api_error_code(
            StatusCode::CONFLICT,
            "Antigravity account identity could not be verified",
            "identity_unverified",
        ),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider storage or runtime unavailable",
        ),
        Err(_) => api_error_code(
            StatusCode::BAD_REQUEST,
            "Invalid Antigravity auth file",
            "invalid_auth_file",
        ),
    }
}

pub async fn import_agy_auth_bulk(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Json(input): Json<AgyAuthBulkImportInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    if input.entries.is_empty() || input.entries.len() > 50 {
        return api_error_code(
            StatusCode::BAD_REQUEST,
            "Antigravity bulk import requires 1-50 entries",
            "invalid_request",
        );
    }
    let total = input.entries.len();
    let mut success = 0usize;
    let mut created = Vec::new();
    let mut errors = Vec::new();
    for (index, entry) in input.entries.into_iter().enumerate() {
        let display_name = entry
            .name
            .clone()
            .or_else(|| entry.email.clone())
            .unwrap_or_else(|| format!("entry {}", index + 1));
        match control
            .import_agy_auth_as(
                ProviderAuthImportInput {
                    source: ProviderAuthImportSource::Json { json: entry.json },
                    name: entry.name,
                    email: entry.email,
                    overwrite_existing: input.overwrite_existing,
                },
                &scope.actor,
                scope.tenant_id.as_deref(),
                None,
            )
            .await
        {
            Ok(imported) => {
                success += 1;
                created.push(imported.connection);
            }
            Err(error) => errors.push(serde_json::json!({
                "index":index,
                "name":display_name,
                "message":if error == "Antigravity account already exists" {
                    "Account already exists"
                } else if error == "Antigravity account identity could not be verified" {
                    "Account identity could not be verified"
                } else if is_runtime_error(error) {
                    "Provider storage or runtime unavailable"
                } else {
                    "Invalid Antigravity auth file"
                },
            })),
        }
    }
    let mut response = Json(serde_json::json!({
        "success":success,
        "failed":total-success,
        "total":total,
        "created":created,
        "errors":errors,
    }))
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn export_provider_auth_response(
    state: ProxyState,
    id: String,
    headers: HeaderMap,
    provider: &'static str,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .export_provider_auth_as(&id, provider, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(export) => {
            let disposition = match HeaderValue::from_str(&format!(
                "attachment; filename=\"{}\"",
                export.file_name
            )) {
                Ok(value) => value,
                Err(_) => {
                    return api_error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "Provider session export unavailable",
                    )
                }
            };
            let mut response = export.content.into_response();
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json; charset=utf-8"),
            );
            response
                .headers_mut()
                .insert(header::CONTENT_DISPOSITION, disposition);
            response.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store, max-age=0"),
            );
            response.headers_mut().insert(
                "x-content-type-options",
                HeaderValue::from_static("nosniff"),
            );
            response
        }
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider storage or runtime unavailable",
        ),
        Err(error)
            if error.contains("reauthentication")
                || error.contains("refresh is unavailable")
                || error.contains("session metadata") =>
        {
            api_error_code(
                StatusCode::CONFLICT,
                "Provider session must be refreshed or re-authenticated before export",
                "reauth_required",
            )
        }
        Err(error) if error.contains("not found") => api_error_code(
            StatusCode::NOT_FOUND,
            "Provider connection not found",
            "not_found",
        ),
        Err(_) => api_error_code(
            StatusCode::BAD_REQUEST,
            "Provider connection does not support this export",
            "invalid_provider",
        ),
    }
}

pub async fn export_codex_auth(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    export_provider_auth_response(state, id, headers, "codex").await
}

pub async fn export_claude_auth(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    export_provider_auth_response(state, id, headers, "claude").await
}

pub async fn import_claude_auth_bulk(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Json(input): Json<ClaudeAuthBulkImportInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    if input.entries.is_empty() || input.entries.len() > 50 {
        return api_error_code(
            StatusCode::BAD_REQUEST,
            "Claude bulk import requires 1-50 entries",
            "invalid_request",
        );
    }
    let total = input.entries.len();
    let mut success = 0usize;
    let mut errors = Vec::new();
    for (index, entry) in input.entries.into_iter().enumerate() {
        let display_name = entry
            .name
            .clone()
            .or_else(|| entry.email.clone())
            .unwrap_or_else(|| format!("entry {}", index + 1));
        let imported = control
            .import_claude_auth_as(
                ProviderAuthImportInput {
                    source: ProviderAuthImportSource::Json { json: entry.json },
                    name: entry.name,
                    email: entry.email,
                    overwrite_existing: input.overwrite_existing,
                },
                &scope.actor,
                scope.tenant_id.as_deref(),
                None,
            )
            .await;
        match imported {
            Ok(_) => success += 1,
            Err(error) => errors.push(serde_json::json!({
                "index": index,
                "name": display_name,
                "message": match error {
                    "Claude account already exists" => "Account already exists",
                    "Claude account identity could not be verified" => "Account identity could not be verified",
                    error if is_runtime_error(error) => "Provider storage or runtime unavailable",
                    _ => "Invalid Claude auth file",
                },
            })),
        }
    }
    let mut response = Json(serde_json::json!({
        "success": success,
        "failed": total - success,
        "total": total,
        "errors": errors,
    }))
    .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub async fn diagnose_provider(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ProviderDiagnosticInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .diagnose_provider_as(&id, input, scope.tenant_id.as_deref())
        .await
    {
        Ok(diagnostic) => Json(serde_json::json!({"diagnostic":diagnostic})).into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider diagnostic unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid provider diagnostic"),
    }
}

pub async fn rotate_provider_oauth(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ProviderOAuthRotationInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .rotate_provider_oauth_as(&id, input, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(provider) => Json(serde_json::json!({"provider":provider})).into_response(),
        Err("provider OAuth generation conflict") => api_error(
            StatusCode::CONFLICT,
            "Provider OAuth credential changed; reload before retrying",
        ),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider OAuth storage or runtime unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid provider OAuth rotation"),
    }
}

pub async fn refresh_provider_oauth(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .refresh_provider_oauth_as(&id, Some(&scope.actor), scope.tenant_id.as_deref())
        .await
    {
        Ok(refresh) => Json(serde_json::json!({"refresh":refresh})).into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider OAuth refresh unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid provider OAuth refresh"),
    }
}

pub async fn refresh_provider_oauth_compat(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    let (_, auth, oauth) = match control
        .provider_oauth_records(&id, scope.tenant_id.as_deref())
        .await
    {
        Ok(records) => records,
        Err(error) if error.contains("not found") => {
            return api_error(StatusCode::NOT_FOUND, "Connection not found")
        }
        Err(error) if is_runtime_error(error) => {
            return api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Provider OAuth refresh unavailable",
            )
        }
        Err(_) => {
            return api_error(
                StatusCode::BAD_REQUEST,
                "Only OAuth connections support manual token refresh",
            )
        }
    };
    let refreshed_at = match ::time::OffsetDateTime::now_utc()
        .format(&::time::format_description::well_known::Rfc3339)
    {
        Ok(value) => value,
        Err(_) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, "Token refresh failed"),
    };
    let expires_at = |value: i64| {
        (value > 0)
            .then(|| ::time::OffsetDateTime::from_unix_timestamp(value).ok())
            .flatten()
            .and_then(|value| {
                value
                    .format(&::time::format_description::well_known::Rfc3339)
                    .ok()
            })
    };
    if oauth.oauth_provider == "codex" {
        return Json(serde_json::json!({
            "success":true,
            "skipped":true,
            "connectionId":id,
            "provider":oauth.oauth_provider,
            "message":"Rotating-refresh provider: the token refreshes automatically on the next request. Manual refresh is skipped to protect the token family.",
            "expiresAt":expires_at(auth.expires_at_unix),
            "refreshedAt":refreshed_at,
        }))
        .into_response();
    }
    match control
        .refresh_provider_oauth_as(&id, Some(&scope.actor), scope.tenant_id.as_deref())
        .await
    {
        Ok(refresh) if refresh.ok => Json(serde_json::json!({
            "success":true,
            "connectionId":id,
            "provider":oauth.oauth_provider,
            "expiresAt":refresh.expires_at_unix.and_then(|value| i64::try_from(value).ok()).and_then(expires_at),
            "refreshedAt":refreshed_at,
        }))
        .into_response(),
        Ok(refresh) if refresh.category == "refresh_in_progress" => {
            Json(serde_json::json!({
                "success":true,
                "skipped":true,
                "connectionId":id,
                "provider":oauth.oauth_provider,
                "message":"A token refresh is already in progress on another replica.",
                "expiresAt":refresh.expires_at_unix.and_then(|value| i64::try_from(value).ok()).and_then(expires_at),
                "refreshedAt":refreshed_at,
            }))
            .into_response()
        }
        Ok(refresh) if refresh.category == "reauth_required" => api_error_code(
            StatusCode::UNAUTHORIZED,
            "Refresh token expired. Please re-authenticate this account.",
            "reauth_required",
        ),
        Ok(refresh) if refresh.category == "oauth_client_unconfigured" => api_error_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "Antigravity OAuth refresh requires configured client credentials.",
            "oauth_client_unconfigured",
        ),
        Ok(_) => api_error(
            StatusCode::BAD_GATEWAY,
            "Token refresh failed - provider returned no new token",
        ),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider OAuth refresh unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid provider OAuth refresh"),
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
        || error.contains("cannot delete")
        || error.contains("cannot reload")
        || error.contains("breaker storage")
        || error.contains("route pin")
        || error.contains("quota state")
        || error.contains("combo has no enabled")
        || error.contains("combo provider unavailable")
        || error.contains("cannot generate client key")
        || error.contains("OIDC")
        || error.contains("OAuth rotation requires SQLite")
        || error.contains("OAuth revision mismatch")
        || error.contains("OAuth rotation state")
        || error.contains("OAuth refresh")
}

pub async fn put_provider_quota(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ProviderQuotaInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .configure_provider_quota_as(&id, input, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(quota) => Json(serde_json::json!({"provider_quota":quota})).into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider quota storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid provider quota"),
    }
}

pub async fn refresh_provider_quota(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .refresh_provider_quota_as(&id, Some(&scope.actor), scope.tenant_id.as_deref())
        .await
    {
        Ok(refresh) => Json(serde_json::json!({"refresh":refresh})).into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider quota refresh unavailable",
        ),
        Err("provider does not exist" | "provider OAuth configuration not found") => {
            api_error(StatusCode::NOT_FOUND, "Provider quota source not found")
        }
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid provider quota refresh"),
    }
}

pub async fn delete_provider_quota(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .clear_provider_quota_as(&id, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider quota storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid provider identifier"),
    }
}

pub async fn delete_provider(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .disable_as(&id, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err("provider is referenced by an enabled combo") => {
            api_error(StatusCode::CONFLICT, "Provider is still in use")
        }
        Err(error) if is_runtime_error(error) || error == "cannot disable provider" => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid provider identifier"),
    }
}

pub async fn purge_provider(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .purge_provider_as(&id, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err("provider configuration not found") => {
            api_error(StatusCode::NOT_FOUND, "Provider configuration not found")
        }
        Err(
            "provider must be disabled before removal"
            | "provider is referenced by an enabled combo",
        ) => api_error(StatusCode::CONFLICT, "Provider is still in use"),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider storage or runtime unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid provider removal request"),
    }
}

pub async fn put_combo(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ComboInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .configure_combo_as(&id, input, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(combo) => Json(serde_json::json!({"combo":combo})).into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Combo storage or runtime unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid combo configuration"),
    }
}

pub async fn delete_combo(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .disable_combo_as(&id, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) if is_runtime_error(error) || error == "cannot disable combo" => {
            api_error(StatusCode::SERVICE_UNAVAILABLE, "Combo storage unavailable")
        }
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid combo identifier"),
    }
}

pub async fn delete_combo_route_pin(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .clear_route_pin(&id, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Route pin storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid combo identifier"),
    }
}

pub async fn put_client_key(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ClientKeyInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .configure_client_key_as(&id, input, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(key) => Json(serde_json::json!({"client_key":key})).into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Client key storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid client key configuration"),
    }
}

pub async fn put_tenant(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<TenantInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(actor) = control.authorized_admin_actor(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control.configure_tenant_as(&id, input, &actor).await {
        Ok(tenant) => Json(serde_json::json!({"tenant":tenant})).into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Tenant storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid tenant configuration"),
    }
}

pub async fn put_identity_binding(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<IdentityBindingInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(actor) = control.authorized_admin_actor(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .configure_identity_binding_as(&id, input, &actor)
        .await
    {
        Ok(binding) => Json(serde_json::json!({"identity_binding":binding})).into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Identity binding storage unavailable",
        ),
        Err(_) => api_error(
            StatusCode::BAD_REQUEST,
            "Invalid identity binding configuration",
        ),
    }
}

pub async fn delete_identity_binding(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(actor) = control.authorized_admin_actor(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control.delete_identity_binding_as(&id, &actor).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Identity binding storage unavailable",
        ),
        Err("identity binding configuration not found") => {
            api_error(StatusCode::NOT_FOUND, "Identity binding not found")
        }
        Err(_) => api_error(
            StatusCode::BAD_REQUEST,
            "Invalid identity binding identifier",
        ),
    }
}

pub async fn provision_client_key(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ClientKeyInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    if input.api_key.is_none() {
        return api_error(StatusCode::BAD_REQUEST, "api_key is required");
    }
    let Some(tenant_id) = input.tenant_id.clone() else {
        return api_error(StatusCode::BAD_REQUEST, "tenant_id is required");
    };
    let Some(actor) = control.authorized_tenant_issuer(&headers, &tenant_id).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid provisioning identity");
    };
    match control
        .configure_client_key_as(&id, input, &actor, Some(&tenant_id))
        .await
    {
        Ok(key) => Json(serde_json::json!({"client_key":key})).into_response(),
        Err(error) if is_runtime_error(error) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Client key storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid client key configuration"),
    }
}

pub async fn delete_client_key(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Management API is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .revoke_client_key_as(&id, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) if is_runtime_error(error) || error == "cannot revoke client key" => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Client key storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid client key identifier"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_labels_preserve_legacy_unicode_length_limits() {
        for label in ["a".repeat(200), "é".repeat(200), "🦀".repeat(100)] {
            assert!(validate_provider_label(&label).is_ok());
            assert!(validate_provider_label(&(label + "a")).is_err());
        }
        for label in ["", "account\nname", "account\u{0000}name"] {
            assert!(validate_provider_label(label).is_err());
        }
    }

    #[tokio::test]
    async fn in_memory_control_plane_keeps_signature_polling() {
        let database = Arc::new(
            crate::storage::Database::connect(crate::storage::Backend::Sqlite, "sqlite::memory:")
                .await
                .unwrap(),
        );
        let plane = ControlPlane::new(
            database,
            "fixture-admin-key-1234567890-abcdef",
            "fixture-storage-key-1234567890",
            false,
        )
        .await
        .unwrap();
        assert!(plane.0.sqlite_changes.is_none());
        assert!(plane.control_snapshot_changed().await.unwrap());
        plane.sync_provider_snapshot().await.unwrap();
        plane.sync_oidc_snapshot().await.unwrap();
    }

    #[tokio::test]
    async fn sqlite_observer_detects_same_pool_writes_without_reserving_the_writer() {
        let directory = tempfile::tempdir().unwrap();
        let file = url::Url::from_file_path(directory.path().join("observer.sqlite")).unwrap();
        let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
        let database = crate::storage::Database::connect(crate::storage::Backend::Sqlite, &url)
            .await
            .unwrap();
        let pool = database.sql_pool().unwrap();
        let mut watcher = SqliteChangeWatcher::new(pool).await.unwrap();
        assert!(!watcher.changed().await.unwrap());
        let own_version: i64 = sqlx::query_scalar("PRAGMA data_version")
            .fetch_one(pool)
            .await
            .unwrap();
        for revision in 1..=2 {
            sqlx::query("INSERT INTO redrouter_control_provider_headers (provider_id,upstream_identity,headers_ciphertext,revision) VALUES ('fixture','identity','ciphertext',$1) ON CONFLICT(provider_id) DO UPDATE SET revision=$1")
                .bind(revision).execute(pool).await.unwrap();
            let after: i64 = sqlx::query_scalar("PRAGMA data_version")
                .fetch_one(pool)
                .await
                .unwrap();
            assert_eq!(
                after, own_version,
                "writer's data_version is not a change feed"
            );
            assert!(watcher.changed().await.unwrap());
            assert!(
                watcher.changed().await.unwrap(),
                "pending changes must remain until acknowledged"
            );
            watcher.acknowledge();
            assert!(!watcher.changed().await.unwrap());
        }
        sqlx::query("DELETE FROM redrouter_control_provider_headers")
            .execute(pool)
            .await
            .unwrap();
        assert!(watcher.changed().await.unwrap());
        watcher.acknowledge();
        assert!(!watcher.changed().await.unwrap());
        assert!(
            sqlx::query("DELETE FROM redrouter_control_provider_headers")
                .execute(&mut watcher.connection)
                .await
                .is_err(),
            "observer cannot write durable data"
        );
    }

    fn direct_combo_target(provider_id: &str, model: &str) -> ComboTarget {
        ComboTarget {
            kind: None,
            combo_id: None,
            provider_id: provider_id.to_owned(),
            model: model.to_owned(),
            prompt: None,
            weight: None,
            input_cost_per_million: None,
            output_cost_per_million: None,
            context_window_tokens: None,
        }
    }

    fn combo_reference(combo_id: &str) -> ComboTarget {
        ComboTarget {
            kind: Some("combo-ref".to_owned()),
            combo_id: Some(combo_id.to_owned()),
            provider_id: String::new(),
            model: String::new(),
            prompt: None,
            weight: None,
            input_cost_per_million: None,
            output_cost_per_million: None,
            context_window_tokens: None,
        }
    }

    fn stored_combo(id: &str, targets: Vec<ComboTarget>, enabled: bool) -> StoredCombo {
        StoredCombo {
            id: id.to_owned(),
            tenant_id: "red".to_owned(),
            protocol: "openai".to_owned(),
            strategy: "priority".to_owned(),
            fallback: true,
            targets_json: serde_json::to_string(&targets).unwrap(),
            enabled,
            revision: 1,
        }
    }

    #[test]
    fn nested_combo_targets_flatten_in_declared_order() {
        let child = stored_combo(
            "child",
            vec![
                direct_combo_target("first", "model-a"),
                direct_combo_target("second", "model-b"),
            ],
            true,
        );
        let root_targets = vec![
            combo_reference("child"),
            direct_combo_target("third", "model-c"),
        ];
        let resolved =
            resolve_nested_combo_targets("root", "red", "openai", &root_targets, &[child]).unwrap();
        assert_eq!(
            resolved
                .iter()
                .map(|target| (target.provider_id.as_str(), target.model.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("first", "model-a"),
                ("second", "model-b"),
                ("third", "model-c")
            ]
        );
    }

    #[test]
    fn nested_combo_graph_rejects_cycles_depth_and_disabled_dependencies() {
        let cycle_a = stored_combo("cycle-a", vec![combo_reference("cycle-b")], true);
        let cycle_b = stored_combo("cycle-b", vec![combo_reference("cycle-a")], true);
        assert_eq!(
            validate_combo_graphs(&[cycle_a, cycle_b]),
            Err("circular combo reference")
        );

        let leaf = stored_combo("leaf", vec![direct_combo_target("first", "model")], true);
        let level_three = stored_combo("level-three", vec![combo_reference("leaf")], true);
        let level_two = stored_combo("level-two", vec![combo_reference("level-three")], true);
        let level_one = stored_combo("level-one", vec![combo_reference("level-two")], true);
        let root = stored_combo("root", vec![combo_reference("level-one")], true);
        assert_eq!(
            validate_combo_graphs(&[leaf, level_three, level_two, level_one, root]),
            Err("maximum combo nesting depth exceeded")
        );

        let child = stored_combo(
            "disabled-child",
            vec![direct_combo_target("first", "model")],
            false,
        );
        let parent = stored_combo(
            "enabled-parent",
            vec![combo_reference("disabled-child")],
            true,
        );
        assert_eq!(
            validate_combo_graphs(&[child, parent]),
            Err("nested combo is disabled")
        );
    }

    #[test]
    fn combo_metadata_uses_models_dev_without_overriding_operator_values() {
        let providers = vec![StoredProvider {
            node_id: None,
            protocol: "auto".to_owned(),
            priority: 0,
            default_model: None,
            id: "first".to_owned(),
            tenant_id: "red".to_owned(),
            provider: "openai".to_owned(),
            upstream_url: "https://api.openai.com/v1/chat/completions".to_owned(),
            credential_ciphertext: "encrypted".to_owned(),
            enabled: true,
            updated_at: 1,
        }];
        let mut input = ComboInput {
            tenant_id: None,
            protocol: "openai-chat".to_owned(),
            strategy: "cost-optimized".to_owned(),
            fallback: true,
            targets: vec![ComboTarget {
                kind: None,
                combo_id: None,
                provider_id: "first".to_owned(),
                model: "gpt-3.5-turbo".to_owned(),
                prompt: None,
                weight: None,
                input_cost_per_million: Some(99.0),
                output_cost_per_million: None,
                context_window_tokens: None,
            }],
            auto: None,
            context_relay: None,
            fusion: None,
            pipeline: None,
            enabled: true,
        };

        let catalog = crate::catalog::bundled_catalog().unwrap();
        enrich_combo_metadata(&mut input, &providers, &catalog).unwrap();

        let target = &input.targets[0];
        assert_eq!(target.input_cost_per_million, Some(99.0));
        assert_eq!(target.output_cost_per_million, Some(1.5));
        assert_eq!(target.context_window_tokens, Some(16_385));
    }

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

    #[test]
    fn agy_auth_parser_accepts_cli_and_flat_exports_without_exposing_tokens() {
        let nested = parse_agy_auth(serde_json::json!({
            "token":{
                "access_token":"access",
                "refresh_token":"refresh",
                "token_type":"Bearer",
                "expiry":"2099-01-01T00:00:00Z"
            },
            "auth_method":"consumer"
        }))
        .unwrap();
        assert_eq!(nested.access_token.as_str(), "access");
        assert_eq!(nested.refresh_token.as_str(), "refresh");
        assert!(nested.expires_at_unix > 4_000_000_000);
        assert!(!nested.session_metadata.contains("access"));
        assert!(!nested.session_metadata.contains("refresh"));

        let flat = parse_agy_auth(serde_json::json!({
            "access_token":"flat-access",
            "refresh_token":"flat-refresh",
            "expiry_date":4_070_908_800_000_u64
        }))
        .unwrap();
        assert_eq!(flat.expires_at_unix, 4_070_908_800);
        assert!(parse_agy_auth(serde_json::json!({
            "access_token":"missing-refresh",
            "expiry_date":4_070_908_800_000_u64
        }))
        .is_err());
    }

    #[test]
    fn usage_export_views_are_write_only_for_service_accounts() {
        let record = StoredUsageExport {
            id: "usage-report".to_owned(),
            tenant_id: "red".to_owned(),
            name: "Billing warehouse".to_owned(),
            export_type: "bigquery".to_owned(),
            mode: "instant".to_owned(),
            window_sec: 0,
            api_key_ids_json: "[]".to_owned(),
            project_id: "red-router-prod".to_owned(),
            dataset_id: "billing".to_owned(),
            table_id: "usage".to_owned(),
            service_account_ciphertext: "rrenc1:secret-ciphertext".to_owned(),
            config_json: "{}".to_owned(),
            secret_ciphertext: String::new(),
            batch_size: 500,
            interval_seconds: 10,
            enabled: true,
            revision: 1_700_000_000_000_000_000,
        };
        let view = usage_export_view(&record, &[]).unwrap();
        let encoded = view.to_string();
        assert_eq!(view["config"]["serviceAccountJson"], "__stored__");
        assert!(!encoded.contains("secret-ciphertext"));
    }

    #[test]
    fn usage_webhook_views_expose_only_the_secret_placeholder() {
        let record = StoredUsageExport {
            id: "usage-hook".to_owned(),
            tenant_id: "red".to_owned(),
            name: "Billing webhook".to_owned(),
            export_type: "webhook".to_owned(),
            mode: "window".to_owned(),
            window_sec: 900,
            api_key_ids_json: "[]".to_owned(),
            project_id: String::new(),
            dataset_id: String::new(),
            table_id: String::new(),
            service_account_ciphertext: String::new(),
            config_json: r#"{"url":"https://billing.example.com/usage"}"#.to_owned(),
            secret_ciphertext: "rrenc1:webhook-secret-ciphertext".to_owned(),
            batch_size: 8,
            interval_seconds: 1,
            enabled: true,
            revision: 1_700_000_000_000_000_000,
        };
        let view = usage_export_view(&record, &[]).unwrap();
        let encoded = view.to_string();
        assert_eq!(view["config"]["secret"], "__stored__");
        assert_eq!(view["config"]["url"], "https://billing.example.com/usage");
        assert_eq!(view["mode"], "window");
        assert_eq!(view["windowSec"], 900);
        assert!(view["nextWindowEnd"].as_str().is_some());
        assert!(!encoded.contains("webhook-secret-ciphertext"));
    }

    #[test]
    fn usage_reddb_views_expose_only_the_token_placeholder() {
        let record = StoredUsageExport {
            id: "usage-reddb".to_owned(),
            tenant_id: "red".to_owned(),
            name: "RedDB billing queue".to_owned(),
            export_type: "reddb".to_owned(),
            mode: "instant".to_owned(),
            window_sec: 0,
            api_key_ids_json: "[]".to_owned(),
            project_id: String::new(),
            dataset_id: String::new(),
            table_id: String::new(),
            service_account_ciphertext: String::new(),
            config_json:
                r#"{"url":"https://reddb.example.com","queue":"usage_events","tenant":"billing"}"#
                    .to_owned(),
            secret_ciphertext: "rrenc1:reddb-token-ciphertext".to_owned(),
            batch_size: 8,
            interval_seconds: 1,
            enabled: true,
            revision: 1_700_000_000_000_000_000,
        };
        let view = usage_export_view(&record, &[]).unwrap();
        let encoded = view.to_string();
        assert_eq!(view["config"]["token"], "__stored__");
        assert_eq!(view["config"]["queue"], "usage_events");
        assert_eq!(view["config"]["tenant"], "billing");
        assert!(!encoded.contains("reddb-token-ciphertext"));
    }

    #[test]
    fn usage_sqs_views_expose_only_write_only_credential_placeholders() {
        let record = StoredUsageExport {
            id: "usage-sqs".to_owned(),
            tenant_id: "red".to_owned(),
            name: "Billing queue".to_owned(),
            export_type: "sqs".to_owned(),
            mode: "instant".to_owned(),
            window_sec: 0,
            api_key_ids_json: "[]".to_owned(),
            project_id: String::new(),
            dataset_id: String::new(),
            table_id: String::new(),
            service_account_ciphertext: String::new(),
            config_json: r#"{"queueUrl":"https://sqs.us-east-1.amazonaws.com/123/usage","region":"us-east-1","accessKeyId":"AKIDEXAMPLE","hasSessionToken":true}"#.to_owned(),
            secret_ciphertext: "rrenc1:sqs-secret-ciphertext".to_owned(),
            batch_size: 8,
            interval_seconds: 1,
            enabled: true,
            revision: 1_700_000_000_000_000_000,
        };
        let view = usage_export_view(&record, &[]).unwrap();
        let encoded = view.to_string();
        assert_eq!(view["config"]["secretAccessKey"], "__stored__");
        assert_eq!(view["config"]["sessionToken"], "__stored__");
        assert_eq!(view["config"]["region"], "us-east-1");
        assert!(!encoded.contains("sqs-secret-ciphertext"));
    }

    #[test]
    fn usage_kafka_views_expose_only_the_password_placeholder() {
        let record = StoredUsageExport {
            id: "usage-kafka".to_owned(),
            tenant_id: "red".to_owned(),
            name: "Billing events".to_owned(),
            export_type: "kafka".to_owned(),
            mode: "window".to_owned(),
            window_sec: 900,
            api_key_ids_json: "[]".to_owned(),
            project_id: String::new(),
            dataset_id: String::new(),
            table_id: String::new(),
            service_account_ciphertext: String::new(),
            config_json: r#"{"brokers":["broker.example.com:9093"],"topic":"redrouter.usage","clientId":"red-router","ssl":true,"saslMechanism":"scram-sha-256","saslUsername":"billing","hasSaslPassword":true}"#.to_owned(),
            secret_ciphertext: "rrenc1:kafka-password-ciphertext".to_owned(),
            batch_size: 8,
            interval_seconds: 1,
            enabled: true,
            revision: 1_700_000_000_000_000_000,
        };
        let view = usage_export_view(&record, &[]).unwrap();
        let encoded = view.to_string();
        assert_eq!(view["config"]["saslPassword"], "__stored__");
        assert_eq!(view["config"]["ssl"], true);
        assert_eq!(view["config"]["brokers"], "broker.example.com:9093");
        assert!(!encoded.contains("kafka-password-ciphertext"));
    }

    #[test]
    fn dashboard_number_fields_accept_strings_and_numbers() {
        assert_eq!(UnsignedInput::Text("500".to_owned()).value().unwrap(), 500);
        assert_eq!(UnsignedInput::Number(10).value().unwrap(), 10);
        assert!(UnsignedInput::Text("ten".to_owned()).value().is_err());
    }
}
