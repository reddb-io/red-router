use crate::storage::{Database, StoredAuditOutboxEvent, StoredUsageExportEvent};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, env, sync::Arc, time::Duration};
use tokio::sync::Mutex;
use zeroize::Zeroizing;

const BIGQUERY_SCOPE: &str = "https://www.googleapis.com/auth/bigquery";
const BIGQUERY_API: &str = "https://bigquery.googleapis.com/bigquery/v2/";
const GOOGLE_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_BATCH_BYTES: usize = 9 * 1024 * 1024;
const MAX_BATCH_ROWS: usize = 500;
const MAX_ATTEMPTS: usize = 3;
const LEASE_MS: i64 = 120_000;

#[derive(Clone)]
pub struct BigQueryAuditConfig {
    pub sink_id: String,
    pub project_id: String,
    pub dataset_id: String,
    pub table_id: String,
    pub service_account_json: Zeroizing<String>,
    pub batch_size: usize,
    pub interval: Duration,
    pub tenant_id: Option<String>,
    pub api_key_ids: Vec<String>,
}

#[derive(Deserialize)]
struct RawServiceAccountKey {
    #[serde(default)]
    r#type: String,
    client_email: String,
    private_key: String,
    #[serde(default = "default_token_uri")]
    token_uri: String,
}

struct ServiceAccountKey {
    client_email: String,
    private_key: Zeroizing<String>,
}

#[derive(Serialize)]
struct ServiceAccountClaims<'a> {
    iss: &'a str,
    scope: &'static str,
    aud: &'a str,
    iat: i64,
    exp: i64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default = "default_token_ttl")]
    expires_in: i64,
}

struct CachedToken {
    value: Zeroizing<String>,
    expires_at_unix_ms: i64,
}

pub struct BigQueryAuditSink {
    config: BigQueryAuditConfig,
    key: ServiceAccountKey,
    client: Client,
    token: Mutex<Option<CachedToken>>,
    api_base: Url,
    token_uri: Url,
}

