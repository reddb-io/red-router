---
"@reddb-io/red-router": patch
---

Bundle offline model metadata, retain canonical identity and decision taxonomy, and preserve
provider-native IDs when enriching or discovering models. Separate provider pricing and effort
metadata by deployment, discover OpenRouter decision offerings, and fence cached catalogs after
connection or authorization changes. Runtime metadata refresh uses conditional HTTP and keeps
the last committed snapshot on failure. Connections and models remain explicitly opt-in.
