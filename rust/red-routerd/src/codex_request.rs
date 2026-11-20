//! Codex Responses requests, ported from the legacy
//! `open-sse/executors/codex.ts` (`buildHeaders` and the native passthrough
//! branch of `transformRequest`), `open-sse/config/codexClient.ts`,
//! `open-sse/executors/codex/reasoningSuffix.ts`,
//! `open-sse/executors/codex/toolCallRepair.ts`,
//! `open-sse/utils/responsesInputNormalization.ts` and the Responses branch
//! of `open-sse/handlers/sseParser.ts`.
//!
//! The Codex backend only answers event streams, so a request is always sent
//! with `stream: true` and a non-streaming client gets the stream folded back
//! into one Responses object.

use axum::http::{HeaderMap, HeaderValue};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;

/// Legacy `DEFAULT_CODEX_CLIENT_VERSION`.
pub(crate) const DEFAULT_CODEX_CLIENT_VERSION: &str = "0.163.0";
/// Legacy `CODEX_CLI_RS_ORIGINATOR`.
pub(crate) const CODEX_ORIGINATOR: &str = "codex_cli_rs";
const USER_AGENT_PLATFORM: &str = "Windows 10.0.26200";
const USER_AGENT_ARCH: &str = "x64";
const PASSTHROUGH_INSTRUCTIONS: &str = "Follow the developer instructions in the conversation.";
const ENCRYPTED_REASONING_INCLUDE: &str = "reasoning.encrypted_content";
/// Legacy `CODEX_FAST_WIRE_VALUE`.
const FAST_WIRE_SERVICE_TIER: &str = "priority";
pub(crate) const EFFORT_ORDER: [&str; 7] =
    ["none", "low", "medium", "high", "xhigh", "max", "ultra"];
pub(crate) const MAX_ALIAS_MODELS: [&str; 7] = [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6.1-sol",
    "gpt-6-luna",
];
pub(crate) const ULTRA_ALIAS_MODELS: [&str; 5] = [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6.1-sol",
];
const RESPONSES_TERMINAL_EVENTS: [&str; 6] = [
    "response.completed",
    "response.done",
    "response.cancelled",
    "response.canceled",
    "response.failed",
    "response.incomplete",
];

/// Legacy `CODEX_FAST_TIER_DEFAULT_SUPPORTED_MODELS`.
pub(crate) const FAST_TIER_DEFAULT_MODELS: [&str; 7] = [
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
];

/// Legacy `normalizeCodexServiceTier`: fast is priority.
pub(crate) fn normalize_codex_service_tier(value: Option<&Value>) -> Option<&'static str> {
    match value?.as_str()?.trim().to_ascii_lowercase().as_str() {
        "fast" | "priority" => Some("priority"),
        "default" => Some("default"),
        "flex" => Some("flex"),
        _ => None,
    }
}

/// Legacy `normalizeCodexReasoningEffort` over `CODEX_REASONING_EFFORT_VALUES`.
pub(crate) fn normalize_codex_reasoning_effort(value: Option<&Value>) -> Option<&'static str> {
    let value = value?.as_str()?.trim().to_ascii_lowercase();
    EFFORT_ORDER[..6]
        .iter()
        .find(|effort| **effort == value)
        .copied()
}

/// A Codex account's workspace binding and request defaults (legacy
/// `providerSpecificData.workspaceId` and `getCodexRequestDefaults`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct CodexAccount {
    pub(crate) account_id: Option<String>,
    pub(crate) reasoning_effort: Option<&'static str>,
    pub(crate) service_tier: Option<&'static str>,
    /// Legacy `isCodexFreePlan`: free accounts cannot run `image_generation`.
    pub(crate) free_plan: bool,
}

impl CodexAccount {
    /// Reads the request defaults a legacy connection carried in its
    /// imported `legacyCodex` session metadata.
    pub(crate) fn new(account_id: Option<String>, session: &Value) -> Self {
        let defaults = session.pointer("/legacyCodex/requestDefaults");
        // Legacy isCodexFreePlan over the imported workspacePlanType (else
        // chatgptPlanType), or the plan the ID token names.
        let legacy = session.get("legacyCodex");
        let plan = match legacy.and_then(|data| data.get("workspacePlanType")) {
            Some(Value::String(plan)) => Some(plan.as_str()),
            _ => legacy
                .and_then(|data| data.get("chatgptPlanType"))
                .and_then(Value::as_str),
        };
        let plan = plan.map(str::to_owned).or_else(|| id_token_plan(session));
        Self {
            account_id,
            free_plan: plan.is_some_and(|plan| plan.trim().eq_ignore_ascii_case("free")),
            reasoning_effort: normalize_codex_reasoning_effort(
                defaults.and_then(|value| value.get("reasoningEffort")),
            ),
            service_tier: normalize_codex_service_tier(
                defaults.and_then(|value| value.get("serviceTier")),
            ),
        }
    }
}

/// The `chatgpt_plan_type` claim of the session's ID token (the legacy Codex
/// OAuth import stores it as `workspacePlanType`).
fn id_token_plan(session: &Value) -> Option<String> {
    use base64::Engine as _;
    let token = session.get("id_token")?.as_str()?;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    claims
        .pointer("/https:~1~1api.openai.com~1auth/chatgpt_plan_type")?
        .as_str()
        .map(str::to_owned)
}

/// Legacy `getCodexModelScope` is spark: Spark-scope models reject the
/// `image_generation` hosted tool on every plan (#6651).
fn spark_scope(model: &str) -> bool {
    let model = model.to_ascii_lowercase();
    model.contains("spark") || model.contains("bengalfox")
}

/// Legacy `CODEX_HOSTED_TOOL_TYPES`.
const HOSTED_TOOL_TYPES: [&str; 9] = [
    "tool_search",
    "image_generation",
    "web_search",
    "web_search_preview",
    "file_search",
    "computer",
    "computer_use_preview",
    "code_interpreter",
    "mcp",
];

/// Legacy `maybeStripRedundantOneOf`: a `oneOf` of string `const` branches
/// that exactly repeats a sibling string `enum` is dropped.
fn strip_redundant_one_of(node: &mut Map<String, Value>) {
    let (Some(Value::Array(branches)), Some(Value::Array(values))) =
        (node.get("oneOf"), node.get("enum"))
    else {
        return;
    };
    if branches.is_empty() || values.is_empty() {
        return;
    }
    let mut consts = Vec::new();
    for branch in branches {
        let Some(branch) = branch.as_object() else {
            return;
        };
        if !branch.contains_key("const")
            || !branch
                .keys()
                .all(|key| matches!(key.as_str(), "const" | "description" | "title" | "$comment"))
        {
            return;
        }
        let Some(value) = branch.get("const").and_then(Value::as_str) else {
            return;
        };
        consts.push(value);
    }
    let Some(values) = values
        .iter()
        .map(Value::as_str)
        .collect::<Option<HashSet<_>>>()
    else {
        return;
    };
    let unique: HashSet<_> = consts.iter().copied().collect();
    if unique.len() != consts.len()
        || values.len() != consts.len()
        || !consts.iter().all(|value| values.contains(value))
    {
        return;
    }
    node.remove("oneOf");
}

/// Legacy `stripRedundantOneOfConstEnum`.
pub(crate) fn strip_redundant_one_of_const_enum(schema: Value) -> Value {
    let mut schema = match schema {
        Value::Array(entries) => {
            return Value::Array(
                entries
                    .into_iter()
                    .map(strip_redundant_one_of_const_enum)
                    .collect(),
            )
        }
        Value::Object(schema) => schema,
        other => return other,
    };
    strip_redundant_one_of(&mut schema);
    let walk = |value: &mut Value| *value = strip_redundant_one_of_const_enum(value.take());
    for field in ["properties", "patternProperties", "$defs", "definitions"] {
        if let Some(Value::Object(entries)) = schema.get_mut(field) {
            entries.values_mut().for_each(walk);
        }
    }
    for field in ["prefixItems", "oneOf", "anyOf", "allOf"] {
        if let Some(Value::Array(entries)) = schema.get_mut(field) {
            entries.iter_mut().for_each(walk);
        }
    }
    for field in ["items", "additionalProperties", "not", "if", "then", "else"] {
        if let Some(value) = schema.get_mut(field) {
            walk(value);
        }
    }
    Value::Object(schema)
}

fn tool_name(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .map(|name| name.trim().chars().take(128).collect())
        .unwrap_or_default()
}

