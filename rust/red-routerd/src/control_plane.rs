//! Authenticated Rust control plane for provider persistence and live reload.
use crate::{
    availability::{AvailabilityStatus, ProviderAvailability},
    circuit::{BreakerStatus, ProviderCircuit},
    policy::{ClientPolicies, StoredPolicy},
    resilience::RateLimitScope,
    storage::{
        StoredClientKey, StoredCombo, StoredIdentityBinding, StoredModelCatalogSnapshot,
        StoredOidcBrowserConfig, StoredOidcConfig, StoredProvider, StoredProviderQuota,
        StoredResilience, StoredRoutePin, StoredTenant,
    },
    LiveProvider, ModelRoute, ProviderProtocol, ProxyState, RouteStrategy, TargetQuota,
};
use aes_gcm::aead::consts::U16;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    aes::Aes256,
    AesGcm, Nonce,
};
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::RwLock;
use zeroize::{Zeroize, Zeroizing};

type ControlCipher = AesGcm<Aes256, U16>;
const MODEL_CATALOG_SYNC_INTERVAL: Duration = Duration::from_secs(5);
const CLIENT_POLICY_SYNC_INTERVAL: Duration = Duration::from_secs(2);

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
    catalog: RwLock<CatalogState>,
    catalog_refresh: tokio::sync::Mutex<()>,
    catalog_client: reqwest::Client,
    catalog_source: reqwest::Url,
    native_usage: RwLock<Option<crate::native_usage::NativeUsage>>,
    mutation: tokio::sync::Mutex<()>,
    admin_hash: [u8; 32],
    encryption_key: Zeroizing<String>,
    allow_private: bool,
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
    pub subject: String,
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
        let native_usage = if database.is_sqlite().await {
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
            native_usage: RwLock::new(native_usage),
            mutation: tokio::sync::Mutex::new(()),
            admin_hash: Sha256::digest(admin_key.as_bytes()).into(),
            encryption_key: Zeroizing::new(encryption_key.to_owned()),
            allow_private,
        }));
        plane.refresh().await?;
        plane.refresh_clients().await?;
        plane.refresh_routes().await?;
        plane.spawn_model_catalog_sync(catalog_poll_interval);
        plane.spawn_client_policy_sync(CLIENT_POLICY_SYNC_INTERVAL);
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
        let quota = identity
            .usage_quota
            .ok_or("native usage quota is unavailable")?;
        let usage = self
            .0
            .native_usage
            .read()
            .await
            .clone()
            .ok_or("native usage storage unavailable")?;
        let prices = self.native_usage_prices(provider, model).await?;
        if quota.max_monthly_microusd > 0 && prices.is_none() {
            return Err("native spend quota requires catalog pricing");
        }
        let event_id = format!("usage_{}", random_token(16)?);
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
                tenant_id: &identity.tenant_id,
                provider,
                model,
                usage: usage_event,
                prices,
                now_ms: unix_time_ms()?,
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
        self.configure_provider_as(id, input, None).await
    }

    async fn configure_provider_as(
        &self,
        id: &str,
        input: ProviderInput,
        enforced_tenant: Option<&str>,
    ) -> Result<ProviderView, &'static str> {
        validate_id(id)?;
        validate_provider(&input.provider)?;
        if !(1..=512).contains(&input.api_key.len()) {
            return Err("provider API key must be 1-512 bytes");
        }
        if input.upstream_url.len() > 2048 {
            return Err("provider upstream URL is too long");
        }
        let rate_limit_scope = RateLimitScope::parse(&input.rate_limit_scope)?;
        // Resolve and pin DNS before changing durable or live configuration.
        let api_key = Zeroizing::new(input.api_key);
        let live =
            ProxyState::live_provider(&input.upstream_url, api_key.as_str(), self.0.allow_private)
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
        self.0
            .database
            .upsert_provider_resilience(&resilience)
            .await?;
        self.0.database.upsert_provider(&stored).await?;
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
        Ok(view(&stored, rate_limit_scope))
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
        if let Some(browser) = &browser_record {
            self.0.database.upsert_oidc_browser(browser).await?;
        } else if input.clear_browser {
            self.0.database.delete_oidc_browser().await?;
        }
        self.0.database.upsert_oidc(&record).await?;
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
        *self.0.oidc.write().await = Some(Arc::new(verifier));
        *self.0.oidc_browser.write().await = browser.clone();
        oidc_stored_view(&stored, browser.as_deref())
    }

    pub async fn delete_oidc(&self) -> Result<(), &'static str> {
        let _mutation = self.0.mutation.lock().await;
        self.0.database.delete_oidc_browser().await?;
        self.0.database.delete_oidc().await?;
        *self.0.oidc.write().await = None;
        *self.0.oidc_browser.write().await = None;
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
        let subject = verifier
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
        let binding = bindings
            .iter()
            .find(|binding| {
                binding.enabled && binding.subject == subject && binding.role == "admin"
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
            subject,
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
        self.disable_as(id, None).await
    }

    async fn disable_as(
        &self,
        id: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<(), &'static str> {
        validate_id(id)?;
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
            .get(&(provider.id, provider.updated_at))
            .copied()
            .unwrap_or_default();
        let revision = revision()?;
        self.0
            .database
            .upsert_provider_resilience(&StoredResilience {
                provider_id: id.to_owned(),
                rate_limit_scope: scope.as_str().to_owned(),
                revision,
            })
            .await?;
        self.0.database.disable_provider(id, revision).await?;
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
        self.configure_combo_as(id, input, None).await
    }

    async fn configure_combo_as(
        &self,
        id: &str,
        mut input: ComboInput,
        enforced_tenant: Option<&str>,
    ) -> Result<ComboView, &'static str> {
        validate_id(id)?;
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
        if let Err(error) = self.refresh_routes().await {
            *self.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        combo_view(&record)
    }

    pub async fn disable_combo(&self, id: &str) -> Result<(), &'static str> {
        self.disable_combo_as(id, None).await
    }

    async fn disable_combo_as(
        &self,
        id: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<(), &'static str> {
        validate_id(id)?;
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
        self.0.database.disable_combo(id, revision()?).await?;
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
        self.configure_provider_quota_as(provider_id, input, None)
            .await
    }

    async fn configure_provider_quota_as(
        &self,
        provider_id: &str,
        input: ProviderQuotaInput,
        enforced_tenant: Option<&str>,
    ) -> Result<ProviderQuotaView, &'static str> {
        validate_id(provider_id)?;
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
        self.0.database.upsert_provider_quota(&record).await?;
        self.quota_state(provider_id).await.update(&record);
        quota_view(&record)
    }

    pub async fn clear_provider_quota(&self, provider_id: &str) -> Result<(), &'static str> {
        self.clear_provider_quota_as(provider_id, None).await
    }

    async fn clear_provider_quota_as(
        &self,
        provider_id: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<(), &'static str> {
        validate_id(provider_id)?;
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
        self.0.database.delete_provider_quota(provider_id).await?;
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
        if self.refresh_clients().await.is_err() {
            *self.0.clients.write().await = ClientSnapshot::Unavailable;
            return Err("cannot reload client key configuration");
        }
        client_view(&record)
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
        validate_id(id)?;
        validate_tenant_slug(&input.slug)?;
        validate_tenant_name(&input.name)?;
        if id == "red" && !input.enabled {
            return Err("default tenant cannot be disabled");
        }
        let _mutation = self.0.mutation.lock().await;
        let tenants = self.0.database.tenants().await?;
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
        if self.refresh_clients().await.is_err() {
            *self.0.clients.write().await = ClientSnapshot::Unavailable;
            return Err("cannot reload client key configuration");
        }
        Ok(tenant_view(&record))
    }

    pub async fn configure_identity_binding(
        &self,
        id: &str,
        input: IdentityBindingInput,
    ) -> Result<IdentityBindingView, &'static str> {
        validate_id(id)?;
        validate_bound_subject(&input.subject)?;
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
        if bindings
            .iter()
            .any(|binding| binding.id != id && binding.subject == input.subject)
        {
            return Err("identity subject is already bound");
        }
        let record = StoredIdentityBinding {
            id: id.to_owned(),
            subject: input.subject,
            tenant_id: input.tenant_id,
            role: input.role,
            enabled: input.enabled,
            revision: revision()?,
        };
        self.0.database.upsert_identity_binding(&record).await?;
        Ok(identity_binding_view(&record))
    }

    pub async fn revoke_client_key(&self, id: &str) -> Result<(), &'static str> {
        self.revoke_client_key_as(id, None).await
    }

    async fn revoke_client_key_as(
        &self,
        id: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<(), &'static str> {
        validate_id(id)?;
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
        self.0.database.revoke_client_key(id, revision()?).await?;
        if self.refresh_clients().await.is_err() {
            *self.0.clients.write().await = ClientSnapshot::Unavailable;
            return Err("cannot reload client key configuration");
        }
        Ok(())
    }

    async fn refresh(&self) -> Result<(), &'static str> {
        let resilience = self.resilience_settings().await?;
        let live = match self.0.database.active_provider().await? {
            Some(record) => {
                let rate_limit_scope = resilience
                    .get(&(record.id.clone(), record.updated_at))
                    .copied()
                    .unwrap_or_default();
                let credential = decrypt(
                    &record.credential_ciphertext,
                    &record.id,
                    self.0.encryption_key.as_str(),
                )?;
                let mut live = ProxyState::live_provider(
                    &record.upstream_url,
                    credential.as_str(),
                    self.0.allow_private,
                )
                .await?;
                let circuit = self.circuit_for(&record.id, &record.upstream_url).await;
                live.in_flight = circuit.in_flight();
                live.circuit = Some(circuit);
                live.availability = Some(self.availability_for(&record.id).await);
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
                    let credential = decrypt(
                        &provider.credential_ciphertext,
                        &provider.id,
                        self.0.encryption_key.as_str(),
                    )?;
                    let mut runtime = ProxyState::live_provider(
                        &provider.upstream_url,
                        credential.as_str(),
                        self.0.allow_private,
                    )
                    .await?;
                    runtime.provider_id = Some(Arc::from(provider.id.clone()));
                    runtime.provider_name = Some(Arc::from(provider.provider.clone()));
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
        enforced_tenant: Option<&str>,
    ) -> Result<(), &'static str> {
        validate_id(combo_id)?;
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
        self.0.database.delete_route_pin(combo_id).await
    }

    async fn views(&self, tenant_id: Option<&str>) -> Result<Vec<ProviderView>, &'static str> {
        let resilience = self.resilience_settings().await?;
        self.0.database.providers().await.map(|rows| {
            rows.iter()
                .filter(|record| tenant_id.is_none_or(|tenant| tenant == record.tenant_id))
                .map(|record| {
                    view(
                        record,
                        resilience
                            .get(&(record.id.clone(), record.updated_at))
                            .copied()
                            .unwrap_or_default(),
                    )
                })
                .collect()
        })
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

    async fn reset_breaker_as(
        &self,
        id: &str,
        enforced_tenant: Option<&str>,
    ) -> Result<(), &'static str> {
        validate_id(id)?;
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
        self.availability_for(&provider.id).await.reset().await?;
        self.circuit_for(&provider.id, &provider.upstream_url)
            .await
            .reset()
            .await
    }

    async fn configure_breaker_as(
        &self,
        id: &str,
        input: ProviderHealthInput,
        enforced_tenant: Option<&str>,
    ) -> Result<BreakerStatus, &'static str> {
        validate_id(id)?;
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
        self.circuit_for(&provider.id, &provider.upstream_url)
            .await
            .configure(
                input.failure_threshold,
                input.degradation_threshold,
                input.reset_timeout_ms,
            )
            .await
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
        if actor == "bootstrap-admin" {
            return Some(ManagementScope {
                actor,
                tenant_id: None,
            });
        }
        let bindings = self.0.database.identity_bindings().await.ok()?;
        let binding = bindings.iter().find(|binding| {
            binding.enabled
                && binding.subject == actor
                && matches!(binding.role.as_str(), "admin" | "tenant-admin")
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
                actor,
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
        if actor == "bootstrap-admin" {
            return Some(actor);
        }
        let bindings = self.0.database.identity_bindings().await.ok()?;
        let binding = bindings.iter().find(|binding| {
            binding.enabled
                && binding.subject == actor
                && binding.tenant_id == tenant_id
                && matches!(binding.role.as_str(), "admin" | "tenant-admin" | "issuer")
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
            Some(actor)
        } else {
            None
        }
    }

    async fn authorized_actor(&self, headers: &HeaderMap) -> Option<String> {
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
                    return Some("bootstrap-admin".to_owned());
                }
            }
            let verifier = self.0.oidc.read().await.clone();
            return match verifier {
                Some(verifier) => verifier.verify(candidate).await.ok(),
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
            Some(session.subject)
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

fn view(record: &StoredProvider, rate_limit_scope: RateLimitScope) -> ProviderView {
    ProviderView {
        id: record.id.clone(),
        tenant_id: record.tenant_id.clone(),
        provider: record.provider.clone(),
        upstream_url: record.upstream_url.clone(),
        enabled: record.enabled,
        revision: record.updated_at.to_string(),
        has_credential: !record.credential_ciphertext.is_empty(),
        rate_limit_scope: rate_limit_scope.as_str().to_owned(),
    }
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
            || (protocol == ProviderProtocol::Gemini && !crate::valid_gemini_model(&target.model))
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

fn decrypt(stored: &str, id: &str, secret: &str) -> Result<Zeroizing<String>, &'static str> {
    let parts: Vec<_> = stored.split(':').collect();
    if parts.len() != 5 || parts[0] != "rr" || parts[1] != "v1" || stored.len() > 8192 {
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
        .reset_breaker_as(&id, scope.tenant_id.as_deref())
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
        .configure_breaker_as(&id, input, scope.tenant_id.as_deref())
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
        .configure_provider_as(&id, input, scope.tenant_id.as_deref())
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

fn is_runtime_error(error: &str) -> bool {
    error.contains("database")
        || error.contains("provider configuration")
        || error.contains("active provider")
        || error.contains("encrypted provider credential")
        || error.contains("decrypt")
        || error.contains("storage encryption")
        || error.contains("cannot write")
        || error.contains("cannot read")
        || error.contains("cannot reload")
        || error.contains("breaker storage")
        || error.contains("route pin")
        || error.contains("quota state")
        || error.contains("combo has no enabled")
        || error.contains("combo provider unavailable")
        || error.contains("cannot generate client key")
        || error.contains("OIDC")
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
        .configure_provider_quota_as(&id, input, scope.tenant_id.as_deref())
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
        .clear_provider_quota_as(&id, scope.tenant_id.as_deref())
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
    match control.disable_as(&id, scope.tenant_id.as_deref()).await {
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
        .configure_combo_as(&id, input, scope.tenant_id.as_deref())
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
        .disable_combo_as(&id, scope.tenant_id.as_deref())
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
        .clear_route_pin(&id, scope.tenant_id.as_deref())
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
    if !control.authorized(&headers).await {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    match control.configure_tenant(&id, input).await {
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
    if !control.authorized(&headers).await {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    }
    match control.configure_identity_binding(&id, input).await {
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
        .revoke_client_key_as(&id, scope.tenant_id.as_deref())
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
}
