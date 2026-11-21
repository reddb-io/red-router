//! Tool identity and index bookkeeping of the Responses stream translation,
//! ported from the legacy `openai-responses/requestToolIdentity.ts`,
//! `functionCallIdentity.ts`, `collaborationPlaintextMarker.ts` and
//! `toolCallLocalIndex.ts`.

use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// A namespaced tool as the request declared it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolIdentity {
    pub namespace: String,
    pub name: String,
}

fn as_identity(value: &Value) -> Option<ToolIdentity> {
    let record = value.as_object()?;
    let namespace = record
        .get("namespace")?
        .as_str()
        .filter(|text| !text.is_empty())?;
    let name = record
        .get("name")?
        .as_str()
        .filter(|text| !text.is_empty())?;
    Some(ToolIdentity {
        namespace: namespace.to_owned(),
        name: name.to_owned(),
    })
}

/// `flattenNamespaceToolName` folds a namespace group onto the Chat wire as
/// `<namespace>__<leaf>`, always under the MCP `mcp__` container convention.
const NAMESPACE_TOOL_PREFIX: &str = "mcp__";

/// Legacy `splitFlattenedNamespaceWireName` (#12996): the fallback for a
/// follow-up turn that declared no namespace tools, splitting on the last
/// `__`. A name hash-truncated past 64 characters cannot be recovered.
fn split_flattened_wire_name(tool_name: &str) -> Option<ToolIdentity> {
    if !tool_name.starts_with(NAMESPACE_TOOL_PREFIX) {
        return None;
    }
    let separator = tool_name.rfind("__").filter(|index| *index > 0)?;
    let (namespace, name) = (&tool_name[..separator], &tool_name[separator + 2..]);
    (!namespace.is_empty() && !name.is_empty()).then(|| ToolIdentity {
        namespace: namespace.to_owned(),
        name: name.to_owned(),
    })
}

/// Legacy `resolveRequestToolIdentity`: a flattened Chat function name back to
/// the identity the request's namespace tool declared. A direct hit wins, then
/// the `namespace.leaf` spelling some tool parsers render, and only a request
/// with no declared identities falls back to the `mcp__` wire-name split.
pub fn resolve_request_tool_identity(
    identities: Option<&Map<String, Value>>,
    tool_name: &str,
) -> Option<ToolIdentity> {
    if tool_name.is_empty() {
        return None;
    }
    if let Some(identity) = identities
        .and_then(|map| map.get(tool_name))
        .and_then(as_identity)
    {
        return Some(identity);
    }
    for candidate in identities.into_iter().flat_map(Map::values) {
        if let Some(identity) = as_identity(candidate) {
            if format!("{}.{}", identity.namespace, identity.name) == tool_name {
                return Some(identity);
            }
        }
    }
    if identities.is_some_and(|map| !map.is_empty()) {
        return None;
    }
    split_flattened_wire_name(tool_name)
}

/// Legacy `plaintextCollaborationFields` (#14154): Codex treats a
/// collaboration call's arguments as ciphertext unless the item carries an
/// empty `encrypted_function_args` list.
pub fn plaintext_collaboration_fields(
    namespace: Option<&str>,
    name: Option<&str>,
) -> Map<String, Value> {
    let mut fields = Map::new();
    if namespace == Some("collaboration")
        && matches!(name, Some("spawn_agent" | "send_message" | "followup_task"))
    {
        fields.insert("encrypted_function_args".to_owned(), json!([]));
    }
    fields
}

/// Legacy `applyFunctionCallIdentity` (#7936): rewrite a function call's name
/// back to its bare leaf, stamp the original namespace beside it, then the
/// plaintext-delivery marker where Codex requires it.
pub fn apply_function_call_identity(
    item: &mut Map<String, Value>,
    identities: Option<&Map<String, Value>>,
    tool_name: &str,
) {
    if let Some(identity) = resolve_request_tool_identity(identities, tool_name) {
        item.insert("namespace".to_owned(), Value::String(identity.namespace));
        item.insert("name".to_owned(), Value::String(identity.name));
    }
    let fields = plaintext_collaboration_fields(
        item.get("namespace").and_then(Value::as_str),
        item.get("name").and_then(Value::as_str),
    );
    item.extend(fields);
}

/// Per-turn remapping of an upstream tool call `index` onto a contiguous,
/// 0-based sequence in first-seen order (legacy `resolveLocalToolCallIndex`),
/// so the emitted `output_index` values never leave a gap.
#[derive(Debug, Default, Clone)]
pub struct LocalToolCallIndex {
    assigned: HashMap<String, usize>,
    next: usize,
}

impl LocalToolCallIndex {
    pub fn resolve(&mut self, upstream_index: &str) -> usize {
        if let Some(index) = self.assigned.get(upstream_index) {
            return *index;
        }
        let index = self.next;
        self.assigned.insert(upstream_index.to_owned(), index);
        self.next = index + 1;
        index
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Outputs the legacy modules produced for the same inputs
    /// (`responses_tool_identity_oracle.json`, generated with Node).
    #[test]
    fn identity_and_index_match_the_legacy_modules() {
        let oracle: Value =
            serde_json::from_str(include_str!("responses_tool_identity_oracle.json")).unwrap();
        for case in oracle["resolve"].as_array().unwrap() {
            let map = case[0].as_object();
            let actual = resolve_request_tool_identity(map, case[1].as_str().unwrap()).map_or(
                Value::Null,
                |identity| json!({"namespace": identity.namespace, "name": identity.name}),
            );
            assert_eq!(actual, case[2], "{case}");
        }
        for case in oracle["apply"].as_array().unwrap() {
            let mut item = case[2].as_object().unwrap().clone();
            apply_function_call_identity(&mut item, case[0].as_object(), case[1].as_str().unwrap());
            assert_eq!(Value::Object(item), case[3], "{case}");
        }
        let mut state = LocalToolCallIndex::default();
        for step in oracle["index"].as_array().unwrap() {
            assert_eq!(
                state.resolve(step[0].as_str().unwrap()) as u64,
                step[1],
                "{step}"
            );
        }
    }
}