/// Legacy `normalizeCodexTools` for a native passthrough (custom tools kept,
/// no default `strict`): Codex accepts flat function tools with a name,
/// namespaces, native custom tools and hosted tools.
pub(crate) fn normalize_tools(body: &mut Map<String, Value>, drop_image_generation: bool) {
    let Some(Value::Array(tools)) = body.get_mut("tools") else {
        return;
    };
    let mut names = HashSet::new();
    tools.retain_mut(|tool| {
        let Some(record) = tool.as_object_mut() else {
            return false;
        };
        let kind = record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if kind == "namespace" {
            if let Some(Value::Array(children)) = record.get("tools") {
                for child in children.iter().filter_map(Value::as_object) {
                    let name = tool_name(child.get("name"));
                    if !name.is_empty() {
                        names.insert(name);
                    }
                }
            }
            return true;
        }
        if kind == "custom" {
            let name = tool_name(record.get("name"));
            if name.is_empty() {
                return false;
            }
            record.insert("name".to_owned(), json!(name));
            names.insert(name);
            return true;
        }
        let function = record.get("function").and_then(Value::as_object).cloned();
        if kind != "function" {
            let has_function = record.get("function").is_some_and(|value| {
                truthy(Some(value)) && (value.is_object() || value.is_array())
            });
            if kind.is_empty() || has_function || record.get("name").is_some_and(Value::is_string) {
                return false;
            }
            return HOSTED_TOOL_TYPES.contains(&kind.as_str())
                && !(kind == "image_generation" && drop_image_generation);
        }
        let raw_name = match record.get("name") {
            Some(Value::String(name)) => name.clone(),
            _ => function
                .as_ref()
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        };
        let name = raw_name.trim().to_owned();
        if name.is_empty() {
            return false;
        }
        let description = match record.get("description") {
            Some(Value::String(text)) => text.clone(),
            _ => function
                .as_ref()
                .and_then(|function| function.get("description"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        };
        let parameters = record
            .get("parameters")
            .filter(|value| value.is_object())
            .or_else(|| {
                function
                    .as_ref()
                    .and_then(|function| function.get("parameters"))
                    .filter(|value| value.is_object())
            })
            .cloned()
            .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
        let strict = record
            .get("strict")
            .filter(|value| value.is_boolean())
            .or_else(|| {
                function
                    .as_ref()
                    .and_then(|function| function.get("strict"))
                    .filter(|value| value.is_boolean())
            })
            .cloned();
        let parameters = strip_redundant_one_of_const_enum(
            crate::tool_schemas::strip_unsupported_regex_patterns(parameters),
        );
        record.clear();
        record.insert("type".to_owned(), json!("function"));
        record.insert(
            "name".to_owned(),
            json!(name.chars().take(128).collect::<String>()),
        );
        if !description.is_empty() {
            record.insert("description".to_owned(), json!(description));
        }
        record.insert("parameters".to_owned(), parameters);
        if let Some(strict) = strict {
            record.insert("strict".to_owned(), strict);
        }
        names.insert(name);
        true
    });
    let drop_choice = match body.get("tool_choice").and_then(Value::as_object) {
        Some(choice) => match choice.get("type").and_then(Value::as_str) {
            Some("function") => {
                let name = choice
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or("");
                name.is_empty() || !names.contains(name)
            }
            Some("local_shell") => true,
            _ => false,
        },
        None => false,
    };
    if drop_choice {
        body.remove("tool_choice");
    }
}

/// Legacy `codexServiceTier` (`resolveCodexGlobalFastServiceTier`): off by
/// default; an unset tier is priority and an empty model list the default
/// Fast-eligible models.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CodexServiceTier {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub tier: Option<String>,
    #[serde(default)]
    pub supported_models: Vec<String>,
    /// The tier a Codex connection without its own uses because the legacy
    /// `codexConnectionDefaultsMigrationV1` never ran on the imported database.
    #[serde(default)]
    pub unmigrated_connection_tier: Option<String>,
}

impl CodexServiceTier {
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        let tier = |value: &Option<String>| {
            value
                .as_deref()
                .is_none_or(|value| matches!(value, "default" | "priority" | "flex"))
        };
        if !tier(&self.tier)
            || !tier(&self.unmigrated_connection_tier)
            || self.supported_models.len() > 100
            || self
                .supported_models
                .iter()
                .any(|model| model.trim().is_empty() || model.len() > 256)
        {
            return Err("invalid Codex service tier");
        }
        Ok(())
    }

    /// Legacy `modelMatchesSupportedList`: the last path segment equals or
    /// extends a supported id.
    fn supports(&self, model: &str) -> bool {
        let model = model.trim().to_ascii_lowercase();
        let model = model.rsplit('/').next().unwrap_or("");
        let matches = |supported: &str| {
            let supported = supported.trim().to_ascii_lowercase();
            !supported.is_empty() && model.starts_with(&supported)
        };
        !model.is_empty()
            && if self.supported_models.is_empty() {
                FAST_TIER_DEFAULT_MODELS.iter().any(|model| matches(model))
            } else {
                self.supported_models.iter().any(|model| matches(model))
            }
    }

    /// Legacy `applyCodexGlobalFastServiceTier`: a valid body tier wins, then
    /// the global mode for a supported model (default clears the account's
    /// tier), then the account. Returns the tier the executor falls back to.
    pub(crate) fn apply(
        &self,
        body: &mut Map<String, Value>,
        model: &str,
        connection: Option<&'static str>,
    ) -> Option<&'static str> {
        let connection = connection.or_else(|| {
            normalize_codex_service_tier(
                self.unmigrated_connection_tier
                    .clone()
                    .map(Value::String)
                    .as_ref(),
            )
        });
        if !self.enabled {
            return connection;
        }
        let mode = normalize_codex_service_tier(Some(&Value::String(
            self.tier.clone().unwrap_or_default(),
        )))
        .unwrap_or("priority");
        if mode != "default" && !self.supports(model) {
            return connection;
        }
        if let Some(tier) = normalize_codex_service_tier(body.get("service_tier")) {
            body.insert("service_tier".to_owned(), json!(tier));
            return connection;
        }
        if mode == "default" {
            return None;
        }
        body.insert("service_tier".to_owned(), json!(mode));
        Some(mode)
    }
}

static VERSION_IN_USER_AGENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:codex[-_][A-Za-z0-9_]*|codex-cli)/(\d+\.\d+\.\d+)").expect("static pattern")
});
static MAX_TIER_SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(.+?)(?:-(max|ultra)|\((max|ultra)\))$").expect("static pattern")
});

