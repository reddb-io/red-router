# @reddb-io/red-router

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
