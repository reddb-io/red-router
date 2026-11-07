//! Read-only translation of a deliberately narrow dashboard combo.
//!
//! A route plan contains no credentials and is not an authorization decision
//! or a runnable FastLLM snapshot. The caller must enforce the full product
//! policies before accepting traffic. Unsupported combo semantics fail closed.

use crate::product_combo::ProductCombo;
use serde_json::{json, Value};
use std::path::Path;

/// Translate a one-target priority combo using the product's SQLite reader.
/// Multi-target priority combos need explicit ordered fallback semantics in
/// FastLLM and cannot be represented by an unordered backend pool.
pub async fn single_target_plan(path: &Path, name: &str) -> Result<Value, &'static str> {
    let combo = ProductCombo::load(path, name).await?;
    if combo.targets.len() != 1 {
        return Err("FastLLM route plan requires exactly one combo target");
    }
    let target = &combo.targets[0];
    if !combo.unchanged().await {
        return Err("product combo changed while building FastLLM route plan");
    }
    Ok(json!({
        "format": "red-router.fastllm.route-plan.v1",
        "frontend_model": combo.name(),
        "provider": target.provider,
        "product_model": target.full_model,
        "upstream_model": target.model,
    }))
}
