//! Authenticated model discovery for saved API connections. No inference-path I/O.
use super::*;
use crate::storage::StoredProviderDiscovery;

// Bound management probes, independently of inference/agent concurrency.
static PROBES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
const MAX_BODY: usize = 2 * 1024 * 1024;
const MAX_MODELS: usize = 10_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiscoveryInput {
    models_path: Option<String>,
}

#[derive(Serialize)]
struct DiscoveryView {
    models_path: Option<String>,
    effective_models_path: Option<String>,
    revision: Option<String>,
}

#[derive(Serialize)]
struct DiscoveredModel {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    context_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_output_tokens: Option<u64>,
}

fn models_url(upstream: &str, path: &str) -> Result<reqwest::Url, &'static str> {
    if path.len() > 2048
        || !path.starts_with('/')
        || path.starts_with("//")
        || path.contains(['\\', '#'])
        || path.chars().any(char::is_control)
    {
        return Err("invalid_models_path");
    }
    let origin = reqwest::Url::parse(upstream).map_err(|_| "invalid_models_path")?;
    let target = origin.join(path).map_err(|_| "invalid_models_path")?;
    if target.origin() != origin.origin()
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return Err("invalid_models_path");
    }
    Ok(target)
}

fn default_path(upstream: &str) -> Option<String> {
    let url = reqwest::Url::parse(upstream).ok()?;
    let path = url.path().trim_end_matches('/');
    if path.ends_with("/models") {
        return Some(path.to_owned());
    }
    for suffix in [
        "/chat/completions",
        "/responses",
        "/messages",
        "/embeddings",
        "/rerank",
    ] {
        if let Some(base) = path.strip_suffix(suffix) {
            return Some(format!("{base}/models"));
        }
    }
    None
}

struct ModelsPage {
    models: Vec<DiscoveredModel>,
    next: Option<(&'static str, String)>,
}

fn parse_models(body: &[u8], protocol: ProviderProtocol) -> Result<ModelsPage, &'static str> {
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| "invalid_models_response")?;
    let rows = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(serde_json::Value::as_array)
        .ok_or("invalid_models_response")?;
    if rows.len() > MAX_MODELS {
        return Err("too_many_models");
    }
    let mut models = BTreeMap::new();
    for row in rows {
        let id = row
            .as_str()
            .or_else(|| row.get("id").and_then(serde_json::Value::as_str))
            .or_else(|| row.get("model").and_then(serde_json::Value::as_str))
            .or_else(|| row.get("name").and_then(serde_json::Value::as_str))
            .ok_or("invalid_models_response")?;
        let id = if protocol == ProviderProtocol::Gemini {
            id.strip_prefix("models/").unwrap_or(id)
        } else {
            id
        };
        if id.is_empty() || id.len() > 256 || id.trim() != id || id.chars().any(char::is_control) {
            return Err("invalid_models_response");
        }
        let name = row
            .get("display_name")
            .or_else(|| row.get("displayName"))
            .or_else(|| row.get("name"))
            .and_then(serde_json::Value::as_str)
            .filter(|value| value.len() <= 512 && !value.chars().any(char::is_control))
            .map(str::to_owned);
        let context_length = row
            .get("context_length")
            .or_else(|| row.get("inputTokenLimit"))
            .and_then(serde_json::Value::as_u64);
        let max_output_tokens = row
            .get("max_output_tokens")
            .or_else(|| row.get("outputTokenLimit"))
            .or_else(|| row.pointer("/top_provider/max_completion_tokens"))
            .and_then(serde_json::Value::as_u64);
        models.entry(id.to_owned()).or_insert(DiscoveredModel {
            id: id.to_owned(),
            name,
            context_length,
            max_output_tokens,
        });
    }
    let next_token = match value.get("nextPageToken") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(token)) => (!token.is_empty()).then_some(token.as_str()),
        _ => return Err("invalid_models_response"),
    };
    let has_more = match value.get("has_more") {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Bool(value)) => *value,
        _ => return Err("invalid_models_response"),
    };
    let cursor = if let Some(token) = next_token {
        Some(("pageToken", token))
    } else if has_more {
        Some((
            "after_id",
            value
                .get("last_id")
                .and_then(serde_json::Value::as_str)
                .ok_or("invalid_models_response")?,
        ))
    } else {
        None
    };
    let next = cursor
        .map(|(parameter, token)| {
            if token.is_empty() || token.len() > 4096 || token.chars().any(char::is_control) {
                return Err("invalid_models_response");
            }
            Ok((parameter, token.to_owned()))
        })
        .transpose()?;
    Ok(ModelsPage {
        models: models.into_values().collect(),
        next,
    })
}

