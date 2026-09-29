---
title: "Product Integration Plan"
lastUpdated: 2026-09-29
---

# Product integration plan

Status: blueprint, 2026-09-29. Evidence base: `config/upstream/capability-map.json` (machine-readable, one row per
capability, `6bf58ed77b` = HEAD when written) plus the parity studies behind it. "Not verified" means the studies did not
confirm it in source. Nothing here proves parity: it records what each north contributes, where it lands and what must
not regress. Rules that govern the work are in `AGENTS.md` (English-only UI, PII opt-in, no scheduled triggers, CI
validates, `main` integration).

RedRouter's baseline is its own v0.33.0 (Friday) experience. The code at HEAD is a RedRouter v3.8.51 TypeScript base
(sync to 3.8.52, including four GHSA security fixes, is in progress elsewhere and treated as slice `X-OMNI`).
Four norths supply capability; none replaces our interface, contracts or release channel.

Reading the map: `sources` says who has a capability (`has`, `partial`, `no`, `n/a` for 9router, Pentatonic, LiteLLM,
RedRouter, Friday); `head` is our state (`equivalent`, `partial`, `missing`, `better`); `slice` is the unit of work
(sections 4 and 6); `ux.home` is the page in the target IA (section 2); `ownUnique` marks RedRouter-only features
(section 5).

## 1. The four norths and RedRouter's own

| North | What we take | Lands in | What we deliberately do not take |
|---|---|---|---|
| 9router (`decolua`, v0.5.91 `f01fb909e3`) | Provider breadth and OAuth/free lanes, CLI tool configs, combo presets and capacity adapter, token-saver family, quota tracker, tunnels and proxy pools, media provider pages | providers-accounts, routing-combos, cache-compression; slices S0-S11 | 9Remote promos and NEW badges, its dashboard look and extra locales, its Docker/publish pipeline, `_ide` tool-name cloak, its hidden Basic Chat and PXPIPE menu entries, wholesale test suites |
| Pentatonic fork (`07bad5a458`) | Owner scoping as the seed for users/tenants, admin keys per owner, per-key spend caps, Postgres and leases, admin request-details API, Bedrock parity checks | access-identity-tenancy, cost-usage-billing, network-deploy; E-A0, E-A, L2, E-B | E-mail string as identity and the `@admin` sentinel, per-user blobs inside global settings, dropping System One dynamic routing (we keep the decision router), its nightly upstream-sync workflow |
| LiteLLM 1.104.0 | Reusable budgets and spend attribution, teams and access groups, guardrail assignment with policy resolve, observability destinations and Prometheus, price and context DB, API surface holes, MCP and A2A gateways, key rotation, cache controls, UX patterns (owner-first key form, entity detail tabs, price provenance) | cost-usage-billing, safety-guardrails, observability, agents-mcp-tools; slices L0-L16 | `enterprise/` code or behaviour copied from licensed files, enterprise gating and upsell banners, route-string permissions, YAML as source of truth, mandatory Postgres and Redis, prompts stored in spend logs, ~50 vendor guardrail hooks, "Ask AI", raw passthrough without an allow-list, startup phone-home fetches, bandit/quality routers as first slices |
| RedRouter 3.8.51 (code base) | Already in HEAD: ~270 providers, 19 combo strategies, three resilience layers, guardrails, compression engines, MCP/A2A servers, batch, memory, skills, MITM, cost ledger, key policy | all domains; slice `X-OMNI` (ledger and sync) | Its product identity and branding, grid wallpaper, sponsor banners, extra locales, gamification visible by default, npm/VPS/release-branch publishers, nightly workflows, operator identity |
| RedRouter (own, none of the four) | See section 5: RedCode header contract, System One/JEV, reasoning autopilot, flat ids per key, usage sinks, recommended combos and Setup, white-label, MCP admin keys, chained routers, Claude Code passthrough, RTK/caveman/ponytail/ADHD, headless service and tray, Friday importer | first-class in every domain (`ownUnique` rows) | n/a |

Upstream attribution stays in the ledgers and CHANGELOG. LiteLLM behaviour is re-implemented independently; only MIT
files may be read for design.

## 2. Target information architecture

Starting point is the Friday sidebar (Operate, Tools, System, Debug). HEAD carries 97 `href` entries in 10 RedRouter
sections (`src/shared/constants/sidebarVisibility/sections.ts`) over 124 `page.tsx` files. The target keeps five sections plus
a hidden Advanced set, and moves the rest into tabs so each page answers one question.

### 2.1 Principles

1. Sections are jobs, not products: Operate (run it daily), Tools (connect clients and agents), Govern (who may do what
   and how much), System (set up and maintain the router), Debug (find out why).
2. One page per noun, tabs per facet. A page never exceeds seven tabs; a tab never nests tabs.
3. Nothing is deleted: every HEAD page maps to a section, a tab or Advanced (table 2.4). Advanced pages stay reachable by
   quick search and Settings > Sidebar.
4. Local Mode first: with tenancy off the product looks like Friday plus budgets and guardrails; Govern People and
   Identity appear when `tenancy.mode` is not `off`.
5. Own features are never buried: Autopilot, Models (flat ids), Setup, Usage sinks and Endpoint & Keys are top-level or
   one click deep.
