//! Per-connection model exclusions from legacy connectionModelRules.ts.
use super::*;
use crate::storage::StoredProviderRules;
use regex::{Regex, RegexBuilder};

const MAX_PATTERNS: usize = 128;
const MAX_PATTERN_BYTES: usize = 256;

#[derive(Default)]
pub(crate) struct ModelRules {
    compiled: Vec<Regex>,
}

impl ModelRules {
    pub(super) fn compile(patterns: &[String]) -> Result<Self, &'static str> {
        if patterns.len() > MAX_PATTERNS {
            return Err("too many model exclusions");
        }
        let mut compiled = Vec::with_capacity(patterns.len());
        for pattern in patterns {
            if pattern.is_empty()
                || pattern.len() > MAX_PATTERN_BYTES
                || pattern.trim() != pattern
                || pattern == "**"
                || pattern.chars().any(char::is_control)
            {
                return Err("invalid model exclusion");
            }
            let mut expression = String::from("^");
            for character in pattern.chars() {
                match character {
                    '*' => expression.push_str(".*"),
                    '?' => expression.push('.'),
                    literal => expression.push_str(&regex::escape(&literal.to_string())),
                }
            }
            expression.push('$');
            compiled.push(
                RegexBuilder::new(&expression)
                    .case_insensitive(true)
                    .size_limit(262_144)
                    .build()
                    .map_err(|_| "invalid model exclusion")?,
            );
        }
        Ok(Self { compiled })
    }

    pub(crate) fn excludes(&self, model: &str) -> bool {
        let trimmed = model.trim();
        if trimmed.is_empty() {
            return false;
        }
        let base = trimmed.strip_suffix("[1m]").unwrap_or(trimmed);
        let tail = base.rsplit('/').next().unwrap_or(base);
        self.compiled.iter().any(|pattern| {
            [trimmed, base, tail]
                .iter()
                .any(|candidate| pattern.is_match(candidate))
        })
    }
}

fn normalize(values: &[String]) -> Result<Vec<String>, &'static str> {
    if values.len() > MAX_PATTERNS {
        return Err("too many model exclusions");
    }
    let mut result = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() || value == "**" {
            continue;
        }
        if value.len() > MAX_PATTERN_BYTES || value.chars().any(char::is_control) {
            return Err("invalid model exclusion");
        }
        if !result.iter().any(|existing| existing == value) {
            result.push(value.to_owned());
        }
    }
    ModelRules::compile(&result)?;
    Ok(result)
}

/// Accept only the legacy fields whose effects this module implements.
pub(crate) fn parse_legacy(raw: Option<&str>) -> Result<Vec<String>, &'static str> {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Ok(Vec::new());
    };
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| "invalid legacy provider configuration")?;
    if value.is_null() || value.as_array().is_some_and(Vec::is_empty) {
        return Ok(Vec::new());
    }
    let object = value
        .as_object()
        .ok_or("legacy provider configuration requires migration")?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "excludedModels" | "excluded_models"))
    {
        return Err("legacy provider configuration requires migration");
    }
    parse_legacy_values(object)
}

/// Remove supported routing rules before validating provider-specific OAuth metadata.
pub(crate) fn take_legacy(
    object: &mut serde_json::Map<String, serde_json::Value>,
) -> Result<Vec<String>, &'static str> {
    let mut rules = serde_json::Map::new();
    for key in ["excludedModels", "excluded_models"] {
        if let Some(value) = object.remove(key) {
            rules.insert(key.to_owned(), value);
        }
    }
    parse_legacy_values(&rules)
}

fn parse_legacy_values(
    object: &serde_json::Map<String, serde_json::Value>,
) -> Result<Vec<String>, &'static str> {
    let value = object
        .get("excludedModels")
        .filter(|v| !v.is_null())
        .or_else(|| object.get("excluded_models"));
    let values = match value {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::String(value)) => value.split(',').map(str::to_owned).collect(),
        Some(serde_json::Value::Array(values)) => values
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or("invalid legacy model exclusions")
            })
            .collect::<Result<Vec<_>, _>>()?,
        _ => return Err("invalid legacy model exclusions"),
    };
    normalize(&values)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RulesInput {
    excluded_models: Vec<String>,
    revision: Option<String>,
}

#[derive(Serialize)]
struct RulesView {
    excluded_models: Vec<String>,
    revision: Option<String>,
}

