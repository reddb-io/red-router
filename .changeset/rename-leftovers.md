---
"@reddb-io/red-router": patch
---

Remove the inherited product name from everything the operator can see outside the language catalogs: the setup diagram (now "RedRouter 4-tier fallback"), notices and hints in the dashboard, provider notices, CLI help and commands (`omniroute …` is now `red-router …`, install commands use `@reddb-io/red-router`), the tray, the desktop app metadata and updater target, the OpenAPI title, the agent card (now English), the built-in Copilot persona and its CLI lookup, generated tool configs (Grok Build and Qwen Code still recognise the entries earlier versions wrote), the published docs, `llm.txt`, and the User-Agents sent to third parties. The news banner no longer ships upstream marketing items. "OmniSkills" is now "Skills". Compatibility identifiers (`OMNIROUTE_*`, `X-OmniRoute-*` headers, `~/.omniroute`) and upstream attribution are unchanged, and a new test fails when user-visible text names the old product again.
