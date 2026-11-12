use axum::body::Body;
use red_routerd::{router_with_spa, spa::SpaAssets, ProxyState};
use std::fs;
use tempfile::TempDir;
use tower::ServiceExt;

async fn fixture() -> (TempDir, axum::Router) {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir_all(directory.path().join("_next/static")).unwrap();
    fs::write(
        directory.path().join("index.html"),
        "<!doctype html><title>RedRouter Rust dashboard</title>",
    )
    .unwrap();
    fs::write(
        directory.path().join("_next/static/app.123.js"),
        "globalThis.redRouter = true;",
    )
    .unwrap();
    fs::write(directory.path().join("sw.js"), "// service worker").unwrap();
    fs::write(directory.path().join(".env"), "SECRET=must-not-leak").unwrap();
    let state = ProxyState::new(
        "http://127.0.0.1:1/v1/chat/completions",
        "fixture-client-key-1234567890",
        "provider-key",
        true,
    )
    .await
    .unwrap();
    let assets = SpaAssets::open(directory.path()).unwrap();
    (directory, router_with_spa(state, assets))
}

#[tokio::test]
async fn serves_navigation_and_versioned_assets_with_safe_cache_headers() {
    let (_directory, app) = fixture().await;
    let navigation = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .uri("/dashboard/settings?tab=security")
                .header("accept", "text/html,application/xhtml+xml")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(navigation.status(), axum::http::StatusCode::OK);
    assert_eq!(navigation.headers()["cache-control"], "no-store");
    assert_eq!(navigation.headers()["x-frame-options"], "DENY");
    assert!(navigation.headers().contains_key("content-security-policy"));
    let body = axum::body::to_bytes(navigation.into_body(), 1024)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&body).contains("RedRouter Rust dashboard"));

    let asset = app
        .oneshot(
            axum::http::Request::builder()
                .uri("/_next/static/app.123.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(asset.status(), axum::http::StatusCode::OK);
    assert_eq!(
        asset.headers()["cache-control"],
        "public, max-age=31536000, immutable"
    );
    assert!(asset.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("text/javascript"));
}

#[tokio::test]
async fn never_turns_unknown_api_or_asset_paths_into_spa_html() {
    let (_directory, app) = fixture().await;
    for path in [
        "/api/not-real",
        "/v1/not-real",
        "/missing.js",
        "/.env",
        "/%2eenv",
        "/assets/%2e%2e/.env",
        "/api%2fnot-real",
    ] {
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(path)
                    .header("accept", "text/html")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            axum::http::StatusCode::NOT_FOUND,
            "unexpected status for {path}"
        );
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert!(
            !String::from_utf8_lossy(&body).contains("RedRouter Rust dashboard"),
            "SPA shell leaked into {path}"
        );
    }
}

#[tokio::test]
async fn serves_exported_pages_for_direct_navigation_and_falls_back_to_shell() {
    let (directory, app) = fixture().await;
    fs::create_dir_all(directory.path().join("dashboard/settings")).unwrap();
    fs::write(
        directory.path().join("dashboard/providers.html"),
        "providers page",
    )
    .unwrap();
    fs::write(
        directory.path().join("dashboard/settings/index.html"),
        "settings page",
    )
    .unwrap();
    for (path, expected) in [
        ("/dashboard/providers", "providers page"),
        ("/dashboard/settings/", "settings page"),
        ("/dashboard/unmatched", "RedRouter Rust dashboard"),
    ] {
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .uri(path)
                    .header("accept", "text/html")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&body).contains(expected), "{path}");
    }
}

#[tokio::test]
async fn service_worker_is_not_cached_and_static_post_is_rejected() {
    let (_directory, app) = fixture().await;
    let worker = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .uri("/sw.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(worker.status(), axum::http::StatusCode::OK);
    assert_eq!(worker.headers()["cache-control"], "no-store");
    assert_eq!(worker.headers()["service-worker-allowed"], "/");

    let post = app
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/dashboard")
                .header("accept", "text/html")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(post.status(), axum::http::StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(post.headers()["allow"], "GET, HEAD");
}

#[test]
fn startup_rejects_incomplete_spa_directories() {
    let directory = tempfile::tempdir().unwrap();
    let error = SpaAssets::open(directory.path()).unwrap_err();
    assert!(error.to_string().contains("must contain index.html"));
}