6. Existing rule kept: MCP and A2A are tabs inside `/dashboard/endpoint` (AGENTS.md review focus).

### 2.2 Sections and pages

| Section | Principle | Pages (tabs) | New or moved |
|---|---|---|---|
| Operate | Daily outcomes, not configuration | Home; Usage (Overview, Costs, Providers and combos, Entities); Quota (Windows, Free tiers, Share); Combos (Builder, Live, Auto, Presets, Capacity, Metrics); Models (Flat models, Catalog, Aliases, Custom); Autopilot (Decision router, Reasoning, Test run, Thinking caps); Endpoint & Keys (Keys, Endpoints and tunnels, MCP, A2A); Context Savings (Engines, Output modes, Cache, Headroom, PXPIPE) | Autopilot and flat Models are Friday pages restored; Usage merges analytics, costs, tokens, provider stats; Context Savings replaces the 14-item compression group |
| Tools | Connect clients and agents to the router | CLI Tools; Agents (Cloud, ACP, Conductor, Orchestration, Memory); Skills (RedRouter pack, Library); Prompts; Playground (Chat, Compare); Media & Search (Providers, Search tools, Batch and files); Agent Bridge (MITM, Inspector) | Prompts is new (L12); Skills gets the RedRouter pack back |
| Govern | Who may do what, how much, under which rules | Budgets; People (Users, Teams, Access groups, Tenants); Identity (Providers, Test sign-in); Guardrails (Rules, Attachments, Policies, Monitor); Audit | Entirely new grouping; Budgets, Guardrails and Audit are visible in Local Mode, People and Identity only when tenancy is on |
| System | Set up and maintain the router | Setup; Providers (Accounts, Custom nodes, Remote routers, Model browser, Free tier); Integrations (Usage sinks, Webhooks, Log export, Metrics); Network (Bind and access, Proxies, Free proxies); Pricing (Prices, Data source); Settings (General, Security, Appearance and branding, Routing, Resilience, Feature flags, Sidebar); Health (Health, Runtime, Embedded services, Version); Data (Import, Backup and export, Updates, Changelog) | Setup, Usage sinks exist at HEAD; Network, Data, Metrics, Pricing source are new homes |
| Debug | Find out why something happened | Logs (Requests, Timeline, Proxy, Activity, Conversations); Console; Translator; Simulate (route explain); Chaos | Simulate is the playground route simulator promoted |
| Advanced (hidden) | RedRouter long tail | Radar, Free provider rankings, Gamification (Leaderboard, Profile, Tokens), Plugins, Evals, Batch extras | Off by default; enabled in Settings > Sidebar or found with quick search |

### 2.3 Default visibility (curated preset "Essential")

Twenty entries, comparable to Friday's ~20; the Full preset shows every section; users keep the existing per-item
visibility setting (`settings-sidebar`).

| Visible by default | Hidden until enabled |
|---|---|
| Operate: Home, Usage, Quota, Combos, Models, Autopilot, Endpoint & Keys, Context Savings. Tools: CLI Tools, Playground, Media & Search. Govern: Budgets, Guardrails. System: Setup (until complete), Providers, Integrations, Settings, Health. Debug: Logs, Console | Tools: Agents, Skills, Prompts, Agent Bridge. Govern: People, Identity, Audit. System: Network, Pricing, Data. Debug: Translator, Simulate, Chaos. Advanced: everything |

Role rules once E-A ships: `viewer` sees Operate and Debug read-only; `member` sees Essential without System writes;
`tenant_admin` adds Govern People for its tenant; `platform_admin` sees all. Hiding is convenience only; the server
enforces the same `can(principal, action, resource)` predicate.

### 2.4 Where HEAD's pages go

| HEAD section (items) | Target |
|---|---|
| home | Operate > Home (first-run readiness card stays; Setup link points at System > Setup) |
| omni-proxy: endpoints, api-manager, api-endpoints, mcp, a2a | Operate > Endpoint & Keys tabs Endpoints, Keys, MCP, A2A |
| omni-proxy: providers, model-catalog, embedded-services | System > Providers; Operate > Models (Catalog tab); System > Health (Embedded services) |
| omni-proxy: combos, combos-live, quota, costs-quota-share | Operate > Combos (Live tab); Operate > Quota |
| omni-proxy: compression-context group (engines, studio, exclusions) | Operate > Context Savings (Engines tab groups the engine pages as a list, not 12 menu items) |
| omni-proxy: tools group (cli-code, cli-agents, acp-agents, cloud-agents, conductor, orchestration, agent-bridge, traffic-inspector, discovery) | Tools > CLI Tools, Agents, Agent Bridge; `discovery` placement not verified |
| omni-proxy: integrations (webhooks, log-export, usage-sinks), proxy | System > Integrations; System > Network |
| analytics (analytics, combo-health, utilization, provider-stats, cache, compression, search, evals, activity) | Operate > Usage tabs; Context Savings (cache, compression); Tools > Media & Search (search); Advanced (evals); Debug > Logs (activity) |
| costs (costs, pricing, budget, free-tiers, free-provider-rankings, radar) | Operate > Usage > Costs; System > Pricing; Govern > Budgets; Operate > Quota > Free tiers; Advanced (rankings, radar) |
| monitoring (health, runtime, resilience, logs group, audit group, system group) | System > Health; Debug > Logs, Console; Govern > Audit; System > Data |
| devtools (translator, playground, search-tools) | Debug > Translator; Tools > Playground; Tools > Media & Search |
| agentic-features (memory, agent-skills, skills, chaos-config, plugins) | Tools > Agents (Memory); Tools > Skills; Debug > Chaos; Advanced > Plugins |
| other-features (gamification group, media, batch group) | Advanced; Tools > Media & Search |
| configuration (settings-general, appearance, ai, modality-bridge, routing, resilience, advanced, security, access-tokens, feature-flags, cache, sidebar) | System > Settings tabs; access tokens under Security; cache links to Context Savings > Cache |
| help (docs, issues, changelog) | Footer links; System > Data > Updates |

