---
"@reddb-io/red-router": minor
---

Sync the OmniRoute engine with release v3.8.52 (258 upstream commits, most of them fixes).

Security:

- GHSA-7j4q-6gx6-pg77: virtual `auto/*` and `qtSd/*` routes are now matched against an API key's combo allow-list, so a restricted key can no longer reach them.
- GHSA-jmq6-8j86-8xqj: the provider connection test runs its local CLI probe only for local callers.
- GHSA-mh4f-3xj9-4gc4: `server.env` is written 0600 in a 0700 data directory, and older installs are repaired on start (the CLI and the desktop app).
- GHSA-9p9m-h9rj-rhhg: pre-request hooks run in an isolated realm and only JSON crosses the boundary (RedRouter already carried an equivalent, stricter implementation, which is kept).
- Also brought in: tightened OAuth, authorization and login handling (#15038-#15073), a constant-time compare for the environment passthrough key, `ip-address` 10.7.2 and `undici` 8.11.2.

Notable fixes: request-scoped streaming refusals fall back without locking the model, model-scoped 429s stay scoped to the model, streamed TTFT and tokens-per-second over generation time, per-request added-wait and resilience-action columns in the call log, the slow-stream deadline is created only for streaming requests (the previous wrapper answered HTTP 500 under the Next.js request proxy), proxy pool set-aside and selector control, per-key token limits for daily, weekly and monthly windows, and a better-sqlite3 native prebuild target.

Database: upstream's new migrations are numbered 195-201 so the RedRouter migrations 190-194 keep their versions. Databases already migrated by a RedRouter build apply the new ones once; fresh installs apply all of them.
