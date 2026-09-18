<div align="center">

# RedRouter CLI

**One command to run the RedRouter gateway + dashboard.**

[![npm](https://img.shields.io/npm/v/%40reddb-io%2Fred-router.svg?color=ff2056&labelColor=0d1117)](https://www.npmjs.com/package/@reddb-io/red-router)
[![Downloads](https://img.shields.io/npm/dm/%40reddb-io%2Fred-router.svg?labelColor=0d1117)](https://www.npmjs.com/package/@reddb-io/red-router)
[![license](https://img.shields.io/badge/license-MIT-blue?labelColor=0d1117)](https://github.com/reddb-io/red-router/blob/main/LICENSE)

</div>

## Install

```bash
npm install -g @reddb-io/red-router

# start the gateway
red-router
```

Dashboard opens at **http://localhost:25050/dashboard**. Or run it once without installing:

```bash
npx @reddb-io/red-router
```

## Options

| Flag | Description |
|---|---|
| `--port, -p <n>` | Custom port (default `25050`) |
| `--no-browser` | Don't open the dashboard on start |
| `--skip-update` | Skip the auto-update check |
| `--help` | Show all options |

## What you get

One OpenAI-compatible gateway (`http://localhost:25050/v1`) with 3-tier fallback (subscription → cheap → free), multi-account rotation, an RTK token saver (20-40% fewer tokens) and format translation between OpenAI, Claude and Gemini — plus the full dashboard, model combos with thinking-level suffixes, web search/fetch and a live model catalog.

See the [full README](https://github.com/reddb-io/red-router#readme) for providers, setup guides and docs.

Data lives in `~/.red-router` (Windows: `%APPDATA%/red-router`). Legacy installs migrate automatically on first run.
