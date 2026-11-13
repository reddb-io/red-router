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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DiscoveredModel {
    pub(super) id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) context_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) max_input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) max_output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) model_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) supported_endpoints: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) input_modalities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) output_modalities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) supports_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) supports_thinking: Option<bool>,
}

impl DiscoveredModel {
    pub(super) fn supports_chat(&self) -> bool {
        if let Some(endpoints) = &self.supported_endpoints {
            return endpoints.iter().any(|value| {
                matches!(
                    value.as_str(),
                    "chat" | "chat-completions" | "chat/completions" | "messages" | "responses"
                )
            });
        }
        self.model_type.as_deref().is_none_or(|kind| kind == "chat")
            && self
                .output_modalities
                .as_ref()
                .is_none_or(|values| values.iter().any(|value| value == "text"))
    }
}

fn endpoints(value: Option<&serde_json::Value>) -> Option<Vec<String>> {
    let values = value?.as_array()?;
    if values.is_empty() || values.len() > 32 {
        return None;
    }
    let mut result = Vec::new();
    for value in values {
        let value = value.as_str()?.trim().to_ascii_lowercase();
        if value.is_empty() || value.len() > 64 || value.chars().any(char::is_control) {
            return None;
        }
        if !result.contains(&value) {
            result.push(value);
        }
    }
    Some(result)
}

fn valid_modality(value: &str) -> bool {
    matches!(value, "text" | "image" | "audio" | "video" | "file" | "pdf")
}

fn first_limit(values: &[Option<&serde_json::Value>]) -> Option<u64> {
    values
        .iter()
        .flatten()
        .filter_map(|value| value.as_u64())
        .find(|value| (1..=1_000_000_000).contains(value))
}

fn modalities(value: Option<&serde_json::Value>) -> Option<Vec<String>> {
    let values = value?.as_array()?;
    if values.is_empty() || values.len() > 16 {
        return None;
    }
    let mut result = Vec::new();
    for value in values {
        let value = value.as_str()?;
        if !valid_modality(value) {
            return None;
        }
        if !result.iter().any(|entry| entry == value) {
            result.push(value.to_owned());
        }
    }
    Some(result)
}

