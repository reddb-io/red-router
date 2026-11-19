//! Content-block rules for OpenAI-format targets from the legacy
//! `filterToOpenAIFormat` (`open-sse/translator/helpers/openaiHelper.ts`).
//!
//! Ported so far: the `preserveVideoUrl` rule (Moonshot's non-standard
//! `video_url` block reaches the upstream only when the model's flag keeps
//! it, or, unset, for the Moonshot and Kimi providers) and the GLM-family
//! user-turn placeholder from `translateRequest`.

use serde_json::Value;

/// Legacy default when the model sets no `preserveVideoUrl` flag.
pub(crate) fn preserve_video_url(flag: Option<bool>, provider: &str) -> bool {
    flag.unwrap_or(matches!(provider, "moonshot" | "kimi"))
}

/// Remove `video_url` blocks from every message's array content.
pub(crate) fn drop_video_url_blocks(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    for message in messages {
        // Tool messages and assistant tool-call turns pass through as-is.
        let role = message.get("role").and_then(Value::as_str);
        if role == Some("tool")
            || (role == Some("assistant") && message.get("tool_calls").is_some())
        {
            continue;
        }
        if let Some(content) = message.get_mut("content").and_then(Value::as_array_mut) {
            content.retain(|block| block.get("type").and_then(Value::as_str) != Some("video_url"));
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
        messages.push(serde_json::json!({"role":"user","content":"(continue)"}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
    fn video_url_blocks_are_removed_from_user_content_only() {
        let mut body = json!({"messages":[
            {"role":"user","content":[
                {"type":"text","text":"describe"},
                {"type":"video_url","video_url":{"url":"https://example.test/clip.mp4"}}
            ]},
            {"role":"user","content":"plain"},
            {"role":"tool","tool_call_id":"x","content":[{"type":"video_url","video_url":{"url":"kept"}}]}
        ]});
        drop_video_url_blocks(&mut body);
        assert_eq!(
            body["messages"][0]["content"],
            json!([{"type":"text","text":"describe"}])
        );
        assert_eq!(body["messages"][1]["content"], "plain");
        assert_eq!(body["messages"][2]["content"][0]["type"], "video_url");
    }
}
