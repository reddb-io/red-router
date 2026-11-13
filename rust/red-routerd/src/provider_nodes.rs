//! Reusable API provider definitions. Account credentials stay on connections.
use super::*;
use crate::storage::StoredProviderNode;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeInput {
    tenant_id: Option<String>,
    name: String,
    prefix: String,
    protocol: String,
    base_url: String,
    chat_path: Option<String>,
    models_path: Option<String>,
    #[serde(default)]
    apply_to_connections: bool,
}

pub(super) fn present_node_id<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

pub(crate) fn default_chat_path(protocol: &str) -> Result<&'static str, &'static str> {
    match protocol {
        "openai" => Ok("/chat/completions"),
        "openai-responses" => Ok("/responses"),
        "openai-embeddings" => Ok("/embeddings"),
        "cohere-rerank" => Ok("/rerank"),
        "anthropic" => Ok("/messages"),
        "gemini" => Ok("/models"),
        _ => Err("Choose a supported API protocol"),
    }
}

pub(crate) fn endpoint(base: &str, path: &str) -> Result<String, &'static str> {
    if path.len() > 500
        || !path.starts_with('/')
        || path.starts_with("//")
        || path.contains(['\\', '#'])
        || path.chars().any(char::is_control)
    {
        return Err("Endpoint path must start with / and contain no fragment");
    }
    let url = reqwest::Url::parse(base).map_err(|_| "Invalid base URL")?;
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Base URL must be credential-free HTTP or HTTPS");
    }
    let target = format!("{}{path}", url.as_str().trim_end_matches('/'));
    let parsed = reqwest::Url::parse(&target).map_err(|_| "Invalid endpoint path")?;
    if parsed.origin() != url.origin() {
        return Err("Endpoint must retain the provider origin");
    }
    if !crate::public_endpoint_query(&parsed) {
        return Err("Endpoint query must not contain credentials");
    }
    Ok(parsed.to_string())
}

pub(crate) fn models_path(node: &StoredProviderNode) -> Result<String, &'static str> {
    let url = endpoint(
        &node.base_url,
        node.models_path.as_deref().unwrap_or("/models"),
    )?;
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Invalid model discovery URL")?;
    let mut relative = parsed.path().to_owned();
    if let Some(query) = parsed.query() {
        relative.push('?');
        relative.push_str(query);
    }
    Ok(relative)
}

