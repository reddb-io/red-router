//! Experimental, memory-only configuration source for the patched FastLLM.
//! This does not replace per-request dashboard authorization or accounting.
use crate::{
    fastllm_plan::validate_transport, product::ProductConnection, product_combo::ProductCombo,
};
use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, Response, StatusCode},
    routing::get,
    Router,
};
use futures_util::future::join_all;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, net::SocketAddr, path::Path, sync::Arc};
use subtle::ConstantTimeEq;
use zeroize::{Zeroize, Zeroizing};

const PRINCIPAL: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const KEY_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

struct ControlState {
    authorization: Zeroizing<String>,
    snapshot: Zeroizing<Vec<u8>>,
    etag: String,
    version: u64,
    combo: ProductCombo,
    connections: Vec<ProductConnection>,
}

fn clear_json(value: &mut Value) {
    match value {
        Value::String(value) => value.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(clear_json),
        Value::Object(values) => values.values_mut().for_each(clear_json),
        _ => {}
    }
}

async fn prepare(
    path: &Path,
    combo_name: &str,
    internal_token: &str,
    control_token: &str,
    storage_key: Option<&str>,
) -> Result<Arc<ControlState>, &'static str> {
    validate_transport("http://127.0.0.1/v1/chat/completions", internal_token)?;
    validate_transport("http://127.0.0.1/v1/chat/completions", control_token)?;
    if bool::from(internal_token.as_bytes().ct_eq(control_token.as_bytes())) {
        return Err("FastLLM control and internal tokens must be different");
    }
    let combo = ProductCombo::load(path, combo_name).await?;
    let mut names = HashSet::new();
    if combo
        .targets
        .iter()
        .any(|target| !names.insert(target.model.clone()))
    {
        return Err("FastLLM control requires unique upstream model names");
    }
    let mut connections = Vec::new();
    let mut provider_data = Vec::new();
    for target in combo.targets.iter() {
        let id = ProductConnection::select_fill_first(path, &target.provider).await?;
        let (connection, credential) = ProductConnection::open(path, &id, storage_key).await?;
        if credential.as_str() == internal_token
            || credential.as_str() == control_token
            || connection.dashboard_key_exists(internal_token).await?
            || connection.dashboard_key_exists(control_token).await?
        {
            return Err("FastLLM tokens must differ from all dashboard and provider keys");
        }
        let connection = connection.with_auto_selection_guard();
        let api_base = connection
            .upstream_url()
            .strip_suffix("/chat/completions")
            .ok_or("unsupported FastLLM provider URL")?;
        provider_data.push((target.model.clone(), api_base, credential));
        connections.push(connection);
    }
    if !combo.unchanged().await
        || join_all(connections.iter().map(ProductConnection::unchanged))
            .await
            .iter()
            .any(|ok| !ok)
    {
        return Err("product configuration changed while preparing FastLLM control");
    }
    let (snapshot, version) = build_snapshot(&provider_data, internal_token)?;
    Ok(Arc::new(ControlState {
        authorization: Zeroizing::new(format!("Bearer {control_token}")),
        snapshot,
        etag: format!("\"{version}\""),
        version,
        combo,
        connections,
    }))
}

/// Model, fixed provider base URL and protected credential captured at startup.
pub type ProviderData = (String, &'static str, Zeroizing<String>);

fn build_snapshot(
    provider_data: &[ProviderData],
    internal_token: &str,
) -> Result<(Zeroizing<Vec<u8>>, u64), &'static str> {
    let hash = hex::encode(Sha256::digest(internal_token.as_bytes()));
    let allowed: Vec<_> = provider_data
        .iter()
        .map(|(model, _, _)| model.clone())
        .collect();
    let models: Vec<_> = provider_data
        .iter()
        .map(|(model, api_base, credential)| {
            json!({
                "name": model, "backends": [{ "api_base": api_base,
                "upstream_model": model, "api_key": credential.as_str(), "protocol": "openai" }]
            })
        })
        .collect();
    let mut snapshot = json!({
        "version": 0, "open": false,
        "keys": {(hash): {"principal": PRINCIPAL, "expires_at": null, "disabled": false, "id": KEY_ID}},
        "principals": [{"id": PRINCIPAL, "name": "red-router-internal", "allowed_models": allowed, "allow_all": false}],
        "models": models
    });
    // A fixed version can make an engine retain old credentials after the
    // control process restarts. Derive a nonzero version from all contents,
    // including provider credentials, before returning conditional responses.
    let mut initial = Zeroizing::new(
        serde_json::to_vec(&snapshot).map_err(|_| "cannot serialize FastLLM configuration")?,
    );
    let digest = Sha256::digest(initial.as_slice());
    let mut version_bytes = [0u8; 8];
    version_bytes[2..].copy_from_slice(&digest[..6]);
    let version = u64::from_be_bytes(version_bytes).max(1);
    initial.zeroize();
    snapshot["version"] = json!(version);
    let bytes = serde_json::to_vec(&snapshot).map_err(|_| "cannot serialize FastLLM configuration");
    clear_json(&mut snapshot);
    Ok((Zeroizing::new(bytes?), version))
}