/// Legacy `SAFE_HEADER_TOKEN_PATTERN`.
fn safe_token(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && value.len() <= 32
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// Legacy `SAFE_HEADER_VALUE_PATTERN`.
fn safe_header_value(value: &str) -> bool {
    (1..=200).contains(&value.len()) && value.bytes().all(|byte| (0x20..=0x7e).contains(&byte))
}

/// Legacy `normalizeCodexSessionId`.
pub(crate) fn normalize_session_id(value: Option<&Value>) -> Option<&str> {
    let value = value?.as_str()?.trim();
    ((1..=200).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')))
    .then_some(value)
}

fn env_value(name: &str, valid: fn(&str) -> bool) -> Option<String> {
    let value = std::env::var(name).ok()?;
    let value = value.trim();
    valid(value).then(|| value.to_owned())
}

/// Legacy `getCodexClientVersion`.
pub(crate) fn client_version() -> String {
    env_value("CODEX_CLIENT_VERSION", safe_token)
        .unwrap_or_else(|| DEFAULT_CODEX_CLIENT_VERSION.to_owned())
}

/// Legacy `getCodexClientVersionFromHeaders`: the caller's own Codex version,
/// from a `version` header or a Codex `User-Agent`.
pub(crate) fn client_version_from_headers(headers: &HeaderMap) -> Option<String> {
    let pick = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    if let Some(version) = pick("version").filter(|version| safe_token(version)) {
        return Some(version.to_owned());
    }
    let captures = VERSION_IN_USER_AGENT.captures(pick("user-agent")?)?;
    let version = captures.get(1)?.as_str();
    safe_token(version).then(|| version.to_owned())
}

/// Legacy `getCodexUserAgent`.
pub(crate) fn user_agent(version_override: Option<&str>) -> String {
    if let Some(user_agent) = env_value("CODEX_USER_AGENT", safe_header_value) {
        return user_agent;
    }
    let version = version_override
        .filter(|version| safe_token(version))
        .map_or_else(client_version, str::to_owned);
    format!("codex-cli/{version} ({USER_AGENT_PLATFORM}; {USER_AGENT_ARCH})")
}

/// Legacy `CodexExecutor.buildHeaders` for a streamed `/responses` call: the
/// caller's Codex version, the workspace binding and the prompt cache session.
pub(crate) fn headers(
    version: Option<&str>,
    account_id: Option<&str>,
) -> Vec<(&'static str, HeaderValue)> {
    let mut headers = Vec::new();
    let mut push = |name: &'static str, value: &str| {
        if let Ok(value) = HeaderValue::from_str(value) {
            headers.push((name, value));
        }
    };
    push("accept", "text/event-stream");
    let version = version.filter(|version| safe_token(version));
    push(
        "version",
        &version.map_or_else(client_version, str::to_owned),
    );
    push("user-agent", &user_agent(version));
    if let Some(account_id) = account_id.filter(|value| !value.is_empty()) {
        push("chatgpt-account-id", account_id);
    }
    push("originator", CODEX_ORIGINATOR);
    let account = account_id.map(|value| Value::String(value.to_owned()));
    if let Some(session) = normalize_session_id(account.as_ref()) {
        push("session_id", session);
    }
    headers
}

/// Legacy `splitCodexReasoningSuffix`.
pub(crate) fn split_reasoning_suffix(model: &str) -> (&str, Option<&'static str>) {
    if let Some(captures) = MAX_TIER_SUFFIX.captures(model) {
        let base = captures.get(1).map_or("", |base| base.as_str());
        let parenthesized = captures.get(3).is_some();
        let effort = captures
            .get(2)
            .or_else(|| captures.get(3))
            .map_or("", |effort| effort.as_str());
        let supported = if parenthesized || effort == "max" {
            MAX_ALIAS_MODELS.contains(&base)
        } else {
            ULTRA_ALIAS_MODELS.contains(&base)
        };
        if supported {
            return (base, Some(if effort == "max" { "max" } else { "ultra" }));
        }
    }
    for effort in ["none", "low", "medium", "high", "xhigh"] {
        if let Some(base) = model
            .strip_suffix(effort)
            .and_then(|base| base.strip_suffix('-'))
        {
            return (base, Some(effort));
        }
    }
    (model, None)
}

/// Legacy `clampEffort` over `MAX_EFFORT_BY_MODEL` and the alias caps.
pub(crate) fn clamp_effort(model: &str, requested: String) -> String {
    let max = match model {
        "gpt-5.3-codex" | "gpt-5.1-codex-max" => "xhigh",
        "gpt-5-mini" | "gpt-5.1-mini" | "gpt-4.1-mini" => "high",
        _ if ULTRA_ALIAS_MODELS.contains(&model) => "ultra",
        _ if MAX_ALIAS_MODELS.contains(&model) => "max",
        _ => "xhigh",
    };
    let rank = |effort: &str| EFFORT_ORDER.iter().position(|value| *value == effort);
    match (rank(&requested), rank(max)) {
        (Some(requested_rank), Some(max_rank)) if requested_rank > max_rank => max.to_owned(),
        _ => requested,
    }
}

/// Legacy `normalizeEffortValue`.
fn normalize_effort(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?.trim().to_ascii_lowercase();
    (!value.is_empty()).then_some(value)
}

/// JavaScript truthiness of an optional field.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(_) => true,
    }
}

fn text_part_type(role: &str) -> &'static str {
    if role == "assistant" {
        "output_text"
    } else {
        "input_text"
    }
}

/// Legacy `normalizeCodexMessageContentPart`.
fn normalize_content_part(part: &Value, role: &str) -> Value {
    if let Some(text) = part.as_str() {
        return json!({"type": text_part_type(role), "text": text});
    }
    let Some(record) = part.as_object() else {
        return part.clone();
    };
    let mut record = record.clone();
    if record.get("type").and_then(Value::as_str) == Some("text") {
        record.insert("type".to_owned(), json!(text_part_type(role)));
    }
    if role == "assistant"
        && matches!(
            record.get("type").and_then(Value::as_str),
            Some("input_text" | "text")
        )
    {
        record.insert("type".to_owned(), json!("output_text"));
        for key in ["annotations", "logprobs", "obfuscation"] {
            record.remove(key);
        }
    }
    Value::Object(record)
}

