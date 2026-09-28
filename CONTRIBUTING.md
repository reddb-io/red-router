# Contributing to OmniRoute

Thank you for your interest in contributing! This guide covers everything you need to get started.

For the official per-change workflow, start with the
[Contribution Golden Path](docs/ops/CONTRIBUTION_GOLDEN_PATH.md). It maps provider, routing,
UI/UX, i18n, CLI, database, and build/deploy changes to their contracts, focused tests, CI
coverage, and reconciliation steps.

---

## Development Setup

### Prerequisites

- **Node.js** `>=22.22.3 <23`, or `>=24.0.0 <27` (recommended: 24 LTS)
- **npm** 10+

> **npm v11+ users (Node 24+):** After `npm install`, verify native modules were installed:
> `node -e "require('better-sqlite3')"`. If it fails with `MODULE_NOT_FOUND`,
> run `npm approve-scripts better-sqlite3 && npm install`. See
> [Troubleshooting](docs/guides/TROUBLESHOOTING.md#npm-v11-better-sqlite3-not-installed-cannot-find-module).

- **Git**

### Clone & Install

```bash
git clone https://github.com/diegosouzapw/OmniRoute.git
cd OmniRoute
npm install
```

### Environment Variables

```bash
# Create your .env from the template
cp .env.example .env

# Generate required secrets
echo "JWT_SECRET=$(openssl rand -base64 48)" >> .env
echo "API_KEY_SECRET=$(openssl rand -hex 32)" >> .env
```

Key variables for development:

| Variable               | Development Default      | Description           |
| ---------------------- | ------------------------ | --------------------- |
| `PORT`                 | `20128`                  | Server port           |
| `NEXT_PUBLIC_BASE_URL` | `http://localhost:20128` | Base URL for frontend |
| `JWT_SECRET`           | (generate above)         | JWT signing secret    |
| `INITIAL_PASSWORD`     | `CHANGEME`               | First login password  |
| `APP_LOG_LEVEL`        | `info`                   | Log verbosity level   |

### Dashboard Settings

The dashboard provides UI toggles for features that can also be configured via environment variables:

| Setting Location    | Toggle             | Description                    |
| ------------------- | ------------------ | ------------------------------ |
| Settings → Advanced | Debug Mode         | Enable debug request logs (UI) |
| Settings → General  | Sidebar Visibility | Show/hide sidebar sections     |

These settings are stored in the database and persist across restarts, overriding env var defaults when set.

### Running Locally

```bash
# Development mode (hot reload)
npm run dev

# Production build
npm run build    # next build → .build/next/ then assembleStandalone → dist/
npm run start

# Fast backend/API-only compile for contributor changes
npm run build:contributor

# Release build (clean rebuild + HEAD sentinel — required for deploy)
npm run build:release   # rm -rf .build dist && build + writes dist/BUILD_SHA

# Common port configuration
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev
```

The contributor build performs compile-only validation: it does not assemble the standalone
distribution or build optional native packaging assets. Use the regular production build when
you need to validate the shippable bundle.

### Build Output Layout

| Directory | Contents                                                                  | Tracked |
| --------- | ------------------------------------------------------------------------- | ------- |
| `src/`    | Application source (TypeScript / TSX)                                     | Yes     |
| `.build/` | Intermediates — `next build` output (gitignored, `distDir = .build/next`) | No      |
| `dist/`   | Shippable bundle — assembled by `assembleStandalone` (gitignored)         | No      |

The build pipeline is a single pass:

```
npm run build
  └─ next build → .build/next/standalone  (Next.js output)
  └─ assembleStandalone()                 (copies standalone + static + public + native assets)
       └─ output: dist/                   (server.js, .next/static/, public/, node_modules/)
```

`npm run build:release` additionally cleans both directories first and writes
`dist/BUILD_SHA` (= `git rev-parse --short HEAD`) as a deploy integrity sentinel.

`npm run build:contributor` uses the backend-only build profile. It temporarily stubs
dashboard UI files while building, keeps API route handlers, and restores the original files
after the build. Use `npm run build` for changes that affect the dashboard UI or for full
release validation; the contributor profile is not a replacement for the release build.

> **VPS deploy note:** the remote image directory `/usr/lib/node_modules/omniroute/app/`
> is unchanged. The deploy skills rsync the contents of `dist/` into it.
> Only the in-repo build output path moved (`app/` → `dist/`).

Default URLs:

- **Dashboard**: `http://localhost:20128/dashboard`
- **API**: `http://localhost:20128/v1`

---

## Git Workflow

> ⚠️ **NEVER commit directly to `main`.** Always use feature branches.
>
> **PR base:** target the active `release/vX.Y.Z` branch (not `main`). See
> [`docs/ops/BRANCHING_MODEL.md`](docs/ops/BRANCHING_MODEL.md) for the
> release-per-branch + tag-at-ship model.

```bash
# Branch from the active release tip (example: release/v3.8.49)
git fetch origin
git checkout -b feat/your-feature-name origin/release/v3.8.49
# ... make changes ...
git commit -m "feat: describe your change"
git push -u origin feat/your-feature-name
# Open a Pull Request with base = release/v3.8.49
```

### Branch Naming

| Prefix      | Purpose                   |
| ----------- | ------------------------- |
| `feat/`     | New features              |
| `fix/`      | Bug fixes                 |
| `refactor/` | Code restructuring        |
| `docs/`     | Documentation changes     |
| `test/`     | Test additions/fixes      |
| `chore/`    | Tooling, CI, dependencies |

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add circuit breaker for provider calls
fix: resolve JWT secret validation edge case
docs: update SECURITY.md with PII protection
test: add observability unit tests
refactor(db): consolidate rate limit tables
```

Scopes (v3.8): `db`, `sse`, `oauth`, `dashboard`, `api`, `cli`, `docker`, `ci`, `mcp`, `a2a`, `memory`, `skills`, `cloud-agent`, `guardrails`, `compression`, `auto-combo`, `resilience`, `providers`, `executors`, `translator`, `domain`, `authz`.

---

## Running Tests

For the current recovery, run tests and builds through GitHub Actions, not locally.
Default commands select RedRouter-owned adaptations and contracts, not the full
upstream suites:

```bash
npm run test:unit    # Product contracts: discovery, routing adaptations, DB, packaging
npm run test:vitest  # Product UI regressions
npm run test:e2e     # Product browser smoke against the built application
npm run test:all     # The three product suites, once each

# List selection without executing tests
node scripts/test/run-redrouter.mjs native --list
node scripts/test/run-redrouter.mjs ui --list
node scripts/test/run-redrouter.mjs e2e --list
```

Existing retained tests are listed in `config/testing/redrouter-suites.json`.
New tests go under `tests/redrouter/native/`, `tests/redrouter/ui/` or
`tests/redrouter/e2e/` and are automatically discovered, including nested folders.
Add behavioral regressions for our production changes: upstream CI does not test
our adaptations, account isolation, distribution or product identity.

The inherited sources remain available as references. `test:upstream:unit`,
`test:upstream:vitest`, `test:upstream:ui` and `test:upstream:e2e` are explicit
opt-ins; specialized inherited commands also remain available but do not run in
default CI. Historical tests can assert obsolete upstream policies and may need
adaptation before use. Their presence is not a claim they currently pass.

### Validation before integration or release

- Check the exact main SHA's CI: product contracts, UI, lint and typechecks.
- Keep package validation and clean installed-package boot checks.
- Reuse the CI build for product browser smoke; do not add duplicate full builds.
- Review changed documentation for verified behavior.
- Keep security analysis of our checkout; review advisory findings separately.
- Coverage percentages are not merge or release gates.
- Do not claim complete upstream parity or faster builds without evidence.

There is no pre-commit hook. Validation runs in CI, not on commit.

### Intentional versions

Use `npm run changeset` to describe a user-visible change. Review
`npm run release:status`, then prepare the next version with
`npm run release:version`. Commit the generated package/lockfile version and
changelog on main. After that commit's CI succeeds, tag that exact version.
Publishing promotes CI's tested tarball; it does not build or choose a version.
See [the release checklist](docs/ops/RELEASE_CHECKLIST.md).

The pinned Changesets CLI runs in an isolated root-package workspace; the private
upstream workspaces are not independently versioned. First use requires registry
access. Versioning neither commits nor tags automatically.

---

## Code Style

- **ESLint** — Validated in CI; commits do not run lint or tests.
- **Prettier** — Format changed files explicitly (2 spaces, semicolons, double quotes, 100 char width, es5 trailing commas). No commit-time rewriting.
- **TypeScript** — All `src/` code uses `.ts`/`.tsx`; `open-sse/` uses `.ts`/`.js`; document with TSDoc (`@param`, `@returns`, `@throws`)
- **No `eval()`** — ESLint enforces `no-eval`, `no-implied-eval`, `no-new-func`
- **Zod validation** — Use Zod v4 schemas for all API input validation
- **Naming**: Files = camelCase/kebab-case, components = PascalCase, constants = UPPER_SNAKE

### Error handling / empty catch blocks

Never leave a `catch` unexplained. Classify it into one of two buckets (operationalizes
the hard rule "never silently swallow errors in SSE streams"):

- **Intentional (our own best-effort cleanup/telemetry)** — a failure here is expected and
  harmless; add a one-line rationale comment, no logging (logging on every request is the
  noise this convention avoids).

  ```ts
  } catch {} // closing an already-closed controller after client disconnect is expected
  ```

- **Should log (external/caller-supplied code, or the swallow changes control flow)** — keep
  the catch (never let it break the stream) but emit a contextual `console.debug`/`warn` so the
  failure is discoverable.

  ```ts
  } catch (e) {
    console.debug("[STREAM] onFailure callback error:", e);
  }
  ```

See `open-sse/utils/stream.ts` and `open-sse/utils/streamHandler.ts` for applied examples.

---

## Project Structure

```
src/                        # TypeScript (.ts / .tsx)
├── app/                    # Next.js 16 App Router
│   ├── (dashboard)/        # Dashboard pages (23 sections)
│   ├── api/                # API routes (51 directories)
│   └── login/              # Auth pages (.tsx)
├── domain/                 # Policy engine (policyEngine, comboResolver, costRules, etc.)
├── lib/                    # Core business logic (.ts)
│   ├── a2a/                # Agent-to-Agent v0.3 protocol server
│   ├── acp/                # Agent Communication Protocol registry
│   ├── compliance/         # Compliance policy engine
│   ├── db/                 # SQLite domain modules + 130 migrations
│   ├── memory/             # Persistent conversational memory
│   ├── oauth/              # OAuth providers, services, and utilities
│   ├── skills/             # Extensible skill framework
│   ├── usage/              # Usage tracking and cost calculation
│   └── localDb.ts          # Re-export layer only — never add logic here
├── middleware/              # Request middleware (promptInjectionGuard)
├── mitm/                   # MITM proxy (cert, DNS, target routing)
├── shared/
│   ├── components/         # React components (.tsx)
│   ├── constants/          # Provider definitions (329), MCP scopes, 19 routing strategies
│   ├── utils/              # Circuit breaker, sanitizer, auth helpers
│   └── validation/         # Zod v4 schemas
└── sse/                    # SSE proxy pipeline

