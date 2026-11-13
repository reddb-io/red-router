//! Provider request headers, inherited from upstreamHeaders.ts and the compatible executor.
//! Values are write-only and encrypted; endpoint changes detach the old map.
use super::*;
use crate::storage::{StoredProviderHeaders, StoredProviderNode, StoredProviderNodeHeaders};
use axum::http::HeaderName;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderHeadersInput {
    headers: BTreeMap<String, String>,
}

impl Drop for ProviderHeadersInput {
    fn drop(&mut self) {
        for value in self.headers.values_mut() {
            value.zeroize();
        }
    }
}

#[derive(Serialize)]
struct HeadersView {
    names: Vec<String>,
    attached: bool,
    revision: Option<String>,
}

fn identity(provider: &StoredProvider) -> String {
    let mut digest = Sha256::new();
    for value in [
        &provider.id,
        &provider.tenant_id,
        &provider.provider,
        &provider.upstream_url,
    ] {
        signature_text(&mut digest, value);
    }
    // Preserve the identity of existing auto-detected connections during upgrade.
    if provider.protocol != "auto" {
        signature_text(&mut digest, "protocol");
        signature_text(&mut digest, &provider.protocol);
    }
    hex::encode(digest.finalize())
}

fn validate(values: &BTreeMap<String, String>) -> Result<HeaderMap, &'static str> {
    if values.len() > 16 {
        return Err("at most 16 custom headers are allowed");
    }
    let mut headers = HeaderMap::new();
    for (name, value) in values {
        if name.len() > 128 || value.len() > 4096 || value.bytes().any(|b| b.is_ascii_control()) {
            return Err("invalid custom header size or control character");
        }
        let name =
            HeaderName::from_bytes(name.as_bytes()).map_err(|_| "invalid custom header name")?;
        if matches!(
            name.as_str(),
            "host"
                | "connection"
                | "content-length"
                | "keep-alive"
                | "proxy-connection"
                | "proxy-authenticate"
                | "proxy-authorization"
                | "transfer-encoding"
                | "te"
                | "trailer"
                | "upgrade"
                | "x-forwarded-for"
                | "x-forwarded-host"
                | "x-forwarded-proto"
                | "x-forwarded-port"
                | "x-forwarded-server"
                | "x-real-ip"
                | "cf-connecting-ip"
                | "true-client-ip"
                | "client-ip"
                | "forwarded"
                | "via"
                | "authorization"
                | "x-api-key"
                | "x-goog-api-key"
                | "api-key"
                | "cookie"
        ) {
            return Err("custom headers cannot override authentication, framing or forwarding");
        }
        let mut value = HeaderValue::from_str(value).map_err(|_| "invalid custom header value")?;
        value.set_sensitive(true);
        if headers.insert(name, value).is_some() {
            return Err("duplicate custom header name");
        }
    }
    Ok(headers)
}

impl ControlPlane {
    async fn header_provider(
        &self,
        id: &str,
        tenant: Option<&str>,
    ) -> Result<StoredProvider, &'static str> {
        validate_id(id)?;
        self.0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|p| p.id == id && tenant.is_none_or(|t| t == p.tenant_id))
            .ok_or("provider does not exist")
    }

    async fn header_view(&self, provider: &StoredProvider) -> Result<HeadersView, &'static str> {
        let entry = self
            .0
            .database
            .provider_headers()
            .await?
            .into_iter()
            .find(|r| r.provider_id == provider.id);
        let Some(entry) = entry else {
            return Ok(HeadersView {
                names: vec![],
                attached: true,
                revision: None,
            });
        };
        let aad = format!(
            "{}:request-headers:{}",
            provider.id, entry.upstream_identity
        );
        let plaintext = decrypt_async(
            &entry.headers_ciphertext,
            &aad,
            self.0.encryption_key.as_str(),
        )
        .await?;
        let headers = decoded_values(&plaintext)?;
        let mut names: Vec<_> = headers.keys().map(|n| n.as_str().to_owned()).collect();
        names.sort();
        Ok(HeadersView {
            names,
            attached: entry.upstream_identity == identity(provider),
            revision: Some(entry.revision.to_string()),
        })
    }

    async fn account_request_headers(
        &self,
        provider: &StoredProvider,
    ) -> Result<HeaderMap, &'static str> {
        let Some(entry) = self
            .0
            .database
            .provider_headers()
            .await?
            .into_iter()
            .find(|r| r.provider_id == provider.id && r.upstream_identity == identity(provider))
        else {
            return Ok(HeaderMap::new());
        };
        // CLI/OAuth transports own their identity headers. These maps are for API credentials.
        if self
            .0
            .database
            .provider_oauth()
            .await?
            .iter()
            .any(|o| o.provider_id == provider.id)
        {
            return Ok(HeaderMap::new());
        }
        let aad = format!(
            "{}:request-headers:{}",
            provider.id, entry.upstream_identity
        );
        let plaintext = decrypt_async(
            &entry.headers_ciphertext,
            &aad,
            self.0.encryption_key.as_str(),
        )
        .await?;
        decoded_values(&plaintext)
    }
}

