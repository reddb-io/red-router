---
title: "RedRouter workflow ownership review"
version: 3.8.51
lastUpdated: 2026-09-28
---

# RedRouter workflow ownership review

RedRouter is `reddb-io/red-router`, publishing `@reddb-io/red-router`. Upstream
source inheritance does not transfer another project's operational workflows,
credentials or wholesale test requirements.

This is a local structural review, not a successful Actions run or a timing benchmark.
The scoped CI changes have not yet been validated in GitHub Actions.

## Active workflows

| Workflow                  | Responsibility                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ci.yml`                  | Main pushes/PRs: product contracts and UI, lint/typecheck/audit, one build reused for browser and installed-package smoke.                                         |
| `red-publish.yml`         | Sole npm publisher: tagged SHA on main, successful exact-SHA CI, checksums, provenance, registry integrity and clean mise/aube installation before GitHub release. |
| `api-route-typecheck.yml` | Main-only API diagnostic regression check.                                                                                                                         |
| `codeql.yml`              | Manual security analysis; default-setup compatibility behavior preserved.                                                                                          |
| `semgrep.yml`             | Main-only advisory code/secrets analysis, not a blocking test suite.                                                                                               |
| `scorecard.yml`           | Default-branch supply-chain posture analysis.                                                                                                                      |

No active workflow has a scheduled trigger: there are no nightly or weekly jobs.
Security analysis evaluates our checkout and is retained independently of upstream
test ownership. The publisher remains tag-driven/manual, not triggered on every push.

## Test ownership

Upstreams own their original suites. RedRouter owns regressions for local
adaptations and integrations: discovery/catalog isolation, JEV/System One,
compatibility ports, product identity, design-system behavior and distribution.

`config/testing/redrouter-suites.json` selects existing product tests relative to
the recorded import snapshot. New tests under `tests/redrouter/{native,ui,e2e}/`
are discovered automatically. Missing files or empty selections fail closed.
Default `test:unit`, `test:vitest`, `test:e2e` and `test:all` use that scope.
No coverage-percentage gate is added.

Inherited sources remain opt-in references through `test:upstream:*` and existing
specialized commands. They may assert obsolete upstream policies; keeping them
does not mean they currently pass. We are deliberately reducing test scope, not
claiming equivalent exhaustive coverage or full feature parity.

## Retired automation

All retired workflow sources are recoverable in `tests/fixtures/upstream-workflows/`;
GitHub does not execute that directory. The previous large `ci.yml` is archived too.

- Duplicate/foreign publication and operations: `npm-publish`, `electron-release`,
  `docker-publish`, `deploy-vps`, `lock-released-branch`, `radar-export`,
  `wiki-sync`, `claude`, `nightly-release-green`.
- Duplicate build/acceptance and release-branch gates: `build`, `quality`,
  `release-acceptance`.
- Inherited plugin matrices: `opencode-provider-ci`, `opencode-plugin-ci`.
- Inherited dynamic/fuzz/property/mutation/resilience matrices: `dast-smoke`,
  `nightly-compat`, `nightly-llm-security`, `nightly-property`,
  `nightly-resilience`, `nightly-schemathesis`, `nightly-mutation`,
  `mutation-redundancy`.

No runtime feature was deleted. Container/desktop distribution needs an explicitly
RedRouter-owned pipeline before being offered as a supported release channel.

## Reference patterns

The prior ownership review inspected sibling repositories read-only: dit for
tagged-tree version validation, redskilled for artifact/provenance verification,
and red-skills for deliverable-specific CI. Their Rust, fleet, mobile and declarative
package workflows are not copied into RedRouter.

## Remaining release work

1. Restore Changesets tooling and reconcile the source identity/version
   (`red-router-app@3.8.51`) with `@reddb-io/red-router` and the lockfile.
   The publisher's v0.x restamping is transitional, not the desired final flow.
2. Run the scoped CI on the exact main SHA and inspect failures. If repository
   protection requires retired job names, reconcile those required checks with the
   active jobs; local workflow edits cannot change server-side branch rules.
3. Review generated version/changelog before tagging; publish the exact checked
   tarball and verify registry availability plus clean consumer installation.
4. Measure comparable Actions runs before claiming a 50% time reduction. A narrower
   suite reduces scheduled work but does not prove a particular wall-clock saving.
