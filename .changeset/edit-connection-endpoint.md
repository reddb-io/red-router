---
"@reddb-io/red-router": patch
---

Editing a connection now shows and saves every field it was created with. A RedRouter connection's remote URL and an Ollama connection's host URL can be changed after creation, and so can a compatible connection's default model. Before, the edit dialog didn't show those fields at all, so the only way to change them was to delete the connection and create it again.

- A changed RedRouter URL is checked and normalized exactly like a new one (HTTP or HTTPS, `/v1` added when missing), and the remote router's model list is refreshed from the new address.
- Validating a new API key checks it against the URL in the form, not the old one.
