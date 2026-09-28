---
"@reddb-io/red-router": patch
---

Restore the RedRouter source package identity and intentional Changesets versioning.
Build and pack once in CI, verify the same tarball's contents and installed runtime,
and promote only that exact successful main commit's artifact to npm.