/// Legacy `normalizeCodexResponsesInputItem`.
fn normalize_input_item(item: &Value) -> Value {
    if let Some(text) = item.as_str() {
        return json!({"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]});
    }
    let Some(record) = item.as_object() else {
        return item.clone();
    };
    let mut record = record.clone();
    let role = record
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("user")
        .to_owned();
    let kind = record
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if kind == "additional_tools" {
        record.remove("content");
        return Value::Object(record);
    }
    if kind.is_empty() && !record.contains_key("content") {
        if let Some(text) = record.get("text").and_then(Value::as_str) {
            return json!({"type": "message", "role": role, "content": [{"type": text_part_type(&role), "text": text}]});
        }
    }
    if kind.is_empty() && !role.is_empty() {
        record.insert("type".to_owned(), json!("message"));
    }
    if record.get("type").and_then(Value::as_str) == Some("message")
        || (kind.is_empty() && record.contains_key("content"))
    {
        let content = match (record.get("content"), record.get("text")) {
            (Some(Value::Array(parts)), _) => parts
                .iter()
                .map(|part| normalize_content_part(part, &role))
                .collect(),
            (Some(Value::String(text)), _) => {
                vec![json!({"type": text_part_type(&role), "text": text})]
            }
            (_, Some(Value::String(text))) => {
                vec![json!({"type": text_part_type(&role), "text": text})]
            }
            _ => Vec::new(),
        };
        record.insert("role".to_owned(), json!(role));
        record.insert("content".to_owned(), Value::Array(content));
        record.insert("type".to_owned(), json!("message"));
    }
    Value::Object(record)
}

/// Legacy `normalizeCodexResponsesInput`.
pub(crate) fn normalize_input(body: &mut Map<String, Value>) {
    match body.get_mut("input") {
        None => {}
        Some(Value::Array(items)) => {
            for item in items.iter_mut() {
                *item = normalize_input_item(item);
            }
        }
        Some(input @ Value::Null) => *input = json!([]),
        Some(input) => *input = json!([normalize_input_item(input)]),
    }
}

/// Legacy mapping of `messages` and `prompt` into `input` (#1832, #1872).
fn map_messages_to_input(body: &mut Map<String, Value>) {
    if truthy(body.get("input")) {
        return;
    }
    let input = if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        messages
            .iter()
            .map(|message| {
                let mut item = Map::new();
                item.insert("type".to_owned(), json!("message"));
                item.insert(
                    "role".to_owned(),
                    json!(message
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or("user")),
                );
                if let Some(phase) = message.get("phase").filter(|phase| phase.is_string()) {
                    item.insert("phase".to_owned(), phase.clone());
                }
                let content = match message.get("content") {
                    Some(Value::String(text)) => json!([{"type": "input_text", "text": text}]),
                    Some(Value::Array(parts)) => Value::Array(
                        parts
                            .iter()
                            .map(|part| match part.as_object() {
                                Some(record)
                                    if record.get("type").and_then(Value::as_str)
                                        == Some("text") =>
                                {
                                    let mut text = Map::new();
                                    text.insert("type".to_owned(), json!("input_text"));
                                    if let Some(value) = record.get("text") {
                                        text.insert("text".to_owned(), value.clone());
                                    }
                                    Value::Object(text)
                                }
                                _ => part.clone(),
                            })
                            .collect(),
                    ),
                    _ => json!([]),
                };
                item.insert("content".to_owned(), content);
                Value::Object(item)
            })
            .collect()
    } else {
        match body.get("prompt") {
            Some(Value::String(prompt)) if !prompt.trim().is_empty() => {
                vec![json!({"type": "message", "role": "user", "content": [{"type": "input_text", "text": prompt}]})]
            }
            Some(Value::Array(prompts)) => prompts
                .iter()
                .map(|prompt| {
                    let text = prompt
                        .as_str()
                        .map_or_else(|| prompt.to_string(), str::to_owned);
                    json!({"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]})
                })
                .collect(),
            _ => return,
        }
    };
    body.insert("input".to_owned(), Value::Array(input));
}

/// Legacy `stripOrphanedCodexFunctionCallOutputs`.
pub(crate) fn strip_orphaned_function_call_outputs(body: &mut Map<String, Value>) {
    if body
        .get("previous_response_id")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.trim().is_empty())
    {
        return;
    }
    let Some(Value::Array(input)) = body.get_mut("input") else {
        return;
    };
    let mut call_ids = HashSet::new();
    let mut outputs = 0;
    for record in input.iter().filter_map(Value::as_object) {
        let kind = record.get("type").and_then(Value::as_str);
        if kind == Some("function_call") {
            if let Some(id) = record.get("call_id").and_then(Value::as_str) {
                call_ids.insert(id.to_owned());
            }
        }
        if let Some(tool_calls) = record.get("tool_calls").and_then(Value::as_array) {
            for id in tool_calls
                .iter()
                .filter_map(|call| call.get("id").and_then(Value::as_str))
            {
                call_ids.insert(id.to_owned());
            }
        }
        if kind == Some("function_call_output") {
            outputs += 1;
        }
    }
    if outputs == 0 {
        return;
    }
    input.retain(|item| {
        let Some(record) = item.as_object() else {
            return true;
        };
        match (
            record.get("type").and_then(Value::as_str),
            record.get("call_id").and_then(Value::as_str),
        ) {
            (Some("function_call_output"), Some(id)) => call_ids.contains(id),
            _ => true,
        }
    });
}

/// Legacy `repairMissingCodexToolCallOutputs`: an empty output follows each
/// tool call that has none.
pub(crate) fn repair_missing_tool_call_outputs(body: &mut Map<String, Value>) {
    let Some(Value::Array(input)) = body.get_mut("input") else {
        return;
    };
    let mut existing = HashSet::new();
    for record in input.iter().filter_map(Value::as_object) {
        if let (Some(kind @ ("function_call_output" | "custom_tool_call_output")), Some(id)) = (
            record.get("type").and_then(Value::as_str),
            record.get("call_id").and_then(Value::as_str),
        ) {
            if !id.trim().is_empty() {
                existing.insert(format!("{kind}:{}", id.trim()));
            }
        }
    }
    let mut repaired = Vec::with_capacity(input.len());
    for item in input.drain(..) {
        let missing = item.as_object().and_then(|record| {
            let output_kind = match record.get("type").and_then(Value::as_str)? {
                "function_call" => "function_call_output",
                "custom_tool_call" => "custom_tool_call_output",
                _ => return None,
            };
            let id = record
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            let key = format!("{output_kind}:{id}");
            (!id.is_empty() && !existing.contains(&key)).then(|| {
                (
                    key,
                    json!({"type": output_kind, "call_id": id, "output": ""}),
                )
            })
        });
        repaired.push(item);
        if let Some((key, output)) = missing {
            existing.insert(key);
            repaired.push(output);
        }
    }
    *input = repaired;
}

/// Legacy `convertSystemToDeveloperRole`.
pub(crate) fn system_to_developer(body: &mut Map<String, Value>) {
    let Some(Value::Array(input)) = body.get_mut("input") else {
        return;
    };
    for record in input.iter_mut().filter_map(Value::as_object_mut) {
        let message = match record.get("type") {
            Some(Value::String(kind)) => kind.is_empty() || kind == "message",
            _ => true,
        };
        if message && record.get("role").and_then(Value::as_str) == Some("system") {
            record.insert("role".to_owned(), json!("developer"));
        }
    }
}

/// Legacy `CodexExecutor.transformRequest` for a native Responses passthrough
/// to `/responses`. `model` is the routed upstream model.
pub(crate) fn shape_passthrough(
    payload: &mut Value,
    model: &str,
    account: Option<&CodexAccount>,
    service_tier: &CodexServiceTier,
) -> Result<(), ()> {
    let body = payload.as_object_mut().ok_or(())?;
    let account_id = account.and_then(|account| account.account_id.as_deref());
    body.remove("_omnirouteResponsesStore");
    body.insert("stream".to_owned(), Value::Bool(true));
    body.remove("_nativeCodexPassthrough");

    let connection_tier = service_tier.apply(
        body,
        model,
        account.and_then(|account| account.service_tier),
    );
    if let Some(tier) = body
        .get("service_tier")
        .and_then(Value::as_str)
        .map(|tier| tier.trim().to_ascii_lowercase())
        .filter(|tier| !tier.is_empty())
    {
        let tier = if tier == "fast" {
            FAST_WIRE_SERVICE_TIER.to_owned()
        } else {
            tier
        };
        body.insert("service_tier".to_owned(), Value::String(tier));
    } else if let Some(tier) = connection_tier {
        body.insert("service_tier".to_owned(), json!(tier));
    }

    map_messages_to_input(body);
    normalize_input(body);
    strip_orphaned_function_call_outputs(body);
    repair_missing_tool_call_outputs(body);
    system_to_developer(body);

    let blank_instructions = match body.get("instructions") {
        Some(Value::String(text)) => text.trim().is_empty(),
        other => !truthy(other),
    };
    if blank_instructions {
        body.insert("instructions".to_owned(), json!(PASSTHROUGH_INSTRUCTIONS));
    }
    body.insert("store".to_owned(), Value::Bool(false));
    normalize_tools(
        body,
        account.is_some_and(|account| account.free_plan) || spark_scope(model),
    );
    body.remove("messages");
    body.remove("prompt");

    let requested_model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(model)
        .to_owned();
    let (base_model, model_effort) = split_reasoning_suffix(&requested_model);
    let base_model = base_model.to_owned();
    if model_effort.is_some() {
        body.insert("model".to_owned(), Value::String(base_model.clone()));
    }
    let reasoning = body.get("reasoning").and_then(Value::as_object).cloned();
    let explicit = normalize_effort(reasoning.as_ref().and_then(|value| value.get("effort")));
    let flat = normalize_effort(body.get("reasoning_effort"));
    let disabled =
        reasoning.as_ref().and_then(|value| value.get("enabled")) == Some(&Value::Bool(false));
    // The legacy thinking mode defaults to passthrough, which applies the
    // connection's default effort, else medium.
    let default_effort = account
        .and_then(|account| account.reasoning_effort)
        .unwrap_or("medium");
    let effort = model_effort
        .map(str::to_owned)
        .or(explicit)
        .or(flat)
        .unwrap_or_else(|| if disabled { "none" } else { default_effort }.to_owned());
    let effort = clamp_effort(&base_model, effort);
    let mut wire = reasoning.unwrap_or_default();
    wire.insert(
        "effort".to_owned(),
        Value::String(if effort == "ultra" {
            "max".to_owned()
        } else {
            effort
        }),
    );
    // Codex accepts only `effort` and `summary` inside `reasoning`.
    wire.retain(|key, _| key == "effort" || key == "summary");
    // Legacy ensureCodexReasoningSummary.
    if normalize_effort(wire.get("effort")).as_deref() != Some("none") {
        wire.entry("summary").or_insert_with(|| json!("auto"));
        match body.get_mut("include") {
            Some(Value::Array(include)) => {
                if !include
                    .iter()
                    .any(|value| value == ENCRYPTED_REASONING_INCLUDE)
                {
                    include.push(json!(ENCRYPTED_REASONING_INCLUDE));
                }
            }
            _ => {
                body.insert("include".to_owned(), json!([ENCRYPTED_REASONING_INCLUDE]));
            }
        }
    }
    body.insert("reasoning".to_owned(), Value::Object(wire));

    // Fields the Codex Responses backend rejects (legacy transformRequest and
    // stripCodexPassthroughRejectedParams).
    for key in [
        "reasoning_effort",
        "max_tokens",
        "max_output_tokens",
        "truncation",
        "background",
        "prompt_cache_retention",
        "safety_identifier",
        "user",
        "temperature",
        "top_p",
    ] {
        body.remove(key);
    }

    // Legacy getPromptCacheSessionId: the conversation, else the account.
    if !truthy(body.get("prompt_cache_key")) {
        let conversation = match body.get("session_id") {
            Some(value) if !value.is_null() => Some(value),
            _ => body.get("conversation_id"),
        };
        let account = account_id.map(|value| Value::String(value.to_owned()));
        if let Some(key) = normalize_session_id(conversation)
            .or_else(|| normalize_session_id(account.as_ref()))
            .map(str::to_owned)
        {
            body.insert("prompt_cache_key".to_owned(), Value::String(key));
        }
    }
    body.remove("session_id");
    body.remove("conversation_id");

    // Legacy applyReasoningInputPolicy: an empty turn continues.
    if body
        .get("input")
        .and_then(Value::as_array)
        .is_some_and(Vec::is_empty)
    {
        body.insert(
            "input".to_owned(),
            json!([{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "continue"}]}]),
        );
    }
    Ok(())
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

fn id_string(value: &Value) -> Value {
    match value {
        Value::Null | Value::String(_) => value.clone(),
        other => Value::String(other.to_string()),
    }
}

/// Legacy `cloneResponseItem`.
fn clone_item(item: Option<&Value>) -> Map<String, Value> {
    let mut record = item.and_then(Value::as_object).cloned().unwrap_or_default();
    for key in ["id", "call_id"] {
        if let Some(value) = record.get_mut(key) {
            *value = id_string(value);
        }
    }
    for key in ["content", "summary"] {
        if let Some(Value::Array(parts)) = record.get_mut(key) {
            for part in parts.iter_mut() {
                if !part.is_object() {
                    *part = json!({});
                }
            }
        }
    }
    record
}

fn text_of(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("")
}

fn output_index(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(number) => number.as_i64().or_else(|| {
            number
                .as_f64()
                .filter(|n| n.fract() == 0.0)
                .map(|n| n as i64)
        }),
        Value::String(text) if !text.trim().is_empty() => text.trim().parse().ok(),
        _ => None,
    }
}

