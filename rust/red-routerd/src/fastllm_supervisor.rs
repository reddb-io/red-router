//! Supervise one private FastLLM process for one immutable dashboard snapshot.
//! A configuration change makes the gateway reject requests until restart.
use crate::ProxyState;
use std::{
    error::Error, future::Future, net::SocketAddr, path::Path, process::Stdio, time::Duration,
};
use tokio::{
    process::{Child, Command},
    task::JoinHandle,
};

type Failure = Box<dyn Error + Send + Sync>;

pub fn random_token() -> Result<zeroize::Zeroizing<String>, &'static str> {
    let mut bytes = zeroize::Zeroizing::new([0u8; 32]);
    getrandom::fill(bytes.as_mut()).map_err(|_| "cannot generate FastLLM token")?;
    Ok(zeroize::Zeroizing::new(hex::encode(bytes.as_ref())))
}

pub async fn reserve_engine_address() -> Result<SocketAddr, Failure> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    Ok(listener.local_addr()?)
}

fn spawn_engine(
    binary: &Path,
    address: SocketAddr,
    control: SocketAddr,
    token: &str,
) -> Result<Child, Failure> {
    let mut command = Command::new(binary);
    command.env_clear();
    // Keep only OS process and certificate-discovery settings. In particular,
    // dashboard credentials and unrelated FASTLLM_* variables are not inherited.
    for key in [
        "PATH",
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            &address.port().to_string(),
            "--role",
            "proxy",
            "--control-url",
            &format!("http://{control}/snapshot"),
            "--redrouter-memory-only",
            "--config-poll",
            "0",
            "--rate-limit-reconcile-interval",
            "0",
            "--shutdown-delay",
            "0",
            "--log",
            "warn",
        ])
        .env("FASTLLM_PROXY_TOKEN", token)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    Ok(command.spawn()?)
}

async fn wait_ready(
    child: &mut Child,
    address: SocketAddr,
    internal: &str,
    version: u64,
) -> Result<(), Failure> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(500))
        .build()?;
    for _ in 0..200 {
        if child.try_wait()?.is_some() {
            return Err("FastLLM exited before readiness".into());
        }
        if let Ok(response) = client
            .get(format!("http://{address}/health"))
            .bearer_auth(internal)
            .send()
            .await
        {
            if response.status().is_success() {
                if let Ok(bytes) = response.bytes().await {
                    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        if value
                            .get("snapshot_version")
                            .and_then(serde_json::Value::as_u64)
                            == Some(version)
                        {
                            return Ok(());
                        }
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("FastLLM did not load the expected snapshot".into())
}

/// Stops the gateway if the control service fails, or after repeated engine
/// crashes. A restarted engine must load the same verified configuration.
pub async fn run<F>(
    binary: &Path,
    engine_address: SocketAddr,
    control_address: SocketAddr,
    control_token: &str,
    internal_token: &str,
    version: u64,
    state: ProxyState,
    mut control_task: JoinHandle<std::io::Result<()>>,
    gateway: F,
) -> Result<(), Failure>
where
    F: Future<Output = Result<(), Failure>>,
{
    let mut child = spawn_engine(binary, engine_address, control_address, control_token)?;
    wait_ready(&mut child, engine_address, internal_token, version).await?;
    if !state.product_configuration_unchanged().await {
        return Err("dashboard configuration changed during FastLLM startup".into());
    }
    tokio::pin!(gateway);
    let mut restarts = 0;
    loop {
        tokio::select! {
            outcome = &mut gateway => { control_task.abort(); return outcome; }
            outcome = &mut control_task => { return Err(format!("FastLLM control stopped: {outcome:?}").into()); }
            outcome = child.wait() => {
                outcome?;
                if restarts >= 3 || !state.product_configuration_unchanged().await {
                    return Err("FastLLM exited or dashboard configuration changed".into());
                }
                restarts += 1;
                tokio::time::sleep(Duration::from_millis(200 * restarts)).await;
                child = spawn_engine(binary, engine_address, control_address, control_token)?;
                wait_ready(&mut child, engine_address, internal_token, version).await?;
                if !state.product_configuration_unchanged().await { return Err("dashboard configuration changed during FastLLM restart".into()); }
            }
        }
    }
}
