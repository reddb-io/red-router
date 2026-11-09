use red_routerd::storage::{
    Backend, Database, StoredAuditEvent, StoredAuditOutboxEvent, StoredAvailability, StoredBreaker,
    StoredClientKey, StoredCombo, StoredIdentityBinding, StoredModelCatalogSnapshot,
    StoredOidcBrowserConfig, StoredOidcConfig, StoredProvider, StoredProviderQuota,
    StoredResilience, StoredRoutePin, StoredTenant,
};
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use tempfile::TempDir;
use url::Url;

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
        id: "first".into(),
        tenant_id: "red".into(),
        provider: "openai".into(),
        upstream_url: "https://first.example/v1/chat/completions".into(),
        credential_ciphertext: "encrypted-first".into(),
        enabled: true,
        updated_at: 1,
    };
    let mut second = StoredProvider {
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
    reopened.delete_route_pin("agent-combo").await.unwrap();
    assert!(reopened.route_pins().await.unwrap().is_empty());
    assert_eq!(reopened.provider_quotas().await.unwrap(), vec![quota]);
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
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT event_id, pricing_snapshot FROM redrouter_usage_ledger ORDER BY event_id",
    )
    .fetch_all(&mut raw)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            (
                "priced".into(),
                Some(r#"{"source":"legacy","available":false}"#.into()),
            ),
            ("unpriced".into(), None),
        ]
    );
    raw.close().await.unwrap();
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
    remote(Backend::Postgres, "RED_ROUTER_TEST_POSTGRES_URL").await;
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
