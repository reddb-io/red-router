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
        let id = env::var("RED_ROUTER_PRODUCT_CONNECTION_ID")?;
        let client_key = env::var("RED_ROUTER_CLIENT_KEY")?;
        let storage_key = env::var("STORAGE_ENCRYPTION_KEY")
            .ok()
            .map(zeroize::Zeroizing::new);
        let (connection, credential) = ProductConnection::open(
            std::path::Path::new(&path),
            &id,
            storage_key.as_deref().map(String::as_str),
        )
        .await?;
        let mut state = ProxyState::new(
            "https://openrouter.ai/api/v1/chat/completions",
            &client_key,
            &credential,
            false,
        )
        .await?
        .with_product_connection(connection);
        match env::var("RED_ROUTER_CLIENT_POLICIES_JSON") {
            Ok(policies) => {
                state = state.with_client_policies(&policies, |name| env::var(name).ok())?
            }
            Err(env::VarError::NotPresent) => {}
            Err(_) => return Err("RED_ROUTER_CLIENT_POLICIES_JSON must be valid Unicode".into()),
        }
        eprintln!("Experimental product credential mode: product API keys, policies, routing, quotas and accounting are not enforced");
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
