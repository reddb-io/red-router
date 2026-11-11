use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Json, Router,
};
use percent_encoding::percent_decode_str;
use std::{
    io,
    path::{Path, PathBuf},
    sync::Arc,
};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; media-src 'self' data: blob:; connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:* https: ws: wss:; worker-src 'self' blob:; manifest-src 'self'";
const MAX_ASSET_ENTRIES: usize = 100_000;

/// A trusted, immutable dashboard build directory validated at process startup.
#[derive(Clone, Debug)]
pub struct SpaAssets {
    root: Arc<PathBuf>,
    index: Arc<PathBuf>,
}

impl SpaAssets {
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let root = std::fs::canonicalize(path.as_ref()).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("could not open RED_ROUTER_SPA_DIR: {error}"),
            )
        })?;
        if !std::fs::metadata(&root)?.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "RED_ROUTER_SPA_DIR must be a directory",
            ));
        }
        validate_tree(&root)?;
        let index = root.join("index.html");
        let metadata = std::fs::symlink_metadata(&index).map_err(|error| {
            io::Error::new(
                error.kind(),
                format!("RED_ROUTER_SPA_DIR must contain index.html: {error}"),
            )
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "RED_ROUTER_SPA_DIR/index.html must be a regular file",
            ));
        }
        Ok(Self {
            root: Arc::new(root),
            index: Arc::new(index),
        })
    }
}

fn validate_tree(root: &Path) -> io::Result<()> {
    let mut pending = vec![root.to_owned()];
    let mut entries = 0usize;
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            entries = entries.checked_add(1).ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidInput, "static asset count overflow")
            })?;
            if entries > MAX_ASSET_ENTRIES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "RED_ROUTER_SPA_DIR contains too many entries",
                ));
            }
            let file_type = entry.file_type()?;
            if file_type.is_symlink() || (!file_type.is_dir() && !file_type.is_file()) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "RED_ROUTER_SPA_DIR may contain only regular files and directories",
                ));
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            }
        }
    }
    Ok(())
}

pub fn attach(app: Router, assets: SpaAssets) -> Router {
    let spa = Router::new().fallback(serve).with_state(assets);
    app.merge(spa)
}

async fn serve(State(assets): State<SpaAssets>, request: Request) -> Response {
    let method = request.method().clone();
    let raw_path = request.uri().path().to_owned();
    let Some(path) = safe_path(&raw_path) else {
        return not_found();
    };
    if reserved_path(&path) {
        return not_found();
    }
    if method != Method::GET && method != Method::HEAD {
        return method_not_allowed();
    }

    let navigation = navigation_request(&path, &request);
    let served = if navigation {
        let page = exported_page(&assets, &path).await;
        ServeFile::new(page)
            .precompressed_br()
            .precompressed_gzip()
            .oneshot(request)
            .await
    } else {
        ServeDir::new(assets.root.as_ref())
            .precompressed_br()
            .precompressed_gzip()
            .append_index_html_on_directories(false)
            .oneshot(request)
            .await
    };
    let mut response = match served {
        Ok(response) => response.map(Body::new),
        Err(never) => match never {},
    };
    add_security_headers(&mut response, &path, navigation);
    response
}

// Next's static export can use either route.html or route/index.html depending
// on trailingSlash. Missing routes retain support for a single-shell SPA.
async fn exported_page(assets: &SpaAssets, path: &str) -> PathBuf {
    let relative = path.trim_matches('/');
    if !relative.is_empty() {
        let file = assets.root.join(format!("{relative}.html"));
        let index = assets.root.join(relative).join("index.html");
        for candidate in [file, index] {
            if tokio::fs::metadata(&candidate)
                .await
                .is_ok_and(|metadata| metadata.is_file())
            {
                return candidate;
            }
        }
    }
    assets.index.as_ref().clone()
}

fn safe_path(path: &str) -> Option<String> {
    let decoded = percent_decode_str(path).decode_utf8().ok()?;
    if decoded.contains('\\')
        || decoded.contains('\0')
        || decoded
            .split('/')
            .any(|segment| segment.starts_with('.') && !segment.is_empty())
    {
        return None;
    }
    Some(decoded.into_owned())
}

fn reserved_path(path: &str) -> bool {
    namespace(path, "/api")
        || namespace(path, "/v1")
        || namespace(path, "/v1beta")
        || namespace(path, "/healthz")
        || namespace(path, "/readyz")
        || namespace(path, "/anthropic")
        || namespace(path, "/openai")
        || namespace(path, "/responses")
        || namespace(path, "/codex")
        || matches!(
            path,
            "/metrics" | "/debug" | "/models" | "/chat/completions"
        )
}

fn namespace(path: &str, prefix: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn navigation_request(path: &str, request: &Request) -> bool {
    let leaf = path.trim_end_matches('/').rsplit('/').next().unwrap_or("");
    let browser_document = request
        .headers()
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(',')
                .any(|item| item.trim().starts_with("text/html"))
        })
        || request
            .headers()
            .get("sec-fetch-dest")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value == "document");
    (path == "/" || browser_document) && !leaf.contains('.')
}

fn add_security_headers(response: &mut Response, path: &str, navigation: bool) {
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static(
            "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=()",
        ),
    );
    headers.insert(
        "cross-origin-opener-policy",
        HeaderValue::from_static("same-origin"),
    );
    let cache = if navigation || path == "/index.html" || path == "/sw.js" {
        "no-store"
    } else if path.starts_with("/_next/static/") {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=3600"
    };
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    if path == "/sw.js" {
        headers.insert("service-worker-allowed", HeaderValue::from_static("/"));
    }
}

fn not_found() -> Response {
    let mut response = (
        StatusCode::NOT_FOUND,
        Json(serde_json::json!({
            "error": {"message": "not found", "type": "not_found"}
        })),
    )
        .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn method_not_allowed() -> Response {
    let mut response = (
        StatusCode::METHOD_NOT_ALLOWED,
        Json(serde_json::json!({
            "error": {"message": "method not allowed", "type": "method_not_allowed"}
        })),
    )
        .into_response();
    let headers = response.headers_mut();
    headers.insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