impl BigQueryAuditConfig {
    pub fn from_env() -> Result<Option<Self>, &'static str> {
        let project_id = match env::var("RED_ROUTER_AUDIT_BIGQUERY_PROJECT_ID") {
            Ok(value) => value,
            Err(env::VarError::NotPresent) => return Ok(None),
            Err(_) => return Err("BigQuery project ID must be valid Unicode"),
        };
        let required =
            |name| env::var(name).map_err(|_| "BigQuery audit configuration is incomplete");
        let batch_size = env::var("RED_ROUTER_AUDIT_BIGQUERY_BATCH_SIZE")
            .ok()
            .map(|value| value.parse::<usize>())
            .transpose()
            .map_err(|_| "BigQuery audit batch size is invalid")?
            .unwrap_or(MAX_BATCH_ROWS);
        let interval_seconds = env::var("RED_ROUTER_AUDIT_BIGQUERY_INTERVAL_SECONDS")
            .ok()
            .map(|value| value.parse::<u64>())
            .transpose()
            .map_err(|_| "BigQuery audit interval is invalid")?
            .unwrap_or(10);
        let config = Self {
            sink_id: env::var("RED_ROUTER_AUDIT_BIGQUERY_SINK_ID")
                .unwrap_or_else(|_| "bigquery".to_owned()),
            project_id,
            dataset_id: required("RED_ROUTER_AUDIT_BIGQUERY_DATASET_ID")?,
            table_id: required("RED_ROUTER_AUDIT_BIGQUERY_TABLE_ID")?,
            service_account_json: Zeroizing::new(required(
                "RED_ROUTER_AUDIT_BIGQUERY_SERVICE_ACCOUNT_JSON",
            )?),
            batch_size,
            interval: Duration::from_secs(interval_seconds),
            tenant_id: None,
            api_key_ids: Vec::new(),
        };
        config.validate()?;
        Ok(Some(config))
    }

    fn usage_from_env() -> Result<Option<Self>, &'static str> {
        let project_id = match env::var("RED_ROUTER_USAGE_BIGQUERY_PROJECT_ID") {
            Ok(value) => value,
            Err(env::VarError::NotPresent) => return Ok(None),
            Err(_) => return Err("BigQuery usage project ID must be valid Unicode"),
        };
        let required =
            |name| env::var(name).map_err(|_| "BigQuery usage configuration is incomplete");
        let batch_size = env::var("RED_ROUTER_USAGE_BIGQUERY_BATCH_SIZE")
            .ok()
            .map(|value| value.parse::<usize>())
            .transpose()
            .map_err(|_| "BigQuery usage batch size is invalid")?
            .unwrap_or(MAX_BATCH_ROWS);
        let interval_seconds = env::var("RED_ROUTER_USAGE_BIGQUERY_INTERVAL_SECONDS")
            .ok()
            .map(|value| value.parse::<u64>())
            .transpose()
            .map_err(|_| "BigQuery usage interval is invalid")?
            .unwrap_or(10);
        let config = Self {
            sink_id: env::var("RED_ROUTER_USAGE_BIGQUERY_SINK_ID")
                .unwrap_or_else(|_| "bigquery-usage".to_owned()),
            project_id,
            dataset_id: required("RED_ROUTER_USAGE_BIGQUERY_DATASET_ID")?,
            table_id: required("RED_ROUTER_USAGE_BIGQUERY_TABLE_ID")?,
            service_account_json: Zeroizing::new(required(
                "RED_ROUTER_USAGE_BIGQUERY_SERVICE_ACCOUNT_JSON",
            )?),
            batch_size,
            interval: Duration::from_secs(interval_seconds),
            tenant_id: None,
            api_key_ids: Vec::new(),
        };
        config.validate()?;
        Ok(Some(config))
    }

    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        validate_sink_id(&self.sink_id)?;
        validate_project_id(&self.project_id)?;
        validate_bigquery_name(&self.dataset_id)?;
        validate_bigquery_name(&self.table_id)?;
        if !(1..=MAX_BATCH_ROWS).contains(&self.batch_size) {
            return Err("BigQuery audit batch size must be 1-500");
        }
        if !(1..=3_600).contains(&self.interval.as_secs()) {
            return Err("BigQuery audit interval must be 1-3600 seconds");
        }
        if self.service_account_json.len() > 128 * 1024 {
            return Err("BigQuery service account JSON is too large");
        }
        if self.api_key_ids.len() > 200
            || self
                .api_key_ids
                .iter()
                .any(|value| value.is_empty() || value.len() > 200)
        {
            return Err("BigQuery usage key filter is invalid");
        }
        Ok(())
    }
}

