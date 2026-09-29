---
"@reddb-io/red-router": minor
---

A Claude-format client asking OpenRouter for an `anthropic/*` model is now sent to OpenRouter's Anthropic Messages endpoint as-is instead of being translated through chat/completions and back, so tool use, thinking and cache markers survive. A Docker image built from the published npm package is published to `ghcr.io/reddb-io/red-router` after a tagged release (a separate workflow, so it can never block the npm release; the version tag is pushed first and `latest` only moves after the image answers its health check).
