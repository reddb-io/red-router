//! OpenAI-format request cleanup from the legacy `filterToOpenAIFormat`
//! (`open-sse/translator/helpers/openaiHelper.ts`) and the surrounding
//! `translateRequest` rules for an OpenAI Chat Completions target.
//!
//! The filter maps `developer` to `system`, keeps only standard content
//! blocks (Moonshot's `video_url` when the model keeps it), turns thinking
//! blocks into `reasoning_content`, inlines text-only files and tool results,
//! drops empty turns and Claude-only fields, and normalizes Claude and Gemini
//! tools and tool choices. Not ported yet: the global cache-control setting
//! and per-connection cache overrides (the `auto` mode applies).

use serde_json::{json, Map, Value};

const VALID_CONTENT_TYPES: [&str; 8] = [
    "text",
    "image_url",
    "image",
    "file_url",
    "file",
    "document",
    "input_audio",
    "audio_url",
];

/// Providers that honor explicit OpenAI-format `cache_control` breakpoints
/// (legacy `OPENAI_FORMAT_CACHE_CONTROL_PROVIDERS`, all also caching providers).
const OPENAI_FORMAT_CACHE_CONTROL_PROVIDERS: [&str; 8] = [
    "alibaba",
    "alibaba-cn",
    "alicode",
    "alicode-intl",
    "alims-intl",
    "alitp-intl",
    "qwen-cloud",
    "xiaomi-mimo",
];

/// Message fields a non-replay OpenAI target rejects
/// (legacy `OPENAI_INCOMPATIBLE_ECHO_FIELDS`).
const ECHO_FIELDS: [&str; 5] = [
    "reasoning_content",
    "reasoning",
    "refusal",
    "annotations",
    "cache_control",
];

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct FilterOptions {
    pub(crate) preserve_cache_control: bool,
    pub(crate) preserve_video_url: bool,
    pub(crate) preserve_reasoning_content: bool,
}

/// Legacy default when the model sets no `preserveVideoUrl` flag.
pub(crate) fn preserve_video_url(flag: Option<bool>, provider: &str) -> bool {
    flag.unwrap_or(matches!(provider, "moonshot" | "kimi"))
}

/// Legacy `isClaudeCodeClient`.
pub(crate) fn is_claude_code_client(user_agent: Option<&str>) -> bool {
    let Some(agent) = user_agent else {
        return false;
    };
    let agent = agent.to_lowercase();
    agent.contains("claude-code")
        || agent.contains("claude_code")
        || agent.contains("claude-cli/")
        || agent.contains("sdk-cli")
        || (agent.contains("anthropic") && agent.contains("cli"))
}

/// Legacy `shouldPreserveCacheControl` in `auto` mode combined with
/// `providerHonorsOpenAIFormatCacheControl`: a caching-aware client talking to
/// a provider that reads OpenAI-format breakpoints.
/// The operator's client cache-marker policy (legacy `alwaysPreserveClientCache`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CacheControlMode {
    /// Preserve for caching-aware clients talking to caching providers.
    #[default]
    Auto,
    Always,
    Never,
}

/// Whether a request keeps its `cache_control` markers (legacy
/// `shouldPreserveCacheControl`: an explicit mode wins over the automatic rule).
#[derive(Clone, Copy, Debug)]
pub(crate) struct CachePolicy {
    pub mode: CacheControlMode,
    pub claude_code_client: bool,
}

impl CachePolicy {
    pub(crate) fn preserves(&self, provider: &str) -> bool {
        match self.mode {
            CacheControlMode::Always => true,
            CacheControlMode::Never => false,
            CacheControlMode::Auto => preserve_cache_control(self.claude_code_client, provider),
        }
    }
}

