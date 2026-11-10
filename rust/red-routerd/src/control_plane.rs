//! Authenticated Rust control plane for provider persistence and live reload.
use crate::{
    availability::{AvailabilityStatus, ProviderAvailability},
    circuit::{BreakerStatus, ProviderCircuit},
    policy::{ClientPolicies, StoredPolicy},
    resilience::RateLimitScope,
    storage::{
        StoredAuditEvent, StoredClientKey, StoredCombo, StoredIdentityBinding,
        StoredModelCatalogSnapshot, StoredOidcBrowserConfig, StoredOidcConfig, StoredProvider,
        StoredProviderAuth, StoredProviderOAuth, StoredProviderOAuthStatus, StoredProviderQuota,
        StoredProviderSession, StoredResilience, StoredRoutePin, StoredTenant, StoredUsageExport,
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
use sqlx::Row;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    io::{Cursor, Read},
    path::Path as FilePath,
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::RwLock;
use zeroize::{Zeroize, Zeroizing};

type ControlCipher = AesGcm<Aes256, U16>;
const MODEL_CATALOG_SYNC_INTERVAL: Duration = Duration::from_secs(5);
const CLIENT_POLICY_SYNC_INTERVAL: Duration = Duration::from_secs(2);
const CONTROL_SNAPSHOT_SYNC_INTERVAL: Duration = Duration::from_secs(2);
const PROVIDER_DIAGNOSTIC_TIMEOUT: Duration = Duration::from_secs(30);
const PROVIDER_DIAGNOSTIC_MAX_BODY_BYTES: usize = 1024 * 1024;
const OAUTH_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const OAUTH_REFRESH_LEAD_SECONDS: i64 = 300;
const OAUTH_REFRESH_LEASE_MS: i64 = 45_000;
const OAUTH_REFRESH_SETTLE_MS: i64 = 2_000;
const OAUTH_REFRESH_MAX_BODY_BYTES: usize = 1024 * 1024;
const CODEX_OAUTH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CLAUDE_OAUTH_TOKEN_URL: &str = "https://api.anthropic.com/v1/oauth/token";
const AGY_OAUTH_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const CODEX_OAUTH_AUTHORIZE_URL: &str = "https://auth.openai.com/oauth/authorize";
const CLAUDE_OAUTH_AUTHORIZE_URL: &str = "https://claude.ai/oauth/authorize";
const CODEX_PROVIDER_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const CLAUDE_PROVIDER_URL: &str = "https://api.anthropic.com/v1/messages";
const AGY_PROVIDER_URL: &str =
    "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent";
const AGY_USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v1/userinfo";
const AGY_LOAD_CODE_ASSIST_URL: &str =
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const CLAUDE_BOOTSTRAP_URL: &str = "https://api.anthropic.com/api/claude_cli/bootstrap";
const CODEX_OAUTH_REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const CLAUDE_OAUTH_REDIRECT_URI: &str = "https://platform.claude.com/oauth/code/callback";
const PROVIDER_OAUTH_FLOW_SECONDS: u64 = 10 * 60;
const CLAUDE_CLI_USER_AGENT: &str = "claude-cli/2.1.301 (external, cli)";
const CODEX_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CLAUDE_OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
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
UNION ALL SELECT 'provider-session', provider_id, revision, 0 FROM redrouter_control_provider_sessions
UNION ALL SELECT 'provider-resilience', record_id, revision, 0 FROM redrouter_provider_resilience
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
    breakers: RwLock<HashMap<String, Arc<ProviderCircuit>>>,
    availability: RwLock<HashMap<String, Arc<ProviderAvailability>>>,
    oidc: RwLock<Option<Arc<crate::oidc::OidcVerifier>>>,
    oidc_browser: RwLock<Option<Arc<crate::oidc::OidcBrowserConfig>>>,
    sqlite_changes: Option<tokio::sync::Mutex<SqliteChangeWatcher>>,
    provider_snapshot_signature: RwLock<[u8; 32]>,
    oidc_snapshot_signature: RwLock<[u8; 32]>,
    catalog: RwLock<CatalogState>,
    catalog_refresh: tokio::sync::Mutex<()>,
    catalog_client: reqwest::Client,
    catalog_source: reqwest::Url,
    oauth_refresh_client: reqwest::Client,
    oauth_refresh: OAuthRefreshConfig,
    native_usage: RwLock<Option<crate::native_usage::NativeUsage>>,
    mutation: tokio::sync::Mutex<()>,
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
    agy_client_id: Option<String>,
    agy_client_secret: Option<Zeroizing<String>>,
    codex_provider_endpoint: reqwest::Url,
    claude_provider_endpoint: reqwest::Url,
    claude_bootstrap_endpoint: reqwest::Url,
    agy_provider_endpoint: reqwest::Url,
    agy_userinfo_endpoint: reqwest::Url,
    agy_load_code_assist_endpoint: reqwest::Url,
}

struct OAuthRefreshRuntime {
    cadence: Duration,
    snapshot_cadence: Duration,
    config: OAuthRefreshConfig,
}

struct SqliteChangeWatcher {
    pool: sqlx::AnyPool,
    version: i64,
    control_marker: [u8; 32],
}

impl SqliteChangeWatcher {
    async fn new(pool: &sqlx::AnyPool) -> Result<Self, &'static str> {
        let version = sqlx::query_scalar::<_, i64>("PRAGMA data_version")
            .fetch_one(pool)
            .await
            .map_err(|_| "cannot initialize control snapshot watcher")?;
        let control_marker = sqlite_control_marker(pool).await?;
        Ok(Self {
            pool: pool.clone(),
            version,
            control_marker,
        })
    }

    async fn changed(&mut self) -> Result<bool, &'static str> {
        let version = sqlx::query_scalar::<_, i64>("PRAGMA data_version")
            .fetch_one(&self.pool)
            .await
            .map_err(|_| "control snapshot watcher unavailable")?;
        if version == self.version {
            return Ok(false);
        }
        self.version = version;
        let control_marker = sqlite_control_marker(&self.pool).await?;
        let changed = control_marker != self.control_marker;
        self.control_marker = control_marker;
        Ok(changed)
    }
}

async fn sqlite_control_marker(pool: &sqlx::AnyPool) -> Result<[u8; 32], &'static str> {
    let rows = sqlx::query(SQLITE_CONTROL_MARKER)
        .fetch_all(pool)
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

