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
const UPSERT_PROVIDER: &str = "INSERT INTO redrouter_control_providers (id, provider, upstream_url, credential_ciphertext, enabled, revision) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET provider = $2, upstream_url = $3, credential_ciphertext = $4, enabled = $5, revision = $6";
const DISABLE_PROVIDER: &str =
    "UPDATE redrouter_control_providers SET enabled = 0, revision = $2 WHERE id = $1";
const CREATE_PROVIDER_OWNERSHIP: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_provider_ownership (provider_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, revision BIGINT NOT NULL)";
const LIST_PROVIDER_OWNERSHIP: &str = "SELECT provider_id, tenant_id, revision FROM redrouter_control_provider_ownership ORDER BY provider_id ASC";
const UPSERT_PROVIDER_OWNERSHIP: &str = "INSERT INTO redrouter_control_provider_ownership (provider_id, tenant_id, revision) VALUES ($1,$2,$3) ON CONFLICT (provider_id) DO UPDATE SET tenant_id = $2, revision = $3";
const CREATE_PROVIDER_AUTH: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_provider_auth (record_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, auth_scheme TEXT NOT NULL, label TEXT NOT NULL, account_email TEXT NOT NULL, expires_at_unix BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_PROVIDER_AUTH: &str = "SELECT provider_id, auth_scheme, label, account_email, expires_at_unix, revision FROM redrouter_control_provider_auth ORDER BY provider_id ASC, revision DESC";
const UPSERT_PROVIDER_AUTH: &str = "INSERT INTO redrouter_control_provider_auth (record_id, provider_id, auth_scheme, label, account_email, expires_at_unix, revision) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (record_id) DO UPDATE SET auth_scheme = $3, label = $4, account_email = $5, expires_at_unix = $6";
const DELETE_PROVIDER_AUTH: &str =
    "DELETE FROM redrouter_control_provider_auth WHERE provider_id = $1";
const CREATE_PROVIDER_OAUTH: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_provider_oauth (provider_id TEXT PRIMARY KEY, oauth_provider TEXT NOT NULL, refresh_token_ciphertext TEXT NOT NULL, generation BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_PROVIDER_OAUTH: &str = "SELECT provider_id, oauth_provider, refresh_token_ciphertext, generation, revision FROM redrouter_control_provider_oauth ORDER BY provider_id ASC";
const UPSERT_PROVIDER_OAUTH: &str = "INSERT INTO redrouter_control_provider_oauth (provider_id, oauth_provider, refresh_token_ciphertext, generation, revision) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (provider_id) DO UPDATE SET oauth_provider = $2, refresh_token_ciphertext = $3, generation = $4, revision = $5";
const DELETE_PROVIDER_OAUTH: &str =
    "DELETE FROM redrouter_control_provider_oauth WHERE provider_id = $1";
const CREATE_PROVIDER_OAUTH_STATUS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_provider_oauth_status (provider_id TEXT PRIMARY KEY, revision BIGINT NOT NULL, generation BIGINT NOT NULL, refresh_state TEXT NOT NULL, error_code TEXT NOT NULL, observed_at_unix BIGINT NOT NULL)";
const LIST_PROVIDER_OAUTH_STATUS: &str = "SELECT provider_id, revision, generation, refresh_state, error_code, observed_at_unix FROM redrouter_control_provider_oauth_status ORDER BY provider_id ASC";
const UPSERT_PROVIDER_OAUTH_STATUS: &str = "INSERT INTO redrouter_control_provider_oauth_status (provider_id, revision, generation, refresh_state, error_code, observed_at_unix) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provider_id) DO UPDATE SET revision = $2, generation = $3, refresh_state = $4, error_code = $5, observed_at_unix = $6";
const DELETE_PROVIDER_OAUTH_STATUS: &str =
    "DELETE FROM redrouter_control_provider_oauth_status WHERE provider_id = $1";
const CREATE_OAUTH_REFRESH_LEASES: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_oauth_refresh_leases (rotation_group TEXT PRIMARY KEY, owner TEXT NOT NULL, lease_until_unix_ms BIGINT NOT NULL, next_allowed_unix_ms BIGINT NOT NULL)";
const CREATE_CLIENT_KEYS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_client_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, key_hash TEXT NOT NULL, enabled BIGINT NOT NULL, expiry_unix BIGINT NOT NULL, scopes_json TEXT NOT NULL, allowed_endpoints_json TEXT NOT NULL, allowed_models_json TEXT NOT NULL, blocked_models_json TEXT NOT NULL, allowed_provider_ids_json TEXT NOT NULL, max_concurrent BIGINT NOT NULL, max_rpm BIGINT NOT NULL, max_rpd BIGINT NOT NULL, revision BIGINT NOT NULL)";
const CREATE_CLIENT_KEY_PREFERENCES: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_client_key_preferences (key_id TEXT PRIMARY KEY, model_id_format TEXT NOT NULL, revision BIGINT NOT NULL)";
const LIST_CLIENT_KEYS: &str = "SELECT id, label, key_hash, enabled, expiry_unix, scopes_json, allowed_endpoints_json, allowed_models_json, blocked_models_json, allowed_provider_ids_json, max_concurrent, max_rpm, max_rpd, revision FROM redrouter_control_client_keys ORDER BY revision DESC, id ASC";
const LIST_CLIENT_KEY_PREFERENCES: &str = "SELECT key_id, model_id_format, revision FROM redrouter_control_client_key_preferences ORDER BY key_id ASC";
const UPSERT_CLIENT_KEY: &str = "INSERT INTO redrouter_control_client_keys (id, label, key_hash, enabled, expiry_unix, scopes_json, allowed_endpoints_json, allowed_models_json, blocked_models_json, allowed_provider_ids_json, max_concurrent, max_rpm, max_rpd, revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (id) DO UPDATE SET label = $2, key_hash = $3, enabled = $4, expiry_unix = $5, scopes_json = $6, allowed_endpoints_json = $7, allowed_models_json = $8, blocked_models_json = $9, allowed_provider_ids_json = $10, max_concurrent = $11, max_rpm = $12, max_rpd = $13, revision = $14";
const UPSERT_CLIENT_KEY_PREFERENCE: &str = "INSERT INTO redrouter_control_client_key_preferences (key_id, model_id_format, revision) VALUES ($1,$2,$3) ON CONFLICT (key_id) DO UPDATE SET model_id_format = $2, revision = $3";
const CREATE_TENANTS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, enabled BIGINT NOT NULL, revision BIGINT NOT NULL)";
const SEED_DEFAULT_TENANT: &str = "INSERT INTO redrouter_control_tenants (id, slug, name, enabled, revision) VALUES ('red','red','Red',1,0) ON CONFLICT (id) DO NOTHING";
const LIST_TENANTS: &str = "SELECT id, slug, name, enabled, revision FROM redrouter_control_tenants ORDER BY revision DESC, id ASC";
const UPSERT_TENANT: &str = "INSERT INTO redrouter_control_tenants (id, slug, name, enabled, revision) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET slug = $2, name = $3, enabled = $4, revision = $5";
const CREATE_IDENTITY_BINDINGS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_identity_bindings (id TEXT PRIMARY KEY, subject TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, binding_role TEXT NOT NULL, enabled BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_IDENTITY_BINDINGS: &str = "SELECT id, subject, tenant_id, binding_role, enabled, revision FROM redrouter_control_identity_bindings ORDER BY revision DESC, id ASC";
const UPSERT_IDENTITY_BINDING: &str = "INSERT INTO redrouter_control_identity_bindings (id, subject, tenant_id, binding_role, enabled, revision) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET subject = $2, tenant_id = $3, binding_role = $4, enabled = $5, revision = $6";
const CREATE_CLIENT_KEY_OWNERSHIP: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_client_key_ownership (key_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, created_by TEXT NOT NULL, revision BIGINT NOT NULL)";
const LIST_CLIENT_KEY_OWNERSHIP: &str = "SELECT key_id, tenant_id, created_by, revision FROM redrouter_control_client_key_ownership ORDER BY key_id ASC";
const UPSERT_CLIENT_KEY_OWNERSHIP: &str = "INSERT INTO redrouter_control_client_key_ownership (key_id, tenant_id, created_by, revision) VALUES ($1,$2,$3,$4) ON CONFLICT (key_id) DO UPDATE SET tenant_id = $2, created_by = $3, revision = $4";
const CREATE_CLIENT_KEY_QUOTAS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_client_key_quotas (key_id TEXT PRIMARY KEY, max_tokens_per_minute BIGINT NOT NULL, max_tokens_per_day BIGINT NOT NULL, max_monthly_microusd BIGINT NOT NULL, reservation_tokens BIGINT NOT NULL, reservation_microusd BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_CLIENT_KEY_QUOTAS: &str = "SELECT key_id, max_tokens_per_minute, max_tokens_per_day, max_monthly_microusd, reservation_tokens, reservation_microusd, revision FROM redrouter_control_client_key_quotas ORDER BY key_id ASC";
const UPSERT_CLIENT_KEY_QUOTA: &str = "INSERT INTO redrouter_control_client_key_quotas (key_id, max_tokens_per_minute, max_tokens_per_day, max_monthly_microusd, reservation_tokens, reservation_microusd, revision) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (key_id) DO UPDATE SET max_tokens_per_minute = $2, max_tokens_per_day = $3, max_monthly_microusd = $4, reservation_tokens = $5, reservation_microusd = $6, revision = $7";
const CREATE_USAGE_RESERVATIONS: &str = "CREATE TABLE IF NOT EXISTS redrouter_usage_reservations (event_id TEXT PRIMARY KEY, key_id TEXT NOT NULL, tenant_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, reserved_tokens BIGINT NOT NULL, reserved_microusd BIGINT NOT NULL, created_at_unix_ms BIGINT NOT NULL, state TEXT NOT NULL)";
const CREATE_USAGE_LEDGER: &str = "CREATE TABLE IF NOT EXISTS redrouter_usage_ledger (event_id TEXT PRIMARY KEY, key_id TEXT NOT NULL, tenant_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, tokens_input BIGINT NOT NULL, tokens_output BIGINT NOT NULL, tokens_cache_read BIGINT NOT NULL, tokens_cache_creation BIGINT NOT NULL, tokens_reasoning BIGINT NOT NULL, amount_microusd BIGINT NOT NULL, pricing_known BIGINT NOT NULL, pricing_snapshot TEXT, created_at_unix_ms BIGINT NOT NULL)";
const CREATE_USAGE_COUNTERS: &str = "CREATE TABLE IF NOT EXISTS redrouter_usage_counters (key_id TEXT NOT NULL, minute_bucket BIGINT NOT NULL, consumed_tokens BIGINT NOT NULL, updated_at_unix_ms BIGINT NOT NULL, PRIMARY KEY (key_id, minute_bucket))";
const CREATE_USAGE_RESERVATIONS_KEY_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_usage_reservations_key_time ON redrouter_usage_reservations (key_id, created_at_unix_ms)";
const CREATE_USAGE_RESERVATIONS_TENANT_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_usage_reservations_tenant_time ON redrouter_usage_reservations (tenant_id, created_at_unix_ms DESC)";
const CREATE_USAGE_LEDGER_KEY_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_usage_ledger_key_time ON redrouter_usage_ledger (key_id, created_at_unix_ms DESC, event_id DESC)";
const CREATE_USAGE_LEDGER_TENANT_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_usage_ledger_tenant_time ON redrouter_usage_ledger (tenant_id, created_at_unix_ms DESC, event_id DESC)";
const CREATE_USAGE_LEDGER_TENANT_KEY_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_usage_ledger_tenant_key_time ON redrouter_usage_ledger (tenant_id, key_id, created_at_unix_ms DESC, event_id DESC)";
const CREATE_COMBOS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_combos (id TEXT PRIMARY KEY, protocol TEXT NOT NULL, routing_strategy TEXT NOT NULL, fallback_enabled BIGINT NOT NULL, targets_json TEXT NOT NULL, enabled BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_COMBOS: &str = "SELECT id, protocol, routing_strategy, fallback_enabled, targets_json, enabled, revision FROM redrouter_control_combos ORDER BY revision DESC, id ASC";
const UPSERT_COMBO: &str = "INSERT INTO redrouter_control_combos (id, protocol, routing_strategy, fallback_enabled, targets_json, enabled, revision) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET protocol = $2, routing_strategy = $3, fallback_enabled = $4, targets_json = $5, enabled = $6, revision = $7";
const DISABLE_COMBO: &str =
    "UPDATE redrouter_control_combos SET enabled = 0, revision = $2 WHERE id = $1";
const CREATE_COMBO_OWNERSHIP: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_combo_ownership (combo_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, revision BIGINT NOT NULL)";
const LIST_COMBO_OWNERSHIP: &str = "SELECT combo_id, tenant_id, revision FROM redrouter_control_combo_ownership ORDER BY combo_id ASC";
const UPSERT_COMBO_OWNERSHIP: &str = "INSERT INTO redrouter_control_combo_ownership (combo_id, tenant_id, revision) VALUES ($1,$2,$3) ON CONFLICT (combo_id) DO UPDATE SET tenant_id = $2, revision = $3";
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
const CREATE_MODEL_CATALOG: &str = "CREATE TABLE IF NOT EXISTS redrouter_model_catalog_snapshot (id INTEGER PRIMARY KEY, snapshot_json TEXT NOT NULL, revision BIGINT NOT NULL)";
const READ_MODEL_CATALOG: &str =
    "SELECT snapshot_json, revision FROM redrouter_model_catalog_snapshot WHERE id = 1";
const READ_MODEL_CATALOG_REVISION: &str =
    "SELECT revision FROM redrouter_model_catalog_snapshot WHERE id = 1";
const UPSERT_MODEL_CATALOG: &str = "INSERT INTO redrouter_model_catalog_snapshot (id, snapshot_json, revision) VALUES (1,$1,$2) ON CONFLICT (id) DO UPDATE SET snapshot_json = $1, revision = $2";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredProvider {
    pub id: String,
    pub tenant_id: String,
    pub provider: String,
    pub upstream_url: String,
    pub credential_ciphertext: String,
    pub enabled: bool,
    pub updated_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StoredProviderOwnership {
    provider_id: String,
    tenant_id: String,
    revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredProviderAuth {
    pub provider_id: String,
    pub auth_scheme: String,
    pub label: String,
    pub account_email: String,
    pub expires_at_unix: i64,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredProviderOAuth {
    pub provider_id: String,
    pub oauth_provider: String,
    pub refresh_token_ciphertext: String,
    pub generation: i64,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredProviderOAuthStatus {
    pub provider_id: String,
    pub revision: i64,
    pub generation: i64,
    pub refresh_state: String,
    pub error_code: String,
    pub observed_at_unix: i64,
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
    pub model_id_format: String,
    pub tenant_id: String,
    pub created_by: String,
    pub max_tokens_per_minute: i64,
    pub max_tokens_per_day: i64,
    pub max_monthly_microusd: i64,
    pub reservation_tokens: i64,
    pub reservation_microusd: i64,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StoredClientKeyPreference {
    key_id: String,
    model_id_format: String,
    revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StoredClientKeyOwnership {
    key_id: String,
    tenant_id: String,
    created_by: String,
    revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StoredClientKeyQuota {
    key_id: String,
    max_tokens_per_minute: i64,
    max_tokens_per_day: i64,
    max_monthly_microusd: i64,
    reservation_tokens: i64,
    reservation_microusd: i64,
    revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredTenant {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub enabled: bool,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredIdentityBinding {
    pub id: String,
    pub subject: String,
    pub tenant_id: String,
    pub role: String,
    pub enabled: bool,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCombo {
    pub id: String,
    pub tenant_id: String,
    pub protocol: String,
    pub strategy: String,
    pub fallback: bool,
    pub targets_json: String,
    pub enabled: bool,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StoredComboOwnership {
    combo_id: String,
    tenant_id: String,
    revision: i64,
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredModelCatalogSnapshot {
    pub snapshot_json: String,
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
                        CREATE_PROVIDER_OWNERSHIP,
                        CREATE_PROVIDER_AUTH,
                        CREATE_PROVIDER_OAUTH,
                        CREATE_PROVIDER_OAUTH_STATUS,
                        CREATE_OAUTH_REFRESH_LEASES,
                        CREATE_CLIENT_KEYS,
                        CREATE_CLIENT_KEY_PREFERENCES,
                        CREATE_TENANTS,
                        CREATE_IDENTITY_BINDINGS,
                        CREATE_CLIENT_KEY_OWNERSHIP,
                        CREATE_CLIENT_KEY_QUOTAS,
                        CREATE_COMBOS,
                        CREATE_COMBO_OWNERSHIP,
                        CREATE_ROUTE_PINS,
                        CREATE_PROVIDER_QUOTAS,
                        CREATE_BREAKERS,
                        CREATE_AVAILABILITY,
                        CREATE_RESILIENCE,
                        CREATE_OIDC,
                        CREATE_OIDC_BROWSER,
                        CREATE_MODEL_CATALOG,
                    ] {
                        db.query(statement)
                            .await
                            .map_err(|_| "cannot initialize database")?;
                    }
                    db.query(SEED_DEFAULT_TENANT)
                        .await
                        .map_err(|_| "cannot initialize default tenant")?;
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
                db.remote_schema_query(CREATE_PROVIDER_OWNERSHIP).await?;
                db.remote_schema_query(CREATE_PROVIDER_AUTH).await?;
                db.remote_schema_query(CREATE_PROVIDER_OAUTH).await?;
                db.remote_schema_query(CREATE_PROVIDER_OAUTH_STATUS).await?;
                db.remote_schema_query(CREATE_OAUTH_REFRESH_LEASES).await?;
                db.remote_schema_query(CREATE_CLIENT_KEYS).await?;
                db.remote_schema_query(CREATE_CLIENT_KEY_PREFERENCES)
                    .await?;
                db.remote_schema_query(CREATE_TENANTS).await?;
                db.remote_schema_query(CREATE_IDENTITY_BINDINGS).await?;
                db.remote_schema_query(CREATE_CLIENT_KEY_OWNERSHIP).await?;
                db.remote_schema_query(CREATE_CLIENT_KEY_QUOTAS).await?;
                db.remote_schema_query(CREATE_COMBOS).await?;
                db.remote_schema_query(CREATE_COMBO_OWNERSHIP).await?;
                db.remote_schema_query(CREATE_ROUTE_PINS).await?;
                db.remote_schema_query(CREATE_PROVIDER_QUOTAS).await?;
                db.remote_schema_query(CREATE_BREAKERS).await?;
                db.remote_schema_query(CREATE_AVAILABILITY).await?;
                db.remote_schema_query(CREATE_RESILIENCE).await?;
                db.remote_schema_query(CREATE_OIDC).await?;
                db.remote_schema_query(CREATE_OIDC_BROWSER).await?;
                db.remote_schema_query(CREATE_MODEL_CATALOG).await?;
                db.remote_query(SEED_DEFAULT_TENANT, &[]).await?;
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
                    CREATE_PROVIDER_OWNERSHIP,
                    CREATE_PROVIDER_AUTH,
                    CREATE_PROVIDER_OAUTH,
                    CREATE_PROVIDER_OAUTH_STATUS,
                    CREATE_OAUTH_REFRESH_LEASES,
                    CREATE_CLIENT_KEYS,
                    CREATE_CLIENT_KEY_PREFERENCES,
                    CREATE_TENANTS,
                    CREATE_IDENTITY_BINDINGS,
                    CREATE_CLIENT_KEY_OWNERSHIP,
                    CREATE_CLIENT_KEY_QUOTAS,
                    CREATE_COMBOS,
                    CREATE_COMBO_OWNERSHIP,
                    CREATE_ROUTE_PINS,
                    CREATE_PROVIDER_QUOTAS,
                    CREATE_BREAKERS,
                    CREATE_AVAILABILITY,
                    CREATE_RESILIENCE,
                    CREATE_OIDC,
                    CREATE_OIDC_BROWSER,
                    CREATE_MODEL_CATALOG,
                ] {
                    sqlx::query(statement)
                        .execute(&pool)
                        .await
                        .map_err(|_| "cannot initialize database")?;
                }
                if backend == Backend::Sqlite {
                    for statement in [
                        CREATE_USAGE_RESERVATIONS,
                        CREATE_USAGE_LEDGER,
                        CREATE_USAGE_COUNTERS,
                        CREATE_USAGE_RESERVATIONS_KEY_INDEX,
                        CREATE_USAGE_RESERVATIONS_TENANT_INDEX,
                        CREATE_USAGE_LEDGER_KEY_INDEX,
                        CREATE_USAGE_LEDGER_TENANT_INDEX,
                        CREATE_USAGE_LEDGER_TENANT_KEY_INDEX,
                    ] {
                        sqlx::query(statement)
                            .execute(&pool)
                            .await
                            .map_err(|_| "cannot initialize usage database")?;
                    }
                    migrate_sqlite_usage_schema(&pool).await?;
                }
                sqlx::query(SEED_DEFAULT_TENANT)
                    .execute(&pool)
                    .await
                    .map_err(|_| "cannot initialize default tenant")?;
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
        let mut providers = match self {
            Self::Sql(pool) => sqlx::query(LIST_PROVIDERS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read provider configuration")?
                .iter()
                .map(read_sql_provider)
                .collect::<Result<Vec<_>, _>>()?,
            Self::Remote(_) => self
                .remote_query(LIST_PROVIDERS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_provider)
                .collect::<Result<Vec<_>, _>>()?,
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_PROVIDERS)
                .await
                .map_err(|_| "cannot read provider configuration")?
                .rows
                .iter()
                .map(read_reddb_provider)
                .collect::<Result<Vec<_>, _>>()?,
        };
        let ownership = self.provider_ownership().await?;
        for provider in &mut providers {
            if let Some(owner) = ownership
                .iter()
                .find(|owner| owner.provider_id == provider.id)
            {
                if owner.revision != provider.updated_at {
                    return Err("provider ownership revision mismatch");
                }
                provider.tenant_id.clone_from(&owner.tenant_id);
            }
        }
        Ok(providers)
    }

    pub async fn active_provider(&self) -> Result<Option<StoredProvider>, &'static str> {
        Ok(self
            .providers()
            .await?
            .into_iter()
            .find(|provider| provider.enabled))
    }

    pub async fn upsert_provider(&self, provider: &StoredProvider) -> Result<(), &'static str> {
        let enabled = if provider.enabled { 1_i64 } else { 0_i64 };
        self.upsert_provider_ownership(provider).await?;
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
        let provider = self
            .providers()
            .await?
            .into_iter()
            .find(|provider| provider.id == id)
            .ok_or("provider configuration not found")?;
        self.upsert_provider_ownership(&StoredProvider {
            updated_at,
            ..provider
        })
        .await?;
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

    async fn provider_ownership(&self) -> Result<Vec<StoredProviderOwnership>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_PROVIDER_OWNERSHIP)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read provider ownership")?
                .iter()
                .map(read_sql_provider_ownership)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_PROVIDER_OWNERSHIP, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_provider_ownership)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_PROVIDER_OWNERSHIP)
                .await
                .map_err(|_| "cannot read provider ownership")?
                .rows
                .iter()
                .map(read_reddb_provider_ownership)
                .collect(),
        }
    }

    async fn upsert_provider_ownership(
        &self,
        provider: &StoredProvider,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_PROVIDER_OWNERSHIP)
                    .bind(&provider.id)
                    .bind(&provider.tenant_id)
                    .bind(provider.updated_at)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider ownership")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    UPSERT_PROVIDER_OWNERSHIP,
                    &provider_ownership_params(provider),
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    UPSERT_PROVIDER_OWNERSHIP,
                    provider_ownership_params(provider),
                )
                .await
                .map_err(|_| "cannot write provider ownership")?;
            }
        }
        Ok(())
    }

    pub async fn provider_auth(&self) -> Result<Vec<StoredProviderAuth>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_PROVIDER_AUTH)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read provider authentication configuration")?
                .iter()
                .map(read_sql_provider_auth)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_PROVIDER_AUTH, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_provider_auth)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_PROVIDER_AUTH)
                .await
                .map_err(|_| "cannot read provider authentication configuration")?
                .rows
                .iter()
                .map(read_reddb_provider_auth)
                .collect(),
        }
    }

    pub async fn upsert_provider_auth(
        &self,
        auth: &StoredProviderAuth,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_PROVIDER_AUTH)
                    .bind(provider_auth_record_id(auth))
                    .bind(&auth.provider_id)
                    .bind(&auth.auth_scheme)
                    .bind(&auth.label)
                    .bind(&auth.account_email)
                    .bind(auth.expires_at_unix)
                    .bind(auth.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider authentication configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_PROVIDER_AUTH, &provider_auth_params(auth))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_PROVIDER_AUTH, provider_auth_params(auth))
                    .await
                    .map_err(|_| "cannot write provider authentication configuration")?;
            }
        }
        Ok(())
    }

    pub async fn delete_provider_auth(&self, provider_id: &str) -> Result<(), &'static str> {
        let params = || vec![reddb_client::Value::Text(provider_id.to_owned())];
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE_PROVIDER_AUTH)
                    .bind(provider_id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete provider authentication configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE_PROVIDER_AUTH, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(DELETE_PROVIDER_AUTH, params())
                    .await
                    .map_err(|_| "cannot delete provider authentication configuration")?;
            }
        }
        Ok(())
    }

    pub async fn provider_oauth(&self) -> Result<Vec<StoredProviderOAuth>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_PROVIDER_OAUTH)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read provider OAuth configuration")?
                .iter()
                .map(read_sql_provider_oauth)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_PROVIDER_OAUTH, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_provider_oauth)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_PROVIDER_OAUTH)
                .await
                .map_err(|_| "cannot read provider OAuth configuration")?
                .rows
                .iter()
                .map(read_reddb_provider_oauth)
                .collect(),
        }
    }

    pub async fn upsert_provider_oauth(
        &self,
        oauth: &StoredProviderOAuth,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_PROVIDER_OAUTH)
                    .bind(&oauth.provider_id)
                    .bind(&oauth.oauth_provider)
                    .bind(&oauth.refresh_token_ciphertext)
                    .bind(oauth.generation)
                    .bind(oauth.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider OAuth configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_PROVIDER_OAUTH, &provider_oauth_params(oauth))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_PROVIDER_OAUTH, provider_oauth_params(oauth))
                    .await
                    .map_err(|_| "cannot write provider OAuth configuration")?;
            }
        }
        Ok(())
    }

    pub async fn delete_provider_oauth(&self, provider_id: &str) -> Result<(), &'static str> {
        let params = || vec![reddb_client::Value::Text(provider_id.to_owned())];
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE_PROVIDER_OAUTH)
                    .bind(provider_id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete provider OAuth configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE_PROVIDER_OAUTH, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(DELETE_PROVIDER_OAUTH, params())
                    .await
                    .map_err(|_| "cannot delete provider OAuth configuration")?;
            }
        }
        Ok(())
    }

    pub async fn provider_oauth_status(
        &self,
    ) -> Result<Vec<StoredProviderOAuthStatus>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_PROVIDER_OAUTH_STATUS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read provider OAuth refresh status")?
                .iter()
                .map(read_sql_provider_oauth_status)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_PROVIDER_OAUTH_STATUS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_provider_oauth_status)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_PROVIDER_OAUTH_STATUS)
                .await
                .map_err(|_| "cannot read provider OAuth refresh status")?
                .rows
                .iter()
                .map(read_reddb_provider_oauth_status)
                .collect(),
        }
    }

    pub async fn upsert_provider_oauth_status(
        &self,
        status: &StoredProviderOAuthStatus,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_PROVIDER_OAUTH_STATUS)
                    .bind(&status.provider_id)
                    .bind(status.revision)
                    .bind(status.generation)
                    .bind(&status.refresh_state)
                    .bind(&status.error_code)
                    .bind(status.observed_at_unix)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider OAuth refresh status")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    UPSERT_PROVIDER_OAUTH_STATUS,
                    &provider_oauth_status_params(status),
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    UPSERT_PROVIDER_OAUTH_STATUS,
                    provider_oauth_status_params(status),
                )
                .await
                .map_err(|_| "cannot write provider OAuth refresh status")?;
            }
        }
        Ok(())
    }

    pub async fn mark_provider_oauth_reauth_required(
        &self,
        status: &StoredProviderOAuthStatus,
    ) -> Result<bool, &'static str> {
        if !self.is_sqlite().await {
            return Err("provider OAuth refresh requires SQLite");
        }
        let pool = self
            .sql_pool()
            .ok_or("provider OAuth refresh requires SQLite")?;
        let result = sqlx::query("INSERT INTO redrouter_control_provider_oauth_status (provider_id, revision, generation, refresh_state, error_code, observed_at_unix) SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS (SELECT 1 FROM redrouter_control_provider_oauth WHERE provider_id = $1 AND revision = $2 AND generation = $3) ON CONFLICT (provider_id) DO UPDATE SET revision = $2, generation = $3, refresh_state = $4, error_code = $5, observed_at_unix = $6")
            .bind(&status.provider_id)
            .bind(status.revision)
            .bind(status.generation)
            .bind(&status.refresh_state)
            .bind(&status.error_code)
            .bind(status.observed_at_unix)
            .execute(pool)
            .await
            .map_err(|_| "cannot write provider OAuth refresh status")?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn delete_provider_oauth_status(
        &self,
        provider_id: &str,
    ) -> Result<(), &'static str> {
        let params = || vec![reddb_client::Value::Text(provider_id.to_owned())];
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE_PROVIDER_OAUTH_STATUS)
                    .bind(provider_id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete provider OAuth refresh status")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE_PROVIDER_OAUTH_STATUS, &params())
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(DELETE_PROVIDER_OAUTH_STATUS, params())
                    .await
                    .map_err(|_| "cannot delete provider OAuth refresh status")?;
            }
        }
        Ok(())
    }

    pub async fn acquire_oauth_refresh_lease(
        &self,
        rotation_group: &str,
        owner: &str,
        now_unix_ms: i64,
        lease_until_unix_ms: i64,
    ) -> Result<bool, &'static str> {
        if !self.is_sqlite().await {
            return Err("provider OAuth refresh requires SQLite");
        }
        let pool = self
            .sql_pool()
            .ok_or("provider OAuth refresh requires SQLite")?;
        let result = sqlx::query("INSERT INTO redrouter_control_oauth_refresh_leases (rotation_group, owner, lease_until_unix_ms, next_allowed_unix_ms) VALUES ($1,$2,$3,0) ON CONFLICT (rotation_group) DO UPDATE SET owner = $2, lease_until_unix_ms = $3 WHERE redrouter_control_oauth_refresh_leases.lease_until_unix_ms <= $4 AND redrouter_control_oauth_refresh_leases.next_allowed_unix_ms <= $4")
            .bind(rotation_group)
            .bind(owner)
            .bind(lease_until_unix_ms)
            .bind(now_unix_ms)
            .execute(pool)
            .await
            .map_err(|_| "cannot acquire provider OAuth refresh lease")?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn release_oauth_refresh_lease(
        &self,
        rotation_group: &str,
        owner: &str,
        next_allowed_unix_ms: i64,
    ) -> Result<(), &'static str> {
        let pool = self
            .sql_pool()
            .ok_or("provider OAuth refresh requires SQLite")?;
        sqlx::query("UPDATE redrouter_control_oauth_refresh_leases SET lease_until_unix_ms = 0, next_allowed_unix_ms = $1 WHERE rotation_group = $2 AND owner = $3")
            .bind(next_allowed_unix_ms)
            .bind(rotation_group)
            .bind(owner)
            .execute(pool)
            .await
            .map_err(|_| "cannot release provider OAuth refresh lease")?;
        Ok(())
    }

    /// Atomically replace a rotating OAuth token pair if the caller still owns
    /// the generation it read. SQLite is the current production authority for
    /// this path; other backends fail closed until they provide equivalent CAS.
    pub async fn rotate_provider_oauth_credentials(
        &self,
        provider_id: &str,
        revision: i64,
        expected_generation: i64,
        access_token_ciphertext: &str,
        refresh_token_ciphertext: &str,
        expires_at_unix: i64,
    ) -> Result<bool, &'static str> {
        if !self.is_sqlite().await {
            return Err("provider OAuth rotation requires SQLite");
        }
        let pool = self
            .sql_pool()
            .ok_or("provider OAuth rotation requires SQLite")?;
        let mut connection = pool
            .acquire()
            .await
            .map_err(|_| "cannot rotate provider OAuth credential")?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *connection)
            .await
            .map_err(|_| "cannot rotate provider OAuth credential")?;
        let result = async {
            let next_generation = expected_generation
                .checked_add(1)
                .ok_or("provider OAuth generation is invalid")?;
            let oauth = sqlx::query("UPDATE redrouter_control_provider_oauth SET refresh_token_ciphertext = $1, generation = $2 WHERE provider_id = $3 AND revision = $4 AND generation = $5")
                .bind(refresh_token_ciphertext)
                .bind(next_generation)
                .bind(provider_id)
                .bind(revision)
                .bind(expected_generation)
                .execute(&mut *connection)
                .await
                .map_err(|_| "cannot rotate provider OAuth credential")?;
            if oauth.rows_affected() == 0 {
                return Ok(false);
            }
            if oauth.rows_affected() != 1 {
                return Err("invalid provider OAuth rotation state");
            }
            let provider = sqlx::query("UPDATE redrouter_control_providers SET credential_ciphertext = $1 WHERE id = $2 AND revision = $3")
                .bind(access_token_ciphertext)
                .bind(provider_id)
                .bind(revision)
                .execute(&mut *connection)
                .await
                .map_err(|_| "cannot rotate provider OAuth credential")?;
            let auth = sqlx::query("UPDATE redrouter_control_provider_auth SET expires_at_unix = $1 WHERE provider_id = $2 AND revision = $3")
                .bind(expires_at_unix)
                .bind(provider_id)
                .bind(revision)
                .execute(&mut *connection)
                .await
                .map_err(|_| "cannot rotate provider OAuth credential")?;
            if provider.rows_affected() != 1 || auth.rows_affected() != 1 {
                return Err("provider OAuth revision mismatch");
            }
            sqlx::query("DELETE FROM redrouter_control_provider_oauth_status WHERE provider_id = $1")
                .bind(provider_id)
                .execute(&mut *connection)
                .await
                .map_err(|_| "cannot clear provider OAuth refresh status")?;
            Ok(true)
        }
        .await;
        match result {
            Ok(value) => {
                sqlx::query("COMMIT")
                    .execute(&mut *connection)
                    .await
                    .map_err(|_| "cannot rotate provider OAuth credential")?;
                Ok(value)
            }
            Err(error) => {
                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                Err(error)
            }
        }
    }

    pub async fn tenants(&self) -> Result<Vec<StoredTenant>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_TENANTS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read tenant configuration")?
                .iter()
                .map(read_sql_tenant)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_TENANTS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_tenant)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_TENANTS)
                .await
                .map_err(|_| "cannot read tenant configuration")?
                .rows
                .iter()
                .map(read_reddb_tenant)
                .collect(),
        }
    }

    pub async fn upsert_tenant(&self, tenant: &StoredTenant) -> Result<(), &'static str> {
        let enabled = if tenant.enabled { 1_i64 } else { 0_i64 };
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_TENANT)
                    .bind(&tenant.id)
                    .bind(&tenant.slug)
                    .bind(&tenant.name)
                    .bind(enabled)
                    .bind(tenant.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write tenant configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_TENANT, &tenant_params(tenant, enabled))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_TENANT, tenant_params(tenant, enabled))
                    .await
                    .map_err(|_| "cannot write tenant configuration")?;
            }
        }
        Ok(())
    }

    pub async fn identity_bindings(&self) -> Result<Vec<StoredIdentityBinding>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_IDENTITY_BINDINGS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read identity binding configuration")?
                .iter()
                .map(read_sql_identity_binding)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_IDENTITY_BINDINGS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_identity_binding)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_IDENTITY_BINDINGS)
                .await
                .map_err(|_| "cannot read identity binding configuration")?
                .rows
                .iter()
                .map(read_reddb_identity_binding)
                .collect(),
        }
    }

    pub async fn upsert_identity_binding(
        &self,
        binding: &StoredIdentityBinding,
    ) -> Result<(), &'static str> {
        let enabled = if binding.enabled { 1_i64 } else { 0_i64 };
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_IDENTITY_BINDING)
                    .bind(&binding.id)
                    .bind(&binding.subject)
                    .bind(&binding.tenant_id)
                    .bind(&binding.role)
                    .bind(enabled)
                    .bind(binding.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write identity binding configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    UPSERT_IDENTITY_BINDING,
                    &identity_binding_params(binding, enabled),
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    UPSERT_IDENTITY_BINDING,
                    identity_binding_params(binding, enabled),
                )
                .await
                .map_err(|_| "cannot write identity binding configuration")?;
            }
        }
        Ok(())
    }

    pub async fn client_keys(&self) -> Result<Vec<StoredClientKey>, &'static str> {
        let mut keys: Vec<StoredClientKey> = match self {
            Self::Sql(pool) => sqlx::query(LIST_CLIENT_KEYS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read client key configuration")?
                .iter()
                .map(read_sql_client_key)
                .collect::<Result<Vec<_>, _>>(),
            Self::Remote(_) => self
                .remote_query(LIST_CLIENT_KEYS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_client_key)
                .collect::<Result<Vec<_>, _>>(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_CLIENT_KEYS)
                .await
                .map_err(|_| "cannot read client key configuration")?
                .rows
                .iter()
                .map(read_reddb_client_key)
                .collect::<Result<Vec<_>, _>>(),
        }?;
        let preferences = self.client_key_preferences().await?;
        for preference in preferences {
            let Some(key) = keys.iter_mut().find(|key| key.id == preference.key_id) else {
                // A preference is committed first. An orphan can therefore be
                // left by a failed new-key insert and is safe to ignore.
                continue;
            };
            if key.revision != preference.revision {
                return Err("client key preference revision mismatch");
            }
            key.model_id_format = preference.model_id_format;
        }
        for ownership in self.client_key_ownerships().await? {
            let Some(key) = keys.iter_mut().find(|key| key.id == ownership.key_id) else {
                // Ownership is committed before a key. An orphan is safe to
                // ignore after a failed insert.
                continue;
            };
            if key.revision != ownership.revision {
                return Err("client key ownership revision mismatch");
            }
            key.tenant_id = ownership.tenant_id;
            key.created_by = ownership.created_by;
        }
        for quota in self.client_key_quotas().await? {
            let Some(key) = keys.iter_mut().find(|key| key.id == quota.key_id) else {
                // Quotas are committed first so a failed new-key insert can
                // only leave an inert orphan.
                continue;
            };
            if key.revision != quota.revision {
                return Err("client key quota revision mismatch");
            }
            key.max_tokens_per_minute = quota.max_tokens_per_minute;
            key.max_tokens_per_day = quota.max_tokens_per_day;
            key.max_monthly_microusd = quota.max_monthly_microusd;
            key.reservation_tokens = quota.reservation_tokens;
            key.reservation_microusd = quota.reservation_microusd;
        }
        Ok(keys)
    }

    pub async fn upsert_client_key(&self, key: &StoredClientKey) -> Result<(), &'static str> {
        self.upsert_client_key_preference(key).await?;
        self.upsert_client_key_ownership(key).await?;
        self.upsert_client_key_quota(key).await?;
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
        let mut key = self
            .client_keys()
            .await?
            .into_iter()
            .find(|key| key.id == id)
            .ok_or("client key not found")?;
        key.enabled = false;
        key.revision = revision;
        self.upsert_client_key(&key).await
    }

    async fn client_key_preferences(&self) -> Result<Vec<StoredClientKeyPreference>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_CLIENT_KEY_PREFERENCES)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read client key preferences")?
                .iter()
                .map(read_sql_client_key_preference)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_CLIENT_KEY_PREFERENCES, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_client_key_preference)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_CLIENT_KEY_PREFERENCES)
                .await
                .map_err(|_| "cannot read client key preferences")?
                .rows
                .iter()
                .map(read_reddb_client_key_preference)
                .collect(),
        }
    }

    async fn upsert_client_key_preference(
        &self,
        key: &StoredClientKey,
    ) -> Result<(), &'static str> {
        if !matches!(key.model_id_format.as_str(), "prefixed" | "flat") {
            return Err("invalid client key model ID format");
        }
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_CLIENT_KEY_PREFERENCE)
                    .bind(&key.id)
                    .bind(&key.model_id_format)
                    .bind(key.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write client key preferences")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    UPSERT_CLIENT_KEY_PREFERENCE,
                    &client_key_preference_params(key),
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    UPSERT_CLIENT_KEY_PREFERENCE,
                    client_key_preference_params(key),
                )
                .await
                .map_err(|_| "cannot write client key preferences")?;
            }
        }
        Ok(())
    }

    async fn client_key_ownerships(&self) -> Result<Vec<StoredClientKeyOwnership>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_CLIENT_KEY_OWNERSHIP)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read client key ownership")?
                .iter()
                .map(read_sql_client_key_ownership)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_CLIENT_KEY_OWNERSHIP, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_client_key_ownership)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_CLIENT_KEY_OWNERSHIP)
                .await
                .map_err(|_| "cannot read client key ownership")?
                .rows
                .iter()
                .map(read_reddb_client_key_ownership)
                .collect(),
        }
    }

    async fn upsert_client_key_ownership(&self, key: &StoredClientKey) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_CLIENT_KEY_OWNERSHIP)
                    .bind(&key.id)
                    .bind(&key.tenant_id)
                    .bind(&key.created_by)
                    .bind(key.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write client key ownership")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    UPSERT_CLIENT_KEY_OWNERSHIP,
                    &client_key_ownership_params(key),
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    UPSERT_CLIENT_KEY_OWNERSHIP,
                    client_key_ownership_params(key),
                )
                .await
                .map_err(|_| "cannot write client key ownership")?;
            }
        }
        Ok(())
    }

    async fn client_key_quotas(&self) -> Result<Vec<StoredClientKeyQuota>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_CLIENT_KEY_QUOTAS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read client key quotas")?
                .iter()
                .map(read_sql_client_key_quota)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_CLIENT_KEY_QUOTAS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_client_key_quota)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_CLIENT_KEY_QUOTAS)
                .await
                .map_err(|_| "cannot read client key quotas")?
                .rows
                .iter()
                .map(read_reddb_client_key_quota)
                .collect(),
        }
    }

    async fn upsert_client_key_quota(&self, key: &StoredClientKey) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_CLIENT_KEY_QUOTA)
                    .bind(&key.id)
                    .bind(key.max_tokens_per_minute)
                    .bind(key.max_tokens_per_day)
                    .bind(key.max_monthly_microusd)
                    .bind(key.reservation_tokens)
                    .bind(key.reservation_microusd)
                    .bind(key.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write client key quotas")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_CLIENT_KEY_QUOTA, &client_key_quota_params(key))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_CLIENT_KEY_QUOTA, client_key_quota_params(key))
                    .await
                    .map_err(|_| "cannot write client key quotas")?;
            }
        }
        Ok(())
    }

    pub(crate) fn sql_pool(&self) -> Option<&AnyPool> {
        match self {
            Self::Sql(pool) => Some(pool),
            _ => None,
        }
    }

    pub(crate) async fn is_sqlite(&self) -> bool {
        match self {
            Self::Sql(pool) => sqlx::query_scalar::<_, String>("SELECT sqlite_version()")
                .fetch_one(pool)
                .await
                .is_ok(),
            _ => false,
        }
    }

    pub async fn combos(&self) -> Result<Vec<StoredCombo>, &'static str> {
        let mut combos = match self {
            Self::Sql(pool) => sqlx::query(LIST_COMBOS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read combo configuration")?
                .iter()
                .map(read_sql_combo)
                .collect::<Result<Vec<_>, _>>()?,
            Self::Remote(_) => self
                .remote_query(LIST_COMBOS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_combo)
                .collect::<Result<Vec<_>, _>>()?,
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_COMBOS)
                .await
                .map_err(|_| "cannot read combo configuration")?
                .rows
                .iter()
                .map(read_reddb_combo)
                .collect::<Result<Vec<_>, _>>()?,
        };
        let ownership = self.combo_ownership().await?;
        for combo in &mut combos {
            if let Some(owner) = ownership.iter().find(|owner| owner.combo_id == combo.id) {
                if owner.revision != combo.revision {
                    return Err("combo ownership revision mismatch");
                }
                combo.tenant_id.clone_from(&owner.tenant_id);
            }
        }
        Ok(combos)
    }

    pub async fn upsert_combo(&self, combo: &StoredCombo) -> Result<(), &'static str> {
        let fallback = if combo.fallback { 1_i64 } else { 0_i64 };
        let enabled = if combo.enabled { 1_i64 } else { 0_i64 };
        self.upsert_combo_ownership(combo).await?;
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
        let combo = self
            .combos()
            .await?
            .into_iter()
            .find(|combo| combo.id == id)
            .ok_or("combo configuration not found")?;
        self.upsert_combo_ownership(&StoredCombo { revision, ..combo })
            .await?;
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

    async fn combo_ownership(&self) -> Result<Vec<StoredComboOwnership>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_COMBO_OWNERSHIP)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read combo ownership")?
                .iter()
                .map(read_sql_combo_ownership)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_COMBO_OWNERSHIP, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_combo_ownership)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_COMBO_OWNERSHIP)
                .await
                .map_err(|_| "cannot read combo ownership")?
                .rows
                .iter()
                .map(read_reddb_combo_ownership)
                .collect(),
        }
    }

    async fn upsert_combo_ownership(&self, combo: &StoredCombo) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_COMBO_OWNERSHIP)
                    .bind(&combo.id)
                    .bind(&combo.tenant_id)
                    .bind(combo.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write combo ownership")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_COMBO_OWNERSHIP, &combo_ownership_params(combo))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_COMBO_OWNERSHIP, combo_ownership_params(combo))
                    .await
                    .map_err(|_| "cannot write combo ownership")?;
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

    pub async fn model_catalog_snapshot(
        &self,
    ) -> Result<Option<StoredModelCatalogSnapshot>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(READ_MODEL_CATALOG)
                .fetch_optional(pool)
                .await
                .map_err(|_| "cannot read model catalog snapshot")?
                .as_ref()
                .map(read_sql_model_catalog)
                .transpose(),
            Self::Remote(_) => self
                .remote_query(READ_MODEL_CATALOG, &[])
                .await?
                .rows
                .first()
                .map(read_reddb_model_catalog)
                .transpose(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(READ_MODEL_CATALOG)
                .await
                .map_err(|_| "cannot read model catalog snapshot")?
                .rows
                .first()
                .map(read_reddb_model_catalog)
                .transpose(),
        }
    }

    /// Lightweight generation probe used by replicas. The multi-megabyte
    /// snapshot is fetched only after this value changes.
    pub async fn model_catalog_revision(&self) -> Result<Option<i64>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(READ_MODEL_CATALOG_REVISION)
                .fetch_optional(pool)
                .await
                .map_err(|_| "cannot read model catalog revision")?
                .as_ref()
                .map(|row| {
                    row.try_get("revision")
                        .map_err(|_| "invalid model catalog revision")
                })
                .transpose(),
            Self::Remote(_) => self
                .remote_query(READ_MODEL_CATALOG_REVISION, &[])
                .await?
                .rows
                .first()
                .map(read_reddb_model_catalog_revision)
                .transpose(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(READ_MODEL_CATALOG_REVISION)
                .await
                .map_err(|_| "cannot read model catalog revision")?
                .rows
                .first()
                .map(read_reddb_model_catalog_revision)
                .transpose(),
        }
    }

    /// One row owns the entire transformed snapshot, so readers can never
    /// observe a manifest from one generation with providers from another.
    pub async fn upsert_model_catalog_snapshot(
        &self,
        snapshot: &StoredModelCatalogSnapshot,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_MODEL_CATALOG)
                    .bind(&snapshot.snapshot_json)
                    .bind(snapshot.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write model catalog snapshot")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    UPSERT_MODEL_CATALOG,
                    &[
                        reddb_client::Value::Text(snapshot.snapshot_json.clone()),
                        reddb_client::Value::Int(snapshot.revision),
                    ],
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    UPSERT_MODEL_CATALOG,
                    vec![
                        reddb_client::Value::Text(snapshot.snapshot_json.clone()),
                        reddb_client::Value::Int(snapshot.revision),
                    ],
                )
                .await
                .map_err(|_| "cannot write model catalog snapshot")?;
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