/// Compare the control snapshot against the exact endpoints and credentials
/// captured by the gateway, including if the database changed and changed back.
pub fn captured_version(
    provider_data: &[ProviderData],
    internal_token: &str,
) -> Result<u64, &'static str> {
    let (_, version) = build_snapshot(provider_data, internal_token)?;
    Ok(version)
}

async fn snapshot(State(state): State<Arc<ControlState>>, headers: HeaderMap) -> Response<Body> {
    let mut authorization = headers.get_all(header::AUTHORIZATION).iter();
    let first = authorization.next();
    if authorization.next().is_some()
        || !first.is_some_and(|h| bool::from(h.as_bytes().ct_eq(state.authorization.as_bytes())))
    {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap();
    }
    let mut markers = headers.get_all("x-redrouter-memory-only").iter();
    if markers.next().is_none_or(|v| v.as_bytes() != b"1") || markers.next().is_some() {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::empty())
            .unwrap();
    }
    if !state.combo.unchanged().await
        || join_all(state.connections.iter().map(ProductConnection::unchanged))
            .await
            .iter()
            .any(|ok| !ok)
    {
        return Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .body(Body::empty())
            .unwrap();
    }
    if headers
        .get(header::IF_NONE_MATCH)
        .is_some_and(|v| v.as_bytes() == state.etag.as_bytes())
    {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::CACHE_CONTROL, "no-store")
            .body(Body::empty())
            .unwrap();
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ETAG, state.etag.as_str())
        // Keep the owned response buffer zeroizing until Hyper releases its
        // last reference, rather than dropping an ordinary plaintext Vec.
        .body(Body::from(axum::body::Bytes::from_owner(Zeroizing::new(
            state.snapshot.to_vec(),
        ))))
        .unwrap()
}

/// The service is loopback-only, emits secrets only to a caller that proves
/// the configured token and requests memory-only operation, and never logs
/// the snapshot. The gateway must still guard every client request.
pub async fn serve(
    path: &Path,
    combo: &str,
    internal_token: &str,
    control_token: &str,
    storage_key: Option<&str>,
    address: SocketAddr,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (_, _, task) = start(
        path,
        combo,
        internal_token,
        control_token,
        storage_key,
        address,
    )
    .await?;
    task.await??;
    Ok(())
}

pub async fn start(
    path: &Path,
    combo: &str,
    internal_token: &str,
    control_token: &str,
    storage_key: Option<&str>,
    address: SocketAddr,
) -> Result<
    (
        SocketAddr,
        u64,
        tokio::task::JoinHandle<std::io::Result<()>>,
    ),
    Box<dyn std::error::Error + Send + Sync>,
> {
    if !address.ip().is_loopback() {
        return Err("FastLLM control must listen on loopback".into());
    }
    let state = prepare(path, combo, internal_token, control_token, storage_key).await?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    let bound = listener.local_addr()?;
    let version = state.version;
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route("/snapshot", get(snapshot))
                .with_state(state),
        )
        .await
    });
    Ok((bound, version, task))
}

#[cfg(test)]
mod tests {
    use super::{captured_version, ProviderData};
    use zeroize::Zeroizing;

    #[test]
    fn fingerprint_changes_with_captured_credential_or_provider() {
        let item = |base, key: &str| -> Vec<ProviderData> {
            vec![("model".into(), base, Zeroizing::new(key.into()))]
        };
        let token = "fixture-internal-fastllm-token-1234567890";
        let first = item("https://example.test/v1", "credential-a");
        let different_key = item("https://example.test/v1", "credential-b");
        let different_base = item("https://other.test/v1", "credential-a");
        let expected = captured_version(&first, token).unwrap();
        assert_eq!(expected, captured_version(&first, token).unwrap());
        assert_ne!(expected, captured_version(&different_key, token).unwrap());
        assert_ne!(expected, captured_version(&different_base, token).unwrap());
    }
}