pub(super) fn parse_inventory(
    json: &str,
) -> Result<BTreeMap<String, DiscoveredModel>, &'static str> {
    let models: Vec<DiscoveredModel> =
        serde_json::from_str(json).map_err(|_| "invalid synced model inventory")?;
    if models.len() > MAX_MODELS {
        return Err("invalid synced model inventory");
    }
    let mut result = BTreeMap::new();
    for model in models {
        // A provider may list IDs that the proxy cannot route. Ignore those
        // entries instead of making every route unavailable for that account.
        if !model_aliases::valid_model_name(&model.id) {
            continue;
        }
        if model
            .name
            .as_ref()
            .is_some_and(|name| name.len() > 512 || name.chars().any(char::is_control))
            || [
                model.context_length,
                model.max_input_tokens,
                model.max_output_tokens,
            ]
            .into_iter()
            .flatten()
            .any(|value| value == 0 || value > 1_000_000_000)
            || model.model_type.as_deref().is_some_and(|value| {
                !matches!(
                    value,
                    "chat" | "embedding" | "image" | "rerank" | "decision"
                )
            })
            || model.supported_endpoints.as_ref().is_some_and(|values| {
                values.is_empty()
                    || values.len() > 32
                    || values.iter().any(|value| {
                        value.is_empty() || value.len() > 64 || value.chars().any(char::is_control)
                    })
            })
            || [&model.input_modalities, &model.output_modalities]
                .into_iter()
                .flatten()
                .any(|values| {
                    values.is_empty()
                        || values.len() > 16
                        || values.iter().any(|value| !valid_modality(value))
                })
            || result.insert(model.id.clone(), model).is_some()
        {
            return Err("invalid synced model inventory");
        }
    }
    Ok(result)
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
        let context_length = first_limit(&[
            row.get("context_length"),
            row.get("contextLength"),
            row.get("contextWindow"),
            row.get("max_model_len"),
            row.get("maxModelLen"),
            row.get("max_context_window"),
            row.get("max_input_tokens"),
            row.get("maxInputTokens"),
            row.pointer("/top_provider/context_length"),
            row.get("inputTokenLimit"),
        ]);
        let max_input_tokens = first_limit(&[
            row.get("inputTokenLimit"),
            row.get("max_input_tokens"),
            row.get("maxInputTokens"),
        ]);
        let max_output_tokens = first_limit(&[
            row.get("max_output_tokens"),
            row.get("outputTokenLimit"),
            row.get("maxOutputTokens"),
            row.get("max_tokens"),
            row.pointer("/top_provider/max_completion_tokens"),
        ]);
        let supported_endpoints = endpoints(row.get("supportedEndpoints"));
        let has_chat = supported_endpoints.as_ref().is_some_and(|values| {
            values.iter().any(|value| {
                matches!(
                    value.as_str(),
                    "chat" | "chat-completions" | "chat/completions" | "messages" | "responses"
                )
            })
        });
        let model_type = row
            .get("modelType")
            .and_then(serde_json::Value::as_str)
            .filter(|value| {
                matches!(
                    *value,
                    "chat" | "embedding" | "image" | "rerank" | "decision"
                )
            })
            .map(|value| if has_chat { "chat" } else { value }.to_owned());
        let input_modalities = modalities(
            row.pointer("/architecture/input_modalities")
                .or_else(|| row.get("input_modalities"))
                .or_else(|| row.get("supportedInputTypes")),
        )
        .or_else(|| {
            (row.get("supportsVision")
                .and_then(serde_json::Value::as_bool)
                == Some(true))
            .then(|| vec!["image".to_owned()])
        });
        let output_modalities = modalities(
            row.pointer("/architecture/output_modalities")
                .or_else(|| row.get("output_modalities")),
        );
        let supports_tools = row
            .get("supportsTools")
            .and_then(serde_json::Value::as_bool)
            .or_else(|| {
                row.get("supported_parameters")
                    .and_then(serde_json::Value::as_array)
                    .filter(|values| values.iter().any(|value| value.as_str() == Some("tools")))
                    .map(|_| true)
            });
        let supports_thinking = row
            .get("supportsThinking")
            .and_then(serde_json::Value::as_bool);
        models.entry(id.to_owned()).or_insert(DiscoveredModel {
            id: id.to_owned(),
            name,
            context_length,
            max_input_tokens,
            max_output_tokens,
            model_type,
            supported_endpoints,
            input_modalities,
            output_modalities,
            supports_tools,
            supports_thinking,
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
        "provider_changed" => (
            StatusCode::CONFLICT,
            "Connection or discovery settings changed; retry discovery",
        ),
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
        let (provider, auth, headers, credential, target, ticket) = {
            let _mutation = self.0.mutation.lock().await;
            let provider = self.discovery_provider(id, tenant).await?;
            let ticket = if provider.enabled && self.0.database.is_sqlite().await {
                let ticket = self
                    .0
                    .database
                    .begin_synced_model_probe(&provider.id, &provider.tenant_id)
                    .await?
                    .ok_or("provider_changed")?;
                if ticket.binding.provider_revision != provider.updated_at {
                    return Err("provider_changed");
                }
                Some(ticket)
            } else {
                None
            };
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
            if let Some(ticket) = &ticket {
                if !self.0.database.synced_model_probe_current(ticket).await? {
                    return Err("provider_changed");
                }
            }
            (provider, auth, headers, credential, target, ticket)
        };
        // Reuse DNS pinning, private-address policy, auth resolution and redirect prohibition.
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
            ProviderAuthScheme::None => request,
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
        let mut complete = false;
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
                complete = true;
                break;
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
        if !complete {
            return Err("too_many_pages");
        }
        let models: Vec<_> = all_models.into_values().collect();
        if let Some(ticket) = &ticket {
            let json = serde_json::to_string(&models).map_err(|_| "invalid_models_response")?;
            if json.len() > MAX_BODY {
                return Err("response_too_large");
            }
            if !self
                .0
                .database
                .publish_synced_models(ticket, &json, unix_time_ms()?)
                .await?
            {
                return Err("provider_changed");
            }
            let _mutation = self.0.mutation.lock().await;
            if !self.0.database.synced_model_probe_current(ticket).await? {
                return Err("provider_changed");
            }
            if let Err(error) = self.refresh_routes().await {
                *self.0.routes.write().await = RouteSnapshot::Unavailable;
                return Err(error);
            }
        }
        Ok(models)
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
        if let Err(error) = control.refresh_routes().await {
            *control.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
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
                priority: 0,
                default_model: None,
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
        let capabilities = parse_models(br#"{"data":[{"id":"vision","contextWindow":1000,"inputTokenLimit":900,"outputTokenLimit":100,"modelType":"chat","architecture":{"input_modalities":["text","image"],"output_modalities":["text"]},"supported_parameters":["tools"],"supportsThinking":true},{"id":"image-model","modelType":"image"}]}"#, ProviderProtocol::OpenAi).unwrap();
        let vision = capabilities
            .models
            .iter()
            .find(|model| model.id == "vision")
            .unwrap();
        assert_eq!(vision.context_length, Some(1000));
        assert_eq!(vision.max_input_tokens, Some(900));
        assert_eq!(vision.max_output_tokens, Some(100));
        assert_eq!(
            vision.input_modalities.as_deref(),
            Some(["text".to_owned(), "image".to_owned()].as_slice())
        );
        assert_eq!(vision.supports_tools, Some(true));
        assert_eq!(vision.supports_thinking, Some(true));
        assert_eq!(capabilities.models[0].model_type.as_deref(), Some("image"));
        let vllm = parse_models(br#"{"data":[{"id":"local-model","context_length":null,"max_model_len":250000,"max_output_tokens":0,"max_tokens":4096}]}"#, ProviderProtocol::OpenAi).unwrap();
        assert_eq!(vllm.models[0].context_length, Some(250000));
        assert_eq!(vllm.models[0].max_output_tokens, Some(4096));
        let endpoints = parse_models(br#"{"data":[{"id":"image-only","supportedEndpoints":["images"]},{"id":"multimodal","modelType":"image","supportedEndpoints":["chat","images"]}]}"#, ProviderProtocol::OpenAi).unwrap();
        assert!(!endpoints.models[0].supports_chat());
        assert!(endpoints.models[1].supports_chat());
        assert_eq!(endpoints.models[1].model_type.as_deref(), Some("chat"));
        assert_eq!(
            parse_inventory(&serde_json::to_string(&capabilities.models).unwrap())
                .unwrap()
                .len(),
            2
        );
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
