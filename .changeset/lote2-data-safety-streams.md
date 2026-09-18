---
"@reddb-io/red-router": minor
---

Port upstream data-safety and stream/translator robustness fixes:

- **Database safety**: fail closed before any schema mutation on a corrupted SQLite database; prevent silent database wipe with startup quick_check
- **OAuth**: parse numeric epoch expiresAt so imported connections still refresh
- **Streams**: terminate streams that end without a finish_reason; Ollama NDJSON no longer blocked as non-SSE (VS Code chat streaming fixed); commandcode retries transient stream errors instead of emitting fake stop chunks
- **Translator**: deduplicate/repair repeated tool call arguments; recover tool results that arrive without a call id; keep Responses tool-output images as images; stop emitting literal think tags on Claude→OpenAI; preserve optional tool parameters and function-tool strict across Responses/Codex; repair trailing assistant prefill instead of dropping it; placeholder for binary tool_result blobs; emit max_completion_tokens for gpt-5/o-series; strip output_config.format for Claude-compatible gateways; decloak tool names on claude→claude and same-format OAuth streams
- **Claude**: drop the diagnostics body field rejected by Anthropic
