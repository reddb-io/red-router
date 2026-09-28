# Historical upstream workflow fixtures

These files are not RedRouter automation. They were removed from `.github/workflows`
because they implemented upstream publication, deployment or release-branch operations.
GitHub does not execute workflows in this directory.

Some inherited regression tests still inspect these fixtures to preserve the lessons
about artifact provenance and desktop packaging. Passing those tests does **not**
validate the active RedRouter publisher. Its independent ownership checks live in
`tests/unit/redrouter-workflow-ownership.test.ts`.

No upstream application capability or test suite was removed with these workflows.
Desktop publication must return as a RedRouter-owned pipeline before it is offered
as a release channel.