Friday routes redirect to their new homes (`/dashboard/console-log`, `cli-tools`, `mitm`, `tools-providers/*`,
`basic-chat`, `token-saver`, `keys/:id`, `proxy-pools`); slice `X-IA`.

## 3. Cross-cutting UX rules on the RedDB design system

The DS (`/home/cyber/Work/reddb.io/design-system`, `DESIGN.md`, `PRODUCT.md`): flat calm surfaces, primary red only for
the primary action and a 2px edge on the current item, feedback colours only for state, dense tables, one H1 per page,
no gradients or decorative backgrounds, colours only from `--reddb-*` roles, English copy. The kits are Svelte 5; React
consumes the CSS and the `*.variants.ts` appearance contracts (they import only `tailwind-variants`).

State at HEAD: styles vendored with a lock; nine contracts in `src/shared/design-system/contracts` (button, card, badge,
input, select, nav-item, page-heading, application-shell, breadcrumbs); Button, Card, Badge, Input, Select and Sidebar
render through them; the grid wallpaper is gone. Missing: `PageHeading` and `BrandMark` components, an `Icon` wrapper
(Material Symbols font still used), native dialog `Modal`, `design.md`/`PRODUCT.md` at the repo root, density is
`comfortable` (Friday used `compact`).

| Rule | Statement | DS contract |
|---|---|---|
| One heading | Every page renders one `PageHeading`: title and a one-line description; breadcrumbs above only at depth 2 or more; pages with their own H1 opt out | page-heading, breadcrumbs |
| Shell | Sidebar, header and content sit in the application shell; nav rows use `nav-item`, current row gets the 2px start-edge primary bar; section labels are small `ink-muted` caps | application-shell, nav-item |
| One primary action | One red primary button per view, top right of the heading or in a drawer footer; all other actions secondary or ghost; danger intent only in danger zones | button |
| Tables | Dense table; toolbar above (search, filter chips, view options); sortable headers; row actions in a menu; pagination below; selection uses neutral surface, never red | table, pagination, dropdown-menu, input, select |
| Empty states | What this is, why it is empty, one action (for example "Connect a provider"); no illustration | empty-state |
| Forms | Create and edit in a right drawer; at most eight fields visible, the rest under a collapsed Advanced disclosure; inline errors; Save primary, Discard secondary | field, form, fieldset, drawer, disclosure, switch, textarea, checkbox, radio-group |
| Danger zones | Last flat section of a page; irreversible actions confirm in an alert dialog that names the target | alert-dialog, button |
| Feedback | Persistent messages as alerts, transient as notifications; badges and status indicators show state only; red never marks a non-danger status | alert, notification, badge, status-indicator |
| Detail template | Entity pages (key, team, tenant, provider) use heading, tabs (Overview, Members, Settings) and a description list; budgets show one thin meter | tabs, description-list, meter, progress |
| Data | Charts use `series-1..6` roles, tables stay dense, no card in card, no gradients; savings shown as separate rows, not coloured cards | table, kpi-card (data kit), statistic |
| Quick navigation | One command palette (Ctrl/Cmd+K) across pages, keys, combos and providers; `/` focuses the table filter; every row and action reachable by keyboard | command-palette, kbd |
| Tenancy and roles | Navigation and controls resolve from `can(principal, action, resource)`; viewer controls are disabled with a tooltip; Govern People and Identity appear only when tenancy is on | tooltip, nav-item |
| Density and type | Compact density by default, user-selectable; sentence case, identifiers in code font; toasts say what changed | (tokens) |
| Icons | Lucide through one `Icon` wrapper; no Material Symbols font | icon (DS `Icon` pattern) |
| Loading | Skeleton rows, not spinners over blank pages | skeleton, loading-indicator |

Contracts already in HEAD: button, card, badge, input, select, nav-item, page-heading, breadcrumbs, application-shell.
Contracts to import next (slices `X-DS2`-`X-DS5`): dialog, drawer, alert, alert-dialog, table, tabs, switch,
toggle-group, tooltip, empty-state, skeleton, textarea, checkbox, radio-group, field, form, fieldset, description-list,
meter, progress, status-indicator, notification, pagination, dropdown-menu, disclosure, command-palette (app kit) and
kpi-card (data kit). Seam: keep HEAD's dedicated dest and hashed lock, copy only the needed `*.variants.ts` (Option B in
the dashboard audit); a `--check` test fails on drift.

