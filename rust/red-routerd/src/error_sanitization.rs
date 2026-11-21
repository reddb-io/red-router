//! Client-visible error sanitization, ported from the legacy
//! `open-sse/utils/errorSanitization.ts`.
//!
//! Error text that reaches a client loses credentials (catalog shapes,
//! labeled assignments, URL user info and signed query parameters, PEM
//! blocks, base64 data URLs), absolute paths and stack tails, including when
//! they hide behind up to three layers of JSON/ASCII escapes. Like the
//! legacy scanner it works on UTF-16 code units, so lengths and offsets keep
//! their JavaScript meaning.

use crate::credential_patterns::redact_known_credential_patterns;
use crate::error_path_redaction::{
    redact_error_paths, strip_error_stack_tail, strip_recognized_error_stack_tail,
};
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::LazyLock;

const MAX_ERROR_LEN: usize = 4096;
const MAX_ERROR_SCAN_HEADROOM: usize = 512;
const MAX_SECURITY_ESCAPE_LAYERS: usize = 3;
const REDACTED: &str = "[REDACTED]";

/// JavaScript `\s` and `\S` as regex classes. ASCII-only case folding
/// (`(?-u)`) mirrors JavaScript `/i` without the `u` flag.
const JS_S: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
const JS_NS: &str = r"[^\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";

/// Legacy `STRONG_CREDENTIAL_TOKEN`; the two lookbehind alternatives are the
/// named groups `sk` and `prefixed`, checked against the preceding unit.
static STRONG_CREDENTIAL_TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i-u)(?:eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[a-z]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|(?P<sk>sk[-_][A-Za-z0-9._~+/=-]{8,})|(?P<prefixed>[A-Za-z0-9]{3,}sk[-_][A-Za-z0-9._~+/=-]{8,}))",
    )
    .expect("static pattern")
});
static BEARER_BASIC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)(?-u:\b(Bearer|Basic)){JS_S}+(?-u:[A-Za-z0-9._~+/=-]+)"
    ))
    .expect("static pattern")
});
static CLI_CREDENTIAL_FLAG: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?i)(?:^|{JS_S})--(?:api[-_]?key|token|password|secret){JS_S}+(?:"[^"]*"|'[^']*'|{JS_NS}+)"#
    ))
    .expect("static pattern")
});
static CREDENTIAL_ASSIGNMENT_HINT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?i)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|secret)["']?{JS_S}*[:=]{JS_S}*["']?[^"'\\,\t\n\x0B\x0C\r \x{{A0}}\x{{1680}}\x{{2000}}-\x{{200A}}\x{{2028}}\x{{2029}}\x{{202F}}\x{{205F}}\x{{3000}}\x{{FEFF}}}}]{{6,}}"#
    ))
    .expect("static pattern")
});
static HTTP_URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)https?://").expect("static pattern"));
static URL_QUERY_PARAM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([?&])([^=&#]+)=([^&#]*)").expect("static pattern"));
static PEM_LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?$").expect("static pattern")
});

/// Legacy `CREDENTIAL_LABELS`: the label and whether its value fails closed
/// to the end of the text.
const CREDENTIAL_LABELS: &[(&str, bool)] = &[
    ("__secure-next-auth.session-token", true),
    ("arena-auth-prod-v1", true),
    ("__cf_bm", true),
    ("_cfuvid", true),
    ("_puid", true),
    ("access_token_v2", true),
    ("token_v2", true),
    ("tokenv2", true),
    ("cf_clearance", true),
    ("credentials", true),
    ("credential", true),
    ("session id", true),
    ("session-id", true),
    ("session_id", true),
    ("sessionid", true),
    ("encryption key", true),
    ("encryption-key", true),
    ("encryption_key", true),
    ("encryptionkey", true),
    ("private key", true),
    ("private-key", true),
    ("private_key", true),
    ("privatekey", true),
    ("session key", true),
    ("session-key", true),
    ("session_key", true),
    ("sessionkey", true),
    ("secret key", true),
    ("secret-key", true),
    ("secret_key", true),
    ("secretkey", true),
    ("signing key", true),
    ("signing-key", true),
    ("signing_key", true),
    ("signingkey", true),
    ("refresh token", false),
    ("refresh-token", false),
    ("refresh_token", false),
    ("refreshtoken", false),
    ("access token", false),
    ("access-token", false),
    ("access_token", false),
    ("accesstoken", false),
    ("authorization", true),
    ("sso-rw", true),
    ("session", true),
    ("sso", true),
    ("api key", false),
    ("api-key", false),
    ("api_key", false),
    ("apikey", false),
    ("password", true),
    ("cookie", true),
    ("secret", true),
    ("token", false),
];

type U = [u16];

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn text(value: &U) -> String {
    String::from_utf16_lossy(value)
}

fn at(value: &U, index: usize) -> Option<u16> {
    value.get(index).copied()
}

fn js_whitespace(code: Option<u16>) -> bool {
    matches!(
        code,
        Some(
            0x09..=0x0d
            | 0x20
            | 0xa0
            | 0x1680
            | 0x2000..=0x200a
            | 0x2028
            | 0x2029
            | 0x202f
            | 0x205f
            | 0x3000
            | 0xfeff,
        )
    )
}

fn alnum(code: Option<u16>) -> bool {
    code.is_some_and(|code| {
        (0x30..=0x39).contains(&code)
            || (0x41..=0x5a).contains(&code)
            || (0x61..=0x7a).contains(&code)
    })
}

