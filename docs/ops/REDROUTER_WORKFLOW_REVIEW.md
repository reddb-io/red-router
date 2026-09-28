---
title: "RedRouter workflow ownership review"
version: 0.34.1
lastUpdated: 2026-09-28
---

# RedRouter workflow ownership review

RedRouter is `reddb-io/red-router`, publishing `@reddb-io/red-router`. Upstream
source inheritance does not transfer another project's workflows, credentials or
wholesale test requirements.

## One active workflow

`.github/workflows/red-publish.yml` is the only active workflow. It has four
parallel validation jobs and one conditional release job:

- `Product checks`: runtime, repository, dependency, lint, typecheck, API-route
  and Changesets checks.
- `RedRouter contracts`: the selected native product regressions.
- `RedRouter UI`: the selected UI regressions.
- `Build and package smoke`: one release build, one pack, installed-package checks
  and the selected browser smoke.
- `Publish npm and GitHub Release`: only for a valid SemVer tag, after every other
  job passes.

Pull requests and pushes to `main` run validation. A `vX.Y.Z` tag runs the same
validation and publishes the tarball produced by that exact workflow run. Manual
dispatch can validate `main` or retry an existing tag. There are no scheduled,
nightly, upstream publication, VPS or release-branch workflows.

GitHub's default CodeQL setup remains the repository-level code analysis facility.
The product workflow retains dependency auditing and the RedRouter security
contracts; separate advisory CodeQL, Semgrep and Scorecard workflow files were
removed to keep one visible pipeline.

## Changesets and SemVer

Changesets decides the next version before tagging:

```bash
npm run changeset
npm run release:status
npm run release:version
```

The root-package adapter uses the pinned official Changesets CLI. A reviewer commits
the generated package, lockfile and changelog changes to `main`, then creates the
matching `vX.Y.Z` tag. The workflow verifies that tag, package and lockfile agree.
It never invents a version, changes a version during upload or creates a release
branch.

## Test ownership

Upstreams own their original suites. RedRouter owns regressions for local
adaptations and integrations. `config/testing/redrouter-suites.json` selects
retained product contracts, while new tests under
`tests/redrouter/{native,ui,e2e}/` are discovered automatically.

Default `test:unit`, `test:vitest`, `test:e2e` and `test:all` use only that scope.
Inherited suites stay opt-in through `test:upstream:*`. Coverage percentages are
not a CI or release gate.

## Artifact and release contract

The build job creates the application and npm tarball once. Package contents,
installation, boot, persistence and browser behavior are checked against that
artifact. For a release run, the tarball and checksums pass directly to the release
job in the same workflow.

The release job verifies source SHA, workflow run, attempt, package identity,
version and checksums before upload. npm publication uses provenance. The workflow
then confirms the public registry integrity and performs a clean mise/aube install
before creating the GitHub Release. It does not rebuild, repack or disable aube
trust checks.

The only external delay outside this pipeline is npm registry processing. A
successful upload is not reported as a complete release until the public metadata,
tarball and consumer installation are available.

## Retired automation

Foreign and inherited workflow sources remain as inert fixtures under
`tests/fixtures/upstream-workflows/` when useful for compatibility tests. GitHub
does not execute that directory. No runtime capability was removed by consolidating
the active workflow files.