async fn migrate_sqlite_usage_schema(pool: &AnyPool) -> Result<(), &'static str> {
    let mut connection = pool
        .acquire()
        .await
        .map_err(|_| "cannot initialize usage database")?;
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *connection)
        .await
        .map_err(|_| "cannot initialize usage database")?;
    let result = async {
        let pricing_snapshot: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('redrouter_usage_ledger') WHERE name = 'pricing_snapshot'",
        )
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| "cannot inspect usage database")?;
        if pricing_snapshot == 0 {
            sqlx::query("ALTER TABLE redrouter_usage_ledger ADD COLUMN pricing_snapshot TEXT")
                .execute(&mut *connection)
                .await
                .map_err(|_| "cannot migrate usage database")?;
        }
        sqlx::query("UPDATE redrouter_usage_ledger SET pricing_snapshot = '{\"source\":\"legacy\",\"available\":false}' WHERE pricing_known = 1 AND pricing_snapshot IS NULL")
            .execute(&mut *connection)
            .await
            .map_err(|_| "cannot migrate usage database")?;
        Ok::<_, &'static str>(())
    }
    .await;
    match result {
        Ok(()) => sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map(|_| ())
            .map_err(|_| "cannot initialize usage database"),
        Err(error) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            Err(error)
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
        tenant_id: "red".to_owned(),
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
        tenant_id: "red".to_owned(),
        provider: text("provider")?,
        upstream_url: text("upstream_url")?,
        credential_ciphertext: text("credential_ciphertext")?,
        enabled: integer("enabled")? == 1,
        updated_at: integer("revision")?,
    })
}

