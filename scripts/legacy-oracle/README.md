# Legacy oracle tooling

The Rust daemon (`rust/red-routerd`) is checked against the legacy TypeScript with **differential oracles**: a script runs a legacy function over a matrix of inputs under Node, writes the outputs to a JSON file next to the Rust module, and a Rust unit test asserts the port returns the same values. The JSON files (`rust/red-routerd/src/*_oracle.json`) are committed; this directory is what regenerates them.

Use it whenever you port a legacy module: read the TypeScript, port it, then pin the port to what the legacy code actually returns. A second implementation that only agrees with itself proves nothing.

## One-time setup

The legacy checkout has no `node_modules`. The oracles need only three packages, installed here (git-ignored):

```bash
cd scripts/legacy-oracle
mkdir -p legacy-deps && cd legacy-deps
echo '{"name":"legacy-deps","private":true}' > package.json
npm install zod uuid typescript@5.9.3 --no-audit --no-fund --ignore-scripts
```

Node 24 or newer is required (`module.registerHooks`). TypeScript must be 5.x: version 7 has no JavaScript compiler API.

## Running

```bash
node scripts/legacy-oracle/run-oracle.mjs --list
node scripts/legacy-oracle/run-oracle.mjs quota-text-cooldowns          # one oracle
node scripts/legacy-oracle/run-oracle.mjs --all                         # all of them
node scripts/legacy-oracle/run-oracle.mjs error-config --root <checkout> # another legacy checkout
```

`--all` rewrites every committed oracle. On an unchanged legacy tree the result must be byte-identical (`git status` stays clean); a diff means the legacy side changed or the script is not deterministic. The runner pins the clock where a script needs one, sets `TZ=UTC`, and redirects the legacy data directory (see below).

## Safety: the legacy db layer opens a real SQLite store

Importing any module that reaches `@/lib/db/*` makes the legacy code open `storage.sqlite` in the application data directory and run schema migrations on it. The runner sets `DATA_DIR` and `RED_ROUTER_DATA_DIR` to `scripts/legacy-oracle/.cache/legacy-data`, so it never touches an installed app's store. If you run a script by hand, set both variables first. Prefer stubbing the db modules (`hooks/stubs-heavy.mjs`) when the module under test does not need them.

## How it loads the legacy code

The legacy sources assume a bundler, so `hooks/` registers Node module hooks, in this order (a later hook runs first):

| Hook | What it does |
| --- | --- |
| `ref-hooks.mjs` | resolves the `@/` alias to `src/` under `LEGACY_ROOT`, and extensionless relative imports |
| `ref-hooks-pkg.mjs` | maps the `@omniroute/open-sse/...` workspace package to `open-sse/` |
| `ref-hooks-heavy.mjs` | stubs `@/lib/logPayloads` and `@/lib/db/providers` (`stubs-heavy.mjs`) |
| `ref-hooks-deps.mjs` | resolves bare packages from `legacy-deps/node_modules` |
| `ref-hooks-json.mjs` | serves JSON imported without `with { type: "json" }` |
| `ref-hooks-ts.mjs` | transpiles `.ts` with TypeScript instead of Node type stripping, which cannot elide type-only imports or handle parameter properties |

`make-copy.mjs` and `hooks/ref-hooks-stub.mjs` exist for `toResponses.ts`, whose import of the store setting is replaced by a copy of the real check. A script that evaluates a function from source text (`resp-text-oracle`, `replayable-oracle`, `stream-oracle`) does so because the module around it imports the whole provider registry.

## Writing a new oracle

1. Create `oracles/<name>.mjs`. It receives the legacy location as `process.argv[2]` and the output path as `process.argv[3]`. Import the legacy module, build inputs that cover the branches (statuses, empty and null values, boundary numbers, casing), and write `JSON.stringify({ cases })`. Fix `Date.now` if the function reads the clock.
2. Register it in `ORACLES` in `run-oracle.mjs` with the argument form it needs (`root-url`, `root-path`, `module-url:<path>`, `source:<path>`, `copy-url:<path>`).
3. In the Rust module add a test that reads the JSON with `include_str!` and compares each case. Keep the JSON small enough to review (a few hundred KB at most); subsample the matrix rather than committing all of it, as `provider-failure` does.
4. Run it, then run the Rust test. Every mismatch is either a port bug or a deliberate difference; a deliberate one is documented in the module and in the ledger, not hidden by trimming the case.

Known limits of the Rust side that the oracles work around: `serde_json::Value` sorts object keys (the legacy `JSON.stringify` keeps insertion order), so a few oracles avoid order-sensitive cases and say so in the module docs.
