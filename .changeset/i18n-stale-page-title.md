---
"@reddb-io/red-router": patch
---

Fixed the page title staying on the first page you opened (for example "Quota Tracker" while you were on Combos). The in-page translator remembered the first text it saw in each element, and when React reused that element for a new page, it put the old text back. It now treats text that React changes as new text, which also fixes any other label React updates in place.
