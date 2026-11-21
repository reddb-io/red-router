//! Streaming JSON hash, ported from the legacy `open-sse/utils/jsonHash.ts`.
//!
//! `json_sha256` is the SHA-256 of the serialized value, computed while the
//! serializer writes into the hasher, so a multi-megabyte body is never
//! materialized as a string just to hash it. Strings escape as JavaScript
//! `JSON.stringify` escapes them. Object keys follow `serde_json`'s sorted
//! map order rather than insertion order, so the digest is stable for one
//! server but not equal to the legacy digest of an object with unsorted keys.

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Write;

/// Feeds serialized bytes into a SHA-256 state.
struct HashWriter(Sha256);

impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Legacy `jsonSha256`: the lowercase hex SHA-256 of the serialized value.
pub fn json_sha256(value: &Value) -> String {
    let mut writer = HashWriter(Sha256::new());
    // Writing a JSON value into an infallible sink cannot fail.
    serde_json::to_writer(&mut writer, value).expect("in-memory hash sink");
    hex::encode(writer.0.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sha256_hex(text: &str) -> String {
        hex::encode(Sha256::digest(text.as_bytes()))
    }

    // Ported from tests/unit/json-hash.test.ts: the digest equals the hash
    // of the serialized text, with JavaScript's string escapes.
    #[test]
    fn the_streamed_digest_matches_the_serialized_text() {
        let large = "A".repeat(5_400_000);
        for value in [
            Value::Null,
            json!(0),
            json!(-1),
            json!(2.71),
            json!(true),
            json!(""),
            json!("plain"),
            json!("with \"quotes\" and \\backslash"),
            json!("line\nbreak\ttab\rcr\u{8}bs\u{c}form"),
            json!("\u{0}\u{1f} control chars"),
            json!("emoji 🚀 and 😀"),
            json!([]),
            json!([[1], [2], [3]]),
            json!([null, 1, "x"]),
            json!({}),
            json!({"a": 1, "b": "two", "c": [true, false]}),
            json!({"nested": {"deep": {"deeper": [{"ok": 1}, null]}}}),
            json!({"messages": [{"role": "user", "content": [{"type": "image", "data": large, "mimeType": "image/png"}]}]}),
        ] {
            assert_eq!(json_sha256(&value), sha256_hex(&value.to_string()));
        }
        // JavaScript JSON.stringify produces these exact texts.
        assert_eq!(json_sha256(&Value::Null), sha256_hex("null"));
        assert_eq!(json_sha256(&json!("plain")), sha256_hex("\"plain\""));
        assert_eq!(
            json_sha256(&json!("\u{0}\u{1f}\n\t")),
            sha256_hex("\"\\u0000\\u001f\\n\\t\"")
        );
        assert_eq!(json_sha256(&json!([1, 2, 3])), sha256_hex("[1,2,3]"));
    }
}