fn definition_subject(node: &StoredProviderNode) -> StoredProvider {
    StoredProvider {
        id: format!("node:{}:{}", node.tenant_id, node.id),
        tenant_id: node.tenant_id.clone(),
        provider: node.prefix.clone(),
        protocol: node.protocol.clone(),
        priority: 0,
        upstream_url: node.upstream_url.clone(),
        credential_ciphertext: String::new(),
        enabled: true,
        updated_at: node.revision,
        node_id: None,
    }
}

pub(crate) async fn encrypt_definition_headers(
    node: &StoredProviderNode,
    values: &BTreeMap<String, String>,
    encryption_key: &str,
) -> Result<Option<StoredProviderNodeHeaders>, &'static str> {
    validate(values)?;
    if values.is_empty() {
        return Ok(None);
    }
    let subject = definition_subject(node);
    let upstream_identity = identity(&subject);
    let aad = format!("{}:request-headers:{upstream_identity}", subject.id);
    let plaintext =
        Zeroizing::new(serde_json::to_string(values).map_err(|_| "invalid provider headers")?);
    Ok(Some(StoredProviderNodeHeaders {
        upstream_identity,
        ciphertext: encrypt_async(&plaintext, &aad, encryption_key).await?,
        revision: node.revision,
    }))
}
fn account_definition_subject(provider: &StoredProvider, node_id: &str) -> StoredProvider {
    StoredProvider {
        id: format!("node:{}:{node_id}", provider.tenant_id),
        tenant_id: provider.tenant_id.clone(),
        provider: provider.provider.clone(),
        protocol: provider.protocol.clone(),
        priority: provider.priority,
        upstream_url: provider.upstream_url.clone(),
        credential_ciphertext: String::new(),
        enabled: true,
        updated_at: provider.updated_at,
        node_id: None,
    }
}
fn decoded_values(plaintext: &str) -> Result<HeaderMap, &'static str> {
    let mut values: BTreeMap<String, String> =
        serde_json::from_str(plaintext).map_err(|_| "invalid stored provider headers")?;
    let result = validate(&values);
    for value in values.values_mut() {
        value.zeroize();
    }
    result
}

