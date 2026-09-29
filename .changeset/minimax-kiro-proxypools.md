---
"@reddb-io/red-router": minor
---

More 9router parity. MiniMax (and MiniMax China) voices are listed by `GET /v1/audio/voices`, grouped into system, cloned, generated and music voices. A CLIProxyAPI Kiro auth file (`auth_method: external_idp`) can be imported, either from the CLIProxy folder scan or by pasting it to the new management-authenticated `POST /api/oauth/kiro/import-cli-proxy`; the account refreshes on first use. Importing a 9router database now brings its proxy pools across as registry proxies and re-binds each connection's pool, idempotently; relay-type pools arrive without relay auth and the import report says so.
