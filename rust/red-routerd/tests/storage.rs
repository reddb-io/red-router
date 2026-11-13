use red_routerd::storage::{
    Backend, Database, StoredAuditEvent, StoredAuditOutboxEvent, StoredAvailability, StoredBreaker,
    StoredBreakerOverride, StoredClientKey, StoredCombo, StoredContextRelayHandoff,
    StoredContextRelaySession, StoredIdentityBinding, StoredModelCatalogSnapshot,
    StoredOidcBrowserConfig, StoredOidcConfig, StoredProvider, StoredProviderModelQuota,
    StoredProviderQuota, StoredProviderSession, StoredResilience, StoredRoutePin,
    StoredRuntimeSettings, StoredTenant, StoredUsageExport,
};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use tempfile::TempDir;
use url::Url;

#[path = "client_policy_atomicity.rs"]
mod client_policy_atomicity_tests;

// Keep the read-only legacy inspection contract in the Windows storage job as
// well as its standalone integration test.
#[path = "legacy_archive.rs"]
mod legacy_archive_tests;
#[path = "legacy_cutover.rs"]
mod legacy_cutover_tests;
#[path = "legacy_keys.rs"]
mod legacy_key_tests;
#[path = "legacy_preflight.rs"]
mod legacy_preflight_tests;
#[path = "legacy_providers.rs"]
mod legacy_provider_tests;
#[path = "legacy_quota.rs"]
mod legacy_quota_tests;

#[tokio::test]
async fn archived_quota_and_disabled_legacy_key_can_be_adopted_together() {
    let (_directory, source, destination, url) = legacy_key_tests::fixture().await;
    let mut input = SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&source))
        .await
        .unwrap();
    sqlx::raw_sql("CREATE TABLE usage_history (id INTEGER PRIMARY KEY); CREATE TABLE request_cost_ledger (id INTEGER PRIMARY KEY,api_key_id TEXT,tenant_id TEXT,timestamp TEXT,tokens_input INTEGER,tokens_output INTEGER,amount_usd REAL,success INTEGER); CREATE TABLE api_key_quota_counters (api_key_id TEXT,dimension_key TEXT,bucket_index INTEGER,consumed REAL,updated_at INTEGER); DROP TABLE api_key_daily_token_limits; CREATE TABLE api_key_daily_token_limits (api_key_id TEXT PRIMARY KEY,daily_tokens_limit INTEGER); INSERT INTO api_key_daily_token_limits VALUES ('first',1000); DROP TABLE api_key_usage_reservations; CREATE TABLE api_key_usage_reservations (id TEXT PRIMARY KEY,api_key_id TEXT,reserved_tokens INTEGER,reserved_usd REAL,created_at INTEGER,state TEXT,provider TEXT,model TEXT);").execute(&mut input).await.unwrap();
    let now = time::OffsetDateTime::now_utc();
    let timestamp = now
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    sqlx::query("INSERT INTO request_cost_ledger VALUES (1,'first','red',?,30,10,0.00000031,1)")
        .bind(timestamp)
        .execute(&mut input)
        .await
        .unwrap();
    input.close().await.unwrap();
    red_routerd::legacy_archive::archive(&source, &destination)
        .await
        .unwrap();
    let imported = red_routerd::legacy_keys::import(&source, &destination)
        .await
        .unwrap();
    assert_eq!(imported.imported, 2);
    let adopted = red_routerd::legacy_quota::adopt(&destination, "first", 50, 10)
        .await
        .unwrap();
    assert_eq!((adopted.daily_tokens, adopted.monthly_microusd), (40, 1));
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let keys = db.client_keys().await.unwrap();
    let key = keys.iter().find(|key| key.id == "first").unwrap();
    assert!(!key.enabled);
    assert_eq!(
        (
            key.max_rpm,
            key.max_tokens_per_minute,
            key.max_tokens_per_day,
            key.max_monthly_microusd
        ),
        (5, 200, 1000, 9999)
    );
    db.close().await.unwrap();
}

