# @reddb-io/red-router

## 0.11.2

### Patch Changes

- d237284: Keep the sidebar focused on navigation: remove the product-logo treatment, version metadata, and update banner. Move version and update controls into Settings.

## 0.11.1

### Patch Changes

- 12bb452: Use the RedDB mark consistently for the browser favicon, PWA icons, dashboard branding, and system tray.

## 0.11.0

### Minor Changes

- d5aee6f: Add RedRouter as a first-class upstream provider. A restricted machine can connect to a second RedRouter by URL and API key, discover its models, preserve remote account isolation, and reject cyclic router chains. Remove the legacy vendor signature from the sidebar.

## 0.10.0

### Minor Changes

- Harden provider routing and translation across OpenCode, Antigravity, CommandCode, Kiro, Codex, DeepSeek and OpenAI Responses. Add JEV-powered Smart combo routing through the native System One provider cascade, registry-driven OpenCode Go Responses routing, model-scoped thought signatures, strict proxy propagation, safer retry and account cooldown behavior, richer model capabilities and bounded usage overlays.

### Patch Changes

- 216c4ee: Reconnect streaming provider requests up to three times when the upstream connection closes before forwarding its first byte.

## 0.9.1

### Patch Changes

- a275528: Route JEV System One requests through stored OpenRouter credentials using its native Decisions API, with provider fallback and release-smoke coverage.

## 0.9.0

### Minor Changes

- 2625322: Make first-run setup task-first, harden empty-stream recovery, repair capability routing and restore release validation for the app and documentation. Validate JEV releases through a provider cascade instead of requiring the direct TypeSafe API.

## 0.8.1

### Patch Changes

- d0f746e: Expose native System One model discovery through `/v1/models/systemone` and classify System One catalog entries separately from generative chat models for Redcode role setup.

## 0.8.0

### Minor Changes

- 19b2554: Port of the PentatonicDev/9router fork features: external Postgres via Kysely (`DATABASE_URL` → Distributed Mode, schema created on boot, shared database across instances), per-user resource scoping (owner on accounts/keys/combos, admin gating, hidden combos, shared-account admin rules), API key ↔ account bindings (`allowedConnectionIds`) with per-key usage and rename/tags, per-user token-saver flags, canonical error contract with `503 no_active_credentials`, translator credential redaction, boot-time token refresh, quota reset-aware locking, openrouter claude-format routing and credit quota, plus a batch of translator/kiro/thinking/RTK fixes.

## 0.7.2

### Patch Changes

- 869ceaf: The OS tray icon now uses the RedDB design system mark (red chamfered square with the R glyph, rendered from the vendored favicon) at 256px with a 6-size Windows .ico — replacing the leftover pre-rebrand 9router logo shown next to the system icons.

## 0.7.1

### Patch Changes

- 8e3fb0b: Dashboard: remove the leftover 9English/9Remote sidebar entries and promo modal. The displayed version now reads the running server via /api/version (runtime truth) instead of a build-time constant, and the update checker queries the correct npm package (@reddb-io/red-router) instead of the pre-rebrand name.

## 0.7.0

### Minor Changes

- 7464ebd: Data dir moves to `~/.red/router` with the database at `~/.red/router/data.sqlite` (matching the `.red/*` ecosystem layout). One-time migration chain imports existing data from `~/.red-router` (previous layout, including the old `db/data.sqlite`) and from the official 9router origin (`~/.9router`, whose `db.json` is imported into SQLite). `DATA_DIR` env override still wins.

## 0.6.0

### Minor Changes

- 069bbd4: Headless background service + docs: `red-router service install|status|uninstall` runs the gateway under systemd --user (Linux) or launchd (macOS), surviving reboots and crashes. Services bind 127.0.0.1 by default; `--expose` (or `-H 0.0.0.0`) opens the gateway to the subnet. READMEs now teach the `npx -y @reddb-io/red-router@latest` flow.

## 0.5.2

### Patch Changes

- aed0607: Fix CLI app failing to boot from the npm package with MODULE_NOT_FOUND react/react-dom (follow-up to the @swc/helpers/@next/env fix). The standalone bundle now ships react and react-dom too, and the release boot smoke test now packs the real tarball and boots it from an isolated directory so it can no longer pass by resolving dependencies from the workspace.

## 0.5.1

### Patch Changes

- 30545ee: Fix CLI app failing to boot from the npm package (MODULE_NOT_FOUND @swc/helpers / @next/env). Next.js standalone output under pnpm misses runtime-only deps that npm traces in; the CLI build now copies them into the bundle and a boot smoke test gates every publish.

## 0.5.0

### Minor Changes

- ef0d26a: Port upstream data-safety and stream/translator robustness fixes:
  
  - **Database safety**: fail closed before any schema mutation on a corrupted SQLite database; prevent silent database wipe with startup quick_check
  - **OAuth**: parse numeric epoch expiresAt so imported connections still refresh
  - **Streams**: terminate streams that end without a finish_reason; Ollama NDJSON no longer blocked as non-SSE (VS Code chat streaming fixed); commandcode retries transient stream errors instead of emitting fake stop chunks
  - **Translator**: deduplicate/repair repeated tool call arguments; recover tool results that arrive without a call id; keep Responses tool-output images as images; stop emitting literal think tags on Claude→OpenAI; preserve optional tool parameters and function-tool strict across Responses/Codex; repair trailing assistant prefill instead of dropping it; placeholder for binary tool_result blobs; emit max_completion_tokens for gpt-5/o-series; strip output_config.format for Claude-compatible gateways; decloak tool names on claude→claude and same-format OAuth streams
  - **Claude**: drop the diagnostics body field rejected by Anthropic

## 0.4.0

### Minor Changes

- 1ff56e4: Port upstream fixes and features:
  
  - **Combos**: merge member capabilities into combo `/v1/models` entries — boolean features are unioned, numeric limits minimized, nested combos flattened; thinking levels for suffixed ids resolve through the clean model
  - **Capabilities**: OpenAI reasoning models cannot disable thinking (levels drop "none"); o-series globs no longer capture Cline's Solar Pro 4
  - **Translator**: repair tool_call_id lost by Responses clients; preserve function-tool strict across Claude/Chat routes
  - **Catalog**: register the renamed deepseek-flash id; pricing gains missing long-context tiers
  - **Dashboard**: surface why a provider connection test failed

## 0.3.0

### Minor Changes

- 68ff9aa: **Breaking**: the default port changed from `20128` (source dev: `20127`) to **`25050`**. Update clients/tools pointing at the old port, or pass `--port`/`PORT` explicitly.

## 0.2.0

### Minor Changes

- 61edd85: Expose `thinking_levels` per model and LLM combo in `/v1/models` and `/v1/models/info` (intersection across members for combos), and accept thinking-suffix overrides on combo names: `my-combo(high)` applies the level to every routed member, clamped to each member's supported levels.
