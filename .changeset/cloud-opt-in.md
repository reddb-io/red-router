---
"@reddb-io/red-router": patch
---

Cloud RedRouter is off on a fresh install. It used to show as "Active" without anyone having enabled it, which contradicts the rule that nothing comes pre-approved; you now turn it on from the API Endpoint page. Installs that already saved the setting keep it as it was, and a test now pins every outward-facing feature (cloud, Tailscale, OIDC, SAML, MCP, A2A, metrics, breach checks, free sources) to off by default.
