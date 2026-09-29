---
"@reddb-io/red-router": patch
---

Restore the RedCode header contract on chat answers: `X-RedRouter-Served-Model` names the provider/model that answered (after combo fallback) and `X-RedRouter-Cost-USD` carries its cost when it can be priced. Browser clients may send the `x-red-router-*` steering headers and read the answer headers.
