# 9Router upstream: commits recentes e PRs abertos

Date: 2026-09-20
Query: "veja se tem algo que a gente possa aprender com os ultimos commits no repositorio oficial 9router e com os prs ainda em aberto lá"
Scope: comparação semântica entre o RedRouter no commit `468d2065` (`system-one-api`) e o repositório oficial `decolua/9router`, cujo `upstream/master` estava em `a8c9d380`. Foram inspecionados os 31 commits exclusivos após o ancestral comum `17c4cc76`, os 100 PRs abertos mais recentes retornados pelo GitHub e, em profundidade, os candidatos mais próximos dos contratos de routing, Responses, ferramentas, erros, proxy e catálogo. Há 987 PRs abertos no total; este relatório não trata a fila inteira como igualmente confiável nem recomenda merge em massa.

Update: a pesquisa posterior em OpenCode, OpenRouter e Redcode resolveu as incertezas de wire contract registradas aqui. Veja [JEV multi-provider: OpenCode, Redcode e implicações para o RedRouter](./2026-09-20-jev-opencode-redcode-multiprovider.md). Zen usa `/zen/v1/systemone`; OpenRouter usa `/api/alpha/decisions`. Nenhum deles deve passar pelo executor de chat.

## Executive Summary

Há material valioso, mas o caminho correto é importar contratos e testes, não sincronizar o upstream inteiro.

As prioridades imediatas são:

1. **Desacoplar JEV de um único endpoint/provider.** O OpenCode Zen já lista `jev-1.13` e `jev-1.13-free`; o OpenRouter publica `typesafe/jev-1.13`. O RedRouter, porém, modela System One como uma capacidade exclusiva de `typesafe-ai`, enquanto o executor OpenCode decide o protocolo por uma lista fixa de dois modelos Muse. O desenho deve evoluir para “capacidade/protocolo por rota de modelo”, permitindo TypeSafe nativo, OpenCode Zen, OpenRouter e Cloudflare AI Gateway sem fingir que todos expõem o mesmo wire contract.
2. **Portar o cluster de robustez do OpenCode, com rebase local.** Os commits de sessão canônica/estável, streaming forçado e cloaking de ferramentas resolvem 403/429 reais. O PR #4215 corrige uma lacuna do próprio cluster já mergeado: em Responses, os decoys `bash`/`read` também precisam ser inseridos quando o cliente já manda ferramentas.
3. **Fechar três falhas de protocolo de alto impacto:** erro in-band quando um stream cai depois do HTTP 200; usage em `response.completed` para o Codex auto-compactar; e coerção de argumentos inválidos de tool calls antes de enviar a upstreams estritos.
4. **Separar erro da requisição de erro da conta.** Um 400/422 causado pelo payload não deve tirar uma credencial saudável da rotação. O upstream já corrigiu isso para 4xx; o PR #4197 aplica o mesmo princípio a 429 de conteúdo no Antigravity. O contrato canônico de erro do RedRouter já é mais forte que o upstream em `Retry-After`, mas a política de cooldown ainda não incorporou toda essa taxonomia.
5. **Adotar ideias de produto, não necessariamente patches:** allowlist para catálogos vivos (#4206) e afinidade de cache por conversa (#4078) são direções fortes, porém pedem adaptação ao escopo multiusuário, combos e ownership do RedRouter.

Não vale portar: alterações de Docker (a distribuição do RedRouter é npm/binário), branding/9Remote/i18n sem demanda, ou providers isolados apenas por volume de upstream.

## Official Sources

- [9Router official repository](https://github.com/decolua/9router) — código, histórico e fila de PRs do upstream oficial.
- [Recent upstream history through `a8c9d380`](https://github.com/decolua/9router/commits/a8c9d3802c5933500fba95416f5bf0c130581396) — fonte primária dos 31 commits avaliados.
- [OpenCode Zen model catalog](https://opencode.ai/zen/v1/models) — catálogo oficial que lista `jev-1.13` e `jev-1.13-free`.
- [OpenRouter: TypeSafe JEV 1.13](https://openrouter.ai/typesafe/jev-1.13) — página oficial do modelo, contrato de decisão, contexto e preço.
- [RedRouter repository](https://github.com/reddb-io/red-router) — implementação local usada para verificar equivalência semântica.

## Hotlinks

- [Canonical and stable OpenCode session](https://github.com/decolua/9router/commit/6091ff597e61e83c7c06e7dbc25968809a78c891) e [stable identity reuse](https://github.com/decolua/9router/commit/0c6ab4f99b69ecfadcd255f6f2bd793919ab6ff2) — correções de 403/429.
- [OpenCode free-tier request hardening](https://github.com/decolua/9router/commit/93837af09fca065717784895d5c092421bdf1d1b) e [forced upstream streaming](https://github.com/decolua/9router/commit/058ceace48e93379b4f24ac03160d27b894536cf) — contrato real do Zen.
- [PR #4215](https://github.com/decolua/9router/pull/4215) — completa o cloaking de ferramentas em Responses.
- [In-band stream failure after HTTP 200](https://github.com/decolua/9router/commit/9300121366c8baf41df57ff588d81703400a234b) — evita stream truncado parecer sucesso.
- [Request-scoped 4xx must not cool down an account](https://github.com/decolua/9router/commit/20a43f5a2ca491335e623c4ceb7d36cac1f225d7) — separa payload inválido de credencial ruim.
- [PR #4192](https://github.com/decolua/9router/pull/4192) — usage em `response.completed` para auto-compaction.
- [PR #4208](https://github.com/decolua/9router/pull/4208) — garante JSON válido em `function.arguments`.
- [PR #4210](https://github.com/decolua/9router/pull/4210) — preserva recusas Claude como `content_filter`, com explicação.
- [PR #4170](https://github.com/decolua/9router/pull/4170) — saneamento defensivo de JSON Schema para Gemini/Antigravity.
- [PR #4185](https://github.com/decolua/9router/pull/4185) — não deixa `strictProxy` desaparecer no plumbing.
- [PR #4206](https://github.com/decolua/9router/pull/4206) — allowlist de modelos em catálogos vivos.
- [PR #4078](https://github.com/decolua/9router/pull/4078) — cache affinity por conversa com rendezvous hashing.

## Key Findings

### 1. A abstração que falta é rota/capacidade por modelo

O endpoint nativo `POST /v1/systemone` do RedRouter é correto para preservar `state + questions` sem tradução, mas está fixado em `SYSTEM_ONE_PROVIDER_ID = "typesafe-ai"`. Isso não representa a disponibilidade atual do modelo:

- OpenCode Zen lista `jev-1.13` e `jev-1.13-free`.
- OpenRouter publica `typesafe/jev-1.13`, 32K de contexto, preço de entrada `$0.042/M` e saída gratuita.
- Cloudflare AI Gateway deve ser tratado como gateway/rota configurável, não presumido como um wire contract idêntico ao endpoint nativo da TypeSafe.

Ao mesmo tempo, `open-sse/executors/opencode.js` só escolhe `/zen/v1/responses` para dois IDs Muse. Um JEV descoberto pelo catálogo live cai hoje no default `/zen/v1/chat/completions`, o que está incorreto: o OpenCode oficial implementa JEV em `/zen/v1/systemone`, com formato `systemone`, sem streaming e corpo nativo.

**Aprendizado:** `targetFormat`, endpoint, auth, capacidades e normalização não podem depender de listas fixas no executor. O catálogo/model-route deve poder declarar por modelo algo como `serviceKind`, `targetFormat`, endpoint e adapter. Um alias lógico JEV pode então agrupar rotas heterogêneas sem esconder suas diferenças.

### 2. OpenCode precisa ser portado como cluster, não commit solto

Os quatro commits recentes se complementam:

- formato canônico de session/request ID e User-Agent válido;
- reuso estável de sessão por identidade, evitando 429 por churn;
- streaming obrigatório a montante, com agregação local quando o cliente pediu JSON;
- decoy tools exigidas pelo free tier.

O PR #4215 prova que o primeiro merge desse cluster ainda tinha uma condição incompleta: Responses com ferramentas externas pulava a injeção dos decoys e continuava em 403. Portanto, cherry-pick parcial repetiria a regressão.

**Recomendação:** adaptar o estado por requisição — evitando `_currentSessionId` mutável na instância — e trazer os testes de sessão, concorrência, ferramentas e non-stream aggregation juntos. Em seguida, adicionar casos específicos para `jev-1.13` e `jev-1.13-free` antes de anunciar suporte Zen.

### 3. O protocolo Responses ainda tem lacunas objetivas no RedRouter

O PR #4192 captura usage mesmo quando o upstream envia um trailer com `choices: []`, converte para o shape Responses e só então emite `response.completed`. No RedRouter atual, `sendCompleted()` não inclui usage. O stream pode contabilizar usage internamente, mas isso não resolve o contrato do cliente: Codex pode manter o medidor de contexto em 0 e não auto-compactar.

O PR #4208 cobre outro caminho local ainda vulnerável: `ensureToolCallIds()` apenas serializa argumentos-objeto; strings inválidas passam. Na conversão Responses → Chat, `item.arguments` também é copiado sem `coerceResponsesArguments()`. Upstreams estritos respondem 400.

O PR #4200 trata nomes de ferramentas injetados por providers (`functions.exec`) e namespaces, com estado por requisição para impedir vazamento entre requests concorrentes. A ideia é correta, mas o patch é maior e ainda está aberto; deve entrar depois dos dois contratos menores acima.

### 4. Streams devem terminar com erro explícito, nunca silêncio ou falso sucesso

O commit `93001213` emite um frame de erro adequado ao formato quando a conexão aborta ou estagna depois de o HTTP 200 já ter sido enviado. Responses já tinha `response.failed`; OpenAI e Claude ainda podiam terminar silenciosamente.

O RedRouter tem proteções próprias para EOF sem terminal e reconexão de resposta vazia, mas `pipeWithDisconnect()` ainda recebe terminal especial apenas para passthrough Responses. Assim, a correção upstream é complementar, não duplicada.

**Recomendação:** portar o builder de terminal por wire format, integrado ao descritor canônico de erro local, sem fabricar `finish_reason: stop`.

### 5. Cooldown precisa refletir o escopo real da falha

O commit `20a43f5a` evita cooldown para 4xx de requisição não classificados. Hoje `checkFallbackError()` do RedRouter ainda cai no cooldown transitório para qualquer erro não reconhecido. Isso transforma um contexto excessivo ou parâmetro inválido de uma sessão em indisponibilidade da conta para todas as sessões.

O PR #4197 estende o princípio: nem todo 429 do Antigravity prova quota; bloqueios de conteúdo não devem alimentar o breaker. Já o PR #4147 diferencia rate limit transitório de saldo/billing terminal e preserva `Retry-After`.

O RedRouter já lê `Retry-After`, gera descritor canônico, expõe metadata de routing e tem testes de propagação no System One. Portanto, não deve importar #4147 literalmente. Deve aproveitar apenas a parte ausente: `terminal`/billing na política de fallback e a separação request/account/content.

### 6. Quatro PRs abertos ensinam boas invariantes adicionais

- **#4210 — recusas não são respostas vazias bem-sucedidas.** Mapear `stop_reason: refusal` para `content_filter` e exibir `stop_details.explanation`; não fazer fallback automático, pois o bloqueio é da conversa.
- **#4170 — JSON Schema externo é input hostil.** Remover constraints não suportadas e normalizar propriedades shorthand antes de enviar ao Gemini/Antigravity. O cleaner local não cobre `encrypted`, `cache_control`, `strict`, `$id` e `example`, nem normaliza todos os atalhos descritos no PR.
- **#4185 — strict proxy é uma garantia de segurança.** Persistir `strictProxy` não basta se o valor some entre resolução de credencial e `proxyAwareFetch`. O RedRouter armazena e usa o campo em vários caminhos, mas não há evidência de propagação no chat core/auth equivalente aos testes do PR; merece auditoria/teste antes de declarar enforcement fim a fim.
- **#4159 — configuração de registry deve dirigir validação.** Treze providers upstream declaravam `validateUrl`, mas o teste de conexão caía no `switch default`. O RedRouter adicionou TypeSafe em casos especiais, mas ainda deve convergir para validação genérica guiada pelo registry.

### 7. As melhores ideias de produto são allowlist e cache affinity

O PR #4206 mostra uma falha estrutural de blacklist em catálogos vivos: não é possível desabilitar um ID que a UI estática nunca conheceu. Uma allowlist explícita resolve exposição, custo e governança — especialmente relevante às API keys/ownership multiusuário do RedRouter.

O PR #4078 usa rendezvous hashing para manter uma conversa na mesma conta, preservando cache do provider com remapeamento mínimo quando uma conta cai. Isso combina com combos e token saver, mas a chave deve incluir o escopo de tenant/API key do RedRouter para não criar afinidade cruzada entre usuários.

## API / CLI / Config Details

### Matriz JEV desejada

| Rota | Modelo público observado | Contrato que precisa ser provado | Papel recomendado |
|---|---|---|---|
| TypeSafe AI | `jev-latest`, `jev-preview`, `jev-1.13.0` localmente registrados | System One nativo: `state + questions` | rota nativa, sem tradução |
| OpenCode Zen | `jev-1.13`, `jev-1.13-free` | `/zen/v1/systemone`, corpo nativo, sem streaming | rota free/Zen |
| OpenRouter | `typesafe/jev-1.13` | `/api/alpha/decisions`, adapter oficial Decisions | rota paga agregada |
| Cloudflare AI Gateway | depende da configuração de gateway/provider | preservar contrato do upstream escolhido | proxy/gateway, não provider semântico |

### Ordem de implementação sugerida

1. Introduzir descriptor por modelo/rota (`serviceKind`, `targetFormat`, endpoint/adapter), mantendo compatibilidade com registros atuais.
2. Portar o cluster OpenCode completo, incluindo #4215 e testes de concorrência.
3. Fazer smoke controlado de JEV Zen/OpenRouter e registrar o wire contract observado em testes/fixtures.
4. Permitir um alias lógico/combo JEV com fallback apenas entre rotas semanticamente equivalentes.
5. Expor no dashboard origem, contrato e custo de cada rota; não apresentar “JEV” como se todos os providers fossem intercambiáveis sem ressalva.

## Version Notes

- O ancestral comum entre o checkout e upstream é `17c4cc76877bd1755030a8414f8d0083f48dcccf`.
- O checkout possui 124 commits exclusivos; upstream possui 31 commits exclusivos nesse corte.
- `git cherry` marca todos os 31 como patches diferentes, mas isso não significa 31 features ausentes: o RedRouter já adaptou semanticamente vários patches anteriores e tem arquitetura própria de catálogo, erro, multiusuário e distribuição.
- `upstream/master` observado termina em `a8c9d380` e changelog `v0.5.81` de 2026-09-18.
- A fila aberta observada em 2026-09-20 tinha 987 PRs; PR aberto não é baseline estável.

## Gotchas

- O endpoint público `/api/v1/models` do OpenRouter não retornou JEV durante esta consulta, embora a página oficial e o endpoint de embed confirmem o modelo. Isso pode ser propagação ou uma particularidade do adapter de decisões; não codificar descoberta apenas com base naquele snapshot.
- Disponibilidade do mesmo nome de modelo não prova wire-contract idêntico. JEV é um modelo de decisão estruturada, não um chat LLM comum.
- O upstream contém baseline com falhas preexistentes em vários PRs. “Nenhuma nova falha versus baseline” é evidência mais fraca que suíte verde e smoke real.
- Não misturar `strictProxy` com caminhos intencionalmente best-effort de quota/refresh sem decidir explicitamente a política; o PR #4185 trata tráfego de inferência.
- O PR #4193 corrige colisão ao agrupar uso por chave mascarada. O RedRouter já diferencia máscaras com sufixo e mantém chave crua no agrupamento interno; importar literalmente pode conflitar com o hardening que impede vazamento de chave na resposta.
- O PR #4192 deve preservar duas formas de usage: shape de Responses para o cliente e shape normalizado interno para custo/log. Reusar um único objeto perde detalhes.

## Open Questions

1. O Cloudflare AI Gateway citado será BYOK/pass-through para TypeSafe/OpenRouter, ou Unified Billing com catálogo próprio?
2. Fallback entre rotas JEV deve preservar estritamente o mesmo schema/semântica, ou o RedRouter assumirá adaptação entre variantes?
3. A allowlist de modelos será por provider, por API key, por tenant, ou combinada com a política de ownership já existente?

## Source-by-Source Notes

- **Commits `6091ff59`, `0c6ab4f9`, `93837af0`, `058ceace`:** evidenciam que OpenCode free tier depende de identidade estável, headers/formato específicos, streaming e payload de tools — não é apenas um base URL sem auth.
- **Commit `93001213`:** adiciona terminal de erro wire-aware para abort/stall após HTTP 200.
- **Commit `20a43f5a`:** fixa a fronteira entre erro da requisição e saúde da conta.
- **Commit `bc3be0cb`:** escopa thought signatures por família de modelo, evitando replay Claude ↔ Gemini quando combos trocam de membro; bom candidato depois dos itens P0.
- **PRs #4192/#4208/#4210/#4170:** patches pequenos/médios, testes focados e falhas reproduzíveis; são os candidatos abertos com melhor relação impacto/risco.
- **PRs #4200/#4206/#4078:** ideias fortes, mas patches mais amplos; devem virar implementação RedRouter-native, não cherry-pick direto.
- **OpenCode/OpenRouter oficiais:** confirmam que o pressuposto “JEV só existe via API TypeSafe” já está desatualizado.

## Recommended Next Steps

### P0 — próximo lote

1. Criar testes vermelhos para JEV no catálogo OpenCode e para seleção explícita de `/zen/v1/systemone`; não permitir fallback para chat/Responses.
2. Adaptar os commits OpenCode `6091ff59` + `0c6ab4f9` + `93837af0` + `058ceace` junto com PR #4215.
3. Portar semanticamente `93001213`, PR #4192 e PR #4208, usando o error descriptor e a telemetria locais.
4. Corrigir `checkFallbackError()` com a taxonomia request/account/terminal; cobrir 400/422 de payload e 429 de conteúdo.

### P1 — robustez

5. Adaptar #4210 e #4170.
6. Auditar `strictProxy` fim a fim com testes equivalentes a #4185.
7. Escopar thought signatures por família de modelo a partir de `bc3be0cb`.
8. Generalizar validação por `validateUrl` em vez de ampliar switches.

### P2 — produto/arquitetura

9. Desenhar allowlist multiusuário inspirada em #4206.
10. Prototipar cache affinity com tenant/API-key no hash, inspirada em #4078.
11. Só então considerar #4200, devido à amplitude do estado de namespace/tool names e ao risco de concorrência.

### Explicitamente não recomendado

- merge/rebase geral de `upstream/master`;
- importar Docker publish (#4198) para uma distribuição que deliberadamente removeu Docker;
- usar contagem de commits/PRs como critério de prioridade;
- anunciar suporte multi-provider JEV antes de provar e fixar o contrato de cada rota.
