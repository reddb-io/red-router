---
"@reddb-io/red-router": patch
---

Every dashboard page now opens with the design system's page heading: breadcrumbs, one H1 title, a description, and a divider below. The top bar is the design system's shell header.

- The title moved out of the top bar into the page. Before, the top bar carried an H1 and ten pages added a second one of their own.
- Usage, Skills, Translator, Proxy Pools and Add Provider drop their own headings, and their titles and descriptions move into the shared heading. Detail pages (a provider, a tool, an API key, Setup) keep their richer headings and show breadcrumbs above them.
- The top bar is a flat sunken bar with no glass blur. The pink Donate button is now a quiet ghost button.
- Toast notifications use the design system's feedback colors.