fn read_sql_provider_ownership(
    row: &sqlx::any::AnyRow,
) -> Result<StoredProviderOwnership, &'static str> {
    Ok(StoredProviderOwnership {
        provider_id: row
            .try_get("provider_id")
            .map_err(|_| "invalid provider ownership")?,
        tenant_id: row
            .try_get("tenant_id")
            .map_err(|_| "invalid provider ownership")?,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid provider ownership")?,
    })
}

fn read_reddb_provider_ownership(
    row: &reddb_client::Row,
) -> Result<StoredProviderOwnership, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid provider ownership"),
    };
    let revision = match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case("revision"))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid provider ownership"),
    }?;
    Ok(StoredProviderOwnership {
        provider_id: text("provider_id")?,
        tenant_id: text("tenant_id")?,
        revision,
    })
}

fn read_sql_provider_auth(row: &sqlx::any::AnyRow) -> Result<StoredProviderAuth, &'static str> {
    Ok(StoredProviderAuth {
        provider_id: row
            .try_get("provider_id")
            .map_err(|_| "invalid provider authentication record")?,
        auth_scheme: row
            .try_get("auth_scheme")
            .map_err(|_| "invalid provider authentication record")?,
        label: row
            .try_get("label")
            .map_err(|_| "invalid provider authentication record")?,
        account_email: row
            .try_get("account_email")
            .map_err(|_| "invalid provider authentication record")?,
        expires_at_unix: row
            .try_get("expires_at_unix")
            .map_err(|_| "invalid provider authentication record")?,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid provider authentication record")?,
    })
}