impl ControlPlane {
    async fn header_node(
        &self,
        id: &str,
        tenant: Option<&str>,
    ) -> Result<StoredProviderNode, &'static str> {
        validate_id(id)?;
        self.0
            .database
            .provider_nodes()
            .await?
            .into_iter()
            .find(|node| node.id == id && tenant.is_none_or(|tenant| node.tenant_id == tenant))
            .ok_or("Provider definition unavailable")
    }

    async fn definition_header_view(
        &self,
        node: &StoredProviderNode,
    ) -> Result<HeadersView, &'static str> {
        let Some(config) = &node.header_config else {
            return Ok(HeadersView {
                names: vec![],
                attached: true,
                revision: None,
            });
        };
        let subject = definition_subject(node);
        let aad = format!(
            "{}:request-headers:{}",
            subject.id, config.upstream_identity
        );
        let plaintext =
            decrypt_async(&config.ciphertext, &aad, self.0.encryption_key.as_str()).await?;
        let headers = decoded_values(&plaintext)?;
        let mut names: Vec<_> = headers
            .keys()
            .map(|name| name.as_str().to_owned())
            .collect();
        names.sort();
        Ok(HeadersView {
            names,
            attached: config.upstream_identity == identity(&subject),
            revision: Some(config.revision.to_string()),
        })
    }

    pub(super) async fn request_headers(
        &self,
        provider: &StoredProvider,
    ) -> Result<HeaderMap, &'static str> {
        if provider.node_id.is_some()
            && self
                .0
                .database
                .provider_oauth()
                .await?
                .iter()
                .any(|oauth| oauth.provider_id == provider.id)
        {
            return Err("shared headers require an API credential connection");
        }
        let own = self.account_request_headers(provider).await?;
        let Some(node_id) = provider.node_id.as_deref() else {
            return Ok(own);
        };
        let node = self.provider_node(node_id, &provider.tenant_id).await?;
        let subject = account_definition_subject(provider, node_id);
        let cache_key = subject.id.clone();
        let Some(config) = &node.header_config else {
            self.0.node_header_cache.lock().await.remove(&cache_key);
            return Ok(own);
        };
        // Bind to the transport already captured for this account, not a newer
        // node snapshot that could belong to a different upstream destination.
        if config.upstream_identity != identity(&subject) {
            self.0.node_header_cache.lock().await.remove(&cache_key);
            return Ok(own);
        }
        let mut fingerprint = Sha256::new();
        signature_text(&mut fingerprint, &config.upstream_identity);
        signature_text(&mut fingerprint, &config.ciphertext);
        signature_i64(&mut fingerprint, config.revision);
        let fingerprint = hex::encode(fingerprint.finalize());
        let cached = self
            .0
            .node_header_cache
            .lock()
            .await
            .get(&cache_key)
            .filter(|(version, _)| version == &fingerprint)
            .map(|(_, headers)| headers.clone());
        let mut shared = if let Some(headers) = cached {
            headers
        } else {
            let aad = format!(
                "{}:request-headers:{}",
                subject.id, config.upstream_identity
            );
            let plaintext =
                decrypt_async(&config.ciphertext, &aad, self.0.encryption_key.as_str()).await?;
            let headers = decoded_values(&plaintext)?;
            let mut cache = self.0.node_header_cache.lock().await;
            if cache.len() >= 256 {
                cache.clear();
            }
            cache.insert(cache_key, (fingerprint, headers.clone()));
            headers
        };
        // HeaderMap keys are case-insensitive. Account values override shared defaults.
        for (name, value) in &own {
            shared.insert(name.clone(), value.clone());
        }
        Ok(shared)
    }
}

pub async fn get_node_headers(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Control plane unavailable");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    let node = match control.header_node(&id, scope.tenant_id.as_deref()).await {
        Ok(node) => node,
        Err(_) => return api_error(StatusCode::NOT_FOUND, "Provider definition unavailable"),
    };
    match control.definition_header_view(&node).await {
        Ok(view) => ([(header::CACHE_CONTROL, "no-store")], Json(view)).into_response(),
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Shared headers unavailable",
        ),
    }
}

