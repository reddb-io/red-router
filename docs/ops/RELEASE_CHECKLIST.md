---
title: "RedRouter release checklist"
version: 3.8.51
lastUpdated: 2026-09-28
---

# RedRouter release checklist

This checklist belongs to `reddb-io/red-router`, not OmniRoute. The npm package is
`@reddb-io/red-router`, and `red-router` is the command. Develop on main, preserve
upstream attribution, and do not deploy or publish another project's package.

The workflow cleanup and source-version/Changesets blockers are recorded in
[the workflow review](./REDROUTER_WORKFLOW_REVIEW.md). They are not resolved merely
because an earlier publication succeeded.

## Prepare an intentional version

- [ ] Include Changesets describing user-visible changes and their compatibility limits.
- [ ] Restore the Changesets CLI/configuration and reconcile the published package's
      source name/version with the lockfile. Verify workspace targeting.
- [ ] Review the generated version and changelog. Do not choose or silently bump
      the release version inside the publisher.
- [ ] Keep all release code on main; do not recreate upstream release branches.
- [ ] Confirm package, tag, artifact and application version agree.
- [ ] Preserve existing organization release/npm credentials; do not copy upstream secrets.

## Validate in GitHub Actions

Do not run local tests/builds for this recovery. CI is the validation environment.

- [ ] The latest main push CI run for the exact release SHA completed successfully.
- [ ] Native unit tests and Vitest both passed; neither substitutes for the other.
- [ ] Lint, applicable typechecks, security checks and DB/integration regressions passed.
- [ ] Changes to dashboard workflows have corresponding UI checks.
- [ ] Changed documentation passed `npm run check:docs-all` in CI.
- [ ] Coverage percentages are diagnostic only, not a merge/release requirement.
- [ ] Record credentialed provider smoke separately from fixtures and mocks.

## Build and publish one artifact

`.github/workflows/red-publish.yml` is the sole active npm publisher. It builds
a selected v0.x tag that belongs to main, checks the exact SHA's main CI result,
and restricts publication to this repository.

- [ ] `npm run build:release` succeeds in Actions.
- [ ] `npm run check:pack-artifact` and `npm run check:pack-boot` pass.
- [ ] Preserve the full dashboard and required native/runtime files in the tarball.
- [ ] Publish the exact checked tarball, verifying SHA256SUMS across jobs.
- [ ] Keep npm provenance on the GitHub-hosted publishing job.
- [ ] Use the configured token or OIDC mode for this repository/package.
- [ ] Confirm npm version/tarball availability after upload; processing is not propagation.
- [ ] Verify registry integrity and a clean installed-package smoke.
- [ ] Attach the verified tarball and checksum to the matching GitHub release.

The current source-identity restamping in the publisher is a transitional mechanism,
not the desired Changesets flow. Replace it with a version-agreement assertion
after source identity and tooling are reconciled. Do not claim that work is complete.

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
