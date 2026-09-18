# RedRouter — Agent Skills

Drop-in skills for any AI agent (Claude, Cursor, ChatGPT, custom SDK). Just **copy a link** below and paste it to your AI — it will fetch the skill and use RedRouter for you.

> Tip: start with the **red-router** entry skill — it covers setup and links to all capability skills.

## Skills

| Capability | Copy link below and paste to your AI |
|---|---|
| **Entry / Setup** (start here) | https://raw.githubusercontent.com/ghcr.io/reddb-io/red-router/refs/heads/master/skills/red-router/SKILL.md |
| Chat / code-gen | https://raw.githubusercontent.com/ghcr.io/reddb-io/red-router/refs/heads/master/skills/red-router-chat/SKILL.md |
| Image generation | https://raw.githubusercontent.com/ghcr.io/reddb-io/red-router/refs/heads/master/skills/red-router-image/SKILL.md |
| Video generation (xAI Grok Imagine) | https://raw.githubusercontent.com/ghcr.io/reddb-io/red-router/refs/heads/master/skills/red-router-video/SKILL.md |
| Text-to-speech | https://raw.githubusercontent.com/ghcr.io/reddb-io/red-router/refs/heads/master/skills/red-router-tts/SKILL.md |
| Speech-to-text | https://raw.githubusercontent.com/ghcr.io/reddb-io/red-router/refs/heads/master/skills/red-router-stt/SKILL.md |
| Embeddings | https://raw.githubusercontent.com/ghcr.io/reddb-io/red-router/refs/heads/master/skills/red-router-embeddings/SKILL.md |
| Web search | https://raw.githubusercontent.com/ghcr.io/reddb-io/red-router/refs/heads/master/skills/red-router-web-search/SKILL.md |
| Web fetch (URL → markdown) | https://raw.githubusercontent.com/ghcr.io/reddb-io/red-router/refs/heads/master/skills/red-router-web-fetch/SKILL.md |

## How to use

Paste to your AI (Claude, Cursor, ChatGPT, …):

```
Read this skill and use it: https://raw.githubusercontent.com/ghcr.io/reddb-io/red-router/refs/heads/master/skills/red-router/SKILL.md
```

Then ask normally — *"generate an image of a cat"*, *"transcribe this URL"*, etc.

## Configure your shell once

```bash
export REDROUTER_URL="http://localhost:25050"   # local default, or your VPS / tunnel URL
export REDROUTER_KEY="sk-..."                   # from Dashboard → Keys (only if requireApiKey=true)
```

Verify: `curl $REDROUTER_URL/api/health` → `{"ok":true}`.

## Links

- Source: https://github.com/reddb-io/red-router
- Dashboard: https://github.com/reddb-io/red-router