fn read_reddb_provider_auth(row: &reddb_client::Row) -> Result<StoredProviderAuth, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid provider authentication record"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid provider authentication record"),
    };
    Ok(StoredProviderAuth {
        provider_id: text("provider_id")?,
        auth_scheme: text("auth_scheme")?,
        label: text("label")?,
        account_email: text("account_email")?,
        expires_at_unix: integer("expires_at_unix")?,
        revision: integer("revision")?,
    })
}

fn provider_auth_record_id(auth: &StoredProviderAuth) -> String {
    format!("{}:{}", auth.provider_id, auth.revision)
}

fn provider_auth_params(auth: &StoredProviderAuth) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(provider_auth_record_id(auth)),
        reddb_client::Value::Text(auth.provider_id.clone()),
        reddb_client::Value::Text(auth.auth_scheme.clone()),
        reddb_client::Value::Text(auth.label.clone()),
        reddb_client::Value::Text(auth.account_email.clone()),
        reddb_client::Value::Int(auth.expires_at_unix),
        reddb_client::Value::Int(auth.revision),
    ]
}

fn read_sql_provider_oauth(row: &sqlx::any::AnyRow) -> Result<StoredProviderOAuth, &'static str> {
    Ok(StoredProviderOAuth {
        provider_id: row
            .try_get("provider_id")
            .map_err(|_| "invalid provider OAuth record")?,
        oauth_provider: row
            .try_get("oauth_provider")
            .map_err(|_| "invalid provider OAuth record")?,
        refresh_token_ciphertext: row
            .try_get("refresh_token_ciphertext")
            .map_err(|_| "invalid provider OAuth record")?,
        generation: row
            .try_get("generation")
            .map_err(|_| "invalid provider OAuth record")?,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid provider OAuth record")?,
    })
}

