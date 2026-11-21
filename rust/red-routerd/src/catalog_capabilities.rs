//! `?capabilities=` filtering and the chat/decision role of catalog rows,
//! ported from the legacy `src/app/api/v1/models/catalogCapabilities.ts`.
//!
//! Decisions (System One) are a separate protocol: chat metadata heuristics
//! must never turn a decision model into a chat model.

use crate::catalog_listing::CatalogEntry;
use crate::model_endpoint_policy::{model_endpoint_decision, ModelEndpointKind};

pub(crate) const INVALID_CAPABILITIES_MESSAGE: &str =
    "Invalid capabilities filter. Use chat, decision, reasoning, tools, vision or structured-output.";

/// At most this many values (after splitting on commas) are accepted.
const MAX_REQUESTED: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum CatalogCapability {
    Chat,
    Decision,
    Reasoning,
    Tools,
    Vision,
    StructuredOutput,
}

impl CatalogCapability {
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "chat" => Self::Chat,
            "decision" => Self::Decision,
            "reasoning" => Self::Reasoning,
            "tools" => Self::Tools,
            "vision" => Self::Vision,
            "structured-output" => Self::StructuredOutput,
            _ => return None,
        })
    }

    /// Capability flag a non-role capability reads from the row.
    fn field(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Decision => "decision",
            Self::Reasoning => "reasoning",
            Self::Tools => "tool_calling",
            Self::Vision => "vision",
            Self::StructuredOutput => "structured_output",
        }
    }
}

/// The extra row fields the role decision reads.
pub(crate) trait CatalogRoleEntry: CatalogEntry {
    fn catalog_owned_by(&self) -> Option<&str>;
    /// Upstream model id without the provider prefix, when stored separately.
    fn catalog_root(&self) -> Option<&str>;
    /// String entries of `supported_endpoints`, when the row declares them.
    fn catalog_supported_endpoints(&self) -> Option<Vec<String>>;
    /// A capability flag; anything other than a boolean reads as `None`.
    fn catalog_capability(&self, name: &str) -> Option<bool>;
}

impl CatalogRoleEntry for serde_json::Value {
    fn catalog_owned_by(&self) -> Option<&str> {
        self.get("owned_by").and_then(serde_json::Value::as_str)
    }
    fn catalog_root(&self) -> Option<&str> {
        self.get("root").and_then(serde_json::Value::as_str)
    }
    fn catalog_supported_endpoints(&self) -> Option<Vec<String>> {
        self.get("supported_endpoints")
            .and_then(serde_json::Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_owned))
                    .collect()
            })
    }
    fn catalog_capability(&self, name: &str) -> Option<bool> {
        self.get("capabilities")
            .and_then(|capabilities| capabilities.get(name))
            .and_then(serde_json::Value::as_bool)
    }
}

/// Parse `capabilities` query values. Repeated parameters and comma-separated
/// values both mean "all of these". Absent means no filter (`Some(empty)`);
/// an empty, unknown or excessive value is invalid (`None`).
pub(crate) fn parse_catalog_capabilities(query: Option<&str>) -> Option<Vec<CatalogCapability>> {
    let values: Vec<String> = url::form_urlencoded::parse(query.unwrap_or_default().as_bytes())
        .filter(|(name, _)| name == "capabilities")
        .flat_map(|(_, value)| {
            value
                .split(',')
                .map(|item| js_trim(item).to_owned())
                .collect::<Vec<_>>()
        })
        .collect();
    if values.len() > MAX_REQUESTED {
        return None;
    }
    values
        .iter()
        .map(|value| CatalogCapability::parse(value))
        .collect()
}

/// Cache key for a capability filter: sorted unique values, or `invalid`.
#[allow(dead_code)] // Used once the Rust catalog caches filtered bodies.
pub(crate) fn catalog_capability_cache_key(query: Option<&str>) -> String {
    match parse_catalog_capabilities(query) {
        Some(requested) => {
            let mut names: Vec<&str> = requested
                .into_iter()
                .map(CatalogCapability::field_name)
                .collect();
            names.sort_unstable();
            names.dedup();
            names.join(",")
        }
        None => "invalid".to_owned(),
    }
}

