//! Strict, read-only subset of dashboard combo configuration.
use serde_json::Value;
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Row, SqlitePool,
};
use std::{path::Path, sync::Arc};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComboTarget {
    pub provider: String,
    pub model: String,
    pub full_model: String,
}

#[derive(Clone)]
pub struct ProductCombo {
    pool: SqlitePool,
    name: Arc<str>,
    snapshot: Arc<str>,
    pub targets: Arc<Vec<ComboTarget>>,
}

impl ProductCombo {
    /// Accept only simple priority combos; unsupported behavior must never
    /// silently disappear when moving a dashboard configuration to Rust.
    pub async fn load(path: &Path, name: &str) -> Result<Self, &'static str> {
        if name.is_empty() || name.len() > 256 {
            return Err("invalid product combo name");
        }
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(SqliteConnectOptions::new().filename(path).read_only(true))
            .await
            .map_err(|_| "cannot open product SQLite database read-only")?;
        let row = sqlx::query(
            "SELECT data, context_cache_protection, tenant_id FROM combos WHERE name = ?",
        )
        .bind(name)
        .fetch_optional(&pool)
        .await
        .map_err(|_| "product combo schema unavailable")?
        .ok_or("product combo not found")?;
        let data: String = row.try_get("data").map_err(|_| "invalid product combo")?;
        let context: i64 = row
            .try_get("context_cache_protection")
            .map_err(|_| "invalid product combo")?;
        let tenant: String = row
            .try_get("tenant_id")
            .map_err(|_| "invalid product combo")?;
        if context != 0 || tenant != "red" {
            return Err("unsupported product combo policy");
        }
        let targets = parse_combo(name, &data)?;
        Ok(Self {
            pool,
            name: Arc::from(name),
            snapshot: Arc::from(data),
            targets: Arc::new(targets),
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub async fn unchanged(&self) -> bool {
        matches!(sqlx::query("SELECT 1 FROM combos WHERE name = ? AND data = ? AND context_cache_protection = 0 AND tenant_id = 'red'")
            .bind(self.name.as_ref()).bind(self.snapshot.as_ref()).fetch_optional(&self.pool).await, Ok(Some(_)))
    }
}

fn parse_combo(name: &str, data: &str) -> Result<Vec<ComboTarget>, &'static str> {
    if data.len() > 256 * 1024 {
        return Err("product combo is too large");
    }
    let value: Value = serde_json::from_str(data).map_err(|_| "invalid product combo")?;
    let object = value.as_object().ok_or("invalid product combo")?;
    if object.keys().any(|key| {
        ![
            "id",
            "name",
            "models",
            "strategy",
            "config",
            "isHidden",
            "sortOrder",
            "createdAt",
            "updatedAt",
            "version",
            "context_cache_protection",
        ]
        .contains(&key.as_str())
    }) {
        return Err("unsupported product combo field");
    }
    if object.get("name").and_then(Value::as_str) != Some(name)
        || object
            .get("strategy")
            .and_then(Value::as_str)
            .is_some_and(|s| s != "priority")
        || object.get("version").is_some_and(|v| v.as_u64() != Some(2))
        || object
            .get("context_cache_protection")
            .is_some_and(|v| !v.is_null() && v != &Value::Bool(false) && v.as_i64() != Some(0))
        || object
            .get("config")
            .is_some_and(|v| !v.is_null() && !v.as_object().is_some_and(|o| o.is_empty()))
    {
        return Err("unsupported product combo configuration");
    }
    let models = object
        .get("models")
        .and_then(Value::as_array)
        .ok_or("product combo targets missing")?;
    if models.is_empty() || models.len() > 8 {
        return Err("product combo must contain 1-8 targets");
    }
    let mut targets = Vec::with_capacity(models.len());
    for step in models {
        let model = if let Some(model) = step.as_str() {
            model
        } else {
            let step = step.as_object().ok_or("invalid product combo step")?;
            if step.keys().any(|key| {
                !["id", "kind", "model", "providerId", "weight", "label"].contains(&key.as_str())
            }) || step.get("kind").and_then(Value::as_str) != Some("model")
                || step.get("weight").is_some_and(|v| v.as_f64() != Some(0.0))
            {
                return Err("unsupported product combo step");
            }
            let model = step
                .get("model")
                .and_then(Value::as_str)
                .ok_or("product combo model missing")?;
            if let Some(provider) = step.get("providerId").and_then(Value::as_str) {
                if !model.starts_with(&format!("{provider}/")) {
                    return Err("product combo provider mismatch");
                }
            }
            model
        };
        if model.len() > 256 || model.trim() != model || model.contains('*') {
            return Err("invalid product combo model");
        }
        let (provider, target) = model
            .split_once('/')
            .ok_or("product combo provider missing")?;
        if !matches!(provider, "openai" | "openrouter")
            || target.is_empty()
            || target.trim() != target
        {
            return Err("unsupported product combo provider");
        }
        targets.push(ComboTarget {
            provider: provider.to_owned(),
            model: target.to_owned(),
            full_model: model.to_owned(),
        });
    }
    Ok(targets)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_simple_cross_provider_priority_combos_are_accepted() {
        let data = json!({"name":"mix","strategy":"priority","version":2,"config":{},
            "models":[{"id":"a","kind":"model","model":"openai/gpt","providerId":"openai","weight":0},
                {"id":"b","kind":"model","model":"openrouter/vendor/model","providerId":"openrouter","weight":0}]}).to_string();
        let targets = parse_combo("mix", &data).unwrap();
        assert_eq!(targets[0].model, "gpt");
        assert_eq!(targets[1].model, "vendor/model");
        for unsupported in [
            json!({"name":"mix","strategy":"round-robin","models":["openai/gpt"]}),
            json!({"name":"mix","models":[{"kind":"combo-ref","comboName":"other"}]}),
            json!({"name":"mix","models":[{"kind":"model","model":"openai/gpt","connectionId":"pinned"}]}),
            json!({"name":"mix","models":["openai/*"]}),
            json!({"name":"mix","models":["openai/gpt"],"system_message":"change"}),
        ] {
            assert!(parse_combo("mix", &unsupported.to_string()).is_err());
        }
    }
}
