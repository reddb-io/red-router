---
"@reddb-io/red-router": patch
---

The forgot-password page and the Google sign-in helper hint now show `npx @reddb-io/red-router …`. The unscoped `npx red-router` in those hints failed with an npm 404 because that package name is not published.
