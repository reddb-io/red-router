# RedRouter - FREE AI Router & Token Saver

**Never stop coding. Save 20-40% tokens with RTK + auto-fallback to FREE & cheap AI models.**

**Connect All AI Code Tools (Claude Code, Cursor, Antigravity, Copilot, Codex, Gemini, OpenCode, Cline, OpenClaw...) to 40+ AI Providers & 100+ Models.**

[![npm](https://img.shields.io/npm/v/%40reddb-io%2Fred-router.svg)](https://www.npmjs.com/package/@reddb-io/red-router)
[![Downloads](https://img.shields.io/npm/dm/%40reddb-io%2Fred-router.svg)](https://www.npmjs.com/package/@reddb-io/red-router)
[![GHCR](https://img.shields.io/badge/GHCR-reddb-io%2Fred-router-blue?logo=github)](https://github.com/reddb-io/red-router/pkgs/container/red-router)
[![License](https://img.shields.io/npm/l/%40reddb-io%2Fred-router.svg)](https://github.com/reddb-io/red-router/blob/main/LICENSE)


[🌐 Website](https://github.com/reddb-io/red-router) • [📖 Full Docs](https://github.com/reddb-io/red-router)

---

## 🤔 Why RedRouter?

**Stop wasting money, tokens and hitting limits:**

- ❌ Subscription quota expires unused every month
- ❌ Rate limits stop you mid-coding
- ❌ Tool outputs (git diff, grep, ls...) burn tokens fast
- ❌ Expensive APIs ($20-50/month per provider)

**RedRouter solves this:**

- ✅ **RTK Token Saver** - Auto-compress tool_result, save 20-40% tokens
- ✅ **Maximize subscriptions** - Track quota, use every bit before reset
- ✅ **Auto fallback** - Subscription → Cheap → Free, zero downtime
- ✅ **Multi-account** - Round-robin between accounts per provider
- ✅ **Universal** - Works with any OpenAI/Claude-compatible CLI

---

## ⚡ Quick Start

**Option 1 — npm (recommended for desktop):**

```bash
npm install -g @reddb-io/red-router
red-router

# Or run directly with npx
npx @reddb-io/red-router
```

**Option 2 — Docker (server/VPS):**

```bash
docker run -d --name red-router -p 20128:20128 \
  -v "$HOME/.red-router:/app/data" -e DATA_DIR=/app/data \
  ghcr.io/reddb-io/red-router:latest
```

Published images: [Docker Hub](https://github.com/reddb-io/red-router/pkgs/container/red-router) • [GHCR](https://github.com/reddb-io/red-router/pkgs/container/red-router) (multi-platform amd64/arm64).

🎉 Dashboard opens at `http://localhost:20128`

**2. Connect a FREE provider (no signup needed):**

Dashboard → Providers → Connect **Kiro AI** (free Claude unlimited) or **OpenCode Free** (no auth) → Done!

**3. Use in your CLI tool:**

```
Claude Code/Codex/OpenClaw/Cursor/Cline Settings:
  Endpoint: http://localhost:20128/v1
  API Key:  [copy from dashboard]
  Model:    kr/claude-sonnet-4.5
```

That's it! Start coding with FREE AI models.

---

## 🚀 CLI Options

```bash
red-router                    # Start with default settings
red-router --port 8080        # Custom port
red-router --no-browser       # Don't open browser
red-router --skip-update      # Skip auto-update check
red-router --help             # Show all options
```

**Dashboard**: `http://localhost:20128/dashboard`

---

## 🛠️ Supported CLI Tools

Claude-Code • OpenClaw • Codex • OpenCode • Cursor • Antigravity • Cline • Continue • Droid • Roo • Copilot • Kilo Code • Gemini CLI • Qwen Code • iFlow • Crush • Crusher • Aider

Any tool supporting OpenAI/Claude-compatible API works.

---

## 💾 Data Location

- **macOS/Linux**: `~/.red-router/db/data.sqlite`
- **Windows**: `%APPDATA%/red-router/db/data.sqlite`
- **Docker**: `/app/data/db/data.sqlite` (mount `$HOME/.red-router` to persist)

---

## 📚 Documentation

Full docs, advanced setup, video tutorials & development guide:

- **GitHub**: https://github.com/reddb-io/red-router
- **Full README**: https://github.com/reddb-io/red-router/blob/main/app/README.md
- **Website**: https://github.com/reddb-io/red-router

---

## 🙏 Acknowledgments

- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** - Original Go implementation

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.