/// JavaScript `slice(0, n)` in code units.
fn truncate_units(value: &str, max: usize) -> String {
    let value = units(value);
    if value.len() <= max {
        return text(&value);
    }
    text(&value[..max])
}

fn hex(code: Option<u16>) -> Option<u32> {
    match code? {
        code @ 0x30..=0x39 => Some(u32::from(code - 0x30)),
        code @ 0x41..=0x46 => Some(u32::from(code - 0x41 + 10)),
        code @ 0x61..=0x66 => Some(u32::from(code - 0x61 + 10)),
        _ => None,
    }
}

/// Legacy `unicodeEscapeCodeAt`: the code of `\uXXXX` at `start`.
fn unicode_escape_code_at(value: &U, start: usize) -> Option<u32> {
    if at(value, start) != Some(0x5c)
        || !matches!(at(value, start + 1), Some(0x75 | 0x55))
        || start + 5 >= value.len()
    {
        return None;
    }
    let mut decoded = 0;
    for digit in start + 2..=start + 5 {
        decoded = decoded * 16 + hex(at(value, digit))?;
    }
    Some(decoded)
}

fn printable_ascii(code: Option<u32>) -> bool {
    code.is_some_and(|code| (0x20..=0x7e).contains(&code))
}

fn security_whitespace(code: Option<u32>) -> bool {
    matches!(code, Some(0x08 | 0x09 | 0x0a | 0x0c | 0x0d))
}

fn escape_token_boundary(code: Option<u16>) -> bool {
    !alnum(code) && !matches!(code, Some(0x2e | 0x5f | 0x2d))
}

/// Legacy `shouldPreserveUnicodeUncEvidence`.
fn preserve_unicode_unc_evidence(
    value: &U,
    run_start: usize,
    run_end: usize,
    decoded: u32,
) -> bool {
    if run_end - run_start < 2
        || matches!(decoded, 0x2f | 0x5c | 0x3a)
        || (run_start > 0 && !escape_token_boundary(at(value, run_start - 1)))
    {
        return false;
    }
    let after = run_end + 5;
    let mut token_end = after;
    while token_end < value.len() && !js_whitespace(at(value, token_end)) {
        token_end += 1;
    }
    if value
        .get(after..token_end)
        .is_some_and(|token| token.contains(&0x3d))
    {
        return false;
    }
    after < token_end
}

/// Legacy `decodeSecurityEscapesOnce`.
fn decode_security_escapes_once(value: &U, decode_quotes: bool, max_length: usize) -> Vec<u16> {
    let mut output: Vec<u16> = Vec::with_capacity(value.len());
    let mut changed = false;
    let mut index = 0;
    while index < value.len() {
        if value[index] != 0x5c {
            output.push(value[index]);
            index += 1;
            continue;
        }
        let run_start = index;
        while index < value.len() && value[index] == 0x5c {
            index += 1;
        }
        let run_end = index;
        if run_end >= value.len() {
            output.extend_from_slice(&value[run_start..]);
            break;
        }
        let escaped = value[run_end];
        if matches!(escaped, 0x75 | 0x55) {
            let decoded = unicode_escape_code_at(value, run_end - 1);
            let quote = matches!(decoded, Some(0x22 | 0x27));
            if security_whitespace(decoded) {
                output.push(0x20);
                index = run_end + 5;
                changed = true;
                continue;
            }
            if printable_ascii(decoded)
                && (decode_quotes || !quote)
                && !preserve_unicode_unc_evidence(value, run_start, run_end, decoded.unwrap_or(0))
            {
                output.push(decoded.unwrap_or(0) as u16);
                index = run_end + 5;
                changed = true;
                continue;
            }
            output.extend_from_slice(&value[run_start..(run_end + 5).min(value.len())]);
            index = run_end + 5;
            continue;
        }
        if matches!(escaped, 0x62 | 0x66 | 0x6e | 0x72 | 0x74) {
            output.push(0x20);
            index = run_end + 1;
            changed = true;
            continue;
        }
        if escaped == 0x2f || (decode_quotes && matches!(escaped, 0x22 | 0x27)) {
            output.push(escaped);
            index = run_end + 1;
            changed = true;
            continue;
        }
        output.extend_from_slice(&value[run_start..run_end]);
        index = run_end;
    }
    if changed {
        output.truncate(max_length);
        output
    } else {
        value.to_vec()
    }
}

/// Legacy `hasResidualSecurityEscape`.
fn has_residual_security_escape(value: &U) -> bool {
    let mut index = 0;
    while index < value.len() {
        if value[index] != 0x5c {
            index += 1;
            continue;
        }
        while index < value.len() && value[index] == 0x5c {
            index += 1;
        }
        if index >= value.len() {
            return false;
        }
        let escaped = value[index];
        if matches!(
            escaped,
            0x62 | 0x66 | 0x6e | 0x72 | 0x74 | 0x2f | 0x22 | 0x27
        ) {
            return true;
        }
        if matches!(escaped, 0x75 | 0x55) {
            let decoded = unicode_escape_code_at(value, index - 1);
            if printable_ascii(decoded) || security_whitespace(decoded) {
                return true;
            }
        }
        index += 1;
    }
    false
}