## 4. Integration roadmap

A wave is a set of slices that ship together as one reviewable milestone; slices inside a wave are independent unless a
dependency says otherwise. Waves 2 and 3 may overlap. The machine is weak: one or two agents at a time, no local builds.

### 4.1 Waves

| Wave | Theme | Slices | Exit criterion |
|---|---|---|---|
| 0 | Protect and pin | S0, L0, X-OMNI, X-GUARD | Ledgers seeded, capability-map lint runs, section 5 behaviours pinned by native tests |
| 1 | Upgrade safety and correctness | E-A0, X-IMPORT, S1, S2, S3, S4, S5, X-DOCKER, X-NETWORK, X-DIAG, X-CIFIX, X-CLISMALL | An existing Friday install upgrades without losing owners, keys, sinks or admin-key limits; container and CI fixtures green |
| 2 | RedCode contract and routing gaps | X-RC1, X-RC2, X-RC3, X-RC4, X-RC5, X-DECISION, X-PREFIX, X-FLAT, X-COMBOPOL | RedCode detects RedRouter with every feature it gates on, flat ids resolve, capabilities never over-advertise |
| 3 | Own the look | X-DS1-X-DS5, X-IA, X-BRAND1, X-BRAND2, X-SETUP, X-AUTOPILOT, X-MEDIA, X-MODELBROWSER | Essential sidebar, one heading per page, Autopilot and Models pages, branding editor |
| 4 | Identity foundation | E-A | Verification list in study B.3.10 step 7 passes; `tenancy.mode=off` is behaviour-identical |
| 5 | Money | L1, L2, L3, L4, S6, X-SINKS, X-TOKENSAVER | Key budgets with per-hop re-check, attribution on every ledger row, `/metrics`, capacity adapter |
| 6 | Governance | L5, L6, L7, L8, L13 | Teams share budgets and model rules, SSO with SAML, guardrail attachments with resolve |
| 7 | Surface breadth | L9, L10, L11, L12, L15, L16, S7-S11, X-CREDIMP, X-HEADROOM, X-PXPIPE, X-UPDATER, X-SKILLS | Long tail by demand; each slice is optional and independent |
| 8 | Scale | E-B, L14 | Two instances on one store; readiness and drain endpoints |
| 9 | Deferred | X-DEFER | Revisit only on demand (bandit routers, SCIM, vendor guardrails, fine-tuning APIs) |

### 4.2 Dependency chain

Importer fidelity (`E-A0`) precedes the tenant schema (`E-A`); budgets (`L2`) precede attribution (`L3`), alerts (`L4`) and
teams (`L6`); teams precede access groups (`L8`); `L5` needs `L2`; `L11` needs `L5`, `L6`, `L8`; `E-B` needs `E-A` and
`L2`; `X-AUTOPILOT` needs `X-DECISION` and `X-IA`; `X-RC3` needs `X-RC2`; `X-FLAT` needs `X-RC2`; DS slices chain
`X-DS1` then `X-DS2` then `X-DS5`; `X-IA` needs `X-DS4`. Budgets carry `scope_type` from day one so teams and tenants
plug in later without a schema break. Full per-slice list: section 6.

### 4.3 Decisions needed from the operator

| # | Question | Default if not answered |
|---|---|---|
| Q1 | Should `/dashboard` land on Home (HEAD) or Usage (Friday)? | Home |
| Q2 | Tenants in phase 1, or users only with tenants reserved in the schema? Should platform-created resources default to shared (Friday) or platform-private? | Users only; shared |
| Q3 | Is per-user budget in scope for `L2`, or only key-scope budgets first? Do notional USD costs of subscription accounts count (`count_zero_cost`)? | Key scope first; not counted |
| Q4 | Build Postgres/HA (`E-B`) at all, or stay single-node SQLite? It needs an ADR first (sync SQLite layer) | Stay SQLite; ADR only |
| Q5 | DS seam: copy `*.variants.ts` (Option B) or adopt the official kit Sync; make `compact` the root density? | Option B; compact |
| Q6 | Sidebar preset: confirm the 20 entries in 2.3 and Govern hidden until tenancy or budgets are used? | As proposed |
| Q7 | Drop 9Remote promos and RedRouter sponsor banners? | Drop |
| Q8 | Restore persistent multi-session Chat as a Playground tab, or leave Basic Chat retired? | Retired |
| Q9 | `if/` resolves to Qoder at HEAD (iFlow was retired): return 410 or keep Qoder? `ollama/` cloud vs local stays as is with a warning? | 410 for `gc/` and `if/`; keep `ollama/` |
| Q10 | Usage-sink payload: accept a delivery-id break versus Friday consumers when moving to payload v1? | Keep HEAD ids, document |
| Q11 | Keep `/v1/mcp` loopback-only (a remote RedRouter cannot host MCP for RedCode)? | Loopback-only |
| Q12 | Allow-listed raw provider passthrough (`L10` b): which provider hosts? | Not started |
| Q13 | Keep OmniRoute-era wire identifiers (`X-OmniRoute-*`, `OMNIROUTE_*`, MCP tool names) as permanent compatibility aliases? | Keep |
| Q14 | Keep gamification and leaderboard in Advanced, or remove? | Advanced |

