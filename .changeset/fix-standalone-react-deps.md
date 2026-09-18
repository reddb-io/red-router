---
"@reddb-io/red-router": patch
---

Fix CLI app failing to boot from the npm package with MODULE_NOT_FOUND react/react-dom (follow-up to the @swc/helpers/@next/env fix). The standalone bundle now ships react and react-dom too, and the release boot smoke test now packs the real tarball and boots it from an isolated directory so it can no longer pass by resolving dependencies from the workspace.