impl BigQueryAuditSink {
    pub fn new(config: BigQueryAuditConfig) -> Result<Self, &'static str> {
        config.validate()?;
        let raw: RawServiceAccountKey = serde_json::from_str(config.service_account_json.as_str())
            .map_err(|_| "BigQuery service account JSON is invalid")?;
        if !raw.r#type.is_empty() && raw.r#type != "service_account" {
            return Err("BigQuery credential must be a service account");
        }
        if raw.client_email.is_empty() || raw.client_email.len() > 320 {
            return Err("BigQuery service account email is invalid");
        }
        let encoded_private_key = Zeroizing::new(raw.private_key);
        let private_key = Zeroizing::new(encoded_private_key.replace("\\n", "\n"));
        if private_key.len() > 64 * 1024 {
            return Err("BigQuery private key is too large");
        }
        let token_uri = Url::parse(&raw.token_uri).map_err(|_| "BigQuery token URI is invalid")?;
        if token_uri.as_str() != GOOGLE_TOKEN_URI {
            return Err("BigQuery token URI is not allowed");
        }
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "cannot initialize BigQuery audit client")?;
        Ok(Self {
            config,
            key: ServiceAccountKey {
                client_email: raw.client_email,
                private_key,
            },
            client,
            token: Mutex::new(None),
            api_base: Url::parse(BIGQUERY_API).map_err(|_| "BigQuery API URL is invalid")?,
            token_uri,
        })
    }

    async fn access_token(&self, now_unix_ms: i64) -> Result<Zeroizing<String>, &'static str> {
        let mut cached = self.token.lock().await;
        if let Some(token) = cached.as_ref() {
            if token.expires_at_unix_ms.saturating_sub(60_000) > now_unix_ms {
                return Ok(token.value.clone());
            }
        }
        let now_seconds = now_unix_ms / 1_000;
        let claims = ServiceAccountClaims {
            iss: &self.key.client_email,
            scope: BIGQUERY_SCOPE,
            aud: self.token_uri.as_str(),
            iat: now_seconds,
            exp: now_seconds.saturating_add(3_600),
        };
        let key = EncodingKey::from_rsa_pem(self.key.private_key.as_bytes())
            .map_err(|_| "BigQuery private key is invalid")?;
        let assertion = Zeroizing::new(
            encode(&Header::new(Algorithm::RS256), &claims, &key)
                .map_err(|_| "cannot sign BigQuery service account assertion")?,
        );
        let form = {
            let mut serializer = url::form_urlencoded::Serializer::new(String::new());
            serializer.append_pair("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
            serializer.append_pair("assertion", assertion.as_str());
            serializer.finish()
        };
        let response = self
            .client
            .post(self.token_uri.clone())
            .header("content-type", "application/x-www-form-urlencoded")
            .body(form)
            .send()
            .await
            .map_err(|_| "BigQuery token exchange unavailable")?;
        if !response.status().is_success() {
            return Err("BigQuery token exchange rejected");
        }
        let body = response
            .bytes()
            .await
            .map_err(|_| "cannot read BigQuery token response")?;
        if body.len() > MAX_RESPONSE_BYTES {
            return Err("BigQuery token response is too large");
        }
        let response: TokenResponse =
            serde_json::from_slice(&body).map_err(|_| "BigQuery token response is invalid")?;
        if response.access_token.is_empty() || response.access_token.len() > 16 * 1024 {
            return Err("BigQuery access token is invalid");
        }
        let ttl_ms = response.expires_in.clamp(60, 3_600).saturating_mul(1_000);
        let value = Zeroizing::new(response.access_token);
        *cached = Some(CachedToken {
            value: value.clone(),
            expires_at_unix_ms: now_unix_ms.saturating_add(ttl_ms),
        });
        Ok(value)
    }

    pub async fn send(&self, events: &[StoredAuditOutboxEvent]) -> Result<(), &'static str> {
        if events.is_empty() {
            return Ok(());
        }
        let chunks = bigquery_chunks(events)?;
        for chunk in chunks {
            self.send_chunk(&chunk).await?;
        }
        Ok(())
    }

    pub async fn send_usage(&self, events: &[StoredUsageExportEvent]) -> Result<(), &'static str> {
        if events.is_empty() {
            return Ok(());
        }
        let chunks = bigquery_usage_chunks(events)?;
        for chunk in chunks {
            self.send_body(bigquery_usage_request(&chunk)?).await?;
        }
        Ok(())
    }

    async fn send_chunk(&self, events: &[&StoredAuditOutboxEvent]) -> Result<(), &'static str> {
        self.send_body(bigquery_request(events)?).await
    }

    async fn send_body(&self, body: Vec<u8>) -> Result<(), &'static str> {
        let now = unix_time_ms()?;
        let mut token = self.access_token(now).await?;
        let mut refreshed_auth = false;
        let path = format!(
            "projects/{}/datasets/{}/tables/{}/insertAll",
            self.config.project_id, self.config.dataset_id, self.config.table_id
        );
        let endpoint = self
            .api_base
            .join(&path)
            .map_err(|_| "BigQuery table URL is invalid")?;
        for attempt in 0..MAX_ATTEMPTS {
            let response = self
                .client
                .post(endpoint.clone())
                .bearer_auth(token.as_str())
                .header("content-type", "application/json")
                .body(body.clone())
                .send()
                .await;
            match response {
                Ok(response) => {
                    let status = response.status();
                    let bytes = response
                        .bytes()
                        .await
                        .map_err(|_| "cannot read BigQuery insert response")?;
                    if bytes.len() > MAX_RESPONSE_BYTES {
                        return Err("BigQuery insert response is too large");
                    }
                    if status.is_success() {
                        let value: serde_json::Value = serde_json::from_slice(&bytes)
                            .map_err(|_| "BigQuery insert response is invalid")?;
                        if value
                            .get("insertErrors")
                            .and_then(serde_json::Value::as_array)
                            .is_some_and(|errors| !errors.is_empty())
                        {
                            return Err("BigQuery rejected part of the export batch");
                        }
                        return Ok(());
                    }
                    if status == StatusCode::UNAUTHORIZED && !refreshed_auth {
                        *self.token.lock().await = None;
                        token = self.access_token(unix_time_ms()?).await?;
                        refreshed_auth = true;
                        continue;
                    }
                    if !retryable_status(status) || attempt + 1 == MAX_ATTEMPTS {
                        return Err("BigQuery rejected the export batch");
                    }
                }
                Err(_) if attempt + 1 == MAX_ATTEMPTS => {
                    return Err("BigQuery export transport unavailable")
                }
                Err(_) => {}
            }
            tokio::time::sleep(Duration::from_millis(500_u64 << attempt)).await;
        }
        Err("BigQuery export transport unavailable")
    }
}

