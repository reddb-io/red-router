use axum::serve::ListenerExt;
use red_routerd::{
    control_plane::{ControlPlane, ProviderInput},
    product::ProductConnection,
    product_combo::ProductCombo,
    router, router_with_spa,
    spa::SpaAssets,
    storage::{embedded_default_url, sqlite_default_url, Backend, Database},
    ProxyState,
};
use std::{env, error::Error, net::SocketAddr, sync::Arc};

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
            runtime.block_on(run_with_reload())
        })?
        .join()
        .map_err(|_| "router initialization thread panicked")?
}

async fn run_with_reload() -> Result<(), Box<dyn Error + Send + Sync>> {
    if env::args_os().nth(1).is_some() || env::var_os("RED_ROUTER_FASTLLM_MANAGED_BINARY").is_none()
    {
        return run(None).await;
    }
    // Keep one shutdown subscription alive across the drain/rebuild gap so a
    // SIGTERM cannot be consumed during reload and followed by a restart.
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        shutdown_signal().await;
        let _ = shutdown_tx.send(true);
    });
    let mut reloading = false;
    loop {
        if *shutdown_rx.borrow() {
            return Ok(());
        }
        match run(Some(shutdown_rx.clone())).await {
            Ok(()) => return Ok(()),
            Err(error)
                if error
                    .downcast_ref::<red_routerd::fastllm_supervisor::ReloadRequired>()
                    .is_some() =>
            {
                reloading = true;
            }
            Err(error) if reloading => {
                eprintln!("waiting for a valid dashboard configuration: {error}");
            }
            Err(error) => return Err(error),
        }
        if *shutdown_rx.borrow() {
            return Ok(());
        }
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {},
            _ = shutdown_rx.changed() => return Ok(()),
        }
    }
}

