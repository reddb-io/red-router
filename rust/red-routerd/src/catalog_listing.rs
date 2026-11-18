//! Listing rules for `GET /v1/models`, ported from the legacy
//! `src/app/api/v1/models/catalogPagination.ts`, `catalogDedupe.ts` and
//! `displayNames.ts`.
//!
//! The legacy body writer (explicit `Content-Length`, chunked enqueue) needs no
//! port: axum serializes `Json` into one buffered body with a known length.

use std::sync::OnceLock;

/// Largest page a client can request with `limit`.
pub(crate) const CATALOG_PAGE_LIMIT_MAX: usize = 10_000;

/// A catalog row as these rules see it: an optional public id plus the
/// listing surface (`type`, `subtype`). Missing or non-string values read as
/// `None` / the empty string, like the legacy `typeof … === "string"` checks.
pub(crate) trait CatalogEntry {
    fn catalog_id(&self) -> Option<&str>;
    fn catalog_type(&self) -> &str;
    fn catalog_subtype(&self) -> &str;
}

impl CatalogEntry for serde_json::Value {
    fn catalog_id(&self) -> Option<&str> {
        self.get("id").and_then(serde_json::Value::as_str)
    }
    fn catalog_type(&self) -> &str {
        self.get("type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
    }
    fn catalog_subtype(&self) -> &str {
        self.get("subtype")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
    }
}

/// OpenAI-style `limit` / `after` paging. Both absent means the full list.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct CatalogPage {
    pub(crate) after: Option<String>,
    pub(crate) limit: Option<usize>,
}

impl CatalogPage {
    /// Whether the client asked for paging; only then does the body carry
    /// `has_more` / `last_id`.
    pub(crate) fn is_requested(&self) -> bool {
        self.after.is_some() || self.limit.is_some()
    }

    /// Key that keeps cached bodies of different pages apart.
    #[allow(dead_code)]
    pub(crate) fn cache_key(&self) -> String {
        format!(
            "after={};limit={}",
            self.after.as_deref().unwrap_or_default(),
            self.limit
                .map(|limit| limit.to_string())
                .unwrap_or_default()
        )
    }
}

#[derive(Debug, PartialEq)]
pub(crate) struct CatalogPageResult<T> {
    pub(crate) models: Vec<T>,
    pub(crate) has_more: bool,
    pub(crate) last_id: Option<String>,
}

/// Parse `limit` and `after` from a raw query string. Like
/// `URLSearchParams.get`, the first occurrence of a name wins. Missing,
/// blank, non-numeric or non-positive values mean "no paging" so existing
/// clients keep the full list.
pub(crate) fn parse_catalog_page(query: Option<&str>) -> CatalogPage {
    let mut after_raw = None;
    let mut limit_raw = None;
    for (name, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        match name.as_ref() {
            "after" if after_raw.is_none() => after_raw = Some(value.into_owned()),
            "limit" if limit_raw.is_none() => limit_raw = Some(value.into_owned()),
            _ => {}
        }
    }
    let after = after_raw
        .map(|value| js_trim(&value).to_owned())
        .filter(|value| !value.is_empty());
    let limit = limit_raw
        .filter(|value| !js_trim(value).is_empty())
        .and_then(|value| js_parse_positive_int(&value))
        .map(|limit| limit.min(CATALOG_PAGE_LIMIT_MAX));
    CatalogPage { after, limit }
}

/// Slice `models` after the `after` id (from the start when the id is not
/// listed) and up to `limit` rows.
pub(crate) fn apply_catalog_page<T: CatalogEntry>(
    models: Vec<T>,
    page: &CatalogPage,
) -> CatalogPageResult<T> {
    if !page.is_requested() {
        return CatalogPageResult {
            models,
            has_more: false,
            last_id: None,
        };
    }
    let start = page
        .after
        .as_deref()
        .and_then(|after| {
            models
                .iter()
                .position(|model| model.catalog_id() == Some(after))
        })
        .map_or(0, |index| index + 1);
    let total = models.len();
    let end = page
        .limit
        .map_or(total, |limit| start.saturating_add(limit));
    let models: Vec<T> = models
        .into_iter()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect();
    let last_id = models
        .last()
        .and_then(CatalogEntry::catalog_id)
        .map(str::to_owned);
    CatalogPageResult {
        models,
        has_more: end < total,
        last_id,
    }
}