pub async fn spawn_from_env(database: &Arc<Database>) -> Result<bool, &'static str> {
    let audit_config = BigQueryAuditConfig::from_env()?;
    let usage_config = BigQueryAuditConfig::usage_from_env()?;
    if audit_config.is_none() && usage_config.is_none() {
        return Ok(false);
    }
    if let (Some(audit), Some(usage)) = (&audit_config, &usage_config) {
        if audit.sink_id == usage.sink_id {
            return Err("BigQuery audit and usage sink IDs must be distinct");
        }
        if audit.project_id == usage.project_id
            && audit.dataset_id == usage.dataset_id
            && audit.table_id == usage.table_id
        {
            return Err("BigQuery audit and usage tables must be distinct");
        }
    }
    if !database.supports_audit_sink_leases() {
        return Err("BigQuery export relay requires SQLite or PostgreSQL");
    }
    if usage_config.is_some() {
        database.usage_export_events(0, "", 1).await?;
    }
    if let Some(config) = audit_config {
        spawn_audit(database, config)?;
    }
    let usage_enabled = usage_config.is_some();
    if let Some(config) = usage_config {
        spawn_usage(database, config)?;
    }
    Ok(usage_enabled)
}

/// Watches Rust-owned usage destinations and starts one revision-bound relay per enabled sink.
/// A relay exits before its next delivery as soon as its record is edited, disabled, or deleted.
pub fn spawn_persisted_usage(
    database: &Arc<Database>,
    encryption_key: &str,
) -> Result<(), &'static str> {
    if !database.supports_audit_sink_leases() {
        return Err("managed BigQuery usage export requires SQLite or PostgreSQL");
    }
    let weak = Arc::downgrade(database);
    let encryption_key = Zeroizing::new(encryption_key.to_owned());
    tokio::spawn(async move {
        let mut revisions = HashMap::<String, i64>::new();
        let mut ticker = tokio::time::interval(Duration::from_secs(2));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let Some(database) = weak.upgrade() else {
                return;
            };
            let exports = match database.usage_exports().await {
                Ok(exports) => exports,
                Err(error) => {
                    eprintln!("Rust managed usage export refresh failed: {error}");
                    continue;
                }
            };
            for export in exports {
                if revisions.get(&export.id) == Some(&export.revision) {
                    continue;
                }
                if !export.enabled {
                    revisions.insert(export.id.clone(), export.revision);
                    continue;
                }
                let aad = format!("usage-export:{}:service-account", export.id);
                let service_account_json = match crate::control_plane::decrypt(
                    &export.service_account_ciphertext,
                    &aad,
                    encryption_key.as_str(),
                ) {
                    Ok(value) => value,
                    Err(error) => {
                        eprintln!("Rust managed usage export credential failed: {error}");
                        continue;
                    }
                };
                let api_key_ids =
                    match serde_json::from_str::<Vec<String>>(&export.api_key_ids_json) {
                        Ok(value) => value,
                        Err(_) => {
                            eprintln!("Rust managed usage export key filter is invalid");
                            continue;
                        }
                    };
                let config = BigQueryAuditConfig {
                    sink_id: format!("managed-{}", export.id),
                    project_id: export.project_id,
                    dataset_id: export.dataset_id,
                    table_id: export.table_id,
                    service_account_json,
                    batch_size: match usize::try_from(export.batch_size) {
                        Ok(value) => value,
                        Err(_) => continue,
                    },
                    interval: match u64::try_from(export.interval_seconds) {
                        Ok(value) => Duration::from_secs(value),
                        Err(_) => continue,
                    },
                    tenant_id: Some(export.tenant_id),
                    api_key_ids,
                };
                let export_id = export.id;
                let export_revision = export.revision;
                match spawn_managed_usage(&database, config, export_id.clone(), export_revision) {
                    Ok(()) => {
                        revisions.insert(export_id, export_revision);
                    }
                    Err(error) => {
                        eprintln!("Rust managed usage export start failed: {error}");
                    }
                }
            }
        }
    });
    Ok(())
}