fn read_reddb_provider_oauth(row: &reddb_client::Row) -> Result<StoredProviderOAuth, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid provider OAuth record"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid provider OAuth record"),
    };
    Ok(StoredProviderOAuth {
        provider_id: text("provider_id")?,
        oauth_provider: text("oauth_provider")?,
        refresh_token_ciphertext: text("refresh_token_ciphertext")?,
        generation: integer("generation")?,
        revision: integer("revision")?,
    })
}

fn provider_oauth_params(oauth: &StoredProviderOAuth) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(oauth.provider_id.clone()),
        reddb_client::Value::Text(oauth.oauth_provider.clone()),
        reddb_client::Value::Text(oauth.refresh_token_ciphertext.clone()),
        reddb_client::Value::Int(oauth.generation),
        reddb_client::Value::Int(oauth.revision),
    ]
}

fn read_sql_provider_oauth_status(
    row: &sqlx::any::AnyRow,
) -> Result<StoredProviderOAuthStatus, &'static str> {
    Ok(StoredProviderOAuthStatus {
        provider_id: row
            .try_get("provider_id")
            .map_err(|_| "invalid provider OAuth refresh status")?,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid provider OAuth refresh status")?,
        generation: row
            .try_get("generation")
            .map_err(|_| "invalid provider OAuth refresh status")?,
        refresh_state: row
            .try_get("refresh_state")
            .map_err(|_| "invalid provider OAuth refresh status")?,
        error_code: row
            .try_get("error_code")
            .map_err(|_| "invalid provider OAuth refresh status")?,
        observed_at_unix: row
            .try_get("observed_at_unix")
            .map_err(|_| "invalid provider OAuth refresh status")?,
    })
}

