# Provider executor parity audit

Pinned baseline: `525a71de4ac25968d0a25e52eeb1b09cc21c6e92`. Generated from `open-sse/executors/index.ts` with `node --import tsx/esm scripts/research/legacy-executor-parity.ts`.

142 explicit aliases form 81 source-module groups. Aliases are not distinct provider implementations. Default compatible providers and external search registries are outside this table. The full module inventory remains in [legacy-rust-parity.json](../../config/upstream/legacy-rust-parity.json).

Registry presence is not proof of availability. Check retirement/feature flags and supported provider integrations before implementing. No executor is marked complete by this static audit. Keep Gemini CLI retired. Follow supported CLI integrations; do not port client impersonation, challenge evasion or credential sharing as a reliability strategy. Web-session executors need explicit availability and supported-integration review, not automatic restoration merely because source exists.

Native evidence: `rust/red-routerd/src/control_plane.rs`, `lib.rs`, `product_provider.rs`, protocol/stream modules and `legacy_providers.rs`. Native OAuth supports six configured kinds (Codex, Claude, Antigravity, GitHub, xAI, Openference); this is independent of the number of catalog providers. Claude OAuth is handled outside the lazy registry and remains in CORE-04/PV-24.

Fixed compatible chat endpoints currently cover OpenAI, OpenRouter, Groq, Cerebras, SambaNova, Mistral, DeepSeek, Together, Perplexity, Fireworks, xAI, NVIDIA, AI21, Moonshot/Kimi, SiliconFlow and Novita. This does not certify protocol quirks, model aliases, native metadata, quota behavior or every old setting for those providers.

## Explicit legacy registrations

Complexity is an initial estimate, independent of priority. L = provider/protocol integration; XL = additional process, browser, event-stream or stateful transport. Prioritize API-04 and CORE-04 operational use cases using the [full backlog](LEGACY_RUST_PARITY_BACKLOG.md) and [configuration gaps](LEGACY_PROVIDER_PARITY_FIELDS.md).