fn spawn_managed_usage(
    database: &Arc<Database>,
    config: BigQueryAuditConfig,
    record_id: String,
    revision: i64,
) -> Result<(), &'static str> {
    let sink = Arc::new(BigQueryAuditSink::new(config.clone())?);
    let weak = Arc::downgrade(database);
    let owner = random_owner()?;
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(config.interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let Some(database) = weak.upgrade() else {
                return;
            };
            let current = database
                .usage_exports()
                .await
                .ok()
                .and_then(|exports| exports.into_iter().find(|item| item.id == record_id));
            if !current.is_some_and(|item| item.enabled && item.revision == revision) {
                return;
            }
            if let Err(error) = drain_usage_once(&database, &sink, &owner).await {
                eprintln!("Rust managed usage export failed: {error}");
            }
        }
    });
    Ok(())
}

fn spawn_audit(database: &Arc<Database>, config: BigQueryAuditConfig) -> Result<(), &'static str> {
    let sink = Arc::new(BigQueryAuditSink::new(config.clone())?);
    let weak = Arc::downgrade(database);
    let owner = random_owner()?;
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(config.interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let Some(database) = weak.upgrade() else {
                return;
            };
            if let Err(error) = drain_once(&database, &sink, &owner).await {
                eprintln!("Rust audit export failed: {error}");
            }
        }
    });
    Ok(())
}

fn spawn_usage(database: &Arc<Database>, config: BigQueryAuditConfig) -> Result<(), &'static str> {
    let sink = Arc::new(BigQueryAuditSink::new(config.clone())?);
    let weak = Arc::downgrade(database);
    let owner = random_owner()?;
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(config.interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let Some(database) = weak.upgrade() else {
                return;
            };
            if let Err(error) = drain_usage_once(&database, &sink, &owner).await {
                eprintln!("Rust usage export failed: {error}");
            }
        }
    });
    Ok(())
}

async fn drain_once(
    database: &Database,
    sink: &BigQueryAuditSink,
    owner: &str,
) -> Result<(), &'static str> {
    let now = unix_time_ms()?;
    if !database
        .acquire_audit_sink_lease(
            &sink.config.sink_id,
            owner,
            now,
            now.saturating_add(LEASE_MS),
        )
        .await?
    {
        return Ok(());
    }
    let result = async {
        let cursor = database.audit_sink_cursor(&sink.config.sink_id).await?;
        let (created_at, event_id) = cursor
            .as_ref()
            .map(|cursor| {
                (
                    cursor.cursor_created_at_unix_ms,
                    cursor.cursor_event_id.as_str(),
                )
            })
            .unwrap_or((0, ""));
        let events = database
            .audit_outbox_events(created_at, event_id, sink.config.batch_size)
            .await?;
        if let Some(last) = events.last() {
            sink.send(&events).await?;
            database
                .advance_audit_sink_cursor(&sink.config.sink_id, owner, last, unix_time_ms()?)
                .await?;
        }
        Ok(())
    }
    .await;
    let _ = database
        .release_audit_sink_lease(&sink.config.sink_id, owner, unix_time_ms().unwrap_or(now))
        .await;
    result
}