impl ControlPlane {
    pub(super) async fn provider_node(
        &self,
        id: &str,
        tenant: &str,
    ) -> Result<StoredProviderNode, &'static str> {
        validate_id(id)?;
        self.0
            .database
            .provider_nodes()
            .await?
            .into_iter()
            .find(|node| node.id == id && node.tenant_id == tenant)
            .ok_or("Provider definition unavailable")
    }

    async fn save_provider_node(
        &self,
        id: &str,
        input: NodeInput,
        actor: &str,
        tenant: Option<&str>,
    ) -> Result<StoredProviderNode, &'static str> {
        validate_id(id)?;
        validate_actor(actor)?;
        validate_provider(&input.prefix)?;
        if input.name.trim().is_empty()
            || input.name.encode_utf16().count() > 200
            || input.name.chars().any(char::is_control)
        {
            return Err("Provider name must contain 1-200 characters");
        }
        if input.base_url.len() > 2048 {
            return Err("Base URL is too long");
        }
        let _mutation = self.0.mutation.lock().await;
        let nodes = self.0.database.provider_nodes().await?;
        let existing = nodes.iter().find(|node| node.id == id);
        let tenant_id = input
            .tenant_id
            .as_deref()
            .or_else(|| existing.map(|node| node.tenant_id.as_str()))
            .or(tenant)
            .unwrap_or("red");
        validate_id(tenant_id)?;
        if tenant.is_some_and(|required| required != tenant_id)
            || existing.is_some_and(|node| node.tenant_id != tenant_id)
        {
            return Err("Provider definition unavailable");
        }
        if !self
            .0
            .database
            .tenants()
            .await?
            .iter()
            .any(|entry| entry.id == tenant_id && entry.enabled)
        {
            return Err("Provider tenant is unavailable");
        }
        let reserved: serde_json::Value = serde_json::from_str(include_str!(
            "../../../config/upstream/legacy-executor-parity.json"
        ))
        .map_err(|_| "cannot read provider namespace registry")?;
        let reserved_alias = reserved["groups"].as_array().is_some_and(|groups| {
            groups.iter().any(|group| {
                group["aliases"].as_array().is_some_and(|aliases| {
                    aliases
                        .iter()
                        .any(|alias| alias.as_str() == Some(&input.prefix))
                })
            })
        });
        if reserved_alias
            || matches!(input.prefix.as_str(), "redrouter" | "gemini-cli")
            || self
                .0
                .catalog
                .read()
                .await
                .catalog
                .provider(&input.prefix)?
                .is_some()
        {
            return Err("Provider prefix is reserved by the provider catalog");
        }
        if nodes
            .iter()
            .any(|node| node.id != id && node.tenant_id == tenant_id && node.prefix == input.prefix)
        {
            return Err("Provider prefix already exists");
        }
        let default_path = default_chat_path(&input.protocol)?;
        let chat_path = input
            .chat_path
            .as_deref()
            .filter(|path| !path.is_empty())
            .unwrap_or(default_path);
        let upstream_url = endpoint(&input.base_url, chat_path)?;
        let protocol = ProviderProtocol::from_configuration(&upstream_url, &input.protocol)?;
        ProxyState::live_provider(
            &upstream_url,
            "definition-validation-only",
            self.0.allow_private,
            ProviderAuthScheme::Auto,
            0,
            &input.protocol,
            true,
        )
        .await?;
        let node = StoredProviderNode {
            header_config: existing.and_then(|node| node.header_config.clone()),
            id: id.to_owned(),
            tenant_id: tenant_id.to_owned(),
            name: input.name.trim().to_owned(),
            prefix: input.prefix,
            protocol: input.protocol,
            base_url: input.base_url.trim_end_matches('/').to_owned(),
            chat_path: chat_path.to_owned(),
            upstream_url,
            models_path: input.models_path.filter(|path| !path.is_empty()),
            revision: revision()?,
        };
        models_path(&node)?;
        let providers = self.0.database.providers().await?;
        let linked: Vec<_> = providers
            .iter()
            .filter(|provider| provider.node_id.as_deref() == Some(id))
            .collect();
        let transport_changed = existing.is_some_and(|old| {
            old.upstream_url != node.upstream_url
                || old.protocol != node.protocol
                || old.prefix != node.prefix
        });
        if transport_changed && !linked.is_empty() && !input.apply_to_connections {
            return Err("Confirm applying endpoint changes to linked accounts");
        }
        if transport_changed {
            let authentication = self.auth_settings().await?;
            for provider in &linked {
                let auth = authentication
                    .get(&(provider.id.clone(), provider.updated_at))
                    .cloned()
                    .unwrap_or_else(|| default_provider_auth(provider));
                ProviderAuthScheme::parse(&auth.auth_scheme)?.resolve(protocol)?;
                if provider.enabled {
                    self.ensure_provider_protocol_compatible(
                        &provider.id,
                        &provider.tenant_id,
                        protocol,
                    )
                    .await?;
                }
            }
        }
        self.0
            .database
            .upsert_provider_node(&node, existing.map(|node| node.revision))
            .await?;
        self.record_audit_event(AuditContext { action: "provider.definition.update", actor, tenant_id: &node.tenant_id, target: id, resource_type: "provider-definition" },
            existing.map(|old| serde_json::json!({"id":old.id,"prefix":old.prefix,"revision":old.revision.to_string()})).as_ref(),
            Some(&serde_json::json!({"id":node.id,"prefix":node.prefix,"revision":node.revision.to_string(),"linked_accounts":linked.len()}))).await;
        // Rebuild snapshots; credentials remain encrypted on their original accounts.
        if let Err(error) = self.refresh().await {
            *self.0.current.write().await = None;
            return Err(error);
        }
        if let Err(error) = self.refresh_routes().await {
            *self.0.routes.write().await = RouteSnapshot::Unavailable;
            return Err(error);
        }
        Ok(node)
    }
}

fn node_view(node: &StoredProviderNode) -> serde_json::Value {
    serde_json::json!({"id":node.id,"tenant_id":node.tenant_id,"name":node.name,"prefix":node.prefix,"protocol":node.protocol,"base_url":node.base_url,"chat_path":node.chat_path,"upstream_url":node.upstream_url,"models_path":node.models_path,"revision":node.revision.to_string()})
}

pub async fn list(State(state): State<ProxyState>, headers: HeaderMap) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Control plane unavailable");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control.0.database.provider_nodes().await {
        Ok(nodes) => ([(header::CACHE_CONTROL, "no-store")], Json(serde_json::json!({"nodes":nodes.into_iter().filter(|node| scope.tenant_id.as_ref().is_none_or(|tenant| *tenant == node.tenant_id)).map(|node| node_view(&node)).collect::<Vec<_>>()}))).into_response(),
        Err(_) => api_error(StatusCode::SERVICE_UNAVAILABLE, "Provider definitions unavailable"),
    }
}

pub async fn get_node(
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
    match control.0.database.provider_nodes().await {
        Ok(nodes) => match nodes.iter().find(|node| {
            node.id == id
                && scope
                    .tenant_id
                    .as_ref()
                    .is_none_or(|tenant| *tenant == node.tenant_id)
        }) {
            Some(node) => (
                [(header::CACHE_CONTROL, "no-store")],
                Json(serde_json::json!({"node":node_view(node)})),
            )
                .into_response(),
            None => api_error(StatusCode::NOT_FOUND, "Provider definition unavailable"),
        },
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider definitions unavailable",
        ),
    }
}