fn failure(code: &'static str) -> Response {
    let (status, message) = match code {
        "provider_not_found" => (StatusCode::NOT_FOUND, "Provider unavailable"),
        "invalid_models_path" => (
            StatusCode::BAD_REQUEST,
            "Use a models path on this provider's origin, beginning with /",
        ),
        "unsupported_connection" => (
            StatusCode::BAD_REQUEST,
            "Model discovery requires an API credential connection",
        ),
        "models_path_required" => (
            StatusCode::BAD_REQUEST,
            "Configure the models path for this connection first",
        ),
        "credential_expired" => (
            StatusCode::BAD_REQUEST,
            "The provider credential has expired",
        ),
        "upstream_authentication" => (
            StatusCode::BAD_GATEWAY,
            "The provider rejected the configured credential",
        ),
        "upstream_rate_limited" => (
            StatusCode::BAD_GATEWAY,
            "The provider rate-limited model discovery; retry later",
        ),
        "upstream_redirect" => (
            StatusCode::BAD_GATEWAY,
            "The provider redirected model discovery; configure the final path directly",
        ),
        "upstream_unavailable" => (
            StatusCode::BAD_GATEWAY,
            "The provider model endpoint is unavailable",
        ),
        "invalid_models_response" => (
            StatusCode::BAD_GATEWAY,
            "The provider returned an invalid model list",
        ),
        "response_too_large" | "too_many_models" => (
            StatusCode::BAD_GATEWAY,
            "The provider model list exceeds the discovery limit",
        ),
        "pagination_loop" | "too_many_pages" => (
            StatusCode::BAD_GATEWAY,
            "The provider returned incomplete or cyclic model pagination",
        ),
        "timeout" => (
            StatusCode::GATEWAY_TIMEOUT,
            "Provider model discovery timed out",
        ),
        "busy" => (
            StatusCode::TOO_MANY_REQUESTS,
            "Model discovery is busy; retry shortly",
        ),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider discovery configuration unavailable",
        ),
    };
    let mut response = api_error(status, message);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

