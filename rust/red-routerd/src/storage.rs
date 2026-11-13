//! Rust-owned persistence boundary for proxy and control-plane configuration.
//!
//! Each process selects one database authority; connection errors never fall
//! back. Provider credentials are accepted here only as encrypted ciphertext.
#[path = "provider_models_storage.rs"]
mod provider_models_storage;
pub use provider_models_storage::StoredProviderModel;
#[path = "model_aliases_storage.rs"]
mod model_aliases_storage;
pub use model_aliases_storage::StoredModelAlias;
#[path = "provider_nodes_storage.rs"]
mod provider_nodes_storage;
pub use provider_nodes_storage::{StoredProviderNode, StoredProviderNodeHeaders};
#[path = "provider_discovery_storage.rs"]
mod provider_discovery_storage;
#[path = "provider_node_binding_storage.rs"]
mod provider_node_binding_storage;
pub use provider_discovery_storage::StoredProviderDiscovery;
#[path = "provider_priority_storage.rs"]
mod provider_priority_storage;
#[path = "provider_protocol_storage.rs"]
mod provider_protocol_storage;

use sqlx::{any::AnyPoolOptions, AnyPool, Row};
use std::sync::Once;

const CREATE: &str = "CREATE TABLE IF NOT EXISTS redrouter_proxy_config (id INTEGER PRIMARY KEY, upstream_url TEXT NOT NULL)";
const READ: &str = "SELECT upstream_url FROM redrouter_proxy_config WHERE id = 1";
const SEED: &str = "INSERT INTO redrouter_proxy_config (id, upstream_url) VALUES (1, $1) ON CONFLICT (id) DO NOTHING";
const SET: &str = "INSERT INTO redrouter_proxy_config (id, upstream_url) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET upstream_url = $1";
const CREATE_PROVIDERS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_providers (id TEXT PRIMARY KEY, provider TEXT NOT NULL, upstream_url TEXT NOT NULL, credential_ciphertext TEXT NOT NULL, enabled BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_PROVIDERS: &str = "SELECT id, provider, upstream_url, credential_ciphertext, enabled, revision FROM redrouter_control_providers ORDER BY revision DESC, id ASC";
// Read the provider and its matching priority in one database snapshot. This
// avoids loading historical priority revisions into memory and prevents an
// update between separate reads from temporarily changing the account order.
const LIST_PROVIDERS_SQL: &str = "SELECT v.id,v.provider,v.upstream_url,v.credential_ciphertext,v.enabled,v.revision,COALESCE(p.priority,0) AS priority FROM redrouter_control_providers v LEFT JOIN redrouter_control_provider_priorities p ON p.record_id = v.id || ':' || CAST(v.revision AS TEXT) ORDER BY v.revision DESC,v.id ASC";
const UPSERT_PROVIDER: &str = "INSERT INTO redrouter_control_providers (id, provider, upstream_url, credential_ciphertext, enabled, revision) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET provider = $2, upstream_url = $3, credential_ciphertext = $4, enabled = $5, revision = $6";
const DISABLE_PROVIDER: &str =
    "UPDATE redrouter_control_providers SET enabled = 0, revision = $2 WHERE id = $1";
const DELETE_PROVIDER: &str = "DELETE FROM redrouter_control_providers WHERE id = $1";
const CREATE_PROVIDER_OWNERSHIP: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_provider_ownership (provider_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, revision BIGINT NOT NULL)";
const LIST_PROVIDER_OWNERSHIP: &str = "SELECT provider_id, tenant_id, revision FROM redrouter_control_provider_ownership ORDER BY provider_id ASC";
const UPSERT_PROVIDER_OWNERSHIP: &str = "INSERT INTO redrouter_control_provider_ownership (provider_id, tenant_id, revision) VALUES ($1,$2,$3) ON CONFLICT (provider_id) DO UPDATE SET tenant_id = $2, revision = $3";
const DELETE_PROVIDER_OWNERSHIP: &str =
    "DELETE FROM redrouter_control_provider_ownership WHERE provider_id = $1";
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
const CREATE_PROVIDER_SESSIONS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_provider_sessions (provider_id TEXT PRIMARY KEY, provider TEXT NOT NULL, session_ciphertext TEXT NOT NULL, revision BIGINT NOT NULL)";
const LIST_PROVIDER_SESSIONS: &str = "SELECT provider_id, provider, session_ciphertext, revision FROM redrouter_control_provider_sessions ORDER BY provider_id ASC";
const UPSERT_PROVIDER_SESSION: &str = "INSERT INTO redrouter_control_provider_sessions (provider_id, provider, session_ciphertext, revision) VALUES ($1,$2,$3,$4) ON CONFLICT (provider_id) DO UPDATE SET provider = $2, session_ciphertext = $3, revision = $4";
const DELETE_PROVIDER_SESSION: &str =
    "DELETE FROM redrouter_control_provider_sessions WHERE provider_id = $1";
const CREATE_PROVIDER_HEADERS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_provider_headers (provider_id TEXT PRIMARY KEY, upstream_identity TEXT NOT NULL, headers_ciphertext TEXT NOT NULL, revision BIGINT NOT NULL)";
const LIST_PROVIDER_HEADERS: &str = "SELECT provider_id, upstream_identity, headers_ciphertext, revision FROM redrouter_control_provider_headers ORDER BY provider_id ASC";
const UPSERT_PROVIDER_HEADER: &str = "INSERT INTO redrouter_control_provider_headers (provider_id, upstream_identity, headers_ciphertext, revision) VALUES ($1,$2,$3,$4) ON CONFLICT (provider_id) DO UPDATE SET upstream_identity = $2, headers_ciphertext = $3, revision = $4";
const DELETE_PROVIDER_HEADER: &str =
    "DELETE FROM redrouter_control_provider_headers WHERE provider_id = $1";
const CREATE_PROVIDER_OAUTH_STATUS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_provider_oauth_status (provider_id TEXT PRIMARY KEY, revision BIGINT NOT NULL, generation BIGINT NOT NULL, refresh_state TEXT NOT NULL, error_code TEXT NOT NULL, observed_at_unix BIGINT NOT NULL)";
const LIST_PROVIDER_OAUTH_STATUS: &str = "SELECT provider_id, revision, generation, refresh_state, error_code, observed_at_unix FROM redrouter_control_provider_oauth_status ORDER BY provider_id ASC";
const UPSERT_PROVIDER_OAUTH_STATUS: &str = "INSERT INTO redrouter_control_provider_oauth_status (provider_id, revision, generation, refresh_state, error_code, observed_at_unix) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provider_id) DO UPDATE SET revision = $2, generation = $3, refresh_state = $4, error_code = $5, observed_at_unix = $6";
const DELETE_PROVIDER_OAUTH_STATUS: &str =
    "DELETE FROM redrouter_control_provider_oauth_status WHERE provider_id = $1";
const CREATE_OAUTH_REFRESH_LEASES: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_oauth_refresh_leases (rotation_group TEXT PRIMARY KEY, owner TEXT NOT NULL, lease_until_unix_ms BIGINT NOT NULL, next_allowed_unix_ms BIGINT NOT NULL)";
const CREATE_CLIENT_KEYS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_client_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, key_hash TEXT NOT NULL, enabled BIGINT NOT NULL, expiry_unix BIGINT NOT NULL, scopes_json TEXT NOT NULL, allowed_endpoints_json TEXT NOT NULL, allowed_models_json TEXT NOT NULL, blocked_models_json TEXT NOT NULL, allowed_provider_ids_json TEXT NOT NULL, max_concurrent BIGINT NOT NULL, max_rpm BIGINT NOT NULL, max_rpd BIGINT NOT NULL, revision BIGINT NOT NULL)";
const CREATE_CLIENT_KEY_PREFERENCES: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_client_key_preferences (key_id TEXT PRIMARY KEY, model_id_format TEXT NOT NULL, revision BIGINT NOT NULL)";
const CREATE_CLIENT_KEY_SCHEDULES: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_client_key_schedules (key_id TEXT PRIMARY KEY, schedule_json TEXT NOT NULL, revision BIGINT NOT NULL)";
const CREATE_CLIENT_KEY_MODEL_ACCESS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_client_key_model_access (key_id TEXT PRIMARY KEY, model_access_mode TEXT NOT NULL, revision BIGINT NOT NULL)";
const CREATE_CLIENT_KEY_COMBO_ACCESS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_client_key_combo_access (key_id TEXT PRIMARY KEY, allowed_combos_json TEXT NOT NULL, revision BIGINT NOT NULL)";
const LIST_CLIENT_KEYS: &str = "SELECT id, label, key_hash, enabled, expiry_unix, scopes_json, allowed_endpoints_json, allowed_models_json, blocked_models_json, allowed_provider_ids_json, max_concurrent, max_rpm, max_rpd, revision FROM redrouter_control_client_keys ORDER BY revision DESC, id ASC";
// One statement gives SQLite and PostgreSQL one consistent policy snapshot.
const LIST_SQL_CLIENT_KEY_SNAPSHOT: &str = r#"SELECT
    k.id,
    k.label,
    k.key_hash,
    k.enabled,
    k.expiry_unix,
    k.scopes_json,
    k.allowed_endpoints_json,
    k.allowed_models_json,
    k.blocked_models_json,
    k.allowed_provider_ids_json,
    k.max_concurrent,
    k.max_rpm,
    k.max_rpd,
    k.revision,
    CASE WHEN p.key_id IS NULL THEN k.revision ELSE p.revision END AS preference_revision,
    CASE WHEN p.key_id IS NULL THEN 'prefixed' ELSE p.model_id_format END AS model_id_format,
    CASE WHEN s.key_id IS NULL THEN k.revision ELSE s.revision END AS schedule_revision,
    CASE WHEN s.key_id IS NULL THEN '' ELSE s.schedule_json END AS schedule_json,
    CASE WHEN m.key_id IS NULL THEN k.revision ELSE m.revision END AS model_access_revision,
    CASE WHEN m.key_id IS NULL THEN 'all' ELSE m.model_access_mode END AS model_access_mode,
    CASE WHEN c.key_id IS NULL THEN k.revision ELSE c.revision END AS combo_access_revision,
    CASE WHEN c.key_id IS NULL THEN 'null' ELSE c.allowed_combos_json END AS allowed_combos_json,
    CASE WHEN o.key_id IS NULL THEN k.revision ELSE o.revision END AS ownership_revision,
    CASE WHEN o.key_id IS NULL THEN 'red' ELSE o.tenant_id END AS tenant_id,
    CASE WHEN o.key_id IS NULL THEN 'legacy' ELSE o.created_by END AS created_by,
    CASE WHEN q.key_id IS NULL THEN k.revision ELSE q.revision END AS quota_revision,
    CASE WHEN q.key_id IS NULL THEN 0 ELSE q.max_tokens_per_minute END AS max_tokens_per_minute,
    CASE WHEN q.key_id IS NULL THEN 0 ELSE q.max_tokens_per_day END AS max_tokens_per_day,
    CASE WHEN q.key_id IS NULL THEN 0 ELSE q.max_monthly_microusd END AS max_monthly_microusd,
    CASE WHEN q.key_id IS NULL THEN 0 ELSE q.reservation_tokens END AS reservation_tokens,
    CASE WHEN q.key_id IS NULL THEN 0 ELSE q.reservation_microusd END AS reservation_microusd
