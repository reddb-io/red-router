---
"@reddb-io/red-router": patch
---

No page shows two tab bars for the same thing any more. The Usage page dropped its own tab strip: Combo health, Utilization, Search, Evals, plus the new Cache health and Route trace pages are routes listed as tabs by the menu (rarely used ones under "More"), and old `?tab=` links redirect to them. MCP and A2A are tabs inside the Endpoint page, so the menu no longer lists them as separate tabs (their own addresses still open the Endpoint page's tab).
