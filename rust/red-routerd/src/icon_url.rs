//! Compatible-provider node icon URL validation, ported from the legacy
//! `src/shared/validation/iconUrl.ts`.
//!
//! Accepted: an empty value (no custom icon), an http(s) URL up to 2000
//! UTF-16 units, or a `data:image/<subtype>[;attr=value]*;base64,<payload>`
//! URL up to 256 KiB with a strict RFC 4648 payload. Everything else
//! (unsafe schemes, non-image data, unencoded data, whitespace in the
//! payload) is rejected.

pub(crate) const MAX_ICON_URL_LENGTH: usize = 2000;
pub(crate) const MAX_ICON_DATA_URL_LENGTH: usize = 256 * 1024;
const BASE64_MARKER: &str = ";base64";
const DATA_SCHEME_LENGTH: usize = "data:".len();

fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn starts_with_ignore_case(text: &str, prefix: &str) -> bool {
    text.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

/// RFC 7230 `tchar`.
fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c)
}

fn is_token(text: &str) -> bool {
    !text.is_empty() && text.chars().all(is_token_char)
}

/// Legacy `isValidProviderIconUrl`.
pub(crate) fn is_valid_provider_icon_url(value: &str) -> bool {
    let trimmed = js_trim(value);
    if trimmed.is_empty() {
        return true;
    }
    if starts_with_ignore_case(trimmed, "data:") {
        return utf16_len(trimmed) <= MAX_ICON_DATA_URL_LENGTH && is_valid_data_icon_url(trimmed);
    }
    if utf16_len(trimmed) > MAX_ICON_URL_LENGTH
        || !(starts_with_ignore_case(trimmed, "http://")
            || starts_with_ignore_case(trimmed, "https://"))
    {
        return false;
    }
    reqwest::Url::parse(trimmed).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
}

fn is_valid_data_icon_url(value: &str) -> bool {
    if !reqwest::Url::parse(value).is_ok_and(|url| url.scheme() == "data") {
        return false;
    }
    let Some((metadata, payload)) = value.split_once(',') else {
        return false;
    };
    if payload.is_empty()
        || metadata.len() < DATA_SCHEME_LENGTH + BASE64_MARKER.len()
        || !metadata
            .get(metadata.len() - BASE64_MARKER.len()..)
            .is_some_and(|marker| marker.eq_ignore_ascii_case(BASE64_MARKER))
    {
        return false;
    }
    let media_type = &metadata[DATA_SCHEME_LENGTH..metadata.len() - BASE64_MARKER.len()];
    is_valid_image_media_type(media_type) && is_base64(payload)
}

/// `image/<subtype>` followed by `;attr=value` parameters (RFC 2045/6838).
fn is_valid_image_media_type(input: &str) -> bool {
    let Some((kind, rest)) = input.split_once('/') else {
        return false;
    };
    if kind.is_empty() || rest.is_empty() || !kind.eq_ignore_ascii_case("image") {
        return false;
    }
    let (subtype, mut parameters) = match rest.find(';') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    if !is_token(subtype) {
        return false;
    }
    while !parameters.is_empty() {
        let Some(after) = parameters.strip_prefix(';') else {
            return false;
        };
        let attribute_end = after.find(['=', ';']).unwrap_or(after.len());
        let attribute = &after[..attribute_end];
        if !is_token(attribute) {
            return false;
        }
        // Valueless parameters are rejected (RFC 2397 `attribute "=" value`).
        let Some(value) = after[attribute_end..].strip_prefix('=') else {
            return false;
        };
        let Some(consumed) = parameter_value_length(value) else {
            return false;
        };
        parameters = &value[consumed..];
        if !parameters.is_empty() && !parameters.starts_with(';') {
            return false;
        }
    }
    true
}

/// Byte length of a token or quoted-string value at the start of `input`.
fn parameter_value_length(input: &str) -> Option<usize> {
    if let Some(quoted) = input.strip_prefix('"') {
        let mut chars = quoted.char_indices();
        while let Some((index, c)) = chars.next() {
            match c {
                '"' => return Some(index + 2),
                // quoted-pair: the escaped character is taken as-is.
                '\\' => {
                    chars.next()?;
                }
                '\t' | ' ' | '!' | '\u{23}'..='\u{5b}' | '\u{5d}'..='\u{7e}' => {}
                c if u32::from(c) >= 0x80 => {}
                _ => return None,
            }
        }
        return None;
    }
    let end = input.find(';').unwrap_or(input.len());
    let value = &input[..end];
    // Percent escapes must be complete; they then count as token characters.
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let escape = value.get(index + 1..index + 3)?;
            if !escape.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return None;
            }
            index += 3;
        } else {
            index += 1;
        }
    }
    is_token(value).then_some(end)
}

/// Strict RFC 4648 base64 (zod `z.base64()`): full quads, then an optional
/// `xx==` or `xxx=` group, no whitespace.
fn is_base64(payload: &str) -> bool {
    let bytes = payload.as_bytes();
    if bytes.len() % 4 != 0 {
        return false;
    }
    let alphabet = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/';
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    padding <= 2
        && bytes[..bytes.len() - padding]
            .iter()
            .all(|byte| alphabet(*byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_urls_and_empty_values_are_accepted() {
        assert!(is_valid_provider_icon_url(""));
        assert!(is_valid_provider_icon_url("   "));
        assert!(is_valid_provider_icon_url(
            " https://example.test/icon.png "
        ));
        assert!(is_valid_provider_icon_url("HTTP://example.test/i.svg"));
        assert!(!is_valid_provider_icon_url("javascript:alert(1)"));
        assert!(!is_valid_provider_icon_url("ftp://example.test/icon.png"));
        assert!(!is_valid_provider_icon_url("https://"));
        let long = format!("https://example.test/{}", "a".repeat(MAX_ICON_URL_LENGTH));
        assert!(!is_valid_provider_icon_url(&long));
    }

    #[test]
    fn data_urls_need_an_image_type_and_strict_base64() {
        assert!(is_valid_provider_icon_url(
            "data:image/png;base64,iVBORw0KGgo="
        ));
        assert!(is_valid_provider_icon_url(
            "DATA:Image/svg+xml;charset=utf-8;BASE64,PHN2Zz48L3N2Zz4="
        ));
        assert!(is_valid_provider_icon_url(
            "data:image/png;name=\"a b\";base64,AAAA"
        ));
        assert!(is_valid_provider_icon_url(
            "data:image/png;x=%41b;base64,AAAA"
        ));
        for rejected in [
            "data:text/html;base64,PGgxPjwvaDE+",
            "data:image/png,AAAA",
            "data:image/png;base64,",
            "data:image/png;base64,AA AA",
            "data:image/png;base64,AAA",
            "data:image/png;base64,A===",
            "data:image/;base64,AAAA",
            "data:image/png;foo;base64,AAAA",
            "data:image/png;x=%4;base64,AAAA",
            "data:image/png;x=\"open;base64,AAAA",
        ] {
            assert!(!is_valid_provider_icon_url(rejected), "{rejected}");
        }
        let big = format!(
            "data:image/png;base64,{}",
            "A".repeat(MAX_ICON_DATA_URL_LENGTH)
        );
        assert!(!is_valid_provider_icon_url(&big));
    }
}
