---
"@reddb-io/red-router": minor
---

The provider page has a Settings button at the top right, and a settings panel right under the header.

- **One place to configure.** The panel lists each connection with its destination, group tag, routing tags and excluded models, marked Custom or Default, with an Edit button per connection. For a custom provider it also shows the provider's own name, prefix and base URL with an Edit provider button (that card used to sit at the very bottom of the page). It opens by itself for a custom provider or when something was changed.
- **Back to the initial settings.** "Reset to defaults" removes a connection's overrides (destination, group tag, routing tags, excluded models) after showing exactly what will change. API keys, credentials and settings a provider needs to work are never touched, and a provider with no built-in host cannot be reset to nothing.
- **API.** `PUT /api/providers/:id` accepts `null` for `baseUrl`, `tag`, `tags` and `excludedModels` in `providerSpecificData` to clear that override (before, an invalid `baseUrl: null` was refused and a cleared field could not be saved).