async fn exercise(backend: Backend, url: &str) {
    let db = Database::connect(backend, url).await.unwrap();
    assert_eq!(
        db.tenants().await.unwrap(),
        vec![StoredTenant {
            id: "red".into(),
            slug: "red".into(),
            name: "Red".into(),
            enabled: true,
            revision: 0,
        }]
    );
    let tenant = StoredTenant {
        id: "acme".into(),
        slug: "acme".into(),
        name: "Acme".into(),
        enabled: true,
        revision: 1,
    };
    db.upsert_tenant(&tenant).await.unwrap();
    assert!(db.tenants().await.unwrap().contains(&tenant));
    let identity = StoredIdentityBinding {
        id: "acme-cloud".into(),
        subject: "oidc:cloud@acme.example".into(),
        tenant_id: "acme".into(),
        role: "issuer".into(),
        enabled: true,
        revision: 2,
    };
    db.upsert_identity_binding(&identity).await.unwrap();
    assert_eq!(
        db.identity_bindings().await.unwrap(),
        vec![identity.clone()]
    );
    db.delete_identity_binding(&identity.id).await.unwrap();
    assert!(db.identity_bindings().await.unwrap().is_empty());
    let audit = StoredAuditEvent {
        id: "audit-one".into(),
        created_at_unix_ms: 1_700_000_000_000,
        action: "identity_binding.delete".into(),
        actor: "bootstrap-admin".into(),
        tenant_id: "acme".into(),
        target: identity.id,
        resource_type: "identity_binding".into(),
        status: "success".into(),
        request_id: "request-one".into(),
        details_json: r#"{"before":{"enabled":true},"after":null}"#.into(),
    };
    db.insert_audit_event(&audit).await.unwrap();
    let outbox = db.audit_outbox_events(0, "", 100).await.unwrap();
    assert_eq!(outbox.len(), 1);
    assert_eq!(
        outbox[0],
        StoredAuditOutboxEvent {
            event_id: audit.id.clone(),
            created_at_unix_ms: audit.created_at_unix_ms,
            tenant_id: audit.tenant_id.clone(),
            topic: "redrouter.audit.v1".into(),
            schema_version: 1,
            payload_json: outbox[0].payload_json.clone(),
        }
    );
    let payload: serde_json::Value = serde_json::from_str(&outbox[0].payload_json).unwrap();
    assert_eq!(payload["schemaVersion"], 1);
    assert_eq!(payload["topic"], "redrouter.audit.v1");
    assert_eq!(payload["event"]["id"], audit.id);
    assert_eq!(payload["event"]["tenant_id"], "acme");
    assert!(db
        .audit_outbox_events(outbox[0].created_at_unix_ms, &outbox[0].event_id, 100)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(db.audit_events(None).await.unwrap(), vec![audit.clone()]);
    assert_eq!(db.audit_events(Some("acme")).await.unwrap(), vec![audit]);
    assert!(db.audit_events(Some("red")).await.unwrap().is_empty());
    assert_eq!(db.upstream().await.unwrap(), None);
    db.seed("https://first.example/v1/chat/completions")
        .await
        .unwrap();
    db.seed("https://ignored.example/v1/chat/completions")
        .await
        .unwrap();
    assert_eq!(
        db.upstream().await.unwrap().as_deref(),
        Some("https://first.example/v1/chat/completions")
    );
    db.set_upstream("https://second.example/v1/chat/completions")
        .await
        .unwrap();
    let first = StoredProvider {
        node_id: None,
        protocol: "auto".to_owned(),
        id: "first".into(),
        tenant_id: "red".into(),
        provider: "openai".into(),
        upstream_url: "https://first.example/v1/chat/completions".into(),
        credential_ciphertext: "encrypted-first".into(),
        enabled: true,
        updated_at: 1,
    };
    let mut second = StoredProvider {
        node_id: None,
        protocol: "openai-responses".to_owned(),
        id: "second".into(),
        tenant_id: "red".into(),
        provider: "openrouter".into(),
        upstream_url: "https://second.example/v1/chat/completions".into(),
        credential_ciphertext: "encrypted-second".into(),
        enabled: false,
        updated_at: 2,
    };
    db.upsert_provider(&first).await.unwrap();
    db.upsert_provider(&second).await.unwrap();
    assert_eq!(
        db.providers().await.unwrap(),
        vec![second.clone(), first.clone()]
    );
    assert_eq!(db.active_provider().await.unwrap(), Some(first.clone()));
    second.enabled = true;
    second.updated_at = 3;
    db.upsert_provider(&second).await.unwrap();
    assert_eq!(db.active_provider().await.unwrap(), Some(second.clone()));
    db.disable_provider("second", 4).await.unwrap();
    assert_eq!(db.active_provider().await.unwrap(), Some(first.clone()));
    assert_eq!(
        db.providers()
            .await
            .unwrap()
            .iter()
            .find(|row| row.id == "second")
            .unwrap()
            .protocol,
        "openai-responses"
    );
    // Explicitly clearing a protocol, including a same-revision replacement, must persist.
    second.enabled = false;
    second.updated_at = 4;
    second.protocol = "auto".into();
    db.upsert_provider(&second).await.unwrap();
    assert_eq!(
        db.providers()
            .await
            .unwrap()
            .iter()
            .find(|row| row.id == "second")
            .unwrap()
            .protocol,
        "auto"
    );
    db.delete_provider("second").await.unwrap();
    assert_eq!(db.providers().await.unwrap(), vec![first.clone()]);
    let provider_session = StoredProviderSession {
        provider_id: "first".into(),
        provider: "codex".into(),
        session_ciphertext: "rr:v1:encrypted-session".into(),
        revision: 1,
    };
    db.upsert_provider_session(&provider_session).await.unwrap();
    assert_eq!(
        db.provider_sessions().await.unwrap(),
        vec![provider_session]
    );
    db.delete_provider_session("first").await.unwrap();
    assert!(db.provider_sessions().await.unwrap().is_empty());
    let client_key = StoredClientKey {
        id: "agent-fleet".into(),
        label: "Agent fleet".into(),
        key_hash: "11".repeat(32),
        enabled: true,
        expiry_unix: 2_000_000_000,
        scopes_json: r#"["inference:chat"]"#.into(),
        allowed_endpoints_json: r#"["chat"]"#.into(),
        allowed_models_json: r#"["openai/*"]"#.into(),
        blocked_models_json: "[]".into(),
        allowed_provider_ids_json: r#"["first"]"#.into(),
        max_concurrent: 32,
        max_rpm: 600,
        max_rpd: 50_000,
        model_id_format: "flat".into(),
        model_access_mode: "restricted".to_owned(),
        allowed_combos_json: r#"["combo/team"]"#.to_owned(),
        access_schedule_json:
            r#"{"enabled":true,"from":"08:00","until":"18:00","days":[1,2,3,4,5],"tz":"America/Sao_Paulo"}"#
                .into(),
        tenant_id: "acme".into(),
        created_by: "test-admin".into(),
        max_tokens_per_minute: 100_000,
        max_tokens_per_day: 1_000_000,
        max_monthly_microusd: 25_000_000,
        reservation_tokens: 10_000,
        reservation_microusd: 500_000,
        revision: 5,
    };
    db.upsert_client_key(&client_key).await.unwrap();
    assert_eq!(db.client_keys().await.unwrap(), vec![client_key.clone()]);
    db.revoke_client_key("agent-fleet", 6).await.unwrap();
    let mut revoked_key = client_key.clone();
    revoked_key.enabled = false;
    revoked_key.revision = 6;
    assert_eq!(db.client_keys().await.unwrap(), vec![revoked_key.clone()]);
    let combo = StoredCombo {
        id: "agent-combo".into(),
        tenant_id: "red".into(),
        protocol: "openai".into(),
        strategy: "priority".into(),
        fallback: true,
        targets_json: r#"[{"provider_id":"first","model":"openai/model"}]"#.into(),
        enabled: true,
        revision: 7,
    };
    db.upsert_combo(&combo).await.unwrap();
    assert_eq!(db.combos().await.unwrap(), vec![combo.clone()]);
    db.disable_combo("agent-combo", 8).await.unwrap();
    let mut disabled_combo = combo;
    disabled_combo.enabled = false;
    disabled_combo.revision = 8;
    assert_eq!(db.combos().await.unwrap(), vec![disabled_combo.clone()]);
    let route_pin = StoredRoutePin {
        combo_id: "agent-combo".into(),
        provider_id: "first".into(),
        model: "openai/model".into(),
        revision: 9,
    };
    db.upsert_route_pin(&route_pin).await.unwrap();
    assert_eq!(db.route_pins().await.unwrap(), vec![route_pin.clone()]);
    let relay_session = StoredContextRelaySession {
        record_id: "hashed-session".into(),
        combo_id: "agent-combo".into(),
        provider_id: "first".into(),
        model: "openai/model".into(),
        updated_at_unix_ms: 1_700_000_000_000,
    };
    db.upsert_context_relay_session(&relay_session)
        .await
        .unwrap();
    assert_eq!(
        db.context_relay_session(&relay_session.record_id)
            .await
            .unwrap(),
        Some(relay_session.clone())
    );
    let relay_handoff = StoredContextRelayHandoff {
        record_id: relay_session.record_id.clone(),
        combo_id: "agent-combo".into(),
        summary: "The migration is active.".into(),
        key_decisions_json: "[\"Rust owns persistence\"]".into(),
        task_progress: "Storage is complete; provider generation is next.".into(),
        active_entities_json: "[\"red-routerd\"]".into(),
        message_count: 12,
        source_model: "openai/model".into(),
        summary_model: "openai/summary".into(),
        generated_at_unix_ms: 1_700_000_000_000,
        expires_at_unix_ms: 1_700_018_000_000,
    };
    db.upsert_context_relay_handoff(&relay_handoff)
        .await
        .unwrap();
    assert_eq!(
        db.context_relay_handoff(&relay_handoff.record_id)
            .await
            .unwrap(),
        Some(relay_handoff.clone())
    );
    let quota = StoredProviderQuota {
        provider_id: "first".into(),
        session_remaining_ppm: 750_000,
        session_reset_unix_ms: 1_700_000_100_000,
        weekly_remaining_ppm: 500_000,
        weekly_reset_unix_ms: 1_700_100_000_000,
        limit_reached: false,
        observed_at_unix_ms: 1_700_000_000_000,
        expires_at_unix_ms: 1_700_000_360_000,
        revision: 10,
    };
    db.upsert_provider_quota(&quota).await.unwrap();
    assert_eq!(db.provider_quotas().await.unwrap(), vec![quota.clone()]);
    let model_quota = StoredProviderModelQuota {
        provider_id: "first".into(),
        model_id: "gemini-3.1-pro".into(),
        session_remaining_ppm: 250_000,
        session_reset_unix_ms: 1_700_000_100_000,
        weekly_remaining_ppm: 600_000,
        weekly_reset_unix_ms: 1_700_100_000_000,
        limit_reached: false,
        observed_at_unix_ms: 1_700_000_000_000,
        expires_at_unix_ms: 1_700_000_360_000,
        revision: 11,
    };
    db.replace_provider_model_quotas("first", std::slice::from_ref(&model_quota))
        .await
        .unwrap();
    assert_eq!(
        db.provider_model_quotas().await.unwrap(),
        vec![model_quota.clone()]
    );
    let breaker = StoredBreaker {
        provider_id: "first".into(),
        state: "open".into(),
        failure_count: 12,
        last_failure_unix_ms: 1_700_000_000_000,
        open_cycle_count: 2,
        failure_threshold: 12,
        degradation_threshold: 7,
        reset_timeout_ms: 30_000,
        revision: 11,
    };
    db.upsert_breaker(&breaker).await.unwrap();
    assert_eq!(db.breakers().await.unwrap(), vec![breaker.clone()]);
    let availability = StoredAvailability {
        provider_id: "first".into(),
        cooldown_until_unix_ms: 9_000_000_000_000,
        backoff_level: 2,
        last_status: 429,
        model_lockouts_json: r#"[{"model":"openai/missing","until_unix_ms":9000000000000,"status":404,"backoff_level":1}]"#.into(),
        revision: 12,
    };
    db.upsert_provider_availability(&availability)
        .await
        .unwrap();
    assert_eq!(
        db.provider_availability().await.unwrap(),
        vec![availability.clone()]
    );
    let previous_resilience = StoredResilience {
        provider_id: "first".into(),
        rate_limit_scope: "auto".into(),
        revision: 12,
    };
    db.upsert_provider_resilience(&previous_resilience)
        .await
        .unwrap();
    let resilience = StoredResilience {
        provider_id: "first".into(),
        rate_limit_scope: "model".into(),
        revision: 13,
    };
    db.upsert_provider_resilience(&resilience).await.unwrap();
    assert_eq!(
        db.provider_resilience().await.unwrap(),
        vec![resilience.clone(), previous_resilience.clone()]
    );
    let runtime_settings = StoredRuntimeSettings {
        quota_preflight_enabled: true,
        quota_preflight_threshold_ppm: 20_000,
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
        revision: 14,
    };
    assert_eq!(db.runtime_settings().await.unwrap(), None);
    db.upsert_runtime_settings(&runtime_settings).await.unwrap();
    assert_eq!(
        db.runtime_settings().await.unwrap(),
        Some(runtime_settings.clone())
    );
    let breaker_override = StoredBreakerOverride {
        provider_id: "first".into(),
        failure_threshold: 4,
        degradation_threshold: 2,
        reset_timeout_ms: 45_000,
        revision: 15,
    };
    db.upsert_breaker_override(&breaker_override).await.unwrap();
    assert_eq!(
        db.breaker_overrides().await.unwrap(),
        vec![breaker_override.clone()]
    );
    let oidc = StoredOidcConfig {
        enabled: true,
        issuer: "https://issuer.example".into(),
        audience: "red-router-admin".into(),
        jwks_uri: "https://issuer.example/.well-known/jwks.json".into(),
        required_claims_json: r#"{"org_role":["owner"]}"#.into(),
        allowed_subjects_json: r#"["operator@example.com"]"#.into(),
        revision: 12,
    };
    db.upsert_oidc(&oidc).await.unwrap();
    assert_eq!(db.oidc_config().await.unwrap(), Some(oidc.clone()));
    let oidc_browser = StoredOidcBrowserConfig {
        public_origin: "https://router.example".into(),
        client_id: "red-router-dashboard".into(),
        client_secret_ciphertext: "encrypted-client-secret".into(),
        authorization_endpoint: "https://issuer.example/authorize".into(),
        token_endpoint: "https://issuer.example/token".into(),
        scopes_json: r#"["openid","profile","email"]"#.into(),
        revision: 12,
    };
    db.upsert_oidc_browser(&oidc_browser).await.unwrap();
    assert_eq!(
        db.oidc_browser_config().await.unwrap(),
        Some(oidc_browser.clone())
    );
    assert_eq!(db.model_catalog_snapshot().await.unwrap(), None);
    assert_eq!(db.model_catalog_revision().await.unwrap(), None);
    let catalog = StoredModelCatalogSnapshot {
        snapshot_json: r#"{"manifest":{"contentSha256":"fixture"}}"#.into(),
        revision: 14,
    };
    db.upsert_model_catalog_snapshot(&catalog).await.unwrap();
    assert_eq!(
        db.model_catalog_snapshot().await.unwrap(),
        Some(catalog.clone())
    );
    assert_eq!(db.model_catalog_revision().await.unwrap(), Some(14));
    db.upsert_antigravity_thought_signature(
        "first",
        "call_agy_fixture_0",
        "opaque-thought-signature",
        100,
        1_000,
    )
    .await
    .unwrap();
    assert_eq!(
        db.antigravity_thought_signature("first", "call_agy_fixture_0", 200)
            .await
            .unwrap()
            .as_deref(),
        Some("opaque-thought-signature")
    );
    db.close().await.unwrap();
    drop(db);
    let reopened = Database::connect(backend, url).await.unwrap();
    assert_eq!(
        reopened.upstream().await.unwrap().as_deref(),
        Some("https://second.example/v1/chat/completions")
    );
    assert_eq!(reopened.active_provider().await.unwrap(), Some(first));
    assert_eq!(reopened.client_keys().await.unwrap(), vec![revoked_key]);
    assert_eq!(reopened.combos().await.unwrap(), vec![disabled_combo]);
    assert_eq!(reopened.route_pins().await.unwrap(), vec![route_pin]);
    assert_eq!(
        reopened
            .context_relay_session(&relay_session.record_id)
            .await
            .unwrap(),
        Some(relay_session)
    );
    assert_eq!(
        reopened
            .context_relay_handoff(&relay_handoff.record_id)
            .await
            .unwrap(),
        Some(relay_handoff)
    );
    reopened.delete_route_pin("agent-combo").await.unwrap();
    assert!(reopened.route_pins().await.unwrap().is_empty());
    assert_eq!(reopened.provider_quotas().await.unwrap(), vec![quota]);
    assert_eq!(
        reopened.provider_model_quotas().await.unwrap(),
        vec![model_quota]
    );
    reopened
        .replace_provider_model_quotas("first", &[])
        .await
        .unwrap();
    assert!(reopened.provider_model_quotas().await.unwrap().is_empty());
    reopened.delete_provider_quota("first").await.unwrap();
    assert!(reopened.provider_quotas().await.unwrap().is_empty());
    assert_eq!(reopened.breakers().await.unwrap(), vec![breaker]);
    reopened.delete_breaker("first").await.unwrap();
    assert!(reopened.breakers().await.unwrap().is_empty());
    assert_eq!(
        reopened.provider_availability().await.unwrap(),
        vec![availability]
    );
    reopened
        .delete_provider_availability("first")
        .await
        .unwrap();
    assert!(reopened.provider_availability().await.unwrap().is_empty());
    assert_eq!(
        reopened.provider_resilience().await.unwrap(),
        vec![resilience, previous_resilience]
    );
    reopened.delete_provider_resilience("first").await.unwrap();
    assert!(reopened.provider_resilience().await.unwrap().is_empty());
    assert_eq!(
        reopened.runtime_settings().await.unwrap(),
        Some(runtime_settings)
    );
    assert_eq!(
        reopened.breaker_overrides().await.unwrap(),
        vec![breaker_override]
    );
    reopened.delete_breaker_override("first").await.unwrap();
    assert!(reopened.breaker_overrides().await.unwrap().is_empty());
    assert_eq!(reopened.oidc_config().await.unwrap(), Some(oidc));
    assert_eq!(
        reopened.oidc_browser_config().await.unwrap(),
        Some(oidc_browser)
    );
    assert_eq!(
        reopened.model_catalog_snapshot().await.unwrap(),
        Some(catalog)
    );
    assert_eq!(reopened.model_catalog_revision().await.unwrap(), Some(14));
    assert_eq!(
        reopened
            .antigravity_thought_signature("first", "call_agy_fixture_0", 200)
            .await
            .unwrap()
            .as_deref(),
        Some("opaque-thought-signature")
    );
    reopened
        .delete_expired_antigravity_thought_signatures(1_000)
        .await
        .unwrap();
    assert_eq!(
        reopened
            .antigravity_thought_signature("first", "call_agy_fixture_0", 1_000)
            .await
            .unwrap(),
        None
    );
    reopened.delete_oidc_browser().await.unwrap();
    assert_eq!(reopened.oidc_browser_config().await.unwrap(), None);
    reopened.delete_oidc().await.unwrap();
    assert_eq!(reopened.oidc_config().await.unwrap(), None);
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn sqlite_configuration_survives_restart() {
    let temp = TempDir::new().unwrap();
    let folder = temp.path().join("storage with spaces");
    std::fs::create_dir_all(&folder).unwrap();
    let file = Url::from_file_path(folder.join("config.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    exercise(Backend::Sqlite, &url).await;
}

#[tokio::test]
async fn sqlite_runtime_settings_adopt_the_pre_cooldown_schema() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("runtime-settings-v1.sqlite");
    let file = Url::from_file_path(&path).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let mut raw = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query("CREATE TABLE redrouter_runtime_settings (id BIGINT PRIMARY KEY, quota_preflight_enabled BIGINT NOT NULL, quota_preflight_threshold_ppm BIGINT NOT NULL, revision BIGINT NOT NULL)")
        .execute(&mut raw)
        .await
        .unwrap();
    sqlx::query("INSERT INTO redrouter_runtime_settings VALUES (1,1,35000,42)")
        .execute(&mut raw)
        .await
        .unwrap();
    raw.close().await.unwrap();

    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let adopted = db.runtime_settings().await.unwrap().unwrap();
    assert!(adopted.quota_preflight_enabled);
    assert_eq!(adopted.quota_preflight_threshold_ppm, 35_000);
    assert_eq!(adopted.oauth_cooldown_base_ms, 5_000);
    assert_eq!(adopted.oauth_breaker_failure_threshold, 8);
    assert_eq!(adopted.apikey_breaker_failure_threshold, 12);
    assert_eq!(adopted.revision, 42);
    db.close().await.unwrap();
}

#[tokio::test]
async fn sqlite_usage_paths_have_bounded_report_and_quota_indexes() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("usage-indexes.sqlite");
    let file = Url::from_file_path(&path).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    Database::connect(Backend::Sqlite, &url)
        .await
        .unwrap()
        .close()
        .await
        .unwrap();

    let options = SqliteConnectOptions::new().filename(&path);
    let mut raw = SqliteConnection::connect_with(&options).await.unwrap();
    let indexes: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'redrouter_usage_%_time' ORDER BY name",
    )
    .fetch_all(&mut raw)
    .await
    .unwrap();
    assert_eq!(
        indexes,
        vec![
            "redrouter_usage_ledger_key_time",
            "redrouter_usage_ledger_tenant_key_time",
            "redrouter_usage_ledger_tenant_time",
            "redrouter_usage_reservations_key_time",
            "redrouter_usage_reservations_tenant_time",
        ]
    );
    raw.close().await.unwrap();
}

#[tokio::test]
async fn sqlite_usage_schema_backfills_legacy_price_snapshots() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("usage-price-migration.sqlite");
    let file = Url::from_file_path(&path).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let options = SqliteConnectOptions::new()
        .filename(&path)
        .create_if_missing(true);
    let mut raw = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query("CREATE TABLE redrouter_usage_ledger (event_id TEXT PRIMARY KEY, key_id TEXT NOT NULL, tenant_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, tokens_input BIGINT NOT NULL, tokens_output BIGINT NOT NULL, tokens_cache_read BIGINT NOT NULL, tokens_cache_creation BIGINT NOT NULL, tokens_reasoning BIGINT NOT NULL, amount_microusd BIGINT NOT NULL, pricing_known BIGINT NOT NULL, created_at_unix_ms BIGINT NOT NULL)")
        .execute(&mut raw)
        .await
        .unwrap();
    sqlx::query("INSERT INTO redrouter_usage_ledger VALUES ('priced','key','red','openai','gpt',1,2,0,0,0,3,1,1700000000000),('unpriced','key','red','openai','gpt',1,2,0,0,0,0,0,1700000000001)")
        .execute(&mut raw)
        .await
        .unwrap();
    raw.close().await.unwrap();

    Database::connect(Backend::Sqlite, &url)
        .await
        .unwrap()
        .close()
        .await
        .unwrap();

    let options = SqliteConnectOptions::new().filename(&path);
    let mut raw = SqliteConnection::connect_with(&options).await.unwrap();
    let rows: Vec<(String, String, String, i64, Option<String>)> = sqlx::query_as(
        "SELECT event_id, key_name, usage_kind, search_units, pricing_snapshot FROM redrouter_usage_ledger ORDER BY event_id",
    )
    .fetch_all(&mut raw)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            (
                "priced".into(),
                "key".into(),
                "tokens".into(),
                0,
                Some(r#"{"source":"legacy","available":false}"#.into()),
            ),
            ("unpriced".into(), "key".into(), "tokens".into(), 0, None),
        ]
    );
    raw.close().await.unwrap();
}

