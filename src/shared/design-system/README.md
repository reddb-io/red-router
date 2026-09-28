# RedRouter design foundation

This is a styles-only adoption of `reddb-io/design-system` release `2026.09`.
The source and producer revisions are fixed in `design-system.manifest.json`.
`design-system.lock.json` records SHA-256 hashes of every delivered file, including
fonts and their OFL licenses. Do not format or edit `vendor/` by hand.

`scripts/dev/sync-design-system.mjs` uses the official DS producer's style planning,
writing and package-assembly functions against the pinned release. Run it with
`node --import tsx scripts/dev/sync-design-system.mjs /path/to/design-system`
from a checkout of the reviewed producer revision. Synchronization does not build
the DS. Normal RedRouter CI/build/install needs no sibling checkout or DS network fetch.

The manifest intentionally routes no Kits or Layers. The delivered package has
no runtime dependencies: React imports CSS directly, not Svelte components.
`bridge.css` temporarily maps existing RedRouter tokens to canonical DS roles.
The root selects the Application Theme, comfortable Density and the persisted
light/dark Color Scheme. White-label overrides remain supported.

This is not complete component adoption. Existing React controls, hard-coded
screen styles, Material Symbols and provider logos remain separate. Provider
icons are compiled from the build-only `@lobehub/icons` dependency; their unused
UI peers must not be installed by a production consumer. Moving those logos to
a licensed static catalog and introducing canonical React components are later work.