fn read_reddb_provider_oauth_status(
    row: &reddb_client::Row,
) -> Result<StoredProviderOAuthStatus, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid provider OAuth refresh status"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid provider OAuth refresh status"),
    };
    Ok(StoredProviderOAuthStatus {
        provider_id: text("provider_id")?,
        revision: integer("revision")?,
        generation: integer("generation")?,
        refresh_state: text("refresh_state")?,
        error_code: text("error_code")?,
        observed_at_unix: integer("observed_at_unix")?,
    })
}

fn provider_oauth_status_params(status: &StoredProviderOAuthStatus) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(status.provider_id.clone()),
        reddb_client::Value::Int(status.revision),
        reddb_client::Value::Int(status.generation),
        reddb_client::Value::Text(status.refresh_state.clone()),
        reddb_client::Value::Text(status.error_code.clone()),
        reddb_client::Value::Int(status.observed_at_unix),
    ]
}

fn provider_ownership_params(provider: &StoredProvider) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(provider.id.clone()),
        reddb_client::Value::Text(provider.tenant_id.clone()),
        reddb_client::Value::Int(provider.updated_at),
    ]
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
        model_id_format: "prefixed".to_owned(),
        tenant_id: "red".to_owned(),
        created_by: "legacy".to_owned(),
        max_tokens_per_minute: 0,
        max_tokens_per_day: 0,
        max_monthly_microusd: 0,
        reservation_tokens: 0,
        reservation_microusd: 0,
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
        model_id_format: "prefixed".to_owned(),
        tenant_id: "red".to_owned(),
        created_by: "legacy".to_owned(),
        max_tokens_per_minute: 0,
        max_tokens_per_day: 0,
        max_monthly_microusd: 0,
        reservation_tokens: 0,
        reservation_microusd: 0,
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