pub async fn put_node_headers(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<ProviderHeadersInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Control plane unavailable");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    if let Err(error) = validate(&input.headers) {
        return api_error(StatusCode::BAD_REQUEST, error);
    }
    let _mutation = control.0.mutation.lock().await;
    let mut node = match control.header_node(&id, scope.tenant_id.as_deref()).await {
        Ok(node) => node,
        Err(_) => return api_error(StatusCode::NOT_FOUND, "Provider definition unavailable"),
    };
    let result: Result<HeadersView, &'static str> = async {
        let before = control.definition_header_view(&node).await?;
        let subject = definition_subject(&node);
        let expected_revision = node.revision;
        node.revision = revision()?;
        node.header_config =
            encrypt_definition_headers(&node, &input.headers, control.0.encryption_key.as_str())
                .await?;
        control
            .0
            .database
            .upsert_provider_node(&node, Some(expected_revision))
            .await?;
        control.0.node_header_cache.lock().await.remove(&subject.id);
        let after = control.definition_header_view(&node).await?;
        control
            .record_audit_event(
                AuditContext {
                    action: "provider.definition.headers.update",
                    actor: &scope.actor,
                    tenant_id: &node.tenant_id,
                    target: &node.id,
                    resource_type: "provider-definition",
                },
                Some(&before),
                Some(&after),
            )
            .await;
        if let Err(error) = control.refresh().await {
            *control.0.current.write().await = None;
            return Err(error);
        }
        if let Err(error) = control.refresh_routes().await {
            *control.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        Ok(after)
    }
    .await;
    match result {
        Ok(view) => ([(header::CACHE_CONTROL, "no-store")], Json(view)).into_response(),
        Err("Provider definition changed; reload and retry") => api_error(
            StatusCode::CONFLICT,
            "Provider definition changed; reload and retry",
        ),
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Shared headers could not be saved or activated",
        ),
    }
}

pub async fn get_headers(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Control plane unavailable");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    let provider = match control
        .header_provider(&id, scope.tenant_id.as_deref())
        .await
    {
        Ok(p) => p,
        Err(_) => return api_error(StatusCode::NOT_FOUND, "Provider unavailable"),
    };
    match control.header_view(&provider).await {
        Ok(view) => ([(header::CACHE_CONTROL, "no-store")], Json(view)).into_response(),
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider headers unavailable",
        ),
    }
}

