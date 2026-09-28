---
"@reddb-io/red-router": patch
---

Adopt the pinned RedDB design-system application colors and self-hosted fonts in
the existing React dashboard, preserving light/dark preferences and custom branding.
Keep provider icons in the build instead of the installed production dependency
tree, avoiding their unused UI peer-dependency chain. Component Kit adoption is
still pending; this change does not introduce a Svelte runtime.
