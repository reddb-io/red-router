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

## Operational diagnostics

`red-router logs --path` prints the current diagnostic file without starting the
server or installing dependencies. `red-router logs --open` and **Open log** in
the tray's right-click menu launch that same file in the default application.
Opening acknowledges the OS launch; it does not wait for the editor to close.

| Platform | Current file |
| --- | --- |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/red-router/logs/red-router.log` |
| Windows | `%LOCALAPPDATA%\red-router\logs\red-router.log` |
| macOS | `~/Library/Logs/red-router/red-router.log` |

Relative/empty state-root variables are ignored; Linux falls back to
`~/.local/state`, Windows to `~/AppData/Local`. The launcher records startup,
shutdown, crashes, server stdout/stderr and tray failures. `--log` also shows
server output in the terminal; file logging does not depend on that flag.
Interactive CLI output is never copied because credential screens can display
complete API keys.

Each file is limited to **10 MiB**, with **five files total**: `red-router.log`
and `.1` through `.4` (newest backup first). Rotation runs during writing and
survives restarts. Oversized existing current/archive files are adopted as bounded
recent complete-line tails. Directories/files are private (0700/0600 on Unix); simultaneous
launchers serialize writes. Lines above 64 KiB are omitted, not split into
potentially sensitive fragments. Credentials and body/prompt fields in diagnostic
lines are redacted. Pretty JSON/payload dumps and multiline secret continuations
are omitted until a new timestamped/leveled diagnostic record; this deliberately
prefers privacy over preserving unframed debug text. Inspect logs before sharing because arbitrary upstream text
can still contain private information. A file-system error warns once on stderr
without taking down the gateway.

This contract covers the **CLI-managed operational log**, not optional request
captures (`ENABLE_REQUEST_LOGS=true`), MITM debug dumps, updater/install logs or
independently launched helper processes. Those legacy facilities retain their
existing paths/policies and can include sensitive request/response content.
They are not enabled or copied by this feature. Legacy logs at other locations
are not moved or deleted. macOS autostart no longer adds unbounded duplicate
files in `/tmp`.

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