FROM redrouter_control_client_keys k
LEFT JOIN redrouter_control_client_key_preferences p ON p.key_id = k.id
LEFT JOIN redrouter_control_client_key_schedules s ON s.key_id = k.id
LEFT JOIN redrouter_control_client_key_model_access m ON m.key_id = k.id
LEFT JOIN redrouter_control_client_key_combo_access c ON c.key_id = k.id
LEFT JOIN redrouter_control_client_key_ownership o ON o.key_id = k.id
LEFT JOIN redrouter_control_client_key_quotas q ON q.key_id = k.id
ORDER BY k.revision DESC, k.id ASC"#;
const LIST_CLIENT_KEY_PREFERENCES: &str = "SELECT key_id, model_id_format, revision FROM redrouter_control_client_key_preferences ORDER BY key_id ASC";
const LIST_CLIENT_KEY_SCHEDULES: &str = "SELECT key_id, schedule_json, revision FROM redrouter_control_client_key_schedules ORDER BY key_id ASC";
const LIST_CLIENT_KEY_MODEL_ACCESS: &str = "SELECT key_id, model_access_mode, revision FROM redrouter_control_client_key_model_access ORDER BY key_id ASC";
const LIST_CLIENT_KEY_COMBO_ACCESS: &str = "SELECT key_id, allowed_combos_json, revision FROM redrouter_control_client_key_combo_access ORDER BY key_id ASC";
const UPSERT_CLIENT_KEY: &str = "INSERT INTO redrouter_control_client_keys (id, label, key_hash, enabled, expiry_unix, scopes_json, allowed_endpoints_json, allowed_models_json, blocked_models_json, allowed_provider_ids_json, max_concurrent, max_rpm, max_rpd, revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (id) DO UPDATE SET label = $2, key_hash = $3, enabled = $4, expiry_unix = $5, scopes_json = $6, allowed_endpoints_json = $7, allowed_models_json = $8, blocked_models_json = $9, allowed_provider_ids_json = $10, max_concurrent = $11, max_rpm = $12, max_rpd = $13, revision = $14";
const UPSERT_CLIENT_KEY_PREFERENCE: &str = "INSERT INTO redrouter_control_client_key_preferences (key_id, model_id_format, revision) VALUES ($1,$2,$3) ON CONFLICT (key_id) DO UPDATE SET model_id_format = $2, revision = $3";
const UPSERT_CLIENT_KEY_SCHEDULE: &str = "INSERT INTO redrouter_control_client_key_schedules (key_id, schedule_json, revision) VALUES ($1,$2,$3) ON CONFLICT (key_id) DO UPDATE SET schedule_json = $2, revision = $3";
const UPSERT_CLIENT_KEY_MODEL_ACCESS: &str = "INSERT INTO redrouter_control_client_key_model_access (key_id, model_access_mode, revision) VALUES ($1,$2,$3) ON CONFLICT (key_id) DO UPDATE SET model_access_mode = $2, revision = $3";
const UPSERT_CLIENT_KEY_COMBO_ACCESS: &str = "INSERT INTO redrouter_control_client_key_combo_access (key_id, allowed_combos_json, revision) VALUES ($1,$2,$3) ON CONFLICT (key_id) DO UPDATE SET allowed_combos_json = $2, revision = $3";
const CREATE_TENANTS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_tenants (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, enabled BIGINT NOT NULL, revision BIGINT NOT NULL)";
const SEED_DEFAULT_TENANT: &str = "INSERT INTO redrouter_control_tenants (id, slug, name, enabled, revision) VALUES ('red','red','Red',1,0) ON CONFLICT (id) DO NOTHING";
const LIST_TENANTS: &str = "SELECT id, slug, name, enabled, revision FROM redrouter_control_tenants ORDER BY revision DESC, id ASC";
const UPSERT_TENANT: &str = "INSERT INTO redrouter_control_tenants (id, slug, name, enabled, revision) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET slug = $2, name = $3, enabled = $4, revision = $5";
const CREATE_IDENTITY_BINDINGS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_identity_bindings (id TEXT PRIMARY KEY, subject TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, binding_role TEXT NOT NULL, enabled BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_IDENTITY_BINDINGS: &str = "SELECT id, subject, tenant_id, binding_role, enabled, revision FROM redrouter_control_identity_bindings ORDER BY revision DESC, id ASC";
const UPSERT_IDENTITY_BINDING: &str = "INSERT INTO redrouter_control_identity_bindings (id, subject, tenant_id, binding_role, enabled, revision) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET subject = $2, tenant_id = $3, binding_role = $4, enabled = $5, revision = $6";
const DELETE_IDENTITY_BINDING: &str =
    "DELETE FROM redrouter_control_identity_bindings WHERE id = $1";
const CREATE_AUDIT_EVENTS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_audit_events (id TEXT PRIMARY KEY, created_at_unix_ms BIGINT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, tenant_id TEXT NOT NULL, target TEXT NOT NULL, resource_type TEXT NOT NULL, status TEXT NOT NULL, request_id TEXT NOT NULL, details_json TEXT NOT NULL)";
const CREATE_AUDIT_TIME_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_control_audit_time ON redrouter_control_audit_events (created_at_unix_ms, id)";
const CREATE_AUDIT_TENANT_TIME_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_control_audit_tenant_time ON redrouter_control_audit_events (tenant_id, created_at_unix_ms, id)";
const LIST_AUDIT_EVENTS: &str = "SELECT id, created_at_unix_ms, action, actor, tenant_id, target, resource_type, status, request_id, details_json FROM redrouter_control_audit_events ORDER BY created_at_unix_ms DESC, id DESC LIMIT 2000";
const LIST_TENANT_AUDIT_EVENTS: &str = "SELECT id, created_at_unix_ms, action, actor, tenant_id, target, resource_type, status, request_id, details_json FROM redrouter_control_audit_events WHERE tenant_id = $1 ORDER BY created_at_unix_ms DESC, id DESC LIMIT 2000";
const INSERT_AUDIT_EVENT: &str = "INSERT INTO redrouter_control_audit_events (id, created_at_unix_ms, action, actor, tenant_id, target, resource_type, status, request_id, details_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)";
const CREATE_AUDIT_OUTBOX: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_audit_outbox (event_id TEXT PRIMARY KEY, created_at_unix_ms BIGINT NOT NULL, tenant_id TEXT NOT NULL, topic TEXT NOT NULL, schema_version BIGINT NOT NULL, payload_json TEXT NOT NULL)";
const CREATE_AUDIT_OUTBOX_ORDER_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_control_audit_outbox_order ON redrouter_control_audit_outbox (created_at_unix_ms, event_id)";
const INSERT_AUDIT_OUTBOX: &str = "INSERT INTO redrouter_control_audit_outbox (event_id, created_at_unix_ms, tenant_id, topic, schema_version, payload_json) VALUES ($1,$2,$3,$4,$5,$6)";
const CREATE_AUDIT_SINK_CURSORS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_audit_sink_cursors (sink_id TEXT PRIMARY KEY, cursor_created_at_unix_ms BIGINT NOT NULL, cursor_event_id TEXT NOT NULL, lease_owner TEXT NOT NULL, lease_until_unix_ms BIGINT NOT NULL, revision BIGINT NOT NULL)";
const READ_AUDIT_SINK_CURSOR: &str = "SELECT sink_id, cursor_created_at_unix_ms, cursor_event_id, lease_owner, lease_until_unix_ms, revision FROM redrouter_control_audit_sink_cursors WHERE sink_id = $1";
const ACQUIRE_AUDIT_SINK_LEASE: &str = "INSERT INTO redrouter_control_audit_sink_cursors (sink_id, cursor_created_at_unix_ms, cursor_event_id, lease_owner, lease_until_unix_ms, revision) VALUES ($1,0,'',$2,$3,$4) ON CONFLICT (sink_id) DO UPDATE SET lease_owner = $2, lease_until_unix_ms = $3, revision = $4 WHERE redrouter_control_audit_sink_cursors.lease_until_unix_ms <= $4 OR redrouter_control_audit_sink_cursors.lease_owner = $2";
const ADVANCE_AUDIT_SINK_CURSOR: &str = "UPDATE redrouter_control_audit_sink_cursors SET cursor_created_at_unix_ms = $3, cursor_event_id = $4, revision = $5 WHERE sink_id = $1 AND lease_owner = $2 AND lease_until_unix_ms > $5 AND (cursor_created_at_unix_ms < $3 OR (cursor_created_at_unix_ms = $3 AND cursor_event_id < $4))";
const RELEASE_AUDIT_SINK_LEASE: &str = "UPDATE redrouter_control_audit_sink_cursors SET lease_owner = '', lease_until_unix_ms = 0, revision = $3 WHERE sink_id = $1 AND lease_owner = $2";
const CREATE_CLIENT_KEY_OWNERSHIP: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_client_key_ownership (key_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, created_by TEXT NOT NULL, revision BIGINT NOT NULL)";
const LIST_CLIENT_KEY_OWNERSHIP: &str = "SELECT key_id, tenant_id, created_by, revision FROM redrouter_control_client_key_ownership ORDER BY key_id ASC";
const UPSERT_CLIENT_KEY_OWNERSHIP: &str = "INSERT INTO redrouter_control_client_key_ownership (key_id, tenant_id, created_by, revision) VALUES ($1,$2,$3,$4) ON CONFLICT (key_id) DO UPDATE SET tenant_id = $2, created_by = $3, revision = $4";
const CREATE_CLIENT_KEY_QUOTAS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_client_key_quotas (key_id TEXT PRIMARY KEY, max_tokens_per_minute BIGINT NOT NULL, max_tokens_per_day BIGINT NOT NULL, max_monthly_microusd BIGINT NOT NULL, reservation_tokens BIGINT NOT NULL, reservation_microusd BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_CLIENT_KEY_QUOTAS: &str = "SELECT key_id, max_tokens_per_minute, max_tokens_per_day, max_monthly_microusd, reservation_tokens, reservation_microusd, revision FROM redrouter_control_client_key_quotas ORDER BY key_id ASC";
const UPSERT_CLIENT_KEY_QUOTA: &str = "INSERT INTO redrouter_control_client_key_quotas (key_id, max_tokens_per_minute, max_tokens_per_day, max_monthly_microusd, reservation_tokens, reservation_microusd, revision) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (key_id) DO UPDATE SET max_tokens_per_minute = $2, max_tokens_per_day = $3, max_monthly_microusd = $4, reservation_tokens = $5, reservation_microusd = $6, revision = $7";
const CREATE_USAGE_RESERVATIONS: &str = "CREATE TABLE IF NOT EXISTS redrouter_usage_reservations (event_id TEXT PRIMARY KEY, key_id TEXT NOT NULL, tenant_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, quota_model TEXT NOT NULL DEFAULT '', reserved_tokens BIGINT NOT NULL, reserved_microusd BIGINT NOT NULL, created_at_unix_ms BIGINT NOT NULL, state TEXT NOT NULL, end_user TEXT, tags_json TEXT NOT NULL DEFAULT '[]')";
const CREATE_DASHBOARD_KEY_VALUE: &str = "CREATE TABLE IF NOT EXISTS key_value (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (namespace,key))";
const CREATE_USAGE_LEDGER: &str = "CREATE TABLE IF NOT EXISTS redrouter_usage_ledger (event_id TEXT PRIMARY KEY, key_id TEXT NOT NULL, key_name TEXT NOT NULL DEFAULT '', tenant_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, quota_model TEXT NOT NULL DEFAULT '', usage_kind TEXT NOT NULL DEFAULT 'tokens', search_units BIGINT NOT NULL DEFAULT 0, tokens_input BIGINT NOT NULL, tokens_output BIGINT NOT NULL, tokens_cache_read BIGINT NOT NULL, tokens_cache_creation BIGINT NOT NULL, tokens_reasoning BIGINT NOT NULL, amount_microusd BIGINT NOT NULL, pricing_known BIGINT NOT NULL, pricing_snapshot TEXT, created_at_unix_ms BIGINT NOT NULL, end_user TEXT, tags_json TEXT NOT NULL DEFAULT '[]')";
const CREATE_USAGE_COUNTERS: &str = "CREATE TABLE IF NOT EXISTS redrouter_usage_counters (key_id TEXT NOT NULL, minute_bucket BIGINT NOT NULL, consumed_tokens BIGINT NOT NULL, updated_at_unix_ms BIGINT NOT NULL, PRIMARY KEY (key_id, minute_bucket))";
const CREATE_LEGACY_QUOTA_BASELINES: &str = "CREATE TABLE IF NOT EXISTS redrouter_legacy_quota_baselines (key_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, day_start_unix_ms BIGINT NOT NULL, daily_tokens BIGINT NOT NULL, month_start_unix_ms BIGINT NOT NULL, monthly_microusd BIGINT NOT NULL)";
const CREATE_LEGACY_MODEL_TOKEN_BASELINES: &str = "CREATE TABLE IF NOT EXISTS redrouter_legacy_model_token_baselines (key_id TEXT NOT NULL, model TEXT NOT NULL, reset_interval TEXT NOT NULL, window_start_unix_ms BIGINT NOT NULL, tokens_used BIGINT NOT NULL, PRIMARY KEY (key_id, model, reset_interval))";
const CREATE_CLIENT_MODEL_TOKEN_LIMITS: &str = "CREATE TABLE IF NOT EXISTS redrouter_client_model_token_limits (key_id TEXT NOT NULL, model TEXT NOT NULL, reset_interval TEXT NOT NULL, reset_minutes BIGINT NOT NULL, token_limit BIGINT NOT NULL, PRIMARY KEY (key_id, model, reset_interval))";
const CREATE_REQUEST_RATE_COUNTERS: &str = "CREATE TABLE IF NOT EXISTS redrouter_request_rate_counters (key_id TEXT NOT NULL, window_seconds BIGINT NOT NULL, bucket_index BIGINT NOT NULL, consumed_requests BIGINT NOT NULL, updated_at_unix_ms BIGINT NOT NULL, PRIMARY KEY (key_id, window_seconds, bucket_index))";
const CREATE_SHARED_BUDGETS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_budgets (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, max_microusd BIGINT NOT NULL, reservation_microusd BIGINT NOT NULL, duration TEXT NOT NULL, enabled BIGINT NOT NULL, key_ids_json TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]', users_json TEXT NOT NULL DEFAULT '[]', revision BIGINT NOT NULL)";
const CREATE_SHARED_BUDGET_TENANT_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_control_budgets_tenant ON redrouter_control_budgets (tenant_id, enabled, id)";
const CREATE_USAGE_RESERVATIONS_KEY_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_usage_reservations_key_time ON redrouter_usage_reservations (key_id, created_at_unix_ms)";
const CREATE_USAGE_RESERVATIONS_TENANT_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_usage_reservations_tenant_time ON redrouter_usage_reservations (tenant_id, created_at_unix_ms DESC)";
const CREATE_USAGE_LEDGER_KEY_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_usage_ledger_key_time ON redrouter_usage_ledger (key_id, created_at_unix_ms DESC, event_id DESC)";
const CREATE_USAGE_LEDGER_TENANT_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_usage_ledger_tenant_time ON redrouter_usage_ledger (tenant_id, created_at_unix_ms DESC, event_id DESC)";
const CREATE_USAGE_LEDGER_TENANT_KEY_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_usage_ledger_tenant_key_time ON redrouter_usage_ledger (tenant_id, key_id, created_at_unix_ms DESC, event_id DESC)";
// MODE is a RedDB keyword. Keep the dashboard contract's field name, but quote the
// durable column so the same schema is accepted by SQLite, PostgreSQL and RedDB.
const CREATE_USAGE_EXPORTS: &str = "CREATE TABLE IF NOT EXISTS redrouter_control_usage_exports (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, export_type TEXT NOT NULL, \"mode\" TEXT NOT NULL, window_sec BIGINT NOT NULL, api_key_ids_json TEXT NOT NULL, project_id TEXT NOT NULL, dataset_id TEXT NOT NULL, table_id TEXT NOT NULL, service_account_ciphertext TEXT NOT NULL, config_json TEXT NOT NULL, secret_ciphertext TEXT NOT NULL, batch_size BIGINT NOT NULL, interval_seconds BIGINT NOT NULL, enabled BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_USAGE_EXPORTS: &str = "SELECT id, tenant_id, name, export_type, \"mode\", window_sec, api_key_ids_json, project_id, dataset_id, table_id, service_account_ciphertext, config_json, secret_ciphertext, batch_size, interval_seconds, enabled, revision FROM redrouter_control_usage_exports ORDER BY revision DESC, id ASC";
const UPSERT_USAGE_EXPORT: &str = "INSERT INTO redrouter_control_usage_exports (id, tenant_id, name, export_type, \"mode\", window_sec, api_key_ids_json, project_id, dataset_id, table_id, service_account_ciphertext, config_json, secret_ciphertext, batch_size, interval_seconds, enabled, revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (id) DO NOTHING";
const UPDATE_USAGE_EXPORT: &str = "UPDATE redrouter_control_usage_exports SET name = $3, export_type = $4, \"mode\" = $5, window_sec = $6, api_key_ids_json = $7, project_id = $8, dataset_id = $9, table_id = $10, service_account_ciphertext = $11, config_json = $12, secret_ciphertext = $13, batch_size = $14, interval_seconds = $15, enabled = $16, revision = $17 WHERE id = $1 AND tenant_id = $2 AND revision = $18";
const DELETE_USAGE_EXPORT: &str =
    "DELETE FROM redrouter_control_usage_exports WHERE id = $1 AND revision = $2";
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
const CREATE_CONTEXT_RELAY_SESSIONS: &str = "CREATE TABLE IF NOT EXISTS redrouter_context_relay_sessions (record_id TEXT PRIMARY KEY, combo_id TEXT NOT NULL, provider_id TEXT NOT NULL, model TEXT NOT NULL, updated_at_unix_ms BIGINT NOT NULL)";
const READ_CONTEXT_RELAY_SESSION: &str = "SELECT combo_id, provider_id, model, updated_at_unix_ms FROM redrouter_context_relay_sessions WHERE record_id = $1";
const UPSERT_CONTEXT_RELAY_SESSION: &str = "INSERT INTO redrouter_context_relay_sessions (record_id, combo_id, provider_id, model, updated_at_unix_ms) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (record_id) DO UPDATE SET combo_id = $2, provider_id = $3, model = $4, updated_at_unix_ms = $5";
const CREATE_CONTEXT_RELAY_HANDOFFS: &str = "CREATE TABLE IF NOT EXISTS redrouter_context_relay_handoffs (record_id TEXT PRIMARY KEY, combo_id TEXT NOT NULL, summary TEXT NOT NULL, key_decisions_json TEXT NOT NULL, task_progress TEXT NOT NULL, active_entities_json TEXT NOT NULL, message_count BIGINT NOT NULL, source_model TEXT NOT NULL, summary_model TEXT NOT NULL, generated_at_unix_ms BIGINT NOT NULL, expires_at_unix_ms BIGINT NOT NULL)";
const READ_CONTEXT_RELAY_HANDOFF: &str = "SELECT combo_id, summary, key_decisions_json, task_progress, active_entities_json, message_count, source_model, summary_model, generated_at_unix_ms, expires_at_unix_ms FROM redrouter_context_relay_handoffs WHERE record_id = $1";
const UPSERT_CONTEXT_RELAY_HANDOFF: &str = "INSERT INTO redrouter_context_relay_handoffs (record_id, combo_id, summary, key_decisions_json, task_progress, active_entities_json, message_count, source_model, summary_model, generated_at_unix_ms, expires_at_unix_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (record_id) DO UPDATE SET combo_id = $2, summary = $3, key_decisions_json = $4, task_progress = $5, active_entities_json = $6, message_count = $7, source_model = $8, summary_model = $9, generated_at_unix_ms = $10, expires_at_unix_ms = $11";
const CREATE_CONTEXT_RELAY_GENERATION_LEASES: &str = "CREATE TABLE IF NOT EXISTS redrouter_context_relay_generation_leases (record_id TEXT PRIMARY KEY, owner TEXT NOT NULL, lease_until_unix_ms BIGINT NOT NULL)";
const ACQUIRE_CONTEXT_RELAY_GENERATION_LEASE: &str = "INSERT INTO redrouter_context_relay_generation_leases (record_id, owner, lease_until_unix_ms) VALUES ($1,$2,$3) ON CONFLICT (record_id) DO UPDATE SET owner = $2, lease_until_unix_ms = $3 WHERE redrouter_context_relay_generation_leases.lease_until_unix_ms <= $4 OR redrouter_context_relay_generation_leases.owner = $2";
const RELEASE_CONTEXT_RELAY_GENERATION_LEASE: &str = "UPDATE redrouter_context_relay_generation_leases SET lease_until_unix_ms = 0 WHERE record_id = $1 AND owner = $2";
const CREATE_PROVIDER_QUOTAS: &str = "CREATE TABLE IF NOT EXISTS redrouter_provider_quotas (provider_id TEXT PRIMARY KEY, session_remaining_ppm BIGINT NOT NULL, session_reset_unix_ms BIGINT NOT NULL, weekly_remaining_ppm BIGINT NOT NULL, weekly_reset_unix_ms BIGINT NOT NULL, limit_reached BIGINT NOT NULL, observed_at_unix_ms BIGINT NOT NULL, expires_at_unix_ms BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_PROVIDER_QUOTAS: &str = "SELECT provider_id, session_remaining_ppm, session_reset_unix_ms, weekly_remaining_ppm, weekly_reset_unix_ms, limit_reached, observed_at_unix_ms, expires_at_unix_ms, revision FROM redrouter_provider_quotas ORDER BY provider_id ASC";
const UPSERT_PROVIDER_QUOTA: &str = "INSERT INTO redrouter_provider_quotas (provider_id, session_remaining_ppm, session_reset_unix_ms, weekly_remaining_ppm, weekly_reset_unix_ms, limit_reached, observed_at_unix_ms, expires_at_unix_ms, revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (provider_id) DO UPDATE SET session_remaining_ppm = $2, session_reset_unix_ms = $3, weekly_remaining_ppm = $4, weekly_reset_unix_ms = $5, limit_reached = $6, observed_at_unix_ms = $7, expires_at_unix_ms = $8, revision = $9";
const DELETE_PROVIDER_QUOTA: &str = "DELETE FROM redrouter_provider_quotas WHERE provider_id = $1";
const CREATE_PROVIDER_MODEL_QUOTAS: &str = "CREATE TABLE IF NOT EXISTS redrouter_provider_model_quotas (record_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, session_remaining_ppm BIGINT NOT NULL, session_reset_unix_ms BIGINT NOT NULL, weekly_remaining_ppm BIGINT NOT NULL, weekly_reset_unix_ms BIGINT NOT NULL, limit_reached BIGINT NOT NULL, observed_at_unix_ms BIGINT NOT NULL, expires_at_unix_ms BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_PROVIDER_MODEL_QUOTAS: &str = "SELECT provider_id, model_id, session_remaining_ppm, session_reset_unix_ms, weekly_remaining_ppm, weekly_reset_unix_ms, limit_reached, observed_at_unix_ms, expires_at_unix_ms, revision FROM redrouter_provider_model_quotas ORDER BY provider_id ASC, model_id ASC";
const UPSERT_PROVIDER_MODEL_QUOTA: &str = "INSERT INTO redrouter_provider_model_quotas (record_id, provider_id, model_id, session_remaining_ppm, session_reset_unix_ms, weekly_remaining_ppm, weekly_reset_unix_ms, limit_reached, observed_at_unix_ms, expires_at_unix_ms, revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (record_id) DO UPDATE SET session_remaining_ppm = $4, session_reset_unix_ms = $5, weekly_remaining_ppm = $6, weekly_reset_unix_ms = $7, limit_reached = $8, observed_at_unix_ms = $9, expires_at_unix_ms = $10, revision = $11";
const DELETE_PROVIDER_MODEL_QUOTAS: &str =
    "DELETE FROM redrouter_provider_model_quotas WHERE provider_id = $1";
const CREATE_BREAKERS: &str = "CREATE TABLE IF NOT EXISTS redrouter_provider_breakers (provider_id TEXT PRIMARY KEY, breaker_state TEXT NOT NULL, failure_count BIGINT NOT NULL, last_failure_unix_ms BIGINT NOT NULL, open_cycle_count BIGINT NOT NULL, failure_threshold BIGINT NOT NULL, degradation_threshold BIGINT NOT NULL, reset_timeout_ms BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_BREAKERS: &str = "SELECT provider_id, breaker_state, failure_count, last_failure_unix_ms, open_cycle_count, failure_threshold, degradation_threshold, reset_timeout_ms, revision FROM redrouter_provider_breakers ORDER BY provider_id ASC";
const UPSERT_BREAKER: &str = "INSERT INTO redrouter_provider_breakers (provider_id, breaker_state, failure_count, last_failure_unix_ms, open_cycle_count, failure_threshold, degradation_threshold, reset_timeout_ms, revision) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (provider_id) DO UPDATE SET breaker_state = $2, failure_count = $3, last_failure_unix_ms = $4, open_cycle_count = $5, failure_threshold = $6, degradation_threshold = $7, reset_timeout_ms = $8, revision = $9";
const DELETE_BREAKER: &str = "DELETE FROM redrouter_provider_breakers WHERE provider_id = $1";
const CREATE_BREAKER_OVERRIDES: &str = "CREATE TABLE IF NOT EXISTS redrouter_provider_breaker_overrides (provider_id TEXT PRIMARY KEY, failure_threshold BIGINT NOT NULL, degradation_threshold BIGINT NOT NULL, reset_timeout_ms BIGINT NOT NULL, revision BIGINT NOT NULL)";
const LIST_BREAKER_OVERRIDES: &str = "SELECT provider_id, failure_threshold, degradation_threshold, reset_timeout_ms, revision FROM redrouter_provider_breaker_overrides ORDER BY provider_id ASC";
const UPSERT_BREAKER_OVERRIDE: &str = "INSERT INTO redrouter_provider_breaker_overrides (provider_id, failure_threshold, degradation_threshold, reset_timeout_ms, revision) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (provider_id) DO UPDATE SET failure_threshold = $2, degradation_threshold = $3, reset_timeout_ms = $4, revision = $5";
const DELETE_BREAKER_OVERRIDE: &str =
    "DELETE FROM redrouter_provider_breaker_overrides WHERE provider_id = $1";
const CREATE_AVAILABILITY: &str = "CREATE TABLE IF NOT EXISTS redrouter_provider_availability (provider_id TEXT PRIMARY KEY, cooldown_until_unix_ms BIGINT NOT NULL, backoff_level BIGINT NOT NULL, last_status BIGINT NOT NULL, model_lockouts_json TEXT NOT NULL, revision BIGINT NOT NULL)";
const LIST_AVAILABILITY: &str = "SELECT provider_id, cooldown_until_unix_ms, backoff_level, last_status, model_lockouts_json, revision FROM redrouter_provider_availability ORDER BY provider_id ASC";
const UPSERT_AVAILABILITY: &str = "INSERT INTO redrouter_provider_availability (provider_id, cooldown_until_unix_ms, backoff_level, last_status, model_lockouts_json, revision) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provider_id) DO UPDATE SET cooldown_until_unix_ms = $2, backoff_level = $3, last_status = $4, model_lockouts_json = $5, revision = $6";
const DELETE_AVAILABILITY: &str =
    "DELETE FROM redrouter_provider_availability WHERE provider_id = $1";
const CREATE_RESILIENCE: &str = "CREATE TABLE IF NOT EXISTS redrouter_provider_resilience (record_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, rate_limit_scope TEXT NOT NULL, revision BIGINT NOT NULL)";
const LIST_RESILIENCE: &str = "SELECT provider_id, rate_limit_scope, revision FROM redrouter_provider_resilience ORDER BY provider_id ASC, revision DESC";
const UPSERT_RESILIENCE: &str = "INSERT INTO redrouter_provider_resilience (record_id, provider_id, rate_limit_scope, revision) VALUES ($1,$2,$3,$4) ON CONFLICT (record_id) DO UPDATE SET rate_limit_scope = $3";
const DELETE_RESILIENCE: &str = "DELETE FROM redrouter_provider_resilience WHERE provider_id = $1";
// Versioning avoids ALTER TABLE assumptions across SQLite, Postgres and RedDB.
// Keep the pre-cooldown shape as a read-only migration source and rollback
// target; new writes are authoritative in v2.
const CREATE_RUNTIME_SETTINGS_LEGACY: &str = "CREATE TABLE IF NOT EXISTS redrouter_runtime_settings (id BIGINT PRIMARY KEY, quota_preflight_enabled BIGINT NOT NULL, quota_preflight_threshold_ppm BIGINT NOT NULL, revision BIGINT NOT NULL)";
const READ_RUNTIME_SETTINGS_LEGACY: &str = "SELECT quota_preflight_enabled, quota_preflight_threshold_ppm, revision FROM redrouter_runtime_settings WHERE id = 1";
const CREATE_RUNTIME_SETTINGS: &str = "CREATE TABLE IF NOT EXISTS redrouter_runtime_settings_v2 (id BIGINT PRIMARY KEY, quota_preflight_enabled BIGINT NOT NULL, quota_preflight_threshold_ppm BIGINT NOT NULL, oauth_cooldown_base_ms BIGINT NOT NULL, oauth_cooldown_retry_hints BIGINT NOT NULL, oauth_cooldown_max_backoff_steps BIGINT NOT NULL, apikey_cooldown_base_ms BIGINT NOT NULL, apikey_cooldown_retry_hints BIGINT NOT NULL, apikey_cooldown_max_backoff_steps BIGINT NOT NULL, oauth_breaker_failure_threshold BIGINT NOT NULL, oauth_breaker_degradation_threshold BIGINT NOT NULL, oauth_breaker_reset_timeout_ms BIGINT NOT NULL, apikey_breaker_failure_threshold BIGINT NOT NULL, apikey_breaker_degradation_threshold BIGINT NOT NULL, apikey_breaker_reset_timeout_ms BIGINT NOT NULL, revision BIGINT NOT NULL)";
const READ_RUNTIME_SETTINGS: &str = "SELECT quota_preflight_enabled, quota_preflight_threshold_ppm, oauth_cooldown_base_ms, oauth_cooldown_retry_hints, oauth_cooldown_max_backoff_steps, apikey_cooldown_base_ms, apikey_cooldown_retry_hints, apikey_cooldown_max_backoff_steps, oauth_breaker_failure_threshold, oauth_breaker_degradation_threshold, oauth_breaker_reset_timeout_ms, apikey_breaker_failure_threshold, apikey_breaker_degradation_threshold, apikey_breaker_reset_timeout_ms, revision FROM redrouter_runtime_settings_v2 WHERE id = 1";
const UPSERT_RUNTIME_SETTINGS: &str = "INSERT INTO redrouter_runtime_settings_v2 (id, quota_preflight_enabled, quota_preflight_threshold_ppm, oauth_cooldown_base_ms, oauth_cooldown_retry_hints, oauth_cooldown_max_backoff_steps, apikey_cooldown_base_ms, apikey_cooldown_retry_hints, apikey_cooldown_max_backoff_steps, oauth_breaker_failure_threshold, oauth_breaker_degradation_threshold, oauth_breaker_reset_timeout_ms, apikey_breaker_failure_threshold, apikey_breaker_degradation_threshold, apikey_breaker_reset_timeout_ms, revision) VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO UPDATE SET quota_preflight_enabled = $1, quota_preflight_threshold_ppm = $2, oauth_cooldown_base_ms = $3, oauth_cooldown_retry_hints = $4, oauth_cooldown_max_backoff_steps = $5, apikey_cooldown_base_ms = $6, apikey_cooldown_retry_hints = $7, apikey_cooldown_max_backoff_steps = $8, oauth_breaker_failure_threshold = $9, oauth_breaker_degradation_threshold = $10, oauth_breaker_reset_timeout_ms = $11, apikey_breaker_failure_threshold = $12, apikey_breaker_degradation_threshold = $13, apikey_breaker_reset_timeout_ms = $14, revision = $15";
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
const CREATE_THOUGHT_SIGNATURES: &str = "CREATE TABLE IF NOT EXISTS redrouter_antigravity_thought_signatures (record_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, signature TEXT NOT NULL, created_at_unix_ms BIGINT NOT NULL, expires_at_unix_ms BIGINT NOT NULL)";
const CREATE_THOUGHT_SIGNATURE_EXPIRY_INDEX: &str = "CREATE INDEX IF NOT EXISTS redrouter_antigravity_thought_signatures_expiry ON redrouter_antigravity_thought_signatures (expires_at_unix_ms)";
const READ_THOUGHT_SIGNATURE: &str = "SELECT signature FROM redrouter_antigravity_thought_signatures WHERE provider_id = $1 AND tool_call_id = $2 AND expires_at_unix_ms > $3";
const UPSERT_THOUGHT_SIGNATURE: &str = "INSERT INTO redrouter_antigravity_thought_signatures (record_id, provider_id, tool_call_id, signature, created_at_unix_ms, expires_at_unix_ms) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (record_id) DO UPDATE SET signature = $4, created_at_unix_ms = $5, expires_at_unix_ms = $6";
const DELETE_EXPIRED_THOUGHT_SIGNATURES: &str =
    "DELETE FROM redrouter_antigravity_thought_signatures WHERE expires_at_unix_ms <= $1";
const DELETE_PROVIDER_THOUGHT_SIGNATURES: &str =
    "DELETE FROM redrouter_antigravity_thought_signatures WHERE provider_id = $1";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredProvider {
    pub node_id: Option<String>,
    pub protocol: String,
    pub priority: i64,
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
pub struct StoredProviderSession {
    pub provider_id: String,
    pub provider: String,
    pub session_ciphertext: String,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredProviderHeaders {
    pub provider_id: String,
    pub upstream_identity: String,
    pub headers_ciphertext: String,
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
    pub access_schedule_json: String,
    pub model_access_mode: String,
    pub allowed_combos_json: String,
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
struct StoredClientKeySchedule {
    key_id: String,
    schedule_json: String,
    revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StoredClientKeyModelAccess {
    key_id: String,
    model_access_mode: String,
    revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct StoredClientKeyComboAccess {
    key_id: String,
    allowed_combos_json: String,
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

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct StoredAuditEvent {
    pub id: String,
    pub created_at_unix_ms: i64,
    pub action: String,
    pub actor: String,
    pub tenant_id: String,
    pub target: String,
    pub resource_type: String,
    pub status: String,
    pub request_id: String,
    pub details_json: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredAuditOutboxEvent {
    pub event_id: String,
    pub created_at_unix_ms: i64,
    pub tenant_id: String,
    pub topic: String,
    pub schema_version: i64,
    pub payload_json: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredAuditSinkCursor {
    pub sink_id: String,
    pub cursor_created_at_unix_ms: i64,
    pub cursor_event_id: String,
    pub lease_owner: String,
    pub lease_until_unix_ms: i64,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredUsageExportEvent {
    pub event_id: String,
    pub created_at_unix_ms: i64,
    pub tenant_id: String,
    pub key_id: String,
    pub key_name: String,
    pub end_user: Option<String>,
    pub tags: Vec<String>,
    pub provider: String,
    pub model: String,
    pub usage_kind: String,
    pub search_units: i64,
    pub tokens_input: i64,
    pub tokens_output: i64,
    pub tokens_cache_read: i64,
    pub tokens_cache_creation: i64,
    pub tokens_reasoning: i64,
    pub amount_microusd: i64,
    pub pricing_known: bool,
    pub pricing_snapshot: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredUsageExport {
    pub id: String,
    pub tenant_id: String,
    pub name: String,
    pub export_type: String,
    pub mode: String,
    pub window_sec: i64,
    pub api_key_ids_json: String,
    pub project_id: String,
    pub dataset_id: String,
    pub table_id: String,
    pub service_account_ciphertext: String,
    /// Non-secret transport fields. Secret material must never be stored here.
    pub config_json: String,
    /// One authenticated ciphertext containing the transport's secret object.
    pub secret_ciphertext: String,
    pub batch_size: i64,
    pub interval_seconds: i64,
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
pub struct StoredContextRelaySession {
    pub record_id: String,
    pub combo_id: String,
    pub provider_id: String,
    pub model: String,
    pub updated_at_unix_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredContextRelayHandoff {
    pub record_id: String,
    pub combo_id: String,
    pub summary: String,
    pub key_decisions_json: String,
    pub task_progress: String,
    pub active_entities_json: String,
    pub message_count: i64,
    pub source_model: String,
    pub summary_model: String,
    pub generated_at_unix_ms: i64,
    pub expires_at_unix_ms: i64,
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
pub struct StoredProviderModelQuota {
    pub provider_id: String,
    pub model_id: String,
    pub session_remaining_ppm: i64,
    pub session_reset_unix_ms: i64,
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
pub struct StoredBreakerOverride {
    pub provider_id: String,
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
pub struct StoredRuntimeSettings {
    pub quota_preflight_enabled: bool,
    /// Parts per million remaining. Two percent is stored as 20_000.
    pub quota_preflight_threshold_ppm: i64,
    pub oauth_cooldown_base_ms: i64,
    pub oauth_cooldown_retry_hints: bool,
    pub oauth_cooldown_max_backoff_steps: i64,
    pub apikey_cooldown_base_ms: i64,
    pub apikey_cooldown_retry_hints: bool,
    pub apikey_cooldown_max_backoff_steps: i64,
    pub oauth_breaker_failure_threshold: i64,
    pub oauth_breaker_degradation_threshold: i64,
    pub oauth_breaker_reset_timeout_ms: i64,
    pub apikey_breaker_failure_threshold: i64,
    pub apikey_breaker_degradation_threshold: i64,
    pub apikey_breaker_reset_timeout_ms: i64,
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

async fn begin_client_key_update(
    pool: &AnyPool,
) -> Result<sqlx::Transaction<'static, sqlx::Any>, &'static str> {
    let sqlite = pool.connect_options().database_url.scheme() == "sqlite";
    let statement = if sqlite { "BEGIN IMMEDIATE" } else { "BEGIN" };
    for attempt in 0..3 {
        match pool.begin_with(statement).await {
            Ok(transaction) => return Ok(transaction),
            Err(error) => {
                let busy = sqlite
                    && error
                        .as_database_error()
                        .and_then(|error| error.code())
                        .and_then(|code| code.parse::<u32>().ok())
                        .is_some_and(|code| matches!(code & 0xff, 5 | 6));
                if !busy || attempt == 2 {
                    return Err("cannot begin client key update");
                }
                // No write has happened yet. Retry only lock contention, never a
                // constraint/IO error or an ambiguous commit; retain a bounded wait.
                tokio::time::sleep(std::time::Duration::from_millis(50 * (attempt + 1))).await;
            }
        }
    }
    unreachable!("bounded transaction acquisition")
}

impl Database {
    pub fn supports_audit_sink_leases(&self) -> bool {
        matches!(self, Self::Sql(_))
    }

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
                        CREATE_PROVIDER_SESSIONS,
                        CREATE_PROVIDER_HEADERS,
                        provider_discovery_storage::CREATE,
                        provider_protocol_storage::CREATE,
                        provider_priority_storage::CREATE,
                        provider_nodes_storage::CREATE,
                        provider_models_storage::CREATE,
                        model_aliases_storage::CREATE,
                        model_aliases_storage::STATE,
                        provider_node_binding_storage::CREATE,
                        CREATE_PROVIDER_OAUTH_STATUS,
                        CREATE_OAUTH_REFRESH_LEASES,
                        CREATE_CLIENT_KEYS,
                        CREATE_CLIENT_KEY_PREFERENCES,
                        CREATE_CLIENT_KEY_SCHEDULES,
                        CREATE_CLIENT_KEY_MODEL_ACCESS,
                        CREATE_CLIENT_KEY_COMBO_ACCESS,
                        CREATE_TENANTS,
                        CREATE_IDENTITY_BINDINGS,
                        CREATE_AUDIT_EVENTS,
                        CREATE_AUDIT_TIME_INDEX,
                        CREATE_AUDIT_TENANT_TIME_INDEX,
                        CREATE_AUDIT_OUTBOX,
                        CREATE_AUDIT_OUTBOX_ORDER_INDEX,
                        CREATE_AUDIT_SINK_CURSORS,
                        CREATE_USAGE_EXPORTS,
                        CREATE_CLIENT_KEY_OWNERSHIP,
                        CREATE_CLIENT_KEY_QUOTAS,
                        CREATE_COMBOS,
                        CREATE_COMBO_OWNERSHIP,
                        CREATE_ROUTE_PINS,
                        CREATE_CONTEXT_RELAY_SESSIONS,
                        CREATE_CONTEXT_RELAY_HANDOFFS,
                        CREATE_CONTEXT_RELAY_GENERATION_LEASES,
                        CREATE_PROVIDER_QUOTAS,
                        CREATE_PROVIDER_MODEL_QUOTAS,
                        CREATE_BREAKERS,
                        CREATE_BREAKER_OVERRIDES,
                        CREATE_AVAILABILITY,
                        CREATE_RESILIENCE,
                        CREATE_RUNTIME_SETTINGS_LEGACY,
                        CREATE_RUNTIME_SETTINGS,
                        CREATE_OIDC,
                        CREATE_OIDC_BROWSER,
                        CREATE_MODEL_CATALOG,
                        CREATE_THOUGHT_SIGNATURES,
                        CREATE_THOUGHT_SIGNATURE_EXPIRY_INDEX,
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
                db.remote_schema_query(CREATE_PROVIDER_SESSIONS).await?;
                db.remote_schema_query(CREATE_PROVIDER_HEADERS).await?;
                db.remote_schema_query(provider_discovery_storage::CREATE)
                    .await?;
                db.remote_schema_query(provider_protocol_storage::CREATE)
                    .await?;
                db.remote_schema_query(provider_priority_storage::CREATE)
                    .await?;
                db.remote_schema_query(model_aliases_storage::STATE).await?;
                db.remote_schema_query(model_aliases_storage::CREATE)
                    .await?;
                db.remote_schema_query(provider_models_storage::CREATE)
                    .await?;
                db.remote_schema_query(provider_nodes_storage::CREATE)
                    .await?;
                db.remote_schema_query(provider_node_binding_storage::CREATE)
                    .await?;
                db.remote_schema_query(CREATE_PROVIDER_OAUTH_STATUS).await?;
                db.remote_schema_query(CREATE_OAUTH_REFRESH_LEASES).await?;
                db.remote_schema_query(CREATE_CLIENT_KEYS).await?;
                db.remote_schema_query(CREATE_CLIENT_KEY_PREFERENCES)
                    .await?;
                db.remote_schema_query(CREATE_CLIENT_KEY_SCHEDULES).await?;
                db.remote_schema_query(CREATE_CLIENT_KEY_MODEL_ACCESS)
                    .await?;
                db.remote_schema_query(CREATE_CLIENT_KEY_COMBO_ACCESS)
                    .await?;
                db.remote_schema_query(CREATE_TENANTS).await?;
                db.remote_schema_query(CREATE_IDENTITY_BINDINGS).await?;
                db.remote_schema_query(CREATE_AUDIT_EVENTS).await?;
                db.remote_schema_query(CREATE_AUDIT_TIME_INDEX).await?;
                db.remote_schema_query(CREATE_AUDIT_TENANT_TIME_INDEX)
                    .await?;
                db.remote_schema_query(CREATE_AUDIT_OUTBOX).await?;
                db.remote_schema_query(CREATE_AUDIT_OUTBOX_ORDER_INDEX)
                    .await?;
                db.remote_schema_query(CREATE_AUDIT_SINK_CURSORS).await?;
                db.remote_schema_query(CREATE_USAGE_EXPORTS).await?;
                db.remote_schema_query(CREATE_CLIENT_KEY_OWNERSHIP).await?;
                db.remote_schema_query(CREATE_CLIENT_KEY_QUOTAS).await?;
                db.remote_schema_query(CREATE_COMBOS).await?;
                db.remote_schema_query(CREATE_COMBO_OWNERSHIP).await?;
                db.remote_schema_query(CREATE_ROUTE_PINS).await?;
                db.remote_schema_query(CREATE_CONTEXT_RELAY_SESSIONS)
                    .await?;
                db.remote_schema_query(CREATE_CONTEXT_RELAY_HANDOFFS)
                    .await?;
                db.remote_schema_query(CREATE_CONTEXT_RELAY_GENERATION_LEASES)
                    .await?;
                db.remote_schema_query(CREATE_PROVIDER_QUOTAS).await?;
                db.remote_schema_query(CREATE_PROVIDER_MODEL_QUOTAS).await?;
                db.remote_schema_query(CREATE_BREAKERS).await?;
                db.remote_schema_query(CREATE_BREAKER_OVERRIDES).await?;
                db.remote_schema_query(CREATE_AVAILABILITY).await?;
                db.remote_schema_query(CREATE_RESILIENCE).await?;
                db.remote_schema_query(CREATE_RUNTIME_SETTINGS_LEGACY)
                    .await?;
                db.remote_schema_query(CREATE_RUNTIME_SETTINGS).await?;
                db.remote_schema_query(CREATE_OIDC).await?;
                db.remote_schema_query(CREATE_OIDC_BROWSER).await?;
                db.remote_schema_query(CREATE_MODEL_CATALOG).await?;
                db.remote_schema_query(CREATE_THOUGHT_SIGNATURES).await?;
                db.remote_schema_query(CREATE_THOUGHT_SIGNATURE_EXPIRY_INDEX)
                    .await?;
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
                let connect_phase = std::sync::Arc::new(std::sync::atomic::AtomicU8::new(0));
                let observed_phase = connect_phase.clone();
                let pool = AnyPoolOptions::new()
                    .max_connections(if backend == Backend::Sqlite { 1 } else { 5 })
                    .acquire_timeout(std::time::Duration::from_secs(5))
                    .after_connect(move |connection, _| {
                        let phase = observed_phase.clone();
                        Box::pin(async move {
                            phase.store(1, std::sync::atomic::Ordering::Relaxed);
                            if backend == Backend::Sqlite {
                                sqlx::query("PRAGMA busy_timeout = 5000")
                                    .execute(&mut *connection)
                                    .await?;
                                phase.store(2, std::sync::atomic::Ordering::Relaxed);
                                // Read first: existing WAL databases need no mode-setting
                                // statement competing with another proxy's writer.
                                let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
                                    .fetch_one(&mut *connection)
                                    .await?;
                                if !mode.eq_ignore_ascii_case("wal")
                                    && !mode.eq_ignore_ascii_case("memory")
                                {
                                    phase.store(3, std::sync::atomic::Ordering::Relaxed);
                                    sqlx::query("PRAGMA journal_mode = WAL")
                                        .execute(&mut *connection)
                                        .await?;
                                }
                                // Preserve SQLite's durability defaults (synchronous/fsync).
                                phase.store(4, std::sync::atomic::Ordering::Relaxed);
                            }
                            Ok(())
                        })
                    })
                    .connect(url)
                    .await
                    .map_err(|error| {
                        // Report only a category: driver messages may contain
                        // a connection URL with credentials.
                        let category = match &error {
                            sqlx::Error::PoolTimedOut => "pool_timeout",
                            sqlx::Error::PoolClosed => "pool_closed",
                            sqlx::Error::Io(_) => "io",
                            sqlx::Error::Database(_) => "database",
                            _ => "driver",
                        };
                        eprintln!(
                            "Selected database connection failed: {category}; setup_phase={}",
                            connect_phase.load(std::sync::atomic::Ordering::Relaxed)
                        );
                        "cannot connect to selected database"
                    })?;
                for statement in [
                    CREATE,
                    CREATE_PROVIDERS,
                    CREATE_PROVIDER_OWNERSHIP,
                    CREATE_PROVIDER_AUTH,
                    CREATE_PROVIDER_OAUTH,
                    CREATE_PROVIDER_SESSIONS,
                    CREATE_PROVIDER_HEADERS,
                    provider_discovery_storage::CREATE,
                    provider_protocol_storage::CREATE,
                    provider_priority_storage::CREATE,
                    provider_nodes_storage::CREATE,
                    provider_models_storage::CREATE,
                    model_aliases_storage::CREATE,
                    model_aliases_storage::STATE,
                    provider_node_binding_storage::CREATE,
                    CREATE_PROVIDER_OAUTH_STATUS,
                    CREATE_OAUTH_REFRESH_LEASES,
                    CREATE_CLIENT_KEYS,
                    CREATE_CLIENT_KEY_PREFERENCES,
                    CREATE_CLIENT_KEY_SCHEDULES,
                    CREATE_CLIENT_KEY_MODEL_ACCESS,
                    CREATE_CLIENT_KEY_COMBO_ACCESS,
                    CREATE_TENANTS,
                    CREATE_IDENTITY_BINDINGS,
                    CREATE_AUDIT_EVENTS,
                    CREATE_AUDIT_TIME_INDEX,
                    CREATE_AUDIT_TENANT_TIME_INDEX,
                    CREATE_AUDIT_OUTBOX,
                    CREATE_AUDIT_OUTBOX_ORDER_INDEX,
                    CREATE_AUDIT_SINK_CURSORS,
                    CREATE_USAGE_EXPORTS,
                    CREATE_CLIENT_KEY_OWNERSHIP,
                    CREATE_CLIENT_KEY_QUOTAS,
                    CREATE_COMBOS,
                    CREATE_COMBO_OWNERSHIP,
                    CREATE_ROUTE_PINS,
                    CREATE_CONTEXT_RELAY_SESSIONS,
                    CREATE_CONTEXT_RELAY_HANDOFFS,
                    CREATE_CONTEXT_RELAY_GENERATION_LEASES,
                    CREATE_PROVIDER_QUOTAS,
                    CREATE_PROVIDER_MODEL_QUOTAS,
                    CREATE_BREAKERS,
                    CREATE_BREAKER_OVERRIDES,
                    CREATE_AVAILABILITY,
                    CREATE_RESILIENCE,
                    CREATE_RUNTIME_SETTINGS_LEGACY,
                    CREATE_RUNTIME_SETTINGS,
                    CREATE_OIDC,
                    CREATE_OIDC_BROWSER,
                    CREATE_MODEL_CATALOG,
                    CREATE_THOUGHT_SIGNATURES,
                    CREATE_THOUGHT_SIGNATURE_EXPIRY_INDEX,
                ] {
                    sqlx::query(statement)
                        .execute(&pool)
                        .await
                        .map_err(|_| "cannot initialize database")?;
                }
                sqlx::query(provider_models_storage::INDEX)
                    .execute(&pool)
                    .await
                    .map_err(|_| "cannot initialize provider model namespace")?;
                sqlx::query(model_aliases_storage::INDEX)
                    .execute(&pool)
                    .await
                    .map_err(|_| "cannot initialize provider model namespace")?;
                sqlx::query(provider_nodes_storage::INDEX)
                    .execute(&pool)
                    .await
                    .map_err(|_| "cannot initialize provider namespace index")?;
                if backend == Backend::Sqlite {
                    for statement in [
                        CREATE_DASHBOARD_KEY_VALUE,
                        CREATE_USAGE_RESERVATIONS,
                        CREATE_USAGE_LEDGER,
                        CREATE_USAGE_COUNTERS,
                        CREATE_LEGACY_QUOTA_BASELINES,
                        CREATE_LEGACY_MODEL_TOKEN_BASELINES,
                        CREATE_CLIENT_MODEL_TOKEN_LIMITS,
                        CREATE_REQUEST_RATE_COUNTERS,
                        CREATE_SHARED_BUDGETS,
                        CREATE_SHARED_BUDGET_TENANT_INDEX,
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
            Self::Sql(pool) => sqlx::query(LIST_PROVIDERS_SQL)
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
        let mut protocols = self.provider_protocols().await?;
        let mut priorities = if matches!(self, Self::Sql(_)) {
            None
        } else {
            Some(self.provider_priorities().await?)
        };
        let mut bindings = self.provider_node_bindings().await?;
        let nodes = self.provider_nodes().await?;
        for provider in &mut providers {
            if let Some(priorities) = &mut priorities {
                provider.priority = priorities
                    .remove(&(provider.id.clone(), provider.updated_at))
                    .unwrap_or(0);
            }
            provider.protocol = protocols
                .remove(&(provider.id.clone(), provider.updated_at))
                .unwrap_or_else(|| "auto".to_owned());
            if let Some(owner) = ownership
                .iter()
                .find(|owner| owner.provider_id == provider.id)
            {
                if owner.revision != provider.updated_at {
                    return Err("provider ownership revision mismatch");
                }
                provider.tenant_id.clone_from(&owner.tenant_id);
            }
            if let Some(node_id) = bindings.remove(&(provider.id.clone(), provider.updated_at)) {
                let node = nodes
                    .iter()
                    .find(|node| node.id == node_id && node.tenant_id == provider.tenant_id)
                    .ok_or("provider definition is unavailable")?;
                provider.node_id = Some(node_id);
                provider.provider.clone_from(&node.prefix);
                provider.upstream_url.clone_from(&node.upstream_url);
                provider.protocol.clone_from(&node.protocol);
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
        self.upsert_provider_protocol(provider).await?;
        self.upsert_provider_priority(provider).await?;
        self.upsert_provider_node_binding(provider).await?;
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
        let provider = StoredProvider {
            updated_at,
            ..provider
        };
        self.upsert_provider_protocol(&provider).await?;
        self.upsert_provider_priority(&provider).await?;
        self.upsert_provider_node_binding(&provider).await?;
        self.upsert_provider_ownership(&provider).await?;
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

    /// Permanently remove the disabled provider row and its ownership record.
    /// Callers delete provider-scoped auxiliary state first; deleting the
    /// provider row before ownership keeps a retry-safe orphan if the second
    /// statement fails on a backend without multi-statement transactions.
    pub async fn delete_provider(&self, id: &str) -> Result<(), &'static str> {
        self.delete_provider_protocols(id).await?;
        self.delete_provider_priorities(id).await?;
        self.delete_provider_node_bindings(id).await?;
        let params = || vec![reddb_client::Value::Text(id.to_owned())];
        match self {
            Self::Sql(pool) => {
                let mut transaction = pool
                    .begin()
                    .await
                    .map_err(|_| "cannot delete provider configuration")?;
                sqlx::query(DELETE_PROVIDER)
                    .bind(id)
                    .execute(&mut *transaction)
                    .await
                    .map_err(|_| "cannot delete provider configuration")?;
                sqlx::query(DELETE_PROVIDER_OWNERSHIP)
                    .bind(id)
                    .execute(&mut *transaction)
                    .await
                    .map_err(|_| "cannot delete provider configuration")?;
                transaction
                    .commit()
                    .await
                    .map_err(|_| "cannot delete provider configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE_PROVIDER, &params()).await?;
                self.remote_query(DELETE_PROVIDER_OWNERSHIP, &params())
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(DELETE_PROVIDER, params())
                    .await
                    .map_err(|_| "cannot delete provider configuration")?;
                db.query_with(DELETE_PROVIDER_OWNERSHIP, params())
                    .await
                    .map_err(|_| "cannot delete provider configuration")?;
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

    pub async fn provider_sessions(&self) -> Result<Vec<StoredProviderSession>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_PROVIDER_SESSIONS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read provider session configuration")?
                .iter()
                .map(read_sql_provider_session)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_PROVIDER_SESSIONS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_provider_session)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_PROVIDER_SESSIONS)
                .await
                .map_err(|_| "cannot read provider session configuration")?
                .rows
                .iter()
                .map(read_reddb_provider_session)
                .collect(),
        }
    }

    pub async fn upsert_provider_session(
        &self,
        session: &StoredProviderSession,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_PROVIDER_SESSION)
                    .bind(&session.provider_id)
                    .bind(&session.provider)
                    .bind(&session.session_ciphertext)
                    .bind(session.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider session configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_PROVIDER_SESSION, &provider_session_params(session))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_PROVIDER_SESSION, provider_session_params(session))
                    .await
                    .map_err(|_| "cannot write provider session configuration")?;
            }
        }
        Ok(())
    }

    pub async fn delete_provider_session(&self, provider_id: &str) -> Result<(), &'static str> {
        let params = || vec![reddb_client::Value::Text(provider_id.to_owned())];
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE_PROVIDER_SESSION)
                    .bind(provider_id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete provider session configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE_PROVIDER_SESSION, &params())
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(DELETE_PROVIDER_SESSION, params())
                    .await
                    .map_err(|_| "cannot delete provider session configuration")?;
            }
        }
        Ok(())
    }

    pub async fn provider_headers(&self) -> Result<Vec<StoredProviderHeaders>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_PROVIDER_HEADERS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read provider headers configuration")?
                .iter()
                .map(read_sql_provider_header)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_PROVIDER_HEADERS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_provider_header)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_PROVIDER_HEADERS)
                .await
                .map_err(|_| "cannot read provider headers configuration")?
                .rows
                .iter()
                .map(read_reddb_provider_header)
                .collect(),
        }
    }

    pub async fn upsert_provider_header(
        &self,
        entry: &StoredProviderHeaders,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_PROVIDER_HEADER)
                    .bind(&entry.provider_id)
                    .bind(&entry.upstream_identity)
                    .bind(&entry.headers_ciphertext)
                    .bind(entry.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider headers configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_PROVIDER_HEADER, &provider_header_params(entry))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_PROVIDER_HEADER, provider_header_params(entry))
                    .await
                    .map_err(|_| "cannot write provider headers configuration")?;
            }
        }
        Ok(())
    }

    pub async fn delete_provider_header(&self, provider_id: &str) -> Result<(), &'static str> {
        let params = || vec![reddb_client::Value::Text(provider_id.to_owned())];
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE_PROVIDER_HEADER)
                    .bind(provider_id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete provider headers configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE_PROVIDER_HEADER, &params()).await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(DELETE_PROVIDER_HEADER, params())
                    .await
                    .map_err(|_| "cannot delete provider headers configuration")?;
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

    pub async fn delete_identity_binding(&self, id: &str) -> Result<(), &'static str> {
        let params = || vec![reddb_client::Value::Text(id.to_owned())];
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE_IDENTITY_BINDING)
                    .bind(id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete identity binding configuration")?;
            }
            Self::Remote(_) => {
                self.remote_query(DELETE_IDENTITY_BINDING, &params())
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(DELETE_IDENTITY_BINDING, params())
                    .await
                    .map_err(|_| "cannot delete identity binding configuration")?;
            }
        }
        Ok(())
    }

    pub async fn audit_events(
        &self,
        tenant_id: Option<&str>,
    ) -> Result<Vec<StoredAuditEvent>, &'static str> {
        let sql = if tenant_id.is_some() {
            LIST_TENANT_AUDIT_EVENTS
        } else {
            LIST_AUDIT_EVENTS
        };
        let params = tenant_id
            .map(|tenant| vec![reddb_client::Value::Text(tenant.to_owned())])
            .unwrap_or_default();
        match self {
            Self::Sql(pool) => {
                let query = sqlx::query(sql);
                let query = if let Some(tenant) = tenant_id {
                    query.bind(tenant)
                } else {
                    query
                };
                query
                    .fetch_all(pool)
                    .await
                    .map_err(|_| "cannot read audit events")?
                    .iter()
                    .map(read_sql_audit_event)
                    .collect()
            }
            Self::Remote(_) => self
                .remote_query(sql, &params)
                .await?
                .rows
                .iter()
                .map(read_reddb_audit_event)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query_with(sql, params)
                .await
                .map_err(|_| "cannot read audit events")?
                .rows
                .iter()
                .map(read_reddb_audit_event)
                .collect(),
        }
    }

    pub async fn insert_audit_event(&self, event: &StoredAuditEvent) -> Result<(), &'static str> {
        let outbox_payload = serde_json::to_string(&serde_json::json!({
            "schemaVersion": 1,
            "topic": "redrouter.audit.v1",
            "event": event
        }))
        .map_err(|_| "cannot encode audit outbox event")?;
        match self {
            Self::Sql(pool) => {
                let mut transaction = pool
                    .begin()
                    .await
                    .map_err(|_| "cannot begin audit outbox transaction")?;
                sqlx::query(INSERT_AUDIT_EVENT)
                    .bind(&event.id)
                    .bind(event.created_at_unix_ms)
                    .bind(&event.action)
                    .bind(&event.actor)
                    .bind(&event.tenant_id)
                    .bind(&event.target)
                    .bind(&event.resource_type)
                    .bind(&event.status)
                    .bind(&event.request_id)
                    .bind(&event.details_json)
                    .execute(&mut *transaction)
                    .await
                    .map_err(|_| "cannot write audit event")?;
                sqlx::query(INSERT_AUDIT_OUTBOX)
                    .bind(&event.id)
                    .bind(event.created_at_unix_ms)
                    .bind(&event.tenant_id)
                    .bind("redrouter.audit.v1")
                    .bind(1_i64)
                    .bind(&outbox_payload)
                    .execute(&mut *transaction)
                    .await
                    .map_err(|_| "cannot write audit outbox event")?;
                transaction
                    .commit()
                    .await
                    .map_err(|_| "cannot commit audit outbox transaction")?;
            }
            Self::Remote(_) => {
                self.remote_query(INSERT_AUDIT_EVENT, &audit_event_params(event))
                    .await?;
                self.remote_query(
                    INSERT_AUDIT_OUTBOX,
                    &audit_outbox_params(event, &outbox_payload),
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(INSERT_AUDIT_EVENT, audit_event_params(event))
                    .await
                    .map_err(|_| "cannot write audit event")?;
                db.query_with(
                    INSERT_AUDIT_OUTBOX,
                    audit_outbox_params(event, &outbox_payload),
                )
                .await
                .map_err(|_| "cannot write audit outbox event")?;
            }
        }
        Ok(())
    }

    pub async fn audit_outbox_events(
        &self,
        after_created_at_unix_ms: i64,
        after_event_id: &str,
        limit: usize,
    ) -> Result<Vec<StoredAuditOutboxEvent>, &'static str> {
        let limit = limit.clamp(1, 1_000);
        let sql = format!(
            "SELECT event_id, created_at_unix_ms, tenant_id, topic, schema_version, payload_json FROM redrouter_control_audit_outbox WHERE created_at_unix_ms > $1 OR (created_at_unix_ms = $1 AND event_id > $2) ORDER BY created_at_unix_ms ASC, event_id ASC LIMIT {limit}"
        );
        let same_time_sql = format!(
            "SELECT event_id, created_at_unix_ms, tenant_id, topic, schema_version, payload_json FROM redrouter_control_audit_outbox WHERE created_at_unix_ms = $1 AND event_id > $2 ORDER BY created_at_unix_ms ASC, event_id ASC LIMIT {limit}"
        );
        let later_sql = format!(
            "SELECT event_id, created_at_unix_ms, tenant_id, topic, schema_version, payload_json FROM redrouter_control_audit_outbox WHERE created_at_unix_ms > $1 ORDER BY created_at_unix_ms ASC, event_id ASC LIMIT {limit}"
        );
        let same_time_params = vec![
            reddb_client::Value::Int(after_created_at_unix_ms),
            reddb_client::Value::Text(after_event_id.to_owned()),
        ];
        let later_params = vec![reddb_client::Value::Int(after_created_at_unix_ms)];
        match self {
            Self::Sql(pool) => sqlx::query(&sql)
                .bind(after_created_at_unix_ms)
                .bind(after_event_id)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read audit outbox events")?
                .iter()
                .map(read_sql_audit_outbox_event)
                .collect(),
            Self::Remote(_) => {
                let same_time = self.remote_query(&same_time_sql, &same_time_params).await?;
                let later = self.remote_query(&later_sql, &later_params).await?;
                Ok(merge_audit_outbox_rows(
                    same_time
                        .rows
                        .iter()
                        .chain(later.rows.iter())
                        .map(read_reddb_audit_outbox_event)
                        .collect::<Result<Vec<_>, _>>()?,
                    limit,
                ))
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                let same_time = db
                    .query_with(&same_time_sql, same_time_params)
                    .await
                    .map_err(|_| "cannot read audit outbox events")?;
                let later = db
                    .query_with(&later_sql, later_params)
                    .await
                    .map_err(|_| "cannot read audit outbox events")?;
                Ok(merge_audit_outbox_rows(
                    same_time
                        .rows
                        .iter()
                        .chain(later.rows.iter())
                        .map(read_reddb_audit_outbox_event)
                        .collect::<Result<Vec<_>, _>>()?,
                    limit,
                ))
            }
        }
    }

    pub async fn audit_sink_cursor(
        &self,
        sink_id: &str,
    ) -> Result<Option<StoredAuditSinkCursor>, &'static str> {
        let params = vec![reddb_client::Value::Text(sink_id.to_owned())];
        match self {
            Self::Sql(pool) => sqlx::query(READ_AUDIT_SINK_CURSOR)
                .bind(sink_id)
                .fetch_optional(pool)
                .await
                .map_err(|_| "cannot read audit sink cursor")?
                .as_ref()
                .map(read_sql_audit_sink_cursor)
                .transpose(),
            Self::Remote(_) => self
                .remote_query(READ_AUDIT_SINK_CURSOR, &params)
                .await?
                .rows
                .first()
                .map(read_reddb_audit_sink_cursor)
                .transpose(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query_with(READ_AUDIT_SINK_CURSOR, params)
                .await
                .map_err(|_| "cannot read audit sink cursor")?
                .rows
                .first()
                .map(read_reddb_audit_sink_cursor)
                .transpose(),
        }
    }

    pub async fn acquire_audit_sink_lease(
        &self,
        sink_id: &str,
        owner: &str,
        now_unix_ms: i64,
        lease_until_unix_ms: i64,
    ) -> Result<bool, &'static str> {
        let Self::Sql(pool) = self else {
            return Err("audit sink leases require SQLite or PostgreSQL");
        };
        let result = sqlx::query(ACQUIRE_AUDIT_SINK_LEASE)
            .bind(sink_id)
            .bind(owner)
            .bind(lease_until_unix_ms)
            .bind(now_unix_ms)
            .execute(pool)
            .await
            .map_err(|_| "cannot acquire audit sink lease")?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn usage_export_events(
        &self,
        after_created_at_unix_ms: i64,
        after_event_id: &str,
        limit: usize,
    ) -> Result<Vec<StoredUsageExportEvent>, &'static str> {
        if !(1..=500).contains(&limit) || after_created_at_unix_ms < 0 {
            return Err("invalid usage export cursor");
        }
        let Self::Sql(pool) = self else {
            return Err("usage export requires SQLite storage");
        };
        let limit = i64::try_from(limit).map_err(|_| "invalid usage export cursor")?;
        sqlx::query("SELECT event_id,created_at_unix_ms,tenant_id,key_id,CASE WHEN key_name = '' THEN key_id ELSE key_name END AS key_name,end_user,tags_json,provider,model,usage_kind,search_units,tokens_input,tokens_output,tokens_cache_read,tokens_cache_creation,tokens_reasoning,amount_microusd,pricing_known,pricing_snapshot FROM redrouter_usage_ledger WHERE created_at_unix_ms > $1 OR (created_at_unix_ms = $1 AND event_id > $2) ORDER BY created_at_unix_ms ASC,event_id ASC LIMIT $3")
            .bind(after_created_at_unix_ms)
            .bind(after_event_id)
            .bind(limit)
            .fetch_all(pool)
            .await
            .map_err(|_| "cannot read usage export events")?
            .iter()
            .map(read_sql_usage_export_event)
            .collect()
    }

    pub async fn usage_exports(&self) -> Result<Vec<StoredUsageExport>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_USAGE_EXPORTS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read usage export configuration")?
                .iter()
                .map(read_sql_usage_export)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_USAGE_EXPORTS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_usage_export)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_USAGE_EXPORTS)
                .await
                .map_err(|_| "cannot read usage export configuration")?
                .rows
                .iter()
                .map(read_reddb_usage_export)
                .collect(),
        }
    }

    pub async fn upsert_usage_export(
        &self,
        export: &StoredUsageExport,
    ) -> Result<(), &'static str> {
        let enabled = i64::from(export.enabled);
        match self {
            Self::Sql(pool) => {
                let result = sqlx::query(UPSERT_USAGE_EXPORT)
                    .bind(&export.id)
                    .bind(&export.tenant_id)
                    .bind(&export.name)
                    .bind(&export.export_type)
                    .bind(&export.mode)
                    .bind(export.window_sec)
                    .bind(&export.api_key_ids_json)
                    .bind(&export.project_id)
                    .bind(&export.dataset_id)
                    .bind(&export.table_id)
                    .bind(&export.service_account_ciphertext)
                    .bind(&export.config_json)
                    .bind(&export.secret_ciphertext)
                    .bind(export.batch_size)
                    .bind(export.interval_seconds)
                    .bind(enabled)
                    .bind(export.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write usage export configuration")?;
                if result.rows_affected() != 1 {
                    return Err("usage export identifier collision");
                }
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_USAGE_EXPORT, &usage_export_params(export, enabled))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_USAGE_EXPORT, usage_export_params(export, enabled))
                    .await
                    .map_err(|_| "cannot write usage export configuration")?;
            }
        }
        Ok(())
    }

    pub async fn update_usage_export(
        &self,
        export: &StoredUsageExport,
        expected_revision: i64,
    ) -> Result<(), &'static str> {
        let enabled = i64::from(export.enabled);
        match self {
            Self::Sql(pool) => {
                let result = sqlx::query(UPDATE_USAGE_EXPORT)
                    .bind(&export.id)
                    .bind(&export.tenant_id)
                    .bind(&export.name)
                    .bind(&export.export_type)
                    .bind(&export.mode)
                    .bind(export.window_sec)
                    .bind(&export.api_key_ids_json)
                    .bind(&export.project_id)
                    .bind(&export.dataset_id)
                    .bind(&export.table_id)
                    .bind(&export.service_account_ciphertext)
                    .bind(&export.config_json)
                    .bind(&export.secret_ciphertext)
                    .bind(export.batch_size)
                    .bind(export.interval_seconds)
                    .bind(enabled)
                    .bind(export.revision)
                    .bind(expected_revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot update usage export configuration")?;
                if result.rows_affected() != 1 {
                    return Err("usage export revision mismatch");
                }
            }
            _ => return Err("usage export updates currently require SQL storage"),
        }
        Ok(())
    }

    pub async fn delete_usage_export(
        &self,
        id: &str,
        expected_revision: i64,
    ) -> Result<bool, &'static str> {
        let existed = self
            .usage_exports()
            .await?
            .iter()
            .any(|export| export.id == id);
        if !existed {
            return Ok(false);
        }
        match self {
            Self::Sql(pool) => {
                let result = sqlx::query(DELETE_USAGE_EXPORT)
                    .bind(id)
                    .bind(expected_revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete usage export configuration")?;
                if result.rows_affected() != 1 {
                    return Err("usage export revision mismatch");
                }
            }
            _ => return Err("usage export deletion currently requires SQL storage"),
        }
        Ok(true)
    }

    pub async fn advance_audit_sink_cursor(
        &self,
        sink_id: &str,
        owner: &str,
        event: &StoredAuditOutboxEvent,
        now_unix_ms: i64,
    ) -> Result<(), &'static str> {
        self.advance_sink_cursor_position(
            sink_id,
            owner,
            event.created_at_unix_ms,
            &event.event_id,
            now_unix_ms,
        )
        .await
    }

    pub async fn advance_sink_cursor_position(
        &self,
        sink_id: &str,
        owner: &str,
        created_at_unix_ms: i64,
        event_id: &str,
        now_unix_ms: i64,
    ) -> Result<(), &'static str> {
        let Self::Sql(pool) = self else {
            return Err("audit sink cursors require SQLite or PostgreSQL");
        };
        let result = sqlx::query(ADVANCE_AUDIT_SINK_CURSOR)
            .bind(sink_id)
            .bind(owner)
            .bind(created_at_unix_ms)
            .bind(event_id)
            .bind(now_unix_ms)
            .execute(pool)
            .await
            .map_err(|_| "cannot advance audit sink cursor")?;
        if result.rows_affected() != 1 {
            return Err("audit sink lease lost");
        }
        Ok(())
    }

    pub async fn release_audit_sink_lease(
        &self,
        sink_id: &str,
        owner: &str,
        now_unix_ms: i64,
    ) -> Result<(), &'static str> {
        let Self::Sql(pool) = self else {
            return Err("audit sink leases require SQLite or PostgreSQL");
        };
        sqlx::query(RELEASE_AUDIT_SINK_LEASE)
            .bind(sink_id)
            .bind(owner)
            .bind(now_unix_ms)
            .execute(pool)
            .await
            .map_err(|_| "cannot release audit sink lease")?;
        Ok(())
    }

    pub async fn client_keys(&self) -> Result<Vec<StoredClientKey>, &'static str> {
        let mut keys: Vec<StoredClientKey> = match self {
            Self::Sql(pool) => {
                return sqlx::query(LIST_SQL_CLIENT_KEY_SNAPSHOT)
                    .fetch_all(pool)
                    .await
                    .map_err(|_| "cannot read client key configuration")?
                    .iter()
                    .map(read_sql_client_key_snapshot)
                    .collect()
            }
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
        // Sidecars are independently ordered. Index once rather than scanning all
        // keys for each row during every control-plane refresh (six quadratic joins).
        let key_indices: std::collections::HashMap<_, _> = keys
            .iter()
            .enumerate()
            .map(|(index, key)| (key.id.clone(), index))
            .collect();
        let preferences = self.client_key_preferences().await?;
        for preference in preferences {
            let Some(key) = key_indices
                .get(&preference.key_id)
                .and_then(|index| keys.get_mut(*index))
            else {
                // A preference is committed first. An orphan can therefore be
                // left by a failed new-key insert and is safe to ignore.
                continue;
            };
            if key.revision != preference.revision {
                return Err("client key preference revision mismatch");
            }
            key.model_id_format = preference.model_id_format;
        }
        for schedule in self.client_key_schedules().await? {
            let Some(key) = key_indices
                .get(&schedule.key_id)
                .and_then(|index| keys.get_mut(*index))
            else {
                // Sidecars are committed first. An orphan from a failed key
                // insert is inert and can be ignored.
                continue;
            };
            if key.revision != schedule.revision {
                return Err("client key access schedule revision mismatch");
            }
            key.access_schedule_json = schedule.schedule_json;
        }
        for access in self.client_key_model_access().await? {
            let Some(key) = key_indices
                .get(&access.key_id)
                .and_then(|index| keys.get_mut(*index))
            else {
                // Sidecars are committed first. An orphan from a failed key
                // insert is inert and can be ignored.
                continue;
            };
            if key.revision != access.revision {
                return Err("client key model access mode revision mismatch");
            }
            key.model_access_mode = access.model_access_mode;
        }
        for access in self.client_key_combo_access().await? {
            let Some(key) = key_indices
                .get(&access.key_id)
                .and_then(|index| keys.get_mut(*index))
            else {
                // Sidecars are committed first. An orphan from a failed key
                // insert is inert and can be ignored.
                continue;
            };
            if key.revision != access.revision {
                return Err("client key combo grants revision mismatch");
            }
            key.allowed_combos_json = access.allowed_combos_json;
        }
        for ownership in self.client_key_ownerships().await? {
            let Some(key) = key_indices
                .get(&ownership.key_id)
                .and_then(|index| keys.get_mut(*index))
            else {
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
            let Some(key) = key_indices
                .get(&quota.key_id)
                .and_then(|index| keys.get_mut(*index))
            else {
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
        if !matches!(key.model_access_mode.as_str(), "all" | "restricted") {
            return Err("invalid client key model access mode");
        }
        if !matches!(key.model_id_format.as_str(), "prefixed" | "flat") {
            return Err("invalid client key model ID format");
        }
        if !matches!(self, Self::Sql(_)) {
            self.upsert_client_key_combo_access(key).await?;
            self.upsert_client_key_model_access(key).await?;
            self.upsert_client_key_preference(key).await?;
            self.upsert_client_key_schedule(key).await?;
            self.upsert_client_key_ownership(key).await?;
            self.upsert_client_key_quota(key).await?;
        }
        let enabled = if key.enabled { 1_i64 } else { 0_i64 };
        match self {
            Self::Sql(pool) => {
                let mut transaction = begin_client_key_update(pool).await?;

                sqlx::query(UPSERT_CLIENT_KEY_COMBO_ACCESS)
                    .bind(&key.id)
                    .bind(&key.allowed_combos_json)
                    .bind(key.revision)
                    .execute(&mut *transaction)
                    .await
                    .map_err(|_| "cannot write client key combo grants")?;

                sqlx::query(UPSERT_CLIENT_KEY_MODEL_ACCESS)
                    .bind(&key.id)
                    .bind(&key.model_access_mode)
                    .bind(key.revision)
                    .execute(&mut *transaction)
                    .await
                    .map_err(|_| "cannot write client key model access mode")?;

                sqlx::query(UPSERT_CLIENT_KEY_PREFERENCE)
                    .bind(&key.id)
                    .bind(&key.model_id_format)
                    .bind(key.revision)
                    .execute(&mut *transaction)
                    .await
                    .map_err(|_| "cannot write client key preferences")?;

                sqlx::query(UPSERT_CLIENT_KEY_SCHEDULE)
                    .bind(&key.id)
                    .bind(&key.access_schedule_json)
                    .bind(key.revision)
                    .execute(&mut *transaction)
                    .await
                    .map_err(|_| "cannot write client key access schedule")?;

                sqlx::query(UPSERT_CLIENT_KEY_OWNERSHIP)
                    .bind(&key.id)
                    .bind(&key.tenant_id)
                    .bind(&key.created_by)
                    .bind(key.revision)
                    .execute(&mut *transaction)
                    .await
                    .map_err(|_| "cannot write client key ownership")?;

                sqlx::query(UPSERT_CLIENT_KEY_QUOTA)
                    .bind(&key.id)
                    .bind(key.max_tokens_per_minute)
                    .bind(key.max_tokens_per_day)
                    .bind(key.max_monthly_microusd)
                    .bind(key.reservation_tokens)
                    .bind(key.reservation_microusd)
                    .bind(key.revision)
                    .execute(&mut *transaction)
                    .await
                    .map_err(|_| "cannot write client key quotas")?;

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
                    .execute(&mut *transaction)
                    .await
                    .map_err(|_| "cannot write client key configuration")?;
                transaction
                    .commit()
                    .await
                    .map_err(|_| "cannot commit client key update")?;
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

    async fn client_key_schedules(&self) -> Result<Vec<StoredClientKeySchedule>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_CLIENT_KEY_SCHEDULES)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read client key access schedules")?
                .iter()
                .map(read_sql_client_key_schedule)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_CLIENT_KEY_SCHEDULES, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_client_key_schedule)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_CLIENT_KEY_SCHEDULES)
                .await
                .map_err(|_| "cannot read client key access schedules")?
                .rows
                .iter()
                .map(read_reddb_client_key_schedule)
                .collect(),
        }
    }

    async fn upsert_client_key_schedule(&self, key: &StoredClientKey) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_CLIENT_KEY_SCHEDULE)
                    .bind(&key.id)
                    .bind(&key.access_schedule_json)
                    .bind(key.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write client key access schedule")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_CLIENT_KEY_SCHEDULE, &client_key_schedule_params(key))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_CLIENT_KEY_SCHEDULE, client_key_schedule_params(key))
                    .await
                    .map_err(|_| "cannot write client key access schedule")?;
            }
        }
        Ok(())
    }

    async fn client_key_model_access(
        &self,
    ) -> Result<Vec<StoredClientKeyModelAccess>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_CLIENT_KEY_MODEL_ACCESS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read client key model access modes")?
                .iter()
                .map(read_sql_client_key_model_access)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_CLIENT_KEY_MODEL_ACCESS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_client_key_model_access)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_CLIENT_KEY_MODEL_ACCESS)
                .await
                .map_err(|_| "cannot read client key model access modes")?
                .rows
                .iter()
                .map(read_reddb_client_key_model_access)
                .collect(),
        }
    }

    async fn upsert_client_key_model_access(
        &self,
        key: &StoredClientKey,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_CLIENT_KEY_MODEL_ACCESS)
                    .bind(&key.id)
                    .bind(&key.model_access_mode)
                    .bind(key.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write client key model access mode")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    UPSERT_CLIENT_KEY_MODEL_ACCESS,
                    &client_key_model_access_params(key),
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    UPSERT_CLIENT_KEY_MODEL_ACCESS,
                    client_key_model_access_params(key),
                )
                .await
                .map_err(|_| "cannot write client key model access mode")?;
            }
        }
        Ok(())
    }

    async fn client_key_combo_access(
        &self,
    ) -> Result<Vec<StoredClientKeyComboAccess>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_CLIENT_KEY_COMBO_ACCESS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read client key combo grantss")?
                .iter()
                .map(read_sql_client_key_combo_access)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_CLIENT_KEY_COMBO_ACCESS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_client_key_combo_access)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_CLIENT_KEY_COMBO_ACCESS)
                .await
                .map_err(|_| "cannot read client key combo grantss")?
                .rows
                .iter()
                .map(read_reddb_client_key_combo_access)
                .collect(),
        }
    }

    async fn upsert_client_key_combo_access(
        &self,
        key: &StoredClientKey,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_CLIENT_KEY_COMBO_ACCESS)
                    .bind(&key.id)
                    .bind(&key.allowed_combos_json)
                    .bind(key.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write client key combo grants")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    UPSERT_CLIENT_KEY_COMBO_ACCESS,
                    &client_key_combo_access_params(key),
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    UPSERT_CLIENT_KEY_COMBO_ACCESS,
                    client_key_combo_access_params(key),
                )
                .await
                .map_err(|_| "cannot write client key combo grants")?;
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

    pub async fn context_relay_session(
        &self,
        record_id: &str,
    ) -> Result<Option<StoredContextRelaySession>, &'static str> {
        let params = [reddb_client::Value::Text(record_id.to_owned())];
        let record = match self {
            Self::Sql(pool) => sqlx::query(READ_CONTEXT_RELAY_SESSION)
                .bind(record_id)
                .fetch_optional(pool)
                .await
                .map_err(|_| "cannot read context relay session")?
                .as_ref()
                .map(read_sql_context_relay_session)
                .transpose()?,
            Self::Remote(_) => self
                .remote_query(READ_CONTEXT_RELAY_SESSION, &params)
                .await?
                .rows
                .first()
                .map(read_reddb_context_relay_session)
                .transpose()?,
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query_with(READ_CONTEXT_RELAY_SESSION, params.to_vec())
                .await
                .map_err(|_| "cannot read context relay session")?
                .rows
                .first()
                .map(read_reddb_context_relay_session)
                .transpose()?,
        };
        Ok(record.map(|mut record| {
            record.record_id = record_id.to_owned();
            record
        }))
    }

    pub async fn upsert_context_relay_session(
        &self,
        session: &StoredContextRelaySession,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_CONTEXT_RELAY_SESSION)
                    .bind(&session.record_id)
                    .bind(&session.combo_id)
                    .bind(&session.provider_id)
                    .bind(&session.model)
                    .bind(session.updated_at_unix_ms)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write context relay session")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    UPSERT_CONTEXT_RELAY_SESSION,
                    &context_relay_session_params(session),
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    UPSERT_CONTEXT_RELAY_SESSION,
                    context_relay_session_params(session),
                )
                .await
                .map_err(|_| "cannot write context relay session")?;
            }
        }
        Ok(())
    }

    pub async fn context_relay_handoff(
        &self,
        record_id: &str,
    ) -> Result<Option<StoredContextRelayHandoff>, &'static str> {
        let params = [reddb_client::Value::Text(record_id.to_owned())];
        let record = match self {
            Self::Sql(pool) => sqlx::query(READ_CONTEXT_RELAY_HANDOFF)
                .bind(record_id)
                .fetch_optional(pool)
                .await
                .map_err(|_| "cannot read context relay handoff")?
                .as_ref()
                .map(read_sql_context_relay_handoff)
                .transpose()?,
            Self::Remote(_) => self
                .remote_query(READ_CONTEXT_RELAY_HANDOFF, &params)
                .await?
                .rows
                .first()
                .map(read_reddb_context_relay_handoff)
                .transpose()?,
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query_with(READ_CONTEXT_RELAY_HANDOFF, params.to_vec())
                .await
                .map_err(|_| "cannot read context relay handoff")?
                .rows
                .first()
                .map(read_reddb_context_relay_handoff)
                .transpose()?,
        };
        Ok(record.map(|mut record| {
            record.record_id = record_id.to_owned();
            record
        }))
    }

    pub async fn upsert_context_relay_handoff(
        &self,
        handoff: &StoredContextRelayHandoff,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_CONTEXT_RELAY_HANDOFF)
                    .bind(&handoff.record_id)
                    .bind(&handoff.combo_id)
                    .bind(&handoff.summary)
                    .bind(&handoff.key_decisions_json)
                    .bind(&handoff.task_progress)
                    .bind(&handoff.active_entities_json)
                    .bind(handoff.message_count)
                    .bind(&handoff.source_model)
                    .bind(&handoff.summary_model)
                    .bind(handoff.generated_at_unix_ms)
                    .bind(handoff.expires_at_unix_ms)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write context relay handoff")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    UPSERT_CONTEXT_RELAY_HANDOFF,
                    &context_relay_handoff_params(handoff),
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    UPSERT_CONTEXT_RELAY_HANDOFF,
                    context_relay_handoff_params(handoff),
                )
                .await
                .map_err(|_| "cannot write context relay handoff")?;
            }
        }
        Ok(())
    }

    pub async fn acquire_context_relay_generation_lease(
        &self,
        record_id: &str,
        owner: &str,
        now_unix_ms: i64,
        lease_until_unix_ms: i64,
    ) -> Result<bool, &'static str> {
        let Self::Sql(pool) = self else {
            // RedDB still has the per-process guard. A cross-process lease will
            // be enabled when its query result exposes an atomic affected-row
            // count equivalent to SQLite/PostgreSQL.
            return Ok(true);
        };
        let result = sqlx::query(ACQUIRE_CONTEXT_RELAY_GENERATION_LEASE)
            .bind(record_id)
            .bind(owner)
            .bind(lease_until_unix_ms)
            .bind(now_unix_ms)
            .execute(pool)
            .await
            .map_err(|_| "cannot acquire context relay generation lease")?;
        Ok(result.rows_affected() == 1)
    }

    pub async fn release_context_relay_generation_lease(
        &self,
        record_id: &str,
        owner: &str,
    ) -> Result<(), &'static str> {
        let Self::Sql(pool) = self else {
            return Ok(());
        };
        sqlx::query(RELEASE_CONTEXT_RELAY_GENERATION_LEASE)
            .bind(record_id)
            .bind(owner)
            .execute(pool)
            .await
            .map_err(|_| "cannot release context relay generation lease")?;
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

    pub async fn provider_model_quotas(
        &self,
    ) -> Result<Vec<StoredProviderModelQuota>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_PROVIDER_MODEL_QUOTAS)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read provider model quota state")?
                .iter()
                .map(read_sql_provider_model_quota)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_PROVIDER_MODEL_QUOTAS, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_provider_model_quota)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_PROVIDER_MODEL_QUOTAS)
                .await
                .map_err(|_| "cannot read provider model quota state")?
                .rows
                .iter()
                .map(read_reddb_provider_model_quota)
                .collect(),
        }
    }

    /// Replaces one provider's model observations as one SQLite/PostgreSQL
    /// transaction. RedDB uses the same single-authority mutation order until
    /// its client exposes an explicit transaction API.
    pub async fn replace_provider_model_quotas(
        &self,
        provider_id: &str,
        quotas: &[StoredProviderModelQuota],
    ) -> Result<(), &'static str> {
        if quotas.iter().any(|quota| quota.provider_id != provider_id) {
            return Err("provider model quota owner mismatch");
        }
        match self {
            Self::Sql(pool) => {
                let mut transaction = pool
                    .begin()
                    .await
                    .map_err(|_| "cannot begin provider model quota update")?;
                sqlx::query(DELETE_PROVIDER_MODEL_QUOTAS)
                    .bind(provider_id)
                    .execute(&mut *transaction)
                    .await
                    .map_err(|_| "cannot replace provider model quota state")?;
                for quota in quotas {
                    sqlx::query(UPSERT_PROVIDER_MODEL_QUOTA)
                        .bind(provider_model_quota_record_id(quota))
                        .bind(&quota.provider_id)
                        .bind(&quota.model_id)
                        .bind(quota.session_remaining_ppm)
                        .bind(quota.session_reset_unix_ms)
                        .bind(quota.weekly_remaining_ppm)
                        .bind(quota.weekly_reset_unix_ms)
                        .bind(if quota.limit_reached { 1_i64 } else { 0_i64 })
                        .bind(quota.observed_at_unix_ms)
                        .bind(quota.expires_at_unix_ms)
                        .bind(quota.revision)
                        .execute(&mut *transaction)
                        .await
                        .map_err(|_| "cannot replace provider model quota state")?;
                }
                transaction
                    .commit()
                    .await
                    .map_err(|_| "cannot commit provider model quota update")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    DELETE_PROVIDER_MODEL_QUOTAS,
                    &[reddb_client::Value::Text(provider_id.to_owned())],
                )
                .await?;
                for quota in quotas {
                    self.remote_query(
                        UPSERT_PROVIDER_MODEL_QUOTA,
                        &provider_model_quota_params(quota),
                    )
                    .await?;
                }
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    DELETE_PROVIDER_MODEL_QUOTAS,
                    vec![reddb_client::Value::Text(provider_id.to_owned())],
                )
                .await
                .map_err(|_| "cannot replace provider model quota state")?;
                for quota in quotas {
                    db.query_with(
                        UPSERT_PROVIDER_MODEL_QUOTA,
                        provider_model_quota_params(quota),
                    )
                    .await
                    .map_err(|_| "cannot replace provider model quota state")?;
                }
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

    pub async fn breaker_overrides(&self) -> Result<Vec<StoredBreakerOverride>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(LIST_BREAKER_OVERRIDES)
                .fetch_all(pool)
                .await
                .map_err(|_| "cannot read provider breaker overrides")?
                .iter()
                .map(read_sql_breaker_override)
                .collect(),
            Self::Remote(_) => self
                .remote_query(LIST_BREAKER_OVERRIDES, &[])
                .await?
                .rows
                .iter()
                .map(read_reddb_breaker_override)
                .collect(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(LIST_BREAKER_OVERRIDES)
                .await
                .map_err(|_| "cannot read provider breaker overrides")?
                .rows
                .iter()
                .map(read_reddb_breaker_override)
                .collect(),
        }
    }

    pub async fn upsert_breaker_override(
        &self,
        policy: &StoredBreakerOverride,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_BREAKER_OVERRIDE)
                    .bind(&policy.provider_id)
                    .bind(policy.failure_threshold)
                    .bind(policy.degradation_threshold)
                    .bind(policy.reset_timeout_ms)
                    .bind(policy.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write provider breaker override")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_BREAKER_OVERRIDE, &breaker_override_params(policy))
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_BREAKER_OVERRIDE, breaker_override_params(policy))
                    .await
                    .map_err(|_| "cannot write provider breaker override")?;
            }
        }
        Ok(())
    }

    pub async fn delete_breaker_override(&self, provider_id: &str) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE_BREAKER_OVERRIDE)
                    .bind(provider_id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete provider breaker override")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    DELETE_BREAKER_OVERRIDE,
                    &[reddb_client::Value::Text(provider_id.to_owned())],
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    DELETE_BREAKER_OVERRIDE,
                    vec![reddb_client::Value::Text(provider_id.to_owned())],
                )
                .await
                .map_err(|_| "cannot delete provider breaker override")?;
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

    pub async fn runtime_settings(&self) -> Result<Option<StoredRuntimeSettings>, &'static str> {
        let current = match self {
            Self::Sql(pool) => sqlx::query(READ_RUNTIME_SETTINGS)
                .fetch_optional(pool)
                .await
                .map_err(|_| "cannot read runtime settings")?
                .as_ref()
                .map(read_sql_runtime_settings)
                .transpose(),
            Self::Remote(_) => self
                .remote_query(READ_RUNTIME_SETTINGS, &[])
                .await?
                .rows
                .first()
                .map(read_reddb_runtime_settings)
                .transpose(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(READ_RUNTIME_SETTINGS)
                .await
                .map_err(|_| "cannot read runtime settings")?
                .rows
                .first()
                .map(read_reddb_runtime_settings)
                .transpose(),
        }?;
        if current.is_some() {
            return Ok(current);
        }
        self.legacy_runtime_settings().await
    }

    async fn legacy_runtime_settings(&self) -> Result<Option<StoredRuntimeSettings>, &'static str> {
        match self {
            Self::Sql(pool) => sqlx::query(READ_RUNTIME_SETTINGS_LEGACY)
                .fetch_optional(pool)
                .await
                .map_err(|_| "cannot read legacy runtime settings")?
                .as_ref()
                .map(read_sql_legacy_runtime_settings)
                .transpose(),
            Self::Remote(_) => self
                .remote_query(READ_RUNTIME_SETTINGS_LEGACY, &[])
                .await?
                .rows
                .first()
                .map(read_reddb_legacy_runtime_settings)
                .transpose(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query(READ_RUNTIME_SETTINGS_LEGACY)
                .await
                .map_err(|_| "cannot read legacy runtime settings")?
                .rows
                .first()
                .map(read_reddb_legacy_runtime_settings)
                .transpose(),
        }
    }

    pub async fn upsert_runtime_settings(
        &self,
        settings: &StoredRuntimeSettings,
    ) -> Result<(), &'static str> {
        let enabled = i64::from(settings.quota_preflight_enabled);
        let oauth_retry_hints = i64::from(settings.oauth_cooldown_retry_hints);
        let apikey_retry_hints = i64::from(settings.apikey_cooldown_retry_hints);
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_RUNTIME_SETTINGS)
                    .bind(enabled)
                    .bind(settings.quota_preflight_threshold_ppm)
                    .bind(settings.oauth_cooldown_base_ms)
                    .bind(oauth_retry_hints)
                    .bind(settings.oauth_cooldown_max_backoff_steps)
                    .bind(settings.apikey_cooldown_base_ms)
                    .bind(apikey_retry_hints)
                    .bind(settings.apikey_cooldown_max_backoff_steps)
                    .bind(settings.oauth_breaker_failure_threshold)
                    .bind(settings.oauth_breaker_degradation_threshold)
                    .bind(settings.oauth_breaker_reset_timeout_ms)
                    .bind(settings.apikey_breaker_failure_threshold)
                    .bind(settings.apikey_breaker_degradation_threshold)
                    .bind(settings.apikey_breaker_reset_timeout_ms)
                    .bind(settings.revision)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write runtime settings")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    UPSERT_RUNTIME_SETTINGS,
                    &runtime_settings_params(
                        settings,
                        enabled,
                        oauth_retry_hints,
                        apikey_retry_hints,
                    ),
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    UPSERT_RUNTIME_SETTINGS,
                    runtime_settings_params(
                        settings,
                        enabled,
                        oauth_retry_hints,
                        apikey_retry_hints,
                    ),
                )
                .await
                .map_err(|_| "cannot write runtime settings")?;
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

    pub async fn antigravity_thought_signature(
        &self,
        provider_id: &str,
        tool_call_id: &str,
        now_unix_ms: i64,
    ) -> Result<Option<String>, &'static str> {
        let params = || {
            vec![
                reddb_client::Value::Text(provider_id.to_owned()),
                reddb_client::Value::Text(tool_call_id.to_owned()),
                reddb_client::Value::Int(now_unix_ms),
            ]
        };
        match self {
            Self::Sql(pool) => sqlx::query(READ_THOUGHT_SIGNATURE)
                .bind(provider_id)
                .bind(tool_call_id)
                .bind(now_unix_ms)
                .fetch_optional(pool)
                .await
                .map_err(|_| "cannot read Antigravity thought signature")?
                .map(|row| {
                    row.try_get("signature")
                        .map_err(|_| "invalid Antigravity thought signature")
                })
                .transpose(),
            Self::Remote(_) => self
                .remote_query(READ_THOUGHT_SIGNATURE, &params())
                .await?
                .rows
                .first()
                .map(read_reddb_thought_signature)
                .transpose(),
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => db
                .query_with(READ_THOUGHT_SIGNATURE, params())
                .await
                .map_err(|_| "cannot read Antigravity thought signature")?
                .rows
                .first()
                .map(read_reddb_thought_signature)
                .transpose(),
        }
    }

    pub async fn upsert_antigravity_thought_signature(
        &self,
        provider_id: &str,
        tool_call_id: &str,
        signature: &str,
        created_at_unix_ms: i64,
        expires_at_unix_ms: i64,
    ) -> Result<(), &'static str> {
        let record_id = thought_signature_record_id(provider_id, tool_call_id);
        let params = || {
            vec![
                reddb_client::Value::Text(record_id.clone()),
                reddb_client::Value::Text(provider_id.to_owned()),
                reddb_client::Value::Text(tool_call_id.to_owned()),
                reddb_client::Value::Text(signature.to_owned()),
                reddb_client::Value::Int(created_at_unix_ms),
                reddb_client::Value::Int(expires_at_unix_ms),
            ]
        };
        match self {
            Self::Sql(pool) => {
                sqlx::query(UPSERT_THOUGHT_SIGNATURE)
                    .bind(&record_id)
                    .bind(provider_id)
                    .bind(tool_call_id)
                    .bind(signature)
                    .bind(created_at_unix_ms)
                    .bind(expires_at_unix_ms)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot write Antigravity thought signature")?;
            }
            Self::Remote(_) => {
                self.remote_query(UPSERT_THOUGHT_SIGNATURE, &params())
                    .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(UPSERT_THOUGHT_SIGNATURE, params())
                    .await
                    .map_err(|_| "cannot write Antigravity thought signature")?;
            }
        }
        Ok(())
    }

    pub async fn delete_expired_antigravity_thought_signatures(
        &self,
        now_unix_ms: i64,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE_EXPIRED_THOUGHT_SIGNATURES)
                    .bind(now_unix_ms)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot prune Antigravity thought signatures")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    DELETE_EXPIRED_THOUGHT_SIGNATURES,
                    &[reddb_client::Value::Int(now_unix_ms)],
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    DELETE_EXPIRED_THOUGHT_SIGNATURES,
                    vec![reddb_client::Value::Int(now_unix_ms)],
                )
                .await
                .map_err(|_| "cannot prune Antigravity thought signatures")?;
            }
        }
        Ok(())
    }

    pub async fn delete_provider_thought_signatures(
        &self,
        provider_id: &str,
    ) -> Result<(), &'static str> {
        match self {
            Self::Sql(pool) => {
                sqlx::query(DELETE_PROVIDER_THOUGHT_SIGNATURES)
                    .bind(provider_id)
                    .execute(pool)
                    .await
                    .map_err(|_| "cannot delete Antigravity thought signatures")?;
            }
            Self::Remote(_) => {
                self.remote_query(
                    DELETE_PROVIDER_THOUGHT_SIGNATURES,
                    &[reddb_client::Value::Text(provider_id.to_owned())],
                )
                .await?;
            }
            #[cfg(feature = "reddb-embedded")]
            Self::Embedded { db, .. } => {
                db.query_with(
                    DELETE_PROVIDER_THOUGHT_SIGNATURES,
                    vec![reddb_client::Value::Text(provider_id.to_owned())],
                )
                .await
                .map_err(|_| "cannot delete Antigravity thought signatures")?;
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
        let key_name: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('redrouter_usage_ledger') WHERE name = 'key_name'",
        )
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| "cannot inspect usage database")?;
        if key_name == 0 {
            sqlx::query(
                "ALTER TABLE redrouter_usage_ledger ADD COLUMN key_name TEXT NOT NULL DEFAULT ''",
            )
            .execute(&mut *connection)
            .await
            .map_err(|_| "cannot migrate usage database")?;
        }
        let usage_kind: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('redrouter_usage_ledger') WHERE name = 'usage_kind'",
        )
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| "cannot inspect usage database")?;
        if usage_kind == 0 {
            sqlx::query(
                "ALTER TABLE redrouter_usage_ledger ADD COLUMN usage_kind TEXT NOT NULL DEFAULT 'tokens'",
            )
            .execute(&mut *connection)
            .await
            .map_err(|_| "cannot migrate usage database")?;
        }
        let search_units: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('redrouter_usage_ledger') WHERE name = 'search_units'",
        )
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| "cannot inspect usage database")?;
        if search_units == 0 {
            sqlx::query(
                "ALTER TABLE redrouter_usage_ledger ADD COLUMN search_units BIGINT NOT NULL DEFAULT 0",
            )
            .execute(&mut *connection)
            .await
            .map_err(|_| "cannot migrate usage database")?;
        }
        for (table, column, definition) in [
            (
                "redrouter_usage_ledger",
                "quota_model",
                "quota_model TEXT NOT NULL DEFAULT ''",
            ),
            ("redrouter_usage_ledger", "end_user", "end_user TEXT"),
            (
                "redrouter_usage_ledger",
                "tags_json",
                "tags_json TEXT NOT NULL DEFAULT '[]'",
            ),
            (
                "redrouter_usage_reservations",
                "quota_model",
                "quota_model TEXT NOT NULL DEFAULT ''",
            ),
            (
                "redrouter_usage_reservations",
                "end_user",
                "end_user TEXT",
            ),
            (
                "redrouter_usage_reservations",
                "tags_json",
                "tags_json TEXT NOT NULL DEFAULT '[]'",
            ),
            (
                "redrouter_control_budgets",
                "tags_json",
                "tags_json TEXT NOT NULL DEFAULT '[]'",
            ),
            (
                "redrouter_control_budgets",
                "users_json",
                "users_json TEXT NOT NULL DEFAULT '[]'",
            ),
        ] {
            let exists: i64 = sqlx::query_scalar(&format!(
                "SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = $1"
            ))
            .bind(column)
            .fetch_one(&mut *connection)
            .await
            .map_err(|_| "cannot inspect usage database")?;
            if exists == 0 {
                sqlx::query(&format!("ALTER TABLE {table} ADD COLUMN {definition}"))
                    .execute(&mut *connection)
                    .await
                    .map_err(|_| "cannot migrate usage database")?;
            }
        }
        let export_config_json: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('redrouter_control_usage_exports') WHERE name = 'config_json'",
        )
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| "cannot inspect usage database")?;
        if export_config_json == 0 {
            sqlx::query(
                "ALTER TABLE redrouter_control_usage_exports ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}'",
            )
            .execute(&mut *connection)
            .await
            .map_err(|_| "cannot migrate usage database")?;
        }
        let export_secret_ciphertext: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM pragma_table_info('redrouter_control_usage_exports') WHERE name = 'secret_ciphertext'",
        )
        .fetch_one(&mut *connection)
        .await
        .map_err(|_| "cannot inspect usage database")?;
        if export_secret_ciphertext == 0 {
            sqlx::query(
                "ALTER TABLE redrouter_control_usage_exports ADD COLUMN secret_ciphertext TEXT NOT NULL DEFAULT ''",
            )
            .execute(&mut *connection)
            .await
            .map_err(|_| "cannot migrate usage database")?;
        }
        sqlx::query("UPDATE redrouter_usage_ledger SET key_name = key_id WHERE key_name = ''")
            .execute(&mut *connection)
            .await
            .map_err(|_| "cannot migrate usage database")?;
        sqlx::query("UPDATE redrouter_usage_ledger SET pricing_snapshot = '{\"source\":\"legacy\",\"available\":false}' WHERE pricing_known = 1 AND pricing_snapshot IS NULL")
            .execute(&mut *connection)
            .await
            .map_err(|_| "cannot migrate usage database")?;
        for statement in [
            "CREATE INDEX IF NOT EXISTS redrouter_usage_reservations_quota_model ON redrouter_usage_reservations (key_id, quota_model)",
            "CREATE INDEX IF NOT EXISTS redrouter_usage_ledger_quota_model_time ON redrouter_usage_ledger (key_id, quota_model, created_at_unix_ms)",
        ] {
            sqlx::query(statement)
                .execute(&mut *connection)
                .await
                .map_err(|_| "cannot migrate usage database")?;
        }
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
        node_id: None,
        protocol: "auto".to_owned(),
        priority: row
            .try_get("priority")
            .map_err(|_| "invalid provider priority")?,
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
        node_id: None,
        protocol: "auto".to_owned(),
        priority: 0,
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