fn ensure_message(
    items: &mut BTreeMap<i64, Map<String, Value>>,
    index: i64,
    now: u64,
) -> &mut Map<String, Value> {
    let item = items.entry(index).or_default();
    if item.get("type").and_then(Value::as_str) != Some("message") {
        let id = item
            .get("id")
            .filter(|id| !id.is_null())
            .map_or_else(|| json!(format!("msg_{now}_{index}")), id_string);
        let mut content = match item.get("content") {
            Some(Value::Array(parts)) => parts.clone(),
            _ => vec![json!({"type": "output_text", "annotations": [], "text": ""})],
        };
        if content.is_empty() {
            content.push(json!({"type": "output_text", "annotations": [], "text": ""}));
        }
        item.insert("id".to_owned(), id);
        item.insert("type".to_owned(), json!("message"));
        item.insert("role".to_owned(), json!("assistant"));
        item.insert("content".to_owned(), Value::Array(content));
    }
    item
}

fn ensure_reasoning<'a>(
    items: &'a mut BTreeMap<i64, Map<String, Value>>,
    index: i64,
    item_id: &str,
    now: u64,
) -> &'a mut Map<String, Value> {
    let item = items.entry(index).or_default();
    if item.get("type").and_then(Value::as_str) != Some("reasoning") {
        let id = if item_id.is_empty() {
            item.get("id")
                .filter(|id| !id.is_null())
                .map_or_else(|| json!(format!("rs_{now}_{index}")), id_string)
        } else {
            json!(item_id)
        };
        let mut summary = match item.get("summary") {
            Some(Value::Array(parts)) => parts.clone(),
            _ => vec![json!({"type": "summary_text", "text": ""})],
        };
        if summary.is_empty() {
            summary.push(json!({"type": "summary_text", "text": ""}));
        }
        item.insert("id".to_owned(), id);
        item.insert("type".to_owned(), json!("reasoning"));
        item.insert("summary".to_owned(), Value::Array(summary));
    }
    item
}

fn ensure_function_call<'a>(
    items: &'a mut BTreeMap<i64, Map<String, Value>>,
    index: i64,
    item_id: &str,
    now: u64,
) -> &'a mut Map<String, Value> {
    let item = items.entry(index).or_default();
    if item.get("type").and_then(Value::as_str) == Some("function_call") {
        for key in ["id", "call_id"] {
            if let Some(value) = item.get_mut(key) {
                if !value.is_null() {
                    *value = id_string(value);
                }
            }
        }
        if !item_id.is_empty() && !truthy(item.get("id")) {
            item.insert("id".to_owned(), json!(item_id));
        }
        return item;
    }
    let existing_id = item
        .get("id")
        .filter(|id| !id.is_null())
        .map(|id| id_string(id).as_str().unwrap_or("").to_owned())
        .unwrap_or_default();
    let existing_call = item
        .get("call_id")
        .filter(|id| !id.is_null())
        .map(|id| id_string(id).as_str().unwrap_or("").to_owned())
        .unwrap_or_default();
    let id = if !item_id.is_empty() {
        item_id.to_owned()
    } else if !existing_id.is_empty() {
        existing_id
    } else {
        format!("fc_{now}_{index}")
    };
    let name = item.get("name").filter(|name| truthy(Some(name))).cloned();
    let arguments = item
        .get("arguments")
        .filter(|value| value.is_string())
        .cloned()
        .unwrap_or_else(|| json!(""));
    item.insert("id".to_owned(), json!(id));
    item.insert("type".to_owned(), json!("function_call"));
    item.insert("call_id".to_owned(), json!(existing_call));
    item.insert("name".to_owned(), name.unwrap_or_else(|| json!("")));
    item.insert("arguments".to_owned(), arguments);
    item
}

/// Writes `text` into the first content part of a message item, or appends.
fn update_first_text(
    item: &mut Map<String, Value>,
    field: &str,
    index: usize,
    text: &str,
    append: bool,
    kind: &str,
) {
    let Some(Value::Array(parts)) = item.get_mut(field) else {
        return;
    };
    while parts.len() <= index {
        parts.push(Value::Null);
    }
    let mut part = parts[index].as_object().cloned().unwrap_or_else(|| {
        let mut part = Map::new();
        part.insert("type".to_owned(), json!(kind));
        if kind == "output_text" {
            part.insert("annotations".to_owned(), json!([]));
        }
        part.insert("text".to_owned(), json!(""));
        part
    });
    if !truthy(part.get("type")) {
        part.insert("type".to_owned(), json!(kind));
    }
    if kind == "output_text" && !part.get("annotations").is_some_and(Value::is_array) {
        part.insert("annotations".to_owned(), json!([]));
    }
    let next = if append {
        format!("{}{text}", text_of(part.get("text")))
    } else {
        text.to_owned()
    };
    part.insert("text".to_owned(), Value::String(next));
    parts[index] = Value::Object(part);
}

