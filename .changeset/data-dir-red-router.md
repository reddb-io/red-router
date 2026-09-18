---
"@reddb-io/red-router": minor
---

Data dir moves to `~/.red/router` with the database at `~/.red/router/data.sqlite` (matching the `.red/*` ecosystem layout). One-time migration chain imports existing data from `~/.red-router` (previous layout, including the old `db/data.sqlite`) and from the official 9router origin (`~/.9router`, whose `db.json` is imported into SQLite). `DATA_DIR` env override still wins.