/// Final exact-duplicate guard (#4424 / #8015). Keeps the first row per
/// `(id, type, subtype)` and drops untyped or `chat` rows whose id also has a
/// typed non-chat row. Rows without a non-empty id always pass. Order is
/// preserved and kept rows are never modified.
pub(crate) fn dedupe_exact_catalog_ids<T: CatalogEntry>(models: Vec<T>) -> Vec<T> {
    if models.len() < 2 {
        return models;
    }
    let specialty: std::collections::HashSet<String> = models
        .iter()
        .filter_map(|model| {
            let id = model.catalog_id().filter(|id| !id.is_empty())?;
            let kind = model.catalog_type();
            (!kind.is_empty() && kind != "chat").then(|| id.to_owned())
        })
        .collect();
    let mut seen = std::collections::HashSet::new();
    models
        .into_iter()
        .filter(|model| {
            let Some(id) = model.catalog_id().filter(|id| !id.is_empty()) else {
                return true;
            };
            let kind = model.catalog_type();
            if specialty.contains(id) && (kind.is_empty() || kind == "chat") {
                return false;
            }
            seen.insert((
                id.to_owned(),
                kind.to_owned(),
                model.catalog_subtype().to_owned(),
            ))
        })
        .collect()
}

/// Normalize a catalog display name: drop a short vendor prefix copied from
/// OpenRouter ("Z.ai: GLM 5.3" → "GLM 5.3") and humanize names that are really
/// ids ("z-ai/glm-5.3-flash" → "GLM 5.3 Flash"). Display only; ids never change.
#[allow(dead_code)] // Wired once the Rust listing emits display names.
pub(crate) fn normalize_catalog_display_name(name: &str, id: Option<&str>) -> String {
    let trimmed = js_trim(name);
    if trimmed.is_empty() {
        return name.to_owned();
    }
    let leaf = id.map(leaf_of).unwrap_or_default();
    if id_like().is_match(trimmed)
        && (Some(trimmed) == id || trimmed == leaf || trimmed.contains('/'))
    {
        let humanized = humanize_id(trimmed);
        return if humanized.is_empty() {
            trimmed.to_owned()
        } else {
            humanized
        };
    }
    let without_vendor = vendor_prefix().replace(trimmed, "");
    if without_vendor.is_empty() {
        trimmed.to_owned()
    } else {
        without_vendor.into_owned()
    }
}

/// Apply [`normalize_catalog_display_name`] to every row with a non-empty
/// string `name`; other rows pass through unchanged.
#[allow(dead_code)]
pub(crate) fn normalize_catalog_model_names(models: &mut [serde_json::Value]) {
    for model in models {
        let Some(name) = model
            .get("name")
            .and_then(serde_json::Value::as_str)
            .filter(|name| !name.is_empty())
        else {
            continue;
        };
        let id = model.get("id").and_then(serde_json::Value::as_str);
        let next = normalize_catalog_display_name(name, id);
        if next != name {
            model["name"] = serde_json::Value::String(next);
        }
    }
}

#[allow(dead_code)] // Wired once the Rust listing emits display names.
fn leaf_of(value: &str) -> &str {
    value.rsplit_once('/').map_or(value, |(_, leaf)| leaf)
}