/// Legacy `normalizeSecurityEscapes`: up to three escape layers decoded,
/// never materializing arbitrary Unicode.
fn normalize_security_escapes(value: &str, decode_quotes: bool, max_length: usize) -> String {
    let mut normalized = units(value);
    normalized.truncate(max_length);
    for _ in 0..MAX_SECURITY_ESCAPE_LAYERS {
        let decoded = decode_security_escapes_once(&normalized, decode_quotes, max_length);
        if decoded == normalized {
            break;
        }
        normalized = decoded;
        normalized.truncate(max_length);
    }
    text(&normalized)
}

fn credential_label_boundary(code: Option<u16>) -> bool {
    !alnum(code) && !matches!(code, Some(0x5f | 0x2d))
}

fn lower_slice_equals(value: &U, start: usize, label: &str) -> bool {
    let end = start + label.encode_utf16().count();
    end <= value.len() && text(&value[start..end]).to_lowercase() == label
}

/// Legacy `matchCredentialAssignmentAt`: where the assigned value starts and
/// whether it fails closed.
fn match_credential_assignment_at(value: &U, start: usize) -> Option<(usize, bool)> {
    let key_quote = at(value, start).filter(|code| matches!(code, 0x22 | 0x27));
    let label_start = start + usize::from(key_quote.is_some());
    let cli_flag = key_quote.is_none()
        && label_start >= 2
        && value[label_start - 2..label_start] == [0x2d, 0x2d]
        && (label_start == 2 || credential_label_boundary(at(value, label_start - 3)));
    'labels: for &(label, fail_closed) in CREDENTIAL_LABELS {
        if !lower_slice_equals(value, label_start, label) {
            continue;
        }
        let mut index = label_start + label.len();
        if (label == "arena-auth-prod-v1" || label == "__secure-next-auth.session-token")
            && at(value, index) == Some(0x2e)
        {
            index += 1;
            let chunk_start = index;
            while index < value.len()
                && at(value, index).is_some_and(|code| (0x30..=0x39).contains(&code))
            {
                index += 1;
            }
            if index == chunk_start {
                continue 'labels;
            }
        }
        if let Some(quote) = key_quote {
            if at(value, index) != Some(quote) {
                continue;
            }
            index += 1;
        } else if !credential_label_boundary(at(value, index)) {
            continue;
        } else if matches!(at(value, index), Some(0x22 | 0x27)) {
            index += 1;
        }
        let separator_start = index;
        while js_whitespace(at(value, index)) {
            index += 1;
        }
        if matches!(at(value, index), Some(0x3a | 0x3d)) {
            index += 1;
            while js_whitespace(at(value, index)) {
                index += 1;
            }
        } else if !(cli_flag && index > separator_start) {
            continue;
        }
        return Some((index, fail_closed));
    }
    None
}

