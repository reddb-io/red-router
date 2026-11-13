//! Versioned model grants. Existing native arrays retain their original wildcard
//! semantics; imported policies carry the legacy matcher in the same JSON value.
//! Source: src/lib/db/apiKeys/modelPermissions.ts at 525a71de4ac2.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::LazyLock};

#[derive(Clone, Copy, Debug, Default)]
pub(crate) enum ModelMatching {
    #[default]
    Native,
    Legacy {
        prefer_claude_code: bool,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LegacyGrants {
    schema: LegacySchema,
    patterns: Vec<String>,
    prefer_claude_code: bool,
}

#[derive(Deserialize, Serialize)]
enum LegacySchema {
    #[serde(rename = "redrouter-model-permissions-v1")]
    V1,
}

#[derive(Deserialize, Serialize)]
#[serde(untagged)]
enum Grants {
    Native(Vec<String>),
    Legacy(LegacyGrants),
}

pub(crate) fn decode(raw: &str) -> Result<(Vec<String>, ModelMatching), &'static str> {
    let grants: Grants = serde_json::from_str(raw).map_err(|_| "invalid model grants")?;
    let (patterns, matching) = match grants {
        Grants::Native(patterns) => (patterns, ModelMatching::Native),
        Grants::Legacy(grants) => (
            grants.patterns,
            ModelMatching::Legacy {
                prefer_claude_code: grants.prefer_claude_code,
            },
        ),
    };
    matching.validate(&patterns)?;
    Ok((patterns, matching))
}

pub(crate) fn encode(
    patterns: Vec<String>,
    matching: ModelMatching,
) -> Result<String, &'static str> {
    matching.validate(&patterns)?;
    let grants = match matching {
        ModelMatching::Native => Grants::Native(patterns),
        ModelMatching::Legacy { prefer_claude_code } => Grants::Legacy(LegacyGrants {
            schema: LegacySchema::V1,
            patterns,
            prefer_claude_code,
        }),
    };
    serde_json::to_string(&grants).map_err(|_| "invalid model grants")
}

impl ModelMatching {
    pub(crate) fn legacy(self) -> bool {
        matches!(self, Self::Legacy { .. })
    }

    pub(crate) fn name(self) -> &'static str {
        if self.legacy() {
            "legacy-v1"
        } else {
            "native"
        }
    }

    pub(crate) fn validate(self, patterns: &[String]) -> Result<(), &'static str> {
        if patterns.len() > 128
            || patterns.iter().any(|pattern| {
                pattern.is_empty()
                    || pattern.len() > 256
                    || pattern.chars().any(char::is_control)
                    || (!self.legacy()
                        && pattern != "*"
                        && pattern.contains('*')
                        && !(pattern.ends_with("/*")
                            && !pattern[..pattern.len() - 1].contains('*')))
            })
        {
            return Err("invalid client key model pattern");
        }
        Ok(())
    }

    pub(crate) fn matches(self, patterns: &[String], model: &str) -> bool {
        match self {
            Self::Native => patterns
                .iter()
                .any(|pattern| native_matches(pattern, model)),
            Self::Legacy { prefer_claude_code } => {
                let candidates = legacy_candidates(model, prefer_claude_code);
                patterns.iter().any(|pattern| {
                    candidates
                        .iter()
                        .any(|model| legacy_matches(pattern, model))
                })
            }
        }
    }
}

pub(crate) fn native_matches(pattern: &str, model: &str) -> bool {
    pattern == "*"
        || pattern == model
        || pattern
            .strip_suffix('*')
            .is_some_and(|prefix| pattern.ends_with("/*") && model.starts_with(prefix))
}

#[derive(Deserialize)]
struct AliasSnapshot {
    aliases: HashMap<String, [String; 2]>,
}

static ALIASES: LazyLock<HashMap<String, [String; 2]>> = LazyLock::new(|| {
    serde_json::from_str::<AliasSnapshot>(include_str!("legacy_model_aliases.json"))
        .expect("built-in legacy permission alias snapshot")
        .aliases
});

/// Resolve a provider spelling from the pinned legacy registry to its
/// canonical provider ID. Callers must still verify the transport is supported.
pub(crate) fn legacy_provider_id(provider: &str) -> Option<&str> {
    ALIASES.get(provider).map(|aliases| aliases[0].as_str())
}

fn add_candidate(candidates: &mut Vec<String>, model: &str) {
    let model = model.trim();
    if model.is_empty() {
        return;
    }
    for value in [model, model.strip_suffix("[1m]").unwrap_or(model)] {
        if !candidates.iter().any(|existing| existing == value) {
            candidates.push(value.to_owned());
        }
    }
}

