---
title: "Provider redirect investigation"
status: proposed
lastUpdated: 2026-11-05
---

# Provider redirect investigation

In the RedRouter `525a71de` baseline, `BaseExecutor` validates the initial request URL
and retry URLs, but its `fetch` calls could automatically follow a redirect without
validating the destination. For local and self-hosted providers, its initial guard
returned before the cloud-metadata check. This is a code-path finding; no production
exploitation or blanket coverage of every executor is claimed.

The change guards the initial URL and each redirect on the shared BaseExecutor chat and
count-token paths, including local/self-hosted provider URLs. The TLS fingerprint
transport honors the requested redirect mode. Cross-origin redirects remove credential
headers, and a cross-origin redirect that preserves a request body is rejected because
the prompt or tool result could itself be sensitive. A same-origin 307/308 can preserve
the body; streaming bodies are not replayed. Redirect loops are bounded. This behavior
can reject an existing provider that legitimately moves POST requests to a different
origin; configure its final trusted endpoint directly instead.

The implementation is informed by [OmniRoute #19096](https://github.com/cheaper-inference/OmniRoute/commit/7c46564279a379b2f90f44b46228971e7e39970b),
with the additional cross-origin request-body restriction. Regression cases are in
`tests/redrouter/native/provider-redirect-guard.test.ts` and are intended to run in
product CI; they do not establish transport-wide security by themselves.

## Remaining security boundary

The URL guard classifies the hostname spelling. It does not establish that a hostname's
DNS answers are safe at connection time; DNS rebinding or an alias resolving to a
metadata/private address needs a connect-time guard. Proxy and TLS-impersonation
transports may resolve names remotely or use a different dispatcher. Do not claim the
new redirect loop closes those gaps. Audit other provider executors, provider-specific
fetches and all transport modes independently; test that any future connect-time guard
retains legitimate configured LAN providers and does not bypass the selected proxy.
