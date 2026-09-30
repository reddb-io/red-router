---
"@reddb-io/red-router": patch
---

Outbound proxy usernames and passwords are now encrypted at rest, like provider credentials always were (they were stored in plain text in the proxy registry, and vendor proxy usernames carry account identifiers). Nothing changes in how proxies are used or listed. On the first start with a storage key, existing proxies are encrypted once, after a managed backup of the database; without a storage key nothing changes, and a row that cannot be decrypted yields empty credentials with a warning instead of an error. The "same host, port and username" rule that merges duplicates is unchanged. The older `proxyConfig` setting and `upstream_proxy_config` may still hold plain-text proxy credentials and were not migrated.
