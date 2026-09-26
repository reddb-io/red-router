---
"@reddb-io/red-router": patch
---

Provider fixes.

- **Kiro IDC.** IDC accounts find their profile again, in their own AWS region. The old lookup used a retired endpoint pinned to us-east-1, which failed with "profileArn is required".
- **Proxy relay.** Relay and DNS-bypass requests no longer drop request headers (auth, content type) when they arrive as a `Headers` object.
- **DNS bypass.** The bypass for MITM-intercepted hosts runs only when the system DNS actually redirects the host to a local address. The Google DNS lookup has a 2 s timeout, the bypass connection a 10 s connect timeout, and any failure falls back to a normal fetch. This fixes hangs on networks that block 8.8.8.8 or use split-horizon DNS.
- **Cline.** Cline and ClinePass now always stream, and the older `{data:{choices}}` reply shape is unwrapped.
- **Xiaomi MiMo.**
  - The retired `mimo-x-*-preview` models are replaced by `mimo-v2.6-pro`, `mimo-v2.6-flash` and `mimo-v2.6-pro-ultraspeed`, served through the account route.
  - The old preview ids still work: they map to their v2.6 successors.