| Complexity | Registered aliases | Pinned source | Native parity evidence / remaining work |
| --- | --- | --- | --- |
| XL | `adapta-web`, `adp-web` | `open-sse/executors/adapta-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `adobe-firefly`, `firefly` | `open-sse/executors/adobe-firefly.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `antigravity`, `agy` | `open-sse/executors/antigravity.ts` | Partial: native Antigravity translation/session/quota/refresh exists. Compare fallback, output cap and stream contracts. |
| L | `auggie` | `open-sse/executors/auggie.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `azure-ai` | `open-sse/executors/azure-ai.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `azure-openai` | `open-sse/executors/azure-openai.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `bedrock` | `open-sse/executors/bedrock.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `blackbox-web`, `bb-web` | `open-sse/executors/blackbox-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `chatgpt-web-codex`, `cgpt-codex` | `open-sse/executors/chatgpt-web-codex.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `chatgpt-web` | `open-sse/executors/chatgpt-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `cheaperinference`, `cinf` | `open-sse/executors/cheaperinference.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `claude-web`, `cw-web` | `open-sse/executors/claude-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `cliproxyapi`, `cpa` | `open-sse/executors/cliproxyapi.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `cloudflare-ai`, `cf` | `open-sse/executors/cloudflare-ai.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `cloudflare-playground`, `cfp` | `open-sse/executors/cloudflare-playground.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `clova-studio` | `open-sse/executors/clova-studio.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `codebuddy-cn`, `cbcn` | `open-sse/executors/codebuddy-cn.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `codebuddy-intl`, `cbai` | `open-sse/executors/codebuddy-intl.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `codex-app-server` | `open-sse/executors/codex-app-server.ts`, `open-sse/executors/codex.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `codex` | `open-sse/executors/codex.ts` | Partial: Responses transport and Codex session/refresh exist. App-server is a separate registration below. |
| L | `command-code`, `cmd` | `open-sse/executors/commandCode.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `conol-web`, `cnl` | `open-sse/executors/conol-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `copilot-m365-web` | `open-sse/executors/copilot-m365-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `copilot-web`, `copilot` | `open-sse/executors/copilot-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `cursor`, `cu`, `cursor-api`, `cua` | `open-sse/executors/cursor.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `dario`, `dr` | `open-sse/executors/dario.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `deepseek-web`, `ds-web` | `open-sse/executors/deepseek-web-with-auto-refresh.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `devin-cli-agentic` | `open-sse/executors/devin-cli-agentic.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `devin-cli`, `devin` | `open-sse/executors/devin-cli.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `devin-desktop` | `open-sse/executors/devin-desktop.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `doubao-web`, `db` | `open-sse/executors/doubao-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `duckduckgo-web`, `ddgw` | `open-sse/executors/duckduckgo-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `freebuff`, `fb` | `open-sse/executors/freebuff.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `gemini-web`, `gweb` | `open-sse/executors/gemini-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `ghe-copilot` | `open-sse/executors/ghe-copilot.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `github` | `open-sse/executors/github.ts` | Partial: Copilot refresh and request headers exist. Verify model discovery, account restrictions and fallback. |
| L | `gitlab`, `gitlab-duo` | `open-sse/executors/gitlab.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `glm`, `glm-cn`, `glmt` | `open-sse/executors/glm.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `grok-cli`, `gc` | `open-sse/executors/grok-cli.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `grok-web` | `open-sse/executors/grok-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `huggingchat`, `hc` | `open-sse/executors/huggingchat.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `hyperagent`, `ha` | `open-sse/executors/hyperagent.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `iflow` | `open-sse/executors/iflow.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `inner-ai`, `in-ai` | `open-sse/executors/inner-ai.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `kimchi` | `open-sse/executors/kimchi.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `kimi-web` | `open-sse/executors/kimi-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `kimi-coding-apikey`, `kimi-coding` | `open-sse/executors/kimi.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `kiro`, `amazon-q` | `open-sse/executors/kiro.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `lmarena`, `lma` | `open-sse/executors/lmarena.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `maxai` | `open-sse/executors/maxai.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `mimo-free`, `mmf` | `open-sse/executors/mimo-free.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `moonshot`, `kimi` | `open-sse/executors/moonshot.ts` | Partial: fixed compatible API endpoint exists. Native executor normalization is not certified. |
| XL | `muse-spark-web`, `ms-web` | `open-sse/executors/muse-spark-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `9router`, `nr` | `open-sse/executors/ninerouter.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `nlpcloud` | `open-sse/executors/nlpcloud.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `notion-web`, `nw` | `open-sse/executors/notion-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `ollama-local` | `open-sse/executors/ollama-local.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `oneminai`, `1min` | `open-sse/executors/oneminai.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `opencode-zen`, `opencode-go`, `opencode` | `open-sse/executors/opencode.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `perplexity-web`, `pplx-web` | `open-sse/executors/perplexity-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `poe-web` | `open-sse/executors/poe-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `pollinations`, `pol` | `open-sse/executors/pollinations.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `promptql`, `pql` | `open-sse/executors/promptql.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `qoder-cn`, `qdcn` | `open-sse/executors/qoder-cn.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `qoder` | `open-sse/executors/qoder.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `t3-web`, `t3chat` | `open-sse/executors/t3-chat-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `tencent-aistudio-web`, `tasw` | `open-sse/executors/tencent-aistudio-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `tinycms-web`, `tcw` | `open-sse/executors/tinycms.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `trae` | `open-sse/executors/trae.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `uc` | `open-sse/executors/uc.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `v0-vercel-web`, `v0` | `open-sse/executors/v0-vercel-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `venice-web`, `ven` | `open-sse/executors/venice-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `veoaifree-web`, `veo-free` | `open-sse/executors/veoaifree-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `vertex`, `vertex-partner` | `open-sse/executors/vertex.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `windsurf`, `ws` | `open-sse/executors/windsurf.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `xai`, `xai-oauth`, `xao` | `open-sse/executors/xai.ts` | Partial: fixed API endpoint and xai-oauth refresh exist. Verify CLI tool/reasoning and error contracts. |
| XL | `yuanbao-web`, `ybw` | `open-sse/executors/yuanbao-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| XL | `zai-web`, `zw` | `open-sse/executors/zai-web.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `zcode`, `zc` | `open-sse/executors/zcode.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `zed-hosted` | `open-sse/executors/zed-hosted.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |
| L | `zenmux-free`, `zmf` | `open-sse/executors/zenmux-free.ts` | Unmapped: locate or implement the provider-specific transport, identity, stream, errors and migration; generic URL support is insufficient. |

Each acceptance row must link authorization/session lifecycle, endpoint/model mapping, request/response fixtures, streaming cancellation/errors, quota/account attribution, SQLite migration and SPA configuration. A catalog listing, successful generic chat request or presence of a name in source does not close a row.