#[allow(dead_code)] // Wired once the Rust listing emits display names.
fn humanize_token(token: &str) -> String {
    const ACRONYMS: [&str; 13] = [
        "gpt", "glm", "llm", "vl", "ai", "api", "ocr", "tts", "stt", "moe", "r1", "qwq", "mimo",
    ];
    let lower = token.to_ascii_lowercase();
    if lower == "mimo" {
        return "MiMo".to_owned();
    }
    if ACRONYMS.contains(&lower.as_str()) {
        return lower.to_ascii_uppercase();
    }
    let mut chars = token.chars();
    match chars.next() {
        Some(first) if first.is_ascii_digit() => token.to_owned(),
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[allow(dead_code)] // Wired once the Rust listing emits display names.
fn humanize_id(value: &str) -> String {
    let joined = leaf_of(value)
        .split(|c: char| c == '-' || c == '_' || js_whitespace(c))
        .filter(|token| !token.is_empty())
        .map(humanize_token)
        .collect::<Vec<_>>()
        .join(" ");
    // Legacy: `.replace(/^GPT (?=\d)/, "GPT-")`.
    match joined.strip_prefix("GPT ") {
        Some(rest) if rest.starts_with(|c: char| c.is_ascii_digit()) => format!("GPT-{rest}"),
        _ => joined,
    }
}

#[allow(dead_code)] // Wired once the Rust listing emits display names.
fn id_like() -> &'static regex::Regex {
    static ID_LIKE: OnceLock<regex::Regex> = OnceLock::new();
    ID_LIKE.get_or_init(|| {
        regex::Regex::new(r"^[a-z0-9][a-z0-9._-]*(/[a-z0-9][a-z0-9._:-]*)*$")
            .expect("valid id pattern")
    })
}

/// Legacy `/^[A-Za-z0-9][A-Za-z0-9.\- ]{0,23}:\s+(?=\S)/`. The lookahead is
/// implied here: the name is trimmed first, so whitespace after the colon is
/// always followed by a non-space character.
#[allow(dead_code)] // Wired once the Rust listing emits display names.
fn vendor_prefix() -> &'static regex::Regex {
    static VENDOR_PREFIX: OnceLock<regex::Regex> = OnceLock::new();
    VENDOR_PREFIX.get_or_init(|| {
        regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9.\- ]{0,23}:[\s\u{feff}]+")
            .expect("valid vendor prefix pattern")
    })
}

