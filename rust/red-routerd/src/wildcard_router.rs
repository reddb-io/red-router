//! Glob model aliases, ported from the legacy
//! `open-sse/services/wildcardRouter.ts`.
//!
//! A pattern uses `*` for any run of characters and `?` for one character,
//! and matches the whole model name without regard to case. When several
//! patterns match, the most specific one wins; equal scores keep the first.
//! Exact aliases are resolved before patterns (see
//! `model_aliases::AliasSnapshot::resolve_route`).

/// Whether an alias name is a glob pattern rather than a literal model name.
pub(crate) fn is_pattern(alias: &str) -> bool {
    alias.contains(['*', '?'])
}

/// Legacy `wildcardMatch`.
pub(crate) fn wildcard_match(model: &str, pattern: &str) -> bool {
    if model.is_empty() || pattern.is_empty() {
        return false;
    }
    if pattern == "*" || pattern == model {
        return true;
    }
    let model: Vec<char> = model.to_lowercase().chars().collect();
    let pattern: Vec<char> = pattern.to_lowercase().chars().collect();
    glob(&model, &pattern)
}

/// The legacy pattern compiles to a JavaScript regex, whose `.` does not
/// match line terminators.
fn js_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// Anchored glob match with single-star backtracking.
fn glob(text: &[char], pattern: &[char]) -> bool {
    let (mut t, mut p) = (0, 0);
    // Pattern position after the last `*`, and the text position it covers to.
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        match pattern.get(p) {
            Some('*') => {
                star = Some((p + 1, t));
                p += 1;
                continue;
            }
            Some('?') if !js_line_terminator(text[t]) => {
                p += 1;
                t += 1;
                continue;
            }
            Some(&c) if c != '?' && c == text[t] => {
                p += 1;
                t += 1;
                continue;
            }
            _ => {}
        }
        match star {
            Some((after, covered)) if !js_line_terminator(text[covered]) => {
                star = Some((after, covered + 1));
                p = after;
                t = covered + 1;
            }
            _ => return false,
        }
    }
    pattern[p..].iter().all(|&c| c == '*')
}

/// Legacy `getSpecificity`: literal segments count most, wildcards subtract,
/// and longer patterns score higher. Lengths are UTF-16 code units, as in
/// JavaScript.
pub(crate) fn get_specificity(pattern: &str) -> i64 {
    let units = |value: &str| value.encode_utf16().count() as i64;
    let literal: i64 = pattern
        .split(['/', '*', '?'])
        .map(|segment| units(segment) * 10)
        .sum();
    let stars = pattern.matches('*').count() as i64;
    let questions = pattern.matches('?').count() as i64;
    literal - stars * 50 - questions * 5 + units(pattern)
}

/// Legacy `resolveWildcardAlias`: the most specific `(pattern, target)` whose
/// pattern matches `model`, keeping the first of equally specific matches.
pub(crate) fn resolve_wildcard_alias<'a, T>(
    model: &str,
    aliases: impl IntoIterator<Item = (&'a str, T)>,
) -> Option<(&'a str, T)> {
    if model.is_empty() {
        return None;
    }
    let mut best: Option<(i64, &'a str, T)> = None;
    for (pattern, target) in aliases {
        if !wildcard_match(model, pattern) {
            continue;
        }
        let specificity = get_specificity(pattern);
        if best
            .as_ref()
            .is_none_or(|(score, _, _)| specificity > *score)
        {
            best = Some((specificity, pattern, target));
        }
    }
    best.map(|(_, pattern, target)| (pattern, target))
}

#[cfg(test)]
mod tests {
    use super::*;

    // tests/unit/wildcard-router.test.ts
    #[test]
    fn matches_exact_star_prefix_middle_and_single_characters() {
        assert!(wildcard_match("gpt-4o", "gpt-4o"));
        assert!(wildcard_match("anything", "*"));
        assert!(wildcard_match("claude-sonnet-4-20250514", "claude-*"));
        assert!(!wildcard_match("gpt-4o", "claude-*"));
        assert!(wildcard_match("claude-sonnet-4-20250514", "claude-*-4*"));
        assert!(wildcard_match("claude-haiku-4-20250514", "claude-*-4*"));
        assert!(wildcard_match("gpt-4o", "gpt-?o"));
        assert!(wildcard_match("gpt-4o", "gpt-??"));
        assert!(!wildcard_match("gpt-4o", "gpt-???"));
        assert!(wildcard_match("GPT-4o", "gpt-*"));
        assert!(!wildcard_match("", "*"));
        assert!(!wildcard_match("model", ""));
    }

    #[test]
    fn patterns_are_anchored_and_literal_outside_wildcards() {
        assert!(!wildcard_match("my-claude-x", "claude-*"));
        assert!(!wildcard_match("gpt-4o-mini", "gpt-4o"));
        assert!(wildcard_match("a.b", "a.b"));
        assert!(!wildcard_match("axb", "a.b"));
        assert!(wildcard_match("v1(beta)", "v1(*)"));
        // `.` in the compiled legacy regex never matches a line terminator.
        assert!(!wildcard_match("a\u{2028}b", "a*b"));
        assert!(!wildcard_match("a\u{2028}b", "a?b"));
    }

    #[test]
    fn more_specific_patterns_score_higher() {
        assert!(get_specificity("claude-sonnet-4") > get_specificity("claude-*"));
        assert!(get_specificity("claude-sonnet-*") > get_specificity("claude-*"));
        assert!(get_specificity("*") < get_specificity("claude-*"));
        assert!(get_specificity("claude-sonnet-4-20250514") > get_specificity("claude-sonnet-4-*"));
    }

    #[test]
    fn resolves_the_most_specific_match() {
        let aliases = [
            ("claude-*", "generic-claude"),
            ("claude-sonnet-*", "sonnet-claude"),
            ("claude-sonnet-4-*", "sonnet4-claude"),
        ];
        assert_eq!(
            resolve_wildcard_alias("claude-sonnet-4-20250514", aliases),
            Some(("claude-sonnet-4-*", "sonnet4-claude"))
        );
        assert_eq!(
            resolve_wildcard_alias("claude-sonnet-4", [("gpt-*", "openai")]),
            None
        );
        assert_eq!(resolve_wildcard_alias::<&str>("model", []), None);
        assert_eq!(resolve_wildcard_alias("", [("*", "any")]), None);
    }

    #[test]
    fn equally_specific_matches_keep_the_first() {
        assert_eq!(
            resolve_wildcard_alias("ab", [("a?", "first"), ("?b", "second")]),
            Some(("a?", "first"))
        );
    }

    #[test]
    fn only_wildcard_names_are_patterns() {
        assert!(is_pattern("claude-*"));
        assert!(is_pattern("gpt-?o"));
        assert!(!is_pattern("friendly"));
    }
}
