---
"@reddb-io/red-router": patch
---

The Docker image workflow can now be run by hand for a release cut before its Dockerfile existed: it takes `Dockerfile.npm` from `main` when the tag has none. The image is still built from the published npm package.