fn read_sql_provider_session(
    row: &sqlx::any::AnyRow,
) -> Result<StoredProviderSession, &'static str> {
    Ok(StoredProviderSession {
        provider_id: row
            .try_get("provider_id")
            .map_err(|_| "invalid provider session record")?,
        provider: row
            .try_get("provider")
            .map_err(|_| "invalid provider session record")?,
        session_ciphertext: row
            .try_get("session_ciphertext")
            .map_err(|_| "invalid provider session record")?,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid provider session record")?,
    })
}

fn read_reddb_provider_session(
    row: &reddb_client::Row,
) -> Result<StoredProviderSession, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid provider session record"),
    };
    let revision = match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case("revision"))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid provider session record"),
    }?;
    Ok(StoredProviderSession {
        provider_id: text("provider_id")?,
        provider: text("provider")?,
        session_ciphertext: text("session_ciphertext")?,
        revision,
    })
}

fn provider_session_params(session: &StoredProviderSession) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(session.provider_id.clone()),
        reddb_client::Value::Text(session.provider.clone()),
        reddb_client::Value::Text(session.session_ciphertext.clone()),
        reddb_client::Value::Int(session.revision),
    ]
}

fn read_sql_provider_header(
    row: &sqlx::any::AnyRow,
) -> Result<StoredProviderHeaders, &'static str> {
    Ok(StoredProviderHeaders {
        provider_id: row
            .try_get("provider_id")
            .map_err(|_| "invalid provider headers record")?,
        upstream_identity: row
            .try_get("upstream_identity")
            .map_err(|_| "invalid provider headers record")?,
        headers_ciphertext: row
            .try_get("headers_ciphertext")
            .map_err(|_| "invalid provider headers record")?,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid provider headers record")?,
    })
}

