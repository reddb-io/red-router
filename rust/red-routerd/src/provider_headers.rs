//! Provider request headers, inherited from upstreamHeaders.ts and the compatible executor.
//! Values are write-only and encrypted; endpoint changes detach the old map.
use super::*;
use crate::storage::StoredProviderHeaders;
use axum::http::HeaderName;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderHeadersInput {
    headers: BTreeMap<String, String>,
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
        let values: BTreeMap<String, String> =
            serde_json::from_str(&plaintext).map_err(|_| "invalid stored provider headers")?;
        let headers = validate(&values)?;
        let mut names: Vec<_> = headers.keys().map(|n| n.as_str().to_owned()).collect();
        names.sort();
        Ok(HeadersView {
            names,
            attached: entry.upstream_identity == identity(provider),
            revision: Some(entry.revision.to_string()),
        })
    }

    pub(super) async fn request_headers(
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
        let values =
            serde_json::from_str(&plaintext).map_err(|_| "invalid stored provider headers")?;
        validate(&values)
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
}