enum RouteSnapshot {
    Legacy,
    Current(Arc<HashMap<String, Arc<ModelRoute>>>),
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderInput {
    pub tenant_id: Option<String>,
    pub provider: String,
    pub upstream_url: String,
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

struct ParsedCodexAuth {
    access_token: Zeroizing<String>,
    refresh_token: Zeroizing<String>,
    session_metadata: Zeroizing<String>,
    account_id: String,
    user_id: Option<String>,
    email: Option<String>,
    expires_at_unix: u64,
}

struct ParsedClaudeAuth {
    access_token: Zeroizing<String>,
    refresh_token: Zeroizing<String>,
    session_metadata: Zeroizing<String>,
    expires_at_unix: u64,
}

struct ParsedAgyAuth {
    access_token: Zeroizing<String>,
    refresh_token: Zeroizing<String>,
    session_metadata: Zeroizing<String>,
    expires_at_unix: u64,
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
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    pub expires_at_unix: Option<u64>,
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
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
    pub expires_at_unix: Option<u64>,
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
pub struct UsageReportQuery {
    pub tenant_id: Option<String>,
    pub key_id: Option<String>,
    pub from_unix_ms: Option<i64>,
    pub to_unix_ms: Option<i64>,
    pub limit: Option<i64>,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UsageExportConfigInput {
    pub url: Option<String>,
    pub secret: Option<String>,
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
            enabled: self.enabled,
            expires_at_unix: self.expires_at_unix,
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
    pub id: String,
    pub label: String,
    pub tenant_id: String,
    pub created_by: String,
    pub model_id_format: String,
    pub enabled: bool,
    pub expires_at_unix: Option<u64>,
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
    pub provider_id: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weight: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_cost_per_million: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_cost_per_million: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<u64>,
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
    pub enabled: bool,
    pub revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_known_good: Option<RoutePinView>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<QuotaWindowView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weekly: Option<QuotaWindowView>,
    pub limit_reached: bool,
    pub observed_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub revision: String,
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
        let agy_client_id = std::env::var("ANTIGRAVITY_OAUTH_CLIENT_ID")
            .ok()
            .filter(|value| !value.trim().is_empty());
        let agy_client_secret = std::env::var("ANTIGRAVITY_OAUTH_CLIENT_SECRET")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(Zeroizing::new);
        validate_oauth_client_id(&codex_client_id)?;
        validate_oauth_client_id(&claude_client_id)?;
        if let Some(client_id) = agy_client_id.as_deref() {
            validate_oauth_client_id(client_id)?;
        }
        if agy_client_secret
            .as_deref()
            .is_some_and(|secret| secret.len() > 8192 || secret.chars().any(char::is_control))
        {
            return Err("invalid Antigravity OAuth client secret");
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
            agy_client_id,
            agy_client_secret,
            codex_provider_endpoint: reqwest::Url::parse(CODEX_PROVIDER_URL)
                .map_err(|_| "invalid Codex provider URL")?,
            claude_provider_endpoint: reqwest::Url::parse(CLAUDE_PROVIDER_URL)
                .map_err(|_| "invalid Claude provider URL")?,
            claude_bootstrap_endpoint: reqwest::Url::parse(CLAUDE_BOOTSTRAP_URL)
                .map_err(|_| "invalid Claude bootstrap URL")?,
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
        Self {
            codex_provider_endpoint,
            codex_endpoint: codex_endpoint.clone(),
            codex_client_id: CODEX_OAUTH_CLIENT_ID.to_owned(),
            claude_provider_endpoint,
            claude_bootstrap_endpoint,
            claude_endpoint,
            claude_client_id: CLAUDE_OAUTH_CLIENT_ID.to_owned(),
            agy_endpoint: codex_endpoint,
            agy_client_id: Some("test-antigravity-client".to_owned()),
            agy_client_secret: Some(Zeroizing::new("test-antigravity-secret".to_owned())),
            agy_provider_endpoint,
            agy_userinfo_endpoint,
            agy_load_code_assist_endpoint,
        }
    }
}

fn validate_oauth_client_id(value: &str) -> Result<(), &'static str> {
    if !(1..=512).contains(&value.len()) || value.chars().any(char::is_control) {
        return Err("invalid OAuth client identifier");
    }
    Ok(())
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
        if !(Duration::from_millis(10)..=Duration::from_secs(3_600))
            .contains(&oauth_refresh.snapshot_cadence)
        {
            return Err("invalid control snapshot interval");
        }
        let OAuthRefreshRuntime {
            cadence: oauth_refresh_cadence,
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
        let sqlite_changes = if sqlite {
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
            database,
            current: RwLock::new(None),
            clients: RwLock::new(ClientSnapshot::Unavailable),
            routes: RwLock::new(RouteSnapshot::Unavailable),
            quotas: RwLock::new(quotas),
            breakers: RwLock::new(breakers),
            availability: RwLock::new(availability),
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
            mutation: tokio::sync::Mutex::new(()),
            admin_hash: Sha256::digest(admin_key.as_bytes()).into(),
            encryption_key: Zeroizing::new(encryption_key.to_owned()),
            allow_private,
        }));
        plane.refresh().await?;
        plane.refresh_clients().await?;
        plane.refresh_routes().await?;
        *plane.0.provider_snapshot_signature.write().await =
            plane.provider_runtime_signature().await?;
        *plane.0.oidc_snapshot_signature.write().await = plane.oidc_runtime_signature().await?;
        plane.spawn_model_catalog_sync(catalog_poll_interval);
        plane.spawn_client_policy_sync(CLIENT_POLICY_SYNC_INTERVAL);
        plane.spawn_control_snapshot_sync(snapshot_cadence);
        if sqlite {
            plane.spawn_oauth_refresh_sync(oauth_refresh_cadence);
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
                    Err(_) => {
                        *plane.0.current.write().await = None;
                        *plane.0.routes.write().await = RouteSnapshot::Unavailable;
                        plane.clear_oidc_runtime().await;
                        continue;
                    }
                }
                plane.sync_provider_snapshot().await;
                plane.sync_oidc_snapshot().await;
            }
        });
    }

    async fn control_snapshot_changed(&self) -> Result<bool, &'static str> {
        match &self.0.sqlite_changes {
            Some(watcher) => watcher.lock().await.changed().await,
            None => Ok(true),
        }
    }

    async fn sync_provider_snapshot(&self) {
        let observed = match self.provider_runtime_signature().await {
            Ok(signature) => signature,
            Err(_) => {
                *self.0.current.write().await = None;
                *self.0.routes.write().await = RouteSnapshot::Unavailable;
                return;
            }
        };
        if *self.0.provider_snapshot_signature.read().await == observed {
            return;
        }
        let _mutation = self.0.mutation.lock().await;
        let latest = match self.provider_runtime_signature().await {
            Ok(signature) => signature,
            Err(_) => {
                *self.0.current.write().await = None;
                *self.0.routes.write().await = RouteSnapshot::Unavailable;
                return;
            }
        };
        if *self.0.provider_snapshot_signature.read().await == latest {
            return;
        }
        if self.refresh().await.is_err() {
            *self.0.current.write().await = None;
            *self.0.routes.write().await = RouteSnapshot::Unavailable;
            return;
        }
        if self.refresh_routes().await.is_err() {
            *self.0.routes.write().await = RouteSnapshot::Unavailable;
            return;
        }
        *self.0.provider_snapshot_signature.write().await = latest;
    }

    async fn sync_oidc_snapshot(&self) {
        let observed = match self.oidc_runtime_signature().await {
            Ok(signature) => signature,
            Err(_) => {
                self.clear_oidc_runtime().await;
                return;
            }
        };
        if *self.0.oidc_snapshot_signature.read().await == observed {
            return;
        }
        let _mutation = self.0.mutation.lock().await;
        let latest = match self.oidc_runtime_signature().await {
            Ok(signature) => signature,
            Err(_) => {
                self.clear_oidc_runtime().await;
                return;
            }
        };
        if *self.0.oidc_snapshot_signature.read().await == latest {
            return;
        }
        if self.refresh_oidc().await.is_err() {
            self.clear_oidc_runtime().await;
            return;
        }
        *self.0.oidc_snapshot_signature.write().await = latest;
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
        let refresh_token = decrypt(
            &oauth.refresh_token_ciphertext,
            &aad,
            self.0.encryption_key.as_str(),
        )?;
        match self
            .exchange_oauth_token(&oauth.oauth_provider, refresh_token.as_str())
            .await
        {
            Ok(tokens) => {
                let access_ciphertext = encrypt(
                    tokens.access_token.as_str(),
                    &provider.id,
                    self.0.encryption_key.as_str(),
                )?;
                let refresh_ciphertext = encrypt(
                    tokens.refresh_token.as_str(),
                    &aad,
                    self.0.encryption_key.as_str(),
                )?;
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

    pub(crate) async fn begin_native_usage(
        &self,
        identity: &crate::policy::ClientIdentity,
        provider: &str,
        model: &str,
    ) -> Result<(String, Option<crate::accounting::TokenPrices>), &'static str> {
        let usage = self
            .0
            .native_usage
            .read()
            .await
            .clone()
            .ok_or("native usage storage unavailable")?;
        let prices = self.native_usage_prices(provider, model).await?;
        if identity
            .usage_quota
            .is_some_and(|quota| quota.max_monthly_microusd > 0)
            && prices.is_none()
        {
            return Err("native spend quota requires catalog pricing");
        }
        let event_id = format!("usage_{}", random_token(16)?);
        if let Some(quota) = identity.usage_quota {
            let allowed = usage
                .reserve(&crate::native_usage::Reservation {
                    event_id: &event_id,
                    key_id: &identity.id,
                    tenant_id: &identity.tenant_id,
                    provider,
                    model,
                    quota,
                    now_ms: unix_time_ms()?,
                })
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
        provider: &str,
        model: &str,
        usage_event: &crate::accounting::ChatUsage,
        prices: Option<&crate::accounting::TokenPrices>,
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
                event_id,
                key_id: &identity.id,
                key_name: &identity.name,
                tenant_id: &identity.tenant_id,
                provider,
                model,
                usage: usage_event,
                prices,
                now_ms: unix_time_ms()?,
                reserved: identity.usage_quota.is_some(),
            })
            .await?;
        Ok(())
    }

    async fn native_usage_prices(
        &self,
        provider: &str,
        model: &str,
    ) -> Result<Option<crate::accounting::TokenPrices>, &'static str> {
        let catalog = self.0.catalog.read().await.catalog.clone();
        let Some(metadata) = catalog.model(provider, model)? else {
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

    pub(crate) async fn routes(
        &self,
    ) -> Result<Option<Arc<HashMap<String, Arc<ModelRoute>>>>, &'static str> {
        match &*self.0.routes.read().await {
            RouteSnapshot::Legacy => Ok(None),
            RouteSnapshot::Current(routes) => Ok(Some(routes.clone())),
            RouteSnapshot::Unavailable => Err("combo route storage unavailable"),
        }
    }

    pub async fn has_active_provider(&self) -> Result<bool, &'static str> {
        self.0
            .database
            .active_provider()
            .await
            .map(|row| row.is_some())
    }

    pub(crate) async fn ready(&self) -> bool {
        let client_keys_ready = match &*self.0.clients.read().await {
            ClientSnapshot::Legacy => true,
            ClientSnapshot::Current(policies) => policies.has_active(),
            ClientSnapshot::Unavailable => false,
        };
        let routes_ready = match &*self.0.routes.read().await {
            RouteSnapshot::Legacy => true,
            RouteSnapshot::Current(routes) => !routes.is_empty(),
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

    fn start_provider_oauth_as(
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
        let flow = ProviderOAuthFlowState {
            provider: provider.to_owned(),
            redirect_uri: redirect_uri.to_owned(),
            verifier_hash: hex::encode(Sha256::digest(code_verifier.as_bytes())),
            actor: actor.to_owned(),
            tenant_id: tenant_id.to_owned(),
            expires_at: now
                .checked_add(PROVIDER_OAUTH_FLOW_SECONDS)
                .ok_or("system clock is out of range")?,
            nonce: random_token(16)?,
        };
        let flow =
            serde_json::to_string(&flow).map_err(|_| "cannot encode provider OAuth state")?;
        let state = encrypt(
            &flow,
            "provider-oauth-browser-flow",
            self.0.encryption_key.as_str(),
        )?;
        let (authorize_url, client_id) = match provider {
            "codex" => (
                CODEX_OAUTH_AUTHORIZE_URL,
                self.0.oauth_refresh.codex_client_id.as_str(),
            ),
            "claude" => (
                CLAUDE_OAUTH_AUTHORIZE_URL,
                self.0.oauth_refresh.claude_client_id.as_str(),
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
                .append_pair("code_challenge", &code_challenge)
                .append_pair("code_challenge_method", "S256")
                .append_pair("state", &state)
                .append_pair("prompt", "login");
            if provider == "codex" {
                query
                    .append_pair("scope", "openid profile email offline_access")
                    .append_pair("id_token_add_organizations", "true")
                    .append_pair("codex_cli_simplified_flow", "true")
                    .append_pair("originator", "codex_cli_rs");
            } else {
                query.append_pair(
                    "scope",
                    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers",
                );
            }
        }
        let mut view = serde_json::json!({
            "authUrl":auth_url.to_string(),
            "state":state,
            "codeVerifier":code_verifier,
            "codeChallenge":code_challenge,
            "redirectUri":redirect_uri,
            "flowType":"authorization_code_pkce",
            "callbackPath":if provider == "codex" { "/auth/callback" } else { "/callback" },
            "callbackHost":"localhost"
        });
        if provider == "codex" {
            view["fixedPort"] = serde_json::json!(1455);
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
            _ => return Err("unsupported browser OAuth provider"),
        };
        let request = if provider == "codex" {
            let form = {
                let mut serializer = url::form_urlencoded::Serializer::new(String::new());
                serializer
                    .append_pair("grant_type", "authorization_code")
                    .append_pair("client_id", client_id)
                    .append_pair("code", code)
                    .append_pair("redirect_uri", redirect_uri)
                    .append_pair("code_verifier", code_verifier);
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
        let flow = decrypt(
            returned_state,
            "provider-oauth-browser-flow",
            self.0.encryption_key.as_str(),
        )
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
                )
                .await
            }
            _ => Err("unsupported browser OAuth provider"),
        }
    }

    async fn import_codex_auth_as(
        &self,
        input: ProviderAuthImportInput,
        actor: &str,
        enforced_tenant: Option<&str>,
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
        let identity = bootstrap
            .account_id
            .map(|value| format!("account:{value}"))
            .or_else(|| {
                email
                    .as_deref()
                    .map(|value| format!("email:{}", value.to_ascii_lowercase()))
            });
        if identity.is_none() && !input.overwrite_existing {
            return Err("Claude account identity could not be verified");
        }
        let identity = identity.unwrap_or_else(|| {
            let mut digest = Sha256::new();
            digest.update(parsed.refresh_token.as_bytes());
            format!("token:{}", hex::encode(digest.finalize()))
        });
        let provider_id = provider_import_id("claude", tenant_id, &identity);
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
                "provider": "claude",
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

    async fn import_agy_auth_as(
        &self,
        input: ProviderAuthImportInput,
        actor: &str,
        enforced_tenant: Option<&str>,
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
        let access_token = decrypt(
            &provider.credential_ciphertext,
            id,
            self.0.encryption_key.as_str(),
        )?;
        let refresh_aad = format!("{id}:oauth-refresh");
        let refresh_token = decrypt(
            &oauth.refresh_token_ciphertext,
            &refresh_aad,
            self.0.encryption_key.as_str(),
        )?;
        let session_aad = format!("{id}:oauth-session");
        let metadata = decrypt(
            &session.session_ciphertext,
            &session_aad,
            self.0.encryption_key.as_str(),
        )?;
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
        let account_id = json_non_empty_string(value.get("account_uuid"))
            .filter(|value| value.len() <= 512 && !value.chars().any(char::is_control))
            .map(str::to_owned);
        let email = json_non_empty_string(value.get("account_email"))
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
        input: ProviderInput,
        session_metadata: Option<Zeroizing<String>>,
        actor: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<ProviderView, &'static str> {
        validate_id(id)?;
        validate_actor(actor)?;
        validate_provider(&input.provider)?;
        if !(1..=8192).contains(&input.api_key.len()) {
            return Err("provider credential must be 1-8192 bytes");
        }
        if input.upstream_url.len() > 2048 {
            return Err("provider upstream URL is too long");
        }
        let rate_limit_scope = RateLimitScope::parse(&input.rate_limit_scope)?;
        let auth_scheme = ProviderAuthScheme::parse(&input.auth_scheme)?;
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
                if !matches!(oauth_provider, "codex" | "claude" | "agy") {
                    return Err("unsupported OAuth provider");
                }
                if input.provider != oauth_provider {
                    return Err("OAuth provider must match provider type");
                }
                if auth_scheme != ProviderAuthScheme::Bearer {
                    return Err("OAuth provider authentication must use bearer");
                }
                let refresh_token = input
                    .refresh_token
                    .as_deref()
                    .ok_or("OAuth refresh token is required")?;
                if !(1..=8192).contains(&refresh_token.len()) {
                    return Err("OAuth refresh token must be 1-8192 bytes");
                }
                if expires_at_unix <= 0 {
                    return Err("OAuth credential expiry is required");
                }
                Some(oauth_provider.to_owned())
            }
            _ => return Err("unsupported provider credential type"),
        };
        if input.enabled
            && expires_at_unix > 0
            && expires_at_unix <= i64::try_from(unix_time_seconds()?).unwrap_or(i64::MAX)
        {
            return Err("provider credential is already expired");
        }
        // Resolve and pin DNS before changing durable or live configuration.
        let api_key = Zeroizing::new(input.api_key);
        let live = ProxyState::live_provider(
            &input.upstream_url,
            api_key.as_str(),
            self.0.allow_private,
            auth_scheme,
            expires_at_unix,
        )
        .await?;
        let _mutation = self.0.mutation.lock().await;
        let existing = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|provider| provider.id == id);
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
        let revision = revision()?;
        let ciphertext = encrypt(api_key.as_str(), id, self.0.encryption_key.as_str())?;
        let stored = StoredProvider {
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
            let refresh_token = Zeroizing::new(
                input
                    .refresh_token
                    .as_deref()
                    .ok_or("OAuth refresh token is required")?
                    .to_owned(),
            );
            let aad = format!("{id}:oauth-refresh");
            let oauth = StoredProviderOAuth {
                provider_id: id.to_owned(),
                oauth_provider,
                refresh_token_ciphertext: encrypt(
                    refresh_token.as_str(),
                    &aad,
                    self.0.encryption_key.as_str(),
                )?,
                generation: 0,
                revision,
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
                    session_ciphertext: encrypt(
                        session_metadata.as_str(),
                        &aad,
                        self.0.encryption_key.as_str(),
                    )?,
                    revision,
                })
                .await?;
        } else {
            self.0.database.delete_provider_session(id).await?;
        }
        self.0.database.delete_provider_oauth_status(id).await?;
        let before = existing.as_ref().map(provider_audit_snapshot);
        let after = provider_audit_snapshot(&stored);
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
        let credential = decrypt(
            &provider.credential_ciphertext,
            &provider.id,
            self.0.encryption_key.as_str(),
        )?;
        let live = ProxyState::live_provider(
            &provider.upstream_url,
            credential.as_str(),
            self.0.allow_private,
            ProviderAuthScheme::parse(&auth.auth_scheme)?,
            auth.expires_at_unix,
        )
        .await?;
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
        let access_ciphertext = encrypt(access_token.as_str(), id, self.0.encryption_key.as_str())?;
        let aad = format!("{id}:oauth-refresh");
        let refresh_ciphertext =
            encrypt(refresh_token.as_str(), &aad, self.0.encryption_key.as_str())?;
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
        let verifier = self.0.oidc.read().await.clone()?;
        let browser = self.0.oidc_browser.read().await.clone();
        Some(oidc_view(verifier.policy(), browser.as_deref()))
    }

    async fn oidc_browser_enabled(&self) -> bool {
        let verifier = self.0.oidc.read().await.clone();
        let browser = self.0.oidc_browser.read().await.clone();
        matches!((verifier, browser), (Some(verifier), Some(browser))
            if verifier.policy().enabled && verifier.policy().revision == browser.revision)
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
                    let encrypted = encrypt(
                        &secret,
                        "oidc-browser-client-secret",
                        self.0.encryption_key.as_str(),
                    )?;
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
        let verifier = self.0.oidc.read().await.clone().ok_or("OIDC is disabled")?;
        let browser = self
            .0
            .oidc_browser
            .read()
            .await
            .clone()
            .ok_or("OIDC browser login is disabled")?;
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
        let flow_cookie = encrypt(
            &flow,
            "oidc-browser-login-flow",
            self.0.encryption_key.as_str(),
        )?;
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
        let flow = decrypt(
            flow_cookie,
            "oidc-browser-login-flow",
            self.0.encryption_key.as_str(),
        )?;
        let flow: OidcFlowState =
            serde_json::from_str(&flow).map_err(|_| "invalid OIDC login state")?;
        let now = unix_time_seconds()?;
        if flow.expires_at < now
            || flow.state.len() != returned_state.len()
            || !bool::from(flow.state.as_bytes().ct_eq(returned_state.as_bytes()))
        {
            return Err("invalid OIDC login state");
        }
        let verifier = self.0.oidc.read().await.clone().ok_or("OIDC is disabled")?;
        let browser = self
            .0
            .oidc_browser
            .read()
            .await
            .clone()
            .ok_or("OIDC browser login is disabled")?;
        if !verifier.policy().enabled
            || flow.revision != verifier.policy().revision
            || flow.revision != browser.revision
        {
            return Err("OIDC login state is stale");
        }
        let secret = decrypt(
            &browser.client_secret_ciphertext,
            "oidc-browser-client-secret",
            self.0.encryption_key.as_str(),
        )?;
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
        };
        let session = serde_json::to_string(&session).map_err(|_| "cannot encode admin session")?;
        let session_cookie = encrypt(
            &session,
            "oidc-browser-admin-session",
            self.0.encryption_key.as_str(),
        )?;
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

    pub async fn disable(&self, id: &str) -> Result<(), &'static str> {
        self.disable_as(id, "bootstrap-admin", None).await
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
        validate_actor(actor)?;
        let _mutation = self.0.mutation.lock().await;
        let providers = self.0.database.providers().await?;
        let existing = self
            .0
            .database
            .combos()
            .await?
            .into_iter()
            .find(|combo| combo.id == id);
        let tenant_id = input
            .tenant_id
            .as_deref()
            .or_else(|| existing.as_ref().map(|combo| combo.tenant_id.as_str()))
            .or(enforced_tenant)
            .unwrap_or("red")
            .to_owned();
        validate_id(&tenant_id)?;
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
        validate_combo(&input)?;
        if input.enabled {
            let protocol = ProviderProtocol::parse(&input.protocol)?;
            if !input.targets.iter().all(|target| {
                providers
                    .iter()
                    .find(|provider| {
                        provider.id == target.provider_id
                            && provider.tenant_id == tenant_id
                            && provider.enabled
                    })
                    .and_then(|provider| {
                        ProviderProtocol::from_upstream(&provider.upstream_url).ok()
                    })
                    == Some(protocol)
            }) {
                return Err("combo targets require enabled providers with the same protocol");
            }
        }
        let record = StoredCombo {
            id: id.to_owned(),
            tenant_id,
            protocol: input.protocol,
            strategy: input.strategy,
            fallback: input.fallback,
            targets_json: serde_json::to_string(&input.targets)
                .map_err(|_| "cannot encode combo targets")?,
            enabled: input.enabled,
            revision: revision()?,
        };
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
        let combo = self
            .0
            .database
            .combos()
            .await?
            .into_iter()
            .find(|combo| combo.id == id)
            .ok_or("combo configuration not found")?;
        if enforced_tenant.is_some_and(|tenant| tenant != combo.tenant_id) {
            return Err("combo tenant is unavailable");
        }
        let before = combo_view(&combo)?;
        let disabled_revision = revision()?;
        self.0.database.disable_combo(id, disabled_revision).await?;
        let mut disabled = combo.clone();
        disabled.enabled = false;
        disabled.revision = disabled_revision;
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
        validate_client_lists(&input)?;
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
        let native_quota = crate::native_usage::NativeQuota {
            max_tokens_per_minute: optional_limit(
                input.max_tokens_per_minute,
                9_007_199_254_740_991,
            )?,
            max_tokens_per_day: optional_limit(input.max_tokens_per_day, 9_007_199_254_740_991)?,
            max_monthly_microusd: optional_usd_micros(input.max_spend_per_month_usd)?,
            reservation_tokens: optional_limit(input.reservation_tokens, 9_007_199_254_740_991)?,
            reservation_microusd: optional_usd_micros(input.reservation_spend_usd)?,
        }
        .validate()?;
        if native_quota.enabled() && self.0.native_usage.read().await.is_none() {
            return Err("native usage quotas require SQLite storage");
        }
        let record = StoredClientKey {
            id: id.to_owned(),
            label: input.label,
            key_hash,
            enabled: input.enabled,
            expiry_unix,
            scopes_json: json_list(&input.scopes)?,
            allowed_endpoints_json: json_list(&input.allowed_endpoints)?,
            allowed_models_json: json_list(&input.allowed_models)?,
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
        if !matches!(export_type.as_str(), "bigquery" | "webhook") {
            return Err("unsupported usage export type");
        }
        if mode != "instant" || window_sec.is_some_and(|value| value != 0) {
            return Err("Rust usage exports currently support instant mode only");
        }
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
                if config.url.is_some() || config.secret.is_some() {
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
                            encrypt(secret.as_str(), &aad, self.0.encryption_key.as_str())?;
                        (ciphertext, secret)
                    }
                    _ => {
                        let stored = current.ok_or("BigQuery service account JSON is required")?;
                        let secret = decrypt(
                            &stored.service_account_ciphertext,
                            &aad,
                            self.0.encryption_key.as_str(),
                        )?;
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
                            encrypt(secret.as_str(), &aad, self.0.encryption_key.as_str())?;
                        (ciphertext, secret)
                    }
                    _ => {
                        let stored = current.ok_or("Webhook secret is required")?;
                        if stored.secret_ciphertext.is_empty() {
                            return Err("Webhook secret is required");
                        }
                        let secret = decrypt(
                            &stored.secret_ciphertext,
                            &aad,
                            self.0.encryption_key.as_str(),
                        )?;
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
            _ => unreachable!("usage export type was validated"),
        };
        Ok(StoredUsageExport {
            id: id.to_owned(),
            tenant_id,
            name,
            export_type,
            mode,
            window_sec: 0,
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
            provider: "red-router".to_owned(),
            model: "destination-test".to_owned(),
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
                let service_account_json = decrypt(
                    &record.service_account_ciphertext,
                    &aad,
                    self.0.encryption_key.as_str(),
                )?;
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
                let secret = decrypt(
                    &record.secret_ciphertext,
                    &aad,
                    self.0.encryption_key.as_str(),
                )?;
                crate::audit_export::send_usage_webhook_test(
                    id,
                    &record.name,
                    &webhook_usage_url(&record.config_json)?,
                    secret.as_str(),
                    &event,
                )
                .await?;
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
        signature_text(&mut digest, "redrouter-provider-runtime-v2");
        for record in self.0.database.providers().await? {
            signature_text(&mut digest, &record.id);
            signature_text(&mut digest, &record.tenant_id);
            signature_text(&mut digest, &record.provider);
            signature_text(&mut digest, &record.upstream_url);
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
                let credential = decrypt(
                    &record.credential_ciphertext,
                    &record.id,
                    self.0.encryption_key.as_str(),
                )?;
                let mut live = ProxyState::live_provider(
                    &record.upstream_url,
                    credential.as_str(),
                    self.0.allow_private,
                    auth_scheme,
                    provider_auth.expires_at_unix,
                )
                .await?;
                let circuit = self.circuit_for(&record.id, &record.upstream_url).await;
                live.in_flight = circuit.in_flight();
                live.circuit = Some(circuit);
                live.availability = Some(self.availability_for(&record.id).await);
                live.antigravity_project = antigravity_projects
                    .get(&(record.id.clone(), record.updated_at))
                    .cloned();
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
            ClientSnapshot::Current(Arc::new(ClientPolicies::from_stored(policies)))
        };
        *self.0.clients.write().await = snapshot;
        Ok(())
    }

    async fn refresh_routes(&self) -> Result<(), &'static str> {
        let records = self.0.database.combos().await?;
        if records.is_empty() {
            *self.0.routes.write().await = RouteSnapshot::Legacy;
            return Ok(());
        }
        let providers = self.0.database.providers().await?;
        let resilience = self.resilience_settings().await?;
        let auth = self.auth_settings().await?;
        let antigravity_projects = self.antigravity_projects().await?;
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
            let view = combo_view(record)?;
            let protocol = ProviderProtocol::parse(&record.protocol)?;
            let mut targets = Vec::new();
            for target in view.targets {
                let Some(provider) = providers.iter().find(|provider| {
                    provider.id == target.provider_id
                        && provider.tenant_id == record.tenant_id
                        && provider.enabled
                }) else {
                    continue;
                };
                if !live.contains_key(&provider.id) {
                    let provider_auth = auth
                        .get(&(provider.id.clone(), provider.updated_at))
                        .cloned()
                        .unwrap_or_else(|| default_provider_auth(provider));
                    let auth_scheme = ProviderAuthScheme::parse(&provider_auth.auth_scheme)?;
                    let credential = decrypt(
                        &provider.credential_ciphertext,
                        &provider.id,
                        self.0.encryption_key.as_str(),
                    )?;
                    let mut runtime = ProxyState::live_provider(
                        &provider.upstream_url,
                        credential.as_str(),
                        self.0.allow_private,
                        auth_scheme,
                        provider_auth.expires_at_unix,
                    )
                    .await?;
                    runtime.provider_id = Some(Arc::from(provider.id.clone()));
                    runtime.provider_name = Some(Arc::from(provider.provider.clone()));
                    runtime.antigravity_project = antigravity_projects
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
                    .is_none_or(|provider| provider.protocol != protocol)
                {
                    return Err("combo provider protocol changed");
                }
                let quota = self.quota_state(&provider.id).await;
                targets.push(ProxyState::control_target(
                    live.get(&provider.id).ok_or("combo provider unavailable")?,
                    target.model,
                    target.weight.unwrap_or(1),
                    target.input_cost_per_million,
                    target.output_cost_per_million,
                    target.context_window_tokens,
                    quota,
                ));
            }
            if targets.is_empty() {
                return Err("combo has no enabled provider targets");
            }
            let strategy = match record.strategy.as_str() {
                "priority" => RouteStrategy::Priority,
                "round-robin" => RouteStrategy::RoundRobin,
                "weighted" => RouteStrategy::Weighted,
                "random" => RouteStrategy::Random,
                "least-used" => RouteStrategy::LeastUsed,
                "p2c" => RouteStrategy::P2c,
                "fill-first" => RouteStrategy::FillFirst,
                "strict-random" => RouteStrategy::StrictRandom,
                "cost-optimized" => RouteStrategy::CostOptimized,
                "context-optimized" => RouteStrategy::ContextOptimized,
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
                    tenant_id: Arc::from(record.tenant_id.clone()),
                    targets,
                    protocol,
                    strategy,
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
        for combo_id in pins.keys() {
            if !retained_pins.contains(combo_id) {
                self.0.database.delete_route_pin(combo_id).await?;
            }
        }
        *self.0.routes.write().await = RouteSnapshot::Current(Arc::new(routes));
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
            RouteSnapshot::Current(routes) => routes.get(combo_id).cloned(),
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
            RouteSnapshot::Current(routes) => routes.get(combo_id).cloned(),
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
        if let RouteSnapshot::Current(routes) = &*self.0.routes.read().await {
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
                if !matches!(record.oauth_provider.as_str(), "codex" | "claude" | "agy")
                    || record.generation < 0
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
            let metadata = decrypt(
                &record.session_ciphertext,
                &aad,
                self.0.encryption_key.as_str(),
            )?;
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
        self.0
            .database
            .provider_quotas()
            .await?
            .iter()
            .filter(|quota| providers.contains(&quota.provider_id))
            .map(quota_view)
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
        let before = self.provider_health_snapshot(&provider).await?;
        self.circuit_for(&provider.id, &provider.upstream_url)
            .await
            .configure(
                input.failure_threshold,
                input.degradation_threshold,
                input.reset_timeout_ms,
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
        let created = Arc::new(ProviderCircuit::new(
            id,
            self.0.database.clone(),
            local_endpoint(upstream_url),
        ));
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
            let verifier = self.0.oidc.read().await.clone();
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
        let browser = self.0.oidc_browser.read().await.clone();
        let verifier = self.0.oidc.read().await.clone();
        let (Some(browser), Some(verifier)) = (browser, verifier) else {
            return None;
        };
        let expected_origin = browser.public_origin.origin().ascii_serialization();
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
        let Ok(session) = decrypt(
            &session_cookie,
            "oidc-browser-admin-session",
            self.0.encryption_key.as_str(),
        ) else {
            return None;
        };
        let Ok(session) = serde_json::from_str::<AdminSession>(&session) else {
            return None;
        };
        let Ok(now) = unix_time_seconds() else {
            return None;
        };
        if session.subject.is_empty()
            || session.subject.len() > 512
            || session.expires_at < now
            || session.revision != verifier.policy().revision
            || session.revision != browser.revision
        {
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
        ProviderProtocol::OpenAiToAnthropic => {
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
        ProviderAuthScheme::Auto => return Err("provider authentication is unresolved"),
    };
    if provider.protocol == ProviderProtocol::Anthropic {
        request = request.header("anthropic-version", "2023-06-01");
    }
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
        id: record.id.clone(),
        tenant_id: record.tenant_id.clone(),
        provider: record.provider.clone(),
        upstream_url: record.upstream_url.clone(),
        enabled: record.enabled,
        revision: record.updated_at.to_string(),
        has_credential: !record.credential_ciphertext.is_empty(),
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
    let expires_at_unix = match record.expiry_unix {
        0 => None,
        value if value > 0 => Some(value as u64),
        _ => return Err("invalid client key expiry"),
    };
    Ok(ClientKeyView {
        id: record.id.clone(),
        label: record.label.clone(),
        tenant_id: record.tenant_id.clone(),
        created_by: record.created_by.clone(),
        model_id_format: validate_model_id_format(&record.model_id_format)?.to_owned(),
        enabled: record.enabled,
        expires_at_unix,
        scopes: parse_list(&record.scopes_json)?,
        allowed_endpoints: parse_list(&record.allowed_endpoints_json)?,
        allowed_models: parse_list(&record.allowed_models_json)?,
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
        _ => return Err("invalid usage export configuration"),
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
        "nextWindowEnd": null,
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

fn combo_view(record: &StoredCombo) -> Result<ComboView, &'static str> {
    let targets: Vec<ComboTarget> = if record.targets_json.len() <= 256 * 1024 {
        serde_json::from_str(&record.targets_json).map_err(|_| "invalid combo targets")?
    } else {
        return Err("invalid combo targets");
    };
    let input = ComboInput {
        tenant_id: Some(record.tenant_id.clone()),
        protocol: record.protocol.clone(),
        strategy: record.strategy.clone(),
        fallback: record.fallback,
        targets: targets.clone(),
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
        enabled: record.enabled,
        revision: record.revision.to_string(),
        last_known_good: None,
    })
}

fn provider_audit_snapshot(record: &StoredProvider) -> serde_json::Value {
    serde_json::json!({
        "id": record.id,
        "tenant_id": record.tenant_id,
        "provider": record.provider,
        "enabled": record.enabled,
        "revision": record.updated_at.to_string(),
        "has_credential": true
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
        session: quota_window_view(record.session_remaining_ppm, record.session_reset_unix_ms),
        weekly: quota_window_view(record.weekly_remaining_ppm, record.weekly_reset_unix_ms),
        limit_reached: record.limit_reached,
        observed_at_unix_ms: record.observed_at_unix_ms as u64,
        expires_at_unix_ms: record.expires_at_unix_ms as u64,
        revision: record.revision.to_string(),
    })
}

fn stored_policy(record: &StoredClientKey) -> Result<StoredPolicy, &'static str> {
    let decoded = hex::decode(&record.key_hash).map_err(|_| "invalid client key hash")?;
    let key_hash: [u8; 32] = decoded.try_into().map_err(|_| "invalid client key hash")?;
    let view = client_view(record)?;
    validate_scope_list(&view.scopes)?;
    validate_endpoint_list(&view.allowed_endpoints)?;
    validate_patterns(&view.allowed_models)?;
    validate_patterns(&view.blocked_models)?;
    for id in &view.allowed_provider_ids {
        validate_id(id)?;
    }
    Ok(StoredPolicy {
        id: record.id.clone(),
        name: record.label.clone(),
        tenant_id: record.tenant_id.clone(),
        model_id_format: view.model_id_format,
        key_hash,
        enabled: record.enabled,
        expires_at_unix: view.expires_at_unix,
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

fn validate_client_lists(input: &ClientKeyInput) -> Result<(), &'static str> {
    validate_scope_list(&input.scopes)?;
    validate_endpoint_list(&input.allowed_endpoints)?;
    validate_patterns(&input.allowed_models)?;
    validate_patterns(&input.blocked_models)?;
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

fn validate_model_id_format(value: &str) -> Result<&str, &'static str> {
    match value {
        "prefixed" | "flat" => Ok(value),
        _ => Err("client key model ID format must be prefixed or flat"),
    }
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

fn validate_patterns(values: &[String]) -> Result<(), &'static str> {
    if values.len() > 128 {
        return Err("too many client key model patterns");
    }
    for pattern in values {
        if pattern.is_empty()
            || pattern.len() > 256
            || (pattern != "*"
                && pattern.contains('*')
                && !(pattern.ends_with("/*") && !pattern[..pattern.len() - 1].contains('*')))
        {
            return Err("invalid client key model pattern");
        }
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
            | "round-robin"
            | "weighted"
            | "random"
            | "least-used"
            | "p2c"
            | "fill-first"
            | "strict-random"
            | "cost-optimized"
            | "context-optimized"
            | "reset-aware"
            | "reset-window"
            | "headroom"
            | "quota-weighted"
            | "lkgp"
    ) {
        return Err("unsupported combo strategy");
    }
    if input.targets.is_empty() || input.targets.len() > 8 {
        return Err("combo targets must contain 1-8 entries");
    }
    for target in &input.targets {
        validate_id(&target.provider_id)?;
        if target.model.is_empty()
            || target.model.len() > 256
            || target.model.chars().any(char::is_control)
            || (matches!(
                protocol,
                ProviderProtocol::Gemini | ProviderProtocol::Antigravity
            ) && !crate::valid_gemini_model(&target.model))
        {
            return Err("invalid combo target model");
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
        input.targets[..index]
            .iter()
            .any(|other| other.provider_id == target.provider_id && other.model == target.model)
    }) {
        return Err("combo contains duplicate targets");
    }
    Ok(())
}

fn enrich_combo_metadata(
    input: &mut ComboInput,
    providers: &[StoredProvider],
    catalog: &crate::catalog::ModelCatalog,
) -> Result<(), &'static str> {
    for target in &mut input.targets {
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

fn validate_provider(value: &str) -> Result<(), &'static str> {
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

fn validate_provider_label(value: &str) -> Result<(), &'static str> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err("provider connection label must be 1-128 characters");
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

fn parse_codex_auth(raw: serde_json::Value) -> Result<ParsedCodexAuth, &'static str> {
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

fn parse_claude_auth(raw: serde_json::Value) -> Result<ParsedClaudeAuth, &'static str> {
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

fn parse_agy_auth(raw: serde_json::Value) -> Result<ParsedAgyAuth, &'static str> {
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

fn encrypt(value: &str, id: &str, secret: &str) -> Result<String, &'static str> {
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

pub async fn auth_config(State(state): State<ProxyState>) -> Response {
    let (control_plane_enabled, oidc_browser_login) = match &state.control_plane {
        Some(control) => (true, control.oidc_browser_enabled().await),
        None => (false, false),
    };
    let mut response = Json(serde_json::json!({
        "backend":"rust",
        "control_plane_enabled":control_plane_enabled,
        "oidc_browser_login":oidc_browser_login,
        "password_login":false
    }))
    .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );
    response
}

pub async fn oidc_login(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Query(query): Query<OidcLoginQuery>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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

pub async fn usage_export_types(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
                "modes": ["instant"],
                "fields": [
                    {"key":"url","labelFallback":"Webhook URL","type":"text","required":true,"placeholder":"https://billing.example.com/hooks/redrouter","helpFallback":"Public HTTPS only; credentials, query strings, redirects and private addresses are refused."},
                    {"key":"secret","labelFallback":"Signing secret","type":"password","required":true,"secret":true,"placeholder":"whsec_...","helpFallback":"Write-only and encrypted at rest. Used for webhook-signature HMAC-SHA256."}
                ]
            },
            {
                "type": "bigquery",
                "label": "Google BigQuery",
                "description": "Exports attributed token and spend reports from the Rust usage ledger.",
                "modes": ["instant"],
                "fields": [
                    {"key":"projectId","labelFallback":"Project ID","type":"text","required":true},
                    {"key":"datasetId","labelFallback":"Dataset ID","type":"text","required":true},
                    {"key":"tableId","labelFallback":"Table ID","type":"text","required":true},
                    {"key":"serviceAccountJson","labelFallback":"Service account JSON","type":"textarea","required":true,"secret":true,"helpFallback":"Write-only; the credential is encrypted at rest."},
                    {"key":"batchSize","labelFallback":"Batch size","type":"number","placeholder":"500"},
                    {"key":"intervalSeconds","labelFallback":"Interval (seconds)","type":"number","placeholder":"10"}
                ]
            }
        ],
        "windowSizesSec": []
    }))
    .into_response()
}

pub async fn list_usage_exports(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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

pub async fn get_usage_report(
    State(state): State<ProxyState>,
    headers: HeaderMap,
    Query(query): Query<UsageReportQuery>,
) -> Response {
    const REPORT_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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

pub async fn list_tenants(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
    };
    if !control.authorized(&headers).await {
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
    };
    if !control.authorized(&headers).await {
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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

pub async fn get_model_catalog_provider(
    State(state): State<ProxyState>,
    Path(provider): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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

pub async fn list_provider_quotas(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .configure_provider_as(&id, input, None, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(provider) => Json(serde_json::json!({"provider":provider})).into_response(),
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control.start_provider_oauth_as(
        &provider,
        query.redirect_uri.as_deref(),
        &scope.actor,
        scope.tenant_id.as_deref(),
    ) {
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .import_codex_auth_as(input, &scope.actor, scope.tenant_id.as_deref())
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .import_claude_auth_as(input, &scope.actor, scope.tenant_id.as_deref())
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .import_agy_auth_as(input, &scope.actor, scope.tenant_id.as_deref())
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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

pub async fn delete_provider_quota(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .disable_as(&id, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) if is_runtime_error(error) || error == "cannot disable provider" => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider storage unavailable",
        ),
        Err(_) => api_error(StatusCode::BAD_REQUEST, "Invalid provider identifier"),
    }
}

pub async fn put_combo(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ComboInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
        return api_error(StatusCode::NOT_FOUND, "Rust control plane is disabled");
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
    fn combo_metadata_uses_models_dev_without_overriding_operator_values() {
        let providers = vec![StoredProvider {
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
                provider_id: "first".to_owned(),
                model: "gpt-3.5-turbo".to_owned(),
                weight: None,
                input_cost_per_million: Some(99.0),
                output_cost_per_million: None,
                context_window_tokens: None,
            }],
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
            mode: "instant".to_owned(),
            window_sec: 0,
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
        assert!(!encoded.contains("webhook-secret-ciphertext"));
    }

    #[test]
    fn dashboard_number_fields_accept_strings_and_numbers() {
        assert_eq!(UnsignedInput::Text("500".to_owned()).value().unwrap(), 500);
        assert_eq!(UnsignedInput::Number(10).value().unwrap(), 10);
        assert!(UnsignedInput::Text("ten".to_owned()).value().is_err());
    }
}