fn read_reddb_provider_header(
    row: &reddb_client::Row,
) -> Result<StoredProviderHeaders, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid provider headers record"),
    };
    let revision = match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case("revision"))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid provider headers record"),
    }?;
    Ok(StoredProviderHeaders {
        provider_id: text("provider_id")?,
        upstream_identity: text("upstream_identity")?,
        headers_ciphertext: text("headers_ciphertext")?,
        revision,
    })
}

fn provider_header_params(entry: &StoredProviderHeaders) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(entry.provider_id.clone()),
        reddb_client::Value::Text(entry.upstream_identity.clone()),
        reddb_client::Value::Text(entry.headers_ciphertext.clone()),
        reddb_client::Value::Int(entry.revision),
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

fn read_sql_client_key_snapshot(row: &sqlx::any::AnyRow) -> Result<StoredClientKey, &'static str> {
    let mut key = read_sql_client_key(row)?;
    for (column, error) in [
        (
            "preference_revision",
            "client key preference revision mismatch",
        ),
        (
            "schedule_revision",
            "client key access schedule revision mismatch",
        ),
        (
            "model_access_revision",
            "client key model access mode revision mismatch",
        ),
        (
            "combo_access_revision",
            "client key combo grants revision mismatch",
        ),
        (
            "ownership_revision",
            "client key ownership revision mismatch",
        ),
        ("quota_revision", "client key quota revision mismatch"),
    ] {
        if row
            .try_get::<i64, _>(column)
            .map_err(|_| "invalid client key snapshot revision")?
            != key.revision
        {
            return Err(error);
        }
    }
    key.model_id_format = row
        .try_get("model_id_format")
        .map_err(|_| "invalid client key snapshot")?;
    key.access_schedule_json = row
        .try_get("schedule_json")
        .map_err(|_| "invalid client key snapshot")?;
    key.model_access_mode = row
        .try_get("model_access_mode")
        .map_err(|_| "invalid client key snapshot")?;
    key.allowed_combos_json = row
        .try_get("allowed_combos_json")
        .map_err(|_| "invalid client key snapshot")?;
    key.tenant_id = row
        .try_get("tenant_id")
        .map_err(|_| "invalid client key snapshot")?;
    key.created_by = row
        .try_get("created_by")
        .map_err(|_| "invalid client key snapshot")?;
    key.max_tokens_per_minute = row
        .try_get("max_tokens_per_minute")
        .map_err(|_| "invalid client key snapshot")?;
    key.max_tokens_per_day = row
        .try_get("max_tokens_per_day")
        .map_err(|_| "invalid client key snapshot")?;
    key.max_monthly_microusd = row
        .try_get("max_monthly_microusd")
        .map_err(|_| "invalid client key snapshot")?;
    key.reservation_tokens = row
        .try_get("reservation_tokens")
        .map_err(|_| "invalid client key snapshot")?;
    key.reservation_microusd = row
        .try_get("reservation_microusd")
        .map_err(|_| "invalid client key snapshot")?;
    Ok(key)
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
        access_schedule_json: String::new(),
        model_access_mode: "all".to_owned(),
        allowed_combos_json: "null".to_owned(),
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
        access_schedule_json: String::new(),
        model_access_mode: "all".to_owned(),
        allowed_combos_json: "null".to_owned(),
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