async fn drain_usage_once(
    database: &Database,
    sink: &BigQueryAuditSink,
    owner: &str,
) -> Result<(), &'static str> {
    let now = unix_time_ms()?;
    if !database
        .acquire_audit_sink_lease(
            &sink.config.sink_id,
            owner,
            now,
            now.saturating_add(LEASE_MS),
        )
        .await?
    {
        return Ok(());
    }
    let result = async {
        let cursor = database.audit_sink_cursor(&sink.config.sink_id).await?;
        let (created_at, event_id) = cursor
            .as_ref()
            .map(|cursor| {
                (
                    cursor.cursor_created_at_unix_ms,
                    cursor.cursor_event_id.as_str(),
                )
            })
            .unwrap_or((0, ""));
        let events = database
            .usage_export_events(created_at, event_id, sink.config.batch_size)
            .await?;
        if let Some(last) = events.last() {
            let selected = events
                .iter()
                .filter(|event| usage_event_selected(&sink.config, event))
                .cloned()
                .collect::<Vec<_>>();
            sink.send_usage(&selected).await?;
            database
                .advance_sink_cursor_position(
                    &sink.config.sink_id,
                    owner,
                    last.created_at_unix_ms,
                    &last.event_id,
                    unix_time_ms()?,
                )
                .await?;
        }
        Ok(())
    }
    .await;
    let _ = database
        .release_audit_sink_lease(&sink.config.sink_id, owner, unix_time_ms().unwrap_or(now))
        .await;
    result
}

fn usage_event_selected(config: &BigQueryAuditConfig, event: &StoredUsageExportEvent) -> bool {
    config
        .tenant_id
        .as_ref()
        .is_none_or(|tenant| event.tenant_id == *tenant)
        && (config.api_key_ids.is_empty() || config.api_key_ids.contains(&event.key_id))
}

fn bigquery_chunks(
    events: &[StoredAuditOutboxEvent],
) -> Result<Vec<Vec<&StoredAuditOutboxEvent>>, &'static str> {
    let mut chunks = Vec::new();
    let mut current = Vec::new();
    let mut bytes = 0_usize;
    for event in events {
        let row_bytes = bigquery_row(event)?.len();
        if row_bytes > MAX_BATCH_BYTES {
            return Err("audit outbox event is too large for BigQuery");
        }
        if !current.is_empty()
            && (current.len() == MAX_BATCH_ROWS
                || bytes.saturating_add(row_bytes) > MAX_BATCH_BYTES)
        {
            chunks.push(current);
            current = Vec::new();
            bytes = 0;
        }
        current.push(event);
        bytes = bytes.saturating_add(row_bytes);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    Ok(chunks)
}

