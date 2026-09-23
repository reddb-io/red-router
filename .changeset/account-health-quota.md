---
"@reddb-io/red-router": minor
---

Account selection now uses measured health and reported quota.

- **Health tracking.** RedRouter measures each account and model: time to first token, latency and error rate, with a circuit breaker that opens after 3 straight failures. The provider page shows each account's TTFT and error rate.
- **"Prefer healthy accounts"** (Settings, the `health` fallback strategy). The account that answers fastest and fails least leads; accounts not yet measured are tried first, and a few requests explore the others.
- **Combos.** Combos move a member to the back while its provider is failing on every account, unless the request's own routing chose it.
- **"Quota-aware routing"** (opt-in). It reads each account's quota every 5 min from the provider's usage API, skips accounts that ran out, keeps a configurable reserve, and uses first the quota that resets soonest. Reports older than 30 min count as unknown, and when every account is exhausted the upstream has the last word.