fn read_sql_client_key_schedule(
    row: &sqlx::any::AnyRow,
) -> Result<StoredClientKeySchedule, &'static str> {
    Ok(StoredClientKeySchedule {
        key_id: row
            .try_get("key_id")
            .map_err(|_| "invalid client key access schedule")?,
        schedule_json: row
            .try_get("schedule_json")
            .map_err(|_| "invalid client key access schedule")?,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid client key access schedule")?,
    })
}

fn read_reddb_client_key_schedule(
    row: &reddb_client::Row,
) -> Result<StoredClientKeySchedule, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid client key access schedule"),
    };
    let revision = match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case("revision"))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid client key access schedule"),
    }?;
    Ok(StoredClientKeySchedule {
        key_id: text("key_id")?,
        schedule_json: text("schedule_json")?,
        revision,
    })
}

fn client_key_schedule_params(key: &StoredClientKey) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(key.id.clone()),
        reddb_client::Value::Text(key.access_schedule_json.clone()),
        reddb_client::Value::Int(key.revision),
    ]
}

fn read_sql_client_key_model_access(
    row: &sqlx::any::AnyRow,
) -> Result<StoredClientKeyModelAccess, &'static str> {
    Ok(StoredClientKeyModelAccess {
        key_id: row
            .try_get("key_id")
            .map_err(|_| "invalid client key model access mode")?,
        model_access_mode: row
            .try_get("model_access_mode")
            .map_err(|_| "invalid client key model access mode")?,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid client key model access mode")?,
    })
}