fn read_sql_client_key_preference(
    row: &sqlx::any::AnyRow,
) -> Result<StoredClientKeyPreference, &'static str> {
    Ok(StoredClientKeyPreference {
        key_id: row
            .try_get("key_id")
            .map_err(|_| "invalid client key preference")?,
        model_id_format: row
            .try_get("model_id_format")
            .map_err(|_| "invalid client key preference")?,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid client key preference")?,
    })
}

fn read_reddb_client_key_preference(
    row: &reddb_client::Row,
) -> Result<StoredClientKeyPreference, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid client key preference"),
    };
    let revision = match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case("revision"))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid client key preference"),
    }?;
    Ok(StoredClientKeyPreference {
        key_id: text("key_id")?,
        model_id_format: text("model_id_format")?,
        revision,
    })
}

fn client_key_preference_params(key: &StoredClientKey) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(key.id.clone()),
        reddb_client::Value::Text(key.model_id_format.clone()),
        reddb_client::Value::Int(key.revision),
    ]
}

fn read_sql_client_key_ownership(
    row: &sqlx::any::AnyRow,
) -> Result<StoredClientKeyOwnership, &'static str> {
    Ok(StoredClientKeyOwnership {
        key_id: row
            .try_get("key_id")
            .map_err(|_| "invalid client key ownership")?,
        tenant_id: row
            .try_get("tenant_id")
            .map_err(|_| "invalid client key ownership")?,
        created_by: row
            .try_get("created_by")
            .map_err(|_| "invalid client key ownership")?,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid client key ownership")?,
    })
}

