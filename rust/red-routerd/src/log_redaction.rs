//! Legacy `src/shared/utils/logRedaction.ts` `redactSecrets`: scrubs
//! credentials (bearer tokens, API key assignments, Telegram bot tokens and
//! OpenAI-style keys) out of a message before it leaves the daemon.
//!
//! The patterns follow the JavaScript ones: `\w` and `\d` are ASCII, `\s` is
//! the JavaScript whitespace set, `\b` is the ASCII word boundary and the
//! case-insensitive parts fold ASCII only. Pinned by
//! `log_redaction_oracle.json`, generated from the legacy function.

use regex::Regex;
use std::borrow::Cow;
use std::sync::LazyLock;

const CENSOR: &str = "[REDACTED]";
/// JavaScript `\s`: Unicode spaces and line terminators plus U+FEFF, without
/// the U+0085 that Rust's `\s` adds.
const WS: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
const TOKEN: &str = r"[A-Za-z0-9_.\-]";

static SECRET_HINT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u:bearer|telegram\.org/bot|api[_-]?key|authorization|sk-)")
        .expect("static pattern")
});

static PATTERNS: LazyLock<Vec<(Regex, String)>> = LazyLock::new(|| {
    [
        // Authorization: Bearer <token>  /  authorization=Bearer <token>
        (
            format!("((?i-u:authorization){WS}*[:=]{WS}*(?i-u:bearer){WS}+){TOKEN}{{6,}}"),
            format!("${{1}}{CENSOR}"),
        ),
        // A bare "Bearer <token>".
        (
            format!(r"(?-u:\b)(?i-u:bearer){WS}+{TOKEN}{{12,}}"),
            format!("Bearer {CENSOR}"),
        ),
        // x-api-key: <value>  /  api_key=<value>
        (
            format!("((?i-u:x-api-key|api[_-]?key){WS}*[:=]{WS}*){TOKEN}{{6,}}"),
            format!("${{1}}{CENSOR}"),
        ),
        // A Telegram bot token in a URL: api.telegram.org/bot<digits>:<token>
        (
            r"((?i-u:api\.telegram\.org/bot))[0-9]{6,}:[A-Za-z0-9_\-]{20,}".to_owned(),
            format!("${{1}}{CENSOR}"),
        ),
        // OpenAI-style keys: sk-... (also sk-proj-...)
        (
            r"(?-u:\b)sk-[A-Za-z0-9_\-]{16,}".to_owned(),
            format!("sk-{CENSOR}"),
        ),
    ]
    .into_iter()
    .map(|(pattern, replacement)| (Regex::new(&pattern).expect("static pattern"), replacement))
    .collect()
});

/// Legacy `redactSecrets`: the text with every credential replaced, or the
/// same text when nothing matches.
pub(crate) fn redact_secrets(text: &str) -> Cow<'_, str> {
    if text.is_empty() || !SECRET_HINT.is_match(text) {
        return Cow::Borrowed(text);
    }
    let mut out = text.to_owned();
    for (pattern, replacement) in PATTERNS.iter() {
        if let Cow::Owned(replaced) = pattern.replace_all(&out, replacement.as_str()) {
            out = replaced;
        }
    }
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redaction_matches_the_legacy_implementation() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("log_redaction_oracle.json")).unwrap();
        let cases = fixture["redact"].as_array().unwrap();
        assert!(cases.len() >= 30);
        for case in cases {
            let input = case[0].as_str().unwrap();
            assert_eq!(
                redact_secrets(input),
                case[1].as_str().unwrap(),
                "{input:?}"
            );
        }
    }
}
