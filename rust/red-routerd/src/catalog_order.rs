//! Provider-grouped ordering for `GET /v1/models`, ported from the legacy
//! `src/app/api/v1/models/catalogOrder.ts` and the catalog rank of
//! `src/shared/constants/canonicalProviderOrder.ts`.
//!
//! Rows are grouped by `owned_by`: combos first, then providers in registry
//! precedence (OAuth, no-auth, API-key; aliases share their provider's rank),
//! then unknown owners by UTF-16 code-unit order. Input order is kept inside a
//! group. The registry precedence is a snapshot of the legacy provider
//! constants in `legacy_provider_order.json`, written by
//! `scripts/research/legacy-provider-order.ts`.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::sync::LazyLock;

use crate::catalog_capabilities::CatalogRoleEntry;

/// Group key of combo-owned rows; the leading space keeps it apart from every
/// real provider id.
const COMBO_GROUP: &str = " combo";

#[derive(serde::Deserialize)]
struct ProviderOrderSnapshot {
    order: Vec<String>,
    aliases: HashMap<String, String>,
}

/// Registry rank of every canonical provider id and of each alias that is not
/// itself a canonical id. An id listed in several registry sections keeps its
/// last position: collecting into the map overwrites earlier ones, like the
/// legacy loop.
static PROVIDER_RANKS: LazyLock<HashMap<String, usize>> = LazyLock::new(|| {
    let snapshot: ProviderOrderSnapshot =
        serde_json::from_str(include_str!("legacy_provider_order.json"))
            .expect("built-in legacy provider order snapshot");
    let mut ranks: HashMap<String, usize> = snapshot
        .order
        .iter()
        .enumerate()
        .map(|(rank, id)| (id.clone(), rank))
        .collect();
    for (alias, id) in snapshot.aliases {
        if let Some(&rank) = ranks.get(&id) {
            ranks.entry(alias).or_insert(rank);
        }
    }
    ranks
});

/// Legacy `groupSortPriority`: combos, then registry rank, then unknown keys.
#[derive(Debug, PartialEq, Eq)]
enum GroupPriority {
    Combo,
    Registry(usize),
    Unknown(String),
}

impl GroupPriority {
    fn of(group_key: &str) -> Self {
        if group_key == COMBO_GROUP {
            return Self::Combo;
        }
        match PROVIDER_RANKS.get(group_key) {
            Some(&rank) => Self::Registry(rank),
            None => Self::Unknown(group_key.to_owned()),
        }
    }

    fn compare(&self, other: &Self) -> Ordering {
        match (self, other) {
            (Self::Combo, Self::Combo) => Ordering::Equal,
            (Self::Combo, _) => Ordering::Less,
            (_, Self::Combo) => Ordering::Greater,
            (Self::Registry(a), Self::Registry(b)) => a.cmp(b),
            (Self::Registry(_), Self::Unknown(_)) => Ordering::Less,
            (Self::Unknown(_), Self::Registry(_)) => Ordering::Greater,
            // JavaScript string comparison orders UTF-16 code units.
            (Self::Unknown(a), Self::Unknown(b)) => a.encode_utf16().cmp(b.encode_utf16()),
        }
    }
}

/// Group key of a row: the combo bucket, else `owned_by`, else (defensively)
/// the id's provider prefix.
fn model_group_key<T: CatalogRoleEntry>(model: &T) -> &str {
    match model.catalog_owned_by() {
        Some("combo") => COMBO_GROUP,
        Some(owned_by) if !owned_by.is_empty() => owned_by,
        _ => {
            let id = model.catalog_id().unwrap_or_default();
            match id.find('/') {
                Some(slash) if slash > 0 => &id[..slash],
                _ => id,
            }
        }
    }
}