/// Legacy `parseSSEToResponsesOutput`: one Responses object from a Codex
/// event stream, preferring the terminal snapshot.
pub(crate) fn responses_from_sse(raw: &[u8], fallback_model: &str) -> Option<Value> {
    let raw = String::from_utf8_lossy(raw);
    let events: Vec<Map<String, Value>> = raw
        .split('\n')
        .filter_map(|line| line.trim().strip_prefix("data:"))
        .map(str::trim)
        .filter(|payload| !payload.is_empty() && *payload != "[DONE]")
        .filter_map(|payload| serde_json::from_str::<Value>(payload).ok())
        .filter_map(|value| match value {
            Value::Object(record) if !record.is_empty() => Some(record),
            _ => None,
        })
        .collect();
    if events.is_empty() {
        return None;
    }
    let now = unix_now();
    let mut terminal: Option<Value> = None;
    let mut terminal_event = String::new();
    let mut latest: Option<Value> = None;
    let mut items: BTreeMap<i64, Map<String, Value>> = BTreeMap::new();
    for event in &events {
        let kind = text_of(event.get("type"));
        let index = output_index(event.get("output_index"));
        let item_id = match event.get("item_id") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(id)) => id.clone(),
            Some(other) => other.to_string(),
        };
        if let Some(index) = index {
            match kind {
                "response.output_item.added" => {
                    items.insert(index, clone_item(event.get("item")));
                }
                "response.output_item.done" => {
                    let next = clone_item(event.get("item"));
                    let merged = match items.remove(&index) {
                        Some(mut existing) => {
                            for (key, value) in next {
                                existing.insert(key, value);
                            }
                            existing
                        }
                        None => next,
                    };
                    items.insert(index, merged);
                }
                "response.output_text.delta" => {
                    let item = ensure_message(&mut items, index, now);
                    update_first_text(
                        item,
                        "content",
                        0,
                        text_of(event.get("delta")),
                        true,
                        "output_text",
                    );
                }
                "response.output_text.done" => {
                    let item = ensure_message(&mut items, index, now);
                    let current = item
                        .get("content")
                        .and_then(|parts| parts.get(0))
                        .map(|part| text_of(part.get("text")).to_owned())
                        .unwrap_or_default();
                    let text = event
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or(&current)
                        .to_owned();
                    update_first_text(item, "content", 0, &text, false, "output_text");
                }
                "response.reasoning_summary_text.delta"
                | "response.reasoning_summary_text.done" => {
                    let summary_index = event
                        .get("summary_index")
                        .and_then(Value::as_u64)
                        .and_then(|value| usize::try_from(value).ok())
                        .unwrap_or(0);
                    let item = ensure_reasoning(&mut items, index, &item_id, now);
                    if kind.ends_with(".delta") {
                        update_first_text(
                            item,
                            "summary",
                            summary_index,
                            text_of(event.get("delta")),
                            true,
                            "summary_text",
                        );
                    } else {
                        let current = item
                            .get("summary")
                            .and_then(|parts| parts.get(summary_index))
                            .map(|part| text_of(part.get("text")).to_owned())
                            .unwrap_or_default();
                        let text = event
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or(&current)
                            .to_owned();
                        update_first_text(
                            item,
                            "summary",
                            summary_index,
                            &text,
                            false,
                            "summary_text",
                        );
                    }
                }
                "response.function_call_arguments.delta" => {
                    let item = ensure_function_call(&mut items, index, &item_id, now);
                    let next = format!(
                        "{}{}",
                        text_of(item.get("arguments")),
                        text_of(event.get("delta"))
                    );
                    item.insert("arguments".to_owned(), Value::String(next));
                }
                "response.function_call_arguments.done" => {
                    let item = ensure_function_call(&mut items, index, &item_id, now);
                    if let Some(arguments) = event.get("arguments").and_then(Value::as_str) {
                        item.insert("arguments".to_owned(), json!(arguments));
                    }
                }
                _ => {}
            }
        }
        if RESPONSES_TERMINAL_EVENTS.contains(&kind) && truthy(event.get("response")) {
            terminal = event.get("response").cloned();
            terminal_event = kind.to_owned();
        }
        if let Some(response) = event.get("response").filter(|value| value.is_object()) {
            latest = Some(response.clone());
        } else if event.get("object").and_then(Value::as_str) == Some("response") {
            latest = Some(Value::Object(event.clone()));
        }
    }
    let picked = terminal.clone().or(latest)?;
    let picked = picked.as_object()?;
    let reconstructed: Vec<Value> = items.into_values().map(Value::Object).collect();
    let picked_output = picked
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_message = |items: &[Value]| {
        items
            .iter()
            .any(|item| item.get("type").and_then(Value::as_str) == Some("message"))
    };
    // #3948: a terminal snapshot without the assistant message keeps the
    // reconstructed one.
    let output =
        if !picked_output.is_empty() && !has_message(&picked_output) && has_message(&reconstructed)
        {
            reconstructed
        } else if !picked_output.is_empty() {
            picked_output
        } else {
            reconstructed
        };
    let output: Vec<Value> = output
        .into_iter()
        .map(|item| {
            let mut record = item.as_object().cloned().unwrap_or_default();
            for key in ["id", "call_id"] {
                if let Some(value) = record.get_mut(key) {
                    *value = id_string(value);
                }
            }
            Value::Object(record)
        })
        .collect();
    let status_fallback = match terminal_event.as_str() {
        "response.cancelled" => "cancelled",
        "response.canceled" => "canceled",
        "response.failed" => "failed",
        "response.incomplete" => "incomplete",
        _ if terminal.is_some() => "completed",
        _ => "in_progress",
    };
    let or = |key: &str, fallback: Value| {
        picked
            .get(key)
            .filter(|value| truthy(Some(value)))
            .cloned()
            .unwrap_or(fallback)
    };
    let id = match picked.get("id") {
        None | Some(Value::Null) => json!(format!("resp_{now}")),
        Some(value) => id_string(value),
    };
    Some(json!({
        "id": id,
        "object": or("object", json!("response")),
        "model": or("model", json!(if fallback_model.is_empty() { "unknown" } else { fallback_model })),
        "output": output,
        "usage": or("usage", Value::Null),
        "status": or("status", json!(status_fallback)),
        "created_at": or("created_at", json!(now)),
        "metadata": or("metadata", json!({})),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(payload: &mut Value, model: &str, account_id: Option<&str>) -> Result<(), ()> {
        let account = CodexAccount {
            account_id: account_id.map(str::to_owned),
            ..CodexAccount::default()
        };
        shape_passthrough(payload, model, Some(&account), &CodexServiceTier::default())
    }

    fn client(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(*name, HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    fn header<'a>(headers: &'a [(&'static str, HeaderValue)], name: &str) -> Option<&'a str> {
        headers
            .iter()
            .find(|(key, _)| *key == name)
            .and_then(|(_, value)| value.to_str().ok())
    }

    // Ported from tests/unit/codex-client-headers.test.ts.
    #[test]
    fn the_callers_codex_version_is_forwarded() {
        assert_eq!(
            client_version_from_headers(&client(&[(
                "user-agent",
                "codex_cli_rs/0.154.0 (Mac OS 26.6.2; arm64)"
            )])),
            Some("0.154.0".to_owned())
        );
        assert_eq!(
            client_version_from_headers(&client(&[(
                "user-agent",
                "codex_exec/0.154.0 (Mac OS 26.6.2; arm64) xterm-256color (codex_exec; 0.154.0)"
            )])),
            Some("0.154.0".to_owned())
        );
        assert_eq!(
            client_version_from_headers(&client(&[
                ("version", "9.9.9"),
                ("user-agent", "codex_cli_rs/0.154.0 (Mac OS 26.6.2; arm64)")
            ])),
            Some("9.9.9".to_owned())
        );
        assert_eq!(client_version_from_headers(&HeaderMap::new()), None);
        assert_eq!(
            client_version_from_headers(&client(&[("user-agent", "curl/8.4.0")])),
            None
        );
        let overlong = format!("1.0.0-{}", "a".repeat(30));
        assert_eq!(
            client_version_from_headers(&client(&[("version", &overlong)])),
            None
        );

        let caller = client_version_from_headers(&client(&[(
            "user-agent",
            "codex_cli_rs/0.160.2 (Mac OS 26.6.2; arm64)",
        )]));
        let built = headers(caller.as_deref(), None);
        assert_eq!(header(&built, "version"), Some("0.160.2"));
        assert_eq!(
            header(&built, "user-agent"),
            Some("codex-cli/0.160.2 (Windows 10.0.26200; x64)")
        );
        let built = headers(Some(&overlong), None);
        assert_eq!(
            header(&built, "version"),
            Some(DEFAULT_CODEX_CLIENT_VERSION)
        );
        assert_eq!(header(&built, "originator"), Some("codex_cli_rs"));
        assert_eq!(header(&built, "accept"), Some("text/event-stream"));
        assert_eq!(header(&built, "chatgpt-account-id"), None);
        assert_eq!(header(&built, "session_id"), None);

        let bound = headers(None, Some("ws-account-001"));
        assert_eq!(header(&bound, "chatgpt-account-id"), Some("ws-account-001"));
        assert_eq!(header(&bound, "session_id"), Some("ws-account-001"));
    }

    // Ported from tests/unit/codex-reasoning-suffix.test.ts.
    #[test]
    fn reasoning_suffixes_split_only_for_supported_models() {
        assert_eq!(
            split_reasoning_suffix("gpt-6-astra-max"),
            ("gpt-6-astra", Some("max"))
        );
        assert_eq!(
            split_reasoning_suffix("gpt-6-astra(ultra)"),
            ("gpt-6-astra", Some("ultra"))
        );
        assert_eq!(
            split_reasoning_suffix("gpt-6-other-max"),
            ("gpt-6-other-max", None)
        );
        assert_eq!(
            split_reasoning_suffix("gpt-6-luna-ultra"),
            ("gpt-6-luna-ultra", None)
        );
        assert_eq!(
            split_reasoning_suffix("gpt-5.5-xhigh"),
            ("gpt-5.5", Some("xhigh"))
        );
        assert_eq!(split_reasoning_suffix("gpt-5.5"), ("gpt-5.5", None));
        assert_eq!(clamp_effort("gpt-5-mini", "xhigh".to_owned()), "high");
        assert_eq!(clamp_effort("gpt-5.5", "max".to_owned()), "xhigh");
        assert_eq!(clamp_effort("gpt-6-astra", "ultra".to_owned()), "ultra");
        assert_eq!(clamp_effort("gpt-5.5", "weird".to_owned()), "weird");
    }

    // Ported from tests/unit/codex-cache-key.test.ts.
    #[test]
    fn the_prompt_cache_key_prefers_the_conversation() {
        let key = |body: Value, account: Option<&str>| {
            let mut body = body;
            shape(&mut body, "gpt-5.5", account).unwrap();
            assert!(body.get("session_id").is_none());
            assert!(body.get("conversation_id").is_none());
            body.get("prompt_cache_key").cloned()
        };
        let account = Some("ws-account-001");
        assert_eq!(
            key(json!({"session_id": "sess-001"}), account),
            Some(json!("sess-001"))
        );
        assert_eq!(
            key(json!({"conversation_id": "conv-002"}), account),
            Some(json!("conv-002"))
        );
        assert_eq!(
            key(
                json!({"session_id": "sess-001", "conversation_id": "conv-002"}),
                account
            ),
            Some(json!("sess-001"))
        );
        assert_eq!(
            key(json!({"model": "gpt-5.5"}), account),
            Some(json!("ws-account-001"))
        );
        assert_eq!(key(json!({}), None), None);
        assert_eq!(
            key(json!({"session_id": ""}), Some("ws-001")),
            Some(json!("ws-001"))
        );
        assert_eq!(
            key(json!({"session_id": 12345}), Some("ws-001")),
            Some(json!("ws-001"))
        );
        assert_eq!(
            key(
                json!({"prompt_cache_key": "mine", "session_id": "s"}),
                account
            ),
            Some(json!("mine"))
        );
    }

    #[test]
    fn passthrough_bodies_are_shaped_for_the_codex_backend() {
        let mut body = json!({
            "model": "gpt-5.5-high",
            "stream": false,
            "messages": [
                {"role": "system", "content": "be brief"},
                {"role": "user", "content": [{"type": "text", "text": "hi"}]}
            ],
            "reasoning": {"enabled": true, "max_tokens": 10},
            "max_output_tokens": 100,
            "temperature": 0.2,
            "user": "someone",
            "truncation": "auto",
            "service_tier": " Fast "
        });
        shape(&mut body, "gpt-5.5-high", None).unwrap();
        assert_eq!(
            body,
            json!({
                "model": "gpt-5.5",
                "stream": true,
                "input": [
                    {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "be brief"}]},
                    {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}
                ],
                "instructions": PASSTHROUGH_INSTRUCTIONS,
                "store": false,
                "reasoning": {"effort": "high", "summary": "auto"},
                "include": [ENCRYPTED_REASONING_INCLUDE],
                "service_tier": "priority"
            })
        );

        // Reasoning turned off keeps no summary and no encrypted include.
        let mut body =
            json!({"input": "hello", "instructions": "x", "reasoning": {"enabled": false}});
        shape(&mut body, "gpt-5.5", None).unwrap();
        assert_eq!(body["reasoning"], json!({"effort": "none"}));
        assert!(body.get("include").is_none());
        assert_eq!(
            body["input"],
            json!([{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hello"}]}])
        );
        assert_eq!(body["instructions"], json!("x"));

        // Assistant history replays as output_text, and an empty turn continues.
        let mut body = json!({"input": [{"role": "assistant", "content": [{"type": "input_text", "text": "a", "annotations": []}]}], "reasoning_effort": "LOW"});
        shape(&mut body, "gpt-5.5", None).unwrap();
        assert_eq!(
            body["input"],
            json!([{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "a"}]}])
        );
        assert_eq!(body["reasoning"]["effort"], json!("low"));
        let mut body = json!({"input": []});
        shape(&mut body, "gpt-5.5", None).unwrap();
        assert_eq!(body["input"][0]["content"][0]["text"], json!("continue"));
        assert_eq!(body["reasoning"]["effort"], json!("medium"));

        // Ultra is sent as max on the wire.
        let mut body = json!({"input": "x", "model": "gpt-6-astra-ultra"});
        shape(&mut body, "gpt-6-astra-ultra", None).unwrap();
        assert_eq!(body["model"], json!("gpt-6-astra"));
        assert_eq!(body["reasoning"]["effort"], json!("max"));
        assert!(shape(&mut json!([]), "gpt-5.5", None).is_err());
    }

    // Ported from tests/unit/codex-fast-tier.test.ts and
    // codex-connection-defaults.test.ts.
    #[test]
    fn the_service_tier_follows_the_body_then_the_global_mode_then_the_account() {
        let tiered =
            |body: Value, model: &str, tier: Option<&'static str>, global: &CodexServiceTier| {
                let mut body = body;
                let account = CodexAccount {
                    service_tier: tier,
                    ..CodexAccount::default()
                };
                shape_passthrough(&mut body, model, Some(&account), global).unwrap();
                body.get("service_tier").cloned()
            };
        let off = CodexServiceTier::default();
        let on = CodexServiceTier {
            enabled: true,
            ..CodexServiceTier::default()
        };
        let mode = |tier: &str| CodexServiceTier {
            enabled: true,
            tier: Some(tier.to_owned()),
            ..CodexServiceTier::default()
        };
        assert_eq!(tiered(json!({}), "gpt-5.5", None, &off), None);
        assert_eq!(
            tiered(json!({}), "gpt-5.5", Some("flex"), &off),
            Some(json!("flex"))
        );
        assert_eq!(
            tiered(json!({}), "gpt-5.5", None, &on),
            Some(json!("priority"))
        );
        assert_eq!(
            tiered(json!({}), "codex/gpt-5.5", Some("priority"), &mode("flex")),
            Some(json!("flex"))
        );
        // A global default clears the account tier.
        assert_eq!(
            tiered(json!({}), "gpt-5.5", Some("priority"), &mode("default")),
            None
        );
        // Prefixed and effort-suffixed ids match; other models keep the account tier.
        for model in ["gpt-6-sol", "cx/gpt-6-sol", "codex/gpt-6-luna-high"] {
            assert_eq!(
                tiered(json!({}), model, None, &on),
                Some(json!("priority")),
                "{model}"
            );
        }
        assert_eq!(tiered(json!({}), "codex/gpt-5.3-codex", None, &on), None);
        assert_eq!(
            tiered(json!({}), "gpt-5.3-codex", Some("flex"), &on),
            Some(json!("flex"))
        );
        let chosen = CodexServiceTier {
            enabled: true,
            supported_models: vec!["gpt-5.5".to_owned()],
            ..CodexServiceTier::default()
        };
        assert_eq!(tiered(json!({}), "gpt-6-sol", None, &chosen), None);
        // A valid body tier wins; an invalid one is replaced.
        for tier in ["default", "flex", "priority"] {
            assert_eq!(
                tiered(json!({"service_tier": tier}), "gpt-6-sol", None, &on),
                Some(json!(tier))
            );
        }
        assert_eq!(
            tiered(json!({"service_tier": " Flex "}), "gpt-5.5", None, &on),
            Some(json!("flex"))
        );
        assert_eq!(
            tiered(json!({"service_tier": "invalid"}), "gpt-5.5", None, &on),
            Some(json!("priority"))
        );
        // Without the global mode the executor keeps any body tier, fast as priority.
        assert_eq!(
            tiered(
                json!({"service_tier": "Fast"}),
                "gpt-5.5",
                Some("flex"),
                &off
            ),
            Some(json!("priority"))
        );
        // A database the legacy defaults migration never ran on.
        let unmigrated = CodexServiceTier {
            unmigrated_connection_tier: Some("priority".to_owned()),
            ..CodexServiceTier::default()
        };
        assert_eq!(
            tiered(json!({}), "gpt-5.3-codex", None, &unmigrated),
            Some(json!("priority"))
        );
        assert_eq!(
            tiered(json!({}), "gpt-5.3-codex", Some("flex"), &unmigrated),
            Some(json!("flex"))
        );
        assert!(mode("turbo").validate().is_err());
        assert!(on.validate().is_ok());
    }

    #[test]
    fn connection_request_defaults_come_from_the_legacy_session() {
        let account = CodexAccount::new(
            Some("ws".to_owned()),
            &json!({"legacyCodex": {"requestDefaults": {"reasoningEffort": " HIGH ", "serviceTier": "fast"}}}),
        );
        assert_eq!(account.reasoning_effort, Some("high"));
        assert_eq!(account.service_tier, Some("priority"));
        assert_eq!(
            CodexAccount::new(
                None,
                &json!({"legacyCodex": {"requestDefaults": {"reasoningEffort": "ultra", "serviceTier": "turbo"}}})
            ),
            CodexAccount::default()
        );
        let mut body = json!({"input": "x"});
        shape_passthrough(
            &mut body,
            "gpt-5.5",
            Some(&account),
            &CodexServiceTier::default(),
        )
        .unwrap();
        assert_eq!(body["reasoning"]["effort"], json!("high"));
        assert_eq!(body["service_tier"], json!("priority"));
        let mut body = json!({"input": "x", "reasoning": {"effort": "low"}});
        shape_passthrough(
            &mut body,
            "gpt-5.5",
            Some(&account),
            &CodexServiceTier::default(),
        )
        .unwrap();
        assert_eq!(body["reasoning"]["effort"], json!("low"));
    }

    // Ported from tests/unit/codex-free-plan-image-generation.test.ts,
    // codex-spark-image-generation.test.ts, codex-tools-redundant-oneof-enum.test.ts,
    // codex-tools-regex-lookaround.test.ts and codex-tools-strict-default.test.ts.
    #[test]
    fn tools_are_normalized_for_the_codex_backend() {
        let tools = |tools: Value, model: &str, free: bool| {
            let mut body = json!({"input": "x", "tools": tools});
            let account = CodexAccount {
                free_plan: free,
                ..CodexAccount::default()
            };
            shape_passthrough(
                &mut body,
                model,
                Some(&account),
                &CodexServiceTier::default(),
            )
            .unwrap();
            body
        };
        let hosted = json!([
            {"type": "image_generation", "output_format": "png"},
            {"type": "function", "name": "foo", "parameters": {"type": "object"}}
        ]);
        assert_eq!(
            tools(hosted.clone(), "gpt-5.5", true)["tools"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            tools(hosted.clone(), "gpt-5.5", false)["tools"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            tools(hosted, "gpt-5.3-codex-spark", false)["tools"]
                .as_array()
                .unwrap()
                .len(),
            1
        );

        let body = tools(
            json!([
                {"type": "function", "function": {"name": " read ", "description": "Read", "parameters": {"type": "object", "properties": {"email": {"type": "string", "pattern": "^(?=.*@).+$"}}}, "strict": true}},
                {"type": "function", "name": "  "},
                {"type": "custom", "name": "apply_patch", "format": {"type": "grammar"}},
                {"type": "namespace", "name": "mcp__x__", "tools": [{"name": "inner"}]},
                {"type": "web_search"},
                {"type": "unknown_hosted"},
                {"type": "local_shell", "name": "sh"},
                "not a tool",
                {"type": "function", "name": "bare"}
            ]),
            "gpt-5.5",
            false,
        );
        assert_eq!(
            body["tools"],
            json!([
                {"type": "function", "name": "read", "description": "Read", "parameters": {"type": "object", "properties": {"email": {"type": "string"}}}, "strict": true},
                {"type": "custom", "name": "apply_patch", "format": {"type": "grammar"}},
                {"type": "namespace", "name": "mcp__x__", "tools": [{"name": "inner"}]},
                {"type": "web_search"},
                {"type": "function", "name": "bare", "parameters": {"type": "object", "properties": {}}}
            ])
        );

        // A tool choice must name a kept tool.
        for (choice, kept) in [
            (json!({"type": "function", "name": "read"}), true),
            (json!({"type": "function", "name": "inner"}), true),
            (json!({"type": "function", "name": "missing"}), false),
            (json!({"type": "local_shell"}), false),
            (json!("auto"), true),
        ] {
            let mut body = json!({"input": "x", "tools": [{"type": "function", "name": "read"}, {"type": "namespace", "tools": [{"name": "inner"}]}], "tool_choice": choice});
            shape(&mut body, "gpt-5.5", None).unwrap();
            assert_eq!(body.get("tool_choice").is_some(), kept, "{choice}");
        }

        // A oneOf that only repeats its sibling enum is dropped.
        let schema = |one_of: Value, values: Value| {
            strip_redundant_one_of_const_enum(
                json!({"type": "string", "oneOf": one_of, "enum": values}),
            )
            .get("oneOf")
            .cloned()
        };
        assert_eq!(
            schema(
                json!([{"const": "a", "description": "A"}, {"const": "b"}]),
                json!(["b", "a"])
            ),
            None
        );
        for (one_of, values) in [
            (json!([{"const": "a"}, {"const": "b"}]), json!(["a", "c"])),
            (json!([{"const": "a"}]), json!(["a", "b"])),
            (json!([{"const": "a"}, {"const": "a"}]), json!(["a"])),
            (json!([{"const": "a", "minLength": 1}]), json!(["a"])),
            (json!([{"type": "string"}]), json!(["a"])),
            (json!([]), json!(["a"])),
            (json!([{"const": 1}]), json!([1])),
        ] {
            assert!(schema(one_of.clone(), values).is_some(), "{one_of}");
        }
        let nested = strip_redundant_one_of_const_enum(
            json!({"properties": {"action": {"oneOf": [{"const": "go"}], "enum": ["go"]}}, "anyOf": [{"oneOf": [{"const": "x"}], "enum": ["x"]}]}),
        );
        assert!(nested["properties"]["action"].get("oneOf").is_none());
        assert!(nested["anyOf"][0].get("oneOf").is_none());

        let free = CodexAccount::new(None, &json!({"legacyCodex": {"workspacePlanType": "FREE"}}));
        assert!(free.free_plan);
        assert!(
            CodexAccount::new(None, &json!({"legacyCodex": {"chatgptPlanType": "free"}})).free_plan
        );
        assert!(
            !CodexAccount::new(
                None,
                &json!({"legacyCodex": {"workspacePlanType": "team", "chatgptPlanType": "free"}})
            )
            .free_plan
        );
        use base64::Engine as _;
        let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"https://api.openai.com/auth":{"chatgpt_plan_type":"free"}}"#);
        assert!(
            CodexAccount::new(None, &json!({"id_token": format!("e30.{claims}.sig")})).free_plan
        );
    }

    // Ported from tests/unit/codex-orphaned-tool-outputs-2928.test.ts and the
    // toolCallRepair cases.
    #[test]
    fn tool_call_history_is_repaired() {
        let mut body = json!({"input": [
            {"type": "function_call_output", "call_id": "orphan", "output": "x"},
            {"type": "function_call", "call_id": "call_1", "name": "f", "arguments": "{}"},
            {"type": "custom_tool_call", "call_id": "custom_1", "name": "g", "input": ""},
            {"type": "custom_tool_call_output", "call_id": "custom_1", "output": "ok"},
            {"type": "message", "role": "user", "content": "go"}
        ]});
        shape(&mut body, "gpt-5.5", None).unwrap();
        let kinds: Vec<_> = body["input"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["type"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            kinds,
            [
                "function_call",
                "function_call_output",
                "custom_tool_call",
                "custom_tool_call_output",
                "message"
            ]
        );
        assert_eq!(
            body["input"][1],
            json!({"type": "function_call_output", "call_id": "call_1", "output": ""})
        );

        // Chat Completions tool calls embedded in a message also match.
        let mut body = json!({"input": [
            {"type": "message", "role": "assistant", "content": [], "tool_calls": [{"id": "call_cc1", "type": "function"}]},
            {"type": "function_call_output", "call_id": "call_cc1", "output": "ok"},
            {"type": "function_call_output", "call_id": "call_cc2", "output": "orphaned"}
        ]});
        shape(&mut body, "gpt-5.5", None).unwrap();
        let outputs: Vec<_> = body["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["type"] == "function_call_output")
            .collect();
        assert_eq!(
            outputs,
            [&json!({"type": "function_call_output", "call_id": "call_cc1", "output": "ok"})]
        );

        // A previous response keeps outputs whose call lives upstream.
        let mut body = json!({"previous_response_id": "resp_1", "input": [
            {"type": "function_call_output", "call_id": "remote", "output": "x"}
        ]});
        shape(&mut body, "gpt-5.5", None).unwrap();
        assert_eq!(body["input"].as_array().unwrap().len(), 1);
    }

    // Ported from tests/unit/codex-stream-false.test.ts and
    // tests/unit/t19-codex-responses-empty-content.test.ts.
    #[test]
    fn a_codex_event_stream_folds_into_one_response() {
        let sse = concat!(
            "event: response.created\n",
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"object\":\"response\",\"status\":\"in_progress\",\"model\":\"gpt-5.5\"}}\n\n",
            "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\",\"summary\":[]}}\n\n",
            "data: {\"type\":\"response.reasoning_summary_text.delta\",\"output_index\":0,\"item_id\":\"rs_1\",\"summary_index\":0,\"delta\":\"think\"}\n\n",
            "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"output_index\":1,\"delta\":\"Hel\"}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"output_index\":1,\"delta\":\"lo\"}\n\n",
            "data: {\"type\":\"response.output_item.added\",\"output_index\":2,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"f\",\"arguments\":\"\"}}\n\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":2,\"item_id\":\"fc_1\",\"delta\":\"{\\\"a\\\"\"}\n\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":2,\"item_id\":\"fc_1\",\"delta\":\":1}\"}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-5.5\",\"created_at\":7,\"output\":[{\"id\":\"rs_1\",\"type\":\"reasoning\",\"summary\":[]}],\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"total_tokens\":5}}}\n\n",
            "data: [DONE]\n\n"
        );
        let response = responses_from_sse(sse.as_bytes(), "fallback").unwrap();
        assert_eq!(response["id"], json!("resp_1"));
        assert_eq!(response["status"], json!("completed"));
        assert_eq!(response["created_at"], json!(7));
        assert_eq!(response["usage"]["total_tokens"], json!(5));
        // The terminal output lacks the message, so the streamed items win.
        let output = response["output"].as_array().unwrap();
        assert_eq!(output.len(), 3);
        assert_eq!(output[0]["summary"][0]["text"], json!("think"));
        assert_eq!(output[1]["content"][0]["text"], json!("Hello"));
        assert_eq!(output[1]["content"][0]["type"], json!("output_text"));
        assert_eq!(output[2]["arguments"], json!("{\"a\":1}"));
        assert_eq!(output[2]["call_id"], json!("call_1"));

        // A complete terminal snapshot is returned as sent.
        let sse = concat!(
            "data: {\"type\":\"response.output_text.delta\",\"output_index\":0,\"delta\":\"x\"}\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_2\",\"output\":[{\"id\":\"m\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"final\"}]}]}}\n"
        );
        let response = responses_from_sse(sse.as_bytes(), "gpt-5.5").unwrap();
        assert_eq!(response["output"][0]["content"][0]["text"], json!("final"));
        assert_eq!(response["model"], json!("gpt-5.5"));
        assert_eq!(response["object"], json!("response"));
        assert_eq!(response["status"], json!("completed"));

        // A failed stream reports its status; a stream without a response is
        // not a response.
        let failed = responses_from_sse(
            b"data: {\"type\":\"response.failed\",\"response\":{\"id\":\"r\",\"error\":{\"message\":\"x\"}}}\n",
            "m",
        )
        .unwrap();
        assert_eq!(failed["status"], json!("failed"));
        assert!(
            responses_from_sse(b"data: {\"type\":\"response.output_text.delta\"}\n", "m").is_none()
        );
        assert!(responses_from_sse(b"not an event stream", "m").is_none());
    }
}
