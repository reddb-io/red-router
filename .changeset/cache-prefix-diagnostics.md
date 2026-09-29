---
"@reddb-io/red-router": minor
---

Prompt-cache diagnostics: for every upstream request the router now compares the body it sends with the previous request of the same conversation and records whether the cacheable prefix (tools, system, earlier messages, thinking settings) stayed identical, where it first diverged and why. A new **Prefix efficiency** tab on the Cache page shows, per model, how many follow-up requests only appended, the cache read and write shares of the input, a "writes not read" warning, and the causes (rewritten history, changed tools or system, thinking change, another account). It reuses the OmniRoute prompt-cache log meta hook and usage history; observations hold only counts and cause names (14-day retention, migration 202, `REDROUTER_CACHE_DIAGNOSTICS=0` switches it off). Motivation: a week of Claude Opus 5.5 usage showed 65% of the spend with 4.6% of input read from cache because the conversation was rewritten on every turn.
