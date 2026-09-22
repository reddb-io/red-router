---
"@reddb-io/red-router": minor
---

Successful chat responses now carry `X-RedRouter-Served-Model` (the provider/model that answered, including the combo member) and `X-Request-Id`; non-streaming responses add `X-RedRouter-Cost-USD` when the model is priced, and OpenAI chat, Anthropic Messages and Responses streams add `usage.cost` (USD) to their final usage event. `/v1/capabilities` advertises the header names.