pub(crate) fn preserve_cache_control(claude_code_client: bool, provider: &str) -> bool {
    claude_code_client
        && OPENAI_FORMAT_CACHE_CONTROL_PROVIDERS.contains(&provider.to_lowercase().as_str())
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// JavaScript `??` operand: present and not null.
fn defined(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// JavaScript `String(value)` for JSON values.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => match (number.as_i64(), number.as_u64(), number.as_f64()) {
            (Some(integer), _, _) => integer.to_string(),
            (_, Some(integer), _) => integer.to_string(),
            (_, _, Some(float)) if float.fract() == 0.0 && float.abs() < 1e21 => {
                format!("{float:.0}")
            }
            _ => number.to_string(),
        },
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

fn block_type(block: &Map<String, Value>) -> Option<&str> {
    block.get("type").and_then(Value::as_str)
}

/// A `file`/`document` block without a URL or inline data becomes a text
/// block carrying its name and contents.
fn inline_file_text(block: &Map<String, Value>) -> Option<String> {
    let file = block.get("file");
    let data = defined(block.get("file_url"))
        .or(defined(file))
        .or(defined(block.get("document")));
    if truthy(data.and_then(|data| data.get("url")))
        || truthy(data.and_then(|data| data.get("data")))
    {
        return None;
    }
    let file_field = |key: &str| defined(file.and_then(|file| file.get(key)));
    let content = file_field("content")
        .or(file_field("text"))
        .or(defined(block.get("content")))
        .or(defined(block.get("text")))?;
    let name = file_field("name")
        .or(defined(block.get("name")))
        .map_or_else(|| "attachment".to_owned(), js_string);
    match content {
        Value::String(content) if !content.is_empty() => Some(format!("[{name}]\n{content}")),
        _ => None,
    }
}

fn tool_result_text(block: &Map<String, Value>) -> Option<String> {
    let content = defined(block.get("content"))
        .or(defined(block.get("text")))
        .or(defined(block.get("output")));
    let text = match content {
        None => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
            .map(|item| defined(item.get("text")).map(js_string).unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n"),
        Some(other) => other.to_string(),
    };
    if text.is_empty() {
        return None;
    }
    let id = defined(block.get("tool_use_id"))
        .or(defined(block.get("id")))
        .map_or_else(|| "unknown".to_owned(), js_string);
    Some(format!("[Tool Result: {id}]\n{text}"))
}

fn filter_blocks(blocks: Vec<Value>, options: FilterOptions) -> (Vec<Value>, Option<Value>) {
    let mut filtered = Vec::with_capacity(blocks.len());
    let mut thinking = None;
    for block in blocks {
        let Value::Object(mut block) = block else {
            continue;
        };
        let kind = block_type(&block).map(str::to_owned);
        match kind.as_deref() {
            Some("thinking") => {
                thinking = Some(
                    [block.get("thinking"), block.get("text")]
                        .into_iter()
                        .find(|value| truthy(*value))
                        .flatten()
                        .cloned()
                        .unwrap_or_else(|| Value::String(String::new())),
                );
            }
            Some(kind)
                if VALID_CONTENT_TYPES.contains(&kind)
                    || (options.preserve_video_url && kind == "video_url") =>
            {
                block.remove("signature");
                let cache_control = block.remove("cache_control");
                if options.preserve_cache_control {
                    if let Some(cache_control) = cache_control {
                        block.insert("cache_control".to_owned(), cache_control);
                    }
                }
                if kind == "text" && block.get("text").and_then(Value::as_str) == Some("") {
                    continue;
                }
                if matches!(kind, "file" | "document") {
                    if let Some(text) = inline_file_text(&block) {
                        filtered.push(json!({"type":"text","text":text}));
                        continue;
                    }
                }
                filtered.push(Value::Object(block));
            }
            Some("tool_result") => {
                if let Some(text) = tool_result_text(&block) {
                    filtered.push(json!({"type":"text","text":text}));
                }
            }
            // `redacted_thinking`, `tool_use` and non-OpenAI blocks are dropped.
            _ => {}
        }
    }
    (filtered, thinking)
}

fn filter_message(message: &mut Value, options: FilterOptions) {
    let Some(object) = message.as_object_mut() else {
        return;
    };
    if object.get("role").and_then(Value::as_str) == Some("developer") {
        object.insert("role".to_owned(), Value::String("system".to_owned()));
    }
    let role = object
        .get("role")
        .and_then(Value::as_str)
        .map(str::to_owned);
    match role.as_deref() {
        Some("tool") => return,
        Some("assistant") if truthy(object.get("tool_calls")) => {
            // Reasoning blobs grow agentic context quadratically, except for
            // replay providers that require them back.
            if !options.preserve_reasoning_content {
                object.remove("reasoning_content");
            }
            return;
        }
        _ => {}
    }
    let Some(Value::Array(blocks)) = object.get_mut("content") else {
        return;
    };
    let (mut filtered, thinking) = filter_blocks(std::mem::take(blocks), options);
    if filtered.is_empty() {
        filtered.push(json!({"type":"text","text":""}));
    }
    object.insert("content".to_owned(), Value::Array(filtered));
    if role.as_deref() == Some("assistant") && truthy(thinking.as_ref()) {
        object.insert("reasoning_content".to_owned(), thinking.unwrap_or_default());
    }
}

fn keeps_message(message: &Value) -> bool {
    let Some(object) = message.as_object() else {
        return true;
    };
    let role = object.get("role").and_then(Value::as_str);
    if role == Some("tool") {
        return true;
    }
    // Moonshot partial assistant turns are output prefixes; empty is valid.
    if role == Some("assistant")
        && (truthy(object.get("tool_calls")) || object.get("partial") == Some(&Value::Bool(true)))
    {
        return true;
    }
    match object.get("content") {
        Some(Value::String(text)) => !js_trim(text).is_empty(),
        Some(Value::Array(blocks)) => blocks.iter().any(|block| {
            if block.get("type").and_then(Value::as_str) == Some("text") {
                block
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|text| !js_trim(text).is_empty())
            } else {
                true
            }
        }),
        _ => true,
    }
}

fn default_parameters() -> Value {
    json!({"type":"object","properties":{}})
}

fn tool_description(value: Option<&Value>) -> Value {
    Value::String(defined(value).map(js_string).unwrap_or_default())
}

fn normalize_tool(tool: Value) -> Vec<Value> {
    let object = match tool {
        Value::Object(object) => object,
        // `Array.prototype.flat` also unwraps a nested tool array.
        Value::Array(items) => return items,
        other => return vec![other],
    };
    if block_type(&object) == Some("function") && truthy(object.get("function")) {
        return vec![Value::Object(object)];
    }
    if truthy(object.get("name"))
        && (truthy(object.get("input_schema")) || truthy(object.get("description")))
    {
        let parameters = object
            .get("input_schema")
            .filter(|schema| truthy(Some(*schema)))
            .cloned()
            .unwrap_or_else(default_parameters);
        return vec![json!({"type":"function","function":{
            "name": object["name"].clone(),
            "description": tool_description(object.get("description")),
            "parameters": parameters,
        }})];
    }
    if let Some(Value::Array(declarations)) = object.get("functionDeclarations") {
        return declarations
            .iter()
            .map(|declaration| {
                let mut function = Map::new();
                if let Some(name) = declaration.get("name") {
                    function.insert("name".to_owned(), name.clone());
                }
                function.insert(
                    "description".to_owned(),
                    tool_description(declaration.get("description")),
                );
                function.insert(
                    "parameters".to_owned(),
                    declaration
                        .get("parameters")
                        .filter(|parameters| truthy(Some(*parameters)))
                        .cloned()
                        .unwrap_or_else(default_parameters),
                );
                json!({"type":"function","function":Value::Object(function)})
            })
            .collect();
    }
    vec![Value::Object(object)]
}

fn normalize_tool_choice(choice: &Map<String, Value>) -> Option<Value> {
    match block_type(choice) {
        Some("auto") => Some(Value::String("auto".to_owned())),
        Some("any") => Some(Value::String("required".to_owned())),
        Some("tool") if truthy(choice.get("name")) => {
            Some(json!({"type":"function","function":{"name":choice["name"].clone()}}))
        }
        _ => None,
    }
}

/// Legacy `filterToOpenAIFormat`; a body without a `messages` array is left
/// untouched.
pub(crate) fn filter_to_openai_format(body: &mut Value, options: FilterOptions) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    for message in messages.iter_mut() {
        filter_message(message, options);
    }
    messages.retain(keeps_message);
    let Some(object) = body.as_object_mut() else {
        return;
    };
    // Some providers (Qwen) reject an empty tools array.
    if matches!(object.get("tools"), Some(Value::Array(tools)) if tools.is_empty()) {
        object.remove("tools");
    }
    for field in ["metadata", "anthropic_version", "client_metadata"] {
        object.remove(field);
    }
    if let Some(max_output_tokens) = object.remove("max_output_tokens") {
        object.entry("max_tokens").or_insert(max_output_tokens);
    }
    if let Some(Value::Array(tools)) = object.get_mut("tools") {
        let normalized = std::mem::take(tools)
            .into_iter()
            .flat_map(normalize_tool)
            .collect();
        *tools = normalized;
    }
    let choice = match object.get("tool_choice") {
        Some(Value::Object(choice)) => normalize_tool_choice(choice),
        _ => None,
    };
    if let Some(choice) = choice {
        object.insert("tool_choice".to_owned(), choice);
    }
}

