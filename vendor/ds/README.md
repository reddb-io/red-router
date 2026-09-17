# RedDB Design System distribution

Vendored byte-for-byte from reddb-io/design-system v2026.08.5, bundle.tar.gz.
Release: https://github.com/reddb-io/design-system/releases/tag/v2026.08.5
Bundle SHA-256: f2d29e20cb7decbcd2d7cc045100d6429fb5f9c4acbf06ce9c330e4aa6003a30

Extracted from the bundle (paths inside it):

- tokens.css — packages/tokens/dist/tokens.css
- density-compact.css — packages/tokens/dist/density-compact.css
- theme-base.css — packages/theme/dist/theme-base.css
- theme-application.css — packages/theme/dist/theme-application.css
- scheme-light.css — packages/theme/dist/scheme-light.css
- scheme-dark.css — packages/theme/dist/scheme-dark.css
- favicon.svg — packages/assets/dist/platform/favicon.svg

These compiled CSS files are imported by src/app/globals.css. The theme applies
under `[data-theme="application"]` and the color scheme under
`[data-color-scheme]`; src/store/themeStore.js and the root layout pre-paint
script keep both in sync with the Tailwind `.dark` class. A bridge block in
globals.css maps the dashboard's existing `--color-*` variables onto the
vendored `--reddb-*` tokens, so existing Tailwind utilities pick up the DS
palette without touching the vendor files. The release ships Svelte Kit source,
not a compiled browser JavaScript component bundle — the dashboard keeps its
React components and adopts the DS through these styles. Font family tokens use
local fallbacks; no remote font requests are introduced.
