<div align="center">

# RedRouter CLI

**One command to run the RedRouter gateway + dashboard.**

[![npm](https://img.shields.io/npm/v/%40reddb-io%2Fred-router.svg?color=ff2056&labelColor=0d1117)](https://www.npmjs.com/package/@reddb-io/red-router)
[![Downloads](https://img.shields.io/npm/dm/%40reddb-io%2Fred-router.svg?labelColor=0d1117)](https://www.npmjs.com/package/@reddb-io/red-router)
[![license](https://img.shields.io/badge/license-MIT-blue?labelColor=0d1117)](https://github.com/reddb-io/red-router/blob/main/LICENSE)

</div>

## Install

Run it straight with npx — nothing to install:

```bash
npx -y @reddb-io/red-router@latest
```

Or install globally and start:

```bash
npm install -g @reddb-io/red-router
red-router
```

Dashboard opens at **http://localhost:25050/dashboard**.

## Service (background)

Keep the gateway always on — survives reboots and crashes (`systemd --user` on Linux, `launchd` on macOS):

```bash
red-router service install            # background, 127.0.0.1 only (safe default)
red-router service install --expose   # open to the subnet (0.0.0.0)
red-router service status
red-router service uninstall
```

Services bind **127.0.0.1 by default**. Use `--expose` (or `-H 0.0.0.0`) only when other machines need to reach the gateway — set API keys and a strong dashboard password first.

## Options

| Flag | Description |
|---|---|
| `--port, -p <n>` | Custom port (default `25050`) |
| `--host, -H <host>` | Bind address (foreground default `0.0.0.0`; services default `127.0.0.1`) |
| `--expose` | Service shorthand for `-H 0.0.0.0` (reachable from the subnet) |
| `--tray, -t` | Background mode with system tray (Windows/Linux/macOS) |
| `--no-browser` | Don't open the dashboard on start |
| `--skip-update` | Skip the auto-update check |
| `--help` | Show all options |

## What you get

One OpenAI-compatible gateway (`http://localhost:25050/v1`) with 3-tier fallback (subscription → cheap → free), multi-account rotation, an RTK token saver (20-40% fewer tokens) and format translation between OpenAI, Claude and Gemini — plus the full dashboard, model combos with thinking-level suffixes, web search/fetch and a live model catalog.

See the [full README](https://github.com/reddb-io/red-router#readme) for providers, setup guides and docs.

Data lives in `~/.red-router` (Windows: `%APPDATA%/red-router`). Legacy installs migrate automatically on first run.
