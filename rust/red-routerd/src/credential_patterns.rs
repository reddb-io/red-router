//! Credential signatures, ported from the legacy
//! `open-sse/utils/credentialPatterns.ts` and the `redactCredentials` helper
//! of `src/lib/guardrails/credentialMasker.ts`.
//!
//! The patterns apply in order and each replaces what it matches, so the
//! specific `sk-` shapes stamp their label before the generic fallback runs.
//! JavaScript `\b` is an ASCII word boundary, written `(?-u:\b)` here.

use regex::Regex;
use std::sync::LazyLock;

/// Legacy `CredentialPattern`.
pub struct CredentialPattern {
    pub name: &'static str,
    regex: Option<Regex>,
    pub replacement: &'static str,
}

fn pattern(name: &'static str, regex: &str, replacement: &'static str) -> CredentialPattern {
    CredentialPattern {
        name,
        regex: Some(Regex::new(regex).expect("static credential pattern")),
        replacement,
    }
}

/// Legacy `CREDENTIAL_PATTERNS`. The last entry, `openai_compatible`, needs
/// a lookbehind the regex crate lacks, so it is a scanner (`regex` is none).
pub static CREDENTIAL_PATTERNS: LazyLock<Vec<CredentialPattern>> = LazyLock::new(|| {
    vec![
        pattern(
            "openai_proj",
            r"sk-proj-[A-Za-z0-9_-]{20,}",
            "[REDACTED:openai]",
        ),
        pattern(
            "openai",
            r"(?-u:\b)sk-[A-Za-z0-9]{48}(?-u:\b)",
            "[REDACTED:openai]",
        ),
        pattern(
            "anthropic",
            r"sk-ant-api[0-9]?-[A-Za-z0-9_-]{20,}",
            "[REDACTED:anthropic]",
        ),
        pattern(
            "anthropic_alt",
            r"sk-ant-[A-Za-z0-9_-]{20,}",
            "[REDACTED:anthropic]",
        ),
        pattern("groq", r"(?-u:\b)gsk_[A-Za-z0-9]{20,}", "[REDACTED:groq]"),
        pattern("xai", r"(?-u:\b)xai-[A-Za-z0-9]{20,}", "[REDACTED:xai]"),
        pattern("google", r"AIza[0-9A-Za-z_-]{20,}", "[REDACTED:google]"),
        pattern("huggingface", r"hf_[A-Za-z0-9]{34}", "[REDACTED:hf]"),
        pattern("replicate", r"r8_[A-Za-z0-9]{37}", "[REDACTED:replicate]"),
        pattern("github", r"gh[pousr]_[A-Za-z0-9]{36,}", "[REDACTED:github]"),
        pattern("slack", r"xox[bpoa]-[A-Za-z0-9-]{10,}", "[REDACTED:slack]"),
        pattern("linear", r"lin_api_[A-Za-z0-9]{40}", "[REDACTED:linear]"),
        pattern("notion", r"secret_[A-Za-z0-9]{43}", "[REDACTED:notion]"),
        pattern("npm", r"npm_[A-Za-z0-9]{36}", "[REDACTED:npm]"),
        pattern(
            "postman",
            r"PMAK-[a-f0-9]{8}-[a-f0-9]{32}",
            "[REDACTED:postman]",
        ),
        pattern(
            "discord",
            r"(?-u:\b)[MN][A-Za-z0-9]{23}\.[A-Za-z0-9]{6}\.[A-Za-z0-9]{27}(?-u:\b)",
            "[REDACTED:discord]",
        ),
        pattern(
            "stripe",
            r"(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{24,}",
            "[REDACTED:stripe]",
        ),
        pattern(
            "square",
            r"sq0(?:atp-[0-9A-Za-z_-]{22}|csp-[0-9A-Za-z_-]{43})",
            "[REDACTED:square]",
        ),
        pattern("aws_access_key", r"AKIA[0-9A-Z]{16}", "[REDACTED:aws]"),
        pattern(
            "twilio",
            r"(?-u:\b)SK[0-9a-fA-F]{32}(?-u:\b)",
            "[REDACTED:twilio]",
        ),
        pattern(
            "sendgrid",
            r"SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}",
            "[REDACTED:sendgrid]",
        ),
        pattern("mailgun", r"key-[a-f0-9]{32}", "[REDACTED:mailgun]"),
        pattern(
            "private_key",
            r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----(?s:.)*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----",
            "[REDACTED:private_key]",
        ),
        pattern(
            "jwt",
            r"(?-u:\b)eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?-u:\b)",
            "[REDACTED:jwt]",
        ),
        pattern(
            "connection_string",
            r#"(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp)://[^:/@\s"']+:[^:/@\s"']+@"#,
            "[REDACTED:connection_string]",
        ),
        pattern(
            "auth_header",
            r#"(?i)((?:["']?(?:Authorization|x-api-key|api-key|apikey)["']?\s*[:=]\s*["']?)(?:(?:Bearer|Basic|Token)\s+)?)[A-Za-z0-9._~+/=-]{10,}"#,
            "${1}[REDACTED:auth_header]",
        ),
        CredentialPattern {
            name: "openai_compatible",
            regex: None,
            replacement: "[REDACTED:openai_compatible]",
        },
    ]
});