### 4.4 Risks

| Risk | Mitigation |
|---|---|
| Upgrade path loses data: Friday `data.sqlite` versus `storage.sqlite`, owners and admin keys, stale `db.json` | `E-A0` and `X-IMPORT` first; backup, single transaction, marker, report; import test builds a Friday DB from DDL |
| Over-advertising to RedCode: capabilities flags gate client behaviour | Never advertise an unimplemented feature; capabilities change ships with, or after, the feature |
| Tenancy touches most CRUD routes and the router | Off by default, additive schema, dual read for one release, `can()` shared by routes and account selection |
| Budget overshoot on single-writer SQLite | In-memory counters, batched persistence, bounded overshoot documented, counters rebuilt from the ledger at boot |
| Rebrand breaks persisted CLI config names and wire headers | Dual recognition (read old, write new) plus tests; keep `X-OmniRoute-*` and env names |
| Visual regressions cannot be checked on this machine (`next dev` runs out of memory) | CI browser smoke in light and dark, operator screenshot review per DS phase |
| RedRouter sync 3.8.52 conflicts with our edits (`en.json`, `manifest.ts`, `Sidebar.tsx`) | Land branding and IA slices in small PRs; ledger records the sync state per file |
| Licence contamination from LiteLLM enterprise files | Behaviour-only re-implementation; never open `enterprise/` while implementing |
| Sprawl: 120 pages in one product | Essential preset, tabs over menu items, Advanced hidden, quick search |

### 4.5 Keeping up with each north

No schedules and no inherited nightly triggers (AGENTS.md). A ledger plus a manual audit script:

1. Pin the last audited ref of each north in `config/upstream/product-inheritance.json` (9router `f01fb909e3`, Pentatonic
   `07bad5a458`, LiteLLM `1.104.0`, RedRouter `3.8.51`, sync 3.8.52 in progress).
2. One ledger per north under `config/upstream/` (`9router-ledger.json`, `litellm-ledger.json`, plus Pentatonic and
   RedRouter): rows `{sha or capability, status: ported|equivalent|na|pending|blocked, evidence, decidedAt}`; `equivalent`
   and `ported` cite a HEAD file and a `tests/redrouter/native/` test.
3. `scripts/ci/upstream-audit.mjs` (slices `S0`, `L0`, `X-OMNI`; run by hand, `workflow_dispatch` optional, never on push):
   fetches the remotes, lists commits since the pin, applies patch-id and path mapping, reports unclassified commits and
   provider, alias and model drift, and lints `capability-map.json` (unique ids, slice exists, `headEvidence` paths exist).
   `--strict` fails on unclassified items older than N days.
4. Rhythm: run before each RedRouter release and when a north tags a version; triage `pending` into slices; port by concept,
   never bulk-copy; keep `REMOVED_PROVIDERS.md` and the Gemini CLI retirement as guards.
5. Update `head`, `headEvidence` and `sources` in the map when a slice lands; the map is the index, ledgers hold detail.

## 5. RedRouter-only features to protect

Every row is `ownUnique` in the map. The regression pack is slice `X-GUARD`: native tests under
`tests/redrouter/native/` (existing files named where they exist). A slice from another wave may not merge if it breaks a
row here.