fn failure(error: &'static str) -> Response {
    let status = match error {
        "Provider definition unavailable" => StatusCode::NOT_FOUND,
        "Provider definition changed; reload and retry"
        | "Confirm applying endpoint changes to linked accounts"
        | "Provider prefix already exists"
        | "Provider definition has linked accounts"
        | "provider protocol is incompatible with an enabled combo" => StatusCode::CONFLICT,
        error if is_runtime_error(error) => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::BAD_REQUEST,
    };
    api_error(
        status,
        if status == StatusCode::SERVICE_UNAVAILABLE {
            "Provider definition storage or runtime unavailable"
        } else {
            error
        },
    )
}

pub async fn put(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<NodeInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Control plane unavailable");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    match control
        .save_provider_node(&id, input, &scope.actor, scope.tenant_id.as_deref())
        .await
    {
        Ok(node) => (
            [(header::CACHE_CONTROL, "no-store")],
            Json(serde_json::json!({"node":node_view(&node)})),
        )
            .into_response(),
        Err(error) => failure(error),
    }
}

pub async fn remove(
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
    let _mutation = control.0.mutation.lock().await;
    let result: Result<(), &'static str> = async {
        validate_id(&id)?;
        let node = control
            .0
            .database
            .provider_nodes()
            .await?
            .into_iter()
            .find(|node| {
                node.id == id
                    && scope
                        .tenant_id
                        .as_ref()
                        .is_none_or(|tenant| *tenant == node.tenant_id)
            })
            .ok_or("Provider definition unavailable")?;
        if control
            .0
            .database
            .providers()
            .await?
            .iter()
            .any(|provider| provider.node_id.as_deref() == Some(&id))
        {
            return Err("Provider definition has linked accounts");
        }
        control
            .0
            .database
            .delete_provider_node(&id, &node.tenant_id)
            .await?;
        control
            .0
            .node_header_cache
            .lock()
            .await
            .remove(&format!("node:{}:{}", node.tenant_id, node.id));
        control
            .record_audit_event(
                AuditContext {
                    action: "provider.definition.delete",
                    actor: &scope.actor,
                    tenant_id: &node.tenant_id,
                    target: &id,
                    resource_type: "provider-definition",
                },
                Some(&serde_json::json!({"id":id})),
                None,
            )
            .await;
        Ok(())
    }
    .await;
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => failure(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn definitions_reject_other_tenant_managers_and_disallowed_endpoint_changes() {
        let database = Arc::new(
            crate::storage::Database::connect(crate::storage::Backend::Sqlite, "sqlite::memory:")
                .await
                .unwrap(),
        );
        let control = ControlPlane::new(
            database.clone(),
            "definition-admin-key-1234567890-abcdef",
            "definition-storage-key-1234567890",
            true,
        )
        .await
        .unwrap();
        let input = || NodeInput {
            tenant_id: None,
            name: "Team API".into(),
            prefix: "team-api".into(),
            protocol: "openai".into(),
            base_url: "http://127.0.0.1:1/v1".into(),
            chat_path: None,
            models_path: None,
            apply_to_connections: false,
        };
        control
            .save_provider_node("team", input(), "test", Some("red"))
            .await
            .unwrap();
        assert!(control
            .save_provider_node("team", input(), "test", Some("other-tenant"))
            .await
            .is_err());
        assert!(control.provider_node("team", "other-tenant").await.is_err());
        database
            .delete_provider_node("team", "other-tenant")
            .await
            .unwrap();
        assert_eq!(database.provider_nodes().await.unwrap().len(), 1);
        let mut invalid = input();
        invalid.base_url = "http://example.com/v1".into();
        assert!(control
            .save_provider_node("team", invalid, "test", Some("red"))
            .await
            .is_err());
        let node = control.provider_node("team", "red").await.unwrap();
        assert_eq!(node.upstream_url, "http://127.0.0.1:1/v1/chat/completions");
        assert_eq!(models_path(&node).unwrap(), "/v1/models");

        let mut queried = input();
        queried.prefix = "query-api".into();
        queried.chat_path = Some("/responses?api-version=2026-11-01".into());
        queried.models_path = Some("/models?api-version=2026-11-01".into());
        control
            .save_provider_node("query-api", queried, "test", Some("red"))
            .await
            .unwrap();
        let queried = control.provider_node("query-api", "red").await.unwrap();
        assert_eq!(
            queried.upstream_url,
            "http://127.0.0.1:1/v1/responses?api-version=2026-11-01"
        );
        assert_eq!(
            models_path(&queried).unwrap(),
            "/v1/models?api-version=2026-11-01"
        );
    }
}
