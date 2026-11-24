//! Request caps stated in 429 bodies, ported from the legacy
//! `open-sse/services/rateLimitManager/requestCap.ts`.
//!
//! Some upstreams state their ceiling in the error text ("Maximum 5
//! requests within 1 minutes", "Rate limit: 20 RPM"). A cap word must come
//! shortly before the figure, and not be followed by a usage verb, so a bare
//! usage statement ("you made 120 requests in 1 minute") is not read as a
//! ceiling.

use regex::Regex;
use std::sync::LazyLock;

const MAX_TEXT_LENGTH: usize = 4_000;
const MAX_WINDOW_MS: u64 = 24 * 3_600_000;

/// Legacy `RequestCap`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RequestCap {
    pub(crate) requests: u32,
    pub(crate) window_ms: u64,
}

/// Legacy `CAP_WORD_PREFIX` without its lookahead, which the `regex` crate
/// lacks: each cap word is checked for a following usage verb separately.
static CAP_WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?-u:\b)(?:max(?:imum)?|limit(?:ed)?|allowed|up to|at most|exceed(?:ed|s)?|quota|rate)(?-u:\b)",
    )
    .expect("static pattern")
});
static USAGE_AFTER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[^.\n]{0,40}(?-u:\b)(?:made|sent|used)(?-u:\b)").expect("static pattern")
});
/// Legacy `REQUESTS_PER_WINDOW_RE` after the cap word.
static REQUESTS_PER_WINDOW: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^[^.\n]{0,40}?(\d{1,7})\s+requests?\s+(?:within|per|in|every)\s+(?:(\d{1,5})\s*)?(second|sec|minute|min|hour|hr)s?(?-u:\b)",
    )
    .expect("static pattern")
});
/// Legacy `RPM_RE` after the cap word.
static RPM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[^.\n]{0,40}?(\d{1,7})\s*rpm(?-u:\b)").expect("static pattern")
});

fn unit_ms(unit: &str) -> u64 {
    match unit.to_ascii_lowercase().as_str() {
        "second" | "sec" => 1_000,
        "minute" | "min" => 60_000,
        _ => 3_600_000,
    }
}

/// Legacy `isValidRequestCap`: a whole number of requests over 1s..24h.
pub(crate) fn is_valid_request_cap(cap: RequestCap) -> bool {
    cap.requests >= 1 && (1_000..=MAX_WINDOW_MS).contains(&cap.window_ms)
}

/// The leftmost match of `pattern` right after a cap word that no usage
/// verb follows, as the legacy regular expression finds it.
fn after_cap_word<'a>(text: &'a str, pattern: &Regex) -> Option<regex::Captures<'a>> {
    CAP_WORD.find_iter(text).find_map(|word| {
        let rest = &text[word.end()..];
        if USAGE_AFTER.is_match(rest) {
            return None;
        }
        pattern.captures(rest)
    })
}

/// Legacy `parseRequestCapFromBody` over the error body text.
pub(crate) fn parse_request_cap_from_body(body: &str) -> Option<RequestCap> {
    let end = body
        .char_indices()
        .nth(MAX_TEXT_LENGTH)
        .map_or(body.len(), |(index, _)| index);
    let text = &body[..end];
    if text.is_empty() {
        return None;
    }
    let cap = if let Some(captures) = after_cap_word(text, &REQUESTS_PER_WINDOW) {
        let requests = captures[1].parse::<u32>().ok()?;
        let count = captures
            .get(2)
            .map_or(Some(1), |count| count.as_str().parse::<u64>().ok())?;
        RequestCap {
            requests,
            window_ms: count.saturating_mul(unit_ms(&captures[3])),
        }
    } else {
        let captures = after_cap_word(text, &RPM)?;
        RequestCap {
            requests: captures[1].parse::<u32>().ok()?,
            window_ms: 60_000,
        }
    };
    is_valid_request_cap(cap).then_some(cap)
}

/// Legacy `requestCapSettings`: the gap that spreads the cap evenly.
pub(crate) fn request_cap_min_time_ms(cap: RequestCap) -> u64 {
    cap.window_ms / u64::from(cap.requests.max(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(requests: u32, window_ms: u64) -> Option<RequestCap> {
        Some(RequestCap {
            requests,
            window_ms,
        })
    }

    // Ported from tests/unit/rate-limit-learned-cap-13594.test.ts.
    #[test]
    fn hard_request_caps_are_read_from_429_bodies() {
        let tokenrouter = serde_json::json!({"error":{"message":"You have reached the request limit: Maximum 5 requests within 1 minutes","type":"rate_limit_error"}}).to_string();
        assert_eq!(parse_request_cap_from_body(&tokenrouter), cap(5, 60_000));
        for (body, expected) in [
            (
                "429: Maximum 100 requests within 30 seconds",
                cap(100, 30_000),
            ),
            (
                "Rate limit exceeded: 60 requests per minute",
                cap(60, 60_000),
            ),
            (
                "You hit the limit of 10 requests per 2 minutes",
                cap(10, 120_000),
            ),
            ("Rate limit: 20 RPM", cap(20, 60_000)),
            ("Rate limit: 20 rpm, current usage: 4 rpm", cap(20, 60_000)),
            ("quota: 1000 requests per hour", cap(1_000, 3_600_000)),
        ] {
            assert_eq!(parse_request_cap_from_body(body), expected, "{body}");
        }
    }

    #[test]
    fn bodies_without_a_request_cap_are_ignored() {
        for body in [
            "Rate limit exceeded. Please retry after 20s.",
            "",
            r#"{"error":{"message":"overloaded"}}"#,
            "Maximum 0 requests within 1 minutes",
            "processed 5 requests in 3 days",
            "You made 120 requests in 1 minute; the limit is 60",
            "Your 3 requests in 10 seconds exceeded the plan",
            "Rate limit exceeded: you sent 120 requests in 1 minute",
            "Generate: 7 requests per minute",
            "Current usage: 4 rpm",
            "Rate limit hit: you have made 3 rpm",
            "Throttled: 20 RPM exceeded",
        ] {
            assert_eq!(parse_request_cap_from_body(body), None, "{body}");
        }
        assert!(is_valid_request_cap(RequestCap {
            requests: 5,
            window_ms: 60_000
        }));
        assert!(!is_valid_request_cap(RequestCap {
            requests: 5,
            window_ms: 1_000_000_000_000
        }));
        assert_eq!(
            request_cap_min_time_ms(RequestCap {
                requests: 5,
                window_ms: 60_000
            }),
            12_000
        );
    }
}
