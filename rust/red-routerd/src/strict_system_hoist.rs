//! Leading system messages for providers that reject a later one (#7293),
//! ported from the legacy `open-sse/translator/helpers/strictSystemHoist.ts`
//! and `systemMessageMustBeFirst` (`src/lib/memory/injection.ts`).
//!
//! For those providers every `system` message after the first position is
//! merged, in order, into a single leading system message; nothing is dropped.
//! Compliant requests are left byte-identical for prompt caches.

use serde_json::Value;
use std::collections::HashSet;
use std::sync::OnceLock;

const BUILTIN_PROVIDERS: [&str; 3] = ["xiaomi-mimo", "mimo", "tokenrouter"];

/// Providers from `OMNIROUTE_STRICT_SYSTEM_PROVIDERS` (comma-separated), as
/// the legacy server reads them, plus the built-in list.
fn strict_providers() -> &'static HashSet<String> {
    static PROVIDERS: OnceLock<HashSet<String>> = OnceLock::new();
    PROVIDERS.get_or_init(|| {
        let extra = std::env::var("OMNIROUTE_STRICT_SYSTEM_PROVIDERS").unwrap_or_default();
        parse_providers(&extra)
    })
}

fn parse_providers(extra: &str) -> HashSet<String> {
    BUILTIN_PROVIDERS
        .iter()
        .map(|provider| (*provider).to_owned())
        .chain(
            extra
                .split(',')
                .map(|id| id.trim().to_lowercase())
                .filter(|id| !id.is_empty()),
        )
        .collect()
}

/// Legacy `systemMessageMustBeFirst`.
pub(crate) fn system_message_must_be_first(provider: &str) -> bool {
    strict_providers().contains(&provider.trim().to_lowercase())
}

fn text_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .map(|part| match part.get("text") {
                Some(Value::String(text)) => text.clone(),
                Some(Value::Null) | None => String::new(),
                Some(other) => other.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn is_system(message: &Value) -> bool {
    message.get("role").and_then(Value::as_str) == Some("system")
}

/// Legacy `hoistLeadingSystemMessage` over a request body's `messages`.
pub(crate) fn hoist_leading_system_message(body: &mut Value, provider: &str) {
    if !system_message_must_be_first(provider) {
        return;
    }
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    if !messages.iter().skip(1).any(is_system) {
        return;
    }
    let mut offending = Vec::new();
    let mut rest = Vec::with_capacity(messages.len());
    for (index, message) in std::mem::take(messages).into_iter().enumerate() {
        if index > 0 && is_system(&message) {
            offending.push(message);
        } else {
            rest.push(message);
        }
    }
    let leading = rest
        .first()
        .filter(|first| is_system(first))
        .map(|first| text_content(first.get("content")));
    let merged = leading
        .into_iter()
        .chain(
            offending
                .iter()
                .map(|message| text_content(message.get("content"))),
        )
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    match rest.first_mut().filter(|first| is_system(first)) {
        Some(first) => {
            if let Some(object) = first.as_object_mut() {
                object.insert("content".to_owned(), Value::String(merged));
            }
        }
        None => rest.insert(0, serde_json::json!({"role":"system","content":merged})),
    }
    *messages = rest;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builtin_and_configured_providers_are_strict() {
        assert!(system_message_must_be_first("xiaomi-mimo"));
        assert!(system_message_must_be_first(" MiMo "));
        assert!(!system_message_must_be_first("openai"));
        let extended = parse_providers(" Custom-Gateway , ,other");
        assert!(extended.contains("custom-gateway") && extended.contains("other"));
        assert!(extended.contains("tokenrouter"));
    }

    #[test]
    fn later_system_messages_merge_into_the_leading_one() {
        let mut body = json!({"messages":[
            {"role":"system","content":"base"},
            {"role":"user","content":"hi"},
            {"role":"system","content":[{"type":"text","text":"injected"}]},
            {"role":"assistant","content":"ok"}
        ]});
        hoist_leading_system_message(&mut body, "mimo");
        assert_eq!(
            body["messages"],
            json!([
                {"role":"system","content":"base\ninjected"},
                {"role":"user","content":"hi"},
                {"role":"assistant","content":"ok"}
            ])
        );
    }

    #[test]
    fn a_leading_system_message_is_created_when_none_exists() {
        let mut body = json!({"messages":[
            {"role":"user","content":"hi"},
            {"role":"system","content":"late"}
        ]});
        hoist_leading_system_message(&mut body, "tokenrouter");
        assert_eq!(
            body["messages"],
            json!([{"role":"system","content":"late"},{"role":"user","content":"hi"}])
        );
    }

    #[test]
    fn compliant_requests_and_other_providers_are_untouched() {
        let compliant =
            json!({"messages":[{"role":"system","content":"a"},{"role":"user","content":"b"}]});
        let mut body = compliant.clone();
        hoist_leading_system_message(&mut body, "mimo");
        assert_eq!(body, compliant);
        let late =
            json!({"messages":[{"role":"user","content":"b"},{"role":"system","content":"a"}]});
        let mut other = late.clone();
        hoist_leading_system_message(&mut other, "openai");
        assert_eq!(other, late);
    }
}
