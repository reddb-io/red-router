---
"@reddb-io/red-router": patch
---

Model names in `/v1/models` now read the same whichever provider serves them: vendor prefixes copied from OpenRouter ("Z.ai: GLM 5.3") are dropped and names that are just ids ("z-ai/glm-5.3-flash") are humanized. Ids and routing are unchanged.
