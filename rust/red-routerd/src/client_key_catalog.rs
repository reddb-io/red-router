//! A client key's model catalog policy (legacy `api_keys.catalog_scope` and
//! `allow_auto_combos`, applied by the legacy `/v1/models` builder in
//! `src/app/api/v1/models/catalog.ts`). It shapes what the key lists; routing
//! permissions stay with the key's model and combo grants.

use serde::{Deserialize, Serialize};

/// Which rows a key's `/v1/models` lists.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogScope {
    #[default]
    All,
    /// Only combos (legacy `catalogScope: "combos"`).
    Combos,
    /// Everything except combos (legacy `catalogScope: "models"`).
    Models,
}

impl CatalogScope {
    /// The legacy column spelling.
    pub(crate) fn parse_legacy(value: &str) -> Option<Self> {
        match value {
            "all" => Some(Self::All),
            "combos" => Some(Self::Combos),
            "models" => Some(Self::Models),
            _ => None,
        }
    }
}

const fn listed_by_default() -> bool {
    true
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogPolicy {
    #[serde(default)]
    pub catalog_scope: CatalogScope,
    /// Whether `auto` and `auto/*` combos are listed (legacy `allowAutoCombos`).
    #[serde(default = "listed_by_default")]
    pub list_auto_combos: bool,
}

impl Default for CatalogPolicy {
    fn default() -> Self {
        Self {
            catalog_scope: CatalogScope::All,
            list_auto_combos: true,
        }
    }
}

impl CatalogPolicy {
    pub(crate) fn decode(raw: &str) -> Result<Self, &'static str> {
        if raw.is_empty() {
            return Ok(Self::default());
        }
        serde_json::from_str(raw).map_err(|_| "invalid client key catalog policy")
    }

    pub(crate) fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_owned())
    }

    /// Whether a combo row with this public id is listed.
    pub(crate) fn lists_combo(&self, id: &str) -> bool {
        self.catalog_scope != CatalogScope::Models
            && (self.list_auto_combos || !(id == "auto" || id.starts_with("auto/")))
    }

    /// Whether model (non-combo) rows are listed.
    pub(crate) fn lists_models(&self) -> bool {
        self.catalog_scope != CatalogScope::Combos
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_policy_follows_the_legacy_listing_rules() {
        let default = CatalogPolicy::decode("{}").unwrap();
        assert_eq!(default, CatalogPolicy::default());
        assert_eq!(CatalogPolicy::decode("").unwrap(), default);
        assert!(default.lists_combo("auto/coding") && default.lists_models());

        let no_auto = CatalogPolicy {
            list_auto_combos: false,
            ..CatalogPolicy::default()
        };
        assert!(!no_auto.lists_combo("auto") && !no_auto.lists_combo("auto/coding"));
        assert!(no_auto.lists_combo("autopilot") && no_auto.lists_combo("team"));

        let combos = CatalogPolicy {
            catalog_scope: CatalogScope::Combos,
            ..CatalogPolicy::default()
        };
        assert!(combos.lists_combo("team") && !combos.lists_models());
        let models = CatalogPolicy {
            catalog_scope: CatalogScope::Models,
            ..CatalogPolicy::default()
        };
        assert!(!models.lists_combo("team") && models.lists_models());

        assert_eq!(CatalogPolicy::decode(&combos.encode()).unwrap(), combos);
        assert!(CatalogPolicy::decode(r#"{"catalog_scope":"x"}"#).is_err());
        assert!(CatalogPolicy::decode(r#"{"other":1}"#).is_err());
        assert_eq!(
            CatalogScope::parse_legacy("models"),
            Some(CatalogScope::Models)
        );
        assert_eq!(CatalogScope::parse_legacy("Models"), None);
    }
}
