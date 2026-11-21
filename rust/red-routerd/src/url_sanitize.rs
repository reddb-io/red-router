//! Base URL normalization, ported from the legacy
//! `open-sse/utils/urlSanitize.ts`.

/// Legacy `stripTrailingSlashes`: every trailing `/` removed, in linear time.
pub fn strip_trailing_slashes(value: &str) -> &str {
    value.trim_end_matches('/')
}

/// Legacy `normalizeBaseUrl`: whitespace trimmed (as JavaScript `trim`, which
/// also drops a byte-order mark) and trailing slashes stripped; a missing
/// value is empty.
pub fn normalize_base_url(value: Option<&str>) -> &str {
    let value = value.unwrap_or("");
    strip_trailing_slashes(value.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}'))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ported from tests/unit/url-sanitize.test.ts and
    // tests/unit/refactor-urlSanitize.test.ts.
    #[test]
    fn trailing_slashes_and_whitespace_are_removed() {
        for (input, expected) in [
            ("https://example.com", "https://example.com"),
            ("https://example.com/", "https://example.com"),
            ("https://example.com///", "https://example.com"),
            ("", ""),
            ("///", ""),
            ("/", ""),
            ("hello", "hello"),
            ("https://example.com/api/v1/", "https://example.com/api/v1"),
        ] {
            assert_eq!(strip_trailing_slashes(input), expected, "{input}");
        }
        let long = format!("https://example.com{}", "/".repeat(100_000));
        assert_eq!(strip_trailing_slashes(&long), "https://example.com");

        assert_eq!(normalize_base_url(None), "");
        assert_eq!(normalize_base_url(Some("")), "");
        assert_eq!(
            normalize_base_url(Some("  https://api.example.com/v1/  ")),
            "https://api.example.com/v1"
        );
        assert_eq!(
            normalize_base_url(Some("https://api.example.com/v1")),
            "https://api.example.com/v1"
        );
        assert_eq!(
            normalize_base_url(Some("https://api.example.com/")),
            "https://api.example.com"
        );
    }
}
