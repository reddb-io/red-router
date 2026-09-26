---
"@reddb-io/red-router": patch
---

OpenAI API conformance. Every `/v1` answer now matches OpenAI's own OpenAPI schemas, which are now checked in CI.

- **`/v1/models`:** entries carry the required `created`, a combo's creation time and a fixed value for everything else, so the catalog version stays stable.
- **Error bodies:** every `/v1` error has `param` and `code`.
- **Chat Completions answers translated from Claude, Gemini and other upstreams:** the JSON answer now has `logprobs`, `refusal`, and `content: null` on a tool-call message, and the stream now ends with `data: [DONE]`. Clients that wait for that sentinel no longer hang until the connection closes.
- **Responses API JSON answers:** they now echo the request settings OpenAI requires (`instructions`, `tools`, `tool_choice`, `parallel_tool_calls`, `temperature`, `top_p`, `metadata`), set `error` and `incomplete_details`, give every output item an `id` and `status`, and include the usage detail blocks.