fn read_reddb_client_key_ownership(
    row: &reddb_client::Row,
) -> Result<StoredClientKeyOwnership, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid client key ownership"),
    };
    let revision = match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case("revision"))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid client key ownership"),
    }?;
    Ok(StoredClientKeyOwnership {
        key_id: text("key_id")?,
        tenant_id: text("tenant_id")?,
        created_by: text("created_by")?,
        revision,
    })
}

fn client_key_ownership_params(key: &StoredClientKey) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(key.id.clone()),
        reddb_client::Value::Text(key.tenant_id.clone()),
        reddb_client::Value::Text(key.created_by.clone()),
        reddb_client::Value::Int(key.revision),
    ]
}

fn read_sql_client_key_quota(
    row: &sqlx::any::AnyRow,
) -> Result<StoredClientKeyQuota, &'static str> {
    let integer = |name| row.try_get(name).map_err(|_| "invalid client key quota");
    Ok(StoredClientKeyQuota {
        key_id: row
            .try_get("key_id")
            .map_err(|_| "invalid client key quota")?,
        max_tokens_per_minute: integer("max_tokens_per_minute")?,
        max_tokens_per_day: integer("max_tokens_per_day")?,
        max_monthly_microusd: integer("max_monthly_microusd")?,
        reservation_tokens: integer("reservation_tokens")?,
        reservation_microusd: integer("reservation_microusd")?,
        revision: integer("revision")?,
    })
}

fn read_reddb_client_key_quota(
    row: &reddb_client::Row,
) -> Result<StoredClientKeyQuota, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid client key quota"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid client key quota"),
    };
    Ok(StoredClientKeyQuota {
        key_id: text("key_id")?,
        max_tokens_per_minute: integer("max_tokens_per_minute")?,
        max_tokens_per_day: integer("max_tokens_per_day")?,
        max_monthly_microusd: integer("max_monthly_microusd")?,
        reservation_tokens: integer("reservation_tokens")?,
        reservation_microusd: integer("reservation_microusd")?,
        revision: integer("revision")?,
    })
}

fn client_key_quota_params(key: &StoredClientKey) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(key.id.clone()),
        reddb_client::Value::Int(key.max_tokens_per_minute),
        reddb_client::Value::Int(key.max_tokens_per_day),
        reddb_client::Value::Int(key.max_monthly_microusd),
        reddb_client::Value::Int(key.reservation_tokens),
        reddb_client::Value::Int(key.reservation_microusd),
        reddb_client::Value::Int(key.revision),
    ]
}

fn read_sql_tenant(row: &sqlx::any::AnyRow) -> Result<StoredTenant, &'static str> {
    Ok(StoredTenant {
        id: row.try_get("id").map_err(|_| "invalid tenant record")?,
        slug: row.try_get("slug").map_err(|_| "invalid tenant record")?,
        name: row.try_get("name").map_err(|_| "invalid tenant record")?,
        enabled: row
            .try_get::<i64, _>("enabled")
            .map_err(|_| "invalid tenant record")?
            == 1,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid tenant record")?,
    })
}

fn read_reddb_tenant(row: &reddb_client::Row) -> Result<StoredTenant, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid tenant record"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid tenant record"),
    };
    Ok(StoredTenant {
        id: text("id")?,
        slug: text("slug")?,
        name: text("name")?,
        enabled: integer("enabled")? == 1,
        revision: integer("revision")?,
    })
}

fn tenant_params(tenant: &StoredTenant, enabled: i64) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(tenant.id.clone()),
        reddb_client::Value::Text(tenant.slug.clone()),
        reddb_client::Value::Text(tenant.name.clone()),
        reddb_client::Value::Int(enabled),
        reddb_client::Value::Int(tenant.revision),
    ]
}

fn read_sql_identity_binding(
    row: &sqlx::any::AnyRow,
) -> Result<StoredIdentityBinding, &'static str> {
    Ok(StoredIdentityBinding {
        id: row
            .try_get("id")
            .map_err(|_| "invalid identity binding record")?,
        subject: row
            .try_get("subject")
            .map_err(|_| "invalid identity binding record")?,
        tenant_id: row
            .try_get("tenant_id")
            .map_err(|_| "invalid identity binding record")?,
        role: row
            .try_get("binding_role")
            .map_err(|_| "invalid identity binding record")?,
        enabled: row
            .try_get::<i64, _>("enabled")
            .map_err(|_| "invalid identity binding record")?
            == 1,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid identity binding record")?,
    })
}

fn read_reddb_identity_binding(
    row: &reddb_client::Row,
) -> Result<StoredIdentityBinding, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid identity binding record"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid identity binding record"),
    };
    Ok(StoredIdentityBinding {
        id: text("id")?,
        subject: text("subject")?,
        tenant_id: text("tenant_id")?,
        role: text("binding_role")?,
        enabled: integer("enabled")? == 1,
        revision: integer("revision")?,
    })
}

fn identity_binding_params(
    binding: &StoredIdentityBinding,
    enabled: i64,
) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(binding.id.clone()),
        reddb_client::Value::Text(binding.subject.clone()),
        reddb_client::Value::Text(binding.tenant_id.clone()),
        reddb_client::Value::Text(binding.role.clone()),
        reddb_client::Value::Int(enabled),
        reddb_client::Value::Int(binding.revision),
    ]
}

fn read_sql_combo(row: &sqlx::any::AnyRow) -> Result<StoredCombo, &'static str> {
    let text = |name| row.try_get(name).map_err(|_| "invalid combo record");
    let integer = |name| row.try_get(name).map_err(|_| "invalid combo record");
    Ok(StoredCombo {
        id: text("id")?,
        tenant_id: "red".to_owned(),
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
        tenant_id: "red".to_owned(),
        protocol: text("protocol")?,
        strategy: text("routing_strategy")?,
        fallback: integer("fallback_enabled")? == 1,
        targets_json: text("targets_json")?,
        enabled: integer("enabled")? == 1,
        revision: integer("revision")?,
    })
}

fn read_sql_combo_ownership(row: &sqlx::any::AnyRow) -> Result<StoredComboOwnership, &'static str> {
    Ok(StoredComboOwnership {
        combo_id: row
            .try_get("combo_id")
            .map_err(|_| "invalid combo ownership")?,
        tenant_id: row
            .try_get("tenant_id")
            .map_err(|_| "invalid combo ownership")?,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid combo ownership")?,
    })
}

fn read_reddb_combo_ownership(
    row: &reddb_client::Row,
) -> Result<StoredComboOwnership, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid combo ownership"),
    };
    let revision = match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case("revision"))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid combo ownership"),
    }?;
    Ok(StoredComboOwnership {
        combo_id: text("combo_id")?,
        tenant_id: text("tenant_id")?,
        revision,
    })
}

fn combo_ownership_params(combo: &StoredCombo) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(combo.id.clone()),
        reddb_client::Value::Text(combo.tenant_id.clone()),
        reddb_client::Value::Int(combo.revision),
    ]
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

fn read_sql_model_catalog(
    row: &sqlx::any::AnyRow,
) -> Result<StoredModelCatalogSnapshot, &'static str> {
    Ok(StoredModelCatalogSnapshot {
        snapshot_json: row
            .try_get("snapshot_json")
            .map_err(|_| "invalid model catalog snapshot")?,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid model catalog snapshot")?,
    })
}

fn read_reddb_model_catalog(
    row: &reddb_client::Row,
) -> Result<StoredModelCatalogSnapshot, &'static str> {
    let snapshot_json = match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case("snapshot_json"))
    {
        Some((_, reddb_client::ValueOut::String(value))) => value.clone(),
        _ => return Err("invalid model catalog snapshot"),
    };
    let revision = match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case("revision"))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => *value,
        _ => return Err("invalid model catalog snapshot"),
    };
    Ok(StoredModelCatalogSnapshot {
        snapshot_json,
        revision,
    })
}

fn read_reddb_model_catalog_revision(row: &reddb_client::Row) -> Result<i64, &'static str> {
    match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case("revision"))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid model catalog revision"),
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
