//! Account selection inside one provider pool, ported from the legacy
//! `getProviderCredentials` strategies (src/sse/services/auth.ts): the global
//! `fallbackStrategy` with per-provider `providerStrategies` overrides.
//!
//! The selected account goes first; the remaining accounts follow as the
//! fallback order. Rotation state (last use per account, the sticky
//! round-robin streak, the strict-random deck) lives in memory per
//! tenant and provider, as the legacy per-connection fields do per process.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

/// Legacy default sticky round-robin limit.
pub(crate) const DEFAULT_STICKY_LIMIT: u32 = 3;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AccountStrategy {
    /// Priority order (legacy default).
    #[default]
    FillFirst,
    /// Priority order (the legacy strategy sorts by priority).
    CostOptimized,
    /// Stay on the most recent account for the sticky limit, then move to the
    /// least recently used one.
    RoundRobin,
    /// Always the least recently used account.
    LeastUsed,
    /// A uniformly random account.
    Random,
    /// Each account once per shuffled deck.
    StrictRandom,
}

impl AccountStrategy {
    /// The legacy strategy names this port supports.
    pub(crate) fn parse_legacy(value: &str) -> Option<Self> {
        match value {
            "fill-first" => Some(Self::FillFirst),
            "cost-optimized" => Some(Self::CostOptimized),
            "round-robin" => Some(Self::RoundRobin),
            "least-used" => Some(Self::LeastUsed),
            "random" => Some(Self::Random),
            "strict-random" => Some(Self::StrictRandom),
            _ => None,
        }
    }
}

#[derive(Default)]
struct Pool {
    last_used: HashMap<String, u64>,
    current: Option<String>,
    streak: u32,
    deck: Vec<String>,
    draws: u64,
}

#[derive(Default)]
pub(crate) struct AccountRotation {
    pools: Mutex<HashMap<(String, String), Pool>>,
}

fn random_index(len: usize) -> usize {
    let mut bytes = [0_u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        return 0;
    }
    (u64::from_le_bytes(bytes) % len as u64) as usize
}

/// Least recently used first: never-used accounts in priority order, then
/// the oldest use.
fn lru_order(ids: &[String], last_used: &HashMap<String, u64>) -> Vec<String> {
    let mut ordered: Vec<(usize, &String)> = ids.iter().enumerate().collect();
    ordered.sort_by_key(|(index, id)| (last_used.get(*id).copied().unwrap_or(0), *index));
    ordered.into_iter().map(|(_, id)| id.clone()).collect()
}

