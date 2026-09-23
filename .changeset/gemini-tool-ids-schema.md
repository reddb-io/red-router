---
"@reddb-io/red-router": patch
---

Gemini, Gemini CLI, Vertex and Antigravity fixes.

- **Reused tool-call ids.** A client that reuses a tool-call id across turns no longer breaks the request. Each result is paired with its own call, and a repeated id is sent to Gemini as `<id>#<n>`. Before, every earlier turn got the last turn's result and name, and Gemini rejected the request.
- **`errorMessage` in tool schemas.** It is now removed from tool schemas, where Gemini rejected it with "Unknown name errorMessage".
- **Parameters named like schema keywords.** Tool parameters named `title`, `format`, `default` or `errorMessage` are no longer deleted as if they were schema keywords.