fn bigquery_request(events: &[&StoredAuditOutboxEvent]) -> Result<Vec<u8>, &'static str> {
    let rows = events
        .iter()
        .map(|event| {
            let payload: serde_json::Value = serde_json::from_str(&event.payload_json)
                .map_err(|_| "audit outbox payload is invalid")?;
            Ok(serde_json::json!({
                "insertId": event.event_id,
                "json": {
                    "event_id": event.event_id,
                    "created_at_unix_ms": event.created_at_unix_ms,
                    "tenant_id": event.tenant_id,
                    "topic": event.topic,
                    "schema_version": event.schema_version,
                    "payload_json": payload.to_string()
                }
            }))
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    serde_json::to_vec(&serde_json::json!({
        "kind": "bigquery#tableDataInsertAllRequest",
        "skipInvalidRows": false,
        "ignoreUnknownValues": false,
        "rows": rows
    }))
    .map_err(|_| "cannot encode BigQuery audit batch")
}

fn bigquery_usage_chunks(
    events: &[StoredUsageExportEvent],
) -> Result<Vec<Vec<&StoredUsageExportEvent>>, &'static str> {
    let mut chunks = Vec::new();
    let mut current = Vec::new();
    let mut bytes = 0_usize;
    for event in events {
        let row_bytes = bigquery_usage_request(&[event])?.len();
        if row_bytes > MAX_BATCH_BYTES {
            return Err("usage event is too large for BigQuery");
        }
        if !current.is_empty()
            && (current.len() == MAX_BATCH_ROWS
                || bytes.saturating_add(row_bytes) > MAX_BATCH_BYTES)
        {
            chunks.push(current);
            current = Vec::new();
            bytes = 0;
        }
        current.push(event);
        bytes = bytes.saturating_add(row_bytes);
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    Ok(chunks)
}

fn bigquery_usage_request(events: &[&StoredUsageExportEvent]) -> Result<Vec<u8>, &'static str> {
    let rows = events
        .iter()
        .map(|event| {
            let tokens_total = event
                .tokens_input
                .checked_add(event.tokens_output)
                .and_then(|value| value.checked_add(event.tokens_reasoning))
                .ok_or("usage token total overflow")?;
            let pricing_snapshot_json = event
                .pricing_snapshot
                .as_deref()
                .map(|snapshot| {
                    serde_json::from_str::<serde_json::Value>(snapshot)
                        .map(|value| value.to_string())
                        .map_err(|_| "usage pricing snapshot is invalid")
                })
                .transpose()?;
            Ok(serde_json::json!({
                "insertId": event.event_id,
                "json": {
                    "event_id": event.event_id,
                    "created_at_unix_ms": event.created_at_unix_ms,
                    "tenant_id": event.tenant_id,
                    "api_key_id": event.key_id,
                    "api_key_name": event.key_name,
                    "provider": event.provider,
                    "model": event.model,
                    "tokens_input": event.tokens_input,
                    "tokens_output": event.tokens_output,
                    "tokens_cache_read": event.tokens_cache_read,
                    "tokens_cache_creation": event.tokens_cache_creation,
                    "tokens_reasoning": event.tokens_reasoning,
                    "tokens_total": tokens_total,
                    "amount_microusd": event.amount_microusd,
                    "amount_usd": event.amount_microusd as f64 / 1_000_000.0,
                    "pricing_known": event.pricing_known,
                    "pricing_snapshot_json": pricing_snapshot_json
                }
            }))
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    serde_json::to_vec(&serde_json::json!({
        "kind": "bigquery#tableDataInsertAllRequest",
        "skipInvalidRows": false,
        "ignoreUnknownValues": false,
        "rows": rows
    }))
    .map_err(|_| "cannot encode BigQuery usage batch")
}

fn bigquery_row(event: &StoredAuditOutboxEvent) -> Result<Vec<u8>, &'static str> {
    bigquery_request(&[event])
}

fn retryable_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 429 | 500 | 502 | 503 | 504)
}

fn validate_sink_id(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err("BigQuery audit sink ID is invalid");
    }
    Ok(())
}

fn validate_project_id(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 200
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b':' | b'.'))
    {
        return Err("BigQuery project ID is invalid");
    }
    Ok(())
}

fn validate_bigquery_name(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() > 1_024
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err("BigQuery dataset or table ID is invalid");
    }
    Ok(())
}

fn unix_time_ms() -> Result<i64, &'static str> {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "system clock is before Unix epoch")?;
    i64::try_from(elapsed.as_millis()).map_err(|_| "system clock is out of range")
}

fn random_owner() -> Result<String, &'static str> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "cannot generate audit sink owner")?;
    Ok(hex::encode(bytes))
}

fn default_token_uri() -> String {
    GOOGLE_TOKEN_URI.to_owned()
}