/// JavaScript `String.prototype.trim` whitespace: Unicode White_Space plus BOM.
fn js_whitespace(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

fn js_trim(value: &str) -> &str {
    value.trim_matches(js_whitespace)
}

/// `Number.parseInt(value, 10)` restricted to positive results: leading
/// whitespace, an optional sign, then decimal digits up to the first other
/// character. Huge values saturate instead of overflowing.
fn js_parse_positive_int(value: &str) -> Option<usize> {
    let rest = value.trim_start_matches(js_whitespace);
    let (negative, digits) = match rest.as_bytes().first() {
        Some(b'-') => (true, &rest[1..]),
        Some(b'+') => (false, &rest[1..]),
        _ => (false, rest),
    };
    let digits: &str = &digits[..digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len())];
    if digits.is_empty() || negative {
        return None;
    }
    let parsed = digits.bytes().fold(0usize, |total, digit| {
        total
            .saturating_mul(10)
            .saturating_add(usize::from(digit - b'0'))
    });
    (parsed > 0).then_some(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn rows(value: Value) -> Vec<Value> {
        value.as_array().cloned().unwrap()
    }

    // tests/unit/models-catalog-pagination.test.ts
    #[test]
    fn missing_params_mean_the_full_list() {
        assert_eq!(parse_catalog_page(None), CatalogPage::default());
        assert_eq!(parse_catalog_page(Some("")), CatalogPage::default());
    }

    #[test]
    fn accepts_openai_compatible_limit_and_after() {
        assert_eq!(
            parse_catalog_page(Some("limit=20&after=gpt-4o")),
            CatalogPage {
                after: Some("gpt-4o".into()),
                limit: Some(20)
            }
        );
    }

    #[test]
    fn ignores_non_positive_limits_and_blank_after() {
        assert_eq!(
            parse_catalog_page(Some("limit=0&after=")),
            CatalogPage::default()
        );
        assert_eq!(parse_catalog_page(Some("limit=-5")), CatalogPage::default());
        assert_eq!(
            parse_catalog_page(Some("limit=abc&after=%20%20")),
            CatalogPage::default()
        );
    }

    #[test]
    fn limit_follows_parse_int_and_is_capped() {
        assert_eq!(parse_catalog_page(Some("limit=20abc")).limit, Some(20));
        assert_eq!(parse_catalog_page(Some("limit=%2B7")).limit, Some(7));
        assert_eq!(parse_catalog_page(Some("limit=0x10")).limit, None);
        assert_eq!(
            parse_catalog_page(Some("limit=99999999999999999999999")).limit,
            Some(CATALOG_PAGE_LIMIT_MAX)
        );
    }

    #[test]
    fn first_occurrence_of_a_parameter_wins() {
        assert_eq!(
            parse_catalog_page(Some("after=a&after=b&limit=1&limit=9")),
            CatalogPage {
                after: Some("a".into()),
                limit: Some(1)
            }
        );
    }

    #[test]
    fn slices_after_a_cursor_and_reports_has_more() {
        let page = CatalogPage {
            after: Some("b".into()),
            limit: Some(1),
        };
        let result = apply_catalog_page(
            rows(json!([{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"}])),
            &page,
        );
        assert_eq!(result.models, rows(json!([{"id":"c"}])));
        assert!(result.has_more);
        assert_eq!(result.last_id.as_deref(), Some("c"));
    }

    #[test]
    fn returns_the_remainder_when_limit_exceeds_the_tail() {
        let page = CatalogPage {
            after: Some("b".into()),
            limit: Some(10),
        };
        let result = apply_catalog_page(rows(json!([{"id":"a"},{"id":"b"},{"id":"c"}])), &page);
        assert_eq!(result.models, rows(json!([{"id":"c"}])));
        assert!(!result.has_more);
        assert_eq!(result.last_id.as_deref(), Some("c"));
    }

    #[test]
    fn unknown_cursor_starts_from_the_beginning_and_no_paging_returns_everything() {
        let models = rows(json!([{"id":"a"},{"id":"b"}]));
        let page = CatalogPage {
            after: Some("zzz".into()),
            limit: Some(1),
        };
        let result = apply_catalog_page(models.clone(), &page);
        assert_eq!(result.models, rows(json!([{"id":"a"}])));
        assert!(result.has_more);
        let all = apply_catalog_page(models.clone(), &CatalogPage::default());
        assert_eq!(
            all,
            CatalogPageResult {
                models,
                has_more: false,
                last_id: None
            }
        );
    }

    #[test]
    fn cache_keys_distinguish_pages() {
        let first = CatalogPage {
            after: None,
            limit: Some(10),
        };
        let second = CatalogPage {
            after: Some("gpt-4o".into()),
            limit: Some(10),
        };
        assert_ne!(first.cache_key(), second.cache_key());
    }

    // tests/unit/models-catalog-exact-dup-4424.test.ts
    #[test]
    fn drops_exact_same_surface_duplicates_and_keeps_the_first_row() {
        let out = dedupe_exact_catalog_ids(rows(json!([
            {"id":"codex/gpt-5.5","owned_by":"codex","root":"gpt-5.5","context_length":200000},
            {"id":"codex/gpt-5.5","owned_by":"codex","root":"gpt-5.5","context_length":100000}
        ])));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["context_length"], 200000);
    }

    #[test]
    fn drops_generic_chat_siblings_of_typed_specialty_rows() {
        let out = dedupe_exact_catalog_ids(rows(json!([
            {"id":"openai/whisper-1","owned_by":"openai","context_length":128000,"capabilities":{"tool_calling":true,"reasoning":true}},
            {"id":"openai/whisper-1","owned_by":"openai","type":"audio","subtype":"transcription"},
            {"id":"veo-free/veo","owned_by":"veo-free","context_length":128000,"capabilities":{"tool_calling":true,"reasoning":true}},
            {"id":"veo-free/veo","owned_by":"veo-free","type":"video"},
            {"id":"openai/omni-moderation-latest","owned_by":"openai","context_length":128000},
            {"id":"openai/omni-moderation-latest","owned_by":"openai","type":"moderation"}
        ])));
        let kept: Vec<(&str, &str, &str)> = out
            .iter()
            .map(|m| {
                (
                    m.catalog_id().unwrap(),
                    m.catalog_type(),
                    m.catalog_subtype(),
                )
            })
            .collect();
        assert_eq!(
            kept,
            [
                ("openai/whisper-1", "audio", "transcription"),
                ("veo-free/veo", "video", ""),
                ("openai/omni-moderation-latest", "moderation", ""),
            ]
        );
        assert!(out[1].get("subtype").is_none());
    }

    #[test]
    fn preserves_transcription_and_speech_surfaces_under_one_id() {
        let out = dedupe_exact_catalog_ids(rows(json!([
            {"id":"openai/gpt-4o-mini-tts","type":"audio","subtype":"transcription"},
            {"id":"openai/gpt-4o-mini-tts","type":"audio","subtype":"speech"},
            {"id":"openai/gpt-4o-mini-tts","context_length":128000}
        ])));
        let subtypes: Vec<&str> = out.iter().map(CatalogEntry::catalog_subtype).collect();
        assert_eq!(subtypes, ["transcription", "speech"]);
    }

    #[test]
    fn keeps_distinct_ids_and_the_first_rows_fields() {
        let out = dedupe_exact_catalog_ids(rows(json!([
            {"id":"a/one","account_id":"acct-1","type":"video"},
            {"id":"a/two","account_id":"acct-2","type":"video"},
            {"id":"a/one","account_id":"acct-9","type":"video"}
        ])));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["account_id"], "acct-1");
        assert_eq!(out[1]["id"], "a/two");
    }

    #[test]
    fn passes_through_short_lists_and_id_less_rows() {
        assert!(dedupe_exact_catalog_ids(Vec::<Value>::new()).is_empty());
        assert_eq!(
            dedupe_exact_catalog_ids(rows(json!([{"id":"only"}]))),
            rows(json!([{"id":"only"}]))
        );
        let out = dedupe_exact_catalog_ids(rows(json!([{"name":"no-id"},{"id":"x"},{"id":"x"}])));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["name"], "no-id");
        let out = dedupe_exact_catalog_ids(rows(json!([
            {"name":"alpha","type":"video"},
            {"name":"beta","type":"audio"}
        ])));
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn preserves_relative_order() {
        let out = dedupe_exact_catalog_ids(rows(json!([
            {"id":"p/e"},{"id":"p/d"},{"id":"p/c"},{"id":"p/b"},{"id":"p/a"}
        ])));
        let ids: Vec<&str> = out.iter().filter_map(CatalogEntry::catalog_id).collect();
        assert_eq!(ids, ["p/e", "p/d", "p/c", "p/b", "p/a"]);
    }

    // tests/redrouter/native/catalog-display-names.test.ts
    #[test]
    fn drops_vendor_prefixes_copied_from_openrouter() {
        assert_eq!(
            normalize_catalog_display_name("Z.ai: GLM 5.3", Some("openrouter/z-ai/glm-5.3")),
            "GLM 5.3"
        );
        assert_eq!(
            normalize_catalog_display_name("Z.ai: GLM 5.3 (batch)", None),
            "GLM 5.3 (batch)"
        );
        assert_eq!(
            normalize_catalog_display_name("Xiaomi: MiMo-V2.5-Pro", None),
            "MiMo-V2.5-Pro"
        );
    }

    #[test]
    fn humanizes_names_that_are_ids() {
        assert_eq!(
            normalize_catalog_display_name(
                "z-ai/glm-5.3-flash",
                Some("openrouter/z-ai/glm-5.3-flash")
            ),
            "GLM 5.3 Flash"
        );
        assert_eq!(
            normalize_catalog_display_name("gpt-5.5", Some("cx/gpt-5.5")),
            "GPT-5.5"
        );
    }

    #[test]
    fn leaves_clean_names_and_long_labels_alone() {
        assert_eq!(
            normalize_catalog_display_name("GLM 5.3", Some("opencode-go/glm-5.3")),
            "GLM 5.3"
        );
        assert_eq!(
            normalize_catalog_display_name("GLM 5.3 Flash (Vision)", None),
            "GLM 5.3 Flash (Vision)"
        );
        let name = "A very long descriptive label that is not a vendor: tail";
        assert_eq!(normalize_catalog_display_name(name, None), name);
        assert_eq!(normalize_catalog_display_name("   ", None), "   ");
    }

    #[test]
    fn only_names_change_and_rows_without_names_pass_through() {
        let mut models = rows(json!([
            {"id":"openrouter/z-ai/glm-5.3","name":"Z.ai: GLM 5.3","owned_by":"openrouter"},
            {"id":"x/y"}
        ]));
        normalize_catalog_model_names(&mut models);
        assert_eq!(
            models,
            rows(json!([
                {"id":"openrouter/z-ai/glm-5.3","name":"GLM 5.3","owned_by":"openrouter"},
                {"id":"x/y"}
            ]))
        );
    }
}
