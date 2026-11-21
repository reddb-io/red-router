# Porting conventions: legacy TypeScript → `rust/red-routerd`

Rustify briefs point here. These rules describe the crate as it already exists; follow them so every batch looks like the code around it. `mappings.toml` in this folder holds the construct-level rules (async, unions, classes, maps, JSON).

## Scope

- Port server behavior only. The React UI stays TypeScript (`rust-dashboard/`); a Rust batch never renders HTML or recreates components. A UI that needs data gets a JSON endpoint.
- Port behavior by product contract, not file by file. One Rust module may replace several TS files; record that with `rustify done --rust FILE` and `--map tsName=rust::path`.
- Mark build glue, Next.js wiring and entrypoint shims with `rustify skip --reason`, and npm packages replaced by a crate with `rustify replace --with`.
- The migration ledger (`docs/architecture/RUSTIFY_MIGRATION_QUEUE.md`) chooses what to port next. Rustify orders files inside the chosen front.

## Stack

- HTTP: `axum` 0.8 with `tower`/`tower-http`. Outbound HTTP: `reqwest` with rustls; never follow redirects to arbitrary hosts without the existing guard.
- Persistence: `sqlx` for SQLite and Postgres, plus the RedDB client. New tables go through the storage layer (`storage.rs` and its `*_storage.rs` modules) for every backend, never as ad hoc SQL in handlers.
- Async: `tokio`. Keep a function async only if it awaits I/O or a timer.
- Data: `serde`/`serde_json`. Give JSON a real type at boundaries; keep `serde_json::Value` only where the legacy contract is genuinely untyped.

## Behavior and data

- Preserve the legacy wire contract (paths, status codes, JSON field names and casing, streaming format) unless the ledger records an intentional change.
- Importers and migrations are transactional: validate first, write everything in one transaction, roll back on any error.
- Refuse populated legacy fields that have no Rust contract yet, with a named error. Never drop data silently.
- Every row is tenant-scoped. Check ownership on read and write; a missing tenant is an error, not a default.
- Secrets: encrypt at rest with the existing helpers, wrap plaintext in `zeroize::Zeroizing`, never log or return them.

## Errors and tests

- Follow the surrounding module's error style; most control-plane and legacy code returns `Result<_, &'static str>` with a stable message.
- Port the TS tests that cover the batch into `rust/red-routerd/tests/` (or a colocated `#[cfg(test)]` module for pure helpers) and pass `--test` for each to `rustify done`.
- Cover the error shapes, not only the success path. Behavior that crosses the process boundary goes in `compare.toml` once it exists.
