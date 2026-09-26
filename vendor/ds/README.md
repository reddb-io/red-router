# RedDB Design System distribution

Vendored byte-for-byte from reddb-io/design-system v2026.09, bundle.tar.gz.
Release: https://github.com/reddb-io/design-system/releases/tag/v2026.09
Bundle SHA-256: cef1be704aa74aa921dd1bcfdf307b32840bf6d90bee4aa0f3e302ed0f6ebea9

Extracted from the bundle (paths inside it):

- tokens.css — packages/tokens/dist/tokens.css
- density-compact.css — packages/tokens/dist/density-compact.css
- theme-base.css — packages/theme/dist/theme-base.css
- theme-application.css — packages/theme/dist/theme-application.css
- theme.css — packages/theme/dist/theme.css (Tailwind 4 `@theme` surface: palette, radius, shadow, spacing, type and motion utilities resolve to `--reddb-*` tokens)
- scheme-light.css — packages/theme/dist/scheme-light.css
- scheme-dark.css — packages/theme/dist/scheme-dark.css
- favicon.svg — packages/assets/dist/platform/favicon.svg
- kits/base/{button,card,badge,breadcrumbs,input,select}.variants.ts — kits/base/dist/src/
- kits/app/{page-heading,application-shell}.variants.ts — kits/app/dist/src/composites/
- kits/app/nav-item.variants.ts — kits/app/dist/src/primitives/
  (the DS appearance contracts: `tailwind-variants` definitions with no Svelte in them)

The dashboard is plain JavaScript, so `node scripts/sync-ds-variants.mjs`
strips the TypeScript syntax from `kits/{base,app}/*.variants.ts` into
`src/shared/ds/*.variants.js`. The React primitives in `src/shared/components`
(Button, Card, Badge, Breadcrumbs, PageHeading, and the Header's shell bar)
render those contracts, so their appearance comes from
the DS rather than from local class lists. `tests/unit/ds-variants-sync.test.js`
fails when a generated file drifts from its vendored source.

These compiled CSS files are imported by src/app/globals.css. The theme applies
under `[data-theme="application"]` and the color scheme under
`[data-color-scheme]`; src/store/themeStore.js and the root layout pre-paint
script keep both in sync with the Tailwind `.dark` class. The density applies
under `[data-density="compact"]`, set on the root element in src/app/layout.js.
theme.css is imported before the dashboard's own `@theme inline` block, so the
dashboard's font and border bridges keep precedence. A bridge block in
globals.css maps the dashboard's existing `--color-*` variables onto the
vendored `--reddb-*` tokens, so existing Tailwind utilities pick up the DS
palette without touching the vendor files. The release ships Svelte Kit source,
not a compiled browser JavaScript component bundle — the dashboard keeps its
React components and adopts the DS through these styles. Font family tokens use
local fallbacks; no remote font requests are introduced.