impl ControlPlane {
    async fn discovery_provider(
        &self,
        id: &str,
        tenant: Option<&str>,
    ) -> Result<StoredProvider, &'static str> {
        validate_id(id).map_err(|_| "provider_not_found")?;
        let provider = self
            .0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|p| p.id == id && tenant.is_none_or(|t| t == p.tenant_id))
            .ok_or("provider_not_found")?;
        if self
            .0
            .database
            .provider_oauth()
            .await?
            .iter()
            .any(|row| row.provider_id == id)
        {
            return Err("unsupported_connection");
        }
        Ok(provider)
    }

    async fn discovery_view(
        &self,
        provider: &StoredProvider,
    ) -> Result<DiscoveryView, &'static str> {
        let entry = self.0.database.provider_discovery(&provider.id).await?;
        let models_path = entry.as_ref().map(|value| value.models_path.clone());
        let inherited_path = if let Some(id) = provider.node_id.as_deref() {
            Some(super::provider_nodes::models_path(
                &self.provider_node(id, &provider.tenant_id).await?,
            )?)
        } else {
            None
        };
        let effective_models_path = models_path.clone().or(inherited_path).or_else(|| {
            if provider.protocol == "gemini" {
                reqwest::Url::parse(&provider.upstream_url)
                    .ok()
                    .map(|url| url.path().to_owned())
            } else {
                default_path(&provider.upstream_url)
            }
        });
        if let Some(path) = &effective_models_path {
            models_url(&provider.upstream_url, path)?;
        }
        Ok(DiscoveryView {
            models_path,
            effective_models_path,
            revision: entry.map(|value| value.revision.to_string()),
        })
    }

    async fn discover_models(
        &self,
        id: &str,
        tenant: Option<&str>,
    ) -> Result<Vec<DiscoveredModel>, &'static str> {
        // Collect one local configuration snapshot, then release management writes before network I/O.
        let (provider, auth, headers, credential, target) = {
            let _mutation = self.0.mutation.lock().await;
            let provider = self.discovery_provider(id, tenant).await?;
            let config = self.discovery_view(&provider).await?;
            let path = config.effective_models_path.ok_or("models_path_required")?;
            let target = models_url(&provider.upstream_url, &path)?;
            let auth = self
                .auth_settings()
                .await?
                .remove(&(provider.id.clone(), provider.updated_at))
                .unwrap_or_else(|| default_provider_auth(&provider));
            if auth.expires_at_unix > 0
                && auth.expires_at_unix <= i64::try_from(unix_time_seconds()?).unwrap_or(i64::MAX)
            {
                return Err("credential_expired");
            }
            let headers = self.request_headers(&provider).await?;
            let credential = decrypt_async(
                &provider.credential_ciphertext,
                &provider.id,
                self.0.encryption_key.as_str(),
            )
            .await?;
            (provider, auth, headers, credential, target)
        };
        // Reuse DNS pinning, private-address policy, auth resolution and redirect prohibition.
        let live = ProxyState::live_provider(
            &provider.upstream_url,
            credential.as_str(),
            self.0.allow_private,
            ProviderAuthScheme::parse(&auth.auth_scheme)?,
            auth.expires_at_unix,
            &provider.protocol,
        )
        .await?;
        let mut request = live
            .client
            .get(target)
            .header(header::ACCEPT, "application/json");
        request = match live.auth_scheme {
            ProviderAuthScheme::Bearer => {
                request.header(header::AUTHORIZATION, live.provider_key.clone())
            }
            ProviderAuthScheme::XApiKey => request.header("x-api-key", live.provider_key.clone()),
            ProviderAuthScheme::XGoogApiKey => {
                request.header("x-goog-api-key", live.provider_key.clone())
            }
            ProviderAuthScheme::Auto => return Err("unsupported_connection"),
        };
        if live.protocol == ProviderProtocol::Anthropic {
            request = request.header("anthropic-version", "2023-06-01");
        }
        let template = request
            .headers(headers)
            .build()
            .map_err(|_| "upstream_unavailable")?;
        let original = template.url().clone();
        let mut page_url = original.clone();
        let mut seen = HashSet::new();
        let mut all_models = BTreeMap::new();
        let mut total_bytes = 0usize;
        for _ in 0..20 {
            let mut request = template.try_clone().ok_or("upstream_unavailable")?;
            *request.url_mut() = page_url;
            let response = live
                .client
                .execute(request)
                .await
                .map_err(|_| "upstream_unavailable")?;
            match response.status().as_u16() {
                200..=299 => (),
                300..=399 => return Err("upstream_redirect"),
                401 | 403 => return Err("upstream_authentication"),
                429 => return Err("upstream_rate_limited"),
                _ => return Err("upstream_unavailable"),
            }
            if response
                .content_length()
                .is_some_and(|length| length > MAX_BODY.saturating_sub(total_bytes) as u64)
            {
                return Err("response_too_large");
            }
            let mut stream = response.bytes_stream();
            let mut body = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| "upstream_unavailable")?;
                total_bytes = total_bytes.saturating_add(chunk.len());
                if total_bytes > MAX_BODY {
                    return Err("response_too_large");
                }
                body.extend_from_slice(&chunk);
            }
            let page = parse_models(&body, live.protocol)?;
            for model in page.models {
                all_models.entry(model.id.clone()).or_insert(model);
            }
            if all_models.len() > MAX_MODELS {
                return Err("too_many_models");
            }
            let Some((parameter, token)) = page.next else {
                return Ok(all_models.into_values().collect());
            };
            if !seen.insert((parameter, token.clone())) {
                return Err("pagination_loop");
            }
            // Cursors become encoded query values on the original pinned origin, never URLs.
            page_url = original.clone();
            let mut query: Vec<(String, String)> = original
                .query_pairs()
                .filter(|(name, _)| name != parameter)
                .map(|(name, value)| (name.into_owned(), value.into_owned()))
                .collect();
            query.push((parameter.to_owned(), token));
            page_url.set_query(None);
            page_url.query_pairs_mut().extend_pairs(query);
        }
        Err("too_many_pages")
    }
}

pub async fn get_config(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return failure("unavailable");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    let result = async {
        let provider = control
            .discovery_provider(&id, scope.tenant_id.as_deref())
            .await?;
        control.discovery_view(&provider).await
    }
    .await;
    match result {
        Ok(view) => ([(header::CACHE_CONTROL, "no-store")], Json(view)).into_response(),
        Err(error) => failure(error),
    }
}

pub async fn put_config(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<DiscoveryInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return failure("unavailable");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    let result = async {
        let _mutation = control.0.mutation.lock().await;
        let provider = control
            .discovery_provider(&id, scope.tenant_id.as_deref())
            .await?;
        let before = control.discovery_view(&provider).await?;
        if let Some(path) = input.models_path {
            models_url(&provider.upstream_url, &path)?;
            control
                .0
                .database
                .upsert_provider_discovery(&StoredProviderDiscovery {
                    provider_id: id.clone(),
                    models_path: path,
                    revision: revision()?,
                })
                .await?;
        } else {
            control.0.database.delete_provider_discovery(&id).await?;
        }
        let after = control.discovery_view(&provider).await?;
        control
            .record_audit_event(
                AuditContext {
                    action: "provider.discovery.update",
                    actor: &scope.actor,
                    target: &id,
                    tenant_id: &provider.tenant_id,
                    resource_type: "provider",
                },
                Some(&before),
                Some(&after),
            )
            .await;
        Ok(after)
    }
    .await;
    match result {
        Ok(view) => ([(header::CACHE_CONTROL, "no-store")], Json(view)).into_response(),
        Err(error) => failure(error),
    }
}

