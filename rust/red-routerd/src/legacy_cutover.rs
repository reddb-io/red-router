//! One-shot offline migration coordinator for the legacy Next.js SQLite store.
//!
//! The individual importers remain deliberately strict. This coordinator adds
//! a durable rollback boundary around them so a later unsupported slice cannot
//! leave an operator with a partially migrated Rust database.
use crate::{
    legacy_archive, legacy_keys, legacy_models, legacy_preflight, legacy_provider_nodes,
    legacy_providers,
};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct CutoverReport {
    pub version: u8,
    pub source: String,
    pub destination: String,
    pub rollback_copy: String,
    pub preflight: legacy_preflight::LegacyPreflight,
    pub pricing: legacy_preflight::PricingImport,
    pub keys: legacy_keys::KeyImport,
    pub provider_nodes: legacy_provider_nodes::ProviderNodeImport,
    pub custom_models: legacy_models::ModelImport,
    pub providers: legacy_providers::ProviderStage,
    pub usage_archive: legacy_archive::ArchiveReport,
    pub activation_required: bool,
    pub follow_up: Vec<&'static str>,
}

fn sidecars(path: &Path) -> [PathBuf; 3] {
    let value = path.as_os_str().to_string_lossy();
    [
        PathBuf::from(format!("{value}-wal")),
        PathBuf::from(format!("{value}-shm")),
        PathBuf::from(format!("{value}-journal")),
    ]
}

fn canonical_new_file(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return Err("rollback copy already exists; choose a new path".into());
    }
    let name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or("invalid rollback copy path")?;
    let parent = path.parent().ok_or("invalid rollback copy path")?;
    let parent = std::fs::canonicalize(parent)
        .map_err(|_| "rollback copy directory does not exist".to_owned())?;
    Ok(parent.join(name))
}

fn reject_live_sidecars(path: &Path, label: &str) -> Result<(), String> {
    if sidecars(path).iter().any(|sidecar| sidecar.exists()) {
        return Err(format!(
            "{label} has a live SQLite sidecar; stop both servers and checkpoint the database"
        ));
    }
    Ok(())
}

fn restore(destination: &Path, rollback: &Path, step: &str, error: &str) -> String {
    for sidecar in sidecars(destination) {
        if sidecar.exists() && std::fs::remove_file(&sidecar).is_err() {
            return format!(
                "migration failed during {step}: {error}; automatic rollback could not remove {}; restore {} manually",
                sidecar.display(),
                rollback.display()
            );
        }
    }
    match std::fs::copy(rollback, destination) {
        Ok(_) => format!(
            "migration failed during {step}: {error}; destination restored and rollback copy retained at {}",
            rollback.display()
        ),
        Err(_) => format!(
            "migration failed during {step}: {error}; automatic rollback failed; restore {} manually",
            rollback.display()
        ),
    }
}

/// Run every lossless generic migration slice against one quiescent source.
///
/// Provider and client-key records remain disabled. OAuth adoption and quota
/// reconciliation require explicit, account-specific operator decisions after
/// this command succeeds.
pub async fn migrate(
    source: &Path,
    destination: &Path,
    rollback: &Path,
    storage_key: &str,
) -> Result<CutoverReport, String> {
    let source =
        std::fs::canonicalize(source).map_err(|_| "legacy database does not exist".to_owned())?;
    let destination = std::fs::canonicalize(destination)
        .map_err(|_| "destination database does not exist".to_owned())?;
    if source == destination {
        return Err("legacy and destination databases must be different files".into());
    }
    if !(16..=512).contains(&storage_key.len()) {
        return Err("invalid storage encryption key".into());
    }
    reject_live_sidecars(&source, "legacy database")?;
    reject_live_sidecars(&destination, "destination database")?;
    let rollback = canonical_new_file(rollback)?;
    if rollback == source || rollback == destination {
        return Err("rollback copy must be a separate file".into());
    }

    let preflight = legacy_preflight::inspect(&source)
        .await
        .map_err(str::to_owned)?;
    std::fs::copy(&destination, &rollback).map_err(|_| "cannot create rollback copy".to_owned())?;

    let pricing = match legacy_preflight::import_pricing(&source, &destination).await {
        Ok(report) => report,
        Err(error) => return Err(restore(&destination, &rollback, "pricing", error)),
    };
    let keys = match legacy_keys::import(&source, &destination).await {
        Ok(report) => report,
        Err(error) => return Err(restore(&destination, &rollback, "client keys", error)),
    };
    let provider_nodes =
        match legacy_provider_nodes::import(&source, &destination, storage_key).await {
            Ok(report) => report,
            Err(error) => {
                return Err(restore(
                    &destination,
                    &rollback,
                    "provider definitions",
                    error,
                ))
            }
        };
    // Provider definitions must exist before model namespaces can be resolved.
    // A later error restores the complete destination from the rollback copy.
    let custom_models = match legacy_models::import(&source, &destination).await {
        Ok(report) => report,
        Err(error) => return Err(restore(&destination, &rollback, "custom models", error)),
    };
    let providers = match legacy_providers::stage(&source, &destination, storage_key).await {
        Ok(report) => report,
        Err(error) => return Err(restore(&destination, &rollback, "providers", error)),
    };
    let usage_archive = match legacy_archive::archive(&source, &destination).await {
        Ok(report) => report,
        Err(error) => return Err(restore(&destination, &rollback, "usage archive", error)),
    };

    reject_live_sidecars(&destination, "destination database")
        .map_err(|error| restore(&destination, &rollback, "final verification", &error))?;

    Ok(CutoverReport {
        version: 3,
        source: source.to_string_lossy().into_owned(),
        destination: destination.to_string_lossy().into_owned(),
        rollback_copy: rollback.to_string_lossy().into_owned(),
        preflight,
        pricing,
        keys,
        provider_nodes,
        custom_models,
        providers,
        usage_archive,
        activation_required: true,
        follow_up: vec![
            "adopt staged OAuth providers with their provider-specific command",
            "import compatible-provider accounts by id to bind their reusable definitions",
            "migrate and verify legacy aliases and remaining model compatibility settings",
            "adopt quota state with explicit reservation bounds",
            "verify providers, policies, counters and historical usage",
            "enable migrated providers and client keys only after verification",
        ],
    })
}
