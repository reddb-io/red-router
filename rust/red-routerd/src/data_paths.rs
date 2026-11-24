//! The legacy router's data directory, ported from `src/lib/dataPaths.ts`.
//!
//! The offline cutover reads the legacy database from this directory, so the
//! resolution follows the legacy rules: `RED_ROUTER_DATA_DIR` or `DATA_DIR`,
//! else `%APPDATA%\red\router` on Windows and `~/.red/router` elsewhere. The
//! environment is passed in so callers and tests choose it explicitly.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// Legacy `APP_NAME`.
pub const APP_NAME: &str = "red-router";
const UPSTREAM_APP_NAME: &str = "omniroute";

/// The environment the legacy resolvers read.
#[derive(Clone, Debug, Default)]
pub struct DataDirEnv {
    /// `os.homedir()` (else `HOME`/`USERPROFILE`, else the temp directory).
    pub home: Option<PathBuf>,
    /// `APPDATA` on Windows.
    pub app_data: Option<PathBuf>,
    /// `RED_ROUTER_DATA_DIR`, else `DATA_DIR`.
    pub configured: Option<String>,
    pub windows: bool,
}

impl DataDirEnv {
    /// The process environment, as the legacy router reads it.
    pub fn from_process() -> Self {
        let var = |name: &str| std::env::var(name).ok();
        Self {
            home: var("HOME")
                .or_else(|| var("USERPROFILE"))
                .filter(|home| !home.trim().is_empty())
                .map(PathBuf::from),
            app_data: var("APPDATA").map(PathBuf::from),
            configured: var("RED_ROUTER_DATA_DIR")
                .filter(|dir| !dir.is_empty())
                .or_else(|| var("DATA_DIR")),
            windows: cfg!(windows),
        }
    }

    fn home(&self) -> PathBuf {
        self.home.clone().unwrap_or_else(std::env::temp_dir)
    }
}

/// Legacy `normalizeConfiguredPath`: a trimmed, absolute path or none.
fn normalize_configured_path(dir: Option<&str>) -> Option<PathBuf> {
    let trimmed = dir?.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(std::path::absolute(trimmed).unwrap_or_else(|_| PathBuf::from(trimmed)))
}

/// Legacy `getLegacyDotDataDir`: the upstream `~/.omniroute`.
pub fn legacy_dot_data_dir(env: &DataDirEnv) -> PathBuf {
    env.home().join(format!(".{UPSTREAM_APP_NAME}"))
}

/// Legacy `getDefaultDataDir`.
pub fn default_data_dir(env: &DataDirEnv) -> PathBuf {
    let home = env.home();
    if env.windows {
        let app_data = env
            .app_data
            .clone()
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        return app_data.join("red").join("router");
    }
    home.join(".red").join("router")
}

/// Legacy `resolveDataDir`: cloud deployments use `/tmp`.
pub fn resolve_data_dir(env: &DataDirEnv, cloud: bool) -> PathBuf {
    if cloud {
        return PathBuf::from("/tmp");
    }
    normalize_configured_path(env.configured.as_deref()).unwrap_or_else(|| default_data_dir(env))
}

/// Legacy `resolveWritableDataDir` for a server start: a configured
/// directory that cannot be created for lack of permission falls back to
/// the default one; any other failure is returned.
pub fn resolve_writable_data_dir(env: &DataDirEnv, cloud: bool) -> std::io::Result<PathBuf> {
    let resolved = resolve_data_dir(env, cloud);
    if cloud || normalize_configured_path(env.configured.as_deref()).is_none() {
        return Ok(resolved);
    }
    match std::fs::create_dir_all(&resolved) {
        Ok(()) => Ok(resolved),
        Err(error) if error.kind() == ErrorKind::PermissionDenied => Ok(default_data_dir(env)),
        Err(error) => Err(error),
    }
}

/// Legacy `isSamePath`: absolute paths compared, case-insensitively on Windows.
pub fn is_same_path(a: Option<&Path>, b: Option<&Path>, windows: bool) -> bool {
    let (Some(a), Some(b)) = (a, b) else {
        return false;
    };
    if a.as_os_str().is_empty() || b.as_os_str().is_empty() {
        return false;
    }
    let absolute = |path: &Path| std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let (a, b) = (absolute(a), absolute(b));
    if windows {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    } else {
        a == b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(home: &Path, configured: Option<&Path>) -> DataDirEnv {
        DataDirEnv {
            home: Some(home.to_path_buf()),
            app_data: None,
            configured: configured.map(|path| path.to_string_lossy().into_owned()),
            windows: false,
        }
    }

    // Ported from tests/unit/data-dir-writable-fallback.test.ts.
    #[test]
    fn the_data_dir_follows_the_legacy_resolution() {
        let root = tempfile::TempDir::new().unwrap();
        let home = root.path().join("home");
        let unset = env(&home, None);
        assert_eq!(default_data_dir(&unset), home.join(".red").join("router"));
        assert_eq!(legacy_dot_data_dir(&unset), home.join(".omniroute"));
        assert_eq!(
            resolve_writable_data_dir(&unset, false).unwrap(),
            default_data_dir(&unset)
        );
        assert_eq!(resolve_data_dir(&unset, false), default_data_dir(&unset));

        let configured = root.path().join("data");
        let set = env(&home, Some(&configured));
        assert_eq!(resolve_writable_data_dir(&set, false).unwrap(), configured);
        assert!(configured.exists());
        assert_eq!(
            resolve_writable_data_dir(&set, true).unwrap(),
            PathBuf::from("/tmp")
        );

        // A parent that is a file is not a permission problem: it is returned.
        let file_parent = root.path().join("iam-a-file");
        std::fs::write(&file_parent, "x").unwrap();
        let blocked = env(&home, Some(&file_parent.join("data")));
        assert!(resolve_writable_data_dir(&blocked, false).is_err());

        let windows = DataDirEnv {
            windows: true,
            app_data: Some(PathBuf::from("C:/Users/x/AppData/Roaming")),
            ..unset.clone()
        };
        assert_eq!(
            default_data_dir(&windows),
            PathBuf::from("C:/Users/x/AppData/Roaming")
                .join("red")
                .join("router")
        );
        assert_eq!(normalize_configured_path(Some("   ")), None);
    }

    #[test]
    fn paths_compare_case_insensitively_on_windows() {
        let a = Path::new("/srv/Data");
        assert!(is_same_path(Some(a), Some(Path::new("/srv/Data")), false));
        assert!(!is_same_path(Some(a), Some(Path::new("/srv/data")), false));
        assert!(is_same_path(Some(a), Some(Path::new("/srv/data")), true));
        assert!(!is_same_path(None, Some(a), false));
        assert!(!is_same_path(Some(Path::new("")), Some(a), false));
    }
}
