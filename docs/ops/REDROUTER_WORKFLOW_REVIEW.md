---
title: "RedRouter workflow ownership review"
version: 3.8.51
lastUpdated: 2026-09-28
---

# RedRouter workflow ownership review

Scope: local inspection of all 28 workflow files present before cleanup. This is
a structural ownership review, not a successful Actions run or a timing benchmark.
Changes in this checkout have not been pushed or executed by CI.

RedRouter is `reddb-io/red-router`, publishing `@reddb-io/red-router`. Upstream source
inheritance does not transfer another project's operational workflows or credentials.
Versioning must use Changesets; publishing on every main push is not the release policy.

## Reference patterns

The sibling repositories were inspected read-only:

- `dit/.github/workflows/release.yml`: tagged-tree version validation, build artifacts,
  release planning. Its Rust/release-plz workflow is not our npm implementation.
- `redskilled/.github/workflows/red-release.yml` and `red-publish.yml`: separate
  version preparation from publishing, use the existing release credentials, verify
  exact artifacts and the registry. Its fleet/plugin/mobile jobs are not copied.
- `red-skills/.github/workflows/red-workspace-ci.yml`: keep CI specific to the repository's
  actual deliverable; a declarative skills repository is not a router package.

## Disposition of every original workflow

| Workflow                    | Disposition and reason                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `red-publish.yml`           | Keep as sole npm publisher. Added repository ownership and exact tagged-SHA/main CI gates. Source-version alignment, Changesets wiring and registry smoke still pending.  |
| `ci.yml`                    | Keep native tests, Vitest, integration, security, package checks and build. Target main only. Review duplicated gates and upstream runners before optimizing.             |
| `api-route-typecheck.yml`   | Keep its API-specific diagnostic regression check; reconcile remaining release-branch trigger.                                                                            |
| `build.yml`                 | Manual build retained pending consolidation with main CI.                                                                                                                 |
| `quality.yml`               | Release-branch-only automation remains pending consolidation; do not delete unique gates without mapping them to main CI.                                                 |
| `release-acceptance.yml`    | Shadow fixture-based acceptance, not release evidence. Pending removal or integration into CI.                                                                            |
| `docker-publish.yml`        | Separate inherited container channel remains pending replacement or retirement; no RedRouter Docker publishing claim.                                                     |
| `opencode-provider-ci.yml`  | Keep tests for included integration code; remove obsolete release branch and review runtime matrix. No separate package publishing authority.                             |
| `opencode-plugin-ci.yml`    | Keep integration tests/builds; reconcile main-only triggers. No separate package publishing authority.                                                                    |
| `codeql.yml`                | Keep security analysis; review activation and duplication.                                                                                                                |
| `semgrep.yml`               | Keep security analysis; reconcile main-only triggers.                                                                                                                     |
| `scorecard.yml`             | Keep supply-chain analysis; reconcile main-only triggers.                                                                                                                 |
| `dast-smoke.yml`            | Keep dynamic security smoke; review overlap/build reuse.                                                                                                                  |
| `nightly-compat.yml`        | Keep runtime compatibility coverage; replace highest-upstream-release selection with main.                                                                                |
| `nightly-llm-security.yml`  | Keep prompt/security checks pending relevance and runner review.                                                                                                          |
| `nightly-property.yml`      | Keep randomized properties; these are not coverage-percentage gates.                                                                                                      |
| `nightly-resilience.yml`    | Keep resilience checks pending cost, runtime and overlap review.                                                                                                          |
| `nightly-schemathesis.yml`  | Keep protocol fuzzing pending schema/runner review.                                                                                                                       |
| `nightly-mutation.yml`      | Pending cost/benefit review; not a RedRouter release requirement.                                                                                                         |
| `mutation-redundancy.yml`   | Manual diagnostic retained pending consolidation, not a release requirement.                                                                                              |
| `npm-publish.yml`           | Removed from active workflows: duplicate upstream npm and plugin publishing.                                                                                              |
| `electron-release.yml`      | Removed from active workflows: upstream desktop release and second npm publishing entry. Application code remains; rebuild a RedRouter-owned desktop pipeline separately. |
| `deploy-vps.yml`            | Removed: explicitly installed `omniroute@latest` and managed an OmniRoute PM2 deployment.                                                                                 |
| `lock-released-branch.yml`  | Removed: changes repository branch protection for the upstream release-branch lifecycle, incompatible with main-only development.                                         |
| `nightly-release-green.yml` | Removed: upstream release-branch selection and maintenance, overlapping main CI.                                                                                          |
| `radar-export.yml`          | Removed: publishes an upstream Radar service's rolling release asset.                                                                                                     |
| `wiki-sync.yml`             | Removed: would republish upstream product documentation to our wiki.                                                                                                      |
| `claude.yml`                | Removed: inherited agent automation requiring its own OAuth credential; not part of RedRouter release/CI.                                                                 |

Removed workflow files are recoverable under `tests/fixtures/upstream-workflows/`.
Inherited static regression tests read those historical fixtures. They do not
substitute for tests of `red-publish.yml`; independent checks are in
`tests/unit/redrouter-workflow-ownership.test.ts`. No runtime feature was deleted.

## Remaining release blockers

1. The root manifest currently identifies `red-router-app@3.8.51`; the published
   identity is `@reddb-io/red-router`. The publisher currently restamps it from a
   v0.x tag. Reconcile source identity/version and lockfile before removing this bridge.
2. Pending Changesets target `@reddb-io/red-router`, but CLI/configuration were lost
   in the base replacement. Installing the pinned CLI offline failed with
   `ENOTCACHED`; no dependency or lockfile update was applied. Restore actual
   Changesets tooling, verify its published-package/workspace targeting, and review
   generated changelog/version changes before tagging. Do not invent a bump in CI.
3. Complete the pending dispositions above, including the inherited Docker channel,
   obsolete branch selectors and runner labels. Do not assume an upstream VPS exists here.
4. Run RedRouter CI on the exact main SHA. Unit and Vitest suites are non-overlapping
   and both required; coverage percentages are not a release requirement.
5. Check tag/source/package version agreement, verify packed boot and checksums,
   then publish the exact tarball. Verify npm propagation, registry integrity and a
   clean installed-package smoke before calling the release usable.

Do not claim a 50% build-time reduction without measured comparable runs. Preserve
test coverage of behavior; remove duplicated builds, obsolete automation and
unnecessary serialization first. Do not disable tests to hide integration regressions.