fn find_quoted_credential_end(value: &U, start: usize, quote: u16) -> Option<usize> {
    let mut index = start + 1;
    while index < value.len() {
        if value[index] == 0x5c {
            index += 2;
            continue;
        }
        if value[index] == quote {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn find_unquoted_credential_end(value: &U, start: usize) -> usize {
    let mut end = start;
    while end < value.len() {
        let code = Some(value[end]);
        if js_whitespace(code) || matches!(code, Some(0x22 | 0x27 | 0x2c | 0x7d)) {
            break;
        }
        end += 1;
    }
    end
}

/// Legacy `redactLabeledCredentialAssignments`.
fn redact_labeled_credential_assignments(value: &str) -> String {
    let value = units(value);
    let marker = units(REDACTED);
    let mut out: Vec<u16> = Vec::new();
    let mut changed = false;
    let mut copy_start = 0;
    let mut index = 0;
    while index < value.len() {
        let Some((value_start, fail_closed)) = match_credential_assignment_at(&value, index) else {
            index += 1;
            continue;
        };
        changed = true;
        if let Some(quote) = at(&value, value_start).filter(|code| matches!(code, 0x22 | 0x27)) {
            out.extend_from_slice(&value[copy_start..value_start + 1]);
            out.extend_from_slice(&marker);
            match find_quoted_credential_end(&value, value_start, quote) {
                None => {
                    copy_start = value.len();
                    index = value.len();
                }
                Some(closing) => {
                    out.push(quote);
                    copy_start = closing + 1;
                    index = copy_start;
                }
            }
            continue;
        }
        let value_end = if fail_closed || at(&value, value_start) == Some(0x5c) {
            value.len()
        } else {
            find_unquoted_credential_end(&value, value_start)
        };
        out.extend_from_slice(&value[copy_start.min(value_start)..value_start]);
        out.extend_from_slice(&marker);
        copy_start = value_end;
        index = value_end.max(value_start + 1);
    }
    if !changed {
        return text(&value);
    }
    out.extend_from_slice(&value[copy_start.min(value.len())..]);
    text(&out)
}

/// Legacy `redactPrivateKeyPemBlocks`.
fn redact_private_key_pem_blocks(value: &str) -> String {
    let value = units(value);
    // ASCII-only fold keeps offsets aligned.
    let upper: Vec<u16> = value
        .iter()
        .map(|code| {
            if (0x61..=0x7a).contains(code) {
                code - 0x20
            } else {
                *code
            }
        })
        .collect();
    let find = |needle: &str, from: usize| {
        let needle = units(needle);
        (from..=upper.len().saturating_sub(needle.len()))
            .find(|start| upper.get(*start..start + needle.len()) == Some(needle.as_slice()))
    };
    let mut out: Vec<u16> = Vec::new();
    let mut changed = false;
    let mut copy_start = 0;
    let mut search_start = 0;
    while search_start < value.len() {
        let Some(block_start) = find("-----BEGIN ", search_start) else {
            break;
        };
        let label_start = block_start + 11;
        let Some(header_end) = find("-----", label_start) else {
            break;
        };
        let label = text(&upper[label_start..header_end]);
        let label = label.trim_matches(|c: char| js_whitespace(u16::try_from(u32::from(c)).ok()));
        if !PEM_LABEL.is_match(label) {
            search_start = header_end + 5;
            continue;
        }
        let end_marker = format!("-----END {label}-----");
        let block_end = find(&end_marker, header_end + 5).map_or(value.len(), |closing| {
            closing + end_marker.encode_utf16().count()
        });
        out.extend_from_slice(&value[copy_start..block_start]);
        out.extend(units(REDACTED));
        changed = true;
        copy_start = block_end;
        search_start = block_end;
    }
    if !changed {
        return text(&value);
    }
    out.extend_from_slice(&value[copy_start.min(value.len())..]);
    text(&out)
}

fn ascii_case_insensitive_at(value: &U, start: usize, expected: &str) -> bool {
    let expected = units(expected);
    start + expected.len() <= value.len()
        && expected.iter().enumerate().all(|(offset, want)| {
            let code = value[start + offset];
            let folded = if (0x41..=0x5a).contains(&code) {
                code + 0x20
            } else {
                code
            };
            folded == *want
        })
}

/// Legacy `redactBase64DataUrls`.
fn redact_base64_data_urls(value: &str) -> String {
    let value = units(value);
    let mut out: Vec<u16> = Vec::new();
    let mut changed = false;
    let mut copy_start = 0;
    let mut index = 0;
    while index < value.len() {
        if !ascii_case_insensitive_at(&value, index, "data:") {
            index += 1;
            continue;
        }
        let data_url_start = index;
        let media_type_start = index + 5;
        let mut delimiter = media_type_start;
        while delimiter < value.len()
            && value[delimiter] != 0x2c
            && !js_whitespace(Some(value[delimiter]))
        {
            delimiter += 1;
        }
        let marker_start = delimiter.checked_sub(7);
        let base64 = delimiter < value.len()
            && value[delimiter] == 0x2c
            && marker_start.is_some_and(|start| {
                start >= media_type_start && ascii_case_insensitive_at(&value, start, ";base64")
            });
        if !base64 {
            index = if delimiter < value.len() {
                delimiter + 1
            } else {
                value.len()
            };
            continue;
        }
        let mut payload_end = delimiter + 1;
        while payload_end < value.len()
            && (alnum(Some(value[payload_end]))
                || matches!(value[payload_end], 0x2b | 0x2f | 0x3d | 0x5f | 0x2d))
        {
            payload_end += 1;
        }
        if payload_end == delimiter + 1 {
            index = delimiter + 1;
            continue;
        }
        out.extend_from_slice(&value[copy_start..data_url_start]);
        out.extend(units("[REDACTED_DATA_URL]"));
        changed = true;
        copy_start = payload_end;
        index = payload_end;
    }
    if !changed {
        return text(&value);
    }
    out.extend_from_slice(&value[copy_start.min(value.len())..]);
    text(&out)
}

fn url_terminator(code: u16) -> bool {
    js_whitespace(Some(code))
        || matches!(
            code,
            0x22 | 0x27 | 0x60 | 0x3c | 0x3e | 0x29 | 0x5d | 0x7d | 0x2c | 0x3b
        )
}

/// JavaScript `decodeURIComponent`, none on a malformed escape.
fn decode_uri_component(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let pair = bytes.get(index + 1..index + 3)?;
            let decoded = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
            out.push(decoded);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Legacy `isSensitiveUrlQueryKey` over `normalizeUrlQueryKey`.
fn sensitive_url_query_key(key: &str) -> bool {
    let plus = key.replace('+', " ");
    let decoded = decode_uri_component(&plus).unwrap_or(plus);
    let normalized: String = decoded
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "sig"
            | "signature"
            | "key"
            | "apikey"
            | "token"
            | "accesstoken"
            | "refreshtoken"
            | "credential"
            | "password"
            | "secret"
            | "awsaccesskeyid"
            | "googleaccessid"
            | "xamzcredential"
            | "xamzsignature"
            | "xamzsecuritytoken"
            | "xgoogcredential"
            | "xgoogsignature"
    )
}

/// Legacy `redactUrlSegment`: user info and signed query values.
fn redact_url_segment(segment: &str) -> String {
    let scheme_end = segment.find("//").map_or(1, |index| index + 2);
    let authority_end = ["/", "?", "#"]
        .iter()
        .filter_map(|delimiter| {
            segment[scheme_end.min(segment.len())..]
                .find(delimiter)
                .map(|i| i + scheme_end)
        })
        .min()
        .unwrap_or(segment.len());
    let mut redacted = segment.to_owned();
    if let Some(user_info_end) = segment[..authority_end.min(segment.len())]
        .rfind('@')
        .filter(|end| *end >= scheme_end)
    {
        redacted = format!(
            "{}[REDACTED]@{}",
            &segment[..scheme_end],
            &segment[user_info_end + 1..]
        );
    }
    URL_QUERY_PARAM
        .replace_all(&redacted, |captures: &regex::Captures| {
            if sensitive_url_query_key(&captures[2]) {
                format!("{}redacted=[REDACTED]", &captures[1])
            } else {
                captures[0].to_owned()
            }
        })
        .into_owned()
}

/// Legacy `redactSensitiveUrlCredentials`.
fn redact_sensitive_url_credentials(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut changed = false;
    let mut copy_start = 0;
    let mut search = 0;
    while let Some(found) = HTTP_URL.find_at(value, search) {
        let start = found.start();
        let end = value[found.end()..]
            .char_indices()
            .find(|(_, ch)| u16::try_from(u32::from(*ch)).is_ok_and(url_terminator))
            .map_or(value.len(), |(offset, _)| found.end() + offset);
        let segment = &value[start..end];
        let redacted = redact_url_segment(segment);
        if redacted != segment {
            out.push_str(&value[copy_start..start]);
            out.push_str(&redacted);
            copy_start = end;
            changed = true;
        }
        search = end.max(found.end());
        if search >= value.len() {
            break;
        }
    }
    if !changed {
        return value.to_owned();
    }
    out.push_str(&value[copy_start..]);
    out
}

/// Legacy `STRONG_CREDENTIAL_TOKEN_GLOBAL` replacement, honouring the two
/// `(?<![A-Za-z0-9])` lookbehinds.
fn replace_strong_credential_tokens(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut copy_start = 0;
    let mut search = 0;
    while search <= value.len() {
        let Some(captures) = STRONG_CREDENTIAL_TOKEN.captures_at(value, search) else {
            break;
        };
        let whole = captures.get(0).expect("match");
        let guarded = captures.name("sk").is_some() || captures.name("prefixed").is_some();
        let preceded = value[..whole.start()]
            .chars()
            .next_back()
            .is_some_and(|ch| ch.is_ascii_alphanumeric());
        if guarded && preceded {
            // The lookbehind fails here; JavaScript retries one position on.
            search = whole.start()
                + value[whole.start()..]
                    .chars()
                    .next()
                    .map_or(1, char::len_utf8);
            continue;
        }
        out.push_str(&value[copy_start..whole.start()]);
        out.push_str(REDACTED);
        copy_start = whole.end();
        search = if whole.end() > whole.start() {
            whole.end()
        } else {
            whole.end() + 1
        };
    }
    out.push_str(&value[copy_start.min(value.len())..]);
    out
}

/// Legacy `containsStrongCredentialToken`.
pub fn contains_strong_credential_token(value: &str) -> bool {
    replace_strong_credential_tokens(value) != value
}

/// Legacy `redactSensitiveErrorText`.
pub fn redact_sensitive_error_text(value: &str) -> String {
    let normalized =
        normalize_security_escapes(value, false, MAX_ERROR_LEN + MAX_ERROR_SCAN_HEADROOM);
    let catalog = redact_known_credential_patterns(&redact_sensitive_url_credentials(&normalized));
    let common = redact_base64_data_urls(&redact_private_key_pem_blocks(&catalog));
    let common = BEARER_BASIC
        .replace_all(&common, "$1 [REDACTED]")
        .into_owned();
    let common = replace_strong_credential_tokens(&common);
    redact_labeled_credential_assignments(&common)
}

/// Legacy `containsSensitiveErrorCredential`.
pub fn contains_sensitive_error_credential(value: &str) -> bool {
    let normalized =
        normalize_security_escapes(value, false, MAX_ERROR_LEN + MAX_ERROR_SCAN_HEADROOM);
    let direct = redact_known_credential_patterns(&redact_sensitive_url_credentials(&normalized));
    let direct = BEARER_BASIC
        .replace_all(&direct, "$1 [REDACTED]")
        .into_owned();
    let direct = replace_strong_credential_tokens(&direct);
    direct != normalized
        || CLI_CREDENTIAL_FLAG.is_match(&normalized)
        || CREDENTIAL_ASSIGNMENT_HINT.is_match(&normalized)
}

/// Legacy `truncateSanitizedErrorText`: a redaction marker cut by the limit
/// is kept whole.
fn truncate_sanitized_error_text(value: &str) -> String {
    let value = units(value);
    if value.len() <= MAX_ERROR_LEN {
        return text(&value);
    }
    let open = units("[REDACTED");
    let marker_start = (0..=MAX_ERROR_LEN.min(value.len().saturating_sub(open.len())))
        .rev()
        .find(|start| value.get(*start..start + open.len()) == Some(open.as_slice()));
    if let Some(marker_start) = marker_start {
        if let Some(marker_end) = (marker_start..value.len()).find(|index| value[*index] == 0x5d) {
            if marker_start < MAX_ERROR_LEN
                && marker_end >= MAX_ERROR_LEN
                && marker_end - marker_start <= 128
            {
                let marker = &value[marker_start..=marker_end];
                let mut out = value[..MAX_ERROR_LEN - marker.len()].to_vec();
                out.extend_from_slice(marker);
                return text(&out);
            }
        }
    }
    text(&value[..MAX_ERROR_LEN])
}

fn sanitize_with_stack_policy(message: &str, strip: fn(&str) -> String) -> String {
    let message = truncate_units(message, MAX_ERROR_LEN + MAX_ERROR_SCAN_HEADROOM);
    let mut value = redact_labeled_credential_assignments(&redact_known_credential_patterns(
        &redact_sensitive_url_credentials(&strip(&message)),
    ));
    value = redact_error_paths(&value);
    value = redact_sensitive_error_text(&value);
    value = truncate_sanitized_error_text(&value);
    value = normalize_security_escapes(&value, false, MAX_ERROR_LEN);
    value = redact_sensitive_error_text(&redact_error_paths(&strip(&value)));
    value = normalize_security_escapes(&value, true, MAX_ERROR_LEN);
    value = redact_sensitive_error_text(&redact_error_paths(&strip(&value)));
    if has_residual_security_escape(&units(&value)) {
        return REDACTED.to_owned();
    }
    value
        .trim_end_matches(|c: char| js_whitespace(u16::try_from(u32::from(c)).ok()))
        .to_owned()
}

/// Legacy `sanitizeErrorMessage`: credentials, paths and stack tails removed
/// from a client-visible message, which keeps its first line only.
pub fn sanitize_error_message(message: &str) -> String {
    sanitize_with_stack_policy(message, strip_error_stack_tail)
}

/// Legacy `sanitizePassthroughErrorMessage`: multiline provider wording stays.
fn sanitize_passthrough_error_message(message: &str) -> String {
    sanitize_with_stack_policy(message, strip_recognized_error_stack_tail)
}

const MAX_DEPTH: usize = 4;
const MAX_UPSTREAM_KEY_LEN: usize = 256;
const SAFE_STATUS_IDENTIFIERS: [&str; 17] = [
    "ABORTED",
    "ALREADY_EXISTS",
    "CANCELLED",
    "DATA_LOSS",
    "DEADLINE_EXCEEDED",
    "FAILED_PRECONDITION",
    "INTERNAL",
    "INVALID_ARGUMENT",
    "NOT_FOUND",
    "OK",
    "OUT_OF_RANGE",
    "PERMISSION_DENIED",
    "RESOURCE_EXHAUSTED",
    "UNAUTHENTICATED",
    "UNAVAILABLE",
    "UNIMPLEMENTED",
    "UNKNOWN",
];
const SAFE_ERROR_IDENTIFIERS: [&str; 24] = [
    "api_error",
    "auth_error",
    "authentication_error",
    "bad_gateway",
    "bad_request",
    "billing_error",
    "context_length_exceeded",
    "error",
    "gateway_timeout",
    "insufficient_quota",
    "invalid_api_key",
    "invalid_request",
    "invalid_request_error",
    "model_not_found",
    "not_found",
    "payment_required",
    "permission_error",
    "provider_error",
    "quota_exhausted",
    "rate_limit_error",
    "rate_limit_exceeded",
    "server_error",
    "upstream_error",
    "upstream_timeout",
];
static BLOCKED_KEYS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)stack|trace|path|file|cwd|dir|password|secret|token|key|authorization|cookie|credential|session")
        .expect("static pattern")
});
static BLOCKED_CREDENTIAL_ALIAS_KEYS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(?:cf_clearance|__cf_bm|_cfuvid|_puid|sso|sso-rw|arena-auth-prod-v1(?:\.\d+)?)$",
    )
    .expect("static pattern")
});