#[tokio::test]
async fn sqlite_usage_export_preserves_key_and_model_attribution() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("usage-export.sqlite");
    let file = Url::from_file_path(&path).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let options = SqliteConnectOptions::new().filename(&path);
    let mut raw = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query("INSERT INTO redrouter_usage_ledger (event_id,key_id,key_name,tenant_id,provider,model,tokens_input,tokens_output,tokens_cache_read,tokens_cache_creation,tokens_reasoning,amount_microusd,pricing_known,pricing_snapshot,created_at_unix_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .bind("usage-one")
        .bind("agent-key")
        .bind("Agent fleet")
        .bind("red")
        .bind("openrouter")
        .bind("openai/gpt-5")
        .bind(100_i64)
        .bind(40_i64)
        .bind(20_i64)
        .bind(5_i64)
        .bind(10_i64)
        .bind(1234_i64)
        .bind(1_i64)
        .bind(r#"{"source":"models.dev"}"#)
        .bind(1_700_000_000_000_i64)
        .execute(&mut raw)
        .await
        .unwrap();
    raw.close().await.unwrap();

    let events = db.usage_export_events(0, "", 10).await.unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].key_id, "agent-key");
    assert_eq!(events[0].key_name, "Agent fleet");
    assert_eq!(events[0].provider, "openrouter");
    assert_eq!(events[0].model, "openai/gpt-5");
    assert_eq!(events[0].usage_kind, "tokens");
    assert_eq!(events[0].search_units, 0);
    assert_eq!(events[0].tokens_input, 100);
    assert_eq!(events[0].tokens_output, 40);
    assert_eq!(events[0].amount_microusd, 1234);
    let webhook = StoredUsageExport {
        id: "usage-hook".into(),
        tenant_id: "red".into(),
        name: "Billing hook".into(),
        export_type: "webhook".into(),
        mode: "instant".into(),
        window_sec: 0,
        api_key_ids_json: r#"["agent-key"]"#.into(),
        project_id: String::new(),
        dataset_id: String::new(),
        table_id: String::new(),
        service_account_ciphertext: String::new(),
        config_json: r#"{"url":"https://billing.example.com/usage"}"#.into(),
        secret_ciphertext: "rrenc1:ciphertext".into(),
        batch_size: 8,
        interval_seconds: 1,
        enabled: true,
        revision: 1_700_000_000_000_000_001,
    };
    db.upsert_usage_export(&webhook).await.unwrap();
    assert_eq!(db.usage_exports().await.unwrap(), vec![webhook]);
    db.close().await.unwrap();
}