fn legacy_candidates(model: &str, prefer_claude_code: bool) -> Vec<String> {
    let mut candidates = Vec::with_capacity(6);
    add_candidate(&mut candidates, model);
    let clean = model.trim().strip_suffix("[1m]").unwrap_or(model.trim());
    if let Some((provider, scoped)) = clean.split_once('/') {
        if !scoped.is_empty() {
            if matches!(provider, "cc" | "claude") {
                add_candidate(&mut candidates, scoped);
                add_candidate(&mut candidates, &format!("cc/{scoped}"));
                add_candidate(&mut candidates, &format!("claude/{scoped}"));
            }
            if let Some(aliases) = ALIASES.get(provider) {
                for alias in aliases {
                    add_candidate(&mut candidates, &format!("{alias}/{scoped}"));
                }
            }
        }
    } else if prefer_claude_code {
        let lower = clean.to_ascii_lowercase();
        if lower.starts_with("claude-")
            || matches!(lower.as_str(), "sonnet" | "opus" | "haiku" | "fable")
        {
            add_candidate(&mut candidates, &format!("cc/{clean}"));
            add_candidate(&mut candidates, &format!("claude/{clean}"));
        }
    }
    candidates
}

fn legacy_matches(pattern: &str, model: &str) -> bool {
    if pattern == model {
        return true;
    }
    if let Some(prefix) = pattern.strip_suffix("/*") {
        return model
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with('/'));
    }
    let mut models = model.split('/');
    for pattern in pattern.split('/') {
        if !models
            .next()
            .is_some_and(|model| segment_matches(pattern, model))
        {
            return false;
        }
    }
    models.next().is_none()
}

// Literal anchors only, no regex compilation or exponential backtracking.
fn segment_matches(pattern: &str, model: &str) -> bool {
    if pattern == model {
        return true;
    }
    if !pattern.contains('*') {
        return false;
    }
    let parts = pattern.split('*').collect::<Vec<_>>();
    let first = parts[0];
    let last = parts[parts.len() - 1];
    if !model.starts_with(first) || !model.ends_with(last) {
        return false;
    }
    let mut cursor = first.len();
    let end = model.len() - last.len();
    for part in &parts[1..parts.len() - 1] {
        if part.is_empty() {
            continue;
        }
        let Some(offset) = model[cursor..].find(part) else {
            return false;
        };
        cursor += offset + part.len();
        if cursor > end {
            return false;
        }
    }
    cursor <= end
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_globs_keep_segment_boundaries_and_literal_prefix_special_case() {
        for (pattern, model, expected) in [
            ("*", "openai/gpt-4", false),
            ("*", "gpt-4", true),
            ("openai/gpt-*", "openai/gpt-4", true),
            ("openai/gpt-*", "openai/gpt-4/extra", false),
            ("openrouter/*", "openrouter/org/model", true),
            ("open*/*", "openai/gpt", false),
            ("o*/g*t-4*", "openai/gpt-4o", true),
            ("a*a", "a", false),
            ("é*é", "é", false),
            ("x[1m]", "x[1m]", true),
            ("a?", "ab", false),
        ] {
            assert_eq!(
                legacy_matches(pattern, model),
                expected,
                "{pattern}: {model}"
            );
        }
        assert!(native_matches("*", "openai/gpt-4"));
    }

    #[test]
    fn legacy_aliases_context_suffix_and_claude_setting_are_preserved() {
        let matching = ModelMatching::Legacy {
            prefer_claude_code: false,
        };
        for (pattern, model) in [
            ("cx/gpt-*", "codex/gpt-5"),
            ("codex/*", "cx/gpt-5"),
            ("vertex/*", "vx/gemini-2.5"),
            ("claude/*", "cc/opus[1m]"),
            ("opus", "cc/opus"),
        ] {
            assert!(
                matching.matches(&[pattern.into()], model),
                "{pattern}: {model}"
            );
        }
        assert!(!matching.matches(&["cc/*".into()], "opus"));
        assert!(ModelMatching::Legacy {
            prefer_claude_code: true
        }
        .matches(&["cc/*".into()], "opus"));
        assert!(!matching.matches(&["openai/*".into()], "openrouter/openai/gpt-4"));
    }

    #[test]
    fn versioned_grants_preserve_native_rules_and_reject_unknown_versions() {
        let (_, native) = decode(r#"["*"]"#).unwrap();
        assert!(!native.legacy());
        let encoded = encode(
            vec!["gpt-*".into()],
            ModelMatching::Legacy {
                prefer_claude_code: true,
            },
        )
        .unwrap();
        let (patterns, legacy) = decode(&encoded).unwrap();
        assert!(legacy.matches(&patterns, "gpt-4"));
        assert!(decode(&encoded.replace("permissions-v1", "permissions-v2")).is_err());
        assert!(decode(r#"["gpt-*"]"#).is_err());
    }
}
