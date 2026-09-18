<div align="center">

<img src="./images/red-router.png" alt="RedRouter" width="560" />

# RedRouter · `rtr`

**One local gateway. Every model. Zero wasted tokens.**

[![npm](https://img.shields.io/npm/v/%40reddb-io%2Fred-router.svg?color=ff2056&labelColor=0d1117)](https://www.npmjs.com/package/@reddb-io/red-router)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen?labelColor=0d1117)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue?labelColor=0d1117)](LICENSE)

[Quick Start](#-quick-start) · [Features](#-features) · [Models & Combos](#-models--combos) · [API](#-api) · [Docs](#-docs)

<img src="./images/fusion-combo-ui.png" alt="RedRouter dashboard" width="760" />

</div>

---

RedRouter runs one **OpenAI-compatible gateway** at `http://localhost:25050/v1` and routes every request across **40+ providers** — subscription quotas first, cheap APIs next, free models last — translating between OpenAI, Claude, Gemini and friends on the fly. Your tools never notice. Your wallet does.

## ⚡ Quick Start

Run it straight with npx — nothing to install:

```bash
npx -y @reddb-io/red-router@latest
```

Or install globally:

```bash
npm install -g @reddb-io/red-router
red-router
```

Open **http://localhost:25050/dashboard**, connect a provider (OAuth or API key), then point any tool at the gateway:

```bash
# OpenAI-style clients (Codex, Cline, OpenClaw, …)
export OPENAI_BASE_URL=http://localhost:25050
```

Claude Code, Codex, Copilot and other OAuth tools connect straight from the dashboard — no env vars, tokens refresh automatically.

### Run it always (background service)

Keep the gateway running across reboots and crashes — `systemd --user` on Linux, `launchd` on macOS:

```bash
npx -y @reddb-io/red-router@latest service install          # background, 127.0.0.1 only (safe default)
npx -y @reddb-io/red-router@latest service install --expose # open to the subnet (0.0.0.0)
npx -y @reddb-io/red-router@latest service status
npx -y @reddb-io/red-router@latest service uninstall
```

Services bind **127.0.0.1 by default**. Use `--expose` (or `-H 0.0.0.0`) only when other machines on your network need to reach it — set API keys and a strong dashboard password first. On Windows, run `red-router -t` for tray-background mode.

Run from source instead:

```bash
pnpm install && pnpm dev
```

## 🧠 Features

| | |
|---|---|
| **Smart 3-tier fallback** | Subscription → cheap → free, zero downtime. Multi-account round-robin per provider. |
| **RTK token saver** | Compresses tool results in place — 20-40% fewer tokens per request. |
| **Format translation** | OpenAI ↔ Claude ↔ Gemini ↔ Kiro/Cursor/Vertex, with direct routes for fragile shapes (thinking blocks, tool ids). |
| **Combos** | Unlimited model chains with `fallback`, `round-robin` and `fusion` (judge-model) strategies. |
| **Thinking levels** | `glm-5.3(high)`, `model(8192)`, even `my-combo(high)` — the level follows the rotation and is clamped to each member. |
| **Live catalog** | `/v1/models` publishes `context_length`, `max_completion_tokens`, `thinking_levels` and capabilities per model — synced daily from models.dev. |
| **And everything else** | Web search & fetch, images, TTS/STT, embeddings, video; auto token refresh; real-time quota tracking; usage analytics; cloud sync. |

## 🛠️ Works With

Claude Code · Codex · Cursor · OpenCode · Cline · OpenClaw · GitHub Copilot · Gemini CLI · Antigravity · Zed · Windsurf · Trae · Qoder · Kilo · iFlow · Devin — **any OpenAI- or Claude-compatible client**.

## 🌐 Providers

40+ in three tiers:

- **Subscription** — Claude Pro/Max, Codex Plus/Pro, GitHub Copilot, Kiro, Antigravity, Qoder, OpenCode Go…
- **Cheap** — GLM (~$0.6/1M), MiniMax (~$0.2/1M), Kimi, Qwen, DeepSeek…
- **Free** — OpenCode Free, Vertex AI ($300 credits), Kiro free tier, free-model gateways — plus self-hosted (Ollama, LM Studio, LiteLLM).

## 📡 API

One endpoint, your client's dialect:

| Client sends | Route |
|---|---|
| OpenAI chat | `POST /v1/chat/completions` · `POST /v1/responses` |
| Claude | `POST /v1/messages` |
| Media | `/v1/images` · `/v1/audio` · `/v1/embeddings` · `/v1/videos` |
| Web | `/v1/search` · `/v1/fetch` |
| Catalog | `GET /v1/models` · `GET /v1/models/info?id=…` · `GET /v1/models/{image,tts,stt,embedding,web}` |

## 📚 Docs

- **Architecture** — [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): request lifecycle, fallback, OAuth, data model
- **Setup guides & FAQ** — [`gitbook/`](gitbook/) (deployed to GitHub Pages)
- **Releases** — [`CHANGELOG.md`](CHANGELOG.md)

## 🛠️ Development

```bash
pnpm install
pnpm dev                    # dashboard + gateway
cd tests && npx vitest run  # test suite
```

Releases follow [Changesets](https://github.com/changesets/changesets): `pnpm changeset` → `pnpm release:version` → tag `vX.Y.Z`; the npm publish is automated on tags.

## License

[MIT](LICENSE)
