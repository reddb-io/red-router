---
"@reddb-io/red-router": patch
---

Keep `tool_choice: "none"` and parallel-tool-call limits across OpenAI↔Claude translation, honor the requested JEV model before a System One provider's default, report usage on Responses `response.completed` so Codex can auto-compact, and stop replaying reasoning fields to Groq, Mistral, and Cerebras.