/// Non-replay OpenAI targets reject echoed assistant metadata on any turn.
pub(crate) fn strip_echo_fields(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    for message in messages.iter_mut().filter_map(Value::as_object_mut) {
        for field in ECHO_FIELDS {
            message.remove(field);
        }
    }
}

/// Legacy `isGlmFamilyUpstream` (`translateRequest`).
fn is_glm_family_upstream(provider: &str, model: &str) -> bool {
    let model = model.to_lowercase();
    matches!(provider, "opencode-go" | "opencode-zen")
        || ["glm", "zhipu", "z-ai"]
            .iter()
            .any(|marker| model.contains(marker))
}

/// GLM-family upstreams reject a `messages` array without a `user` turn
/// (400 [1214]); agent tool loops reach that shape after compression. The
/// legacy fix appends a placeholder turn at the end, keeping every earlier
/// byte identical for prompt caches.
pub(crate) fn ensure_glm_user_turn(body: &mut Value, provider: &str, model: &str) {
    if !is_glm_family_upstream(provider, model) {
        return;
    }
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    if !messages
        .iter()
        .any(|message| message.get("role").and_then(Value::as_str) == Some("user"))
    {
        messages.push(json!({"role":"user","content":"(continue)"}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filtered(mut body: Value, options: FilterOptions) -> Value {
        filter_to_openai_format(&mut body, options);
        body
    }

    #[test]
    fn glm_family_requests_without_a_user_turn_get_a_placeholder() {
        let tool_loop = json!({"messages":[
            {"role":"system","content":"s"},
            {"role":"assistant","tool_calls":[]},
            {"role":"tool","tool_call_id":"x","content":"ok"}
        ]});
        for (provider, model) in [
            ("zai", "GLM-5.3-flash"),
            ("opencode-go", "kimi"),
            ("router", "z-ai/glm-5"),
            ("router", "zhipu-x"),
        ] {
            let mut body = tool_loop.clone();
            ensure_glm_user_turn(&mut body, provider, model);
            assert_eq!(
                body["messages"][3],
                json!({"role":"user","content":"(continue)"}),
                "{provider}/{model}"
            );
        }
        let mut other = tool_loop.clone();
        ensure_glm_user_turn(&mut other, "openai", "gpt-5");
        assert_eq!(other, tool_loop);
        let with_user = json!({"messages":[{"role":"user","content":"hi"}]});
        let mut unchanged = with_user.clone();
        ensure_glm_user_turn(&mut unchanged, "zai", "glm-5");
        assert_eq!(unchanged, with_user);
    }

    #[test]
    fn video_url_defaults_to_kept_only_for_moonshot_and_kimi() {
        assert!(preserve_video_url(None, "moonshot"));
        assert!(preserve_video_url(None, "kimi"));
        assert!(!preserve_video_url(None, "openai"));
        assert!(preserve_video_url(Some(true), "openai"));
        assert!(!preserve_video_url(Some(false), "moonshot"));
    }

    #[test]
    fn content_keeps_standard_blocks_and_folds_the_rest() {
        let body = json!({"messages":[
            {"role":"developer","content":"policy"},
            {"role":"user","content":[
                {"type":"text","text":"describe","cache_control":{"type":"ephemeral"},"signature":"s"},
                {"type":"text","text":""},
                {"type":"video_url","video_url":{"url":"https://example.test/clip.mp4"}},
                {"type":"input_text","text":"dropped"},
                {"type":"file","file":{"name":"notes.md","content":"hello"}},
                {"type":"file","file":{"file_data":"x","url":"https://example.test/a.pdf"}},
                {"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"42"},{"type":"image"}]},
                {"type":"tool_result","content":{"ok":true}}
            ]},
            {"role":"assistant","content":[
                {"type":"thinking","thinking":"plan"},
                {"type":"redacted_thinking","data":"x"},
                {"type":"tool_use","id":"t1"},
                {"type":"text","text":"answer"}
            ]},
            {"role":"tool","tool_call_id":"x","content":[{"type":"video_url"}]}
        ]});
        let out = filtered(body.clone(), FilterOptions::default());
        assert_eq!(
            out["messages"][0],
            json!({"role":"system","content":"policy"})
        );
        assert_eq!(
            out["messages"][1]["content"],
            json!([
                {"type":"text","text":"describe"},
                {"type":"text","text":"[notes.md]\nhello"},
                {"type":"file","file":{"file_data":"x","url":"https://example.test/a.pdf"}},
                {"type":"text","text":"[Tool Result: t1]\n42"},
                {"type":"text","text":"[Tool Result: unknown]\n{\"ok\":true}"}
            ])
        );
        assert_eq!(
            out["messages"][2],
            json!({"role":"assistant","content":[{"type":"text","text":"answer"}],"reasoning_content":"plan"})
        );
        assert_eq!(out["messages"][3], body["messages"][3]);
        let kept = filtered(
            body,
            FilterOptions {
                preserve_cache_control: true,
                preserve_video_url: true,
                ..FilterOptions::default()
            },
        );
        assert_eq!(
            kept["messages"][1]["content"][0],
            json!({"type":"text","text":"describe","cache_control":{"type":"ephemeral"}})
        );
        assert_eq!(kept["messages"][1]["content"][1]["type"], "video_url");
    }

    #[test]
    fn empty_turns_are_dropped_but_tool_and_prefix_turns_are_kept() {
        let out = filtered(
            json!({"messages":[
                {"role":"user","content":"  "},
                {"role":"user","content":[{"type":"redacted_thinking"}]},
                {"role":"assistant","content":"","partial":true},
                {"role":"assistant","tool_calls":[],"reasoning_content":"r"},
                {"role":"tool","content":""},
                {"role":"user"}
            ]}),
            FilterOptions::default(),
        );
        assert_eq!(
            out["messages"],
            json!([
                {"role":"assistant","content":"","partial":true},
                {"role":"assistant","tool_calls":[]},
                {"role":"tool","content":""},
                {"role":"user"}
            ])
        );
        let replay = filtered(
            json!({"messages":[{"role":"assistant","tool_calls":[{}],"reasoning_content":"r"}]}),
            FilterOptions {
                preserve_reasoning_content: true,
                ..FilterOptions::default()
            },
        );
        assert_eq!(replay["messages"][0]["reasoning_content"], "r");
    }

    #[test]
    fn request_fields_tools_and_tool_choice_are_normalized() {
        let out = filtered(
            json!({
                "messages":[{"role":"user","content":"hi"}],
                "metadata":{"user_id":"u"},"anthropic_version":"v","client_metadata":{},
                "max_output_tokens":64,
                "tools":[
                    {"type":"function","function":{"name":"a"}},
                    {"name":"b","input_schema":{"type":"object","properties":{"q":{"type":"string"}}}},
                    {"name":"c","description":7},
                    {"functionDeclarations":[{"name":"d","description":"gd"},{"description":"nameless"}]}
                ],
                "tool_choice":{"type":"any"}
            }),
            FilterOptions::default(),
        );
        assert_eq!(out["max_tokens"], 64);
        for field in [
            "metadata",
            "anthropic_version",
            "client_metadata",
            "max_output_tokens",
        ] {
            assert!(out.get(field).is_none(), "{field}");
        }
        assert_eq!(
            out["tools"],
            json!([
                {"type":"function","function":{"name":"a"}},
                {"type":"function","function":{"name":"b","description":"","parameters":{"type":"object","properties":{"q":{"type":"string"}}}}},
                {"type":"function","function":{"name":"c","description":"7","parameters":{"type":"object","properties":{}}}},
                {"type":"function","function":{"name":"d","description":"gd","parameters":{"type":"object","properties":{}}}},
                {"type":"function","function":{"description":"nameless","parameters":{"type":"object","properties":{}}}}
            ])
        );
        assert_eq!(out["tool_choice"], "required");
        let kept = filtered(
            json!({"messages":[],"max_tokens":8,"max_output_tokens":64,"tools":[],"tool_choice":{"type":"tool","name":"x"}}),
            FilterOptions::default(),
        );
        assert_eq!(kept["max_tokens"], 8);
        assert!(kept.get("tools").is_none());
        assert_eq!(
            kept["tool_choice"],
            json!({"type":"function","function":{"name":"x"}})
        );
        let untouched = json!({"input":"x","metadata":{}});
        assert_eq!(
            filtered(untouched.clone(), FilterOptions::default()),
            untouched
        );
    }

    #[test]
    fn cache_control_survives_only_for_breakpoint_providers_and_claude_clients() {
        assert!(is_claude_code_client(Some(
            "claude-cli/2.1.0 (external, cli)"
        )));
        assert!(is_claude_code_client(Some("Anthropic-SDK CLI")));
        assert!(!is_claude_code_client(Some("curl/8")));
        assert!(!is_claude_code_client(None));
        assert!(preserve_cache_control(true, "Alibaba"));
        assert!(!preserve_cache_control(true, "openai"));
        assert!(!preserve_cache_control(false, "xiaomi-mimo"));
        let policy = |mode, claude_code_client| CachePolicy {
            mode,
            claude_code_client,
        };
        assert!(policy(CacheControlMode::Always, false).preserves("openai"));
        assert!(!policy(CacheControlMode::Never, true).preserves("alibaba"));
        assert!(policy(CacheControlMode::Auto, true).preserves("alibaba"));
        assert!(!policy(CacheControlMode::Auto, true).preserves("openai"));
    }

    #[test]
    fn echo_fields_are_stripped_from_every_turn() {
        let mut body = json!({"messages":[
            {"role":"assistant","content":"a","reasoning_content":"r","reasoning":"x","refusal":null,"annotations":[],"cache_control":{}},
            "not-an-object"
        ]});
        strip_echo_fields(&mut body);
        assert_eq!(
            body["messages"],
            json!([{"role":"assistant","content":"a"}, "not-an-object"])
        );
    }
}