#[tokio::test]
async fn sqlite_client_preference_revision_mismatch_fails_closed() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("preference-revision.sqlite");
    let file = Url::from_file_path(&path).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    db.upsert_client_key(&StoredClientKey {
        id: "client".into(),
        label: "Client".into(),
        key_hash: "22".repeat(32),
        enabled: true,
        expiry_unix: 0,
        scopes_json: "[]".into(),
        allowed_endpoints_json: "[]".into(),
        allowed_models_json: "[]".into(),
        blocked_models_json: "[]".into(),
        allowed_provider_ids_json: "[]".into(),
        max_concurrent: 0,
        max_rpm: 0,
        max_rpd: 0,
        model_id_format: "flat".into(),
        model_access_mode: "restricted".to_owned(),
        allowed_combos_json: r#"["combo/team"]"#.to_owned(),
        access_schedule_json: String::new(),
        tenant_id: "red".into(),
        created_by: "test-admin".into(),
        max_tokens_per_minute: 0,
        max_tokens_per_day: 0,
        max_monthly_microusd: 0,
        reservation_tokens: 0,
        reservation_microusd: 0,
        revision: 1,
    })
    .await
    .unwrap();
    db.close().await.unwrap();

    let options = SqliteConnectOptions::new().filename(&path);
    let mut raw = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query(
        "UPDATE redrouter_control_client_key_preferences SET revision = 2 WHERE key_id = 'client'",
    )
    .execute(&mut raw)
    .await
    .unwrap();
    raw.close().await.unwrap();

    let reopened = Database::connect(Backend::Sqlite, &url).await.unwrap();
    assert_eq!(
        reopened.client_keys().await.unwrap_err(),
        "client key preference revision mismatch"
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn sqlite_client_schedule_revision_mismatch_fails_closed() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("schedule-revision.sqlite");
    let file = Url::from_file_path(&path).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    db.upsert_client_key(&StoredClientKey {
        id: "client".into(),
        label: "Client".into(),
        key_hash: "44".repeat(32),
        enabled: true,
        expiry_unix: 0,
        scopes_json: "[]".into(),
        allowed_endpoints_json: "[]".into(),
        allowed_models_json: "[]".into(),
        blocked_models_json: "[]".into(),
        allowed_provider_ids_json: "[]".into(),
        max_concurrent: 0,
        max_rpm: 0,
        max_rpd: 0,
        model_id_format: "prefixed".into(),
        model_access_mode: "restricted".to_owned(),
        allowed_combos_json: r#"["combo/team"]"#.to_owned(),
        access_schedule_json:
            r#"{"enabled":true,"from":"08:00","until":"18:00","days":[1],"tz":"UTC"}"#.into(),
        tenant_id: "red".into(),
        created_by: "test-admin".into(),
        max_tokens_per_minute: 0,
        max_tokens_per_day: 0,
        max_monthly_microusd: 0,
        reservation_tokens: 0,
        reservation_microusd: 0,
        revision: 1,
    })
    .await
    .unwrap();
    db.close().await.unwrap();

    let options = SqliteConnectOptions::new().filename(&path);
    let mut raw = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query(
        "UPDATE redrouter_control_client_key_schedules SET revision = 2 WHERE key_id = 'client'",
    )
    .execute(&mut raw)
    .await
    .unwrap();
    raw.close().await.unwrap();

    let reopened = Database::connect(Backend::Sqlite, &url).await.unwrap();
    assert_eq!(
        reopened.client_keys().await.unwrap_err(),
        "client key access schedule revision mismatch"
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn sqlite_client_ownership_revision_mismatch_fails_closed() {
    let temp = TempDir::new().unwrap();
    let path = temp.path().join("ownership-revision.sqlite");
    let file = Url::from_file_path(&path).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    db.upsert_client_key(&StoredClientKey {
        id: "client".into(),
        label: "Client".into(),
        key_hash: "33".repeat(32),
        enabled: true,
        expiry_unix: 0,
        scopes_json: "[]".into(),
        allowed_endpoints_json: "[]".into(),
        allowed_models_json: "[]".into(),
        blocked_models_json: "[]".into(),
        allowed_provider_ids_json: "[]".into(),
        max_concurrent: 0,
        max_rpm: 0,
        max_rpd: 0,
        model_id_format: "prefixed".into(),
        model_access_mode: "restricted".to_owned(),
        allowed_combos_json: r#"["combo/team"]"#.to_owned(),
        access_schedule_json: String::new(),
        tenant_id: "red".into(),
        created_by: "test-admin".into(),
        max_tokens_per_minute: 0,
        max_tokens_per_day: 0,
        max_monthly_microusd: 0,
        reservation_tokens: 0,
        reservation_microusd: 0,
        revision: 1,
    })
    .await
    .unwrap();
    db.close().await.unwrap();

    let options = SqliteConnectOptions::new().filename(&path);
    let mut raw = SqliteConnection::connect_with(&options).await.unwrap();
    sqlx::query(
        "UPDATE redrouter_control_client_key_ownership SET revision = 2 WHERE key_id = 'client'",
    )
    .execute(&mut raw)
    .await
    .unwrap();
    raw.close().await.unwrap();

    let reopened = Database::connect(Backend::Sqlite, &url).await.unwrap();
    assert_eq!(
        reopened.client_keys().await.unwrap_err(),
        "client key ownership revision mismatch"
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn sqlite_rolls_back_audit_when_the_outbox_append_fails() {
    let temp = TempDir::new().unwrap();
    let file = Url::from_file_path(temp.path().join("audit-outbox.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let mut raw = SqliteConnection::connect(&url).await.unwrap();
    sqlx::query("INSERT INTO redrouter_control_audit_outbox (event_id,created_at_unix_ms,tenant_id,topic,schema_version,payload_json) VALUES (?,?,?,?,?,?)")
        .bind("audit-collision")
        .bind(1_700_000_000_000_i64)
        .bind("red")
        .bind("redrouter.audit.v1")
        .bind(1_i64)
        .bind(r#"{"fixture":true}"#)
        .execute(&mut raw)
        .await
        .unwrap();
    raw.close().await.unwrap();
    let audit = StoredAuditEvent {
        id: "audit-collision".into(),
        created_at_unix_ms: 1_700_000_000_000,
        action: "tenant.update".into(),
        actor: "bootstrap-admin".into(),
        tenant_id: "red".into(),
        target: "red".into(),
        resource_type: "tenant".into(),
        status: "success".into(),
        request_id: "request-collision".into(),
        details_json: r#"{"before":null,"after":{"enabled":true}}"#.into(),
    };
    assert_eq!(
        db.insert_audit_event(&audit).await.unwrap_err(),
        "cannot write audit outbox event"
    );
    assert!(db.audit_events(None).await.unwrap().is_empty());
    assert_eq!(db.audit_outbox_events(0, "", 100).await.unwrap().len(), 1);
    db.close().await.unwrap();
}

#[tokio::test]
async fn sqlite_audit_sink_lease_serializes_cursor_progress() {
    let temp = TempDir::new().unwrap();
    let file = Url::from_file_path(temp.path().join("audit-sink.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let db = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let audit = StoredAuditEvent {
        id: "audit-export".into(),
        created_at_unix_ms: 1_700_000_000_000,
        action: "tenant.update".into(),
        actor: "bootstrap-admin".into(),
        tenant_id: "red".into(),
        target: "red".into(),
        resource_type: "tenant".into(),
        status: "success".into(),
        request_id: "request-export".into(),
        details_json: r#"{"before":null,"after":{"enabled":true}}"#.into(),
    };
    db.insert_audit_event(&audit).await.unwrap();
    let event = db.audit_outbox_events(0, "", 1).await.unwrap().remove(0);
    assert!(db
        .acquire_audit_sink_lease("bigquery", "owner-a", 100, 1_000)
        .await
        .unwrap());
    assert!(!db
        .acquire_audit_sink_lease("bigquery", "owner-b", 200, 1_200)
        .await
        .unwrap());
    db.advance_audit_sink_cursor("bigquery", "owner-a", &event, 300)
        .await
        .unwrap();
    db.release_audit_sink_lease("bigquery", "owner-a", 400)
        .await
        .unwrap();
    let cursor = db.audit_sink_cursor("bigquery").await.unwrap().unwrap();
    assert_eq!(cursor.cursor_created_at_unix_ms, event.created_at_unix_ms);
    assert_eq!(cursor.cursor_event_id, event.event_id);
    assert_eq!(cursor.lease_owner, "");
    assert_eq!(cursor.lease_until_unix_ms, 0);
    assert!(db
        .acquire_audit_sink_lease("bigquery", "owner-b", 500, 1_500)
        .await
        .unwrap());
    db.close().await.unwrap();
}

#[tokio::test]
async fn sqlite_context_relay_generation_lease_serializes_replicas() {
    let temp = TempDir::new().unwrap();
    let file = Url::from_file_path(temp.path().join("context-relay-lease.sqlite")).unwrap();
    let url = format!("{}?mode=rwc", file.as_str().replacen("file:", "sqlite:", 1));
    let first = Database::connect(Backend::Sqlite, &url).await.unwrap();
    let second = Database::connect(Backend::Sqlite, &url).await.unwrap();

    assert_context_relay_generation_lease(&first, &second).await;
    first.close().await.unwrap();
    second.close().await.unwrap();
}

async fn assert_context_relay_generation_lease(first: &Database, second: &Database) {
    assert!(first
        .acquire_context_relay_generation_lease("relay", "owner-a", 100, 1_000)
        .await
        .unwrap());
    assert!(!second
        .acquire_context_relay_generation_lease("relay", "owner-b", 200, 1_200)
        .await
        .unwrap());

    first
        .release_context_relay_generation_lease("relay", "owner-a")
        .await
        .unwrap();
    assert!(second
        .acquire_context_relay_generation_lease("relay", "owner-b", 500, 1_500)
        .await
        .unwrap());

    // A stale owner cannot release the current owner's lease.
    first
        .release_context_relay_generation_lease("relay", "owner-a")
        .await
        .unwrap();
    assert!(!first
        .acquire_context_relay_generation_lease("relay", "owner-c", 600, 1_600)
        .await
        .unwrap());

    // A crashed owner cannot strand generation permanently.
    assert!(first
        .acquire_context_relay_generation_lease("relay", "owner-c", 1_500, 2_500)
        .await
        .unwrap());
    first
        .release_context_relay_generation_lease("relay", "owner-c")
        .await
        .unwrap();
}

#[cfg(feature = "reddb-embedded")]
#[tokio::test]
async fn embedded_reddb_configuration_survives_restart() {
    let temp = TempDir::new().unwrap();
    let folder = temp.path().join("storage with spaces");
    std::fs::create_dir_all(&folder).unwrap();
    let url = Url::from_file_path(folder.join("config.rdb")).unwrap();
    exercise(Backend::ReddbEmbedded, url.as_str()).await;
}

#[cfg(feature = "reddb-embedded")]
#[tokio::test]
async fn embedded_reddb_refuses_a_second_owner() {
    let temp = TempDir::new().unwrap();
    let url = Url::from_file_path(temp.path().join("config.rdb")).unwrap();
    let first = Database::connect(Backend::ReddbEmbedded, url.as_str())
        .await
        .unwrap();
    assert!(Database::connect(Backend::ReddbEmbedded, url.as_str())
        .await
        .is_err());
    first.close().await.unwrap();
    drop(first);
    let second = Database::connect(Backend::ReddbEmbedded, url.as_str())
        .await
        .unwrap();
    second.close().await.unwrap();
}

async fn remote(backend: Backend, variable: &str) {
    let Ok(url) = std::env::var(variable) else {
        return;
    };
    assert_eq!(
        std::env::var("RED_ROUTER_TEST_DISPOSABLE").as_deref(),
        Ok("1")
    );
    exercise(backend, &url).await;
}

#[tokio::test]
async fn remote_postgres_configuration_survives_reconnect() {
    let Ok(url) = std::env::var("RED_ROUTER_TEST_POSTGRES_URL") else {
        return;
    };
    assert_eq!(
        std::env::var("RED_ROUTER_TEST_DISPOSABLE").as_deref(),
        Ok("1")
    );
    exercise(Backend::Postgres, &url).await;
    let first = Database::connect(Backend::Postgres, &url).await.unwrap();
    let second = Database::connect(Backend::Postgres, &url).await.unwrap();
    assert_context_relay_generation_lease(&first, &second).await;
    first.close().await.unwrap();
    second.close().await.unwrap();
}

#[tokio::test]
async fn remote_reddb_configuration_survives_reconnect() {
    remote(Backend::ReddbRemote, "RED_ROUTER_TEST_REDDB_URL").await;
}

#[tokio::test]
async fn remote_reddb_uses_tls_and_authentication() {
    let Ok(url) = std::env::var("RED_ROUTER_TEST_REDDB_TLS_URL") else {
        return;
    };
    assert_eq!(
        std::env::var("RED_ROUTER_TEST_DISPOSABLE").as_deref(),
        Ok("1")
    );
    let parsed = Url::parse(&url).unwrap();
    let ca = parsed
        .query_pairs()
        .find(|(key, _)| key == "ca")
        .unwrap()
        .1
        .into_owned();
    let password = percent_encoding::percent_decode_str(parsed.password().unwrap())
        .decode_utf8()
        .unwrap()
        .into_owned();
    let options = reddb_client::redwire::ConnectOptions::new(
        parsed.host_str().unwrap(),
        parsed.port().unwrap(),
    )
    .with_auth(reddb_client::redwire::Auth::Basic {
        user: parsed.username().into(),
        pass: password,
    })
    .with_tls(
        reddb_client::redwire::TlsConfig::from_files(Some(std::path::Path::new(&ca)), None, None)
            .unwrap(),
    );
    reddb_client::redwire::RedWireClient::connect(options)
        .await
        .expect("synthetic authenticated TLS RedWire connection")
        .close()
        .await
        .unwrap();
    let mut wrong = parsed;
    wrong.set_password(Some("wrong-test-password")).unwrap();
    assert!(Database::connect(Backend::ReddbRemote, wrong.as_str())
        .await
        .is_err());
    exercise(Backend::ReddbRemote, &url).await;
}

#[tokio::test]
async fn unavailable_or_mismatched_database_never_falls_back() {
    assert!(Database::connect(
        Backend::Sqlite,
        "postgresql://secret:private@127.0.0.1/test"
    )
    .await
    .is_err());
    let error = match Database::connect(
        Backend::Postgres,
        "postgresql://secret:private@127.0.0.1:1/test",
    )
    .await
    {
        Ok(_) => panic!("expected connection failure"),
        Err(error) => error,
    };
    assert!(!error.contains("private"));
    for url in [
        "red://alice:private@127.0.0.1:1?token=second-secret",
        "red://127.0.0.1:1?ca=/tmp/fixture.pem",
        "red://127.0.0.1:1?unexpected=secret",
    ] {
        let error = match Database::connect(Backend::ReddbRemote, url).await {
            Ok(_) => panic!("expected invalid connection options"),
            Err(error) => error,
        };
        assert!(!error.contains("private") && !error.contains("secret"));
    }
}