impl AccountRotation {
    /// Order a pool's accounts (`ids`, in priority order) for one request
    /// and record the selection, as the legacy selection commits `lastUsedAt`.
    pub(crate) fn order(
        &self,
        tenant: &str,
        provider: &str,
        ids: &[String],
        strategy: AccountStrategy,
        sticky_limit: u32,
        now_ms: u64,
    ) -> Vec<String> {
        if ids.len() <= 1
            || matches!(
                strategy,
                AccountStrategy::FillFirst | AccountStrategy::CostOptimized
            )
        {
            return ids.to_vec();
        }
        let Ok(mut pools) = self.pools.lock() else {
            return ids.to_vec();
        };
        let pool = pools
            .entry((tenant.to_owned(), provider.to_owned()))
            .or_default();
        let selected = match strategy {
            AccountStrategy::FillFirst | AccountStrategy::CostOptimized => unreachable!(),
            AccountStrategy::RoundRobin => {
                let current = pool
                    .current
                    .clone()
                    .filter(|id| ids.contains(id) && pool.last_used.contains_key(id));
                match current {
                    Some(id) if pool.streak < sticky_limit => {
                        pool.streak += 1;
                        id
                    }
                    _ => {
                        pool.streak = 1;
                        lru_order(ids, &pool.last_used)[0].clone()
                    }
                }
            }
            AccountStrategy::LeastUsed => lru_order(ids, &pool.last_used)[0].clone(),
            AccountStrategy::Random => ids[random_index(ids.len())].clone(),
            AccountStrategy::StrictRandom => {
                pool.deck.retain(|id| ids.contains(id));
                if pool.deck.is_empty() {
                    pool.deck = ids.to_vec();
                    // Fisher-Yates shuffle of the new deck.
                    for index in (1..pool.deck.len()).rev() {
                        pool.deck.swap(index, random_index(index + 1));
                    }
                }
                pool.deck.remove(0)
            }
        };
        // Strictly increasing within a pool so ties never hide an order.
        pool.draws += 1;
        let stamp = now_ms
            .max(1)
            .saturating_mul(1_000)
            .saturating_add(pool.draws);
        pool.last_used.insert(selected.clone(), stamp);
        pool.last_used.retain(|id, _| ids.contains(id));
        pool.current = Some(selected.clone());
        let rest = match strategy {
            AccountStrategy::RoundRobin | AccountStrategy::LeastUsed => {
                lru_order(ids, &pool.last_used)
            }
            _ => ids.to_vec(),
        };
        std::iter::once(selected.clone())
            .chain(rest.into_iter().filter(|id| *id != selected))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> Vec<String> {
        ["a", "b", "c"].map(str::to_owned).to_vec()
    }

    #[test]
    fn fill_first_keeps_priority_order() {
        let rotation = AccountRotation::default();
        for strategy in [AccountStrategy::FillFirst, AccountStrategy::CostOptimized] {
            assert_eq!(rotation.order("t", "p", &ids(), strategy, 3, 1), ids());
        }
    }

    #[test]
    fn round_robin_stays_for_the_sticky_limit_then_moves_to_the_least_recent() {
        let rotation = AccountRotation::default();
        let first =
            |now| rotation.order("t", "p", &ids(), AccountStrategy::RoundRobin, 2, now)[0].clone();
        assert_eq!(first(1), "a");
        assert_eq!(first(2), "a");
        // The streak reached the limit: the least recently used account next.
        assert_eq!(first(3), "b");
        assert_eq!(first(4), "b");
        assert_eq!(first(5), "c");
        assert_eq!(first(6), "c");
        assert_eq!(first(7), "a");
        // The fallback order behind the selection is least recent first.
        let order = rotation.order("t", "p", &ids(), AccountStrategy::RoundRobin, 2, 8);
        assert_eq!(order, ["a", "b", "c"]);
        // Pools are independent.
        assert_eq!(
            rotation.order("t", "other", &ids(), AccountStrategy::RoundRobin, 2, 9)[0],
            "a"
        );
    }

    #[test]
    fn least_used_cycles_and_strict_random_uses_each_account_once_per_deck() {
        let rotation = AccountRotation::default();
        let firsts: Vec<String> = (1..=3)
            .map(|now| {
                rotation.order("t", "p", &ids(), AccountStrategy::LeastUsed, 3, now)[0].clone()
            })
            .collect();
        assert_eq!(firsts, ["a", "b", "c"]);

        let rotation = AccountRotation::default();
        let mut deck: Vec<String> = (1..=3)
            .map(|now| {
                rotation.order("t", "p", &ids(), AccountStrategy::StrictRandom, 3, now)[0].clone()
            })
            .collect();
        deck.sort();
        assert_eq!(deck, ids());
        let order = rotation.order("t", "p", &ids(), AccountStrategy::Random, 3, 4);
        assert_eq!(order.len(), 3);
        assert!(ids().contains(&order[0]));
    }

    #[test]
    fn legacy_strategy_names_parse() {
        assert_eq!(
            AccountStrategy::parse_legacy("round-robin"),
            Some(AccountStrategy::RoundRobin)
        );
        assert_eq!(AccountStrategy::parse_legacy("p2c"), None);
        assert_eq!(AccountStrategy::parse_legacy("health"), None);
    }
}
