---
"@reddb-io/red-router": minor
---

Proxy presets in Settings → Proxies: add Tor (a local SOCKS proxy on 9050 or 9150; RedRouter does not install or run Tor, and the card warns that many providers block Tor exits) or a residential gateway from Bright Data, Oxylabs, Decodo or IPRoyal by filling in a few fields, with a sticky session (one exit IP for the connection assigned to it) or a rotating one. Vendor usernames and passwords are composed for you; the vendor formats are marked unverified with a link to their docs, and the proxy can be edited afterwards. Presets are created through the same registry as any other proxy, so duplicates update the existing row and nothing is ever shown back in lists or logs.
