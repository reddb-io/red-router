//! The model catalog version, ported from the legacy `src/lib/catalogVersion.ts`.
//!
//! A client that cached `/v1/models` re-reads it when this digest differs
//! from the one it cached. `created` is the catalog build time, not a model
//! revision, so it is left out: rebuilding an unchanged catalog must not
//! invalidate clients. The digest is opaque, so it only has to be stable for
//! one server.

use serde_json::Value;
use sha2::{Digest, Sha256};

/// Legacy `computeCatalogVersion`: 16 hex characters of the SHA-256 of the
/// entries without `created`.
pub fn compute_catalog_version(models: &[Value]) -> Option<String> {
    let stable: Vec<Value> = models
        .iter()
        .map(|model| {
            let mut model = model.clone();
            if let Some(entry) = model.as_object_mut() {
                entry.remove("created");
            }
            model
        })
        .collect();
    let digest = Sha256::digest(serde_json::to_vec(&stable).ok()?);
    Some(hex::encode(digest)[..16].to_owned())
}

/// Legacy `catalogVersionFromBody`: the version of a serialized
/// `{ "data": [...] }` body, or none when it is not one.
pub fn catalog_version_from_body(body: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(body).ok()?;
    compute_catalog_version(parsed.get("data")?.as_array()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model(id: &str, extra: Value) -> Value {
        let mut model = json!({"id": id, "type": "chat"});
        if let (Some(model), Some(extra)) = (model.as_object_mut(), extra.as_object()) {
            model.extend(extra.clone());
        }
        model
    }

    // Ported from tests/redrouter/native/catalog-version.test.ts.
    #[test]
    fn the_version_ignores_the_build_time_and_tracks_cached_fields() {
        let a = compute_catalog_version(&[model("a/x", json!({"created": 1}))]).unwrap();
        let b = compute_catalog_version(&[model("a/x", json!({"created": 2}))]).unwrap();
        assert_eq!(a.len(), 16);
        assert!(a.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_eq!(a, b);

        let base = compute_catalog_version(&[model("a/x", json!({"context_length": 1000}))]);
        assert_ne!(
            base,
            compute_catalog_version(&[model("a/x", json!({"context_length": 2000}))])
        );
        assert_ne!(
            base,
            compute_catalog_version(&[model("a/x", json!({})), model("a/y", json!({}))])
        );
        assert_ne!(base, compute_catalog_version(&[]));

        let data = vec![model("a/x", json!({"created": 5}))];
        assert_eq!(
            catalog_version_from_body(&json!({"object": "list", "data": data}).to_string()),
            compute_catalog_version(&data)
        );
        assert_eq!(catalog_version_from_body("not json"), None);
        assert_eq!(
            catalog_version_from_body(&json!({"error": "x"}).to_string()),
            None
        );
    }
}