static BLOCKED_KEYS_BUT_SESSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)stack|trace|path|file|cwd|dir|password|secret|token|key|authorization|cookie|credential")
        .expect("static pattern")
});

/// Legacy `BLOCKED_KEYS`, whose `session(?!_?(?:count|status)$)` lookahead
/// lets `session_count` and `session_status` through.
fn blocked_key(key: &str) -> bool {
    if BLOCKED_KEYS_BUT_SESSION.is_match(key) {
        return true;
    }
    if !BLOCKED_KEYS.is_match(key) {
        return false;
    }
    // Any "session" occurrence without an allowed suffix blocks the key.
    let lower = key.to_ascii_lowercase();
    lower.match_indices("session").any(|(index, _)| {
        !matches!(
            &lower[index + 7..],
            "count" | "_count" | "status" | "_status"
        )
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Classification {
    Code,
    Reason,
    Status,
    Type,
}

fn classification_key(key: &str) -> Option<Classification> {
    let normalized: String = key
        .chars()
        .filter(|c| *c != '-' && *c != '_')
        .collect::<String>()
        .to_lowercase();
    match normalized.as_str() {
        "code" | "errorcode" => Some(Classification::Code),
        "reason" | "errorreason" => Some(Classification::Reason),
        "status" | "statuscode" | "errorstatus" | "errorstatuscode" => Some(Classification::Status),
        "type" | "errortype" | "subtype" => Some(Classification::Type),
        _ => None,
    }
}

/// Legacy `projectUpstreamErrorIdentifier`.
fn project_identifier(key: Classification, value: &Value) -> Option<Value> {
    match value {
        Value::Number(number) => {
            let integer = number.as_i64().or_else(|| {
                number
                    .as_f64()
                    .filter(|f| f.fract() == 0.0)
                    .map(|f| f as i64)
            })?;
            if key == Classification::Code && (0..=16).contains(&integer) {
                return Some(value.clone());
            }
            ((key == Classification::Code || key == Classification::Status)
                && (100..=599).contains(&integer))
            .then(|| value.clone())
        }
        Value::String(text) => {
            if key == Classification::Status
                && SAFE_STATUS_IDENTIFIERS.contains(&text.to_uppercase().as_str())
            {
                return Some(value.clone());
            }
            // /^[1-5]\d{2}$/ and /^HTTP_[1-5]\d{2}$/i
            let status_digits = |digits: &[u8]| {
                digits.len() == 3
                    && (b'1'..=b'5').contains(&digits[0])
                    && digits[1..].iter().all(u8::is_ascii_digit)
            };
            let bytes = text.as_bytes();
            let http_status = status_digits(bytes);
            let http_named = bytes.len() == 8
                && bytes[..5].eq_ignore_ascii_case(b"HTTP_")
                && status_digits(&bytes[5..]);
            if http_status
                || http_named
                || SAFE_ERROR_IDENTIFIERS.contains(&text.to_lowercase().as_str())
            {
                return Some(value.clone());
            }
            match key {
                Classification::Type => Some(Value::String("upstream_error".to_owned())),
                Classification::Code => Some(Value::String(String::new())),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Legacy `isSafeUpstreamDetailKey`.
fn safe_detail_key(key: &str) -> bool {
    let length = key.encode_utf16().count();
    if length == 0
        || length > MAX_UPSTREAM_KEY_LEN
        || blocked_key(key)
        || BLOCKED_CREDENTIAL_ALIAS_KEYS.is_match(key)
        || matches!(
            key.to_lowercase().as_str(),
            "__proto__" | "constructor" | "prototype"
        )
    {
        return false;
    }
    sanitize_error_message(key) == key
}

fn sanitize_details(value: &Value, depth: usize, multiline: bool, classify: bool) -> Value {
    if depth > MAX_DEPTH {
        return Value::String("[truncated]".to_owned());
    }
    match value {
        Value::Null => Value::Null,
        Value::String(text) => Value::String(if multiline {
            sanitize_passthrough_error_message(text)
        } else {
            sanitize_error_message(text)
        }),
        Value::Number(_) | Value::Bool(_) => value.clone(),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(32)
                .map(|item| sanitize_details(item, depth + 1, multiline, classify))
                .collect(),
        ),
        Value::Object(record) => {
            let mut out = Map::new();
            for (key, entry) in record {
                if !safe_detail_key(key) {
                    continue;
                }
                let normalized = key.to_lowercase();
                if classify {
                    if let Some(kind) = classification_key(&normalized) {
                        if let Some(projected) = project_identifier(kind, entry) {
                            out.insert(key.clone(), projected);
                        }
                        continue;
                    }
                }
                let child = matches!(
                    normalized.as_str(),
                    "error" | "errors" | "warning" | "warnings"
                );
                out.insert(
                    key.clone(),
                    sanitize_details(entry, depth + 1, multiline, child),
                );
            }
            Value::Object(out)
        }
    }
}

/// Legacy `sanitizeUpstreamDetails`: an upstream JSON error body with unsafe
/// keys dropped, error identifiers projected and every string sanitized.
pub fn sanitize_upstream_details(value: &Value) -> Value {
    sanitize_details(value, 0, false, true)
}

/// Legacy `sanitizePassthroughUpstreamDetails`: as above, keeping safe
/// multiline provider wording.
pub fn sanitize_passthrough_upstream_details(value: &Value) -> Value {
    sanitize_details(value, 0, true, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Outputs the legacy TypeScript produced for the same inputs
    /// (`error_sanitization_oracle.json`, generated with Node).
    #[test]
    fn outputs_match_the_legacy_implementation() {
        let oracle: Value =
            serde_json::from_str(include_str!("error_sanitization_oracle.json")).unwrap();
        for pair in oracle["messages"].as_array().unwrap() {
            let input = pair[0].as_str().unwrap();
            assert_eq!(
                sanitize_error_message(input),
                pair[1].as_str().unwrap(),
                "{input:?}"
            );
        }
        for pair in oracle["sensitive"].as_array().unwrap() {
            let input = pair[0].as_str().unwrap();
            assert_eq!(
                contains_sensitive_error_credential(input),
                pair[1].as_bool().unwrap(),
                "{input:?}"
            );
        }
        for pair in oracle["details"].as_array().unwrap() {
            assert_eq!(sanitize_upstream_details(&pair[0]), pair[1], "{}", pair[0]);
        }
        for pair in oracle["passthrough"].as_array().unwrap() {
            assert_eq!(
                sanitize_passthrough_upstream_details(&pair[0]),
                pair[1],
                "{}",
                pair[0]
            );
        }
    }

    // Ported from tests/unit/strong-credential-token-linear-scan.test.ts.
    #[test]
    fn strong_credential_tokens_scan_linearly_and_catch_glued_keys() {
        let started = std::time::Instant::now();
        assert!(!contains_strong_credential_token(&"a".repeat(200_000)));
        assert!(started.elapsed().as_millis() < 500);
        assert!(contains_strong_credential_token("projsk-AbCdEfGhIjKl"));
        assert!(contains_strong_credential_token("(abcsk_AbCdEfGh12)"));
        assert_eq!(
            redact_sensitive_error_text("rejected xyzsk-AbCdEfGhIjKlMn for this project"),
            "rejected [REDACTED] for this project"
        );
        assert!(!contains_strong_credential_token("ab-xsk-AbCdEfGhIjKl"));
    }

    // Ported from tests/unit/error-sensitive-redaction.test.ts.
    #[test]
    fn messages_lose_bearer_json_url_escaped_and_cli_credentials() {
        assert_eq!(
            sanitize_error_message("upstream echoed Authorization: Bearer eyJ.secret.token and data:image/png;charset=utf-8;base64,iVBORw0KGgoAAAANSUhEUgAAAAE="),
            "upstream echoed Authorization: [REDACTED]"
        );
        let json = sanitize_error_message(
            r#"{"api_key":"sk-sensitive","access_token":"oauth-sensitive","cookie":"session=sensitive; secondary=also-sensitive","authorization":"Basic dXNlcjpwYXNz"}"#,
        );
        for secret in [
            "sk-sensitive",
            "oauth-sensitive",
            "session=sensitive",
            "also-sensitive",
            "dXNlcjpwYXNz",
        ] {
            assert!(!json.contains(secret), "{json}");
        }
        assert!(json.contains(REDACTED));

        let safe_url = "https://example.com/docs/error?lang=en#recovery";
        let projected = sanitize_error_message(&format!(
            "proxy failed https://svc-user:p4ss-opaque-9382@internal.example/v1 then https://storage.example/blob?X-Amz-Credential=AKIAOPAQUE%2Fscope&X-Amz-Signature=signature-secret&X-Amz-Expires=60 and https://account.blob.core.windows.net/c?sv=2025-01-05&sig=sas-secret&se=soon then https://vertex.example/predict?key=vertex-key-secret&mode=express plus https://gateway.example/v1?api_key=query-api-secret&token=query-token-secret see {safe_url}"
        ));
        for secret in [
            "svc-user",
            "p4ss-opaque",
            "AKIAOPAQUE",
            "signature-secret",
            "sas-secret",
            "vertex-key-secret",
            "query-api-secret",
            "query-token-secret",
        ] {
            assert!(!projected.contains(secret), "{projected}");
        }
        for kept in ["X-Amz-Expires=60", "sv=2025-01-05", "se=soon", safe_url] {
            assert!(projected.contains(kept), "{projected}");
        }

        for input in [
            r"api_key\t=opaque-tab-secret-9382746",
            r"api_key\u0009=opaque-unicode-tab-9382746",
            r"Bearer\topaque-bearer-secret-9382746",
            r"api_key\\t=opaque-double-tab-secret-9382746",
            "spawn failed: helper --api-key opaque-cli-key-9382746 --mode check",
            "spawn failed: helper --token \"opaque cli token 9382746\" --mode check",
            "spawn failed: helper --password 'opaque-cli-password-9382746' --mode check",
        ] {
            let projected = sanitize_error_message(input);
            assert!(!projected.contains("opaque"), "{input:?} -> {projected:?}");
            assert!(projected.contains(REDACTED), "{input:?} -> {projected:?}");
        }
    }

    #[test]
    fn the_credential_catalog_and_the_length_boundary_are_covered() {
        let a = |count: usize| "A".repeat(count);
        let credentials = [
            format!("AIza{}", a(35)),
            format!("hf_{}", a(34)),
            format!("r8_{}", a(37)),
            format!("gho_{}", a(36)),
            format!("ghu_{}", a(36)),
            format!("ghs_{}", a(36)),
            format!("ghr_{}", a(36)),
            format!("lin_api_{}", a(40)),
            format!("secret_{}", a(43)),
            format!("npm_{}", a(36)),
            format!("PMAK-1234abcd-{}", "a".repeat(32)),
            format!("rk_live_{}", a(24)),
            format!("sq0atp-{}", a(22)),
            format!("SK{}", "a".repeat(32)),
            format!("SG.{}.{}", a(22), "B".repeat(43)),
            format!("key-{}", "a".repeat(32)),
            format!("M{}.{}.{}", a(23), "B".repeat(6), "C".repeat(27)),
            "postgresql://db-user:db-password@db.internal.example/app".to_owned(),
            format!("gsk_{}", a(52)),
            format!("xai-{}", a(80)),
        ];
        for credential in &credentials {
            let projected = sanitize_error_message(&format!("upstream echoed {credential}"));
            assert!(!projected.contains(credential.as_str()), "{projected}");
            assert!(projected.contains("[REDACTED"), "{projected}");
        }

        let credential = format!("hf_{}", a(34));
        for input in [
            format!("{}{credential}", "x".repeat(4088)),
            format!(r"\t{}{credential}", "x".repeat(4088)),
        ] {
            let output = sanitize_error_message(&input);
            assert!(!output.contains("hf_"));
            assert!(output.ends_with(']') && output.contains("[REDACTED"));
            assert!(output.encode_utf16().count() <= MAX_ERROR_LEN);
        }
    }

    #[test]
    fn private_key_armor_and_credential_headers_are_dropped() {
        assert_eq!(
            sanitize_error_message("provider returned -----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: test\n\npgp-private-material\n-----END PGP PRIVATE KEY BLOCK----- after"),
            "provider returned [REDACTED]"
        );
        assert_eq!(
            sanitize_error_message("provider returned -----BEGIN PGP PRIVATE KEY BLOCK-----\npgp-unterminated-material"),
            "provider returned [REDACTED]"
        );
        let safe = sanitize_upstream_details(&serde_json::json!({
            "authorization": "Bearer sensitive",
            "cookie": "session=sensitive; refresh=also-sensitive",
            "set-cookie": "session=sensitive",
            "error": "failed for data:image/webp;base64,UklGRgAAAAA=",
        }));
        assert_eq!(
            safe,
            serde_json::json!({"error": "failed for [REDACTED_DATA_URL]"})
        );
    }
}
