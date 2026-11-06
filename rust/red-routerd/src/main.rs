use axum::serve::ListenerExt;
use red_routerd::{
    product::ProductConnection,
    router,
    storage::{embedded_default_url, sqlite_default_url, Backend, Database},
    ProxyState,
};
use std::{env, error::Error, net::SocketAddr};

fn main() -> Result<(), Box<dyn Error + Send + Sync>> {
    // RedDB initialization uses a deeper call stack than Windows' default
    // executable thread stack. Keep it off the network worker threads.
    std::thread::Builder::new()
        .name("red-routerd-main".into())
        .stack_size(8 * 1024 * 1024)
        .spawn(|| {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()?;
            runtime.block_on(run())
        })?
        .join()
        .map_err(|_| "router initialization thread panicked")?
}

async fn run() -> Result<(), Box<dyn Error + Send + Sync>> {
    let mut args = env::args().skip(1);
    let command = args.next();
    if args.next().is_some() || !matches!(command.as_deref(), None | Some("set-upstream")) {
        return Err("usage: red-routerd [set-upstream]".into());
    }
    let address: SocketAddr = env::var("RED_ROUTER_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:19091".into())
        .parse()?;
    if !address.ip().is_loopback() {
        return Err("this development slice only listens on loopback".into());
    }
    if let Some(path) = env::var_os("RED_ROUTER_PRODUCT_DB_PATH") {
        if command.is_some() {
            return Err("set-upstream is not available with a product connection".into());
        }
        for name in [
            "RED_ROUTER_UPSTREAM_URL",
            "RED_ROUTER_PROVIDER_KEY",
            "RED_ROUTER_ROUTES_JSON",
            "RED_ROUTER_DATABASE_URL",
            "RED_ROUTER_DB_BACKEND",
        ] {
            if env::var_os(name).is_some() {
                return Err("product connection mode cannot be combined with separate upstream, route, credential, or database configuration".into());
            }
        }
        let (id, auto_selection) = match (env::var("RED_ROUTER_PRODUCT_CONNECTION_ID"), env::var("RED_ROUTER_PRODUCT_PROVIDER")) {
            (Ok(id), Err(env::VarError::NotPresent)) => (id, false),
            (Err(env::VarError::NotPresent), Ok(provider)) => {
                (ProductConnection::select_fill_first(std::path::Path::new(&path), &provider).await?, true)
            }
            _ => return Err("set exactly one of RED_ROUTER_PRODUCT_CONNECTION_ID or RED_ROUTER_PRODUCT_PROVIDER".into()),
        };
        let product_client_keys = match env::var("RED_ROUTER_PRODUCT_CLIENT_KEYS").as_deref() {
            Ok("1") => true,
            Err(env::VarError::NotPresent) | Ok("0") => false,
            _ => return Err("RED_ROUTER_PRODUCT_CLIENT_KEYS must be 0 or 1".into()),
        };
        let shared_rpm = match env::var("RED_ROUTER_PRODUCT_SHARED_RPM").as_deref() {
            Ok("1") => true,
            Err(env::VarError::NotPresent) | Ok("0") => false,
            _ => return Err("RED_ROUTER_PRODUCT_SHARED_RPM must be 0 or 1".into()),
        };
        if shared_rpm && !product_client_keys {
            return Err("shared RPM accounting requires product client keys".into());
        }
        let account_fallback = match env::var("RED_ROUTER_PRODUCT_ACCOUNT_FALLBACK").as_deref() {
            Ok("1") => true,
            Err(env::VarError::NotPresent) | Ok("0") => false,
            _ => return Err("RED_ROUTER_PRODUCT_ACCOUNT_FALLBACK must be 0 or 1".into()),
        };
        if account_fallback && (!auto_selection || !product_client_keys) {
            return Err(
                "account fallback requires automatic selection and product client keys".into(),
            );
        }
        let client_key = if product_client_keys {
            if env::var_os("RED_ROUTER_CLIENT_KEY").is_some()
                || env::var_os("RED_ROUTER_CLIENT_POLICIES_JSON").is_some()
            {
                return Err("product client keys cannot be combined with environment client keys or policies".into());
            }
            if env::var("DEFAULT_RATE_LIMIT_PER_DAY")
                .is_ok_and(|v| !v.trim().is_empty() && v.trim() != "0")
            {
                return Err("product default request limits are unsupported".into());
            }
            // Unreachable as client authentication switches to the product DB.
            "product-client-auth-placeholder".to_owned()
        } else {
            env::var("RED_ROUTER_CLIENT_KEY")?
        };
        let storage_key = env::var("STORAGE_ENCRYPTION_KEY")
            .ok()
            .map(zeroize::Zeroizing::new);
        let (mut connection, credential) = ProductConnection::open(
            std::path::Path::new(&path),
            &id,
            storage_key.as_deref().map(String::as_str),
        )
        .await?;
        if auto_selection {
            connection = connection.with_auto_selection_guard();
        }
        if shared_rpm {
            connection = connection.with_shared_rpm().await?;
        }
        let mut fallbacks = Vec::new();
        if account_fallback {
            for fallback_id in connection.fallback_ids().await? {
                if let Ok((fallback, key)) = ProductConnection::open(
                    std::path::Path::new(&path),
                    &fallback_id,
                    storage_key.as_deref().map(String::as_str),
                )
                .await
                {
                    fallbacks.push((fallback.inherit_accounting(&connection)?, key.to_string()));
                }
            }
        }
        let mut state = ProxyState::new(connection.upstream_url(), &client_key, &credential, false)
            .await?
            .with_product_connection(connection);
        if product_client_keys {
            state = state.with_product_client_keys()?;
        }
        if account_fallback {
            state = state.with_product_fallbacks(fallbacks)?;
        }
        match env::var("RED_ROUTER_CLIENT_POLICIES_JSON") {
            Ok(policies) => {
                state = state.with_client_policies(&policies, |name| env::var(name).ok())?
            }
            Err(env::VarError::NotPresent) => {}
            Err(_) => return Err("RED_ROUTER_CLIENT_POLICIES_JSON must be valid Unicode".into()),
        }
        eprintln!("Experimental product mode: only a restricted subset of product policies and quota accounting is supported");
        return serve_proxy(address, state).await;
    }
    let backend_setting = match env::var("RED_ROUTER_DB_BACKEND") {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => None,
        Err(_) => return Err("RED_ROUTER_DB_BACKEND must be valid Unicode".into()),
    };
    let backend = Backend::parse(backend_setting.as_deref().unwrap_or("sqlite"))?;
    let database_url = match env::var("RED_ROUTER_DATABASE_URL") {
        Ok(url) => url,
        Err(env::VarError::NotPresent) if backend == Backend::ReddbEmbedded => {
            embedded_default_url()?
        }
        Err(env::VarError::NotPresent) if backend == Backend::Sqlite => {
            if backend_setting.is_none() {
                let directory = env::current_dir()?;
                if directory.join("red-router.rdb").try_exists()?
                    && !directory.join("red-router.sqlite").try_exists()?
                {
                    return Err("existing default RedDB found; explicitly select sqlite or reddb-embedded to choose the database authority".into());
                }
            }
            sqlite_default_url()?
        }
        Err(env::VarError::NotPresent) => {
            return Err("RED_ROUTER_DATABASE_URL is required for the selected backend".into())
        }
        Err(_) => return Err("RED_ROUTER_DATABASE_URL must be valid Unicode".into()),
    };
    let db = Database::connect(backend, &database_url).await?;
    let client_key = env::var("RED_ROUTER_CLIENT_KEY")?;
    let provider_key = env::var("RED_ROUTER_PROVIDER_KEY")?;
    let allow_private = env::var("RED_ROUTER_ALLOW_PRIVATE_UPSTREAM").as_deref() == Ok("1");
    let requested = env::var("RED_ROUTER_UPSTREAM_URL").ok();
    if command.as_deref() == Some("set-upstream") {
        let upstream = requested.ok_or("RED_ROUTER_UPSTREAM_URL is required")?;
        ProxyState::new(&upstream, &client_key, &provider_key, allow_private).await?;
        db.set_upstream(&upstream).await?;
        db.close().await?;
        println!("Upstream configuration saved; restart the proxy to apply it");
        return Ok(());
    }
    let upstream = match db.upstream().await? {
        Some(value) => value,
        None => {
            let candidate = requested
                .ok_or("RED_ROUTER_UPSTREAM_URL is required to initialize an empty database")?;
            ProxyState::new(&candidate, &client_key, &provider_key, allow_private).await?;
            db.seed(&candidate).await?;
            db.upstream()
                .await?
                .ok_or("database configuration was not visible after initialization")?
        }
    };
    let mut state = ProxyState::new(&upstream, &client_key, &provider_key, allow_private).await?;
    match env::var("RED_ROUTER_ROUTES_JSON") {
        Ok(routes) => {
            state = state
                .with_routes(&routes, |name| env::var(name).ok(), allow_private)
                .await?
        }
        Err(env::VarError::NotPresent) => {}
        Err(_) => return Err("RED_ROUTER_ROUTES_JSON must be valid Unicode".into()),
    }
    match env::var("RED_ROUTER_CLIENT_POLICIES_JSON") {
        Ok(policies) => {
            state = state.with_client_policies(&policies, |name| env::var(name).ok())?
        }
        Err(env::VarError::NotPresent) => {}
        Err(_) => return Err("RED_ROUTER_CLIENT_POLICIES_JSON must be valid Unicode".into()),
    }
    serve_proxy(address, state).await?;
    db.close().await?;
    Ok(())
}

async fn serve_proxy(
    address: SocketAddr,
    state: ProxyState,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!(
        "red-routerd development slice listening on {}",
        listener.local_addr()?
    );
    // Streaming frequently sends small SSE chunks; avoid Nagle delaying them
    // while waiting for an ACK from the client.
    let listener = listener.tap_io(|socket| {
        if let Err(error) = socket.set_nodelay(true) {
            eprintln!("failed to enable TCP_NODELAY: {error}");
        }
    });
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