async fn run(
    shutdown: Option<tokio::sync::watch::Receiver<bool>>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let mut args = env::args().skip(1);
    let command = args.next();
    if command.as_deref() == Some("inspect-legacy-sqlite") {
        if args.next().is_some() {
            return Err(
                "usage: red-routerd inspect-legacy-sqlite (set RED_ROUTER_PRODUCT_DB_PATH)".into(),
            );
        }
        let path = env::var_os("RED_ROUTER_PRODUCT_DB_PATH")
            .ok_or("RED_ROUTER_PRODUCT_DB_PATH is required")?;
        let report = red_routerd::legacy_preflight::inspect(std::path::Path::new(&path)).await?;
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }
    if command.as_deref() == Some("archive-legacy-usage") {
        if args.next().as_deref() != Some("--offline-confirmed") || args.next().is_some() {
            return Err("usage: red-routerd archive-legacy-usage --offline-confirmed (set RED_ROUTER_PRODUCT_DB_PATH and RED_ROUTER_MIGRATION_DEST_PATH; stop both servers first)".into());
        }
        let source = env::var_os("RED_ROUTER_PRODUCT_DB_PATH")
            .ok_or("RED_ROUTER_PRODUCT_DB_PATH is required")?;
        let destination = env::var_os("RED_ROUTER_MIGRATION_DEST_PATH")
            .ok_or("RED_ROUTER_MIGRATION_DEST_PATH is required")?;
        let report = red_routerd::legacy_archive::archive(
            std::path::Path::new(&source),
            std::path::Path::new(&destination),
        )
        .await?;
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }
    if command.as_deref() == Some("import-legacy-provider") {
        let flag = args.next();
        let id = args.next();
        if flag.as_deref() != Some("--offline-confirmed") || id.is_none() || args.next().is_some() {
            return Err("usage: red-routerd import-legacy-provider --offline-confirmed PROVIDER_ID (set RED_ROUTER_PRODUCT_DB_PATH, RED_ROUTER_MIGRATION_DEST_PATH and STORAGE_ENCRYPTION_KEY; stop both servers first)".into());
        }
        let source = env::var_os("RED_ROUTER_PRODUCT_DB_PATH")
            .ok_or("RED_ROUTER_PRODUCT_DB_PATH is required")?;
        let destination = env::var_os("RED_ROUTER_MIGRATION_DEST_PATH")
            .ok_or("RED_ROUTER_MIGRATION_DEST_PATH is required")?;
        let secret = zeroize::Zeroizing::new(env::var("STORAGE_ENCRYPTION_KEY")?);
        let report = red_routerd::legacy_providers::import(
            std::path::Path::new(&source),
            std::path::Path::new(&destination),
            id.as_deref().unwrap_or_default(),
            &secret,
        )
        .await?;
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }
    if command.as_deref() == Some("import-legacy-keys") {
        if args.next().as_deref() != Some("--offline-confirmed") || args.next().is_some() {
            return Err("usage: red-routerd import-legacy-keys --offline-confirmed (set RED_ROUTER_PRODUCT_DB_PATH and RED_ROUTER_MIGRATION_DEST_PATH; stop both servers first)".into());
        }
        let source = env::var_os("RED_ROUTER_PRODUCT_DB_PATH")
            .ok_or("RED_ROUTER_PRODUCT_DB_PATH is required")?;
        let destination = env::var_os("RED_ROUTER_MIGRATION_DEST_PATH")
            .ok_or("RED_ROUTER_MIGRATION_DEST_PATH is required")?;
        let report = red_routerd::legacy_keys::import(
            std::path::Path::new(&source),
            std::path::Path::new(&destination),
        )
        .await?;
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }
    if command.as_deref() == Some("import-legacy-pricing") {
        if args.next().is_some() {
            return Err("usage: red-routerd import-legacy-pricing (set RED_ROUTER_PRODUCT_DB_PATH and RED_ROUTER_MIGRATION_DEST_PATH)".into());
        }
        let source = env::var_os("RED_ROUTER_PRODUCT_DB_PATH")
            .ok_or("RED_ROUTER_PRODUCT_DB_PATH is required")?;
        let destination = env::var_os("RED_ROUTER_MIGRATION_DEST_PATH")
            .ok_or("RED_ROUTER_MIGRATION_DEST_PATH is required")?;
        let report = red_routerd::legacy_preflight::import_pricing(
            std::path::Path::new(&source),
            std::path::Path::new(&destination),
        )
        .await?;
        println!("{}", serde_json::to_string_pretty(&report)?);
        return Ok(());
    }
    if command.as_deref() == Some("fastllm-control") {
        if args.next().is_some() {
            return Err("usage: red-routerd fastllm-control".into());
        }
        let path = env::var_os("RED_ROUTER_PRODUCT_DB_PATH")
            .ok_or("RED_ROUTER_PRODUCT_DB_PATH is required")?;
        let combo = env::var("RED_ROUTER_PRODUCT_COMBO")?;
        let internal = zeroize::Zeroizing::new(env::var("RED_ROUTER_FASTLLM_INTERNAL_KEY")?);
        let control = zeroize::Zeroizing::new(env::var("RED_ROUTER_FASTLLM_CONTROL_TOKEN")?);
        let storage = env::var("STORAGE_ENCRYPTION_KEY")
            .ok()
            .map(zeroize::Zeroizing::new);
        let address: SocketAddr = env::var("RED_ROUTER_FASTLLM_CONTROL_LISTEN")
            .unwrap_or_else(|_| "127.0.0.1:19092".into())
            .parse()?;
        return red_routerd::fastllm_control::serve(
            std::path::Path::new(&path),
            &combo,
            internal.as_str(),
            control.as_str(),
            storage.as_deref().map(String::as_str),
            address,
        )
        .await;
    }
    if command.as_deref() == Some("fastllm-route-plan") {
        let name = args
            .next()
            .ok_or("usage: red-routerd fastllm-route-plan <combo-name>")?;
        if args.next().is_some() {
            return Err("usage: red-routerd fastllm-route-plan <combo-name>".into());
        }
        let path = env::var_os("RED_ROUTER_PRODUCT_DB_PATH")
            .ok_or("RED_ROUTER_PRODUCT_DB_PATH is required")?;
        let plan =
            red_routerd::fastllm_plan::single_target_plan(std::path::Path::new(&path), &name)
                .await?;
        println!("{}", serde_json::to_string(&plan)?);
        return Ok(());
    }
    if matches!(
        command.as_deref(),
        Some("list-usage-reservations" | "reconcile-usage" | "cancel-undispatched")
    ) {
        let path = env::var_os("RED_ROUTER_PRODUCT_DB_PATH")
            .ok_or("RED_ROUTER_PRODUCT_DB_PATH is required")?;
        let path = std::path::Path::new(&path);
        match command.as_deref() {
            Some("list-usage-reservations") => {
                if args.next().is_some() {
                    return Err("usage: red-routerd list-usage-reservations".into());
                }
                println!(
                    "{}",
                    serde_json::to_string_pretty(&red_routerd::reconcile::list(path).await?)?
                );
            }
            Some("reconcile-usage") => {
                use std::io::Read as _;
                let id = args
                    .next()
                    .ok_or("usage: red-routerd reconcile-usage <reservation-id> <usage.json>")?;
                let file = args
                    .next()
                    .ok_or("usage: red-routerd reconcile-usage <reservation-id> <usage.json>")?;
                if args.next().is_some() {
                    return Err(
                        "usage: red-routerd reconcile-usage <reservation-id> <usage.json>".into(),
                    );
                }
                let mut data = Vec::new();
                std::fs::File::open(file)?
                    .take(1_048_577)
                    .read_to_end(&mut data)?;
                if data.len() > 1_048_576 {
                    return Err("usage JSON file is too large".into());
                }
                let response: serde_json::Value = serde_json::from_slice(&data)?;
                red_routerd::reconcile::reconcile(path, &id, &response).await?;
                println!("Usage reconciled");
            }
            Some("cancel-undispatched") => {
                let id = args
                    .next()
                    .ok_or("usage: red-routerd cancel-undispatched <reservation-id>")?;
                if args.next().is_some() {
                    return Err("usage: red-routerd cancel-undispatched <reservation-id>".into());
                }
                if !red_routerd::reconcile::cancel_undispatched(path, &id).await? {
                    return Err("reservation is missing or was already dispatched".into());
                }
                println!("Undispatched reservation cancelled");
            }
            _ => unreachable!(),
        }
        return Ok(());
    }
    if args.next().is_some() || !matches!(command.as_deref(), None | Some("set-upstream")) {
        return Err("usage: red-routerd [set-upstream|fastllm-route-plan|inspect-legacy-sqlite|import-legacy-pricing|import-legacy-keys|import-legacy-provider|archive-legacy-usage|list-usage-reservations|reconcile-usage|cancel-undispatched]".into());
    }
    let address: SocketAddr = env::var("RED_ROUTER_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:19091".into())
        .parse()?;
    if !address.ip().is_loopback() {
        return Err("this development slice only listens on loopback".into());
    }
    let max_in_flight = match env::var("RED_ROUTER_MAX_IN_FLIGHT") {
        Ok(value) => Some(
            value
                .parse::<usize>()
                .map_err(|_| "invalid RED_ROUTER_MAX_IN_FLIGHT")?,
        ),
        Err(env::VarError::NotPresent) => None,
        Err(_) => return Err("invalid RED_ROUTER_MAX_IN_FLIGHT".into()),
    };
    let antigravity_credits_mode = match env::var("ANTIGRAVITY_CREDITS") {
        Ok(value) => value,
        Err(env::VarError::NotPresent) => "off".to_owned(),
        Err(_) => return Err("ANTIGRAVITY_CREDITS must be valid Unicode".into()),
    };
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
        let combo = match env::var("RED_ROUTER_PRODUCT_COMBO") {
            Ok(name) => Some(ProductCombo::load(std::path::Path::new(&path), &name).await?),
            Err(env::VarError::NotPresent) => None,
            Err(_) => return Err("RED_ROUTER_PRODUCT_COMBO must be valid Unicode".into()),
        };
        let combo_name = combo.as_ref().map(|value| value.name().to_owned());
        let (id, auto_selection) = if let Some(combo) = &combo {
            if env::var_os("RED_ROUTER_PRODUCT_CONNECTION_ID").is_some()
                || env::var_os("RED_ROUTER_PRODUCT_PROVIDER").is_some()
            {
                return Err(
                    "product combo cannot be combined with provider or connection selection".into(),
                );
            }
            (
                ProductConnection::select_fill_first(
                    std::path::Path::new(&path),
                    &combo.targets[0].provider,
                )
                .await?,
                true,
            )
        } else {
            match (env::var("RED_ROUTER_PRODUCT_CONNECTION_ID"), env::var("RED_ROUTER_PRODUCT_PROVIDER")) {
            (Ok(id), Err(env::VarError::NotPresent)) => (id, false),
            (Err(env::VarError::NotPresent), Ok(provider)) => {
                (ProductConnection::select_fill_first(std::path::Path::new(&path), &provider).await?, true)
            }
            _ => return Err("set exactly one of RED_ROUTER_PRODUCT_CONNECTION_ID or RED_ROUTER_PRODUCT_PROVIDER".into()),
        }
        };
        let product_client_keys = match env::var("RED_ROUTER_PRODUCT_CLIENT_KEYS").as_deref() {
            Ok("1") => true,
            Err(env::VarError::NotPresent) | Ok("0") => false,
            _ => return Err("RED_ROUTER_PRODUCT_CLIENT_KEYS must be 0 or 1".into()),
        };
        let managed_binary = env::var_os("RED_ROUTER_FASTLLM_MANAGED_BINARY");
        let managed = if let Some(binary) = managed_binary {
            if env::var_os("RED_ROUTER_FASTLLM_URL").is_some()
                || env::var_os("RED_ROUTER_FASTLLM_INTERNAL_KEY").is_some()
                || env::var_os("RED_ROUTER_FASTLLM_CONTROL_TOKEN").is_some()
            {
                return Err("managed FastLLM cannot be combined with externally configured FastLLM tokens or URLs".into());
            }
            if !product_client_keys || combo.is_none() {
                return Err("managed FastLLM requires dashboard keys and a priority combo".into());
            }
            Some((
                std::path::PathBuf::from(binary),
                red_routerd::fastllm_supervisor::reserve_engine_address().await?,
                red_routerd::fastllm_supervisor::random_token()?,
                red_routerd::fastllm_supervisor::random_token()?,
            ))
        } else {
            None
        };
        let external_transport = match (
            env::var("RED_ROUTER_FASTLLM_URL"),
            env::var("RED_ROUTER_FASTLLM_INTERNAL_KEY"),
        ) {
            (Err(env::VarError::NotPresent), Err(env::VarError::NotPresent)) => None,
            (Ok(url), Ok(token)) => {
                red_routerd::fastllm_plan::validate_transport(&url, &token)?;
                if !product_client_keys || combo.is_none() {
                    return Err(
                        "FastLLM transport requires dashboard keys and a priority combo".into(),
                    );
                }
                let mut names = std::collections::HashSet::new();
                if combo
                    .as_ref()
                    .is_some_and(|c| c.targets.iter().any(|t| !names.insert(t.model.as_str())))
                {
                    return Err(
                        "FastLLM transport requires unique upstream model names within a combo"
                            .into(),
                    );
                }
                Some((url, zeroize::Zeroizing::new(token)))
            }
            _ => {
                return Err(
                    "set both RED_ROUTER_FASTLLM_URL and RED_ROUTER_FASTLLM_INTERNAL_KEY".into(),
                )
            }
        };
        let fastllm_transport = if let Some((_, address, internal, _)) = &managed {
            let mut names = std::collections::HashSet::new();
            if combo
                .as_ref()
                .is_some_and(|c| c.targets.iter().any(|t| !names.insert(t.model.as_str())))
            {
                return Err(
                    "FastLLM transport requires unique upstream model names within a combo".into(),
                );
            }
            Some((
                format!("http://{address}/v1/chat/completions"),
                internal.clone(),
            ))
        } else {
            external_transport
        };
        let shared_rpm = match env::var("RED_ROUTER_PRODUCT_SHARED_RPM").as_deref() {
            Ok("1") => true,
            Err(env::VarError::NotPresent) | Ok("0") => false,
            _ => return Err("RED_ROUTER_PRODUCT_SHARED_RPM must be 0 or 1".into()),
        };
        if shared_rpm && !product_client_keys {
            return Err("shared RPM accounting requires product client keys".into());
        }
        let usage_accounting = match env::var("RED_ROUTER_PRODUCT_ACCOUNT_USAGE").as_deref() {
            Ok("1") => true,
            Err(env::VarError::NotPresent) | Ok("0") => false,
            _ => return Err("RED_ROUTER_PRODUCT_ACCOUNT_USAGE must be 0 or 1".into()),
        };
        if usage_accounting && !product_client_keys {
            return Err("usage accounting requires product client keys".into());
        }
        let report_all_usage = match env::var("REDROUTER_USAGE_REPORT_ALL_REQUESTS").as_deref() {
            Ok("true") | Ok("1") => true,
            Err(env::VarError::NotPresent) | Ok("false") | Ok("0") => false,
            _ => {
                return Err(
                    "REDROUTER_USAGE_REPORT_ALL_REQUESTS must be true, false, 1 or 0".into(),
                )
            }
        };
        if report_all_usage && !usage_accounting {
            return Err("all-request reporting requires product usage accounting".into());
        }
        let strict_quotas = match env::var("RED_ROUTER_PRODUCT_STRICT_QUOTAS").as_deref() {
            Ok("1") => true,
            Err(env::VarError::NotPresent) | Ok("0") => false,
            _ => return Err("RED_ROUTER_PRODUCT_STRICT_QUOTAS must be 0 or 1".into()),
        };
        let concurrent_quotas = match env::var("RED_ROUTER_PRODUCT_CONCURRENT_QUOTAS").as_deref() {
            Ok("1") => true,
            Err(env::VarError::NotPresent) | Ok("0") => false,
            _ => return Err("RED_ROUTER_PRODUCT_CONCURRENT_QUOTAS must be 0 or 1".into()),
        };
        if concurrent_quotas && !strict_quotas {
            return Err("concurrent quotas require strict quotas".into());
        }
        if strict_quotas && (!usage_accounting || !shared_rpm) {
            return Err("strict quotas require product usage accounting and shared RPM".into());
        }
        if strict_quotas && fastllm_transport.is_some() && !concurrent_quotas {
            return Err("FastLLM token and spend quotas require concurrent quota admission".into());
        }
        let account_fallback = match env::var("RED_ROUTER_PRODUCT_ACCOUNT_FALLBACK").as_deref() {
            Ok("1") => true,
            Err(env::VarError::NotPresent) | Ok("0") => false,
            _ => return Err("RED_ROUTER_PRODUCT_ACCOUNT_FALLBACK must be 0 or 1".into()),
        };
        if combo.is_some() && (!product_client_keys || account_fallback) {
            return Err(
                "product combo requires product client keys and no account fallback".into(),
            );
        }
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
        if let Ok(attributes) = env::var("REDROUTER_USAGE_ATTRIBUTES_JSON") {
            connection = connection.with_instance_usage_attributes(&attributes)?;
        }
        if fastllm_transport
            .as_ref()
            .is_some_and(|(_, token)| token.as_str() == credential.as_str())
        {
            return Err("FastLLM internal token must differ from the provider credential".into());
        }
        if let Some((_, token)) = &fastllm_transport {
            if connection.dashboard_key_exists(token).await? {
                return Err("FastLLM internal token must differ from all dashboard keys".into());
            }
        }
        if auto_selection {
            connection = connection.with_auto_selection_guard();
        }
        if shared_rpm {
            connection = connection.with_shared_rpm().await?;
        }
        if usage_accounting {
            connection = connection.with_usage_accounting().await?;
        }
        if report_all_usage {
            connection = connection.with_all_usage_reporting()?;
        }
        if strict_quotas {
            let tokens: i64 = env::var("RED_ROUTER_PRODUCT_RESERVE_TOKENS")?.parse()?;
            let usd: f64 = env::var("RED_ROUTER_PRODUCT_RESERVE_USD")?.parse()?;
            connection = if concurrent_quotas {
                connection.with_concurrent_strict_usage(tokens, usd)?
            } else {
                connection.with_strict_usage(tokens, usd)?
            };
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
        let mut combo_connections = Vec::new();
        let mut combo_keys = Vec::new();
        let mut managed_provider_data: Vec<red_routerd::fastllm_control::ProviderData> = Vec::new();
        let mut combo_route = None;
        if let Some(combo) = &combo {
            let mut targets = Vec::new();
            for (index, target) in combo.targets.iter().enumerate() {
                let (source, key) = if index == 0 {
                    (
                        connection.clone(),
                        zeroize::Zeroizing::new(credential.to_string()),
                    )
                } else {
                    let target_id = ProductConnection::select_fill_first(
                        std::path::Path::new(&path),
                        &target.provider,
                    )
                    .await?;
                    let (source, key) = ProductConnection::open(
                        std::path::Path::new(&path),
                        &target_id,
                        storage_key.as_deref().map(String::as_str),
                    )
                    .await?;
                    (
                        source
                            .with_auto_selection_guard()
                            .inherit_accounting(&connection)?,
                        key,
                    )
                };
                if fastllm_transport
                    .as_ref()
                    .is_some_and(|(_, token)| token.as_str() == key.as_str())
                {
                    return Err(
                        "FastLLM internal token must differ from every provider credential".into(),
                    );
                }
                if managed.is_some() {
                    let api_base = source
                        .upstream_url()
                        .strip_suffix("/chat/completions")
                        .ok_or("unsupported FastLLM provider URL")?;
                    managed_provider_data.push((
                        target.model.clone(),
                        api_base,
                        zeroize::Zeroizing::new(key.to_string()),
                    ));
                }
                let (url, key) = match &fastllm_transport {
                    Some((url, token)) => {
                        (url.as_str(), zeroize::Zeroizing::new(token.to_string()))
                    }
                    None => (source.upstream_url(), key),
                };
                targets.push(serde_json::json!({"url":url,"model":target.model,"api_key_env":format!("KEY_{index}")}));
                combo_connections.push(source);
                combo_keys.push(key);
            }
            combo_route = Some(
                serde_json::json!([{"model":combo.name(),"fallback":true,"targets":targets}])
                    .to_string(),
            );
        }
        let mut state = ProxyState::new(connection.upstream_url(), &client_key, &credential, false)
            .await?
            .with_antigravity_credits_mode(&antigravity_credits_mode)?;
        if let Some(limit) = max_in_flight {
            state = state.with_max_in_flight(limit)?;
        }
        if let Some(config) = combo_route {
            state = state
                .with_routes(
                    &config,
                    |name| {
                        name.strip_prefix("KEY_")
                            .and_then(|n| n.parse::<usize>().ok())
                            .and_then(|n| combo_keys.get(n))
                            .map(|key| key.to_string())
                    },
                    false,
                )
                .await?;
        }
        state = state.with_product_connection(connection);
        if let Some(combo) = combo {
            state = state.with_product_combo(combo, combo_connections)?;
        }
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
        if let Some((binary, engine_address, internal, control)) = managed {
            let (control_address, version, control_task) = red_routerd::fastllm_control::start(
                std::path::Path::new(&path),
                combo_name
                    .as_deref()
                    .ok_or("managed FastLLM needs a combo")?,
                internal.as_str(),
                control.as_str(),
                storage_key.as_deref().map(String::as_str),
                "127.0.0.1:0".parse()?,
                true,
            )
            .await?;
            let captured = red_routerd::fastllm_control::captured_version(
                &managed_provider_data,
                internal.as_str(),
            )?;
            drop(managed_provider_data);
            if captured != version {
                control_task.abort();
                return Err(Box::new(red_routerd::fastllm_supervisor::ReloadRequired));
            }
            let (reload_tx, reload_rx) = tokio::sync::oneshot::channel();
            let supervisor_shutdown = shutdown
                .as_ref()
                .ok_or("managed shutdown handler unavailable")?
                .clone();
            let gateway = serve_proxy(address, state.clone(), Some(reload_rx), shutdown);
            return red_routerd::fastllm_supervisor::run(
                red_routerd::fastllm_supervisor::Config {
                    binary: &binary,
                    engine_address,
                    control_address,
                    control_token: control.as_str(),
                    internal_token: internal.as_str(),
                    version,
                },
                state,
                control_task,
                reload_tx,
                supervisor_shutdown,
                gateway,
            )
            .await;
        }
        return serve_proxy(address, state, None, shutdown).await;
    }
    if env::var_os("RED_ROUTER_FASTLLM_MANAGED_BINARY").is_some()
        || env::var_os("RED_ROUTER_FASTLLM_URL").is_some()
        || env::var_os("RED_ROUTER_FASTLLM_INTERNAL_KEY").is_some()
    {
        return Err("FastLLM transport requires RED_ROUTER_PRODUCT_DB_PATH".into());
    }
    match env::var("RED_ROUTER_PRODUCT_ACCOUNT_USAGE").as_deref() {
        Ok("1") => {
            return Err("product usage accounting requires RED_ROUTER_PRODUCT_DB_PATH".into())
        }
        Err(env::VarError::NotPresent) | Ok("0") => {}
        _ => return Err("RED_ROUTER_PRODUCT_ACCOUNT_USAGE must be 0 or 1".into()),
    }
    match env::var("REDROUTER_USAGE_REPORT_ALL_REQUESTS").as_deref() {
        Ok("true") | Ok("1") => {
            return Err("all-request reporting requires RED_ROUTER_PRODUCT_DB_PATH".into())
        }
        Err(env::VarError::NotPresent) | Ok("false") | Ok("0") => {}
        _ => return Err("REDROUTER_USAGE_REPORT_ALL_REQUESTS must be true, false, 1 or 0".into()),
    }
    if env::var_os("RED_ROUTER_PRODUCT_STRICT_QUOTAS").is_some_and(|v| v != "0") {
        return Err("strict quotas require RED_ROUTER_PRODUCT_DB_PATH".into());
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
    let db = Arc::new(Database::connect(backend, &database_url).await?);
    let admin_key = match env::var("RED_ROUTER_ADMIN_KEY") {
        Ok(value) => Some(value),
        Err(env::VarError::NotPresent) => None,
        Err(_) => return Err("RED_ROUTER_ADMIN_KEY must be valid Unicode".into()),
    };
    let client_key = match env::var("RED_ROUTER_CLIENT_KEY") {
        Ok(value) => value,
        Err(env::VarError::NotPresent) if admin_key.is_some() => {
            // An empty Rust client-key table may use this only as an
            // unobservable compatibility fallback. Operators create the first
            // durable key through the authenticated admin API.
            let mut random = zeroize::Zeroizing::new([0_u8; 32]);
            getrandom::fill(random.as_mut())
                .map_err(|_| "cannot initialize client authentication")?;
            hex::encode(random.as_ref())
        }
        Err(env::VarError::NotPresent) => return Err("RED_ROUTER_CLIENT_KEY is required".into()),
        Err(_) => return Err("RED_ROUTER_CLIENT_KEY must be valid Unicode".into()),
    };
    let allow_private = env::var("RED_ROUTER_ALLOW_PRIVATE_UPSTREAM").as_deref() == Ok("1");
    let requested = env::var("RED_ROUTER_UPSTREAM_URL").ok();
    if command.as_deref() == Some("set-upstream") {
        let provider_key = env::var("RED_ROUTER_PROVIDER_KEY")?;
        let upstream = requested.ok_or("RED_ROUTER_UPSTREAM_URL is required")?;
        ProxyState::new(&upstream, &client_key, &provider_key, allow_private).await?;
        db.set_upstream(&upstream).await?;
        db.close().await?;
        println!("Upstream configuration saved; restart the proxy to apply it");
        return Ok(());
    }
    let usage_export_enabled = red_routerd::audit_export::spawn_from_env(&db).await?;
    if usage_export_enabled && admin_key.is_none() {
        return Err("BigQuery usage export requires the Rust control plane".into());
    }
    if let Some(admin_key) = admin_key {
        let admin_key = zeroize::Zeroizing::new(admin_key);
        let encryption_key = zeroize::Zeroizing::new(env::var("STORAGE_ENCRYPTION_KEY")?);
        let control = ControlPlane::new(
            db.clone(),
            admin_key.as_str(),
            encryption_key.as_str(),
            allow_private,
        )
        .await?;
        if backend == Backend::Sqlite {
            red_routerd::audit_export::spawn_persisted_usage(&db, encryption_key.as_str())?;
        }
        if !control.has_active_provider().await? {
            if let Some(upstream) = requested.as_deref() {
                let provider_key = zeroize::Zeroizing::new(env::var("RED_ROUTER_PROVIDER_KEY")?);
                let provider =
                    env::var("RED_ROUTER_PROVIDER_NAME").unwrap_or_else(|_| "openai".into());
                let rate_limit_scope = env::var("RED_ROUTER_PROVIDER_RATE_LIMIT_SCOPE")
                    .unwrap_or_else(|_| "auto".into());
                control
                    .configure_provider(
                        "default",
                        ProviderInput {
                            tenant_id: None,
                            provider,
                            upstream_url: upstream.to_owned(),
                            api_key: provider_key.to_string(),
                            enabled: true,
                            rate_limit_scope,
                            auth_scheme: env::var("RED_ROUTER_PROVIDER_AUTH_SCHEME")
                                .unwrap_or_else(|_| "auto".into()),
                            label: env::var("RED_ROUTER_PROVIDER_LABEL").ok(),
                            account_email: env::var("RED_ROUTER_PROVIDER_ACCOUNT_EMAIL").ok(),
                            expires_at_unix: env::var("RED_ROUTER_PROVIDER_EXPIRES_AT_UNIX")
                                .ok()
                                .and_then(|value| value.parse().ok()),
                            credential_type: "static".to_owned(),
                            oauth_provider: None,
                            refresh_token: None,
                        },
                    )
                    .await?;
            }
        }
        // The static target is never selected while the control plane is enabled;
        // it only lets the common proxy state initialize before the live snapshot.
        let mut state = ProxyState::new(
            "http://127.0.0.1:1/v1/chat/completions",
            &client_key,
            "control-plane-placeholder",
            true,
        )
        .await?
        .with_control_plane(control)
        // SQLite is the current durable usage authority. Keep the ledger complete so a
        // dashboard-managed export can be enabled without losing requests before its first poll.
        .with_native_usage_reporting(usage_export_enabled || backend == Backend::Sqlite)
        .with_antigravity_credits_mode(&antigravity_credits_mode)?;
        if let Some(limit) = max_in_flight {
            state = state.with_max_in_flight(limit)?;
        }
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
        serve_proxy(address, state, None, shutdown).await?;
        db.close().await?;
        return Ok(());
    }
    let provider_key = env::var("RED_ROUTER_PROVIDER_KEY")?;
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
    let mut state = ProxyState::new(&upstream, &client_key, &provider_key, allow_private)
        .await?
        .with_antigravity_credits_mode(&antigravity_credits_mode)?;
    if let Some(limit) = max_in_flight {
        state = state.with_max_in_flight(limit)?;
    }
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
    serve_proxy(address, state, None, shutdown).await?;
    db.close().await?;
    Ok(())
}

async fn serve_proxy(
    address: SocketAddr,
    state: ProxyState,
    reload: Option<tokio::sync::oneshot::Receiver<()>>,
    shutdown: Option<tokio::sync::watch::Receiver<bool>>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let listener = tokio::net::TcpListener::bind(address).await?;
    println!("red-routerd listening on {}", listener.local_addr()?);
    // Streaming frequently sends small SSE chunks; avoid Nagle delaying them
    // while waiting for an ACK from the client.
    let listener = listener.tap_io(|socket| {
        if let Err(error) = socket.set_nodelay(true) {
            eprintln!("failed to enable TCP_NODELAY: {error}");
        }
    });
    let app = match env::var_os("RED_ROUTER_SPA_DIR") {
        Some(path) => router_with_spa(state, SpaAssets::open(path)?),
        None => router(state),
    };
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let stop = async move {
                if let Some(mut receiver) = shutdown {
                    if !*receiver.borrow() {
                        let _ = receiver.changed().await;
                    }
                } else {
                    shutdown_signal().await;
                }
            };
            if let Some(reload) = reload {
                tokio::select! { _ = stop => {}, _ = reload => {} }
            } else {
                stop.await;
            }
        })
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    if let Ok(mut terminate) =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
    {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
        return;
    }
    let _ = tokio::signal::ctrl_c().await;
}