impl ControlPlane {
    async fn rules_provider(
        &self,
        id: &str,
        tenant: Option<&str>,
    ) -> Result<StoredProvider, &'static str> {
        validate_id(id)?;
        self.0
            .database
            .providers()
            .await?
            .into_iter()
            .find(|p| p.id == id && tenant.is_none_or(|tenant| tenant == p.tenant_id))
            .ok_or("provider unavailable")
    }

    async fn rules_view(&self, provider: &StoredProvider) -> Result<RulesView, &'static str> {
        let entry = self
            .0
            .database
            .provider_model_rules()
            .await?
            .into_iter()
            .find(|entry| entry.provider_id == provider.id);
        if entry
            .as_ref()
            .is_some_and(|entry| entry.tenant_id != provider.tenant_id)
        {
            return Err("invalid provider model rules");
        }
        Ok(match entry {
            Some(entry) => RulesView {
                excluded_models: entry.patterns,
                revision: Some(entry.revision.to_string()),
            },
            None => RulesView {
                excluded_models: Vec::new(),
                revision: None,
            },
        })
    }
}

pub async fn get_rules(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Control plane unavailable");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    if !control.0.database.is_sqlite().await {
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider model rules require SQLite",
        );
    }
    let provider = match control
        .rules_provider(&id, scope.tenant_id.as_deref())
        .await
    {
        Ok(provider) => provider,
        Err(_) => return api_error(StatusCode::NOT_FOUND, "Provider unavailable"),
    };
    match control.rules_view(&provider).await {
        Ok(view) => ([(header::CACHE_CONTROL, "no-store")], Json(view)).into_response(),
        Err(_) => api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider model rules unavailable",
        ),
    }
}

pub async fn put_rules(
    State(state): State<ProxyState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<RulesInput>,
) -> Response {
    let Some(control) = &state.control_plane else {
        return api_error(StatusCode::NOT_FOUND, "Control plane unavailable");
    };
    let Some(scope) = control.management_scope(&headers).await else {
        return api_error(StatusCode::UNAUTHORIZED, "Invalid admin key");
    };
    let patterns = match normalize(&input.excluded_models) {
        Ok(patterns) => patterns,
        Err(error) => return api_error(StatusCode::BAD_REQUEST, error),
    };
    let expected = match input.revision.as_deref().map(str::parse::<i64>).transpose() {
        Ok(value) if value.is_none_or(|v| v > 0) => value,
        _ => return api_error(StatusCode::BAD_REQUEST, "Invalid rules revision"),
    };
    let _mutation = control.0.mutation.lock().await;
    let provider = match control
        .rules_provider(&id, scope.tenant_id.as_deref())
        .await
    {
        Ok(provider) => provider,
        Err(_) => return api_error(StatusCode::NOT_FOUND, "Provider unavailable"),
    };
    let entry = StoredProviderRules {
        provider_id: id.clone(),
        tenant_id: provider.tenant_id.clone(),
        patterns,
        revision: match revision() {
            Ok(value) => value,
            Err(_) => {
                return api_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "Provider model rules unavailable",
                )
            }
        },
    };
    if let Err(error) = control
        .0
        .database
        .save_provider_model_rules(&entry, provider.updated_at, expected)
        .await
    {
        return if error.contains("reload and retry") {
            api_error(StatusCode::CONFLICT, error)
        } else {
            api_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Provider model rules unavailable",
            )
        };
    }
    if control.refresh_routes().await.is_err() {
        *control.0.routes.write().await = RouteSnapshot::Unavailable;
        return api_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Provider model rules unavailable",
        );
    }
    control
        .record_audit_event(
            AuditContext {
                action: "provider.model_rules.update",
                actor: &scope.actor,
                tenant_id: &provider.tenant_id,
                target: &id,
                resource_type: "provider",
            },
            Option::<&serde_json::Value>::None,
            Some(&serde_json::json!({"excluded_count":entry.patterns.len()})),
        )
        .await;
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(RulesView {
            excluded_models: entry.patterns,
            revision: Some(entry.revision.to_string()),
        }),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_patterns_match_prefix_context_case_and_wildcards() {
        let patterns =
            parse_legacy(Some(r#"{"excludedModels":"anthropic/*,gpt-4?,**,a.b"}"#)).unwrap();
        let rules = ModelRules::compile(&patterns).unwrap();
        for model in ["anthropic/claude/x", "GPT-4O[1m]", "provider/a.b"] {
            assert!(rules.excludes(model), "{model}");
        }
        for model in ["gpt-4oo", "provider/axb", "other"] {
            assert!(!rules.excludes(model), "{model}");
        }
        assert!(parse_legacy(Some(
            r#"{"excludedModels":["a"],"baseUrl":"https://example.com"}"#
        ))
        .is_err());
        let mut metadata = serde_json::json!({
            "workspaceId":"workspace-1",
            "excludedModels":null,
            "excluded_models":"private-*, other",
        })
        .as_object()
        .unwrap()
        .clone();
        assert_eq!(take_legacy(&mut metadata).unwrap(), ["private-*", "other"]);
        assert_eq!(metadata.len(), 1);
        assert_eq!(metadata["workspaceId"], "workspace-1");
        metadata.insert("excludedModels".into(), serde_json::json!([7]));
        assert!(take_legacy(&mut metadata).is_err());
    }
}
