# Oportunidades de providers e de inputs do JEV: 9router oficial + LiteLLM

Date: 2026-09-22
Query: "dê uma olhada nos repositórios oficiais do 9router e veja quais oportunidades temos de aprender e resolver problemas de providers e também sobre novos inputs do JEV. Quero saber como as pessoas estão solucionando estes problemas. Veja o LiteLLM, que também é um proxy, e o que eles implementaram."
Scope:
- **Incluído:**
  - [decolua/9router](https://github.com/decolua/9router): commits v0.5.82 → v0.5.85, cerca de 848 issues desde 2026-06-22 (~80 lidas a fundo), PRs atualizados desde 19/09, Discussions e cerca de 12 forks ativos.
  - [BerriAI/litellm](https://github.com/BerriAI/litellm): código em `main` @ `88a4cbdd`, docs.litellm.ai, issues dos últimos 3 meses.
  - Inventário do RedRouter em `origin/main` + v0.13.0 (`a43e3c51`).
- **Excluído:** o fork PentatonicDev e o que já está em [2026-09-20-9router-upstream-commits-open-prs.md](2026-09-20-9router-upstream-commits-open-prs.md) e [2026-09-22-pentatonic-routing-audit.md](2026-09-22-pentatonic-routing-audit.md). Aqui entra só o que mudou desde essas pesquisas.

Status de cada item no RedRouter: "yes / partial / no", com o caminho do arquivo. Vem da leitura do código, não de execução. Três bugs foram conferidos à mão (seção Gotchas).

## Executive Summary

1. **O LiteLLM já usa o JEV.** O `complexity_router` dele tem `classifier_type: jev`, que chama TypeSafe `/v1/systemone`, e existe um guardrail TypeSafe que compacta tool results pela relevância.
   - A nossa decisão é mais calibrada: winner-strength, tie-band por custo, tool routing, shadow mode, verdict por sessão.
   - O que eles construíram é o **entorno** do classificador, e esse é o ganho mais barato para nós:
     - limpar o ruído do harness antes de montar o `state`;
     - curto-circuito para chamadas de housekeeping (geração de título);
     - piso de tier em plan mode;
     - escalonamento quando o agente trava;
     - `heuristic_first`/`hybrid`, que só chamam o JEV quando a heurística local está em dúvida.
2. **No 9router, os problemas de provider se concentram em quatro frentes:**
   - falhas "soft" com HTTP 200 (stream vazio, `choices:null`, erro no corpo, quota esgotada disfarçada);
   - `disabledModels` ignorado no roteamento;
   - `tool_choice:"none"` virando `"auto"`;
   - capabilities (vision, contexto) detectadas só pelo nome do modelo.

   O RedRouter tem as quatro lacunas. Três delas são pequenas.
3. **Como a comunidade resolve a seleção de conta/modelo:** com sinais determinísticos, isto é, quota restante e horário de reset, saúde (breaker, taxa de erro), latência (TTFT/tok-s), concorrência por conta e orçamento por key. O consenso, alinhado à auditoria do Pentatonic, é:
   - esses sinais funcionam como **filtro e ordenação em código**;
   - o JEV julga a **adequação** entre os candidatos que sobram;
   - no `state` ou nos briefs entram só fatos grosseiros ("cache quente no membro X", "classe de latência: lenta"), nunca números crus para o JEV fazer contas.
4. **Onde o RedRouter já está à frente e não vale copiar:** OAuth de assinaturas, cooldown/locks por modelo, remoção de parâmetros não suportados, fallback só antes do primeiro byte (o mid-stream fallback do LiteLLM corrompe tool calls) e o próprio System One (o upstream só faz pass-through de `/v1/systemone`).
5. **Precisa de decisão de produto:** o time do OpenCode pediu ao 9router que removesse o provider "OpenCode Free" sem autenticação ([#4182](https://github.com/decolua/9router/issues/4182)). O RedRouter distribui o mesmo provider (`open-sse/providers/registry/opencode.js`).

## Official Sources

- [decolua/9router](https://github.com/decolua/9router): o upstream oficial do qual o RedRouter é fork. Fonte primária: código, issues, PRs e Discussions.
- [BerriAI/litellm](https://github.com/BerriAI/litellm): repositório oficial do LiteLLM (código, READMEs de estratégias e release notes).
- [docs.litellm.ai](https://docs.litellm.ai/): documentação oficial do LiteLLM.
- [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute) e [Skulldorom/9router-auto-router](https://github.com/Skulldorom/9router-auto-router): derivados do 9router. **Não são primários**; aparecem como evidência de como a comunidade resolve o problema.

## Hotlinks

- [LiteLLM auto routing (docs)](https://docs.litellm.ai/docs/proxy/auto_routing)
- [LiteLLM complexity_router (código)](https://github.com/BerriAI/litellm/tree/main/litellm/router_strategy/complexity_router)
- [LiteLLM adaptive_router README (bandit)](https://github.com/BerriAI/litellm/blob/main/litellm/router_strategy/adaptive_router/README.md)
- [LiteLLM TypeSafe/Jev compaction guardrail](https://github.com/BerriAI/litellm/blob/main/litellm/proxy/guardrails/guardrail_hooks/typesafe/typesafe.py)
- [LiteLLM sensitive_data_routing hook](https://github.com/BerriAI/litellm/blob/main/litellm/proxy/hooks/sensitive_data_routing.py)
- [LiteLLM MCP semantic tool filter](https://github.com/BerriAI/litellm/blob/main/litellm/proxy/hooks/mcp_semantic_filter/ARCHITECTURE.md)
- [9router da004655: usage em response.completed](https://github.com/decolua/9router/commit/da0046550accedfd4560c3bfe991f09ece7df097)
- [9router PR #3560: read-ahead até o primeiro frame com conteúdo](https://github.com/decolua/9router/pull/3560)
- [9router PR #2941: probe → score → ε-explore + breaker](https://github.com/decolua/9router/pull/2941)
- [9router PR #4241: limites por API key](https://github.com/decolua/9router/pull/4241)
- [9router #4171: tool_choice none → auto](https://github.com/decolua/9router/issues/4171)

## Key Findings

### A. Problemas de provider e como estão sendo resolvidos

| # | Problema | Como resolvem | RedRouter | Esforço |
|---|---|---|---|---|
| A1 | Codex não compacta sozinho porque falta usage no `response.completed` | 9router [da004655](https://github.com/decolua/9router/commit/da0046550accedfd4560c3bfe991f09ece7df097), [#3432](https://github.com/decolua/9router/issues/3432) | **no**: `open-sse/transformer/responsesTransformer.js:227`, `translator/response/openai-responses.js` | S |
| A2 | Modelo desabilitado ou fora da allowlist ainda é roteado; só some de `/v1/models` | 9router [#4246](https://github.com/decolua/9router/issues/4246), [#4249](https://github.com/decolua/9router/issues/4249), [#3135](https://github.com/decolua/9router/issues/3135) | **no**: `disabledModels` não é lido em `src/sse`/`open-sse/services`/`open-sse/handlers` (conferido). O trabalho local de API-key/model-binding no checkout principal é o lugar natural para isso | S |
| A3 | `tool_choice:"none"` vira `"auto"`; `parallel_tool_calls`/`allowed_tools` são descartados | 9router [#4171](https://github.com/decolua/9router/issues/4171) (sem fix upstream) | **no**: `open-sse/translator/request/openai-to-claude.js:306` (conferido; o Claude aceita `none`) | S |
| A4 | Replay de `reasoning_content` quebra Groq/Mistral/Cerebras a partir do 2º turno; o combo pula esses providers em silêncio | 9router [7c2b1fe3](https://github.com/decolua/9router/commit/7c2b1fe3e146183674c8d75ff9ef51d9d42b5dad) | **no**: `translator/concerns/paramSupport.js` | S |
| A5 | **Falhas soft com HTTP 200**: stream vazio, `choices:null`, "overloaded" no corpo, spend hard-limit, GLM com quota esgotada devolvendo 200 + `stop_reason: model_context_window_exceeded` sem conteúdo | 9router [#3463](https://github.com/decolua/9router/issues/3463), [#2188](https://github.com/decolua/9router/issues/2188), [#2727](https://github.com/decolua/9router/issues/2727), [#3232](https://github.com/decolua/9router/issues/3232), [disc. #3992](https://github.com/decolua/9router/discussions/3992); fix: [PR #3560](https://github.com/decolua/9router/pull/3560) segura o stream até o primeiro frame com conteúdo e então faz replay. LiteLLM [#38535](https://github.com/BerriAI/litellm/issues/38535) propõe `treat_finish_reason_as_failure` | **partial**: só reconecta no mesmo provider em EOF antes do 1º byte (`open-sse/handlers/chatCore.js:636-650`) | M |
| A6 | Rotação de contas ignora quota restante; a conta premium se esgota cedo | 9router [PR #584](https://github.com/decolua/9router/pull/584), [PR #3584](https://github.com/decolua/9router/pull/3584), [PR #4243](https://github.com/decolua/9router/pull/4243), OmniRoute quotaStrategies. Ideias: reserva de X%, preferir a conta cujo reset está mais perto ("use or lose"), quota desatualizada conta como desconhecida | **partial**: quota é buscada para ~15 providers, mas só Antigravity a 0% barra o roteamento (`src/sse/services/auth.js:118-180`) | M |
| A7 | Não há memória de saúde/latência entre requests | 9router [PR #2941](https://github.com/decolua/9router/pull/2941) (testa contas novas primeiro, pontua pela razão com a mais rápida, ε-explore, breaker), [PR #2284](https://github.com/decolua/9router/pull/2284) (score −10 5xx / −30 429 / −50 401-403, +3/min de recuperação), [PR #4225](https://github.com/decolua/9router/pull/4225). LiteLLM: health checks em background, com resultados que expiram e 429/408 tratados como transitórios | **partial**: TTFT/total ficam gravados por request (`chatCore/requestDetail.js`) mas nunca são agregados nem usados no roteamento; health check só manual (`/api/providers/[id]/test`) | M |
| A8 | Capabilities só por padrão de nome: modelos VL próprios perdem imagens; não dá para sobrescrever o context window | 9router [#3568](https://github.com/decolua/9router/issues/3568), [#3836](https://github.com/decolua/9router/issues/3836), [#3809](https://github.com/decolua/9router/issues/3809), [#3854](https://github.com/decolua/9router/issues/3854) | **partial**: `open-sse/providers/capabilities.js` (default `vision:false`, 200k para modelo desconhecido em `:42`, `maxOutput` não usado). Pré-requisito para qualquer filtro de candidatos confiável | M |
| A9 | Cliente desconecta, o usage se perde e a falha é registrada como sucesso; conexões ociosas caem por falta de keepalive | 9router [#3409](https://github.com/decolua/9router/issues/3409)/[PR #3457](https://github.com/decolua/9router/pull/3457), [#3090](https://github.com/decolua/9router/issues/3090), [#4104](https://github.com/decolua/9router/issues/4104), [PR #3907](https://github.com/decolua/9router/pull/3907). LiteLLM: timeout do cliente não pode mandar a conta para cooldown | **no** | M |
| A10 | Ban de conta por rajada | VansRouter: semáforo de concorrência por conta + breaker por provider/proxy | **no/partial** | M |
| A11 | Limites e orçamento por API key | 9router [PR #4241](https://github.com/decolua/9router/pull/4241) (RPM, tokens/dia e /mês, USD/mês, 429 + Retry-After); LiteLLM: budgets por key/team/provider | **no** (existe só `allowedConnectionIds` em `src/lib/db/repos/apiKeysRepo.js`) | M |
| A12 | Passthrough do Claude Code: `anthropic-beta` do cliente é perdido e `safeguards` é descartado | 9router [#4196](https://github.com/decolua/9router/issues/4196), [#4173](https://github.com/decolua/9router/issues/4173) | **no** | S |
| A13 | Headers de rate limit genéricos (`x-ratelimit-remaining-*`, `anthropic-ratelimit-*`) | LiteLLM usa esses headers para o tracking de TPM/RPM por deployment | **partial**: só Groq/antigravity; `retry-after` e `anthropic-ratelimit-unified-reset` já viram lock (`open-sse/utils/error.js:201`) | S-M |
| A14 | Retry sem jitter e sem política por tipo de erro | LiteLLM: `retry_policy` por classe de exceção; `allowed_fails` + cooldown | **partial**: `executors/base.js:116-200` com delays fixos; 429 → 0 retries | S |

Regressões de translator que viraram bug no LiteLLM e valem como casos de teste (links na seção E do anexo LiteLLM):
- tool-call que chega em um único delta de streaming perde id/nome;
- `content_block_stop` duplicado faz a tool rodar duas vezes;
- id de tool com mais de 64 chars quebra no Bedrock;
- Gemini rejeita `$ref`/`$defs` no schema;
- thinking budget maior que `max_tokens`;
- thought signature do Gemini vaza para outros providers;
- system message no meio da conversa invalida o prefixo cacheado.

### B. Novos inputs e melhorias para o JEV / System One

**O que o JEV recebe hoje** (inventário completo no Anexo C):
- o `state` montado em `open-sse/decision/state.js:69`: system + conversa do mais novo para o mais antigo em 24k chars, 4k por mensagem, 600 por tool result, nomes de tool calls;
- briefs de modelo escritos à mão (`modelBriefs.js`);
- preço de input, usado só em código para o desempate;
- modalidades exigidas e context fit, **aplicados depois do JEV** em `combo.js:243-370`;
- verdict anterior da sessão.

O caminho legado "smart" (`jevClassifier.js`) manda só o último turno do usuário, com até 4k chars.

| # | Input ou mecanismo | De onde vem | Onde entra no RedRouter | Esforço |
|---|---|---|---|---|
| B1 | **Limpar o ruído do harness antes do `state`**: tirar blocos `<system-reminder>`, `<environment_context>`/`<user_instructions>`/`# AGENTS.md instructions` do Codex; para UA `claude-cli/`/`claude-code/` descartar o system do cliente; classificar sobre o último pedido humano real | LiteLLM complexity_router (`reminder_markers`) | `open-sse/decision/state.js` `buildState` e `jevClassifier.js`. Hoje manda tudo, inclusive os nossos próprios hints injetados (`injectHint.js`) | S |
| B2 | **Curto-circuito de housekeeping**: título de sessão, resumo e classificador de auto-mode vão para o tier mais barato **sem chamar o JEV** | LiteLLM `route_housekeeping_to_cheapest_tier` (medido: 17 de 789 chamadas/dia iam para o tier mais caro); 9router [#3164](https://github.com/decolua/9router/issues/3164), [#3410](https://github.com/decolua/9router/issues/3410), [#4196](https://github.com/decolua/9router/issues/4196) | antes de `decideModel` em `src/sse/services/decisionRouter.js` | S |
| B3 | **Piso de tier em plan mode**: "Plan mode is active" ou a tool `exit_plan_mode` sobem o tier só naquele turno | LiteLLM `plan_mode_min_tier` | pré-filtro determinístico e fato em `state` | S |
| B4 | **Stall escalation**: a última tool call se repetiu ou falhou (`is_error`) ≥3 vezes nas últimas 6, então sobe um tier. Stateless, recalculado da lista de mensagens | LiteLLM `stall_escalation_enabled` | fato estruturado no `state` + regra em código | S |
| B5 | **Heurística local antes do JEV** (`heuristic_first` / `hybrid`): score local rápido; o JEV só é chamado perto da fronteira de tier ou quando o sinal é zero; a heurística vira fallback quando o breaker abre | LiteLLM (7 dimensões com pesos, fronteiras 0.15/0.35/0.60); [Skulldorom auto-router](https://github.com/Skulldorom/9router-auto-router) (24000/12000/16 chars, hard ≥6); OmniRoute complexityRouter ("com tools, nunca o tier mais fraco") | `jevClassifier.js` hoje cai para a ordem original. Corta latência e custo do JEV | S-M |
| B6 | **Context fit e modalidade ANTES do JEV**: hoje o JEV pode escolher um modelo que depois é filtrado por contexto | inventário RedRouter; LiteLLM faz escalonamento por context-window/modalidade só para cima | mover `filterModelsByContext`/capabilities para antes de `rankPool` | S |
| B7 | **Custo total estimado** (input + output esperado + cache read/write + reasoning) no lugar de só preço de input; tiers `long_context` | 9router [PR #4074](https://github.com/decolua/9router/pull/4074), [PR #2453](https://github.com/decolua/9router/pull/2453); LiteLLM cost map | `priceOf` em `decisionRouter.js:118`, `providers/pricing.js` | S-M |
| B8 | **Afinidade de cache/sessão**: trocar de modelo ou conta perde o prompt cache; "cache quente no membro X" entra como custo de troca no gate | LiteLLM (fixa na deployment que tem o prefixo em cache, com expiração); 9router [PR #4078](https://github.com/decolua/9router/pull/4078), [#2929](https://github.com/decolua/9router/issues/2929) | `switchStrength` em `decide.js`; o round-robin de contas em `auth.js` hoje quebra o cache | M |
| B9 | **Sinais de saúde, quota e latência** (A6/A7) como filtro e ordenação em código; no máximo uma "classe de latência" nos briefs | 9router PRs #2941/#2284/#4225, OmniRoute (~16 fatores ponderados) | depende de A6/A7 | M |
| B10 | **Compactação por relevância com o JEV**: uma pergunta sim/não por tool exchange concluído ("ainda é necessário?"); zera os abaixo de 0.2; pula resultados < 200 chars, protege os turnos recentes, fail-open | LiteLLM TypeSafe guardrail | novo hook em `open-sse/rtk/` (já é fail-open por convenção) | M |
| B11 | **Header de override por request** (forçar tier/modelo; `x-...-min-quality-tier`) e header de resposta expondo a decisão | 9router [#2852](https://github.com/decolua/9router/issues/2852); LiteLLM `x-litellm-min-quality-tier` | hoje `x-red-router-decision: off` só vale no caminho de tools (`chatCore.js:351`), não na decisão de modelo | S |
| B12 | **Relatório de economia** incluindo o custo do classificador; baseline = o modelo mais caro do tier mais difícil sobre uma request de referência fixa; pode dar negativo por causa de cache-write | LiteLLM `savings_baseline.py` | dashboard Usage (as decisões já são requests próprias) | S-M |
| B13 | **Roteamento por dado sensível**: guardrail detecta PII e fixa a sessão num modelo local/seguro | LiteLLM `sensitive_data_routing` | novo; casa com o text classification (PR #33) | M |
| B14 | **Bandit de resultado**: Thompson sampling por (tipo de request, modelo), alimentado por sinais no próximo turno do usuário (satisfação, loop, falha) | LiteLLM `adaptive_router` | depois; poderia calibrar os briefs com o tempo | L |
| B15 | **Preço por horário** (desconto off-peak do DeepSeek) | 9router [#3953](https://github.com/decolua/9router/issues/3953) | código (janelas `allow_only`/`priority_boost`) | S-M |

## API / CLI / Config Details

- **LiteLLM `complexity_router`:**
  - `classifier_type` ∈ `heuristic | heuristic_v2 | llm | capability | llm_v2 | jev | heuristic_first | hybrid | custom`;
  - `classifier_fallback` ∈ `heuristic | default_model`;
  - timeout faz uma única tentativa, com circuit breaker por processo (30s e depois um probe). É o mesmo desenho do nosso `jevClassifier`;
  - flags: `route_housekeeping_to_cheapest_tier` (on por padrão), `plan_mode_min_tier`, `stall_escalation_enabled` (janela 6, limiar 3), `session_affinity_ttl_seconds` (3600), `classification_mode: user_turn`, `max_tokens_from_tier_model`, `context_compaction`, `tier_labels`;
  - a decisão é logada como `routing_decision.cause`/`signals`.
- **LiteLLM `jev` classifier:** uma pergunta `choice` chamada `tier` em TypeSafe `/v1/systemone`; o custo é registrado como spend `typesafe/<model>`, com valor tirado do cost map. É o mesmo formato do nosso caminho legado "smart".
- **TypeSafe guardrail:** `relevance_threshold` 0.2; resultados < 200 chars são ignorados; até 4000 chars por resultado no `state`; até 200 exchanges por avaliação.
- **9router PR #3560:** faz read-ahead do SSE até o primeiro frame com conteúdo. Se vier vazio ou com erro, lança uma exceção que dispara o fallback; senão faz replay dos frames que segurou.

## Version Notes

- 9router: `master` @ [21583c03](https://github.com/decolua/9router/commit/21583c03e5c5d5276924efad82328ebe6e215854) (v0.5.85). Tem `/v1/systemone` próprio, servido por OpenCode Zen e OpenRouter, mas só faz pass-through e não roteia com ele. Mais recente que o nosso e ainda não portado: usage em `response.completed`, remoção do `reasoning_content` para providers estritos, `qoder-cn`, `mimo-v2.6-flash-free` como fallback de vision.
- LiteLLM: stable v1.101.0 (2026-09-15), v1.103.0-rc.1 (2026-09-20), `main` @ `88a4cbdd`. O `auto_router` antigo, baseado em embeddings (semantic-router), está **deprecated** em favor do `complexity_router`.
- RedRouter: `origin/main` @ `d104eeb0` + a v0.13.0 (`a43e3c51`, PR #36 ainda não mergeado).

## Gotchas

Conferidos no código:
- **`tool_choice:"none"` → `{type:"auto"}`** em `open-sse/translator/request/openai-to-claude.js:306`. O Claude aceita `none`. É exatamente o problema de "respeitar `tool_choice: none`" que a auditoria do Pentatonic cita, só que agora na camada de tradução.
- **`resolveSystemOneProviderModel` devolve `config.defaultModel` antes de olhar o `modelMap`** (`open-sse/handlers/systemOneCore.js:107`). TypeSafe e OpenRouter definem `defaultModel`, então um `jev-1.13` pedido é ignorado e o `modelMap` desses providers nunca é usado.
- **`disabledModels` não é consultado em nenhum ponto do caminho de roteamento.**

Apontados pelo inventário, não conferidos à mão:
- O header `x-red-router-decision: off` só desliga a decisão de tools (`chatCore.js:351`).
- O context-window check roda depois do JEV (`combo.js:243-370`), então o JEV pode escolher um modelo que depois é descartado.
- `accountFallback.js:6` diz 1s/4min, mas o código usa base 2s e máximo 5min (`errorConfig.js:37-41`). O `terminal` das regras de erro é ignorado pelo combo.
- Código morto em `open-sse/decision/*`: `hasCacheBreakpoint`, `decideSwitch`, `buildShortlistQuestions`, `readShortlist`.
- Pendente da pesquisa de 20/09: a OpenRouter continua em `/api/v1/systemone`, não em `/api/alpha/decisions`, e ainda não existe política de cost-class (free/paid/byok).

Cuidados ao copiar do LiteLLM:
- **Não copiar o mid-stream fallback**: corrompe tool calls ([#31067](https://github.com/BerriAI/litellm/issues/31067)) e não dispara em streams cortados ([#40404](https://github.com/BerriAI/litellm/issues/40404)).
- **Não copiar o repasse de OAuth**: o token do cliente já vazou para um base URL de terceiro ([#42172](https://github.com/BerriAI/litellm/issues/42172)).
- **Não copiar o default de erro em parâmetro não suportado**: os usuários reclamam.
- **Semantic cache vale pouco para tráfego de agentes**, porque qualquer mudança na conversa é cache miss.

## Open Questions

- **OpenCode Free ([#4182](https://github.com/decolua/9router/issues/4182)):** manter, esconder atrás de opt-in ou remover o provider no-auth?
- **Heurística local (B5):** quem mantém os pesos e fronteiras? Usar os do LiteLLM como ponto de partida ou calibrar com os logs de decisão que já gravamos (as decisões são requests próprias com probabilidades)?
- **Sinais de saúde/latência (B9):** ficam só em código, ou uma "classe de latência" também entra nos briefs do JEV? Recomendo só em código até haver medição em shadow.
- **Compactação por relevância (B10):** tem custo por tool exchange avaliado. Vale ligar por padrão ou só acima de um tamanho de conversa?

## Source-by-Source Notes

Resumo aqui; as notas detalhadas, com todos os links, estão nos anexos.

- **9router, issues:** 848 triadas por título, ~80 lidas com comentários. Clusters: OAuth/refresh, 429/cooldown, ban/fingerprint, gating de modelo desabilitado, streaming, tool calls, thinking, vision, contexto/cache. (Anexo A, partes 1a/1b.)
- **9router, commits/PRs:** v0.5.82 → v0.5.85, mais PRs de roteamento abertos e antigos que não estavam na pesquisa de 20/09. (Anexo A, partes 2/2b/3b.)
- **9router, forks:** de 731 forks ativos desde agosto, a maioria só ressincroniza com o upstream. Os que se destacam:
  - OmniRoute: scoring com ~16 fatores e complexity router;
  - VansRouter: breaker e semáforo por conta;
  - PR #4213 da Primexz: auto-routing + dashboard de performance.

  (Anexo A, parte 3.)
- **LiteLLM:** router strategies, retries/fallbacks/cooldowns, translation quirks, routing intelligence (complexity/adaptive/quality/lar1, plugins, guardrails), ops e issues recentes. (Anexo B.)

## Recommended Next Steps

Tudo isto fica para **depois** da v0.13.0; nenhum item deve entrar na release.

**Lote 1: bugs e lacunas pequenas** (S, alto impacto, dá para um PR `fix` por item):
1. A3: `tool_choice:"none"` preservado em OpenAI↔Claude, com teste.
2. Gotcha: `resolveSystemOneProviderModel` passa a respeitar o `modelMap`/modelo pedido antes do `defaultModel`.
3. A2: `disabledModels`/allowlist aplicados no roteamento. Reconciliar antes com o trabalho local de model-binding do checkout principal.
4. A1: usage em `response.completed`.
5. A4: remover `reasoning_content` para Groq/Mistral/Cerebras.
6. B11 (parte): `x-red-router-decision: off` também desliga a decisão de modelo.

**Lote 2: o entorno do JEV** (S, reduz custo e erro sem mexer na calibração):
- B1 limpeza do harness;
- B2 housekeeping;
- B3 plan mode;
- B4 stall;
- B6 context/modalidade antes do JEV.

Tudo determinístico, testável em shadow mode e logado como `cause` na request de decisão.

**Lote 3: resiliência** (M):
- A5 falhas soft com 200 (read-ahead no estilo do PR #3560, com fallback para o próximo membro do combo);
- A7 agregação de TTFT/erro por conta+modelo;
- A6 quota-aware selection.

Esses sinais passam então a filtrar e ordenar o pool antes do JEV (B9).

**Lote 4:**
- B5 heurística local (`heuristic_first`/`hybrid` + fallback do breaker);
- B7 custo total;
- B8 afinidade de cache;
- B10 compactação por relevância no RTK;
- B12 relatório de economia.

**Depois:** A8 capabilities com override, A9 keepalive/disconnect, A10 concorrência por conta, A11 limites por key, B13 PII, B14 bandit, B15 preço por horário.

---

# Anexos

As notas completas das três investigações seguem abaixo, sem edição. Cada item tem link para a fonte e o status no RedRouter.


## Anexo A — 9router upstream, issues, PRs e forks (delta)

### 9router upstream: provider problems, new PRs, forks and routing signals (delta)

Date: 2026-09-22. Upstream: [decolua/9router](https://github.com/decolua/9router) `master` @ [21583c03](https://github.com/decolua/9router/commit/21583c03e5c5d5276924efad82328ebe6e215854) (v0.5.85). 29.6k stars, 5.5k forks, about 2.2k open issues+PRs, Discussions enabled (93 threads).
RedRouter baseline: `/tmp/red-router-release-0130` @ `a43e3c51` (v0.13.0 = origin/main).
Delta only. Already covered and not repeated here: [2026-09-20 upstream report](/home/cyber/Work/reddb.io/red-router/.red/researches/2026-09-20-9router-upstream-commits-open-prs.md) (PRs #4192/#4208/#4210/#4170/#4185/#4206/#4078/#4197/#4147/#4215/#4200, commits 20a43f5a/93001213/bc3be0cb, the OpenCode session cluster) and the [Pentatonic audit](/home/cyber/Work/reddb.io/red-router/.red/researches/2026-09-22-pentatonic-routing-audit.md).

Method: 848 issues created since 2026-06-22 were listed and triaged by title. About 80 were read in depth, together with their comments and linked PRs. Every commit since a8c9d380 and every PR updated since 09-19 was diffed or read. Forks were ranked by stars and by pushes since 2026-08-20; about 12 were inspected through the GitHub compare API. RedRouter status was checked by grepping `open-sse/` and `src/` (yes / partial / no + path). "Already in RedRouter?" is based on reading the code, not on running it.

## Executive summary: ranked opportunities (impact ÷ effort)

| # | Opportunity | Evidence | RedRouter today | Effort |
|---|---|---|---|---|
| 1 | **Report usage in `response.completed`** (Codex auto-compaction) | merged upstream [da004655](https://github.com/decolua/9router/commit/da0046550accedfd4560c3bfe991f09ece7df097); issue [#3432](https://github.com/decolua/9router/issues/3432) | **no.** Still missing: `open-sse/transformer/responsesTransformer.js:227`, `translator/response/openai-responses.js` | S |
| 2 | **Enforce disabled models and the allowlist during routing**, not only in `/v1/models` | [#4246](https://github.com/decolua/9router/issues/4246), [#4249](https://github.com/decolua/9router/issues/4249), [#3135](https://github.com/decolua/9router/issues/3135), [#4205](https://github.com/decolua/9router/issues/4205) | **no.** `disabledModels` is never read in `src/sse`/`open-sse/services`; `enabledModels` is read but never written | S |
| 3 | **`tool_choice:"none"` becomes `"auto"`** in both OpenAI↔Claude directions; `parallel_tool_calls`/`allowed_tools` are dropped. This is also a prerequisite for any "forced tool" decision mode | [#4171](https://github.com/decolua/9router/issues/4171) (no upstream fix) | **no**: `open-sse/translator/request/openai-to-claude.js:302-308` | S |
| 4 | **Soft-failure detection → combo failover**: 200 with empty stream, `choices:null`, error text inside 200 ("overloaded", spend hard-limit, `outcome=exhausted`) | [#3463](https://github.com/decolua/9router/issues/3463), [#2188](https://github.com/decolua/9router/issues/2188), [#2727](https://github.com/decolua/9router/issues/2727), [#3232](https://github.com/decolua/9router/issues/3232), [#3242](https://github.com/decolua/9router/issues/3242), [discussion #3992](https://github.com/decolua/9router/discussions/3992); fix idea in open [PR #3560](https://github.com/decolua/9router/pull/3560) (read ahead to the first content frame, then replay) | **partial**: only same-provider reconnects on EOF before the first byte (`open-sse/handlers/chatCore.js:636-650`) | M |
| 5 | **Drop replayed `reasoning_content` for strict upstreams** (groq/mistral/cerebras) | [7c2b1fe3](https://github.com/decolua/9router/commit/7c2b1fe3e146183674c8d75ff9ef51d9d42b5dad) (#4220) | **no**: `translator/concerns/paramSupport.js` | S |
| 6 | **Quota-remaining-aware account selection** (reserve X%, prefer the soonest reset, stale quota = unknown) | [PR #584](https://github.com/decolua/9router/pull/584), [PR #3584](https://github.com/decolua/9router/pull/3584), [#3583](https://github.com/decolua/9router/issues/3583), [#3726](https://github.com/decolua/9router/issues/3726), AG pools [PR #4243](https://github.com/decolua/9router/pull/4243)/[#3969](https://github.com/decolua/9router/pull/3969), OmniRoute quotaStrategies (forks section) | **partial**: quota is fetched for ~15 providers but only Antigravity at 0% gates routing (`src/sse/services/auth.js:118-180`) | M |
| 7 | **Latency/TTFT/tok-s telemetry, then latency- and health-aware account and combo ranking** | [PR #4225](https://github.com/decolua/9router/pull/4225), [PR #2941](https://github.com/decolua/9router/pull/2941) (probe-unproven → score → ε-explore + breaker), [PR #2284](https://github.com/decolua/9router/pull/2284), [PR #4213](https://github.com/decolua/9router/pull/4213) perf dashboard, [#3072](https://github.com/decolua/9router/issues/3072) | **partial**: `latency.{ttft,total}` is stored per request detail only; no aggregation, no routing use | M |
| 8 | **Deterministic complexity pre-scorer** as a free prior and as the fallback when Jev is off or its breaker is open (today it fails open to the static order) | [Skulldorom/9router-auto-router](https://github.com/Skulldorom/9router-auto-router), [PR #2045](https://github.com/decolua/9router/pull/2045), OmniRoute `complexityRouter.ts` | **no**: `open-sse/services/jevClassifier.js` returns null → original order | S-M |
| 9 | **Capabilities (vision, context) are pattern-only**: vision is stripped from custom/self-hosted VL models, and context windows can't be overridden per model | [#3568](https://github.com/decolua/9router/issues/3568), [#3836](https://github.com/decolua/9router/issues/3836), [#4211](https://github.com/decolua/9router/issues/4211), [#3809](https://github.com/decolua/9router/issues/3809), [#3750](https://github.com/decolua/9router/issues/3750), [#3854](https://github.com/decolua/9router/issues/3854) | **partial**: `open-sse/providers/capabilities.js` (default `vision:false`). A prerequisite for correct System One candidate filtering | M |
| 10 | **SSE keepalive + disconnect finalization** (usage lost and failures logged as success when the client aborts) | [#3409](https://github.com/decolua/9router/issues/3409)/[PR #3457](https://github.com/decolua/9router/pull/3457); [#3090](https://github.com/decolua/9router/issues/3090), [#3488](https://github.com/decolua/9router/issues/3488), [#4104](https://github.com/decolua/9router/issues/4104), [PR #3907](https://github.com/decolua/9router/pull/3907), [PR #3348](https://github.com/decolua/9router/pull/3348) | **no** | M |
| 11 | **Per-API-key limits** (RPM, tokens/day and /month, monthly USD budget, 429 + Retry-After). These also feed "budget remaining" to the decision layer | [PR #4241](https://github.com/decolua/9router/pull/4241), [#2390](https://github.com/decolua/9router/pull/2390) | **no** (per-key `allowedConnectionIds` exists in `src/lib/db/repos/apiKeysRepo.js`) | M |
| 12 | **Per-account concurrency limit (semaphore) + per-provider/proxy breaker** against burst bans | VansRouter (forks section) | **no / partial** | M |
| 13 | Claude Code pass-through: merge the client's `anthropic-beta` header, keep `safeguards` | [#4196](https://github.com/decolua/9router/issues/4196), [#4173](https://github.com/decolua/9router/issues/4173) | **no** | S |
| 14 | **Legal: OpenCode team asked 9router to remove the no-auth OpenCode Free provider** | [#4182](https://github.com/decolua/9router/issues/4182) | RedRouter ships the same `noAuth` provider (`open-sse/providers/registry/opencode.js`): **product decision needed** | S |

## 4. Routing and decision signals: what exists vs. candidate new inputs for JEV / System One

Today the decision layer (`src/sse/services/decisionRouter.js`, `open-sse/decision/{state,questions,decide,modelBriefs}.js`, `open-sse/services/jevClassifier.js`, `open-sse/services/combo.js`) uses these inputs:
- conversation `state`: text, newest first, 24k-char budget, tool_call names
- candidate combo members with curated **model briefs**
- **input price** as a tie-breaker (`priceOf`, `TIE_BAND` 0.15)
- **required modalities** (`detectRequiredCapabilities`)
- **context fit** (`estimateRequestTokens` + `filterModelsByContext`)
- Jev **tier** (SIMPLE/MEDIUM/COMPLEX/REASONING)
- tool roster (shortlist)
- previous verdict
- winner strength, confidence and deliberation

Candidate new inputs found upstream and in forks:

| Signal | Where it is used or proposed | Deterministic (code) or ask Jev? | Notes |
|---|---|---|---|
| **Provider/account health**: rolling error rate, breaker state, consecutive strikes | [PR #2941](https://github.com/decolua/9router/pull/2941), [PR #2284](https://github.com/decolua/9router/pull/2284) (score deltas −10 5xx / −30 429 / −50 401-403, +3/min recovery), VansRouter breaker, OmniRoute scoring | code (eligibility + ordering) | keep out of the Jev prompt; filter or reorder candidates before asking |
| **Latency**: TTFT p50/p95, total p95, tok/s | [PR #4225](https://github.com/decolua/9router/pull/4225), [PR #4213](https://github.com/decolua/9router/pull/4213) `summarizePerformance`, [#3072](https://github.com/decolua/9router/issues/3072), [#3796](https://github.com/decolua/9router/issues/3796) (TTFT variance on ag/gemini-3.8-flash) | code; latency *class* ("fast/slow") could go into briefs | normalize as a ratio to the fastest candidate, not min-max ([PR #2941](https://github.com/decolua/9router/pull/2941) regression note) |
| **Empty-stream / stall rate** per provider-model | [#3463](https://github.com/decolua/9router/issues/3463), [#3977](https://github.com/decolua/9router/issues/3977) (cursor soft-block), [#3136](https://github.com/decolua/9router/issues/3136) | code | cheapest reliability signal for free-tier providers |
| **Quota remaining % and time until reset**, stale-quota flag | [PR #584](https://github.com/decolua/9router/pull/584), [PR #3584](https://github.com/decolua/9router/pull/3584), [PR #4243](https://github.com/decolua/9router/pull/4243), OmniRoute quotaStrategies | code | prefer the account/model whose window resets soonest ("use it or lose it"), keep a reserve for premium |
| **Account in-flight concurrency** | VansRouter accountSemaphore | code | also an anti-ban measure |
| **Budget remaining** (per API key / per owner, monthly USD) | [PR #4241](https://github.com/decolua/9router/pull/4241) | code (hard cap) + could shift the cost tie-band | |
| **Time-of-day pricing** (off-peak discounts) | [#3953](https://github.com/decolua/9router/issues/3953) | code (schedule windows `allow_only` / `priority_boost`) | DeepSeek 50% off-peak example |
| **Total cost estimate** (input + expected output + cache read/write + reasoning), provider-reported `usage.cost.total` | [PR #4074](https://github.com/decolua/9router/pull/4074), [PR #2453](https://github.com/decolua/9router/pull/2453), [#4191](https://github.com/decolua/9router/issues/4191) | code | RedRouter's `priceOf` is input-only |
| **Cache/session affinity** (prefix warm on account X) | [PR #4078](https://github.com/decolua/9router/pull/4078), [#2639](https://github.com/decolua/9router/pull/2639), [#2736](https://github.com/decolua/9router/pull/2736), [#2929](https://github.com/decolua/9router/issues/2929) | code | switching model/account loses the cache, so the switch cost belongs in the gate |
| **Deterministic complexity features**: context chars, #turns, actual tool calls/results, large tool output, strong task phrases, tool count (weak) | [Skulldorom auto-router](https://github.com/Skulldorom/9router-auto-router) (thresholds 24000 / 12000 / 16, hard≥6), [PR #2045](https://github.com/decolua/9router/pull/2045), [#2852](https://github.com/decolua/9router/issues/2852), OmniRoute complexityRouter | code prior; can be passed to Jev as structured facts in `state` | "tools present → never the weakest tier" rule (OmniRoute) |
| **Requested output budget / reasoning effort** (`max_tokens`, `reasoning_effort`, thinking budget) | [PR #2045](https://github.com/decolua/9router/pull/2045) | code + Jev | already partly visible in the body; not used as a signal |
| **Main agent vs. subagent / title-gen / classifier call** | [#3410](https://github.com/decolua/9router/issues/3410), [#3164](https://github.com/decolua/9router/issues/3164) (title-gen), [#4196](https://github.com/decolua/9router/issues/4196) (auto-mode classifier) | code (headers/system-prompt fingerprints) | cheap calls should never go to premium |
| **Request-level override** (header forcing a tier/model) | [#2852](https://github.com/decolua/9router/issues/2852) | code | useful for evaluation/benchmark A/B |
| **Endpoint capability** (native Responses support) | [PR #3842](https://github.com/decolua/9router/pull/3842) | code (probe) | avoids lossy translation for reasoning+tools (see [#4031](https://github.com/decolua/9router/issues/4031), [#2540](https://github.com/decolua/9router/issues/2540)) |
| **Correct per-model/connection capabilities** (vision, context, max output) | [#3809](https://github.com/decolua/9router/issues/3809), [#3854](https://github.com/decolua/9router/issues/3854), [5c217d34](https://github.com/decolua/9router/commit/5c217d34f369a13a1362833e679d5e8aee2ef81b) | code (eligibility) | prerequisite: wrong caps poison every other signal |

Design note, consistent with the Pentatonic audit: health, quota, budget, concurrency and capabilities should be **hard eligibility filters and ordering in code**. Jev should judge *fitness* among eligible candidates. At most, coarse structured facts (tier prior, latency class, "cache warm on member X") go into `state`/briefs. Raw numbers should not be handed to Jev for arithmetic.

---

### 1a. Issue clusters: OAuth, quota/429, bans/fingerprinting, model gating

### Part A — 9router issues: OAuth refresh, 429/cooldown, bans/fingerprinting, disabled-model gating

Window: issues created ~2026-06-22 → 2026-09-22 on decolua/9router. RedRouter checked at `/tmp/red-router-release-0130` (v0.13.0, a43e3c51).
Already-covered items (prior report 2026-09-20) are referenced only: #4192, #4208, #4210, #4170, #4185, #4206, #4078, #4197, #4147, #4215, commits 20a43f5a / 93001213 / bc3be0cb, OpenCode session cluster.

Link base: issue `https://github.com/decolua/9router/issues/N`, PR `https://github.com/decolua/9router/pull/N`, commit `https://github.com/decolua/9router/commit/SHA`.

## 1. OAuth / token refresh failures

| Problem | Issues | Upstream fix (PR/commit) | Already in RedRouter? |
|---|---|---|---|
| A numeric epoch `expiresAt` stored as text (from import, backup restore or an external tool) parses to `Invalid Date`. Proactive refresh then skips the connection **silently**, and the token dies at expiry. This is the root cause behind several "never refreshed" reports. | [#4000](https://github.com/decolua/9router/issues/4000) (links #2546, #2734) | [PR #3997](https://github.com/decolua/9router/pull/3997) (OPEN) | **yes**: `open-sse/services/oauthCredentialManager.js` `parseTimeMs` accepts numeric strings and uses a seconds-vs-ms heuristic |
| xAI / grok-cli refresh never fires, or fires without a refresh token read from PSD. The token dies at +6h every day. | [#2546](https://github.com/decolua/9router/issues/2546), [#2734](https://github.com/decolua/9router/issues/2734) | commenter fixes 608ff20/895c567 (in fork), not in upstream master. Both still OPEN | **yes (wiring)**: `open-sse/services/tokenRefresh.js:143-146` maps xai/grok-cli/gcli → `refreshXaiToken` (`open-sse/services/tokenRefresh/providers.js`, with dedup) |
| xAI refresh and discovery use raw `fetch()`, which bypasses the proxy. Refresh fails behind a firewall, then backoff escalates. | [#2737](https://github.com/decolua/9router/issues/2737) | [PR #2343](https://github.com/decolua/9router/pull/2343) (OPEN, draft, needs recut) | **no**: `src/lib/oauth/services/xai.js:56,130,157` use bare `fetch`. There is no global proxy dispatcher (`setGlobalDispatcher` is absent) |
| Kiro proactive refresh → `TypeError: fetch failed` (network). There is no diagnostic of whether it is proxy, DNS or revoked. | [#3384](https://github.com/decolua/9router/issues/3384) | none | partial: generic refresh path; no per-connection "why not renewed" diagnostics |
| Cline background refresh posted form-encoded data. Cline wants JSON `{refreshToken, grantType, clientType}`. | [#3377](https://github.com/decolua/9router/issues/3377) | [PR #3379](https://github.com/decolua/9router/pull/3379) → commit [88676b30](https://github.com/decolua/9router/commit/88676b30); ClinePass refresh [f6e7cabe](https://github.com/decolua/9router/commit/f6e7cabe) | **yes**: `open-sse/services/tokenRefresh.js:150-152` (`refreshClineToken` for cline + clinepass) |
| ClinePass OAuth used the IDE-extension flow and returned 401. ClinePass is API-key auth. | [#2252](https://github.com/decolua/9router/issues/2252), [#2333](https://github.com/decolua/9router/issues/2333) | [PR #2332](https://github.com/decolua/9router/pull/2332) (closed), superseded by f6e7cabe / [122f23ee](https://github.com/decolua/9router/commit/122f23ee) (envelope unwrap) | yes (registry already has clinepass + refresh; not re-verified live) |
| The OAuth `redirect_uri` is hard-coded to `http://localhost:<port>/callback` and ignores the public base URL. This breaks reverse-proxied/headless installs. The code stays valid if the user pastes it. | [#4054](https://github.com/decolua/9router/issues/4054) | none | **no (same code)**: `src/shared/components/OAuthModal.js:295-303`. Caveat: many providers only whitelist loopback redirects, so the realistic fix is a "paste the callback URL" UX plus a clear hint, not a rewrite of redirect_uri |
| Antigravity: `onboardUser` returns `done:true` with an empty `cloudaicompanionProject`. `projectId=""` is saved, retries run 5× per account, and requests then return 429. | [#2932](https://github.com/decolua/9router/issues/2932) | [PR #3452](https://github.com/decolua/9router/pull/3452) (closed: treat done-without-project as terminal and skip refetch on rotation); [PR #4060](https://github.com/decolua/9router/pull/4060) (OPEN: native loadCodeAssist and free-tier provisioning, DoH fallback) | **partial**: `open-sse/services/projectId.js:236-242` still throws and retries on `done:true` without an id (up to MAX_ATTEMPTS with jitter). Eager-refetch storm is fixed (next row) |
| Multi-account Google refresh burst (`Promise.allSettled`) plus eager projectId fetch triggers Google anti-abuse and shadow restriction. | related #2461, #1059 | [PR #3813](https://github.com/decolua/9router/pull/3813) → [1442cc73](https://github.com/decolua/9router/commit/1442cc73ce12d4d30f8a8e6a50a00fbdacb90f18) | **yes**: `src/sse/services/backgroundTokenRefresh.js:96-129` (sequential, `BG_REFRESH_GOOGLE_DELAY_MS` 12s plus jitter); lazy projectId in `src/sse/services/tokenRefresh.js:133-140` |
| OIDC login: "provider did not return an id_token" | [#3642](https://github.com/decolua/9router/issues/3642) | none | n/a (dashboard OIDC; low value) |

Side note (#4000): external companion [pathbit/9RTKSync](https://github.com/pathbit/9RTKSync) states **per connection why it was or was not renewed**. It also notes that `GET openrouter.ai/api/v1/models` returns 200 without auth (use `/api/v1/key`), and that Google AI Studio returns 400, not 401, for a bad key. Useful for our connection-test validators.

## 2. Quota / 429 handling and cooldown policy

| Problem | Issues | Upstream fix | Already in RedRouter? |
|---|---|---|---|
| Antigravity: 429 on an account/model whose quota is exhausted still hits upstream. Fix: an in-memory quota cache keyed by `connectionId+model` until `resetAt`. | [#3561](https://github.com/decolua/9router/issues/3561) | shipped v0.5.59 | **yes**: `src/sse/services/antigravityQuota.js` |
| The quota API reports 90%+ remaining while generation keeps returning 429 (dual-pool mismatch). The result was 61k 429s a day across a 7-account pool. Fix: a strike breaker (3×429 in 60s → 15 min block). | [#3681](https://github.com/decolua/9router/issues/3681) | [ac98dd9d](https://github.com/decolua/9router/commit/ac98dd9d) (PR #3684) | **yes**: `src/sse/services/antigravityQuota.js:19-27` |
| The strike breaker counts **content-triggered** 429s. It blocks all accounts for 15 min and answers 503 instead of the upstream status. | [#4140](https://github.com/decolua/9router/issues/4140) | PR #4197 (prior report) | **yes**: `QUOTA_ERROR_MARKERS` in `src/sse/services/antigravityQuota.js:28-32` (only counts RATE_LIMIT_EXCEEDED / QUOTA_EXHAUSTED / "Individual quota reached") |
| Fake 429s from Antigravity content filters: the Claude Code `x-anthropic-billing-header` line in the system prompt (OpenAI-format input), the Hermes identity string, and `requestType:"agent"`. | [#4138](https://github.com/decolua/9router/issues/4138), [#3358](https://github.com/decolua/9router/issues/3358), #2938 | [PR #4139](https://github.com/decolua/9router/pull/4139); [5798b308](https://github.com/decolua/9router/commit/5798b308) (drop requestType agent, PR #4229) | **yes**: `open-sse/config/appConstants.js:179-187` `ANTIGRAVITY_PROMPT_REWRITES`; `open-sse/translator/request/openai-to-gemini.js:283-310` |
| Antigravity weekly vs short-window quota buckets were conflated, and exhausted pools were still cached. | #3891, PR [#4209](https://github.com/decolua/9router/pull/4209), [#4243](https://github.com/decolua/9router/pull/4243) | [be3bc764](https://github.com/decolua/9router/commit/be3bc764); #4243 closed | not verified here (another fork covers the new commits) |
| A 400 for an invalid parameter (kimi-k3 `thinking_effort=medium`, claude-adaptive `effort:"auto"`, Claude Code `diagnostics` field) is treated as an account failure. That locks every account, and the client sees a **later 429/503 instead of the first meaningful 400**. | [#3794](https://github.com/decolua/9router/issues/3794), [#3786](https://github.com/decolua/9router/issues/3786), [#3875](https://github.com/decolua/9router/issues/3875) | 20a43f5a (prior report); [PR #3792](https://github.com/decolua/9router/pull/3792) (adaptive auto effort); [PR #3871](https://github.com/decolua/9router/pull/3871) (OPEN) | **yes / partial**: `open-sse/services/accountFallback.js:48-62` returns `shouldFallback:false` for unmatched 4xx (except 401/402/403/429). `diagnostics` is stripped in `open-sse/translator/concerns/paramSupport.js:13`. **Gap:** after account exhaustion, `src/sse/handlers/chat.js:477-479` returns the routing candidate message and does not carry the *first* upstream error. The 402/terminal billing rules exist in `open-sse/config/errorConfig.js` |
| The 429 backoff schedule is hard-coded (2s→5min, level 15). Users want environment/per-provider overrides, and Retry-After/`resets_at` honoured everywhere. | [#3343](https://github.com/decolua/9router/issues/3343) | [PR #3352](https://github.com/decolua/9router/pull/3352) (OPEN) | **partial**: Retry-After is honoured (prior report). `BACKOFF_CONFIG` in `open-sse/config/errorConfig.js:37-41` is constant, with no env/per-provider override |
| Quota safety margin: pause or skip an account when remaining quota is at or below X% (for example 15%, or an Antigravity "emergency stop at 90%"). | [#3583](https://github.com/decolua/9router/issues/3583), [#3726](https://github.com/decolua/9router/issues/3726) | [PR #3584](https://github.com/decolua/9router/pull/3584) (OPEN: "pause threshold") | **no**: no threshold in `src/sse/services/auth.js` selection. **Decision signal candidate:** "quota remaining %" per connection |
| Rotate API keys round-robin instead of fill-first to avoid TPM 429s. Same-provider key fallback. | [#2597](https://github.com/decolua/9router/issues/2597), [#2429](https://github.com/decolua/9router/issues/2429) | closed (implemented as provider `fallbackStrategy`) | **yes**: `src/sse/services/auth.js:220-232` (`fill-first` / `round-robin`, per-provider override) |
| Soft errors inside HTTP 200 are treated as success: `choices:null` on NVIDIA ResourceExhausted, the Codex "Our servers are currently overloaded", NaraRouter `outcome=exhausted`, AiHubMix "to prevent abuse of free resources", and CommandCode in-stream `[CommandCode error: … isRetryable:true]`. | [#2727](https://github.com/decolua/9router/issues/2727), [#3232](https://github.com/decolua/9router/issues/3232), [#3242](https://github.com/decolua/9router/issues/3242), [#3602](https://github.com/decolua/9router/issues/3602), [#3468](https://github.com/decolua/9router/issues/3468), [#3729](https://github.com/decolua/9router/issues/3729) | [PR #3315](https://github.com/decolua/9router/pull/3315) (OPEN, Codex overloaded retry); issue-proposal [#3636](https://github.com/decolua/9router/issues/3636) (CommandCode stream error → fallback) | **partial**: CommandCode retries on wrapped 502/503/504 (`open-sse/executors/commandcode.js:50`). There is **no generic "soft-error in 200 body" classifier** (no match for `choices: null`, "currently overloaded", provider-specific phrases). Text-rule list: `open-sse/config/errorConfig.js` `ERROR_RULES` |
| A combo treats an **empty-but-200 stream** as success and never fails over. The stall watchdog fires after the combo has already returned. | [#3463](https://github.com/decolua/9router/issues/3463), [#2188](https://github.com/decolua/9router/issues/2188), [#3977](https://github.com/decolua/9router/issues/3977) | [PR #3560](https://github.com/decolua/9router/pull/3560) (OPEN: `peekStreamForContent` peeks until the first content frame and replays buffered bytes, so the combo can fall through) | **partial**: `open-sse/handlers/chatCore.js:636-650` reconnects the *same* provider up to `EMPTY_STREAM_MAX_RECONNECTS=3` (`open-sse/utils/streamHandler.js:5`). There is no combo-level failover to the next model on an empty stream |
| A failed `GET /v1/videos/{id}` poll (for example a 404 on an unknown or client-controlled id) calls `markAccountUnavailable(..., model=null)`. That sets `modelLock___all`, so the whole account goes down for chat too, and the pin is not honoured. | [#4009](https://github.com/decolua/9router/issues/4009) | [PR #4087](https://github.com/decolua/9router/pull/4087) (OPEN) | **no (same bug)**: `src/sse/handlers/videoGeneration.js:224-226` passes `null` model. The 404 rule (`errorConfig.js`, 2 min cooldown) applies to all models |
| Activating a connection (`testStatus:"active"`) nulls **all** `modelLock_*`, including far-future manual "dead model" locks. | [#4250](https://github.com/decolua/9router/issues/4250); stale-lock clear [7fee56ba](https://github.com/decolua/9router/commit/7fee56ba) (#3830) | none | **same behaviour**: `src/lib/db/repos/connectionsRepo.js:17-32`. Low severity. The real need is a first-class model blocklist (see §4) |
| "Keys fallback broken on v0.5.81, works on v0.5.75" | [#4214](https://github.com/decolua/9router/issues/4214) | no detail | n/a |

## 3. Account bans / fingerprinting / suspension

| Problem | Issues | Upstream fix | Already in RedRouter? |
|---|---|---|---|
| **OpenCode Free: the OpenCode team sent a ToS takedown request.** Free models are "provisioned solely for use from within OpenCode" and may not be proxied, and they ask for `oc/` to be removed within 7 days. Around 09-17 OpenCode also started requiring Console login ("free tier can only be used from within OpenCode"). The 403 FreeTierError gates reverse-engineered by commenters are: canonical `ses_` id, UA `opencode/1.18.31`, the `{bash,glob,grep,read}` tool quartet, and `stream:true`. | [#4182](https://github.com/decolua/9router/issues/4182), [#4183](https://github.com/decolua/9router/issues/4183), [#4101](https://github.com/decolua/9router/issues/4101), [#4124](https://github.com/decolua/9router/issues/4124), [#4127](https://github.com/decolua/9router/issues/4127) | PRs #4105, #4132, #4165, #4188, #4215 (fingerprint cluster, prior report) | **yes (technical)**: `open-sse/executors/opencode.js:18-24,414-416`, `open-sse/utils/opencodeFingerprint.js`, registry `open-sse/providers/registry/opencode.js` (`noAuth:true`). **Risk flag:** the legal/ToS exposure of shipping a no-auth `opencode` free provider (plus `opencode-zen` PAYG is fine). This needs a product decision, not code |
| Antigravity multi-account refresh burst → Google anti-abuse restriction | #2461, #1059 | 1442cc73 | **yes** (see §1) |
| Cursor imported token → `429 "Update Required"` (`ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT`). This is a client-version/fingerprint rejection, not a rate limit, but it is backed off as 429 forever. | [#2487](https://github.com/decolua/9router/issues/2487), [#2766](https://github.com/decolua/9router/issues/2766) | PR #2685 (client version bump) | **partial**: RedRouter bumped the Cursor version (`6994cd1f`), but there is no classification of "Update Required" as a terminal/fingerprint error (grep finds nothing in `open-sse/`, `src/`) |
| Cursor silent empty responses (HTTP 200, OUT 0) since around Sep 10: an AgentService soft-block and empty turns. | [#3977](https://github.com/decolua/9router/issues/3977), #4016 | [c933eefc](https://github.com/decolua/9router/commit/c933eefc) (PR #4017) | **yes**: `open-sse/executors/cursor.js:80,205-222` (`isAgentCapableRequest`, `createRequestContextResponse`, `rejectExecRequest`) |
| Claude Code auto-mode "server-side classifier" is not honoured behind the gateway. The `safeguards` request field and `safeguard_results` response keys are dropped, and the client `anthropic-beta` is **replaced** by a pinned list, so users keep paying for classifier calls. This is the same root cause as the "Extra inputs are not permitted" errors whenever CC ships a new beta. | [#4196](https://github.com/decolua/9router/issues/4196), [#4173](https://github.com/decolua/9router/issues/4173) | none (spec: code.claude.com/docs/en/llm-gateway-protocol#feature-pass-through) | **no**: `open-sse/providers/shared.js:30-36` pins the Anthropic-Beta list; `open-sse/executors/default.js:302` overrides it; `grep safeguard` finds nothing in the routing code |
| Claude Pro account suspended after 1 day of use through the router | [#2931](https://github.com/decolua/9router/issues/2931) | none | n/a (anecdotal). Reinforces the pass-through-fidelity and stable-identity work |
| "Your User ID is temporarily suspended. We detected unusual user activity" (1-minute lock) | [#4102](https://github.com/decolua/9router/issues/4102) | none | n/a. Candidate for a text rule in `ERROR_RULES`, with a short cooldown, not a backoff |
| sub2api relay: "This account only allows Codex official clients" (UA/header fingerprint; cc-switch works) | [#2912](https://github.com/decolua/9router/issues/2912) | none | not verified. Suggests an option to preserve the downstream Codex UA/headers for openai-compatible relays |
| Deno Relay docs "can easily lead to account suspension" | [#2675](https://github.com/decolua/9router/issues/2675) | none | n/a |

## 4. Disabled-model / allowlist gating

| Problem | Issues | Upstream fix | Already in RedRouter? |
|---|---|---|---|
| Disabling a model in the dashboard only writes the `disabledModels` KV, which only `/v1/models` and the UI read. **Routing still sends traffic.** On a dead model id the first request hangs about 250s on connect timeout. The workaround users adopted is a hand-written far-future `modelLock_*`, which activation then wipes (#4250). | [#4246](https://github.com/decolua/9router/issues/4246), [#4249](https://github.com/decolua/9router/issues/4249) | none | **no**: `getDisabledModels` is used only in `src/app/api/v1/models/route.js:392`. Nothing in `src/sse/handlers/chat.js`, `src/sse/services/auth.js` or `open-sse/services/*` consults it |
| Custom and live-catalog providers expose the whole upstream catalog in `/v1/models` (and it is callable). `enabledModels` is read but never persisted. | [#2768](https://github.com/decolua/9router/issues/2768), [#3115](https://github.com/decolua/9router/issues/3115), [#3135](https://github.com/decolua/9router/issues/3135), [#4205](https://github.com/decolua/9router/issues/4205) | PR #4206 (OPEN, allowlist; prior report) | **partial**: `src/app/api/v1/models/route.js:482-515` prefers `providerSpecificData.enabledModels` over the live resolver. But grep shows **no writer of `enabledModels`** anywhere in `src/`, and it is not enforced at routing. (The uncommitted work in `/home/cyber/Work/reddb.io/red-router` on API-key model binding and ModelSelectModal is the natural place to close this) |

---

### 1b. Issue clusters: streaming, tool calls, thinking, images, context/cache

### Part B: decolua/9router issues (streaming, tools, thinking, vision, context/cache), 2026-06-22 to 2026-09-22

Method: read 79 issues with comments (`gh issue view -R decolua/9router`), looked up the PRs that reference them (`gh pr list --search`), searched `git log upstream/master` for the fixes, and grepped the RedRouter release tree at `/tmp/red-router-release-0130` (v0.13.0, `a43e3c51`). "Closed" PRs in 9router often landed as maintainer commits with different hashes; a fix counts as merged only when an upstream commit is cited. Paths are relative to the RedRouter repo root.

Legend: **yes** means RedRouter already handles it (verified in code). **partial** means part of it is handled or the fix is weaker. **no** means the gap is confirmed in code.

Already covered by the 2026-09-20 report (listed here only for completeness): #4192 (usage on `response.completed`), #4208 (non-JSON tool arguments), #4210 (refusal mapped to `content_filter`, now merged upstream as [0f488c70](https://github.com/decolua/9router/commit/0f488c70)), #4170, #4185/#4007 strictProxy, #4206/#4205 allowlist, #4078/#2929 cache affinity, #4197/#4140 content-triggered 429, #4215, #4200, commits 20a43f5a, 93001213, bc3be0cb (#4136).

## 1. Streaming breakage

| Problem | Issues | Fix (PR/commit) | Already in RedRouter? |
|---|---|---|---|
| **No SSE keepalive during upstream silence.** Claude Code shows "Waiting for API response" after ~20s of silence (thinking or prefill). Strict clients like Oh My Pi declare the stream stalled and burn retries. Anthropic itself sends `event: ping`. Design constraint from comments: never insert the ping between `event:` and `data:` (this broke CLIProxyAPI, router-for-me/CLIProxyAPI#4047). OmniRoute's `earlyStreamKeepalive` pings after a few seconds, then about every 1s, and stops at the first real chunk. | [#3409](https://github.com/decolua/9router/issues/3409), [#3796](https://github.com/decolua/9router/issues/3796) | Open PR [#3457](https://github.com/decolua/9router/pull/3457) (`SSE_KEEPALIVE_MS`). Not merged. | **no**. There is no ping on the `/v1` streams (`open-sse/utils/stream.js`, `open-sse/utils/streamHandler.js`). Only the dashboard SSE routes send `: ping`. |
| **Empty-but-200 stream counted as success, so the combo never fails over.** A stream opens, sends only role or keepalive frames (or nothing), and closes cleanly. The combo marks the member as succeeded. A stall after the stream is committed also cannot fail over. | [#3463](https://github.com/decolua/9router/issues/3463), [#2188](https://github.com/decolua/9router/issues/2188), [#3977](https://github.com/decolua/9router/issues/3977) (Cursor OUT 0) | Open PR [#3560](https://github.com/decolua/9router/pull/3560) (combo fails over on empty streams). Open PR [#2462](https://github.com/decolua/9router/pull/2462) (antigravity). Cursor-only fix [c933eefc](https://github.com/decolua/9router/commit/c933eefc). | **partial**. `open-sse/handlers/chatCore/streamResponse.js` `prepareStreamingResponse` retries or returns 502 when the stream ends before its first byte, and `open-sse/utils/streamHandler.js` `reconnectBeforeFirstByte` reconnects up to 3 times. A stream whose first bytes are only role/keepalive frames and that then ends with no content or tool call still passes as success. Detection needs to be content-aware (first *meaningful* frame) before headers are committed. |
| **Stream ends without `finish_reason`, or aborts after HTTP 200.** | [#4080](https://github.com/decolua/9router/issues/4080) | [93001213](https://github.com/decolua/9router/commit/93001213) (prior report) | **yes**. `open-sse/utils/stream.js` (`hasOpenAITerminal`, `finish_reason: "network_error"` terminal) |
| **Client disconnect never records usage or request details.** `cancel()` aborts the transform, so `flush()` and `onStreamComplete` never run. Rows stay at "[Streaming in progress...]" with 0/0 tokens, and tokens the upstream already billed are not counted. The failed row is also saved as `status: success` (#4104). | [#3090](https://github.com/decolua/9router/issues/3090), [#3488](https://github.com/decolua/9router/issues/3488), [#4104](https://github.com/decolua/9router/issues/4104) | Open PRs [#3907](https://github.com/decolua/9router/pull/3907), [#3513](https://github.com/decolua/9router/pull/3513), [#3348](https://github.com/decolua/9router/pull/3348) (recovers partial usage), [#3175](https://github.com/decolua/9router/pull/3175). [#3542](https://github.com/decolua/9router/pull/3542) closed. None merged. | **no**. In `open-sse/utils/streamHandler.js`, `createDisconnectAwareStream.cancel()` calls `reader.cancel()` and `writer.abort()` with no finalize step. `open-sse/handlers/chatCore/streamingHandler.js` `buildOnStreamComplete` always writes `status: "success"`. |
| **Bun runtime never detects client disconnect.** Bun's `res` never emits `'close'`, so the upstream fetch is never aborted and keeps billing. Only `req 'close'`/`'aborted'` and `socket 'close'` fire on both runtimes. | [#3559](https://github.com/decolua/9router/issues/3559) | None merged | **unknown/likely no**. RedRouter ships `dev:bun`/`start:bun`. The abort path in `open-sse/utils/streamHandler.js` also depends on stream `cancel`, which is Next's `res 'close'` signal. Needs a check on Bun. |
| **Missing `stream` field treated as streaming.** The OpenAI default is `false`. | [#3492](https://github.com/decolua/9router/issues/3492), [#4122](https://github.com/decolua/9router/issues/4122) | [#3528](https://github.com/decolua/9router/pull/3528) (closed) and #3878 (open). #4122 is still open upstream. | **yes**. `open-sse/handlers/chatCore/streamMode.js` `clientRequestedStreaming` checks `body.stream === true`. |
| **Forced-SSE-to-JSON path returns a `chat.completion` body to a Claude client.** | [#3682](https://github.com/decolua/9router/issues/3682) | Open PR [#3683](https://github.com/decolua/9router/pull/3683) | **yes**. `open-sse/handlers/chatCore/completionToClient.js` `shapeCompletionForClient` has a `FORMATS.CLAUDE` branch, used by `sseToJsonHandler.js`. |
| **Non-streaming aggregation ignores `reasoning`/`reasoning_details`.** It then reports "empty response" (500) on reasoning-only models. | [#3796](https://github.com/decolua/9router/issues/3796) (bug 2) | None | **unverified**. `open-sse/transformer/streamToJsonConverter.js` should be tested with a reasoning-only stream. |
| Stall watchdog diagnostics. A Codex Responses stall after partial activity cannot be told apart from upstream silence or a half-open socket. `STREAM_FIRST_CHUNK_TIMEOUT_MS` is declared but unused. | [#4072](https://github.com/decolua/9router/issues/4072) | None | **partial**. RedRouter arms the stall timer on raw upstream bytes (`open-sse/utils/streamHandler.js`, `STREAM_STALL_TIMEOUT_MS` = 360s in `open-sse/config/runtimeConfig.js`). The terminal error carries no diagnostics (bytes, last-chunk age). |
| Leaked sockets on the local server (CLOSE_WAIT) after hours of uptime. Stale keep-alive sockets hang provider requests. | [#3796](https://github.com/decolua/9router/issues/3796) comment, [#3710](https://github.com/decolua/9router/issues/3710) | [#3941](https://github.com/decolua/9router/pull/3941) (closed) | not checked (`custom-server.js`) |
| Responses swapped between two concurrent requests to the same model (ZCode title-gen plus main turn). | [#3164](https://github.com/decolua/9router/issues/3164) | None. The root cause is unconfirmed (suspect module-level mutable state in an executor). | **unknown**. This matches the per-instance `_currentSessionId` risk the prior report flagged for OpenCode. Worth a concurrency test. |
| One-provider items: gc/ ANSI codes in SSE ([#2273](https://github.com/decolua/9router/issues/2273), PR [#2299](https://github.com/decolua/9router/pull/2299)); Kiro fully buffered ([#3041](https://github.com/decolua/9router/issues/3041)); codebuddy-cn long-stream break ([#4005](https://github.com/decolua/9router/issues/4005)). | | | skipped (provider quirks) |

## 2. Tool-call translation

| Problem | Issues | Fix (PR/commit) | Already in RedRouter? |
|---|---|---|---|
| **`tool_choice: "none"` becomes `auto` in both directions. OpenAI `allowed_tools` and `parallel_tool_calls:false` are dropped** on the way to Claude. Claude needs `tool_choice.disable_parallel_tool_use`. The upstream test suite already has `it.fails` "KNOWN BUG" cases for this. | [#4171](https://github.com/decolua/9router/issues/4171) | None | **no**. `open-sse/translator/request/openai-to-claude.js` `convertOpenAIToolChoice` maps `"none"` to `{type:"auto"}` (comment: "auto, none, or anything unexpected") even though Claude accepts `none`. `open-sse/translator/request/claude-to-openai.js` `convertToolChoice` has no `none` case, so it defaults to `"auto"`. Neither translator mentions `parallel_tool_calls`. This is a safety issue: "do not call tools" turns into "call freely". It also matters for the decision layer's `forced` tool mode (the Pentatonic audit found the same class of bug). |
| **Tool `strict` not copied to Claude. `developer` role rewritten to `system` even on OpenAI-to-OpenAI.** | [#4172](https://github.com/decolua/9router/issues/4172) | None | **no**. `open-sse/translator/formats/openai.js:20` always normalizes `developer`. `openai-to-claude.js` does not read `strict`. |
| **Responses `function_call_output` without `call_id` produces a `tool_call_id`-less tool message.** Strict upstreams return 400 and the whole combo dies (503). | [#4091](https://github.com/decolua/9router/issues/4091) | Open PR [#4090](https://github.com/decolua/9router/pull/4090) | **yes**. `open-sse/translator/request/openai-responses.js` (~L205, L235-278, repairs the id) |
| **Long MCP tool names truncated to 64 chars with no dedup or reverse map.** Gemini returns "Duplicate function declaration", and OpenAI-compatible providers say "name must be at most 64". Truncated names also cannot be mapped back to the client's name. | [#3622](https://github.com/decolua/9router/issues/3622) | Open PR [#3637](https://github.com/decolua/9router/pull/3637) (name compression) | **no**. `open-sse/translator/request/openai-to-gemini.js` `sanitizeGeminiFunctionName` does `substring(0,64)` with no collision handling. `open-sse/executors/antigravity.js:17` is the same. Fix: hash-suffix plus a per-request `toolNameMap` for the reverse mapping (the infrastructure already exists for the Claude cloaking and Kiro paths). |
| Kiro collapses consecutive underscores in tool names and never restores them. | [#4113](https://github.com/decolua/9router/issues/4113) | [c49efdf5](https://github.com/decolua/9router/commit/c49efdf5) | **likely yes**. `open-sse/translator/concerns/toolCall.js` has underscore-preservation logic. Verify against the upstream test. |
| Foreign `server_tool_use` id (non-`srvtoolu_`) from another provider poisons Claude history (400). | [#3685](https://github.com/decolua/9router/issues/3685) | [ed1bd0c5](https://github.com/decolua/9router/commit/ed1bd0c5) | **yes**. `open-sse/translator/formats/claude.js:190-203` |
| `cache_control` on a `defer_loading` tool gives a 400. Re-anchoring adds a 5th marker, over the limit of 4. | [#3567](https://github.com/decolua/9router/issues/3567), [#3795](https://github.com/decolua/9router/issues/3795) | [6ab9ca9e](https://github.com/decolua/9router/commit/6ab9ca9e), [8a81085a](https://github.com/decolua/9router/commit/8a81085a) | **yes**. `open-sse/translator/formats/claude.js:15-101,349-354` |
| Anthropic `defer_loading` / ToolSearch on a Codex target resets the cache (tools are re-serialized or reordered when a deferred tool is added). | [#3889](https://github.com/decolua/9router/issues/3889) | None | **no/unverified**. There is no handling of `defer_loading` in the Claude-to-OpenAI/Responses direction. |
| Unconditional `type:"custom"` on Claude tools breaks DeepSeek's Anthropic endpoint and other non-Anthropic gateways. | [#3905](https://github.com/decolua/9router/issues/3905), [#3952](https://github.com/decolua/9router/issues/3952) | [#3926](https://github.com/decolua/9router/pull/3926) (closed; scopes defaulting to the gateways that need it) | **partial**. `open-sse/utils/claudeToolTypeSelfCheck.mjs` exists. Scoping to Anthropic-native targets needs confirming. |
| Codex rejects tool schema `pattern` containing `\p{...}`. | [#3922](https://github.com/decolua/9router/issues/3922) | [781c18d8](https://github.com/decolua/9router/commit/781c18d8) | **yes**. `open-sse/utils/codexToolSchema.js` |
| Top-level `anyOf`/`oneOf`/`allOf` in `input_schema` rejected by Anthropic. Proposed fix: sanitize, or fail fast naming the tool. | [#4075](https://github.com/decolua/9router/issues/4075) (points to OmniRoute #13552) | None | **no**. There is no top-level combinator handling in `open-sse/translator/request/openai-to-claude.js`. Only the Gemini cleaner handles `anyOf`. |
| **Gemini schema cleaner treats the `properties` name map as a schema node.** A parameter named `properties` causes a 400 on every request, and a parameter named `title` is silently deleted (common in Notion and Linear MCP tools). | [#2884](https://github.com/decolua/9router/issues/2884) | Open PRs [#3082](https://github.com/decolua/9router/pull/3082), [#3114](https://github.com/decolua/9router/pull/3114) | **no**. `open-sse/translator/formats/gemini.js:307` `ensureObjectType` (and sibling walkers) recurse over every object value. |
| Streamed `input_json_delta` truncated or merged (`start_line`/`end_line` collapsed; OpenAI-to-Claude closes the stream once per finish chunk). | [#3416](https://github.com/decolua/9router/issues/3416), [#2868](https://github.com/decolua/9router/issues/2868) | Open PR [#3520](https://github.com/decolua/9router/pull/3520) (close the OpenAI-to-Claude stream once, not once per finish chunk) | **unverified**. Test `open-sse/translator/response/openai-to-claude.js` with multiple finish chunks. |
| `_ide` cloak suffix leaks on repeated `tool_use` in same-format Claude OAuth streaming. | [#3828](https://github.com/decolua/9router/issues/3828), [#2693](https://github.com/decolua/9router/issues/2693), [#2391](https://github.com/decolua/9router/issues/2391) | Open PR [#3861](https://github.com/decolua/9router/pull/3861) (bundle) | **partial**. `open-sse/utils/claudeCloaking.js` decloaks. The repeated-name and history-replay case needs a regression test. |
| Combo `/v1/models` entries carry no `capabilities`, so Codex downgrades to stub tools. | [#3901](https://github.com/decolua/9router/issues/3901), [#2805](https://github.com/decolua/9router/issues/2805), [#3486](https://github.com/decolua/9router/issues/3486) | [5c217d34](https://github.com/decolua/9router/commit/5c217d34) (capability metadata on /v1/models plus combo aggregation) and PR [#3909](https://github.com/decolua/9router/pull/3909) | **yes**. `src/app/api/v1/models/route.js:270-311` aggregates combo capabilities, using the minimum contextWindow across members. |
| **Native `web_search_20250305` dead-ends on non-Anthropic providers.** It is stripped, so the model answers from memory. Request: emulate it (convert to a function tool, execute through `/v1/search`, rebuild blocks per client format) or reroute to a search-capable model. | [#4011](https://github.com/decolua/9router/issues/4011), [#3133](https://github.com/decolua/9router/issues/3133) | None upstream. The Pentatonic fork has `webSearchEmulation.js` (see the prior report). | **no**. `open-sse/translator/formats/claude.js:564` strips built-in tools. RedRouter has a search service (`open-sse/handlers/search`) that could back it. |
| Anthropic Advisor server-tool passthrough. | [#2582](https://github.com/decolua/9router/issues/2582) | Open PRs [#3931](https://github.com/decolua/9router/pull/3931), [#2649](https://github.com/decolua/9router/pull/2649) | **no** (no mention of `advisor`) |

## 3. Thinking / reasoning

| Problem | Issues | Fix (PR/commit) | Already in RedRouter? |
|---|---|---|---|
| Gemini 3.x `thoughtSignature` dropped on tool-call replay through the OpenAI pivot. Replaying signatures across the Claude/Gemini families is also rejected. | [#3646](https://github.com/decolua/9router/issues/3646), [#4136](https://github.com/decolua/9router/issues/4136) | [c08efbe](https://github.com/decolua/9router/commit/c08efdbe) (persist and replay with a session namespace), bc3be0cb (family scope) | **yes**. `open-sse/services/thoughtSignatureStore.js` plus the Gemini translators |
| Literal `<think></think>` leaks into `delta.content` for Claude-protocol providers. | [#3399](https://github.com/decolua/9router/issues/3399), [#2158](https://github.com/decolua/9router/issues/2158) | [#2160](https://github.com/decolua/9router/pull/2160)/[#2190](https://github.com/decolua/9router/pull/2190) | **yes**. `open-sse/translator/response/claude-to-openai.js:62-70` |
| `delta.reasoning` (DeepSeek via Cline, NVIDIA/vLLM) not normalized to `reasoning_content`. | [#4082](https://github.com/decolua/9router/issues/4082), [#2936](https://github.com/decolua/9router/issues/2936) | Open PR [#3084](https://github.com/decolua/9router/pull/3084) | **yes for translated paths** (`open-sse/translator/concerns/reasoning.js:17-19`). On openai-to-openai passthrough (`createPassthroughStreamWithLogger`), check that `reasoning` is renamed. |
| **Effort level outside the provider's accepted menu.** `xhigh` returns 400 on poolside, 500 on muse-spark, and 400 when rewritten to `max` on third-party deepseek-v4 hosts. Request: a per-model or per-connection effort menu and clamping to the nearest supported level at egress. | [#3939](https://github.com/decolua/9router/issues/3939), [#3572](https://github.com/decolua/9router/issues/3572), [#4149](https://github.com/decolua/9router/issues/4149), [#2538](https://github.com/decolua/9router/issues/2538) | [477b2aed](https://github.com/decolua/9router/commit/477b2aed) (one model), [d1de3245](https://github.com/decolua/9router/commit/d1de3245) (max tier). No generic clamp. | **partial**. `open-sse/providers/thinkingLevels.js` has per-format and per-pattern level menus, but they only drive the UI picker. `open-sse/translator/concerns/thinkingUnified.js` `clampToMax` clamps only to a max level, not to the nearest member of the menu. There are no per-custom-node overrides. |
| Unsupported reasoning params (`enable_thinking`, `thinking`, `reasoning_effort`) forwarded to strict providers (Groq, Mistral, Cerebras) cause 400. | [#3014](https://github.com/decolua/9router/issues/3014), [#2752](https://github.com/decolua/9router/issues/2752) | [7c2b1fe3](https://github.com/decolua/9router/commit/7c2b1fe3) (drops replayed reasoning fields for Groq/Mistral/Cerebras, #4220) | **partial**. `open-sse/translator/concerns/paramSupport.js` has per-provider rules. Port 7c2b1fe3 (merged 2026-09-21, after the prior report). |
| Adaptive thinking with no effort: `claude-adaptive` wrote `effort:"auto"` (400, and the 400 then put the account into backoff). `claude-budget` emits `{type:"enabled"}` without `budget_tokens`. | [#3786](https://github.com/decolua/9router/issues/3786), [#2894](https://github.com/decolua/9router/issues/2894) | [77e6a227](https://github.com/decolua/9router/commit/77e6a227) (#3792) | **partial**. `open-sse/translator/concerns/thinkingUnified.js:272` maps `auto` to `high` (fixed). The claude-budget branch at L275-278 still emits `{ type: "enabled" }` with no `budget_tokens` when `toBudget` returns -1, which is bug 1 of #2894. The "400 locks the account" half is the request/account taxonomy from the prior report. |
| Reasoning history dropped across the OpenAI bridge (Claude/Gemini/Ollama/CommandCode directions). DeepSeek requires `content[].thinking` to be passed back. | [#2400](https://github.com/decolua/9router/issues/2400), [#2397](https://github.com/decolua/9router/issues/2397) | Open PR [#2401](https://github.com/decolua/9router/pull/2401) | not verified per direction |
| OpenAI reasoning models (gpt-5.6-*, gpt-6-astra) reject function tools plus `reasoning_effort` on `/chat/completions` and need `/v1/responses`. Responses targets need nested `reasoning.effort`. | [#4031](https://github.com/decolua/9router/issues/4031), [#2540](https://github.com/decolua/9router/issues/2540), [#3154](https://github.com/decolua/9router/issues/3154) | Open PRs [#2547](https://github.com/decolua/9router/pull/2547), [#4048](https://github.com/decolua/9router/pull/4048), [#3183](https://github.com/decolua/9router/pull/3183) | **partial**. `open-sse/translator/request/openai-responses.js:601` nests `reasoning.effort`. There is no automatic upgrade to Responses for OpenAI-compatible nodes whose model needs it. That could come from the per-model route/`targetFormat` descriptor the prior report recommended. |

## 4. Images / vision

| Problem | Issues | Fix (PR/commit) | Already in RedRouter? |
|---|---|---|---|
| **Vision decided only by name-pattern capabilities, with no user or connection override.** Self-hosted or custom models (qwen3.8, step-3.7, Fireworks, vLLM/LM Studio) default to `vision:false`, so the modality stripper replaces the image with "[image omitted: model has no vision support]". The UI "vision toggle" is ignored. This is the most-reported vision complaint. | [#3568](https://github.com/decolua/9router/issues/3568), [#3590](https://github.com/decolua/9router/issues/3590), [#3836](https://github.com/decolua/9router/issues/3836), [#4211](https://github.com/decolua/9router/issues/4211), [#4092](https://github.com/decolua/9router/issues/4092), [#3455](https://github.com/decolua/9router/issues/3455), [#3752](https://github.com/decolua/9router/issues/3752), [#3762](https://github.com/decolua/9router/issues/3762), [#3809](https://github.com/decolua/9router/issues/3809)/[#3812](https://github.com/decolua/9router/issues/3812) | Upstream added "custom capabilities" in v0.5.65, but issues report it does not apply to custom OpenAI-compatible nodes. [5c217d34](https://github.com/decolua/9router/commit/5c217d34) fixes some patterns. Open bundle [#3861](https://github.com/decolua/9router/pull/3861). | **no**. `open-sse/providers/capabilities.js:42` has `DEFAULT_CAPABILITIES.vision=false`, and `getCapabilitiesForModel` (L564-606) looks only at the provider table, then the canonical table, then patterns, then `refine`. There is no per-connection or per-model override, and no use of an upstream-reported `input_modalities`. `open-sse/translator/concerns/modality.js:61-65` strips. Fix: honour user-declared or discovered modalities ahead of the pattern floor. The remote-catalog work already carries metadata. |
| Image-only `tool_result` (Claude to OpenAI): originally base64 was stringified into the text. Better: forward it as an image part. | [#2122](https://github.com/decolua/9router/issues/2122) | Open PR [#2123](https://github.com/decolua/9router/pull/2123) | **partial**. `open-sse/translator/request/claude-to-openai.js:204-217` replaces the image with an "Omitted image…" placeholder (no inflation, but the model cannot see screenshots). |
| OpenAI to Responses drops image parts in tool-result messages. Codex accepts `input_image` only in the user role, so the fix moves them into a synthetic user message. | [#3864](https://github.com/decolua/9router/issues/3864) | Open PR [#3867](https://github.com/decolua/9router/pull/3867) | **no/unverified**. There is no tool-to-user image relay in `open-sse/translator/request/openai-responses.js`. |
| Kimi K3 plus Codex `input_image` inflates past 1M tokens (image counted as text). | [#3392](https://github.com/decolua/9router/issues/3392) | None | not checked (opencode-go image handling) |
| Provider-specific drops (Kiro, cloudflare-ai, antigravity image-edit, Claude-on-Antigravity), embeddings multimodal. | [#2521](https://github.com/decolua/9router/issues/2521), [#2749](https://github.com/decolua/9router/issues/2749), [#2797](https://github.com/decolua/9router/issues/2797), [#3148](https://github.com/decolua/9router/issues/3148) (PR [#3117](https://github.com/decolua/9router/pull/3117)), [#3825](https://github.com/decolua/9router/issues/3825) | mostly open PRs | skipped (provider quirks) |
| Vision adapter misses images an agent extracts itself (image inside a tool result rather than the user turn). | [#4166](https://github.com/decolua/9router/issues/4166) | None | **likely no**. `open-sse/services/combo.js` `detectRequiredCapabilities` only inspects trailing user items (`trailingUserItems`). |

## 5. Context length, token counting, cache

| Problem | Issues | Fix (PR/commit) | Already in RedRouter? |
|---|---|---|---|
| `count_tokens` counted only text blocks, which broke Claude Code auto-compaction. | [#2337](https://github.com/decolua/9router/issues/2337) | [081c6f2a](https://github.com/decolua/9router/commit/081c6f2a) | **yes**. `src/app/api/v1/messages/count_tokens/route.js:42-44` |
| Streaming path dropped nested `prompt_tokens_details.cached_tokens`, so cache reads were billed at the full input rate (10x on gpt-5.6-sol). | [#2873](https://github.com/decolua/9router/issues/2873) | Open PR [#3083](https://github.com/decolua/9router/pull/3083) | **yes**. `open-sse/utils/usageTracking.js:180-200` |
| Responses-to-Claude usage: `input_tokens` must exclude cached tokens. A reporter also sees a ~2000-token "client context buffer" added. | [#3890](https://github.com/decolua/9router/issues/3890) | Open PR [#3913](https://github.com/decolua/9router/pull/3913) | **partial**. `open-sse/translator/response/openai-to-claude.js:97-99` subtracts cached tokens. The buffer part is unverified. |
| **Context window not propagated or not overridable for custom and proxied models.** Agents cannot compact. Request: discover limits from the provider catalog, allow manual edits, persist them, and expose them in `/v1/models`. | [#3750](https://github.com/decolua/9router/issues/3750), [#3574](https://github.com/decolua/9router/issues/3574), [#3854](https://github.com/decolua/9router/issues/3854), [#2720](https://github.com/decolua/9router/issues/2720), [#2495](https://github.com/decolua/9router/issues/2495) | Open PR [#3858](https://github.com/decolua/9router/pull/3858) | **partial**. `src/app/api/v1/models/route.js:423,619-626` exposes `context_length` from capabilities. There is no per-model user override, and the pattern-guessed defaults are used. |
| Per-component cost breakdown in the dashboard uses a blended token share (cached ≈ 0.1x input, output ≈ 5x). | [#4191](https://github.com/decolua/9router/issues/4191) | Open PRs [#4216](https://github.com/decolua/9router/pull/4216), [#4193](https://github.com/decolua/9router/pull/4193) | not checked (dashboard) |
| Cache hits intermittent due to upstream multi-instance load balancing without affinity. | [#2929](https://github.com/decolua/9router/issues/2929) | See #4078 in the prior report | **no** |

## Signals relevant to the decision layer (from these clusters)

- **Empty-stream rate, TTFT variance, and stall events per provider/model** (#3463, #3796, #4081, #4072) are health inputs that router authors want and nobody has built. They are candidate "provider health" inputs for combo reordering. RedRouter records TTFT in `buildOnStreamComplete` (`latency.ttft`) but does not feed it back into routing.
- **Effective modalities (vision/pdf/audio) plus context window per member.** The vision cluster shows that capability *truth* is the precondition for any smart routing. A router that picks a "vision" member based on a wrong `vision:false` fails silently.
- **Tool policy (`tool_choice` none/required/allowed_tools, parallel) must be preserved.** This is a hard constraint on any decision-layer "forced tool" mode.

---

## 2. Upstream commits since the prior report (a8c9d380..21583c03, v0.5.82 → v0.5.85, 2026-09-19..22)

Baseline for "already in RedRouter?": `/tmp/red-router-release-0130` @ `a43e3c51` (v0.13.0). `git cherry` flags almost every upstream commit as "not identical", but RedRouter ports semantically, so each row was checked by grepping the code.

| Commit | What | Already in RedRouter? |
|---|---|---|
| [b7446f8d](https://github.com/decolua/9router/commit/b7446f8dd1667d92f31f3e352b56a2175d7c0c05), [f84c667d](https://github.com/decolua/9router/commit/f84c667d42eaa5fd7880380bb9adfeacf09fe2f4), [20014b31](https://github.com/decolua/9router/commit/20014b31049220482a1b5395c4f199f6fdba565d), [f28e918e](https://github.com/decolua/9router/commit/f28e918e24314388ef4fd70601c7fc381a2e6b9e), [6431e353](https://github.com/decolua/9router/commit/6431e3530339169e9dd2befa361d7c9fccde1bb1) | Upstream now ships its **own `/v1/systemone` pass-through** (OpenCode Zen `jev-1.13`/`jev-1.13-free` + OpenRouter `typesafe/jev-1.13` lane). The registry's `systemoneConfig` drives URL/headers, and the handler copies the embeddings account-fallback + usage flow. It is a **media-provider kind**, with no chat-pipeline changes: upstream does not route with Jev. | **yes, and more.** RedRouter has multi-lane System One (`open-sse/config/systemOne.js`: typesafe-ai, vercel-ai-gateway, openrouter, opencode-zen) and decision routing (`src/sse/services/decisionRouter.js`, `open-sse/decision/*`). Worth confirming the OpenRouter URL: upstream uses `POST https://openrouter.ai/api/v1/systemone`, which matches `OPENROUTER_SYSTEM_ONE_ENDPOINT`. |
| [5c217d34](https://github.com/decolua/9router/commit/5c217d34f369a13a1362833e679d5e8aee2ef81b) | Capability metadata on `/v1/models`; `aggregateComboCapabilities` (union of vision/audio/search/pdf, intersection of tools, min contextWindow, max maxOutput, nested combos depth≤6) | **yes (own impl)**: `src/app/api/v1/models/route.js:270-420` merges combo member caps (min contextWindow, nested flattening). |
| [da004655](https://github.com/decolua/9router/commit/da0046550accedfd4560c3bfe991f09ece7df097) (PR #4192 merged) | `response.completed` now carries usage (`toResponsesUsage`, capture usage before the empty-choices guard, defer completion to flush) → Codex auto-compaction works | **no.** `open-sse/translator/response/openai-responses.js` still has no `responsesUsage`, and `sendCompleted()` in `open-sse/transformer/responsesTransformer.js:227` emits no `usage`. The prior report flagged this as P0, and it is still open. |
| [0f488c70](https://github.com/decolua/9router/commit/0f488c702706154b2a2c1a95b0f1dcb6ffcfeaa1) (PR #4210) | Claude `refusal` → `content_filter` + explanation | **yes**: `open-sse/translator/response/claude-to-openai.js:158-163`, `schema/finishReasons.js` |
| [7c2b1fe3](https://github.com/decolua/9router/commit/7c2b1fe3e146183674c8d75ff9ef51d9d42b5dad) (#4220) | `dropMessageFields` rule in `paramSupport.js`: strip replayed `reasoning_content`/`reasoning`/`reasoning_details` from assistant turns for **groq, mistral, cerebras** (they 400/422 from turn 2 on, and combos silently skip them) | **no.** There is no `dropMessageFields` in `open-sse/translator/concerns/paramSupport.js`. Cheap and generic. |
| [5798b308](https://github.com/decolua/9router/commit/5798b308419d3798a706b2756e39d59dda9d8a29) (#4229) | Antigravity: drop `requestType:"agent"` (false 429 RESOURCE_EXHAUSTED) | **yes**: `open-sse/executors/antigravity.js:296`, `translator/request/openai-to-gemini.js:283` |
| [be3bc764](https://github.com/decolua/9router/commit/be3bc764b156513b9d4e5acd220d552ce7820d60) (#4209) | Antigravity weekly vs 5h quota buckets | **yes**: `open-sse/services/usage/antigravity-weekly.js`, `usage/google.js:254` |
| [2daf25ff](https://github.com/decolua/9router/commit/2daf25ffbe0bf53b367464e4bf5dc45bb492156f), [782c137b](https://github.com/decolua/9router/commit/782c137b1fd6db0928544a1a08d45b435eb9b885) | Qoder: code 110 billing block as structured 403 quota error; preserve SSE error status in forced-SSE→JSON; prevent signed-request replay through the proxy | **partial**: code 110/112/10605 in `open-sse/executors/qoder.js:339-350`. The replay fix (782c137b, `qoder-proxy-replay.test.js`) was not evident. |
| [402745dc](https://github.com/decolua/9router/commit/402745dc1f30786c09dbee900e0a7326aa0f988c) | New provider **qoder-cn** (qoder.com.cn) | **no** |
| [6886915f](https://github.com/decolua/9router/commit/6886915f62c84d9f65c31afb9c833df9db36e723), [41a1b800](https://github.com/decolua/9router/commit/41a1b8003d54c4609b91e187b6e01da68ee4f53b), [1a027131](https://github.com/decolua/9router/commit/1a02713150685898a3a1032acb2f0af9dad9ecf9) | `mimo-v2.6-flash-free` on OpenCode Zen free tier becomes the **default vision-adapter fallback**, with a settings migration from mimo-v2.5-free | **no** (no `mimo-v2.6-flash-free` in the tree) |
| [c933eefc](https://github.com/decolua/9router/commit/c933eefc2711ab94d3bb0508973f827532c7bd07) | Cursor AgentService: fold system into user, send ModelDetails, MCP tools via `mcp_tools`, RTK pre-translate for cursor | **yes**: `open-sse/executors/cursor.js:114,149`, `utils/cursorProtobuf.js` (RedRouter #29) |
| [d1de3245](https://github.com/decolua/9router/commit/d1de324586ff0e2511f1f29c22be09f379963b84) | lastUsed overlay bounded to 2 days; `budgetToLevel` reaches `max` | **yes** (RedRouter 309a180e, d59877db) |
| [477b2aed](https://github.com/decolua/9router/commit/477b2aed0b7e601956563cd6880eb8cc857ae430) | opencode-go glm-5.3-flash sends reasoning_effort | not checked (catalog detail) |
| [253199f1](https://github.com/decolua/9router/commit/253199f16f0018c7fe2b1889791178566af19e4f) | Combo presets (Cursor/Claude Default) + bulk ops | **yes**: `src/lib/comboPresets.js`, `src/app/api/combos/presets/route.js` |
| [0d50fe36](https://github.com/decolua/9router/commit/0d50fe3610ca2e53a7e91a7e2f4f752ff6b40813), [b53260ca](https://github.com/decolua/9router/commit/b53260ca54b52ec5652a0ec3946ef3f8d09abe07) | Analytics Requests mode, provider/model charts, All Time | **yes/partial** (RedRouter #30 "expand usage analytics") |
| [6c9fe6f7](https://github.com/decolua/9router/commit/6c9fe6f78aa2544a859274f0997ee90baf4fddbe), [49185137](https://github.com/decolua/9router/commit/49185137b8aad5dd564800402a6c02d3fa824ed8), [73e021b8](https://github.com/decolua/9router/commit/73e021b8a00e81d71ffe0f1da000d786c17437d7), [822aa958](https://github.com/decolua/9router/commit/822aa958d19b535f8b02c19bb4e8aa4cf0cdd533) | CLI tools (Pi, OMP, Crush…), OpenCode Zen PAYG, Ollama monthly, OpenCode Responses cloak | **yes** (RedRouter #31, #32, #29) |
| [cf663f53](https://github.com/decolua/9router/commit/cf663f5300035b7a45e05dd5aed15f4d39340ee6) | HuggingFace Inference Providers router migration | **no** (no `router.huggingface.co` in `open-sse`) |

## 2b. PRs opened or changed since 2026-09-19 that the prior report did not cover

| PR | State | What | Already in RedRouter? |
|---|---|---|---|
| [#4213](https://github.com/decolua/9router/pull/4213) (Primexz, +3.8k) | closed unmerged | **Classifier-based `auto-routing` combo strategy.** Uses any *LLM* as classifier (`classifierModel`, non-stream, 128 max tokens, 2s timeout), returns `{"tier":"SIMPLE\|MEDIUM\|COMPLEX\|REASONING"}` with a prompt-injection-hardened rubric. Context = current ask (8k chars) + ≤3 prior turns (8k) + system (2k) + `requiredCapabilities`, with `<system-reminder>` stripped. Tier pool first, combo members as an **emergency pool**, capacity-adapter integration, client-abort propagation through classifier/refresh/stream. Also adds a `performanceSamples` table + `/dashboard/performance` (success rate, p50/p95 latency, p50/p95 TTFT, median output tok/s, failure category per provider/model/connection, 90-day retention) ([autoRouting.js](https://github.com/Primexz/9router/blob/a36f0d62d249ffa5a77542a78fd6a5610618aeef/open-sse/services/autoRouting.js), [performanceMetrics.js](https://github.com/Primexz/9router/blob/a36f0d62d249ffa5a77542a78fd6a5610618aeef/src/lib/performanceMetrics.js)) | **partial.** The tier classifier exists via Jev (`open-sse/services/jevClassifier.js`, `reorderModelsForTier` in `open-sse/services/combo.js:110`). Missing: an LLM-classifier fallback when Jev is unavailable, the emergency-pool split, and the **performance samples/p95 dashboard**. `requestDetails` stores `latency.{ttft,total}` (`src/lib/db/repos/requestDetailsRepo.js:115`) but nothing aggregates it. |
| [#4230](https://github.com/decolua/9router/pull/4230) | open | Smart routing strategy via Jev complexity classifier | **yes**: RedRouter 9652f04a + 67de200f (`jevClassifier.js`) |
| [#4225](https://github.com/decolua/9router/pull/4225) (chisewaguri) | open | Record `latencyMs`/`ttftMs` in `usageHistory` (schema v2), plus avg duration, TTFT and **tok/s** aggregates (only rows with timing count); quota tracker grouped by provider (count, off, empty, soonest reset) | **no**: `src/lib/db/repos/usageRepo.js` has no latency columns |
| [#4241](https://github.com/decolua/9router/pull/4241) (andri-andreal) | open | **Per-API-key limits**: RPM (in-memory sliding window), tokens/day and /month (total/in/out), requests/month, **monthly USD budget** from pricing. Enforced on every `/v1` endpoint after key validation, 429 + `Retry-After` naming the limit, fail-open, `GET /api/keys/usage` | **no** (RedRouter has per-key `allowedConnectionIds`/owner in `src/lib/db/repos/apiKeysRepo.js`, but no limits). Older equivalents: [#2390](https://github.com/decolua/9router/pull/2390), [#1681](https://github.com/decolua/9router/pull/1681) |
| [#4243](https://github.com/decolua/9router/pull/4243) (hifzi) | closed | Antigravity **quota pools** (`gemini` vs `claude_gpt`): quota tracker refresh and background refresh warm the routing cache; 409/429 marks the whole pool exhausted for sibling models; 503 `MODEL_CAPACITY_EXHAUSTED` blocks the pool until reset | **partial**: `src/sse/services/auth.js:118-180` skips AG accounts per exact model at 0% only, lazily after a 409/429. See also [#3969](https://github.com/decolua/9router/pull/3969) (persistent AG quota locks + family mapping + weekly-only free accounts). |
| [#4222](https://github.com/decolua/9router/pull/4222) | open | Responses→Chat: merge message + function_call items of one assistant turn into one chat message (fixes `reasoning_content_missing` 400 on thinking upstreams) | **yes**: `open-sse/translator/request/openai-responses.js:103-183` (`currentAssistantMsg`) |
| [#4224](https://github.com/decolua/9router/pull/4224) | open | CommandCode reference protocol + preserve tool/retry data | not checked in depth |
| [#4227](https://github.com/decolua/9router/pull/4227) | open | New provider OrcaRouter (API key + OAuth PKCE) | no |
| [#4245](https://github.com/decolua/9router/pull/4245) | open | xiaomi-mimo server-assisted desktop login, 5 account clusters, v2.6 models | no |
| [#4216](https://github.com/decolua/9router/pull/4216), [#4242](https://github.com/decolua/9router/pull/4242) | open | per-API-key usage attribution/cost breakdown fixes | see prior report's #4193 note (RedRouter already keys raw) |

## 3b. Older routing PRs that are still open (not in the prior report)

| PR | Idea | Signals / algorithm | Already in RedRouter? |
|---|---|---|---|
| [#2941](https://github.com/decolua/9router/pull/2941) latency-aware account routing (+907) | Account strategy `latency-aware` next to fill-first/round-robin | In-memory TTL rolling window per connection and per connection+model. Order: probe unproven accounts → best score (weighted latency ratio vs fastest + error rate; `latencyToleranceRatio`) → ε-exploration. Per-account circuit breaker, ignored if all are open. Fail-open. Measures TTFB. `/dashboard/routing-health` | **no**: `src/sse/services/auth.js:220-272` only fill-first / round-robin |
| [#2284](https://github.com/decolua/9router/pull/2284) Smart Scoring combo | Health score per combo member | Start at 100. +5 on success, −10 on 5xx, −30 on 429/402, −50 on 401/403, +3/min passive recovery, floor 10, LRU tiebreak | **no** (combo health ranking) |
| [#2045](https://github.com/decolua/9router/pull/2045) task-aware combo routing | light/standard/heavy/critical classes | prompt size, tool count, output budget (`max_tokens`), reasoning hints, task keywords; hard capabilities preserved | **partial** (Jev tier + capabilities; no deterministic scorer) |
| [#584](https://github.com/decolua/9router/pull/584), [#3584](https://github.com/decolua/9router/pull/3584) (issue [#3583](https://github.com/decolua/9router/issues/3583), [#3726](https://github.com/decolua/9router/issues/3726)) | **Minimum quota reserve** (skip an account at ≤X% remaining, default 15%) + post-reset cooldown; background 60s quota monitor; in-memory filter in auth.js | quota remaining % | **no**: RedRouter reads quota for ~15 providers (`open-sse/services/usage/*`) but uses it for routing only for Antigravity at 0% |
| [#2639](https://github.com/decolua/9router/pull/2639), [#2736](https://github.com/decolua/9router/pull/2736), [#4078](https://github.com/decolua/9router/pull/4078) | Session-sticky / cache-affinity account selection (hashed session id, soft escape vs hard rebind, LRU+TTL) | session id, cache warmness | **no** (already recommended in the prior report as P2) |
| [#3842](https://github.com/decolua/9router/pull/3842) | Probe whether an OpenAI-compatible node natively supports `/v1/responses` and store `formatCapabilities`; chatCore passes Responses natively or translates | endpoint capability | **no** (static `targetFormat`) |
| [#3632](https://github.com/decolua/9router/pull/3632) | Global + per-provider connect-timeout | — | partial (`stallTimeoutMs` per provider in `open-sse/handlers/chatCore/streamingHandler.js:132`) |
| [#4074](https://github.com/decolua/9router/pull/4074), [#2453](https://github.com/decolua/9router/pull/2453) | Preserve provider-reported exact `usage.cost.total` (OpenRouter etc.) instead of estimating | real cost | not checked |
| [#3958](https://github.com/decolua/9router/pull/3958) ([discussion #3959](https://github.com/decolua/9router/discussions/3959)) | Privacy/DLP module: 14 PII patterns, reversible pseudonymization, templates | — | **no** |

## External overlay: Skulldorom/9router-auto-router
[Skulldorom/9router-auto-router](https://github.com/Skulldorom/9router-auto-router), linked from issue [#2852](https://github.com/decolua/9router/issues/2852), pushed 2026-09-22. A Docker overlay adds an **"Auto Router" combo strategy that picks between two existing combos (easy/hard)** with a **local deterministic scorer, with no LLM call**. Signals: weighted task phrases (strong ones: "fully audit", "root cause", "race condition", "repository-wide", "multi-file", "debug intermittent"; weak ones: "security", "architecture", "migration"), conversation history depth, accumulated context size (`longContextChars` 24000), actual tool calls/results and large tool output (`largeToolResultChars` 12000), and tool count as *weak* evidence (`manyTools` 16, because agents expose big toolsets even for trivial tasks). `hardThreshold` 6. Only user-task text feeds the semantic score; system/tool output feeds structural signals only. **Fails closed to hard.** Logs score + reason labels without prompt text. RedRouter: **no deterministic pre-scorer.** It would be a free, zero-latency prior and fallback for when Jev/System One is off or its breaker is open (`jevClassifier.js` currently fails open to the static order).

## Feature-request issues that give routing signals

| Issue | Signal requested | Already in RedRouter? |
|---|---|---|
| [#2852](https://github.com/decolua/9router/issues/2852) task-aware smart routing | est. input tokens, #messages, #tools, media presence, tool-result size, task type, thresholds, request-level override header, logged reason | partial (Jev tier; context filter `estimateRequestTokens` in `open-sse/services/combo.js:286`) |
| [#3410](https://github.com/decolua/9router/issues/3410) | separate combo for main chat vs delegated subagent tasks by complexity | no (subagent detection is not a signal) |
| [#3072](https://github.com/decolua/9router/issues/3072), PR [#3255](https://github.com/decolua/9router/pull/3255) | TTFT + total latency per provider/model, p50/p95, `pickFastestProvider()` | no |
| [#3953](https://github.com/decolua/9router/issues/3953) | **time-of-day / off-peak routing** (DeepSeek 50% off-peak; flat-rate subscriptions at peak): `schedule.windows`, `allow_only` or `priority_boost` | no |
| [#2467](https://github.com/decolua/9router/issues/2467) | priority strategy with automatic *return* to the preferred provider after its window resets | partial (fill-first + lock expiry) |
| [#3583](https://github.com/decolua/9router/issues/3583) / [#3726](https://github.com/decolua/9router/issues/3726) | quota safety margin / emergency stop at 90% | no |
| [#3811](https://github.com/decolua/9router/issues/3811) | surface silent failover: which connection served each request (header), "serving 2/3 accounts" badge | partial (routing metadata exists in the RedRouter error descriptor; no per-provider degraded badge found) |
| [#3136](https://github.com/decolua/9router/issues/3136) | rotate on reasoning-phase stream stall | partial (stall timeout emits an error terminal; no pre-first-token failover) |
| [#3788](https://github.com/decolua/9router/issues/3788) | OpenRouter `provider.order` / `allow_fallbacks` per model (price/speed per sub-provider) | no |
| [#4125](https://github.com/decolua/9router/issues/4125)/[#4126](https://github.com/decolua/9router/issues/4126) | Jev as combo strategy | **yes** |
| [#2513](https://github.com/decolua/9router/discussions/2513) (discussion) | "Zero-cost" mode: credential-level gate so billable models cannot be called | no |
| [#4153](https://github.com/decolua/9router/discussions/4153) (discussion) | per-API-key provider/account permissions | **yes** (`allowedConnectionIds` + owner, `src/lib/db/repos/apiKeysRepo.js:89-125`) |
| [#3992](https://github.com/decolua/9router/discussions/3992) (discussion) | ChatGPT hard spend limit returns HTTP 200 → combo never falls back; user patch sniffs the body | see the soft-failure cluster in the issues section |
| [#2860](https://github.com/decolua/9router/issues/2860) | "team" combo: planner → worker → reviewer panel → compressor | partial (fusion/panel+judge in `open-sse/services/combo.js:612-717`) |

---

### 3. Forks (excluding PentatonicDev)

### Part 3: forks of decolua/9router (excluding PentatonicDev)

Snapshot 2026-09-22. `decolua/9router` has 5,619 forks. I paged the whole list with `forks?sort=newest`. 731 forks had a push after they were created and on or after 2026-08-20. Most of those are plain upstream syncs. I picked forks to inspect in depth by stars, by a description that differs from the upstream default, and by ahead_by from `compare/decolua:master...owner:branch`. Per the resource constraint, I inspected about 12 in depth and did not clone any.

RedRouter baseline: `/tmp/red-router-release-0130` (v0.13.0, `a43e3c51`).

The most useful routing work in the fork network is in **OmniRoute** (diegosouzapw/OmniRoute, 69k stars). It descends from 9router but is **not a GitHub fork**. The top-starred fork, VansRouter, benchmarks itself against it. I included OmniRoute because it is the richest source of routing signals.

## Summary table

| Fork (stars, last push) | Divergent feature | Evidence | Already in RedRouter? |
|---|---|---|---|
| [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute) (69k, 09-22; derivative, not a GH fork) | Multi-factor **auto-combo scorer**. Factors: quota, health, costInv, latencyInv, taskFit, stability, tierPriority/Affinity, specificityMatch, contextAffinity, cacheAffinity, sessionAvailability, **resetWindowAffinity**, connectionDensity, feedback **quality**, **reliability** (1 - failure rate). Weights are normalized and user-configurable. | [scoring.ts](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/open-sse/services/autoCombo/scoring.ts) | **partial**. Ordering is fixed-order/round-robin + tier (`open-sse/services/combo.js` `getRotatedModels`, `reorderModelsForTier`), plus Jev choice (`src/sse/services/decisionRouter.js`). There is no weighted multi-signal scorer. |
| OmniRoute | **Rule-based complexity router**. Signals: codeComplexity, mathComplexity, reasoningDepth, contextSize, toolCalling, domainSpecificity. They map to a free/cheap/premium tier, with a **tool-use floor** (never below "cheap" when tools are present). No LLM call. | [complexityRouter.ts](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/open-sse/services/autoCombo/complexityRouter.ts) | **partial**. Complexity tier comes from Jev via `open-sse/services/jevClassifier.js` and is not deterministic. There is no tool-count floor. |
| OmniRoute | **Reset-aware / reset-window quota strategies**. Prefers accounts whose quota resets soonest ("use it before it expires"). Quota-weighted A/B pools, where a snapshot older than 10 min drops to pool B. | [quotaStrategies.ts](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.51/open-sse/services/combo/quotaStrategies.ts) | **partial**. `src/sse/services/auth.js` has fill-first/round-robin/LRU, but reset data is used only to *skip* exhausted Antigravity accounts. |
| OmniRoute | Other strategy modules: speedRanking, providerDiversity, strictZeroCostFilter / paidModelFilter, selfHealing, chaosEngine, modePacks | [autoCombo/](https://github.com/diegosouzapw/OmniRoute/tree/release/v3.8.51/open-sse/services/autoCombo) | **no** |
| [Vanszs/VansRouter](https://github.com/Vanszs/VansRouter) (262, 09-22; 736 ahead) | **Provider circuit breaker** with per-failure-kind thresholds. Defaults: 5 failures, 30s reset, half-open 1, degradation ratio 0.6, backoff escalation up to 16x. Counts 408/5xx/520/524 and ignores local stream-lifecycle errors. Keyed `provider:proxyHash`, so one dead proxy doesn't block the others. | [circuitBreaker.js](https://github.com/Vanszs/VansRouter/blob/main/open-sse/utils/circuitBreaker.js), commits [5606972f](https://github.com/Vanszs/VansRouter/commit/5606972f), [329f37b4](https://github.com/Vanszs/VansRouter/commit/329f37b4) | **partial**. Per-account/model locks are in `open-sse/services/accountFallback.js` and Antigravity strikes in `src/sse/handlers/chat.js:544`. The only breaker is Jev's (`jevClassifier.js`). There is no provider/proxy breaker. |
| VansRouter | **Account semaphore**. Per-`provider:account:proxyHash` concurrency limit (default 1, queue 20, 30s timeout) with `markBlocked(duration)`. It is a guard against bans and 429s caused by parallel bursts on one account. | [accountSemaphore.js](https://github.com/Vanszs/VansRouter/blob/main/open-sse/services/accountSemaphore.js), fix [a8a7ff36](https://github.com/Vanszs/VansRouter/commit/a8a7ff36) (wake race) | **no** (no semaphore or concurrency limit in open-sse/ or src/) |
| VansRouter | Kimchi quota auto-reactivation on the 1st of each month. Gemini 3.7 high/med/low tiered reasoning routing. AgentRouter provider. Cloudflare 520/524 mitigation on large context ([c8fc8e40](https://github.com/Vanszs/VansRouter/commit/c8fc8e40)). | [README comparison table](https://github.com/Vanszs/VansRouter#-comparison-vansrouter-vs-9router-vs-omniroute) | **no** (provider-specific) |
| [Primexz/9router](https://github.com/Primexz/9router) (2, 09-20) via [PR #4213](https://github.com/decolua/9router/pull/4213) (closed unmerged) | `auto-routing` combo strategy. The classifier is **any concrete chat model** with a JSON-only prompt, 2s timeout, and a context of the current ask (8k chars) + 3 prior turns (8k) + system (2k) + detected capabilities. It strips `<system-reminder>` and has prompt-injection-resistant wording. Each of 4 tiers has its **own model pool**, and the combo list is kept as an **emergency pool**. Client abort propagates to the classifier, token refresh and streaming. | [autoRouting.js @a36f0d62](https://github.com/decolua/9router/blob/a36f0d62d249ffa5a77542a78fd6a5610618aeef/open-sse/services/autoRouting.js), [config](https://github.com/decolua/9router/blob/a36f0d62d249ffa5a77542a78fd6a5610618aeef/open-sse/config/autoRouting.js) | **partial**. Tiers exist (`open-sse/config/jev.js` `JEV_TIERS`), but only Jev can classify. Tiers reorder one combo; there are no per-tier pools plus emergency pool. |
| Primexz (same PR) | GitHub Copilot **AI Credits tracking + local usage limits** (`githubCreditLimit.js`). Codex per-account fast mode (`service_tier: priority`). `/v1/models` stale-while-revalidate cache. | PR #4213 [commits](https://github.com/decolua/9router/pull/4213/commits) (5459eec1, 40b68457, 0a5306b4) | Credits: **no**. Fast mode: **partial** (`open-sse/executors/codex.js:495` maps `fast` to `priority`, but it is not a per-account setting). |
| [coozgan PR #4230](https://github.com/decolua/9router/pull/4230) (open) | `smart` combo strategy: Jev complexity tier reorders the combo | PR body | **yes**, `open-sse/services/jevClassifier.js` + `combo.js reorderModelsForTier` (same design) |
| [chisewaguri PR #4225](https://github.com/decolua/9router/pull/4225) (open) | Records `latencyMs`/`ttftMs` in usageHistory. Aggregates average duration, TTFT and tok/s (only over rows that carry timing). | PR body | **partial**. TTFT is stored per request detail (`open-sse/handlers/chatCore/*`, `RequestDetailsTab.js`) but not aggregated, and it is **not a routing input**. |
| [nightwalker89/n9router](https://github.com/nightwalker89/n9router) (44, 09-22; 222 ahead) | **Token Rotate/Swap at the MITM level** for Antigravity. When the IDE's own request gets 401/403/429/500/503, the MITM swaps in another account token and retries. Retry type is classified as auth/permission/quota/server_error, and 401 is detected from `www-authenticate: invalid_token`/`UNAUTHENTICATED`. Per-token cooldown. The fork rejected upstream's SQLite migration. | [tokenSwapRetry.js](https://github.com/nightwalker89/n9router/blob/master/src/mitm/tokenSwapRetry.js), [7a0165aa](https://github.com/nightwalker89/n9router/commit/7a0165aa5a0663434f7219cf9438bff8ab44e15f), [0f54d760](https://github.com/nightwalker89/n9router/commit/0f54d7602bf9e5e760310442d5039a8c1f7ba360) | **no** (`src/mitm/` has no rotation; account fallback exists only on the /v1 path) |
| [lza6/9router-Max](https://github.com/lza6/9router-Max) (0, 09-10; 35 ahead) | **Exact response cache**. Only for non-streaming requests with no tools and an explicit `temperature: 0`. The key includes connectionId. Fail-open. | [2077794f](https://github.com/lza6/9router-Max/commit/2077794f), [responseCache.js](https://github.com/lza6/9router-Max/blob/master/open-sse/handlers/chatCore/responseCache.js) | **no** |
| lza6/9router-Max | **traceId + attemptIndex** shared across combo members and account fallbacks, plus a persisted **route_reason** (clientModel/provider/model/source→target format/transport/stream/account) shown in the Usage drawer. App-level token-bucket rate limit and ready/metrics probes. | [eebd3cb6](https://github.com/lza6/9router-Max/commit/eebd3cb6), [03ea3ec4](https://github.com/lza6/9router-Max/commit/03ea3ec468b7859e34941114f3907dc4c2016282) | **partial**. RedRouter has request IDs and routing metadata in `errorContext` and Jev decision details (`decisionRouter.js saveDecisionDetail`). No per-attempt trace chain was found. |
| [Amir83Nasr/10Router](https://github.com/Amir83Nasr/10Router) (0, 09-22) | OpenCode free-lane **429 breaker**: in-memory backoff with synthetic retry-after, cleared on OK. Treats HTTP 500 as transient in combo retry. Session-scoped request tags. Also ports upstream System One. | [fa09daeb](https://github.com/Amir83Nasr/10Router/commit/fa09daeb) | **partial** (generic cooldown in `accountFallback.js`; nothing specific to the OpenCode free lane) |
| [some-du6e/10router](https://github.com/some-du6e/10router) (1, 09-18; 94 ahead) | OAuth **re-auth action** for invalid tokens ([6dd28286](https://github.com/some-du6e/10router/commit/6dd28286), [ee749791](https://github.com/some-du6e/10router/commit/ee749791)). Keeps tool namespaces alive across the OpenAI pivot ([b8cc1253](https://github.com/some-du6e/10router/commit/b8cc1253)). Repairs Opus 5 assistant prefills ([c9c45fad](https://github.com/some-du6e/10router/commit/c9c45fad)). Matches aliases/combos through a `[1m]` selector ([353bc8b2](https://github.com/some-du6e/10router/commit/353bc8b2)). | commits | not verified per item. They are translator fixes, not routing. |
| [fazulfi/9router-mw](https://github.com/fazulfi/9router-mw) (3, 08-04; 311 ahead) | **Multi-worker** gateway: a dedicated SQLite/PostgreSQL writer process, async repos, OAuth pending sessions shared through Redis, zero-downtime deploy | [369aa8aa](https://github.com/fazulfi/9router-mw/commit/369aa8aa), [0a9cc59b](https://github.com/fazulfi/9router-mw/commit/0a9cc59b) | **no** (single-process; `src/lib/db/driver.js` has no remote DB). Also see [lehuygiang28/9router](https://github.com/lehuygiang28/9router) ("remote database PG"). |
| [capncodes69/9capn](https://github.com/capncodes69/9capn) (140), [mhiqrambg/9router-mibp-version](https://github.com/mhiqrambg/9router-mibp-version) (180), [8mbe/9router](https://github.com/8mbe/9router), [serenhope/9router](https://github.com/serenhope/9router) | Mostly upstream syncs. 9capn adds Qoder bonus/campaign credits in the quota card ([240ebe76](https://github.com/capncodes69/9capn/commit/240ebe76)) and dedupes repeat CodeBuddy/Qoder logins ([140e237d](https://github.com/capncodes69/9capn/commit/140e237d)). MIBP adds a test harness that isolates DATA_DIR ([9c37af90](https://github.com/mhiqrambg/9router-mibp-version/commit/9c37af90)). | commits | low value |
| [thunderkex/9router-extended](https://github.com/thunderkex/9router-extended) (12), [morpheusbr/hiperrouter-app](https://github.com/morpheusbr/hiperrouter-app) | Pluggable skill registry/studio, and an embedded autonomous agent runtime/CLI. Neither is routing work. | READMEs/commits | n/a |

## Per-fork notes

### OmniRoute (non-GitHub-fork derivative; highest value for the decision layer)
- `scoreAutoTargets` computes a weighted sum of about 16 normalized factors. Weights come from `DEFAULT_WEIGHTS` and can be tuned in the UI via `normalizeScoringWeights`. Cold candidates default to neutral: quality 0.5 and reliability 1. A candidate with no data is therefore never penalized. RedRouter should copy this "no data ≠ bad" invariant if it adds scoring.
- The complexity router is deterministic and costs nothing. It could serve as a **pre-filter or fallback** for when Jev is unavailable or its breaker is open, instead of today's "keep original order". The tool-use floor is a cheap, sensible rule: with tools present, don't route to the weakest tier.
- `resetWindowAffinity` and the quota-weighted A/B pools treat a stale quota snapshot as unknown, not empty. That maps to RedRouter's quota data in `open-sse/services/usage/*`.

### VansRouter
- The breaker counts only upstream-attributable failures (408/5xx/520/524) and excludes local stream-lifecycle errors. That is the same request-versus-account split recommended in the 09-20 report. Keying it on the proxy hash is new.
- The account semaphore directly mitigates two things: bans from parallel identical-account bursts, and the 429s seen on OpenCode/Antigravity.

### Primexz auto-routing (PR #4213)
- Compared with RedRouter's Jev tiering, this adds two things: separate **tier pools + emergency pool** semantics, and a **classifier-model-agnostic** backend (any cheap chat model). The second option matters when no Jev route is configured. Classifier cancellation is tied to the client abort signal.

## Candidate decision-layer signals seen in forks (for JEV/System One)
Candidate inputs beyond what `open-sse/decision/state.js` and `jevClassifier.js` use today (conversation text, tool names, required capabilities, estimated tokens for context filtering):
1. Observed TTFT/latency and tok/s per model/account (PR #4225; OmniRoute `latencyInv`, `speedRanking`)
2. Rolling failure rate and a quality feedback score (OmniRoute `reliability`, `quality`)
3. Quota remaining + **time to reset** (OmniRoute `resetWindowAffinity`, quota A/B pools)
4. Provider/proxy breaker state (VansRouter)
5. Account concurrency occupancy (VansRouter semaphore; OmniRoute `sessionAvailability`, `connectionDensity`)
6. Tool presence/count as a tier floor (OmniRoute complexityRouter)
7. Cache/session affinity (OmniRoute `cacheAffinity`, `contextAffinity`; see also upstream PR #4078)
8. Deterministic complexity features (code/math/reasoning depth/context size), usable as a Jev fallback

## Anexo B — LiteLLM

### LiteLLM → RedRouter: what to adopt (research notes, 2026-09-22)

Sources: docs.litellm.ai and the BerriAI/litellm repo (HEAD `88a4cbdd`, 2026-09-22; latest stable v1.101.0 released 2026-09-15, v1.103.0-rc.1 released 2026-09-20).
RedRouter baseline: `/tmp/red-router-release-0130` (v0.13.0, `a43e3c51`).
Status legend for RedRouter: **YES** = already has it, **PARTIAL**, **NO**.

> Headline: LiteLLM's `auto_router/complexity_router` already contains a **`classifier_type: jev`** (TypeSafe System One) plus a
> **TypeSafe/Jev guardrail that compacts old tool results by relevance**. They face the same problem as System One and have
> built a lot of scaffolding around the classifier. Section C covers it, and it is the most useful part of this report.

---

## A. Provider reliability

| Feature | LiteLLM | RedRouter |
|---|---|---|
| Routing strategies | `routing_strategy`: `simple-shuffle` (weight/rpm/tpm-weighted random, the default), `least-busy` (fewest in-flight), `usage-based-routing` v2 (lowest TPM, needs Redis), `latency-based-routing` (`routing_strategy_args.ttl`), `cost-based-routing` (cost map), plus custom `CustomRoutingStrategyBase`. **`routing_groups`** apply a different strategy to a subset of models. [docs/routing](https://docs.litellm.ai/docs/routing), [router_strategy/](https://github.com/BerriAI/litellm/tree/main/litellm/router_strategy) | **PARTIAL**. Combos support `fallback` / `round-robin` (with sticky limit) / `auto` (JEV) / fusion (`open-sse/services/combo.js`). Accounts support `fill-first` / `round-robin` with `stickyRoundRobinLimit` (`src/sse/services/auth.js:218-272`). There is no least-busy, latency or cost strategy at the account or combo level; cost is only used inside JEV tie-breaks (`decide.js cheapestWithinBand`). |
| `order` priority and weighted failover | `order` on each deployment: order=1 gets its retries, then order=2. `enable_weighted_failover` re-picks inside the same group before any cross-group fallback. | **YES**. Account `priority` plus fill-first does the same job. |
| Retries | `num_retries` can be set by header `x-litellm-num-retries`, in the body, per deployment or router-wide. RateLimitError retries use exponential backoff; other errors retry immediately. **`retry_policy`** sets counts per exception type (`AuthenticationErrorRetries: 0`, `ContentPolicyViolationErrorRetries`, `RateLimitErrorRetries`, `DefaultRetries`…). | **PARTIAL**. `ERROR_RULES` in `open-sse/config/errorConfig.js` (text/status → cooldown/backoff/terminal) and `executors/base.js` retry with a Retry-After hook. There is no per-error-class retry count that operators can configure. |
| Fallback types | `fallbacks`, **`context_window_fallbacks`** (on ContextWindowExceededError), **`content_policy_fallbacks`** (cross-provider when the content filter blocks) and `default_fallbacks`. Client-side `fallbacks` go in the body. `disable_fallbacks` can be set per request or per key. Spend logs record `attempted_fallbacks` and `original_model_group`. [docs/proxy/reliability](https://docs.litellm.ai/docs/proxy/reliability) | **PARTIAL**. The combo walks its chain on errors, and the context overflow is caught **before** dispatch (`filterModelsByContext`, `contextOverflowResponse` in combo.js). There is no dedicated content-policy fallback class and no per-request `disable_fallbacks`. |
| Cooldowns | A 429 cools down immediately. Otherwise cooldown starts at >50% failures in the current minute or after `allowed_fails` fails per minute, and lasts `cooldown_time` s. 401/404/408 are non-retryable. **`allowed_fails_policy`** sets thresholds per error type. `model_info.cooldown_time: 0` exempts a deployment. | **YES, and richer on accounts**: exponential backoff levels, per-model locks (`accountFallback.js MODEL_LOCK_*`), and terminal billing rules. |
| Pre-call context check | `enable_pre_call_checks` filters deployments whose `max_input_tokens` can't fit the prompt. The complexity router's `enable_context_window_escalation` moves up a tier with a 0.95 buffer. | **YES**. See `filterModelsByContext` and `capacityAdapter.stripHistoryForContext`. |
| **Health-check-driven routing** | `background_health_checks` + `health_check_interval` (default 300 s) + **`enable_health_check_routing`**. Unhealthy deployments leave the pool, and results go stale after `health_check_staleness_threshold` (default 2× the interval). `health_check_ignore_transient_errors` ignores 429/408. Per model you can set `health_check_model`, `health_check_timeout` and `health_check_max_tokens`. [health](https://docs.litellm.ai/docs/proxy/health), [health_check_routing](https://docs.litellm.ai/docs/proxy/health_check_routing) | **NO**. There's only the manual ping (`src/app/api/models/test/ping.js`) and tunnel health checks. Accounts are learned bad only from failed live traffic. |
| Rate-limit header tracking | Router tracks `rpm`/`tpm` per deployment and returns `x-ratelimit-remaining-{requests,tokens}` (router.py). `io_token_rate_limit_check` tracks ITPM/OTPM separately. `max_parallel_requests` defaults from rpm/tpm (6 req per 1000 TPM). An over-limit request gets a 429 before any upstream call. **Dynamic rate limiter v3**: when a model is over 80% saturated, priority weights are enforced; below that, idle capacity can be borrowed. [README](https://github.com/BerriAI/litellm/blob/main/litellm/proxy/hooks/README.dynamic_rate_limiter_v3.md) | **PARTIAL**. Only Groq/antigravity parse `x-ratelimit-*`. Quota is tracked per provider through `services/usage/*`. There is no generic parser for `x-ratelimit-remaining-*` / `anthropic-ratelimit-*`, and no proactive "remaining < N → deprioritize" logic. |
| Timeouts | `request_timeout`, `stream_timeout`, and a per-deployment `timeout`. | **YES**. `STREAM_FIRST_CHUNK_TIMEOUT_MS`, `STREAM_STALL_TIMEOUT_MS`, a per-provider `stallTimeoutMs`, and `FETCH_CONNECT_TIMEOUT_MS` (`runtimeConfig.js`). |
| Mid-stream fallback | `stream_with_fallbacks` continues on the fallback with a "continue this text" prefix. Known bugs: it corrupts tool calls ([#31067](https://github.com/BerriAI/litellm/issues/31067)), it doesn't fire on cut, stalled or malformed streams ([#40404](https://github.com/BerriAI/litellm/issues/40404)), and partial usage is lost ([#33273](https://github.com/BerriAI/litellm/issues/33273)). | **PARTIAL**. `prepareStreamingResponse` retries empty streams and failures **before the first byte** (`chatCore/streamResponse.js`). Nothing happens after the first byte, which is the right call given LiteLLM's bugs. |
| Provider / deployment budgets | `provider_budget_config: {openai: {budget_limit, time_period: 1d}}` and per-deployment `max_budget` + `budget_duration`. Over-budget providers are skipped. Prometheus exposes `litellm_provider_remaining_budget_metric`. [provider_budget_routing](https://docs.litellm.ai/docs/proxy/provider_budget_routing) | **NO**. Usage is tracked, but there are no USD caps that feed routing. |
| Tag routing | `enable_tag_filtering`. Deployments carry `tags`. Requests send `metadata.tags` or the `x-litellm-tags` header. Syntax supports `!tag` (exclude) and `&tag` (require). There is a `default` tag. **`tag_regex` matches request headers**, e.g. `^User-Agent: claude-code\/`. Keys and teams inherit tags. [tag_routing](https://docs.litellm.ai/docs/proxy/tag_routing) | **PARTIAL**. API keys have `tags` (`apiKeysRepo.normalizeTags`), but they are display-only labels (the file says so). `allowedConnectionIds` restricts accounts per key. |
| Session / deployment affinity | `optional_pre_call_checks: ["session_affinity" \| "deployment_affinity" \| "encrypted_content_affinity" \| "responses_api_deployment_check" \| "prompt_caching"]`. The session id comes from `x-litellm-session-id`, `x-claude-code-session-id` or `metadata.session_id`. **`prompt_caching_deployment_check`** pins to the deployment that already cached the prefix (a prefix hash is written on success, `PROMPT_CACHE_PIN_TTL_SECONDS=300`). `encrypted_content_affinity` encodes the model id into Responses `rs_` item ids. [pre_call_checks/](https://github.com/BerriAI/litellm/tree/main/litellm/router_utils/pre_call_checks) | **PARTIAL**. There's session-scoped JEV verdict memory (`chat.js orderComboModels`, scope = hash of key+combo+session), sticky round-robin, and `thoughtSignatureStore`. There's no explicit "route to the account that holds this cached prefix" logic, and round-robin accounts can break cache. |

## B. Translation & provider quirks

| Feature | LiteLLM | RedRouter |
|---|---|---|
| Param support | `drop_params` (global, per request or per deployment), `additional_drop_params` with JSONPath (`tools[*].input_examples`), `allowed_openai_params` to let a param through, and `get_supported_openai_params(model, provider)`. Default behavior is to **raise** `UnsupportedParamsError`, which users complain about ([#32042](https://github.com/BerriAI/litellm/issues/32042)). [drop_params](https://docs.litellm.ai/docs/completion/drop_params) | **YES** (rule table): `translator/concerns/paramSupport.js STRIP_RULES` (drop, flattenContent, clampToModelMaxOutput, maxOutputCap). It fails open, which is better UX. Worth adding operator-editable rules and JSONPath drops. |
| Reasoning | `reasoning_effort` maps to an Anthropic thinking budget (low 1024 / medium 2048 / high 4096 / xhigh 8192 / max 16384). Responses carry `reasoning_content` + `thinking_blocks` (with signatures). **`reasoning_effort_capability.py`** resolves which effort levels a deployment accepts from `supports_{none,minimal,low,xhigh,max}_reasoning_effort` flags or an explicit `reasoning_effort_levels`, and intersects them across a model group. Medium/high are unconditional, minimal/low are opt-out, xhigh/max are opt-in. [reasoning_content](https://docs.litellm.ai/docs/reasoning_content) | **YES**. `thinkingUnified.js`, `thinkingLevels.js`, combo thinking suffixes, `effortCeilingForDeliberation` (JEV). The per-model allowed-level set concept is worth copying if it's missing. |
| Prompt caching | `cache_control` passes through to Anthropic/Bedrock (`cachePoint`)/Vertex/Gemini. OpenAI gets `prompt_cache_key`/`prompt_cache_retention`, and gpt-5.6+ gets a `prompt_cache_breakpoint`. Usage is normalized to `cached_tokens` / `cache_creation_input_tokens`. **`cache_control_injection_points`** auto-inject breakpoints (`location: message, role: system` or `index: -1`). **`prompt_cache_prediction` hook** stores observed cached-prefix fingerprints with `cached_tokens` + `expires_at` to predict hits. [prompt_caching](https://docs.litellm.ai/docs/tutorials/prompt_caching) | **PARTIAL**. `hasCacheBreakpoint` exists in `decision/state.js` and cache usage in `translator/concerns/usage.js`. There's no automatic breakpoint injection and no cache-hit prediction. |
| Responses API bridge | Both directions: Responses→Chat for non-native providers, and Chat→Responses (`use_chat_completions_api`, `openai/chat_completions/*`). `previous_response_id` storage needs a DB or S3. | **YES** (translators for openai-responses exist). |
| `/v1/messages` unified | An Anthropic-format endpoint over all providers, plus `/v1/messages/count_tokens`. | **YES** (Claude format is a translator source). |
| Capabilities / cost map | `model_prices_and_context_window.json` (+ JSON schema). Fields include `max_input_tokens`, `max_output_tokens`, per-token and cache read/write costs, `mode`, `supports_vision/pdf_input/function_calling/tool_choice/prompt_caching/reasoning/response_schema/web_search`, and per-level reasoning-effort flags. It's fetched remotely at startup (`LITELLM_LOCAL_MODEL_COST_MAP=True` forces local), and a deployment's `model_info` overrides it. [schema](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.schema.json) | **YES**. models.dev sync + snapshot (`src/lib/modelCatalog/sync.js`), `providers/capabilities.js`, `pricing.js`, `pricingRepo`. |

## C. Routing intelligence (candidate JEV/System One inputs)

### C1. `auto_router/complexity_router`
Code: [complexity_router/](https://github.com/BerriAI/litellm/tree/main/litellm/router_strategy/complexity_router) (config.py is about 2.2k lines, complexity_router.py about 4.7k). Docs: [auto_routing](https://docs.litellm.ai/docs/proxy/auto_routing). The old embedding-based `auto_router` (semantic-router + utterances) is now **deprecated**.

The router has four tiers: SIMPLE, MEDIUM, COMPLEX and REASONING (you can rename them with `tier_labels`). A tier maps to a model, a random pool, or objects with per-tier `litellm_params` (e.g. `reasoning_effort: xhigh`, which gives an "effort ladder").

`classifier_type` options:

- `heuristic`: a 7-dimension weighted keyword scorer that runs in under 1 ms. Dimensions are tokenCount 0.10, codePresence 0.30, reasoningMarkers 0.25, technicalTerms 0.25, simpleIndicators 0.05, multiStep 0.03 and questionComplexity 0.02. Boundaries are 0.15/0.35/0.60. Two or more reasoning markers promote to REASONING. System-prompt markers are ignored. `custom_dimensions` allows keywords or bounded regexes.
- `heuristic_v2`: a bundled calibrated success-probability artifact (trained on UltraFeedback). It picks the first tier whose p(success) ≥ threshold (default 0.75).
- `llm`: an LLM picks the tier.
- `capability`: NVIDIA Switchyard prompt. The verdict is `{crux, primary_rule, capability_boundary, p_solve}`. A threshold policy picks efficient vs capable, with the threshold depending on the boundary (supported/uncertain/unsupported). It **fails closed to the capable tier**. It supports an optional **logit calibration** (`slope`, `intercept`, `version`).
- `llm_v2` / "Fuse": a joint forecast of success for an efficient and a capable solver, using **model and harness profiles** (`fuse_presets.json`). This is the same idea as RedRouter's `modelBriefs.js`.
- **`jev`**: calls TypeSafe `/v1/systemone` with one `choice` question named `tier` (`jev_classifier.py`). It logs the call as a `typesafe/<model>` spend row with cost taken from the cost map.
- **`heuristic_first`**: runs the local scorer and skips the classifier when the tier is ≤ `heuristic_first_max_tier` **and** at least one signal fired (a score of 0.0 is not evidence).
- **`hybrid`**: calls the classifier only when the local score is within `hybrid_boundary_margin` of a tier boundary.
- `custom`: a plugin returns a tier or None.

`classifier_fallback` is either `heuristic` or `default_model`. A timeout triggers a **one-attempt hard deadline plus a process-local circuit breaker** (30 s cooldown, then one probe).

Deterministic overrides and signals (all logged as `routing_decision.cause` / `signals`):

- **Harness reminder stripping**: the router removes `<system-reminder>` blocks and, for Codex user agents, `<environment_context>`, `<user_instructions>` and the `# AGENTS.md instructions for …` blocks before classifying. It uses the "last real human ask". For `claude-cli/` and `claude-code/` user agents it drops the caller's system text from the classifier input. `reminder_markers` is configurable.
- **Housekeeping short-circuit** (`route_housekeeping_to_cheapest_tier`, on by default): literal sentinels such as "You are coming up with a succinct title for a coding session" and "Write the title in the predominant language of the session" send the request to the cheapest tier **with no classifier call**. They measured that a title request quoting the whole session otherwise lands on the most expensive tier (17 of 789 calls/day).
- **Plan-mode floor** (`plan_mode_min_tier`): sentinels "Plan mode is active", "Plan mode still active", `You are currently running in "Plan" mode.` and the `exit_plan_mode` tool. It raises the tier for those turns only and never rewrites the pin.
- **Stall escalation** (`stall_escalation_enabled`, window 6, threshold 3): if the **newest** assistant tool call repeats, or errors (Anthropic `is_error`), ≥3 times in the last 6 calls, the request moves up one tier. It is stateless and recomputed from the message list each turn.
- **Escalation keywords** (default `LITELLM ESCALATE`) and `keyword_tier_rules` (optionally semantic, via embeddings).
- **Context-window escalation** and **modality routing**: an image request never lands on a model with `supports_vision:false`. Escalation only walks up, never down. `modality_pin_override` lets an image turn leave its pin once.
- **Session affinity** with an idle TTL (`session_affinity_ttl_seconds`, default 3600). Escalations are never pinned. `classification_mode: user_turn` re-classifies only when a new human ask arrives.
- **`max_tokens_from_tier_model`**: max_tokens is rewritten to the tier model's output ceiling.
- **`context_compaction`**: history is compacted near the selected deployment's input limit.
- **Savings reporting** (`savings_baseline.py`): the baseline is the priciest model in the hardest tier, priced against a fixed reference request (20k in with 19k cached, 1k out). Savings = baseline − routed − classifier cost. **Savings can be negative when cache-creation charges outweigh the cheaper model's savings.**
- A **Test Routing** preview in the UI, plus "Configure automatically" to assign tiers.

### C2. `adaptive_router` (bandit)
Code: [README](https://github.com/BerriAI/litellm/blob/main/litellm/router_strategy/adaptive_router/README.md).

- It classifies each turn into 7 `RequestType` buckets and keeps a **Thompson-sampled Beta posterior per (request_type, model)**.
- Score = `quality_weight·sample + cost_weight·normalized_cost`. Cold-start priors come from `quality_tier` and `strengths`.
- A **post-call signal detector** (`signals.py`, regex and tool-call based) awards credit or blame:
  - satisfaction → +α
  - misalignment, stagnation, disengagement or failure → +β each
  - loop → +0.5β
  - exhaustion → 0
- Feedback in the user's next message is credited to the *previous* responder.
- Callers can send the header `x-litellm-min-quality-tier`.
- Inside the complexity router it can run with `adaptive: true`, which applies `tier_distance_penalty` soft floors and never goes below a capability decision.

### C3. Other routers and hooks
- `quality_router`: complexity → `quality_tier` map, plus per-deployment `keywords` overrides.
- `lar1_routing`: routes on an agent-supplied confidence value (`metadata.lar1`).
- **Router plugins registry** (`router_plugins.json`): third-party plugins that "publish a routing signal" (example: language-detector).
- **`sensitive_data_routing` hook**: a guardrail configured with `on_sensitive_data: route` pins the session to a safe model, stored in cache per tenant and session ([code](https://github.com/BerriAI/litellm/blob/main/litellm/proxy/hooks/sensitive_data_routing.py)).
- **MCP semantic tool filter**: embeds tools as routes and keeps the top-K (10) tools matching the user query ([ARCHITECTURE](https://github.com/BerriAI/litellm/blob/main/litellm/proxy/hooks/mcp_semantic_filter/ARCHITECTURE.md)). This is similar to RedRouter's JEV shortlist sharding.
- **TypeSafe/Jev compaction guardrail**: asks Jev one yes/no question per completed tool exchange ("is this result still needed for the current task?") and blanks results below `relevance_threshold` (0.2). It skips results under 200 chars, caps state at 4000 chars per result, evaluates at most 200 exchanges, and protects the recent turns ([typesafe.py](https://github.com/BerriAI/litellm/blob/main/litellm/proxy/guardrails/guardrail_hooks/typesafe/typesafe.py)).
- Other compaction guardrails: `headroom` and `compresr`.
- Session and agent-loop limiters: `max_iterations_limiter`, `max_budget_per_session_limiter`.

### C4. Guardrails framework
- Modes are `pre_call`, `during_call` (runs in parallel with the LLM call, blocks the response), `post_call`, `logging_only`, and MCP-specific pre-call.
- `default_on`, per-request `guardrails: [...]`, per-key/team assignment, `skip_system_message_in_guardrail`, and mask vs block actions.
- About 60 integrations: Presidio PII, Lakera, Bedrock, Model Armor, OpenAI moderation, `litellm_content_filter`, `tool_permission`, `tool_policy`, `llm_as_a_judge`, `block_code_execution`, `mcp_security`… ([quick_start](https://docs.litellm.ai/docs/proxy/guardrails/quick_start))

**RedRouter status for C.** **PARTIAL**, and strong on the core decision:
- JEV model choice with winner-strength gating, cost tie-break, deliberation → effort ceiling, tool routing (forced/none/hint), shortlist sharding, shadow mode, fail-open breaker, and tier reorder (`open-sse/decision/*`, `services/jevClassifier.js`, `src/sse/services/decisionRouter.js`).

Missing:
- A local pre-classifier (heuristic_first/hybrid) to skip JEV calls
- Reminder/harness stripping in `decision/state.js buildState` (it passes the full system text plus `<system-reminder>` content)
- Housekeeping and plan-mode sentinels
- Stall escalation
- A calibrated `p_solve` style question
- Outcome feedback (bandit)
- JEV relevance compaction
- A sensitive-data → local-model route
- A savings baseline including classifier cost
- A guardrail framework (only `redactHeaders.js`)

## D. Ops

| Feature | LiteLLM | RedRouter |
|---|---|---|
| Virtual keys and budgets | Keys, users, teams and orgs, each with `max_budget`, `budget_duration`, `rpm_limit`, `tpm_limit`, `models` allow-list, `max_parallel_requests`, soft budget alerts, **atomic pre-call budget reservation**, and `enforce_fallback_budget`. | **PARTIAL**. API keys have `allowedConnectionIds`, tags and owner (`apiKeysRepo.js`). There are no USD budgets or rpm limits per key. |
| Response cache | Exact-match (local, redis, s3, gcs, disk) and semantic (redis-semantic, qdrant-semantic). Per-request `cache: {no-cache, no-store, ttl, s-maxage, namespace}`. The docs warn that "any change to the conversation is a miss", so this is poor for agentic traffic. [caching](https://docs.litellm.ai/docs/proxy/caching) | **NO**. This is low value for coding-agent traffic, as LiteLLM itself admits. |
| Observability | Callbacks for Langfuse, OTel, Prometheus, Datadog, S3 and others. Spend logs carry `routing_decision` (cause, signals, tier, classifier cost). Response headers include `x-litellm-model-id`, `x-litellm-attempted-fallbacks`… | **PARTIAL**. There are request details and usage DB, but no OTel/Prometheus export. Worth adding a `x-redrouter-*` decision header and an OTel exporter. |
| MCP gateway | Streamable HTTP, SSE and stdio transports. Tools are namespaced by server prefix. Access is controlled per key and team. Tool cost tracking. OAuth for MCP (PKCE, client credentials, DCR). `require_approval: never` auto-executes tools, but that breaks Claude Code's client tools ([#37031](https://github.com/BerriAI/litellm/issues/37031)). [mcp](https://docs.litellm.ai/docs/mcp) | **PARTIAL**. `src/lib/mcp/stdioSseBridge.js` and `src/app/api/mcp/[plugin]`. |
| Subscription OAuth | Passthrough only: `forward_client_headers_to_llm_api` forwards Claude Code's own Max OAuth header ([tutorial](https://docs.litellm.ai/docs/tutorials/claude_code_max_subscription)). It is buggy on `/v1/messages` ([#42170](https://github.com/BerriAI/litellm/issues/42170), [#42172](https://github.com/BerriAI/litellm/issues/42172) where a token leaks to a third-party api_base). | **RedRouter is far ahead here**: managed multi-account OAuth, token refresh, and quota tracking. The one lesson: **never forward a client's subscription token to a different base URL**. |

## E. Pain points from recent LiteLLM issues (2026-06-22 → 2026-09-22)
These are good regression-test ideas for RedRouter's translators.

- **Zombie 200s.** z.ai GLM Coding Plan quota exhaustion returns `200` with `stop_reason: model_context_window_exceeded` and empty content, so no cooldown or fallback fires. The proposed fix is a `treat_finish_reason_as_failure` policy knob ([#38535](https://github.com/BerriAI/litellm/issues/38535)). RedRouter only handles the 429 "余额不足" form (`errorConfig.js`), so this is a **gap** worth fixing: empty content plus a suspicious finish reason should count as an account failure.
- **Streams failing after the first byte don't fall back** ([#40404](https://github.com/BerriAI/litellm/issues/40404)). Mid-stream continuation corrupts tool calls ([#31067](https://github.com/BerriAI/litellm/issues/31067), fixed by retrying with clean messages when `tools` is present). Mid-stream fallback resolves the chain from the deployment instead of the model group ([#35578](https://github.com/BerriAI/litellm/issues/35578)). SSE error codes outside 100-599 are dropped, so cooldown never fires ([#31284](https://github.com/BerriAI/litellm/issues/31284)).
- **Tool-call streaming.**
  - The re-chunker drops `tool_calls[].id` and `name` when the full call arrives in one delta ([#39796](https://github.com/BerriAI/litellm/issues/39796)).
  - Duplicate `content_block_stop` makes tools execute twice ([#37273](https://github.com/BerriAI/litellm/issues/37273)).
  - Bedrock Mantle tool index starts at 1 ([#32759](https://github.com/BerriAI/litellm/issues/32759)).
  - ollama finishes with `stop` instead of `tool_calls` ([#35663](https://github.com/BerriAI/litellm/issues/35663)).
  - Bedrock emits a trailing empty chunk after finish ([#36767](https://github.com/BerriAI/litellm/issues/36767)).
  - `message_start` is emitted twice ([#32478](https://github.com/BerriAI/litellm/issues/32478)).
- **Tool ids and schemas.**
  - Bedrock `toolUseId` is limited to 64 chars ([#34239](https://github.com/BerriAI/litellm/issues/34239)).
  - Sanitizing tool ids broke vLLM/Kimi ([#32214](https://github.com/BerriAI/litellm/issues/32214)).
  - Gemini rejects `$ref`/`$defs` in tool results ([#38223](https://github.com/BerriAI/litellm/issues/38223)), and recursive schemas hang `unpack_defs` ([#34328](https://github.com/BerriAI/litellm/issues/34328)).
  - `input_schema` vs `parameters` dropped params on Vertex ([#35685](https://github.com/BerriAI/litellm/issues/35685)).
  - Bedrock rejects `strict` on tools ([#33193](https://github.com/BerriAI/litellm/issues/33193)) and 400s on toolless requests with `parallel_tool_calls`/`tool_choice` ([#34420](https://github.com/BerriAI/litellm/issues/34420)), or on tool history without `tools` ([#40735](https://github.com/BerriAI/litellm/issues/40735)).
  - Moonshot rejects empty text alongside tool calls ([#42186](https://github.com/BerriAI/litellm/issues/42186)).
  - Cohere leaks the synthetic `index` field ([#41290](https://github.com/BerriAI/litellm/issues/41290)).
- **Reasoning.**
  - Plaintext reasoning is dropped across tool-call replay on `/v1/messages` ([#37270](https://github.com/BerriAI/litellm/issues/37270)).
  - Encrypted reasoning items are dropped for non-native Responses providers ([#36197](https://github.com/BerriAI/litellm/issues/36197), [#39339](https://github.com/BerriAI/litellm/issues/39339)).
  - Reasoning items rebuilt from summaries break cache byte-stability ([#40288](https://github.com/BerriAI/litellm/issues/40288)).
  - Gemini thought signatures leak to other providers ([#38270](https://github.com/BerriAI/litellm/issues/38270), [#42201](https://github.com/BerriAI/litellm/issues/42201)).
  - The thinking budget exceeds `max_tokens` ([#39627](https://github.com/BerriAI/litellm/issues/39627)).
  - A `reasoning_effort` dict is kept when `summary` is set, which broke Codex CLI ([#39354](https://github.com/BerriAI/litellm/issues/39354)).
  - Beta headers like `thinking-binding-controls` are stripped ([#41202](https://github.com/BerriAI/litellm/issues/41202)).
- **Prompt caching.**
  - Mid-conversation `system` messages change the Gemini/Bedrock prefix every turn ([#42104](https://github.com/BerriAI/litellm/issues/42104), [#32730](https://github.com/BerriAI/litellm/issues/32730)).
  - `cache_control` is dropped through the Responses bridge ([#33687](https://github.com/BerriAI/litellm/issues/33687)).
  - `message_start` reports cache tokens as 0 ([#31069](https://github.com/BerriAI/litellm/issues/31069)).
- **Routing.**
  - Context-window checks were silently skipped for Responses calls ([#33686](https://github.com/BerriAI/litellm/issues/33686)) and on Anthropic `image` blocks ([#36604](https://github.com/BerriAI/litellm/issues/36604)).
  - The auto router ignored vision, so one image broke a session permanently ([#35223](https://github.com/BerriAI/litellm/issues/35223)).
  - Affinity pins flap across replicas ([#41225](https://github.com/BerriAI/litellm/issues/41225)).
  - A caller-supplied timeout pushed the primary into cooldown ([#41223](https://github.com/BerriAI/litellm/issues/41223)). Lesson: client aborts and timeouts must not count as account failures.
  - Streams from concurrent requests contaminated each other ([#35023](https://github.com/BerriAI/litellm/issues/35023)).

## Anexo C — Inventário do RedRouter (System One / JEV e resiliência)

Base: `/tmp/red-router-release-0130` @ `a43e3c51` (v0.13.0). Os caminhos são relativos à raiz do repositório.

**O que é o JEV.** É um modelo de decisão da TypeSafe. Recebe `{model, state, questions}` e devolve `{answers, usage}`. As perguntas são `choice` (uma opção por critério) e `noul` (0..1). Endpoints por gateway:
- TypeSafe: `api.typesafe.ai/v1/systemone`, `jev-latest`.
- OpenRouter: `openrouter.ai/api/v1/systemone`, `typesafe/jev-1.13`.
- Vercel: `ai-gateway.vercel.sh/typesafe/v1/systemone`, `typesafe-ai/jev`.
- OpenCode Zen: `opencode.ai/zen/v1/systemone`, `jev-1.13-free`.

Ordem do `/v1/systemone` público: typesafe-ai → vercel-ai-gateway → openrouter → opencode-zen (`open-sse/config/systemOne.js:2`).

**Caminho A, combo "smart" legado** (`src/sse/handlers/chat.js:270-306`, `open-sse/services/jevClassifier.js`):
- **Entrada:** só o último turno do usuário, até 4000 chars.
- **Pergunta:** `tier` com as opções SIMPLE/MEDIUM/COMPLEX/REASONING (`open-sse/config/jev.js:14-25`).
- **Gate:** confiança ≥ 0.5.
- **Circuit breaker:** 30s, abre só em timeout.
- **Resultado:** reordena o combo pelo `smartTiers`. Não tem shadow mode.

**Caminho B, combo "auto" + tool routing** (`src/sse/services/decisionRouter.js`, `open-sse/decision/*`):
- **Modos:** off/shadow/enforce.
- **Defaults:** provider vercel-ai-gateway, `toolMode` hint, `minStrength` 0.35, `switchStrength` 0.6, `timeoutMs` 1500.
- **`state`** (`state.js:69`): system + conversa em 24k chars, 4k por mensagem, 600 por tool result, até 8 nomes de tool calls por mensagem, `earlier_turns_omitted`.
- **Briefs:** operador → tabela curada → fallback por capability. O fallback por capability acertou 0 de 4 casos medidos.
- **Custo:** só o preço de input, e só em código (cheapest-first + tie-band 0.15).
- **Perguntas:** `model` + `needs_reasoning`; `tool` (+`no_tool_needed`) + `needs_tool`.
- **Pré-filtros em código:**
  - capacity adapters;
  - `rankPool` (expande 1 nível de combos aninhados, deduplica, ordena por preço);
  - allowlist `config.models`; abstém com menos de 2 candidatos;
  - roster de tools acima de 24 é reduzido por sobreposição de palavras com a última mensagem;
  - limite de 120 tools, nomes seguros, `tool_choice` fixado pelo cliente pula a decisão.
- **Decisão de modelo:**
  - strength = `(p1-1/n)/(1-1/n)`;
  - ≥0.6 aplica direto;
  - 0.35–0.6 só se o verdict anterior da sessão concordar;
  - `cheapestWithinBand`;
  - não escolhe o modelo mais barato quando `needs_reasoning ≥ 0.7`.
- **Decisão de tool:** confiança ≥0.7; a escolha precisa concordar com `needs_tool`; com Anthropic `thinking` o modo fica limitado a hint.
- **Memoização:** tools por sha256 de messages+tools, só dentro da request. O verdict fica por (apiKey, owner, combo, sessão) num Map em memória (máx. 5000, com TTL). Não há cache de verdicts de modelo entre requests.
- **Transporte:** 1 retry em 408/429/5xx/529.
- **Log:** `saveRequestUsage` com endpoint `decision` + `saveRequestDetail` (state, perguntas, respostas, probabilidades) + tag `DECISION:` no log.

**Resiliência hoje**

| Área | Onde | Lacuna |
|---|---|---|
| Fallback de conta | `src/sse/handlers/chat.js:467-503` | sem limite além do exclude set |
| Cooldown/locks | `src/sse/services/auth.js:321-380`, `open-sse/services/accountFallback.js:168-198` | `backoffLevel` é por conexão, não por modelo; comentário diz 1s/4min, o código usa 2s/5min |
| Regras de erro | `open-sse/config/errorConfig.js:52-79` | casamento por substring; `terminal` ignorado pelo combo |
| Seleção de conta | `auth.js:218-275` | não considera latência nem quota |
| 429/Retry-After | `open-sse/utils/error.js:201` | `x-ratelimit-*` só para groq/antigravity |
| Retry | `open-sse/executors/base.js:116-200`, `runtimeConfig.js:92` | delays fixos, sem jitter |
| Fallback de combo | `open-sse/services/combo.js:514-605` | sem memória de saúde entre requests |
| Context check | `combo.js:243-370` | roda depois do JEV; modelo desconhecido assume 200k (`capabilities.js:42`) |
| Capabilities | `open-sse/providers/capabilities.js:564` | `maxOutput` não usado |
| Pricing | `open-sse/providers/pricing.js:397` | roteamento usa só input; `long_context` ignorado |
| Token refresh | `open-sse/services/tokenRefresh.js:43`, `src/sse/services/backgroundTokenRefresh.js` | sem lacuna |
| Quota | `open-sse/services/usage/*`, `src/sse/services/quotaReset.js` | só consultada depois de uma falha |
| Health | `src/app/api/providers/[id]/test` | só manual |
| Latência | `chatCore/requestDetail.js`, `streamingHandler.js:169` | gravada, nunca agregada |
