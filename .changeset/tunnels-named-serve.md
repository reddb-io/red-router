---
"@reddb-io/red-router": minor
---

Two new tunnels on the API Endpoint page, grouped as Private and Public. Tailscale Serve is private: it publishes the endpoint only to devices on your tailnet (`https://<machine>.<tailnet>.ts.net`), and turning it off removes only that mapping, never the rest of your Tailscale config. Cloudflare Named Tunnel gives a stable URL on your own domain: paste the tunnel token and the public hostname you mapped in Cloudflare Zero Trust. The token is passed to cloudflared through its environment (never the command line), stored encrypted, and never returned by any API. Both are managed only from the machine running RedRouter, need a management session, and are audited. The card says whether API keys are required (they are only when REQUIRE_API_KEY is on), the Funnel row is now labelled Public, and Serve refuses to start while Funnel is publishing the same port. Nothing was tested against a live Cloudflare or Tailscale account.