| Feature | Acceptance behaviours that must never regress | Guard |
|---|---|---|
| RedCode header contract | `X-RedRouter-Served-Model` names the answering `provider/model` (combo member after fallback, thinking suffix stripped) and never appears on errors; `X-RedRouter-Cost-USD` is a plain decimal only when priced; `X-RedRouter-Catalog-Version` is a per-key 16-hex digest that changes when combos, keys or disabled models change; request headers `x-red-router-hint`, `-decision`, `-reasoning`, `-token-saver` keep their grammar; capabilities advertise only what exists | `redcode-headers.test.ts`, `catalog-version.test.ts`, `redcode-models-kind.test.ts`, `combo-routing-contract.test.ts` |
| Reasoning autopilot (dual mode, `auto` effort) | Precedence: header `off`, header level, hint effort, header `auto`, configured autopilot; a level stated by the client is never overridden; response header reads `from->level; cause=...[; shadow]`; disabled means no behaviour change; fail-open | `reasoning-autopilot.test.ts` |
| System One / JEV | `/v1/systemone` and `/v1/decisions` stay distinct from chat; unavailable evaluator never becomes an implicit approval; routing off leaves normal behaviour; `/v1/models/systemone` lists evaluators; capabilities report `systemone.available` per key | `systemone-decisions-alias.test.ts`, `tests/unit/jev-routing-parity.test.ts` |
| Flat model ids per key | A `vendor/model` id executes as an implicit fallback combo, cheapest first, free and paid never mixed; the key's id format is applied to `/v1/models` and reported as applied; prefixed and flat spellings resolve to one model | new test in `X-FLAT` (gap today) |
| Usage sinks | Stable delivery ids across retries (no duplicate billing); signed HTTPS webhook; SQS, Kafka and RedDB use the delivery id as message identity; secrets encrypted and redacted in API responses; coverage limits (costed requests only) stay disclosed until `X-SINKS` fixes them | `usage-sinks-outbox.test.ts`, `usage-sink-transports.test.ts`, `usage-sinks-api.test.ts` |
| Recommended combos and Setup | Default, fast and review combos preview and apply from connected accounts, re-apply updates in place, shared-name conflicts are reported; Setup validates with a per-check list | `recommended-combos*.test.ts`, `setup-workbench.test.ts`, `setup-readiness.test.ts` |
| White-label branding | `RED_ROUTER_BRANDING` precedence, `--reddb-*` token vocabulary, sandboxed asset route, theme injection, login and favicon | `tests/unit/branding-product-contract.test.ts` |
| MCP admin keys and `/v1/mcp` | Ten tools, schema version 4, admin role gates admin tools; an imported admin key never becomes a `manage`-scope key; loopback-only origin | `mcp-legacy-*` tests; `E-A0` importer test |
| Chained RedRouters | Hop list in `x-red-router-chain`, loop returns 508, more than four hops refused, `x-rr-internal-models-fetch` avoids fetch loops, remote catalog bound to the credential | `tests/unit/remote-router-catalog.test.ts`; new test in `X-RC5` |
| Claude Code passthrough | Native identity, betas, tool naming and thinking display preserved; client version current (`S1`); no compression of prompts when `x-red-router-token-saver: off` | new fixtures in `S1` (parity vs Friday not verified) |
| Output modes | RTK, caveman, ponytail and ADHD styles selectable; token-saver header `off` bypasses every saver; failure of a saver fails open | `token-saver-header.test.ts` |
| Headless service and tray | Service install, status and uninstall; detached tray attach; loopback bind by default, LAN only through the network setting | `runtime-compatibility.test.mjs` |
| Friday importer | `data.sqlite` is never modified; backup, one transaction, marker and report; keys keep ids so history joins; owners and prefs are staged, not dropped | `friday-import.test.ts`; extend in `E-A0` |
| Policy constants | PII redaction opt-in default (Hard Rule 20); Gemini CLI retired and Antigravity kept; English-only UI and CLI; process-spawning routes local-only; single-build publisher; no scheduled workflows | `pii-opt-in-default.test.ts`, `gemini-cli-deprecation.test.ts`, `update-ownership.test.ts`, `release-artifact.test.mjs` |

## 6. Coverage and slice registry (generated from the map)

| Domain | Capabilities | RedRouter-only | Equivalent | Better | Partial | Missing |
|---|---|---|---|---|---|---|
| gateway-protocols | 34 | 14 | 14 | 0 | 9 | 11 |
| providers-accounts | 20 | 2 | 8 | 1 | 7 | 4 |
| routing-combos | 20 | 4 | 5 | 2 | 6 | 7 |
| reasoning-decisions | 9 | 8 | 6 | 0 | 1 | 2 |
| cost-usage-billing | 16 | 3 | 6 | 0 | 4 | 6 |
| access-identity-tenancy | 22 | 2 | 4 | 1 | 6 | 11 |
| safety-guardrails | 11 | 1 | 3 | 1 | 2 | 5 |
| cache-compression | 7 | 1 | 2 | 1 | 3 | 1 |
| observability | 11 | 1 | 3 | 0 | 4 | 4 |
| agents-mcp-tools | 14 | 1 | 4 | 2 | 3 | 5 |
| network-deploy | 14 | 5 | 6 | 0 | 4 | 4 |
| admin-ux-branding | 19 | 5 | 4 | 0 | 8 | 7 |
| Total (12 domains) | 197 | 47 | 65 | 8 | 57 | 67 |

Highest-value gaps (`head` missing or partial, value H), ordered by effort, then slice:

