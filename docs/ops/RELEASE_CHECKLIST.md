---
title: "RedRouter release checklist"
version: 0.34.1
lastUpdated: 2026-09-28
---

# RedRouter release checklist

This checklist belongs to `reddb-io/red-router`, not RedRouter. The npm package is
`@reddb-io/red-router`, and `red-router` is the command. Develop on main, preserve
upstream attribution, and do not deploy or publish another project's package.

The workflow design and remaining validation work are recorded in
[the workflow review](./REDROUTER_WORKFLOW_REVIEW.md).

## Prepare an intentional version

- [ ] Include Changesets describing user-visible changes and their compatibility limits.
- [ ] Run `npm run release:status` to review pending Changesets, then
      `npm run release:version` when preparing a release.
- [ ] Review the root package/lockfile version and generated changelog together.
      The adapter uses the pinned official Changesets CLI in an isolated single-package
      workspace because npm workspace discovery excludes the root deliverable.
      It does not version the private upstream engine/browser packages.
- [ ] Review the generated version and changelog. Do not choose or silently bump
      the release version inside the publisher.
- [ ] Keep all release code on main; do not recreate upstream release branches.
- [ ] Confirm package, tag, artifact and application version agree.
- [ ] Preserve existing organization release/npm credentials; do not copy upstream secrets.

## Validate in GitHub Actions

Do not run local tests/builds for this recovery. CI is the validation environment.

- [ ] The single RedRouter workflow completed successfully for the release tag.
- [ ] Selected RedRouter native and UI suites both passed; neither substitutes for the other.
- [ ] Product lint/typechecks, blocking security checks and selected integration regressions passed.
- [ ] Changes to dashboard workflows have corresponding UI checks.
- [ ] Review changed product documentation against the implementation; inherited docs ratchets are opt-in.
- [ ] Upstream wholesale suites are not release gates; new product tests are discovered under
      `tests/redrouter/{native,ui,e2e}/`, with existing contracts selected in
      `config/testing/redrouter-suites.json`.
- [ ] Coverage percentages are diagnostic only, not a merge/release requirement.
- [ ] Record credentialed provider smoke separately from fixtures and mocks.

## Build and publish one artifact

`.github/workflows/red-publish.yml` is the sole active npm publisher. It resolves
a selected SemVer tag on main, runs the same product checks used for pull requests,
builds and packs once, then passes that run's tested artifact directly to the release
job. The release job never rebuilds, repacks or changes the package identity.

- [ ] `npm run build:release` succeeds in Actions.
- [ ] CI runs `npm run release:pack` once. The content and boot checks both consume
      that tarball through `REDROUTER_RELEASE_ARTIFACT_DIR=release-artifacts`.
- [ ] `npm run check:pack-artifact` and `npm run check:pack-boot` pass.
- [ ] Preserve the full dashboard and required native/runtime files in the tarball.
- [ ] Publish the exact checked tarball, verifying SHA256SUMS across jobs.
- [ ] Keep npm provenance on the GitHub-hosted publishing job.
- [ ] Keep npm trusted publishing configured for `red-publish.yml` and the
      `npm-release` environment.
- [ ] Confirm npm version/tarball availability after upload; processing is not propagation.
- [ ] Verify registry integrity and a clean installed-package smoke.
- [ ] Attach the verified tarball and checksum to the matching GitHub release.

Tag runs retain release artifacts for 14 days, named by workflow run and attempt.
The release job rejects mismatched package/tag versions, source/run metadata,
checksums and tarball manifests. Rerun the complete tag workflow if its artifact
has expired or was not produced.

Source identity is `@reddb-io/red-router@0.34.1`. Pending Changesets must produce
the next intentional version before tagging. Do not move or recreate existing
published tags.

The CLI is pinned to `@changesets/cli@3.0.3` through npm exec, not installed as a
production dependency. It needs registry access on the first invocation. CI checks
real root-versioning behavior in a temporary fixture and reports pending changes.
There are no scheduled workflows or automatic version commits.

## Product acceptance

- [ ] Verify RedRouter setup, providers, combos, keys, model discovery and usage.
- [ ] Verify installed command, service ownership, port and data paths against the
      intended RedRouter contract, not upstream defaults.
- [ ] Check old client contracts and explicitly document remaining incompatibilities.
- [ ] Verify remote catalogs cannot cross credential/account boundaries.
- [ ] Keep JEV/System One separate from ordinary chat.
- [ ] Do not report complete upstream parity from route/provider counts.

## Rollback and recovery

Preserve existing tags and published versions. Prefer a corrective patch release
and, when appropriate, deprecating a broken npm version with a clear replacement.
Never delete user data, rewrite published tags, reset a dirty checkout, or change
a deployment merely to make a release checklist pass. Application/container/desktop
deployment channels need their own RedRouter-owned validation and authorization.