fn read_reddb_client_key_model_access(
    row: &reddb_client::Row,
) -> Result<StoredClientKeyModelAccess, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid client key model access mode"),
    };
    let revision = match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case("revision"))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid client key model access mode"),
    }?;
    Ok(StoredClientKeyModelAccess {
        key_id: text("key_id")?,
        model_access_mode: text("model_access_mode")?,
        revision,
    })
}

fn client_key_model_access_params(key: &StoredClientKey) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(key.id.clone()),
        reddb_client::Value::Text(key.model_access_mode.clone()),
        reddb_client::Value::Int(key.revision),
    ]
}

fn read_sql_client_key_combo_access(
    row: &sqlx::any::AnyRow,
) -> Result<StoredClientKeyComboAccess, &'static str> {
    Ok(StoredClientKeyComboAccess {
        key_id: row
            .try_get("key_id")
            .map_err(|_| "invalid client key combo grants")?,
        allowed_combos_json: row
            .try_get("allowed_combos_json")
            .map_err(|_| "invalid client key combo grants")?,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid client key combo grants")?,
    })
}

fn read_reddb_client_key_combo_access(
    row: &reddb_client::Row,
) -> Result<StoredClientKeyComboAccess, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid client key combo grants"),
    };
    let revision = match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case("revision"))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid client key combo grants"),
    }?;
    Ok(StoredClientKeyComboAccess {
        key_id: text("key_id")?,
        allowed_combos_json: text("allowed_combos_json")?,
        revision,
    })
}

