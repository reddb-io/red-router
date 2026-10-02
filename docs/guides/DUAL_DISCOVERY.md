---
title: Dual reasoning discovery
---

# Dual reasoning discovery

Select S1 from `GET /v1/models?capabilities=decision`. Each authorized decision
entry has a complete routing `id`, `capabilities.decision: true`, and
`supported_endpoints: ["systemone", "decisions"]`. These IDs remain qualified
when the tenant disables transparent models: S1 selection must bind the route
chosen by the client. Ordinary S2 discovery still follows the transparency policy.

`GET /v1/capabilities` projects the same authorized catalog. Its
`systemone.models` contains those decision IDs; `systemone.endpoint` is
`/v1/systemone`, with `/v1/decisions` as a public alias. Both invoke the same
handler. Enabled connections, explicit model activation, model visibility, key
restrictions and tenant ownership apply before discovery. Each receiving router
adds one `red/` hop and dispatch removes only that hop.

`availability: "not_probed"` distinguishes catalog membership from a successful
credentialed evaluation. Discovery does not enable models or connections. The
Router caches discovery through its unified catalog: entries are scoped by a
credential fingerprint and view, and connection, model and authorization writes
invalidate the catalog generation. Clients should test the advertised endpoint
and preserve it for subsequent evaluations.

## OpenRouter upstream contract

OpenRouter documents `POST https://openrouter.ai/api/v1/systemone` for the native
`model`, `state`, `questions` protocol, with a response containing keyed `answers`.
The separate alpha Decisions operation is documented at `/api/alpha/decisions`.
The documented System One destination remains the Router's upstream adapter;
changing the Router's public alias does not change that destination.

Official references checked on 2026-10-02:

- [System One operation](https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request)
- [Alpha Decisions operation](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request)

## Evaluation diagnostics

Failures preserve upstream HTTP status and safe retry/request-ID headers. Public
error bodies use stable `error.code` identifiers and never expose raw upstream
error text:

| Code                               | Meaning                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `systemone_credential_required`    | No credential provided to the adapter                                               |
| `systemone_credential_rejected`    | Upstream returned 401 or 403                                                        |
| `systemone_connection_unavailable` | No eligible connection selected                                                     |
| `systemone_endpoint_not_found`     | Upstream returned 405 or explicitly identified a missing route                      |
| `systemone_model_unavailable`      | Upstream explicitly identified an unavailable model                                 |
| `systemone_resource_not_found`     | Ambiguous upstream 404; insufficient evidence to distinguish route and model        |
| `systemone_transport_failure`      | Fetch failed or timed out                                                           |
| `systemone_invalid_response`       | Successful HTTP response had invalid JSON, missing answers or invalid typed answers |
| `systemone_upstream_http_error`    | Another upstream HTTP failure                                                       |

A fast 502 alone does not identify the cause. A successful evaluation requires
answers for the requested question IDs, with numeric finite Noul/Score values
and string Choice values. Noul is bounded to 0–1. Unknown question types remain
upstream-owned and retain their extension fields.
