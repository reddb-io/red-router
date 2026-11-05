use red_routerd::{
    router,
    storage::{embedded_default_url, Backend, Database},
    ProxyState,
};
use std::{env, error::Error, net::SocketAddr};

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
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
    let backend = Backend::parse(
        &env::var("RED_ROUTER_DB_BACKEND").unwrap_or_else(|_| "reddb-embedded".into()),
    )?;
    let database_url = match env::var("RED_ROUTER_DATABASE_URL") {
        Ok(url) => url,
        Err(_) if backend == Backend::ReddbEmbedded => embedded_default_url()?,
        Err(_) => {
            return Err("RED_ROUTER_DATABASE_URL is required for the selected backend".into())
        }
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
    let state = ProxyState::new(&upstream, &client_key, &provider_key, allow_private).await?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!(
        "red-routerd development slice listening on {}",
        listener.local_addr()?
    );
    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    db.close().await?;
    Ok(())
}