pub async fn discover(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return failure("unavailable");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    let Ok(_permit) = PROBES.try_acquire() else {
        return failure("busy");
    };
    match tokio::time::timeout(
        Duration::from_secs(15),
        control.discover_models(&id, scope.tenant_id.as_deref()),
    )
    .await
    {
        Ok(Ok(models)) => (
            [(header::CACHE_CONTROL, "no-store")],
            Json(serde_json::json!({"provider_id":id,"models":models})),
        )
            .into_response(),
        Ok(Err(error)) => failure(error),
        Err(_) => failure("timeout"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn discovery_preserves_tenant_ownership_and_oauth_boundaries() {
        let database = Arc::new(
            crate::storage::Database::connect(crate::storage::Backend::Sqlite, "sqlite::memory:")
                .await
                .unwrap(),
        );
        let control = ControlPlane::new(
            database.clone(),
            "fixture-admin-key-1234567890-abcdef",
            "fixture-storage-key-1234567890",
            false,
        )
        .await
        .unwrap();
        database
            .upsert_provider(&StoredProvider {
                node_id: None,
                protocol: "auto".to_owned(),
                id: "account".into(),
                tenant_id: "red".into(),
                provider: "openai-compatible".into(),
                upstream_url: "https://example.test/v1/chat/completions".into(),
                credential_ciphertext: "opaque".into(),
                enabled: false,
                updated_at: 1,
            })
            .await
            .unwrap();
        assert!(control
            .discovery_provider("account", Some("red"))
            .await
            .is_ok());
        assert_eq!(
            control
                .discovery_provider("account", Some("other"))
                .await
                .unwrap_err(),
            "provider_not_found"
        );
        database
            .upsert_provider_oauth(&StoredProviderOAuth {
                provider_id: "account".into(),
                oauth_provider: "codex".into(),
                refresh_token_ciphertext: "opaque".into(),
                generation: 1,
                revision: 1,
            })
            .await
            .unwrap();
        assert_eq!(
            control
                .discovery_provider("account", Some("red"))
                .await
                .unwrap_err(),
            "unsupported_connection"
        );
        assert_eq!(
            control
                .discovery_provider("account", Some("other"))
                .await
                .unwrap_err(),
            "provider_not_found"
        );
    }

    #[test]
    fn paths_preserve_origin_and_catalog_formats_are_bounded() {
        let upstream = "https://example.com/api/v1/chat/completions";
        assert_eq!(default_path(upstream).as_deref(), Some("/api/v1/models"));
        assert_eq!(
            models_url(upstream, "/custom/models?version=2")
                .unwrap()
                .as_str(),
            "https://example.com/custom/models?version=2"
        );
        for path in [
            "https://evil.test/models",
            "//evil.test/models",
            "/\\evil.test/models",
            "/models#secret",
            "/models\r\n",
        ] {
            assert!(models_url(upstream, path).is_err());
        }
        assert_eq!(default_path("https://example.com/custom/infer"), None);
        let models = parse_models(br#"{"data":[{"id":"b","context_length":123,"secret":"ignored"},{"id":"a"},{"id":"a"}]}"#, ProviderProtocol::OpenAi).unwrap();
        assert_eq!(
            parse_models(
                br#"{"models":[{"name":"models/gemini"}]}"#,
                ProviderProtocol::Gemini
            )
            .unwrap()
            .models[0]
                .id,
            "gemini"
        );
        assert!(parse_models(
            br#"{"models":[{"name":"models/"}]}"#,
            ProviderProtocol::Gemini
        )
        .is_err());
        assert_eq!(models.models.len(), 2);
        assert_eq!(models.models[0].id, "a");
        assert!(!serde_json::to_string(&models.models)
            .unwrap()
            .contains("secret"));
        assert!(parse_models(
            br#"{"error":{"message":"secret"}}"#,
            ProviderProtocol::OpenAi
        )
        .is_err());
        assert!(parse_models(
            br#"{"data":[{"id":"bad\nmodel"}]}"#,
            ProviderProtocol::OpenAi
        )
        .is_err());
        assert_eq!(
            parse_models(
                br#"{"models":[{"name":"models/gemini","inputTokenLimit":123}]}"#,
                ProviderProtocol::Gemini
            )
            .unwrap()
            .models[0]
                .context_length,
            Some(123)
        );
    }
}