pub async fn put_headers(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(mut input): Json<ProviderHeadersInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Control plane unavailable");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    if let Err(error) = validate(&input.headers) {
        return api_error(StatusCode::BAD_REQUEST, error);
    }
    let _mutation = control.0.mutation.lock().await;
    let provider = match control
        .header_provider(&id, scope.tenant_id.as_deref())
        .await
    {
        Ok(p) => p,
        Err(_) => return api_error(StatusCode::NOT_FOUND, "Provider unavailable"),
    };
    let result: Result<HeadersView, &'static str> = async {
        if !input.headers.is_empty()
            && control
                .0
                .database
                .provider_oauth()
                .await?
                .iter()
                .any(|o| o.provider_id == id)
        {
            return Err("custom headers require an API credential connection");
        }
        let before = control.header_view(&provider).await?;
        if input.headers.is_empty() {
            control.0.database.delete_provider_header(&id).await?;
        } else {
            let upstream_identity = identity(&provider);
            let plaintext = Zeroizing::new(
                serde_json::to_string(&input.headers).map_err(|_| "invalid provider headers")?,
            );
            let aad = format!("{id}:request-headers:{upstream_identity}");
            let entry = StoredProviderHeaders {
                provider_id: id.clone(),
                upstream_identity,
                headers_ciphertext: encrypt_async(
                    &plaintext,
                    &aad,
                    control.0.encryption_key.as_str(),
                )
                .await?,
                revision: revision()?,
            };
            control.0.database.upsert_provider_header(&entry).await?;
        }
        let after = control.header_view(&provider).await?;
        control
            .record_audit_event(
                AuditContext {
                    action: "provider.headers.update",
                    actor: &scope.actor,
                    tenant_id: &provider.tenant_id,
                    target: &id,
                    resource_type: "provider",
                },
                Some(&before),
                Some(&after),
            )
            .await;
        // Build the same runtime snapshots used by inference and combo retries.
        if let Err(error) = control.refresh().await {
            *control.0.current.write().await = None;
            return Err(error);
        }
        if let Err(error) = control.refresh_routes().await {
            *control.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        Ok(after)
    }
    .await;
    for value in input.headers.values_mut() {
        value.zeroize();
    }
    match result {
        Ok(view) => ([(header::CACHE_CONTROL, "no-store")], Json(view)).into_response(),
        Err("custom headers require an API credential connection") => api_error(
            StatusCode::BAD_REQUEST,
            "Custom headers require an API credential connection",
        ),
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider headers could not be saved or activated",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_legacy_denylist_and_rejects_duplicates_and_injection() {
        for name in [
            "Authorization",
            "HOST",
            "x-api-key",
            "x-goog-api-key",
            "api-key",
            "Cookie",
            "Proxy-Authorization",
            "Content-Length",
            "Connection",
            "X-Forwarded-For",
            "Via",
        ] {
            assert!(validate(&BTreeMap::from([(name.to_owned(), "secret".to_owned())])).is_err());
        }
        for value in ["abc\r\nAuthorization: other", "abc\0", "abc\t"] {
            assert!(
                validate(&BTreeMap::from([("x-custom".to_owned(), value.to_owned())])).is_err()
            );
        }
        assert!(validate(&BTreeMap::from([
            ("X-Custom".into(), "one".into()),
            ("x-custom".into(), "two".into())
        ]))
        .is_err());
        let headers = validate(&BTreeMap::from([
            ("HTTP-Referer".into(), "https://example.test".into()),
            ("X-Title".into(), "RedRouter".into()),
        ]))
        .unwrap();
        assert_eq!(headers["x-title"], "RedRouter");
        assert!(headers["x-title"].is_sensitive());
        assert!(validate(&(0..17).map(|i| (format!("x-{i}"), "v".into())).collect()).is_err());
    }

    #[tokio::test]
    async fn shared_header_metadata_keeps_tenant_scope_and_accepts_older_node_documents() {
        let db = Arc::new(
            crate::storage::Database::connect(crate::storage::Backend::Sqlite, "sqlite::memory:")
                .await
                .unwrap(),
        );
        let control = ControlPlane::new(
            db.clone(),
            "headers-admin-key-1234567890-abcdef",
            "headers-storage-key-1234567890",
            true,
        )
        .await
        .unwrap();
        let mut node: StoredProviderNode = serde_json::from_value(serde_json::json!({"id":"shared","tenant_id":"red","name":"Shared API","prefix":"shared-api","protocol":"openai","base_url":"http://127.0.0.1:1/v1","chat_path":"/chat/completions","upstream_url":"http://127.0.0.1:1/v1/chat/completions","models_path":null,"revision":1})).unwrap();
        assert!(node.header_config.is_none());
        let subject = definition_subject(&node);
        let identity = identity(&subject);
        let aad = format!("{}:request-headers:{identity}", subject.id);
        node.header_config = Some(StoredProviderNodeHeaders {
            upstream_identity: identity,
            ciphertext: encrypt_async(
                r#"{"X-Project":"private-project"}"#,
                &aad,
                "headers-storage-key-1234567890",
            )
            .await
            .unwrap(),
            revision: 1,
        });
        db.upsert_provider_node(&node, None).await.unwrap();
        assert!(control
            .header_node("shared", Some("other-tenant"))
            .await
            .is_err());
        let scoped = control.header_node("shared", Some("red")).await.unwrap();
        let view = control.definition_header_view(&scoped).await.unwrap();
        assert_eq!(view.names, vec!["x-project"]);
        assert!(view.attached);
        assert!(!serde_json::to_string(&view)
            .unwrap()
            .contains("private-project"));
        let mut account = definition_subject(&node);
        account.id = "account-a".into();
        account.node_id = Some(node.id.clone());
        assert_eq!(
            control.request_headers(&account).await.unwrap()["x-project"],
            "private-project"
        );
        account.id = "account-b".into();
        assert_eq!(
            control.request_headers(&account).await.unwrap()["x-project"],
            "private-project"
        );
        assert_eq!(control.0.node_header_cache.lock().await.len(), 1);
        node.revision = 2;
        node.header_config.as_mut().unwrap().ciphertext = "corrupt".into();
        db.upsert_provider_node(&node, Some(1)).await.unwrap();
        assert!(control.request_headers(&account).await.is_err());
    }
}