impl CatalogCapability {
    /// Query spelling of the capability.
    #[allow(dead_code)]
    fn field_name(self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Decision => "decision",
            Self::Reasoning => "reasoning",
            Self::Tools => "tools",
            Self::Vision => "vision",
            Self::StructuredOutput => "structured-output",
        }
    }
}

/// Whether the row is selectable for chat and whether it is a decision model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct CatalogRole {
    pub(crate) chat: bool,
    pub(crate) decision: bool,
}

pub(crate) fn catalog_model_role<T: CatalogRoleEntry>(model: &T) -> CatalogRole {
    let declared = model.catalog_supported_endpoints();
    let id = model.catalog_id().unwrap_or_default();
    let raw_model = model
        .catalog_root()
        .unwrap_or_else(|| id.split_once('/').map_or(id, |(_, rest)| rest));
    let endpoint = model_endpoint_decision(
        model.catalog_owned_by(),
        raw_model,
        declared.as_deref(),
        None,
    );
    let kind = model.catalog_type();
    let decision = kind == "systemone"
        || endpoint.kind == ModelEndpointKind::SystemOne
        || model.catalog_capability("decision") == Some(true);
    let chat = !decision
        && (kind.is_empty() || matches!(kind, "chat" | "llm" | "imageToText"))
        && endpoint.chat_selectable;
    CatalogRole { chat, decision }
}

/// Keep rows that satisfy every requested capability. Apply only to the
/// already authorized catalog, before pagination. Unknown support is not true.
pub(crate) fn filter_catalog_capabilities<T: CatalogRoleEntry>(
    models: Vec<T>,
    requested: &[CatalogCapability],
) -> Vec<T> {
    if requested.is_empty() {
        return models;
    }
    models
        .into_iter()
        .filter(|model| {
            let role = catalog_model_role(model);
            requested.iter().all(|capability| match capability {
                CatalogCapability::Chat => role.chat,
                CatalogCapability::Decision => role.decision,
                other => model.catalog_capability(other.field()) == Some(true),
            })
        })
        .collect()
}

/// Capability flags forced on a decision row: decisions are not chat, and
/// generation capabilities copied from chat metadata do not apply.
pub(crate) const DECISION_CAPABILITY_FLAGS: [(&str, bool); 7] = [
    ("chat", false),
    ("decision", true),
    ("tool_calling", false),
    ("reasoning", false),
    ("vision", false),
    ("thinking", false),
    ("supportsThinking", false),
];

/// A decision row has never been probed by the catalog.
pub(crate) const DECISION_AVAILABILITY: &str = "not_probed";

/// The endpoints that serve a decision row.
pub(crate) const DECISION_SUPPORTED_ENDPOINTS: [&str; 2] = ["systemone", "decisions"];

