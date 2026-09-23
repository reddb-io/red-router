---
"@reddb-io/red-router": patch
---

Failures that arrive with HTTP 200 now fall back like any other error. A stream is read ahead (up to 15 s, `STREAM_READ_AHEAD_MS`) until its first event that carries an answer. An error event, an overloaded or quota message, `choices: null`, a role-only stream that ends, or a failing `finish_reason` (such as GLM's `model_context_window_exceeded`) becomes an error before the client sees the 200. The next account or combo member is then tried. Non-streaming bodies get the same check. While the upstream is silent, SSE clients get a `: keepalive` comment every 15 s (`STREAM_KEEPALIVE_MS`, 0 turns it off). When a client disconnects mid-stream, the tokens streamed so far are still recorded, and the request detail is marked `aborted`.