open-sse/                   # @omniroute/open-sse workspace
├── executors/              # 89 executor implementation modules
├── handlers/               # 11 request handlers (chat, responses, embeddings, images, etc.)
├── mcp-server/             # MCP server (110 unique tools, 3 transports, 33 scopes)
├── services/               # 178 top-level services (combo, autoCombo, rateLimitManager, etc.)
├── translator/             # Format translators (OpenAI ↔ Claude ↔ Gemini ↔ Responses ↔ Ollama)
├── transformer/            # Responses API transformer
└── utils/                  # 22 utility modules (stream, TLS, proxy, logging)

electron/                   # Electron desktop app (cross-platform)

tests/
├── unit/                   # Node.js test runner (1,574 test files)
├── integration/            # Integration tests
├── e2e/                    # Playwright tests
├── security/               # Security tests
├── translator/             # Translator-specific tests
└── load/                   # Load tests

docs/
├── adr/                     # Architecture Decision Records
├── architecture/            # System architecture & resilience
├── comparison/              # OmniRoute vs alternatives
├── compression/             # Compression guides & rules
├── dev/                     # Development guides
├── diagrams/                # Architecture diagrams
├── frameworks/              # MCP, A2A, OpenCode, Memory, Skills
├── guides/                  # User guide, Docker, setup, troubleshooting
├── i18n/                    # Internationalized README translations
├── marketing/               # Marketing materials
├── ops/                     # Deployment, proxy, coverage, releases
├── providers/               # Provider-specific docs
├── reference/               # API reference, env vars, CLI tools, free tiers
├── releases/                # Release notes
├── routing/                 # Auto-combo engine, reasoning replay
├── screenshots/             # Dashboard screenshots
├── security/                # Guardrails, compliance, stealth, tokens
└── specs/                   # Design specs
```

---

## Adding a New Provider

### Step 1: Register Provider Constants

Add to `src/shared/constants/providers.ts` — Zod-validated at module load.

### Step 2: Add Executor (if custom logic needed)

Create executor in `open-sse/executors/your-provider.ts` extending the base executor.

### Step 3: Add Translator (if non-OpenAI format)

Create request/response translators in `open-sse/translator/`.

### Step 4: Add OAuth Config (if OAuth-based)

Add OAuth credentials in `src/lib/oauth/constants/oauth.ts` and service in `src/lib/oauth/services/`.

If the upstream provider distributes a public OAuth client_id/secret or Firebase Web API key inside its public CLI / browser bundle, **do not** embed it as a string literal. Use `resolvePublicCred()` from `open-sse/utils/publicCreds.ts` and add a masked byte entry to `EMBEDDED_DEFAULTS`. The full mandatory workflow is documented in [`docs/security/PUBLIC_CREDS.md`](./docs/security/PUBLIC_CREDS.md).

Inside handlers/executors, error messages reaching the client must go through `buildErrorBody()` / `sanitizeErrorMessage()` from `open-sse/utils/error.ts` — never put raw `err.stack` or `err.message` in a Response body. See [`docs/security/ERROR_SANITIZATION.md`](./docs/security/ERROR_SANITIZATION.md).

### Step 5: Register Models

Add model definitions in `open-sse/config/providerRegistry.ts`.

### Step 6: Add Tests

Write unit tests in `tests/unit/` covering at minimum:

- Provider registration
- Request/response translation
- Error handling

---

## Pull Request Checklist

- [ ] Tests pass (`npm test`)
- [ ] Linting passes (`npm run lint`)
- [ ] Build succeeds (`npm run build`)
- [ ] TypeScript types added for new public functions and interfaces
- [ ] No hardcoded secrets or fallback values
- [ ] Public upstream credentials embedded via `resolvePublicCred()` (see [`docs/security/PUBLIC_CREDS.md`](./docs/security/PUBLIC_CREDS.md)), never as literals
- [ ] Error responses route through `buildErrorBody()` / `sanitizeErrorMessage()` — no raw stack traces in response bodies (see [`docs/security/ERROR_SANITIZATION.md`](./docs/security/ERROR_SANITIZATION.md))
- [ ] Shell commands (`exec` / `spawn`) pass runtime values via `env`, not via string interpolation
- [ ] All inputs validated with Zod schemas
- [ ] Changelog **fragment** added under `changelog.d/{features|fixes|maintenance}/<PR>-<slug>.md` for user-facing changes (see [`changelog.d/README.md`](./changelog.d/README.md)) — do **not** edit `CHANGELOG.md` directly; fragments are aggregated at release time and never conflict between PRs
- [ ] Documentation updated (if applicable)
- [ ] No new CodeQL / Secret-Scanning alerts opened, or each one dismissed with technical justification referencing the relevant `docs/security/` doc
- [ ] Routes that spawn child processes (`/api/mcp/`, `/api/cli-tools/runtime/`) classified as `isLocalOnlyPath()` in `src/server/authz/routeGuard.ts` — see [Hard Rule #15](docs/security/ROUTE_GUARD_TIERS.md)
- [ ] No `Co-Authored-By` trailers in commit messages — commits must appear solely under the repository owner's Git identity (Hard Rule #16)

---

## Releasing

Releases are managed via the `/generate-release` workflow. When a new GitHub Release is created, the package is **automatically published to npm** via GitHub Actions.

For VPS deploys, use `npm run build:release` (not `npm run build`) — it performs a clean
rebuild, assembles the bundle into `dist/`, and writes the `dist/BUILD_SHA` sentinel.
Then use the `/deploy-vps-*-cc` skills which rsync `dist/` to the remote `app/` directory.

---

## Getting Help

- **Architecture**: See [`docs/architecture/ARCHITECTURE.md`](docs/architecture/ARCHITECTURE.md)
- **API Reference**: See [`docs/reference/API_REFERENCE.md`](docs/reference/API_REFERENCE.md)
- **Security docs**: [`docs/security/CLI_TOKEN.md`](docs/security/CLI_TOKEN.md), [`docs/security/ROUTE_GUARD_TIERS.md`](docs/security/ROUTE_GUARD_TIERS.md), [`docs/security/ERROR_SANITIZATION.md`](docs/security/ERROR_SANITIZATION.md), [`docs/security/PUBLIC_CREDS.md`](docs/security/PUBLIC_CREDS.md)
- **Ops docs**: [`docs/ops/SQLITE_RUNTIME.md`](docs/ops/SQLITE_RUNTIME.md)
- **Issues**: [github.com/diegosouzapw/OmniRoute/issues](https://github.com/diegosouzapw/OmniRoute/issues)
- **ADRs**: See `docs/adr/` for architectural decision records