fn key_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'+' | b'/' | b'=' | b'-')
}

/// Legacy `(?<![A-Za-z0-9])sk-[A-Za-z0-9._~+/=-]{20,}`: the leftmost valid
/// key at each step, as the JavaScript engine scans.
fn replace_openai_compatible(text: &str, replacement: &str) -> (String, usize) {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut count = 0;
    let mut start = 0;
    while let Some(found) = text[start..].find("sk-") {
        let at = start + found;
        let boundary = at == 0 || !bytes[at - 1].is_ascii_alphanumeric();
        let mut end = at + 3;
        while end < bytes.len() && key_char(bytes[end]) {
            end += 1;
        }
        if boundary && end - (at + 3) >= 20 {
            out.push_str(&text[copied..at]);
            out.push_str(replacement);
            copied = end;
            count += 1;
            start = end;
        } else {
            start = at + 1;
        }
    }
    out.push_str(&text[copied..]);
    (out, count)
}

/// Legacy `redactCredentials`: the redacted text and, per pattern that
/// matched, its name and match count.
pub fn redact_credentials(text: &str) -> (String, Vec<(&'static str, usize)>) {
    let mut result = text.to_owned();
    let mut detections = Vec::new();
    for pattern in CREDENTIAL_PATTERNS.iter() {
        let (next, count) = match &pattern.regex {
            Some(regex) => {
                let count = regex.find_iter(&result).count();
                if count == 0 {
                    continue;
                }
                (
                    regex.replace_all(&result, pattern.replacement).into_owned(),
                    count,
                )
            }
            None => replace_openai_compatible(&result, pattern.replacement),
        };
        if count > 0 {
            result = next;
            detections.push((pattern.name, count));
        }
    }
    (result, detections)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALNUM: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const HEX: &str = "0123456789abcdef";

    /// The legacy test's deterministic fake key generator.
    fn fill(n: usize, charset: &str, seed: usize) -> String {
        let chars: Vec<char> = charset.chars().collect();
        (0..n)
            .map(|i| chars[(i * 31 + seed * 17 + i * i) % chars.len()])
            .collect()
    }

    fn types(text: &str) -> Vec<&'static str> {
        redact_credentials(text)
            .1
            .into_iter()
            .map(|(name, _)| name)
            .collect()
    }

    // Ported from tests/unit/credential-masker-guardrail.test.ts.
    #[test]
    fn credential_shapes_are_redacted_with_their_label() {
        let token = format!(
            "eyJ{}.{}.{}",
            "a".repeat(12),
            "b".repeat(12),
            "c".repeat(12)
        );
        assert!(redact_credentials(&format!("token={token}"))
            .0
            .contains("[REDACTED:jwt]"));
        let header = redact_credentials(&format!(
            "{{\"Authorization\": \"Bearer {}\"}}",
            "a".repeat(24)
        ))
        .0;
        assert!(
            header.contains("\"Authorization\": \"Bearer [REDACTED:auth_header]\""),
            "{header}"
        );
        assert!(
            redact_credentials(&format!("Authorization=Basic {}", "ab+/=".repeat(4)))
                .0
                .contains("Authorization=Basic [REDACTED:auth_header]")
        );
        assert!(
            redact_credentials(&format!("x-api-key: Token {}", "ab+/=".repeat(4)))
                .0
                .contains("x-api-key: Token [REDACTED:auth_header]")
        );

        let shapes = [
            (format!("gsk_{}", fill(52, ALNUM, 7)), "groq"),
            (format!("xai-{}", fill(80, ALNUM, 3)), "xai"),
            (format!("sk-{}", fill(32, HEX, 7)), "openai_compatible"),
            (format!("sk-{}", fill(40, ALNUM, 9)), "openai_compatible"),
            (format!("sk-{}", fill(51, ALNUM, 11)), "openai_compatible"),
            (format!("sk-{}", fill(20, ALNUM, 13)), "openai_compatible"),
            (
                format!("sk-{}", fill(36, &format!("{ALNUM}_-"), 2)),
                "openai_compatible",
            ),
        ];
        for (key, kind) in &shapes {
            for input in [
                key.clone(),
                format!("upstream error: Invalid API Key {key} for model foo"),
                format!("{{\"error\":{{\"message\":\"Incorrect API key provided: {key}. Check docs.\"}}}}"),
            ] {
                let (text, detections) = redact_credentials(&input);
                assert!(!text.contains(key.as_str()), "key survived: {text}");
                assert!(text.contains(&format!("[REDACTED:{kind}]")), "{text}");
                assert_eq!(
                    detections.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
                    [*kind],
                    "{input}"
                );
            }
        }
    }

    #[test]
    fn prose_and_sub_bound_prefixes_are_left_alone() {
        for input in [
            "gsk_abc".to_owned(),
            "xai-1".to_owned(),
            "sk-short".to_owned(),
            "task sk failed".to_owned(),
            format!("gsk_{}", fill(19, ALNUM, 7)),
            format!("xai-{}", fill(19, ALNUM, 7)),
            format!("sk-{}", fill(19, ALNUM, 7)),
            "risk-based-access-control-policy-evaluation-failed".to_owned(),
            "Model gpt-5 is not available on this plan".to_owned(),
        ] {
            let (text, detections) = redact_credentials(&input);
            assert_eq!(text, input);
            assert!(detections.is_empty(), "{input}");
        }
    }

    #[test]
    fn specific_sk_labels_win_over_the_generic_fallback() {
        let mixed = format!("{ALNUM}_-");
        for (key, kind, label) in [
            (
                format!("sk-proj-{}", fill(60, &mixed, 4)),
                "openai_proj",
                "[REDACTED:openai]",
            ),
            (
                format!("sk-{}", fill(48, ALNUM, 21)),
                "openai",
                "[REDACTED:openai]",
            ),
            (
                format!("sk-ant-api03-{}", fill(60, &mixed, 6)),
                "anthropic_alt",
                "[REDACTED:anthropic]",
            ),
            (
                format!("sk-ant-api3-{}", fill(60, &mixed, 6)),
                "anthropic",
                "[REDACTED:anthropic]",
            ),
            (
                format!("sk-ant-{}", fill(40, &mixed, 8)),
                "anthropic_alt",
                "[REDACTED:anthropic]",
            ),
            (
                format!("sk_live_{}", fill(24, ALNUM, 10)),
                "stripe",
                "[REDACTED:stripe]",
            ),
        ] {
            let input = format!("upstream error: Invalid API Key {key} for model foo");
            let (text, _) = redact_credentials(&input);
            assert!(!text.contains(key.as_str()), "{text}");
            assert!(text.contains(label), "{text}");
            assert!(!text.contains("[REDACTED:openai_compatible]"), "{text}");
            assert_eq!(types(&input), [kind], "{key}");
        }
        let names: Vec<_> = CREDENTIAL_PATTERNS
            .iter()
            .map(|pattern| pattern.name)
            .collect();
        assert_eq!(names.last(), Some(&"openai_compatible"));
        let unique: std::collections::HashSet<_> = names.iter().collect();
        assert_eq!(unique.len(), names.len());
    }
}
