---
"@reddb-io/red-router": minor
---

A container image now ships with every release: `ghcr.io/reddb-io/red-router:<version>` and `:latest`, for linux/amd64.

- It is built from the same npm tarball the release publishes, and runs the standalone server directly: no launcher, no tray.
- It runs as a non-root user and keeps all data in the `/data` volume.
- It listens on port 25050 and has a health check on `/api/health`.
- Set `INITIAL_PASSWORD` to choose the dashboard password.
- A `docker-compose.yml` is included.
