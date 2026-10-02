# Connections, routes and effective policies

RedRouter groups traffic configuration into three areas:

- **Connections** (`/proxy/providers`): provider accounts, credentials and destination URLs.
- **Routes** (`/dashboard/api-manager/routing`): authorized public model IDs, target order and reasoning-routing rules.
- **Policies** (`/system/settings/routing`): model visibility, provider priority and tenant delegation.

These links also appear on the Endpoints screen. Endpoints describes the client-facing protocols;
connection credentials and provider-order policies remain in their owning screens.

## Effective policy preview

`GET /api/routing/preview` is a read-only management endpoint. It accepts `apiKeyId`, `model` and
`kind=chat|decision`. The routing screen selects the key passed in its `apiKeyId` query parameter.
The model selector comes from the authorized catalog, with no fixed sample models.

The response retains `scope`, `policy`, `models`, `model`, `targets`, `note` and optional `reason`.
It adds `effectivePolicy`: setting values and their sources, selected-key model and endpoint
restrictions, and non-credential connection metadata. Each target also has `upstreamModel` and
`supportedEndpoints`. Responses use `Cache-Control: no-store`.

Model visibility and provider order resolve independently using the existing runtime resolver:
owner pins take precedence, delegated tenant choices follow, and instance defaults apply otherwise.
Key and tenant connection restrictions use the request-time metadata resolver. An empty tenant
pool retains its deny sentinel rather than turning into unrestricted access.

For chat, the upstream model uses `getModelInfo`. For decisions, it uses
`resolveSystemOneTarget`, including the existing one-hop federation behavior. The preview does
not alter model IDs, payloads, endpoints or credentials. Supported endpoints are catalog
declarations, not evidence that an upstream evaluation succeeded.

Connection entries show enabled state, a future cooldown timestamp if present, and the last
recorded connection status. They do not select a credential or certify a model as working. Provider
breakers, model lockouts, budgets, quotas, payload capabilities and live availability still
apply at dispatch. Cache and streaming rows describe key defaults; actual requests may differ
according to their headers, explicit parameters and endpoint behavior.

Changing scope or refreshing clears the displayed previous result while the replacement loads.
A failed request displays its error without retaining the previous scope's routes or connections.

## Upstream concept reference

The separation of traffic resources and reusable policy concepts was studied in Apache APISIX
`3.19.0`, commit `473043623c161966f3f6ef4e8f12d2d8667a12d2`:

- [Routes and Services](https://github.com/apache/apisix/blob/3.19.0/docs/en/latest/terminology/route.md)
- [Plugin configuration](https://github.com/apache/apisix/blob/3.19.0/docs/en/latest/terminology/plugin-config.md)
- [Configuration precedence](https://github.com/apache/apisix/blob/3.19.0/docs/en/latest/terminology/plugin.md)

This is a local RedRouter adaptation of concepts, not an APISIX plugin port. Named reusable
traffic-policy profiles, declarative configuration promotion and separate control/data-plane
deployment remain follow-up work.

Behavioral regression cases live under `tests/redrouter/native/` and `tests/redrouter/ui/`:
authorized scope, setting sources, secret-free projections, upstream ID preservation, typed
decision federation, initial key selection and removal of stale results after failure.
