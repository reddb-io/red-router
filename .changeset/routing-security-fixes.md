---
"@reddb-io/red-router": patch
---

Security and routing fixes.

- **`/v1/systemone` now enforces the API key's rules.** It applies the key's request/token/spend limits (429 with Retry-After) and its model allow/deny rules (403); before, any valid key could bypass both. The router's own smart-combo classifier call is exempt, since its chat request already passed them.
- **Usage statistics no longer expose API keys.** The 7-day, 30-day and "all" views sent the full key inside `/api/usage/stats`, `/history` and `/stream`. Rows are now identified by the key's id (or a hash). Two keys whose masked forms match are no longer merged into one row.
- **A combo tries its next member when the model itself is the problem.** Status 410, 406, or a 400/404/422 saying the model is not found, not supported, retired or not served on this endpoint, no longer end the combo. A request error that every member would repeat, such as a context overflow or a bad parameter, still ends it.
- **Account cooldowns escalate as intended.** A streak of 429s now backs off further each time; before, every 429 locked the account for the same 2 s. A single 5xx right after a success locks the model for 5 s instead of 30 s, and repeated 5xx still get the full cooldown.
- **Auto combos no longer ask JEV about unusable members.** A member whose accounts are all locked, missing, or outside the calling key is left out of the decision, and stays at the back as a fallback.
- **Subscription accounts count as free in the auto-combo cost ranking.** A member served by a subscription account (OAuth, web cookie, free) costs 0 there.