fn client_key_combo_access_params(key: &StoredClientKey) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(key.id.clone()),
        reddb_client::Value::Text(key.allowed_combos_json.clone()),
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

fn read_sql_audit_event(row: &sqlx::any::AnyRow) -> Result<StoredAuditEvent, &'static str> {
    let text = |name| row.try_get(name).map_err(|_| "invalid audit event record");
    Ok(StoredAuditEvent {
        id: text("id")?,
        created_at_unix_ms: row
            .try_get("created_at_unix_ms")
            .map_err(|_| "invalid audit event record")?,
        action: text("action")?,
        actor: text("actor")?,
        tenant_id: text("tenant_id")?,
        target: text("target")?,
        resource_type: text("resource_type")?,
        status: text("status")?,
        request_id: text("request_id")?,
        details_json: text("details_json")?,
    })
}

fn read_reddb_audit_event(row: &reddb_client::Row) -> Result<StoredAuditEvent, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid audit event record"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid audit event record"),
    };
    Ok(StoredAuditEvent {
        id: text("id")?,
        created_at_unix_ms: integer("created_at_unix_ms")?,
        action: text("action")?,
        actor: text("actor")?,
        tenant_id: text("tenant_id")?,
        target: text("target")?,
        resource_type: text("resource_type")?,
        status: text("status")?,
        request_id: text("request_id")?,
        details_json: text("details_json")?,
    })
}

fn audit_event_params(event: &StoredAuditEvent) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(event.id.clone()),
        reddb_client::Value::Int(event.created_at_unix_ms),
        reddb_client::Value::Text(event.action.clone()),
        reddb_client::Value::Text(event.actor.clone()),
        reddb_client::Value::Text(event.tenant_id.clone()),
        reddb_client::Value::Text(event.target.clone()),
        reddb_client::Value::Text(event.resource_type.clone()),
        reddb_client::Value::Text(event.status.clone()),
        reddb_client::Value::Text(event.request_id.clone()),
        reddb_client::Value::Text(event.details_json.clone()),
    ]
}

fn audit_outbox_params(event: &StoredAuditEvent, payload_json: &str) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(event.id.clone()),
        reddb_client::Value::Int(event.created_at_unix_ms),
        reddb_client::Value::Text(event.tenant_id.clone()),
        reddb_client::Value::Text("redrouter.audit.v1".to_owned()),
        reddb_client::Value::Int(1),
        reddb_client::Value::Text(payload_json.to_owned()),
    ]
}

fn read_sql_audit_outbox_event(
    row: &sqlx::any::AnyRow,
) -> Result<StoredAuditOutboxEvent, &'static str> {
    let text = |name| row.try_get(name).map_err(|_| "invalid audit outbox record");
    Ok(StoredAuditOutboxEvent {
        event_id: text("event_id")?,
        created_at_unix_ms: row
            .try_get("created_at_unix_ms")
            .map_err(|_| "invalid audit outbox record")?,
        tenant_id: text("tenant_id")?,
        topic: text("topic")?,
        schema_version: row
            .try_get("schema_version")
            .map_err(|_| "invalid audit outbox record")?,
        payload_json: text("payload_json")?,
    })
}

fn read_reddb_audit_outbox_event(
    row: &reddb_client::Row,
) -> Result<StoredAuditOutboxEvent, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid audit outbox record"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid audit outbox record"),
    };
    Ok(StoredAuditOutboxEvent {
        event_id: text("event_id")?,
        created_at_unix_ms: integer("created_at_unix_ms")?,
        tenant_id: text("tenant_id")?,
        topic: text("topic")?,
        schema_version: integer("schema_version")?,
        payload_json: text("payload_json")?,
    })
}

fn merge_audit_outbox_rows(
    mut events: Vec<StoredAuditOutboxEvent>,
    limit: usize,
) -> Vec<StoredAuditOutboxEvent> {
    events.sort_by(|left, right| {
        (left.created_at_unix_ms, left.event_id.as_str())
            .cmp(&(right.created_at_unix_ms, right.event_id.as_str()))
    });
    events.truncate(limit);
    events
}

fn read_sql_audit_sink_cursor(
    row: &sqlx::any::AnyRow,
) -> Result<StoredAuditSinkCursor, &'static str> {
    let text = |name| row.try_get(name).map_err(|_| "invalid audit sink cursor");
    let integer = |name| row.try_get(name).map_err(|_| "invalid audit sink cursor");
    Ok(StoredAuditSinkCursor {
        sink_id: text("sink_id")?,
        cursor_created_at_unix_ms: integer("cursor_created_at_unix_ms")?,
        cursor_event_id: text("cursor_event_id")?,
        lease_owner: text("lease_owner")?,
        lease_until_unix_ms: integer("lease_until_unix_ms")?,
        revision: integer("revision")?,
    })
}

fn read_sql_usage_export_event(
    row: &sqlx::any::AnyRow,
) -> Result<StoredUsageExportEvent, &'static str> {
    let text = |name| -> Result<String, &'static str> {
        row.try_get(name).map_err(|_| "invalid usage export event")
    };
    let integer = |name| -> Result<i64, &'static str> {
        row.try_get(name).map_err(|_| "invalid usage export event")
    };
    let pricing_known = integer("pricing_known")?;
    if !matches!(pricing_known, 0 | 1) {
        return Err("invalid usage export event");
    }
    let pricing_snapshot: Option<String> = row
        .try_get("pricing_snapshot")
        .map_err(|_| "invalid usage export event")?;
    if (pricing_known == 1) != pricing_snapshot.is_some() {
        return Err("invalid usage export event");
    }
    let end_user: Option<String> = row
        .try_get("end_user")
        .map_err(|_| "invalid usage export event")?;
    let tags = serde_json::from_str::<Vec<String>>(&text("tags_json")?)
        .map_err(|_| "invalid usage export event")?;
    let usage_kind: String = text("usage_kind")?;
    let search_units: i64 = integer("search_units")?;
    if !matches!(usage_kind.as_str(), "tokens" | "rerank")
        || search_units < 0
        || (usage_kind == "tokens" && search_units != 0)
    {
        return Err("invalid usage export event");
    }
    Ok(StoredUsageExportEvent {
        event_id: text("event_id")?,
        created_at_unix_ms: integer("created_at_unix_ms")?,
        tenant_id: text("tenant_id")?,
        key_id: text("key_id")?,
        key_name: text("key_name")?,
        end_user,
        tags,
        provider: text("provider")?,
        model: text("model")?,
        usage_kind,
        search_units,
        tokens_input: integer("tokens_input")?,
        tokens_output: integer("tokens_output")?,
        tokens_cache_read: integer("tokens_cache_read")?,
        tokens_cache_creation: integer("tokens_cache_creation")?,
        tokens_reasoning: integer("tokens_reasoning")?,
        amount_microusd: integer("amount_microusd")?,
        pricing_known: pricing_known == 1,
        pricing_snapshot,
    })
}

fn read_sql_usage_export(row: &sqlx::any::AnyRow) -> Result<StoredUsageExport, &'static str> {
    let text = |name| {
        row.try_get(name)
            .map_err(|_| "invalid usage export configuration")
    };
    let integer = |name| {
        row.try_get(name)
            .map_err(|_| "invalid usage export configuration")
    };
    let enabled = integer("enabled")?;
    if !matches!(enabled, 0 | 1) {
        return Err("invalid usage export configuration");
    }
    Ok(StoredUsageExport {
        id: text("id")?,
        tenant_id: text("tenant_id")?,
        name: text("name")?,
        export_type: text("export_type")?,
        mode: text("mode")?,
        window_sec: integer("window_sec")?,
        api_key_ids_json: text("api_key_ids_json")?,
        project_id: text("project_id")?,
        dataset_id: text("dataset_id")?,
        table_id: text("table_id")?,
        service_account_ciphertext: text("service_account_ciphertext")?,
        config_json: text("config_json")?,
        secret_ciphertext: text("secret_ciphertext")?,
        batch_size: integer("batch_size")?,
        interval_seconds: integer("interval_seconds")?,
        enabled: enabled == 1,
        revision: integer("revision")?,
    })
}