| Capability | Head | Effort | Slice | Lives in |
|---|---|---|---|---|
| ai-import-owner-fidelity: Friday import keeps ownership and narrow admin keys | partial | S | E-A0 | System > Data > Import |
| ai-mcp-admin-keys: MCP admin keys | partial | S | E-A0 | Operate > Endpoint & Keys > MCP |
| cu-budget-behaviours: Soft budget, throttle and per-hop budget re-check | missing | S | L2 | Govern > Budgets |
| ob-destinations: Log destinations and full OTLP traces | partial | S | L4 | System > Integrations > Log export |
| sg-registry: Guardrail registry (PII, injection, credential) | partial | S | L5 | Govern > Guardrails |
| ai-oidc-gate: OIDC login, auth modes and SSO-only admin list | partial | S | L7 | Govern > Identity |
| gw-claude-code-passthrough: Claude Code passthrough and fidelity | partial | S | S1 | Tools > CLI Tools |
| pa-claude-opus-5-5: Claude Opus 5.5 and Claude Code 2.1.280 | partial | S | S1 | System > Providers |
| pa-alias-compat: Compatibility aliases for saved model ids | partial | S | S2 | System > Providers |
| ux-ds-foundation: Design-system foundation | partial | S | X-DS1 | System > Settings > Appearance |
| rcx-catalog-version: X-RedRouter-Catalog-Version per key | partial | S | X-RC3 | Debug > Logs |
| ai-identity-linking: Identity linking by issuer and subject | missing | M | E-A | Govern > Identity |
| pa-price-context-db: LiteLLM price and context DB v2 with provenance panel | partial | M | L1 | System > Pricing |
| cu-key-limits: Per-key limits (four mechanisms) | partial | M | L2 | Operate > Endpoint & Keys > Keys |
| cu-budget-engine: Reusable budgets with scopes | missing | M | L2 | Govern > Budgets |
| cu-attribution: Attribution stamping, end users and tags | missing | M | L3 | Operate > Usage |
| ob-prometheus: Prometheus metrics endpoint | missing | M | L4 | System > Integrations > Metrics |
| ob-alerts: Webhooks, chat integrations and alert events | partial | M | L4 | System > Integrations > Webhooks |
| sg-assignment: Guardrail assignment and priority | missing | M | L5 | Govern > Guardrails |
| cu-team-user-budgets: Team, user and tenant budgets | missing | M | L6 | Govern > Budgets |
| ai-saml: SAML SP login | missing | M | L7 | Govern > Identity |
| rd-autopilot-page: Autopilot page: decision router, reasoning, Test run | missing | M | X-AUTOPILOT | Operate > Autopilot |
| nd-ci-fixtures: CI fixture e2e (routing, remote router, system one, conformance) | missing | M | X-CIFIX | System > Data |
| rd-jev-global-default: Global decision router default | missing | M | X-DECISION | Operate > Autopilot |
| ux-ds-primitives: Primitives on DS contracts | partial | M | X-DS2 | System > Settings > Appearance |
| ux-shell: Shell: sidebar, header, page heading, breadcrumbs, brand mark | partial | M | X-DS4 | Operate > Home |
| rc-flat-model-ids: Flat model ids per API key | partial | M | X-FLAT | Operate > Models |
| ux-models-page: Models page: one row per flat model id | missing | M | X-FLAT | Operate > Models |
| ux-curated-sidebar: Curated sidebar preset and section model | missing | M | X-IA | System > Settings > Sidebar |
| nd-friday-import: Friday data import and legacy dir migration | partial | M | X-IMPORT | System > Data > Import |
| nd-network-access: Network access setting and CLI | missing | M | X-NETWORK | System > Network |
| sg-omni-security-fixes: RedRouter 3.8.52 security fixes | partial | M | X-OMNI | System > Health |
| rcx-usage-cost-stream: usage.cost in the final stream event | missing | M | X-RC2 | Debug > Logs |
| rcx-models-entry: /v1/models entry contract and kind lists | partial | M | X-RC2 | Operate > Models |
| rcx-capabilities: GET /v1/capabilities superset | partial | M | X-RC3 | Operate > Endpoint & Keys |
| cu-sinks-payload: Usage sinks payload v1, tag filter and coverage | partial | M | X-SINKS | System > Integrations > Usage sinks |
| cc-output-modes: RTK, caveman, ponytail and ADHD output modes | partial | M | X-TOKENSAVER | Operate > Context Savings |
| ai-users-roles: Users, memberships and roles | missing | L | E-A | Govern > People |
| ai-resource-scope: Per-user resource ownership and shared pool | missing | L | E-A | Operate > Combos |
| am-agent-gateways: MCP gateway and A2A agent registry | missing | L | L11 | Operate > Endpoint & Keys > MCP |
| ai-key-groups-teams: Teams (evolving key groups) | partial | L | L6 | Govern > People > Teams |
| rc-capacity-adapter: Capacity adapter (vision, pdf, audio, video fallback pools) | missing | L | S6 | Operate > Combos > Capacity |

Not verified, listed in the map as `nv` in `headEvidence`: stored Responses retrieve/cancel, video remix and content,
Claude Code parity against Friday, free-but-priced cost header, catalog-version header on chat responses, RTK filter
parity, Bedrock credit ceiling, per-request cache controls beyond no-cache, provider gap candidates versus LiteLLM,
`discovery` page placement.

Slice registry: every slice id used in this plan is defined here and referenced by at least one map row.

