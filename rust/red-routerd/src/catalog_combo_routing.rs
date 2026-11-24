//! What a combo advertises to clients in `GET /v1/models`, ported from the
//! legacy `src/app/api/v1/models/catalogComboRouting.ts`.
//!
//! RedCode only sends its steering hints to a combo whose strategy it knows.
//! RedRouter v0.33.0 called the priority strategy `fallback`, so `strategy`
//! carries that name and `routing_strategy` keeps the native one. `members`
//! lists the model ids the combo can route to.

/// Legacy `comboStrategyForClients`: `(strategy, routing_strategy)` for a
/// native strategy name. The Rust strategy is already normalized when the
/// combo is loaded, so no `normalizeRoutingStrategy` step is needed here.
pub(crate) fn combo_strategy_for_clients(routing: &'static str) -> (&'static str, &'static str) {
    let strategy = if routing == "priority" {
        "fallback"
    } else {
        routing
    };
    (strategy, routing)
}

/// Legacy `comboMemberIds`: the `prefix/model` ids a combo can route to, in
/// target order and without repeats.
pub(crate) fn combo_member_ids<'a>(
    targets: impl IntoIterator<Item = (&'a str, &'a str)>,
    prefix_for: impl Fn(&str) -> &str,
) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for (provider_id, model_id) in targets {
        let id = format!("{}/{model_id}", prefix_for(provider_id));
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    // tests/redrouter/native/combo-routing-contract.test.ts
    #[test]
    fn priority_is_advertised_under_its_v0_33_name_with_the_native_one_kept() {
        assert_eq!(
            combo_strategy_for_clients("priority"),
            ("fallback", "priority")
        );
        assert_eq!(combo_strategy_for_clients("round-robin").0, "round-robin");
        assert_eq!(combo_strategy_for_clients("fusion").0, "fusion");
        assert_eq!(combo_strategy_for_clients("auto").0, "auto");
    }

    #[test]
    fn members_are_ordered_prefixed_and_never_repeated() {
        let members = combo_member_ids(
            [
                ("claude", "claude-opus-5-5"),
                ("node-uuid", "x/y"),
                ("claude", "claude-opus-5-5"),
            ],
            |provider| match provider {
                "node-uuid" => "myproxy",
                other => other,
            },
        );
        assert_eq!(members, ["claude/claude-opus-5-5", "myproxy/x/y"]);
    }
}