fn default_token_ttl() -> i64 {
    3_600
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(id: &str, payload_size: usize) -> StoredAuditOutboxEvent {
        StoredAuditOutboxEvent {
            event_id: id.to_owned(),
            created_at_unix_ms: 1,
            tenant_id: "red".to_owned(),
            topic: "redrouter.audit.v1".to_owned(),
            schema_version: 1,
            payload_json: serde_json::json!({"value":"x".repeat(payload_size)}).to_string(),
        }
    }

    fn usage_event(id: &str) -> StoredUsageExportEvent {
        StoredUsageExportEvent {
            event_id: id.to_owned(),
            created_at_unix_ms: 1_700_000_000_000,
            tenant_id: "red".to_owned(),
            key_id: "agent-key".to_owned(),
            key_name: "Agent fleet".to_owned(),
            provider: "openrouter".to_owned(),
            model: "openai/gpt-5".to_owned(),
            tokens_input: 100,
            tokens_output: 40,
            tokens_cache_read: 20,
            tokens_cache_creation: 5,
            tokens_reasoning: 10,
            amount_microusd: 1234,
            pricing_known: true,
            pricing_snapshot: Some(r#"{"source":"models.dev"}"#.to_owned()),
        }
    }

    #[test]
    fn bigquery_rows_preserve_stable_insert_ids() {
        let first = event("audit-one", 16);
        let encoded = bigquery_request(&[&first]).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(value["rows"][0]["insertId"], "audit-one");
        assert_eq!(value["rows"][0]["json"]["schema_version"], 1);
        assert!(value["rows"][0]["json"]["payload_json"]
            .as_str()
            .unwrap()
            .contains("value"));
    }

    #[test]
    fn bigquery_chunks_are_bounded_by_row_count() {
        let events = (0..501)
            .map(|index| event(&format!("audit-{index}"), 8))
            .collect::<Vec<_>>();
        let chunks = bigquery_chunks(&events).unwrap();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), 500);
        assert_eq!(chunks[1].len(), 1);
    }

    #[test]
    fn bigquery_identifiers_are_strict() {
        assert!(validate_project_id("red-router-prod").is_ok());
        assert!(validate_bigquery_name("audit_events_2026").is_ok());
        assert!(validate_bigquery_name("audit/events").is_err());
        assert!(validate_sink_id("bigquery.prod").is_ok());
        assert!(validate_sink_id("../../escape").is_err());
    }

    #[test]
    fn usage_rows_include_attribution_without_api_key_secrets() {
        let event = usage_event("usage-one");
        let encoded = bigquery_usage_request(&[&event]).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        let row = &value["rows"][0];
        assert_eq!(row["insertId"], "usage-one");
        assert_eq!(row["json"]["api_key_id"], "agent-key");
        assert_eq!(row["json"]["api_key_name"], "Agent fleet");
        assert_eq!(row["json"]["provider"], "openrouter");
        assert_eq!(row["json"]["model"], "openai/gpt-5");
        assert_eq!(row["json"]["tokens_total"], 150);
        assert_eq!(row["json"]["amount_microusd"], 1234);
        assert!(row["json"].get("api_key").is_none());
    }

    #[test]
    fn managed_usage_filters_never_cross_tenant_or_key_scope() {
        let config = BigQueryAuditConfig {
            sink_id: "managed-report".to_owned(),
            project_id: "red-router-prod".to_owned(),
            dataset_id: "billing".to_owned(),
            table_id: "usage".to_owned(),
            service_account_json: Zeroizing::new("{}".to_owned()),
            batch_size: 100,
            interval: Duration::from_secs(10),
            tenant_id: Some("red".to_owned()),
            api_key_ids: vec!["agent-key".to_owned()],
        };
        let allowed = usage_event("allowed");
        assert!(usage_event_selected(&config, &allowed));
        let mut other_tenant = allowed.clone();
        other_tenant.tenant_id = "other".to_owned();
        assert!(!usage_event_selected(&config, &other_tenant));
        let mut other_key = allowed;
        other_key.key_id = "other-key".to_owned();
        assert!(!usage_event_selected(&config, &other_key));
    }
}
