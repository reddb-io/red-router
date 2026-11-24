//! Request-scoped resource errors, ported from the legacy
//! `open-sse/services/requestResourceErrors.ts`.
//!
//! A provider can answer 404 for a resource the request names (a
//! conversation or thread id, a Files API id, a response item, an upload).
//! That failure describes the payload, not provider or model health, and no
//! other account or model can make the unknown id valid. Every expression is
//! bounded, as in the legacy module, because upstreams control the body.

use regex::Regex;
use std::sync::LazyLock;

/// Legacy `RESOURCE_NOT_FOUND_PATTERNS`. JavaScript `\b` is an ASCII word
/// boundary, hence `(?-u:\b)`.
static RESOURCE_NOT_FOUND_PATTERNS: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        r"(?i)(?-u:\b)(?:thread_not_found|previous_message(?:_id)?_not_found)(?-u:\b)",
        r"(?i)(?-u:\b)(?:thread|previous[_ -]?message[_ -]?id)(?-u:\b)[^\n]{0,160}(?-u:\b)(?:not found|does not exist|unknown|invalid)(?-u:\b)",
        r"(?i)(?-u:\b)(?:not found|does not exist|unknown|invalid)(?-u:\b)[^\n]{0,160}(?-u:\b)(?:thread|previous[_ -]?message[_ -]?id)(?-u:\b)",
        r"(?i)(?-u:\b)files?(?-u:\b)[^\n]{0,160}(?-u:\b)(?:not found|does not exist)(?-u:\b)",
        r"(?i)(?-u:\b)(?:not found|does not exist)(?-u:\b)[^\n]{0,160}(?-u:\b)files?(?-u:\b)",
        r"(?i)(?-u:\b)(?:input[_ -]?file|file[_ -]?id|item|response|vector[_ -]?store|upload)(?-u:\b)[^\n]{0,160}(?-u:\b)(?:not found|does not exist)(?-u:\b)",
        r"(?i)(?-u:\b)(?:not found|does not exist)(?-u:\b)[^\n]{0,160}(?-u:\b)(?:input[_ -]?file|file[_ -]?id|item|response|vector[_ -]?store|upload)(?-u:\b)",
        r"(?i)(?-u:\b)file-[a-z0-9_-]+(?-u:\b)[^\n]{0,160}(?-u:\b)(?:not found|does not exist)(?-u:\b)",
    ]
    .iter()
    .map(|pattern| Regex::new(pattern).expect("static pattern"))
    .collect()
});

/// Legacy `isResourceNotFoundResponse` over the raw error body (the legacy
/// helper stringifies an object body, which is the raw JSON here).
pub(crate) fn is_resource_not_found_response(body: &str) -> bool {
    RESOURCE_NOT_FOUND_PATTERNS
        .iter()
        .any(|pattern| pattern.is_match(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from tests/unit/error-classifier.test.ts.
    #[test]
    fn request_resource_404_shapes_are_recognized() {
        let files = serde_json::json!({
            "error": {
                "message": "[404]: Files [file-be30851bd1614656872e725e] were not found",
                "type": "invalid_request_error",
                "code": "model_not_found"
            }
        })
        .to_string();
        assert!(is_resource_not_found_response(&files));
        for body in [
            serde_json::json!({"error":{"message":"input_file file_id does not exist"}})
                .to_string(),
            serde_json::json!({"error":{"message":"Response resp_123 was not found"}}).to_string(),
            serde_json::json!({"error":{"message":"vector_store vs_123 not found"}}).to_string(),
            "Upload upload_123 does not exist".to_owned(),
            r#"{"error":{"code":"thread_not_found"}}"#.to_owned(),
            "previous_message_id msg_1 is invalid".to_owned(),
        ] {
            assert!(is_resource_not_found_response(&body), "{body}");
        }
        for body in [
            r#"{"error":{"message":"Not Found"}}"#,
            r#"{"error":{"message":"The model gpt-9 does not exist"}}"#,
            "",
            // The bounded gap does not cross a line.
            "file\nnot found",
            // A word boundary is required around the resource word.
            "profile not found",
        ] {
            assert!(!is_resource_not_found_response(body), "{body}");
        }
    }
}
