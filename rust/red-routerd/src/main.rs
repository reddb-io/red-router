use red_routerd::{router, ProxyState};
use std::{env, error::Error, net::SocketAddr};

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let address: SocketAddr = env::var("RED_ROUTER_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:19091".into())
        .parse()?;
    if !address.ip().is_loopback() {
        return Err("this development slice only listens on loopback".into());
    }
    let state = ProxyState::new(
        &env::var("RED_ROUTER_UPSTREAM_URL")?,
        &env::var("RED_ROUTER_CLIENT_KEY")?,
        &env::var("RED_ROUTER_PROVIDER_KEY")?,
        env::var("RED_ROUTER_ALLOW_PRIVATE_UPSTREAM").as_deref() == Ok("1"),
    )
    .await?;
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
    Ok(())
}