fn read_reddb_usage_export(row: &reddb_client::Row) -> Result<StoredUsageExport, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid usage export configuration"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid usage export configuration"),
    };
    let enabled = integer("enabled")?;
    if !matches!(enabled, 0 | 1) {
        return Err("invalid usage export configuration");
    }
    Ok(StoredUsageExport {
        id: text("id")?,
        tenant_id: text("tenant_id")?,
        name: text("name")?,
        export_type: text("export_type")?,
        mode: text("mode")?,
        window_sec: integer("window_sec")?,
        api_key_ids_json: text("api_key_ids_json")?,
        project_id: text("project_id")?,
        dataset_id: text("dataset_id")?,
        table_id: text("table_id")?,
        service_account_ciphertext: text("service_account_ciphertext")?,
        config_json: text("config_json")?,
        secret_ciphertext: text("secret_ciphertext")?,
        batch_size: integer("batch_size")?,
        interval_seconds: integer("interval_seconds")?,
        enabled: enabled == 1,
        revision: integer("revision")?,
    })
}

fn usage_export_params(export: &StoredUsageExport, enabled: i64) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(export.id.clone()),
        reddb_client::Value::Text(export.tenant_id.clone()),
        reddb_client::Value::Text(export.name.clone()),
        reddb_client::Value::Text(export.export_type.clone()),
        reddb_client::Value::Text(export.mode.clone()),
        reddb_client::Value::Int(export.window_sec),
        reddb_client::Value::Text(export.api_key_ids_json.clone()),
        reddb_client::Value::Text(export.project_id.clone()),
        reddb_client::Value::Text(export.dataset_id.clone()),
        reddb_client::Value::Text(export.table_id.clone()),
        reddb_client::Value::Text(export.service_account_ciphertext.clone()),
        reddb_client::Value::Text(export.config_json.clone()),
        reddb_client::Value::Text(export.secret_ciphertext.clone()),
        reddb_client::Value::Int(export.batch_size),
        reddb_client::Value::Int(export.interval_seconds),
        reddb_client::Value::Int(enabled),
        reddb_client::Value::Int(export.revision),
    ]
}

fn read_reddb_audit_sink_cursor(
    row: &reddb_client::Row,
) -> Result<StoredAuditSinkCursor, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid audit sink cursor"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid audit sink cursor"),
    };
    Ok(StoredAuditSinkCursor {
        sink_id: text("sink_id")?,
        cursor_created_at_unix_ms: integer("cursor_created_at_unix_ms")?,
        cursor_event_id: text("cursor_event_id")?,
        lease_owner: text("lease_owner")?,
        lease_until_unix_ms: integer("lease_until_unix_ms")?,
        revision: integer("revision")?,
    })
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

fn read_sql_context_relay_session(
    row: &sqlx::any::AnyRow,
) -> Result<StoredContextRelaySession, &'static str> {
    let text = |name| {
        row.try_get(name)
            .map_err(|_| "invalid context relay session")
    };
    Ok(StoredContextRelaySession {
        record_id: String::new(),
        combo_id: text("combo_id")?,
        provider_id: text("provider_id")?,
        model: text("model")?,
        updated_at_unix_ms: row
            .try_get("updated_at_unix_ms")
            .map_err(|_| "invalid context relay session")?,
    })
}

fn read_reddb_context_relay_session(
    row: &reddb_client::Row,
) -> Result<StoredContextRelaySession, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid context relay session"),
    };
    let updated_at_unix_ms = match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case("updated_at_unix_ms"))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid context relay session"),
    }?;
    Ok(StoredContextRelaySession {
        record_id: String::new(),
        combo_id: text("combo_id")?,
        provider_id: text("provider_id")?,
        model: text("model")?,
        updated_at_unix_ms,
    })
}

fn context_relay_session_params(session: &StoredContextRelaySession) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(session.record_id.clone()),
        reddb_client::Value::Text(session.combo_id.clone()),
        reddb_client::Value::Text(session.provider_id.clone()),
        reddb_client::Value::Text(session.model.clone()),
        reddb_client::Value::Int(session.updated_at_unix_ms),
    ]
}

fn read_sql_context_relay_handoff(
    row: &sqlx::any::AnyRow,
) -> Result<StoredContextRelayHandoff, &'static str> {
    let text = |name| {
        row.try_get(name)
            .map_err(|_| "invalid context relay handoff")
    };
    let integer = |name| {
        row.try_get(name)
            .map_err(|_| "invalid context relay handoff")
    };
    Ok(StoredContextRelayHandoff {
        record_id: String::new(),
        combo_id: text("combo_id")?,
        summary: text("summary")?,
        key_decisions_json: text("key_decisions_json")?,
        task_progress: text("task_progress")?,
        active_entities_json: text("active_entities_json")?,
        message_count: integer("message_count")?,
        source_model: text("source_model")?,
        summary_model: text("summary_model")?,
        generated_at_unix_ms: integer("generated_at_unix_ms")?,
        expires_at_unix_ms: integer("expires_at_unix_ms")?,
    })
}

fn read_reddb_context_relay_handoff(
    row: &reddb_client::Row,
) -> Result<StoredContextRelayHandoff, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid context relay handoff"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid context relay handoff"),
    };
    Ok(StoredContextRelayHandoff {
        record_id: String::new(),
        combo_id: text("combo_id")?,
        summary: text("summary")?,
        key_decisions_json: text("key_decisions_json")?,
        task_progress: text("task_progress")?,
        active_entities_json: text("active_entities_json")?,
        message_count: integer("message_count")?,
        source_model: text("source_model")?,
        summary_model: text("summary_model")?,
        generated_at_unix_ms: integer("generated_at_unix_ms")?,
        expires_at_unix_ms: integer("expires_at_unix_ms")?,
    })
}

fn context_relay_handoff_params(handoff: &StoredContextRelayHandoff) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(handoff.record_id.clone()),
        reddb_client::Value::Text(handoff.combo_id.clone()),
        reddb_client::Value::Text(handoff.summary.clone()),
        reddb_client::Value::Text(handoff.key_decisions_json.clone()),
        reddb_client::Value::Text(handoff.task_progress.clone()),
        reddb_client::Value::Text(handoff.active_entities_json.clone()),
        reddb_client::Value::Int(handoff.message_count),
        reddb_client::Value::Text(handoff.source_model.clone()),
        reddb_client::Value::Text(handoff.summary_model.clone()),
        reddb_client::Value::Int(handoff.generated_at_unix_ms),
        reddb_client::Value::Int(handoff.expires_at_unix_ms),
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

fn read_sql_provider_model_quota(
    row: &sqlx::any::AnyRow,
) -> Result<StoredProviderModelQuota, &'static str> {
    let text = |name| {
        row.try_get(name)
            .map_err(|_| "invalid provider model quota record")
    };
    let integer = |name| {
        row.try_get(name)
            .map_err(|_| "invalid provider model quota record")
    };
    Ok(StoredProviderModelQuota {
        provider_id: text("provider_id")?,
        model_id: text("model_id")?,
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

fn read_reddb_provider_model_quota(
    row: &reddb_client::Row,
) -> Result<StoredProviderModelQuota, &'static str> {
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid provider model quota record"),
    };
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid provider model quota record"),
    };
    Ok(StoredProviderModelQuota {
        provider_id: text("provider_id")?,
        model_id: text("model_id")?,
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

fn provider_model_quota_params(quota: &StoredProviderModelQuota) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(provider_model_quota_record_id(quota)),
        reddb_client::Value::Text(quota.provider_id.clone()),
        reddb_client::Value::Text(quota.model_id.clone()),
        reddb_client::Value::Int(quota.session_remaining_ppm),
        reddb_client::Value::Int(quota.session_reset_unix_ms),
        reddb_client::Value::Int(quota.weekly_remaining_ppm),
        reddb_client::Value::Int(quota.weekly_reset_unix_ms),
        reddb_client::Value::Int(if quota.limit_reached { 1 } else { 0 }),
        reddb_client::Value::Int(quota.observed_at_unix_ms),
        reddb_client::Value::Int(quota.expires_at_unix_ms),
        reddb_client::Value::Int(quota.revision),
    ]
}

fn provider_model_quota_record_id(quota: &StoredProviderModelQuota) -> String {
    format!(
        "{}:{}{}",
        quota.provider_id.len(),
        quota.provider_id,
        quota.model_id
    )
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

fn read_sql_breaker_override(
    row: &sqlx::any::AnyRow,
) -> Result<StoredBreakerOverride, &'static str> {
    Ok(StoredBreakerOverride {
        provider_id: row
            .try_get("provider_id")
            .map_err(|_| "invalid provider breaker override")?,
        failure_threshold: row
            .try_get("failure_threshold")
            .map_err(|_| "invalid provider breaker override")?,
        degradation_threshold: row
            .try_get("degradation_threshold")
            .map_err(|_| "invalid provider breaker override")?,
        reset_timeout_ms: row
            .try_get("reset_timeout_ms")
            .map_err(|_| "invalid provider breaker override")?,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid provider breaker override")?,
    })
}

fn read_reddb_breaker_override(
    row: &reddb_client::Row,
) -> Result<StoredBreakerOverride, &'static str> {
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid provider breaker override"),
    };
    let text = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid provider breaker override"),
    };
    Ok(StoredBreakerOverride {
        provider_id: text("provider_id")?,
        failure_threshold: integer("failure_threshold")?,
        degradation_threshold: integer("degradation_threshold")?,
        reset_timeout_ms: integer("reset_timeout_ms")?,
        revision: integer("revision")?,
    })
}

fn breaker_override_params(policy: &StoredBreakerOverride) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Text(policy.provider_id.clone()),
        reddb_client::Value::Int(policy.failure_threshold),
        reddb_client::Value::Int(policy.degradation_threshold),
        reddb_client::Value::Int(policy.reset_timeout_ms),
        reddb_client::Value::Int(policy.revision),
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

fn read_sql_runtime_settings(
    row: &sqlx::any::AnyRow,
) -> Result<StoredRuntimeSettings, &'static str> {
    let integer = |name| {
        row.try_get(name)
            .map_err(|_| "invalid runtime settings record")
    };
    let enabled = integer("quota_preflight_enabled")?;
    let oauth_retry_hints = integer("oauth_cooldown_retry_hints")?;
    let apikey_retry_hints = integer("apikey_cooldown_retry_hints")?;
    if !matches!(enabled, 0 | 1)
        || !matches!(oauth_retry_hints, 0 | 1)
        || !matches!(apikey_retry_hints, 0 | 1)
    {
        return Err("invalid runtime settings record");
    }
    Ok(StoredRuntimeSettings {
        quota_preflight_enabled: enabled == 1,
        quota_preflight_threshold_ppm: integer("quota_preflight_threshold_ppm")?,
        oauth_cooldown_base_ms: integer("oauth_cooldown_base_ms")?,
        oauth_cooldown_retry_hints: oauth_retry_hints == 1,
        oauth_cooldown_max_backoff_steps: integer("oauth_cooldown_max_backoff_steps")?,
        apikey_cooldown_base_ms: integer("apikey_cooldown_base_ms")?,
        apikey_cooldown_retry_hints: apikey_retry_hints == 1,
        apikey_cooldown_max_backoff_steps: integer("apikey_cooldown_max_backoff_steps")?,
        oauth_breaker_failure_threshold: integer("oauth_breaker_failure_threshold")?,
        oauth_breaker_degradation_threshold: integer("oauth_breaker_degradation_threshold")?,
        oauth_breaker_reset_timeout_ms: integer("oauth_breaker_reset_timeout_ms")?,
        apikey_breaker_failure_threshold: integer("apikey_breaker_failure_threshold")?,
        apikey_breaker_degradation_threshold: integer("apikey_breaker_degradation_threshold")?,
        apikey_breaker_reset_timeout_ms: integer("apikey_breaker_reset_timeout_ms")?,
        revision: integer("revision")?,
    })
}

fn read_sql_legacy_runtime_settings(
    row: &sqlx::any::AnyRow,
) -> Result<StoredRuntimeSettings, &'static str> {
    let enabled: i64 = row
        .try_get("quota_preflight_enabled")
        .map_err(|_| "invalid legacy runtime settings record")?;
    if !matches!(enabled, 0 | 1) {
        return Err("invalid legacy runtime settings record");
    }
    Ok(StoredRuntimeSettings {
        quota_preflight_enabled: enabled == 1,
        quota_preflight_threshold_ppm: row
            .try_get("quota_preflight_threshold_ppm")
            .map_err(|_| "invalid legacy runtime settings record")?,
        oauth_cooldown_base_ms: 5_000,
        oauth_cooldown_retry_hints: false,
        oauth_cooldown_max_backoff_steps: 8,
        apikey_cooldown_base_ms: 3_000,
        apikey_cooldown_retry_hints: true,
        apikey_cooldown_max_backoff_steps: 5,
        oauth_breaker_failure_threshold: 8,
        oauth_breaker_degradation_threshold: 5,
        oauth_breaker_reset_timeout_ms: 60_000,
        apikey_breaker_failure_threshold: 12,
        apikey_breaker_degradation_threshold: 7,
        apikey_breaker_reset_timeout_ms: 30_000,
        revision: row
            .try_get("revision")
            .map_err(|_| "invalid legacy runtime settings record")?,
    })
}

fn read_reddb_runtime_settings(
    row: &reddb_client::Row,
) -> Result<StoredRuntimeSettings, &'static str> {
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid runtime settings record"),
    };
    let enabled = integer("quota_preflight_enabled")?;
    let oauth_retry_hints = integer("oauth_cooldown_retry_hints")?;
    let apikey_retry_hints = integer("apikey_cooldown_retry_hints")?;
    if !matches!(enabled, 0 | 1)
        || !matches!(oauth_retry_hints, 0 | 1)
        || !matches!(apikey_retry_hints, 0 | 1)
    {
        return Err("invalid runtime settings record");
    }
    Ok(StoredRuntimeSettings {
        quota_preflight_enabled: enabled == 1,
        quota_preflight_threshold_ppm: integer("quota_preflight_threshold_ppm")?,
        oauth_cooldown_base_ms: integer("oauth_cooldown_base_ms")?,
        oauth_cooldown_retry_hints: oauth_retry_hints == 1,
        oauth_cooldown_max_backoff_steps: integer("oauth_cooldown_max_backoff_steps")?,
        apikey_cooldown_base_ms: integer("apikey_cooldown_base_ms")?,
        apikey_cooldown_retry_hints: apikey_retry_hints == 1,
        apikey_cooldown_max_backoff_steps: integer("apikey_cooldown_max_backoff_steps")?,
        oauth_breaker_failure_threshold: integer("oauth_breaker_failure_threshold")?,
        oauth_breaker_degradation_threshold: integer("oauth_breaker_degradation_threshold")?,
        oauth_breaker_reset_timeout_ms: integer("oauth_breaker_reset_timeout_ms")?,
        apikey_breaker_failure_threshold: integer("apikey_breaker_failure_threshold")?,
        apikey_breaker_degradation_threshold: integer("apikey_breaker_degradation_threshold")?,
        apikey_breaker_reset_timeout_ms: integer("apikey_breaker_reset_timeout_ms")?,
        revision: integer("revision")?,
    })
}

fn read_reddb_legacy_runtime_settings(
    row: &reddb_client::Row,
) -> Result<StoredRuntimeSettings, &'static str> {
    let integer = |name: &str| match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case(name))
    {
        Some((_, reddb_client::ValueOut::Integer(value))) => Ok(*value),
        _ => Err("invalid legacy runtime settings record"),
    };
    let enabled = integer("quota_preflight_enabled")?;
    if !matches!(enabled, 0 | 1) {
        return Err("invalid legacy runtime settings record");
    }
    Ok(StoredRuntimeSettings {
        quota_preflight_enabled: enabled == 1,
        quota_preflight_threshold_ppm: integer("quota_preflight_threshold_ppm")?,
        oauth_cooldown_base_ms: 5_000,
        oauth_cooldown_retry_hints: false,
        oauth_cooldown_max_backoff_steps: 8,
        apikey_cooldown_base_ms: 3_000,
        apikey_cooldown_retry_hints: true,
        apikey_cooldown_max_backoff_steps: 5,
        oauth_breaker_failure_threshold: 8,
        oauth_breaker_degradation_threshold: 5,
        oauth_breaker_reset_timeout_ms: 60_000,
        apikey_breaker_failure_threshold: 12,
        apikey_breaker_degradation_threshold: 7,
        apikey_breaker_reset_timeout_ms: 30_000,
        revision: integer("revision")?,
    })
}

fn runtime_settings_params(
    settings: &StoredRuntimeSettings,
    enabled: i64,
    oauth_retry_hints: i64,
    apikey_retry_hints: i64,
) -> Vec<reddb_client::Value> {
    vec![
        reddb_client::Value::Int(enabled),
        reddb_client::Value::Int(settings.quota_preflight_threshold_ppm),
        reddb_client::Value::Int(settings.oauth_cooldown_base_ms),
        reddb_client::Value::Int(oauth_retry_hints),
        reddb_client::Value::Int(settings.oauth_cooldown_max_backoff_steps),
        reddb_client::Value::Int(settings.apikey_cooldown_base_ms),
        reddb_client::Value::Int(apikey_retry_hints),
        reddb_client::Value::Int(settings.apikey_cooldown_max_backoff_steps),
        reddb_client::Value::Int(settings.oauth_breaker_failure_threshold),
        reddb_client::Value::Int(settings.oauth_breaker_degradation_threshold),
        reddb_client::Value::Int(settings.oauth_breaker_reset_timeout_ms),
        reddb_client::Value::Int(settings.apikey_breaker_failure_threshold),
        reddb_client::Value::Int(settings.apikey_breaker_degradation_threshold),
        reddb_client::Value::Int(settings.apikey_breaker_reset_timeout_ms),
        reddb_client::Value::Int(settings.revision),
    ]
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

fn read_reddb_thought_signature(row: &reddb_client::Row) -> Result<String, &'static str> {
    match row
        .iter()
        .find(|(column, _)| column.eq_ignore_ascii_case("signature"))
    {
        Some((_, reddb_client::ValueOut::String(value))) => Ok(value.clone()),
        _ => Err("invalid Antigravity thought signature"),
    }
}

fn thought_signature_record_id(provider_id: &str, tool_call_id: &str) -> String {
    format!("{:x}:{provider_id}{tool_call_id}", provider_id.len())
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