| Slice | Title | Wave | Size | Depends on | Rows |
|---|---|---|---|---|---|
| L0 | LiteLLM ledger and drift audit | 0 | S | - | 7 |
| S0 | 9router ledger and audit script | 0 | S | - | 23 |
| X-GUARD | RedRouter-only feature regression contract | 0 | S | - | 18 |
| X-OMNI | RedRouter ledger and sync 3.8.52 (in progress elsewhere) | 0 | S | - | 22 |
| E-A0 | Friday importer fidelity for ownership and narrow admin keys | 1 | S | - | 2 |
| S1 | Claude Code 2.1.280 adoption and Claude Code fidelity check | 1 | S | - | 2 |
| S2 | Alias compatibility and retired guard (gc, if) | 1 | S | - | 1 |
| S3 | Provider create conflict guard (done) | 1 | S | - | 1 |
| S4 | Translator robustness bundle | 1 | M | - | 1 |
| S5 | Catalog refresh | 1 | M | - | 1 |
| X-CIFIX | CI fixture e2e and conformance | 1 | M | - | 1 |
| X-CLISMALL | Small CLI and route leftovers | 1 | S | - | 1 |
| X-DIAG | Rotating diagnostics log | 1 | M | - | 1 |
| X-DOCKER | Docker image and GHCR publish | 1 | M | - | 1 |
| X-IMPORT | Friday importer completion: legacy data dirs, stale db.json guard, proxy and prefs mapping | 1 | M | - | 1 |
| X-NETWORK | Network access setting, API, CLI | 1 | M | - | 1 |
| X-COMBOPOL | Combo cost-class policy and stream soft-failure fallback | 2 | M | - | 2 |
| X-DECISION | Global decision router default | 2 | M | X-GUARD | 1 |
| X-FLAT | Flat model ids per key and Models page | 2 | M | X-RC2 | 2 |
| X-PREFIX | Per-connection model prefix | 2 | M | - | 1 |
| X-RC1 | RedCode error headers, expose list, key headers | 2 | S | X-GUARD | 2 |
| X-RC2 | RedCode /v1/models entry contract and usage.cost stream | 2 | M | X-GUARD | 2 |
| X-RC3 | RedCode capabilities superset, grouped catalog, catalog version everywhere | 2 | M | X-RC2 | 3 |
| X-RC4 | Header-keyed combo session affinity | 2 | M | - | 1 |
| X-RC5 | Router chaining and remote System One | 2 | M | X-RC3 | 2 |
| X-AUTOPILOT | Autopilot page: decision, reasoning, Test run | 3 | M | X-DECISION, X-IA | 3 |
| X-BRAND1 | Branding sweep and public assets | 3 | M | - | 2 |
| X-BRAND2 | Branding API and editor | 3 | S | - | 1 |
| X-DS1 | Design-system foundation completion | 3 | S | - | 1 |
| X-DS2 | Primitives long tail | 3 | M | X-DS1 | 1 |
| X-DS3 | Icon wrapper and codemod | 3 | L | X-DS1 | 1 |
| X-DS4 | Shell: PageHeading, BrandMark, breadcrumbs, application-shell | 3 | M | X-DS1 | 1 |
| X-DS5 | Behaviour primitives: dialog, switch, tabs, table, tooltip, empty-state | 3 | M | X-DS2 | 1 |
| X-IA | Information architecture, curated sidebar, redirects, quick nav | 3 | M | X-DS4 | 6 |
| X-MEDIA | Media and web tools pages | 3 | M | X-IA | 1 |
| X-MODELBROWSER | Provider model browser | 3 | M | - | 1 |
| X-SETUP | Setup workbench and recommended combos (shipped, verify) | 3 | S | - | 2 |
| E-A | Users, tenants, roles, ownership epic | 4 | L | E-A0 | 7 |
| L1 | Price and context data v2 | 5 | M | - | 2 |
| L2 | Budgets engine at key scope | 5 | M | - | 5 |
| L3 | Attribution stamping | 5 | M | L2 | 2 |
| L4 | Observability: Prometheus, destinations, alerts | 5 | M | L2 | 3 |
| S6 | Capacity adapter, presets and bulk combo actions | 5 | L | - | 2 |
| X-SINKS | Usage sinks payload v1, tag filter, ledger coverage | 5 | M | L3 | 1 |
| X-TOKENSAVER | Token saver parity: flags import, RTK filters, per-owner | 5 | M | E-A0 | 1 |
| L5 | Guardrail assignment, policies, content filter | 6 | L | L2 | 7 |
| L6 | Teams | 6 | L | L2, E-A | 2 |
| L7 | SSO, SAML, JWT mapping, invitations, login hardening | 6 | L | E-A | 4 |
| L8 | Access groups | 6 | M | L6 | 1 |
| L13 | Key lifecycle and rotation | 6 | M | L2 | 1 |
| L9 | Routing extras: retries, content-policy fallback, probes, stall, reroute | 7 | M | L5 | 5 |
| L10 | API surface additions | 7 | M | L2 | 5 |
| L11 | MCP gateway and A2A registry | 7 | L | L5, L6, L8 | 1 |
| L12 | Prompt registry | 7 | M | - | 1 |
| L15 | Cache extras | 7 | S | - | 1 |
| L16 | UX slices delivered with the feature they front | 7 | S | L3, L6 | 5 |
| S7 | Xiaomi MiMo clusters and login | 7 | L | - | 1 |
| S8 | Quota extras | 7 | S | - | 1 |
| S9 | CLI tool cards: Amp, Devin, Cowork, OpenDesign | 7 | M | - | 1 |
| S10 | Antigravity requestType live check | 7 | S | - | 1 |
| S11 | Gemini Live STT | 7 | M | - | 1 |
| X-CREDIMP | Credential import routes | 7 | M | - | 1 |
| X-HEADROOM | Headroom proxy path, restart, extras | 7 | M | - | 1 |
| X-PXPIPE | PXPIPE service | 7 | L | - | 1 |
| X-SKILLS | RedRouter skill pack restore | 7 | S | - | 1 |
| X-UPDATER | RedRouter-owned updater | 7 | M | - | 1 |
| E-B | Enterprise epic: Postgres, leases, admin request-details | 8 | L | E-A, L2 | 2 |
| L14 | Deploy and HA extras | 8 | M | E-B | 2 |
| X-DEFER | Explicitly deferred or not taken | 9 | S | - | 6 |
