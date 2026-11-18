# Rustify roadmap: legacy TypeScript backend → `rust/red-routerd`

This is the plan for porting every server feature of the legacy TypeScript red-router to Rust with Rustify. The React UI is not ported: it stays the SPA and talks to Rust through JSON endpoints. Product priority and acceptance stay in [RUSTIFY_MIGRATION_QUEUE.md](RUSTIFY_MIGRATION_QUEUE.md); this roadmap adds the Rustify graph's size and ordering facts to it. Sizes come from `rustify graph` on commit `6649f4f22`; they are measurements, not completion percentages.

## Starting point

- Rustify graph (server only, UI excluded by `rustify.toml`): 4,478 TypeScript files, 835,719 lines, 4,203 dependency units, depth 40, 5,592 module tests. One unresolved import. Ten import cycles; the largest has 261 files and 94,651 lines (the `open-sse` executors).
- Existing Rust: 1,314 graph files (309,891 lines) have a Rust candidate that still needs behavior review; 3,157 files (524,952 lines) have none. Only 18 graph files changed since the parity audit, so its crosswalk is still usable.
- Rustify writes no Rust. It orders the work, writes per-batch briefs, records each port against the TypeScript blob ids, and fails CI when ported TypeScript changes without its Rust (`ratchet`).
- `rustify done` refuses a file whose imports are not ported yet. Ports therefore grow from the leaves up, and orchestrators such as `chatCore.ts` or `catalogResponse.ts` are recorded last even when their Rust behavior already exists.
- At Rustify's batch limit of 800 lines, the graph needs at least 1,045 batches.

## Fronts by size

Files are assigned to the queue's fronts by path keywords, so the split is an estimate; the base row is code no single front owns. "Pulled" is the code a front transitively imports that no earlier front in this order has already pulled in.

| Front (queue order) | Own lines | Pulled lines | Rust candidates (files / lines) | Batches ≥ |
| --- | ---: | ---: | ---: | ---: |
| 1 Compatible providers, paths, model discovery | 55,114 | 20,729 | 124 / 21,807 | 69 |
| 2 Custom models, aliases, limits, capabilities | 8,541 | 0 | 10 / 2,008 | 11 |
| 3 Account priorities, groups, queues | 3,220 | 328 | 6 / 2,593 | 5 |
| 4 OAuth/CLI per executor | 145,162 | 6,888 | 340 / 98,038 | 182 |
| 5 Faithful migration and cutover | (Rust importers; no TS port) | | | |
| 6 Organizations, permissions, OIDC, keys | 26,632 | 2,569 | 24 / 7,262 | 34 |
| 7 Quotas, reservations, combos, resilience | 77,899 | 5,679 | 198 / 51,037 | 98 |
| 8 Navigation, onboarding, settings (server side) | 23,392 | 9,107 | 3 / 1,132 | 30 |
| 9 Analytics, pricing, logs, timeline | 36,561 | 2,942 | 65 / 9,081 | 46 |
| 10 Webhooks, exports, reports | 4,615 | 146 | 2 / 257 | 6 |
| 11 Images, audio, video, search, files, batches | 45,865 | 1,755 | 59 / 10,649 | 58 |
| 12 Playground and protocol translation | 25,957 | 0 | 66 / 21,364 | 33 |
| 13 Cache, compression, token savings | 36,947 | 0 | 153 / 28,253 | 47 |
| 14 MCP, A2A, memory, skills, guardrails | 43,639 | 1,029 | 1 / 207 | 55 |
| 15 Agents, plugins, jobs, bridges | 30,049 | 3,367 | 12 / 4,542 | 38 |
| Proxy core (chat, stream, routing) | 56,650 | 512,167 if first | 21 / 4,397 | 71 |
| CLI `bin/cli` (last) | 33,370 | 444 | 1 / 309 | 42 |
| Shared base (db, utils, constants, schemas) | 182,106 | — | 229 / 46,955 | 228 |

The proxy core imports almost everything else. Porting it first would pull in 61% of the graph, so its orchestrators come after the fronts they call.

## Phases

### Phase 0: tooling (in progress)

Done:
- Rustify `bbf9ac7` with a small patch for the repository root package and tsconfig path aliases, so it reads the real tree instead of a rewritten copy.
- `rustify.toml`, `rust/port/mappings.toml` (a rule for every one of the 91 external imports) and `rust/port/CONVENTIONS.md`.
- Pilot, catalog front: batch 1 (paging, dedupe, display names) and batch 2 (endpoint policy, capability filter) passed the full Rust CI (run 44383753407). Five TypeScript modules are recorded in `rust/port/index.toml`.

Remaining:
- Build the patched Rustify in CI. Either propose the patch upstream or vendor it with a pinned build step.
- Add a CI job for `rustify check` and `rustify ratchet --base origin/main`, so changed TypeScript cannot drift from its port.
- Add `compare.toml` cases that run the same requests against both servers (`/v1/models` first).

### Phase 1: record what already exists

- Review the 1,314 candidate files per front against their TypeScript tests. Record matches with `done`, with `--map` for renamed items and `--notes` for intentional differences.
- Mark pure Next.js wiring, build glue and UI leftovers with `skip`, and npm packages replaced by crates with `replace`.
- Exit: `rustify status` reports the real ported share. The ledger's acceptance states stay authoritative.

### Phase 2: fronts in queue order, leaves first

For each front:
1. Take the front's leaf units from `rustify next` (or `brief` on chosen files).
2. Port behavior into the existing Rust modules, choosing batches that change behavior. Skip helpers whose feature does not exist in Rust yet, because they would be dead code.
3. Mirror the TypeScript tests in Rust and pass CI (`cargo fmt`, `clippy -D warnings`, tests on Linux and Windows).
4. Record with `rustify done`. Update the queue row with CI evidence in the same commit.

Order adjustments the graph forces:
- Front 4 includes the 261-file executor cycle. Split it per executor contract instead of porting it as one unit.
- Fronts 12 and 13 import nothing from other fronts, so they can run in parallel with earlier ones.
- The proxy core's orchestrators (`open-sse/handlers/chatCore.ts`, `src/sse/handlers/chat.ts`) are recorded after the fronts they call.

### Phase 3: orchestrators and cutover

- Port or record the remaining high-level modules: catalog builders, route handlers and stream orchestration.
- Front 5: rehearse backup, import, restart and rollback against real legacy databases, preserving ciphertext, ownership and counters.
- Run the `compare` suite against both servers, then retire the TypeScript backend.

### Phase 4: CLI

Port `bin/cli` (182 files) as subcommands of the `red-routerd` binary, which already carries the `import-legacy-*` commands.

## Working rules

- Heavy builds and tests run in CI. Run Rustify locally with `RAYON_NUM_THREADS=1`; a full graph takes about five minutes on a modest workstation.
- One branch per front, with small PRs, each carrying its `index.toml` entries.
- The queue ledger decides priority and acceptance; Rustify decides the order inside a front.

## Risks

- The Rustify patch must be maintained until upstream supports root packages and path aliases.
- The legacy TypeScript still changes. The ratchet is what keeps finished ports from going stale.
- The front split above is keyword-based; check a front's file list in the graph before planning it.
- The batch count is a lower bound. Cycles and review work make the real effort larger.