/// Stable provider-grouped sort of catalog rows.
pub(crate) fn sort_catalog_models_provider_grouped<T: CatalogRoleEntry>(models: Vec<T>) -> Vec<T> {
    let mut annotated: Vec<(GroupPriority, T)> = models
        .into_iter()
        .map(|model| (GroupPriority::of(model_group_key(&model)), model))
        .collect();
    // `sort_by` is stable, which keeps the input order inside a group.
    annotated.sort_by(|(a, _), (b, _)| a.compare(b));
    annotated.into_iter().map(|(_, model)| model).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn ids(models: &[Value]) -> Vec<&str> {
        models.iter().map(|m| m["id"].as_str().unwrap()).collect()
    }

    fn owners(models: &[Value]) -> Vec<&str> {
        models
            .iter()
            .map(|m| m["owned_by"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn combos_move_to_front_regardless_of_input_or_registry_order() {
        let out = sort_catalog_models_provider_grouped(vec![
            json!({"id": "openai/gpt-4", "owned_by": "openai"}),
            json!({"id": "auto/smart", "owned_by": "combo"}),
            json!({"id": "anthropic/claude", "owned_by": "anthropic"}),
            json!({"id": "auto/cheap", "owned_by": "combo"}),
        ]);
        assert_eq!(
            ids(&out),
            [
                "auto/smart",
                "auto/cheap",
                "openai/gpt-4",
                "anthropic/claude"
            ]
        );
    }

    #[test]
    fn owned_by_grouping_keeps_a_prefix_alias_contiguous() {
        let out = sort_catalog_models_provider_grouped(vec![
            json!({"id": "oc/kimi-k2", "owned_by": "opencode"}),
            json!({"id": "openai/gpt-4", "owned_by": "openai"}),
            json!({"id": "oc/glm-5", "owned_by": "opencode"}),
            json!({"id": "openai/gpt-5", "owned_by": "openai"}),
        ]);
        let keys = owners(&out);
        for owner in ["opencode", "openai"] {
            let first = keys.iter().position(|k| *k == owner).unwrap();
            let last = keys.iter().rposition(|k| *k == owner).unwrap();
            assert_eq!(last - first, 1, "{owner} stays contiguous");
        }
    }

    #[test]
    fn registry_precedence_beats_code_unit_order_within_a_tier() {
        let out = sort_catalog_models_provider_grouped(vec![
            json!({"id": "agy/gemini", "owned_by": "agy"}),
            json!({"id": "qoder/model", "owned_by": "qoder"}),
        ]);
        assert_eq!(owners(&out), ["qoder", "agy"]);
    }

    #[test]
    fn oauth_tier_precedes_api_key_tier() {
        let out = sort_catalog_models_provider_grouped(vec![
            json!({"id": "openai/gpt-4", "owned_by": "openai"}),
            json!({"id": "zed/model", "owned_by": "zed"}),
        ]);
        assert_eq!(owners(&out), ["zed", "openai"]);
    }

    #[test]
    fn unknown_providers_use_code_unit_order() {
        let out = sort_catalog_models_provider_grouped(vec![
            json!({"id": "zzz-unknown/m1", "owned_by": "zzz-unknown"}),
            json!({"id": "Zed-unknown/m2", "owned_by": "Zed-unknown"}),
            json!({"id": "aaa-unknown/m3", "owned_by": "aaa-unknown"}),
            json!({"id": "9nine-unknown/m4", "owned_by": "9nine-unknown"}),
        ]);
        assert_eq!(
            owners(&out),
            ["9nine-unknown", "Zed-unknown", "aaa-unknown", "zzz-unknown"]
        );
    }

    #[test]
    fn unknown_keys_compare_utf16_code_units_not_utf8_bytes() {
        // In UTF-8 bytes U+FF5E (EF ..) sorts before U+1F600 (F0 ..); in UTF-16
        // the surrogate 0xD83D of U+1F600 sorts before 0xFF5E, as in JavaScript.
        let out = sort_catalog_models_provider_grouped(vec![
            json!({"id": "b/1", "owned_by": "\u{FF5E}"}),
            json!({"id": "a/1", "owned_by": "\u{1F600}"}),
        ]);
        assert_eq!(ids(&out), ["a/1", "b/1"]);
    }

    #[test]
    fn malformed_rows_fall_back_to_the_id_prefix() {
        let out = sort_catalog_models_provider_grouped(vec![
            json!({"id": "openai/gpt-4", "owned_by": "openai"}),
            json!({"id": "weird/model", "owned_by": ""}),
            json!({"id": "slashless", "owned_by": ""}),
            json!({"id": "openai/gpt-5", "owned_by": "openai"}),
            json!({"id": "weird/model2"}),
            json!({"id": "", "owned_by": ""}),
        ]);
        assert_eq!(
            ids(&out),
            [
                "openai/gpt-4",
                "openai/gpt-5",
                "",
                "slashless",
                "weird/model",
                "weird/model2"
            ]
        );
    }

    #[test]
    fn equal_id_twins_keep_input_order() {
        let out = sort_catalog_models_provider_grouped(vec![
            json!({"id": "openai/gpt-4", "owned_by": "openai", "subtype": "chat"}),
            json!({"id": "openai/gpt-4", "owned_by": "openai", "subtype": "speech"}),
            json!({"id": "openai/gpt-3.5", "owned_by": "openai"}),
        ]);
        assert_eq!(out[0]["subtype"], "chat");
        assert_eq!(out[1]["subtype"], "speech");
        assert_eq!(out[2]["id"], "openai/gpt-3.5");
    }

    #[test]
    fn every_row_is_kept_exactly_once() {
        let input = vec![
            json!({"id": "openai/gpt-4", "owned_by": "openai"}),
            json!({"id": "auto/x", "owned_by": "combo"}),
            json!({"id": "anthropic/claude", "owned_by": "anthropic"}),
            json!({"id": "weird/m", "owned_by": ""}),
            json!({"id": "openai/gpt-5", "owned_by": "openai"}),
        ];
        let mut expected: Vec<String> = input
            .iter()
            .map(|m| m["id"].as_str().unwrap().to_owned())
            .collect();
        let out = sort_catalog_models_provider_grouped(input);
        let mut actual: Vec<String> = ids(&out).into_iter().map(str::to_owned).collect();
        expected.sort();
        actual.sort();
        assert_eq!(actual, expected);
    }

    #[test]
    fn aliases_share_their_provider_rank_but_never_a_canonical_slot() {
        let snapshot: ProviderOrderSnapshot =
            serde_json::from_str(include_str!("legacy_provider_order.json")).unwrap();
        for (alias, id) in &snapshot.aliases {
            assert!(!snapshot.order.contains(alias), "{alias} is canonical");
            assert_eq!(PROVIDER_RANKS.get(alias), PROVIDER_RANKS.get(id), "{alias}");
        }
        // An id listed in two registry sections takes its last position, as
        // the legacy `rank.set(id, i)` loop overwrites the earlier one.
        let last = snapshot
            .order
            .iter()
            .rposition(|id| id == "windsurf")
            .unwrap();
        assert!(last > 0, "windsurf is listed twice in the baseline");
        assert_eq!(GroupPriority::of("windsurf"), GroupPriority::Registry(last));
    }
}
