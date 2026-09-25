# RedRouter

[![npm](https://img.shields.io/npm/v/%40reddb-io%2Fred-router.svg)](https://www.npmjs.com/package/@reddb-io/red-router)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

RedRouter is a self-hosted gateway for AI model traffic. It exposes a single
OpenAI- and Anthropic-compatible endpoint and routes each request to the
providers and accounts you have configured, with format translation, fallback
between models and accounts, usage and cost accounting, and per-key access
control. A web dashboard manages providers, API keys, routing and usage.

It runs on your machine or your server. Credentials and usage data stay in its
local database.

## Responsible use

RedRouter does not provide access to any model. It forwards requests using the
credentials you supply, and you remain bound by each provider's terms of
service, acceptable-use policies and rate limits. That includes any
restrictions a provider places on using a subscription plan or account through
third-party tools. Connect only accounts you are authorized to use, in the way
their terms allow.

RedRouter is an independent project, not affiliated with or endorsed by any
model provider. Product and company names are trademarks of their respective
owners.

## Installation

Requires Node.js 18 or later.

```bash
npx -y @reddb-io/red-router@latest      # run without installing
npm install -g @reddb-io/red-router     # or install globally
red-router
```

The dashboard opens at `http://localhost:25050/dashboard` and the API is served
at `http://localhost:25050/v1`. Set a dashboard password on first start
(`INITIAL_PASSWORD` or Settings → Security).

### As a background service

`systemd --user` on Linux, `launchd` on macOS:

```bash
red-router service install      # listens on 127.0.0.1 only
red-router service status
red-router service uninstall
```

### Docker

A container image (`linux/amd64`) is published with each release:

```bash
docker run -d --name red-router -p 25050:25050 \
  -e INITIAL_PASSWORD='choose-a-strong-password' \
  -v red-router-data:/data \
  ghcr.io/reddb-io/red-router:latest
```

All state is stored in `/data`. A [`docker-compose.yml`](docker-compose.yml) is included.

### From source

```bash
pnpm install
pnpm dev
```

## Network access

By default the service listens on `127.0.0.1`. To accept connections from other
machines, choose **Whole network** in Settings → Network access, or run
`red-router network lan`. `red-router network local` switches back.

Before exposing RedRouter beyond your machine:

- set a strong dashboard password;
- turn on **Require API key** (Endpoint & Keys);
- issue one API key per client.

## Capabilities

- **One API, several dialects.** OpenAI Chat Completions and Responses, and
  Anthropic Messages, on the same endpoint. Requests are translated to each
  provider's native format.
- **Routing and fallback.**
  - Combos group several models under one name, with fallback, round-robin or judge-based strategies.
  - Several accounts of the same provider can back each other up.
  - Flat model ids (`vendor/model`) let RedRouter choose among the providers that serve the same model, and the order is configurable per model.
- **API keys and policy.** Per-key model rules, request and spending limits,
  bindings to specific accounts, and an admin role for keys that manage other
  keys.
- **Usage and cost.** Per-request logs, token and cost accounting by key, model
  and provider, and quota tracking for providers that report quotas.
- **Usage export.** Usage can be sent to a billing system per request or in
  5–60 minute totals per API key, by signed webhook, Amazon SQS, Kafka or a
  RedDB queue.
- **Autopilot (optional).** A small decision model can choose the combo member
  and the reasoning level for each turn. It is off by default, and a test mode
  records its decisions without applying them.
- **MCP server.** `/v1/mcp` lets agents look up the models, combos, providers,
  quotas and usage available to their API key.
- **Other endpoints.** Embeddings, images, speech, transcription, video, web
  search and fetch.

## Providers

RedRouter supports more than 40 providers. Each connects through an API key,
or through the provider's own sign-in where it offers one. Any OpenAI- or
Anthropic-compatible endpoint can also be added, including self-hosted servers
such as Ollama, LM Studio and LiteLLM, and another RedRouter instance.

## Clients

Any client that speaks the OpenAI or Anthropic API can use RedRouter by
pointing its base URL at `http://<host>:25050/v1` and authenticating with a
RedRouter API key. The dashboard includes setup steps for common coding tools
and editors.

## API

| Purpose | Endpoint |
|---|---|
| Chat | `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages` |
| Models | `GET /v1/models`, `GET /v1/models/info?id=…` |
| Media and data | `/v1/embeddings`, `/v1/images`, `/v1/audio`, `/v1/videos` |
| Web | `/v1/search`, `/v1/fetch` |
| Calling key | `GET /v1/key` |
| MCP | `POST /v1/mcp` |

Requests authenticate with `Authorization: Bearer <RedRouter API key>` (or
`x-api-key`). The optional `x-red-router-reasoning` header sets the reasoning
level for a single request (`off`, `none` … `max`, or `auto`). The level that
was applied is reported in the `X-RedRouter-Reasoning` response header.
`GET /v1/capabilities` describes what this instance accepts.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): request lifecycle, routing, authentication and data model.
- [Guides](gitbook/): setup and frequently asked questions.
- [Changelog](cli/CHANGELOG.md).

## Development

```bash
pnpm install
pnpm dev                         # dashboard and gateway
cd tests && npx vitest run       # test suite
```

Releases use [Changesets](https://github.com/changesets/changesets). A pushed
`vX.Y.Z` tag publishes the npm package and the container image.

## License

[MIT](LICENSE)
