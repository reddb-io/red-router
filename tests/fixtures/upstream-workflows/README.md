# Historical upstream workflow fixtures

These files are not RedRouter automation. They were removed from `.github/workflows`
because they implemented upstream publication, deployment, release-branch operations,
duplicate builds or wholesale upstream test matrices.
GitHub does not execute workflows in this directory.

Some inherited regression tests still inspect these fixtures to preserve the lessons
about artifact provenance and desktop packaging. Passing those tests does **not**
validate the active RedRouter publisher. Its independent ownership checks live in
`tests/unit/redrouter-workflow-ownership.test.ts`.

The former main CI is preserved as `ci.yml`. No application capability or test
source was removed; inherited test suites no longer run in default RedRouter CI.
The active suites select our adaptations and package contracts through
`config/testing/redrouter-suites.json`, plus automatic discovery under
`tests/redrouter/{native,ui,e2e}/`. Historical static tests may need adaptation
before use against these fixtures; they are references, not release gates.
Desktop publication must return as a RedRouter-owned pipeline before it is offered
as a release channel.
