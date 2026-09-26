---
"@reddb-io/red-router": minor
---

**White label from one JSON file.** A `branding.json` changes RedRouter's visual identity: the name and logo (sidebar and browser tab), the favicon, the login screen (title, subtitle, logo, background, footer) and the theme (accent colour, corner radius, font, default colour scheme, and any design-system colour token for light and dark). Everything else works as before.

- **Where the file lives:** `branding.json` in the data folder (or the path in `RED_ROUTER_BRANDING`). You can also paste the JSON into Settings → Branding, which validates it and applies it.
- **Images:** an https URL, a base64 `data:image` URI, or a file placed next to the JSON.
- **Validation:** unknown or unsafe values (anything that could escape the stylesheet or the branding folder) are reported and ignored, and the rest still applies.