/// JSON form of the legacy `withCatalogRoleCapabilities`: rows that are not
/// decisions are returned unchanged; decision rows become `systemone` rows
/// with decision endpoints and the forced capability flags.
#[allow(dead_code)] // The typed listing applies the same rule in lib.rs.
pub(crate) fn with_catalog_role_capabilities(model: &serde_json::Value) -> serde_json::Value {
    let role = catalog_model_role(model);
    if !role.decision {
        return model.clone();
    }
    let mut capabilities = model
        .get("capabilities")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (name, value) in DECISION_CAPABILITY_FLAGS {
        let value = if name == "chat" { role.chat } else { value };
        capabilities.insert(name.to_owned(), serde_json::Value::Bool(value));
    }
    capabilities.remove("effort_tiers");
    let mut out = model.clone();
    if let Some(object) = out.as_object_mut() {
        object.insert("type".into(), "systemone".into());
        object.insert("availability".into(), DECISION_AVAILABILITY.into());
        object.insert(
            "supported_endpoints".into(),
            serde_json::json!(DECISION_SUPPORTED_ENDPOINTS),
        );
        object.insert(
            "capabilities".into(),
            serde_json::Value::Object(capabilities),
        );
    }
    out
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

#[cfg(test)]
mod tests {
    use super::CatalogCapability::*;
    use super::*;
    use serde_json::{json, Value};

    fn models() -> Vec<Value> {
        json!([
            {"id":"openai/gpt-4o","owned_by":"openai","type":"chat",
             "capabilities":{"tool_calling":true,"vision":true,"reasoning":true}},
            {"id":"openrouter/typesafe/jev-1.13","owned_by":"openrouter","root":"typesafe/jev-1.13",
             "type":"systemone",
             "capabilities":{"tool_calling":true,"reasoning":true,"vision":true,"effort_tiers":["high"]}},
            {"id":"openai/text-embedding-3-small","owned_by":"openai","type":"embedding"}
        ])
        .as_array()
        .cloned()
        .unwrap()
    }

    fn ids(models: &[Value]) -> Vec<&str> {
        models.iter().filter_map(CatalogEntry::catalog_id).collect()
    }

    // tests/redrouter/native/catalog-capabilities.test.ts
    #[test]
    fn decision_protocol_overrides_optimistic_chat_flags() {
        let source = models();
        let catalog: Vec<Value> = source.iter().map(with_catalog_role_capabilities).collect();
        let decision = &catalog[1];
        assert_eq!(decision["type"], "systemone");
        assert_eq!(
            decision["supported_endpoints"],
            json!(["systemone", "decisions"])
        );
        assert_eq!(
            ids(&filter_catalog_capabilities(catalog.clone(), &[Decision])),
            ["openrouter/typesafe/jev-1.13"]
        );
        assert_eq!(
            ids(&filter_catalog_capabilities(
                catalog.clone(),
                &[Chat, Tools, Vision, Reasoning]
            )),
            ["openai/gpt-4o"]
        );
        assert!(decision["capabilities"].get("effort_tiers").is_none());
        assert_eq!(source[1]["capabilities"]["tool_calling"], true);
        assert!(filter_catalog_capabilities(catalog.clone(), &[Decision, Tools]).is_empty());
        assert!(filter_catalog_capabilities(catalog, &[StructuredOutput]).is_empty());
    }

    #[test]
    fn explicit_decision_endpoints_are_recognized_without_a_type() {
        let model = with_catalog_role_capabilities(&json!({
            "id":"gateway/jev","supported_endpoints":["decisions"],"capabilities":{"reasoning":true}
        }));
        assert_eq!(model["type"], "systemone");
        assert_eq!(model["capabilities"]["chat"], false);
        let known = with_catalog_role_capabilities(&json!({
            "id":"openrouter/typesafe/jev-1.13","owned_by":"openrouter","supported_endpoints":["chat"]
        }));
        assert_eq!(known["capabilities"]["decision"], true);
        let embedding = with_catalog_role_capabilities(&json!({
            "id":"openai/text-embedding-3-small","owned_by":"openai","supported_endpoints":["chat"]
        }));
        assert!(filter_catalog_capabilities(vec![embedding], &[Chat]).is_empty());
        let combo =
            with_catalog_role_capabilities(&json!({"id":"unknown-router","owned_by":"combo"}));
        assert!(combo.get("capabilities").is_none());
        assert_eq!(
            filter_catalog_capabilities(vec![combo.clone()], &[Chat]),
            vec![combo]
        );
    }

    #[test]
    fn parses_conjunctions_and_rejects_unknown_or_empty_values() {
        assert_eq!(
            parse_catalog_capabilities(Some("capabilities=chat,tools&capabilities=vision")),
            Some(vec![Chat, Tools, Vision])
        );
        assert_eq!(parse_catalog_capabilities(None), Some(vec![]));
        assert_eq!(parse_catalog_capabilities(Some("limit=1")), Some(vec![]));
        assert_eq!(parse_catalog_capabilities(Some("capabilities=")), None);
        assert_eq!(
            parse_catalog_capabilities(Some("capabilities=unknown")),
            None
        );
        assert_eq!(
            parse_catalog_capabilities(Some("capabilities=%20structured-output%20")),
            Some(vec![StructuredOutput])
        );
        let thirteen = vec!["chat"; 13].join(",");
        assert_eq!(
            parse_catalog_capabilities(Some(&format!("capabilities={thirteen}"))),
            None
        );
    }

    #[test]
    fn cache_keys_are_sorted_unique_or_invalid() {
        assert_eq!(
            catalog_capability_cache_key(Some("capabilities=vision,chat,vision")),
            "chat,vision"
        );
        assert_eq!(
            catalog_capability_cache_key(Some("capabilities=nope")),
            "invalid"
        );
        assert_eq!(
            catalog_capability_cache_key(Some("capabilities=tools,structured-output")),
            "structured-output,tools"
        );
        assert_eq!(catalog_capability_cache_key(None), "");
    }
}
