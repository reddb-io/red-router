# JEV multi-provider: OpenCode, Redcode e implicações para o RedRouter

Date: 2026-09-20
Query: "sim, estuda opencode, mas veja redcode tbm!"
Scope: OpenCode oficial (`anomalyco/opencode` em `dev`), OpenRouter oficial, Redcode `origin/main` v0.40.3 e o checkout atual do RedRouter. O objetivo é estabelecer o protocolo real de cada rota JEV e extrair contratos reutilizáveis; nenhuma inferência autenticada ou paga foi executada.

## Executive Summary

O ponto central está confirmado: **JEV não é um modelo de chat e não deve depender exclusivamente da API direta da TypeSafe**.

- O OpenCode oficial criou um formato de inferência separado, `systemone`, e publica JEV em `POST /zen/v1/systemone` como `jev-1.13` e `jev-1.13-free`.
- O OpenRouter publica `typesafe/jev-1.13` pelo endpoint especializado `POST /api/alpha/decisions`; a documentação e os SDKs oficiais confirmam que esse endpoint fica fora de `/api/v1`.
- O Redcode v0.40.3 já implementa a abstração correta no consumidor: um papel de evaluator System One com adapters distintos para Zen, OpenRouter, TypeSafe, RedRouter, Cloudflare AI Gateway, Vercel, Vivgrid e NanoGPT.
- O RedRouter ainda está estruturalmente preso a `SYSTEM_ONE_PROVIDER_ID = "typesafe-ai"`. Seus registries de OpenCode, OpenRouter e Cloudflare só descrevem caminhos generativos/mídia, enquanto o handler `/v1/systemone` sempre escolhe credenciais TypeSafe e sempre chama `api.typesafe.ai`.

Portanto, o RedRouter deve copiar a **separação protocolo/rota** do Redcode e a **disciplina de formato** do OpenCode, não transformar JEV em mais um modelo no executor de chat. O contrato público pode continuar sendo `POST /v1/systemone`; internamente ele precisa selecionar uma rota System One e aplicar o adapter nativo daquela rota.

## Official Sources

- [OpenCode commit `1573a7b6`: support jev](https://github.com/anomalyco/opencode/commit/1573a7b608eb13c45a2243201964c7784f2a8281) — adiciona formato, rotas, adapter, uso e testes.
- [OpenCode Zen System One route](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/v1/systemone.ts) — endpoint sem streaming e com `format: "systemone"`.
- [OpenCode System One provider helper](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/util/provider/systemone.ts) — corpo nativo, bearer auth, afinidade e usage.
- [OpenCode Zen documentation](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/zen.mdx#jev) — IDs, exemplos `noul`/`choice`/`score`, preço e oferta gratuita temporária.
- [OpenCode issue #50032](https://github.com/anomalyco/opencode/issues/50032) — demonstra a falha causada quando JEV entra no default de modelos generativos.
- [OpenCode PR #50107](https://github.com/anomalyco/opencode/pull/50107) — PR aberto que torna modelos sem família, incluindo JEV, visíveis; não resolve a separação de protocolo.
- [OpenRouter JEV 1.13](https://openrouter.ai/typesafe/jev-1.13) — modelo público com modalidade de saída `decisions` e adapter `TypeSafeDecisionsAdapter`.
- [OpenRouter TypeScript SDK: Decisions](https://github.com/OpenRouterTeam/typescript-sdk/blob/main/src/funcs/alphaDecisionsCreate.ts) — confirma `POST /api/alpha/decisions` e a resposta `DecisionsResponse`.
- [OpenRouter cookbook: JEV verified cascade](https://github.com/OpenRouterTeam/docs/blob/main/cookbook/evaluate-and-optimize/jev-verified-cascade.mdx) — exemplo oficial com `typesafe/jev-1.13`, `state` e `questions`.
- [Redcode commit `2a7bf1f9`](https://github.com/reddb-io/redcode/commit/2a7bf1f94f) — catálogo e onboarding multi-provider para System One.
- [Redcode commit `28ac03e7`](https://github.com/reddb-io/redcode/commit/28ac03e7e2) — adiciona OpenRouter Decisions explicitamente.
- [Redcode v0.40.3](https://github.com/reddb-io/redcode/releases/tag/v0.40.3) — estado publicado que contém os adapters avaliados.

## O que o OpenCode realmente implementou

### Um protocolo separado

O gateway Zen adicionou `systemone` ao enum de formatos ao lado de `anthropic`, `google`, `openai` e `oa-compat`. A rota:

- lê `model` do corpo;
- seleciona somente providers cujo formato seja `systemone`;
- declara `parseIsStream: () => false`;
- encaminha o corpo sem tradução;
- adiciona bearer auth e `x-session-affinity`;
- normaliza `usage.input_tokens` e `usage.output_tokens`.

O endpoint público documentado é:

```text
POST https://opencode.ai/zen/v1/systemone
```

com:

```json
{
  "model": "jev-1.13-free",
  "state": { "candidate": "..." },
  "questions": {
    "check": { "type": "noul", "instructions": "..." }
  }
}
```

Isso elimina a incerteza do levantamento anterior: no Zen, JEV **não** usa `/chat/completions` nem `/responses`.

### A integração ainda é do gateway, não do agent loop

O código oficial oferece o transporte e documenta o uso, mas não usa JEV internamente para decidir compaction, task completion ou validação do agente. A proposta de auto model picker do PR #50139 foi fechada sem merge.

Há ainda uma fronteira quebrada no catálogo do OpenCode: a issue #50032 mostra `jev-1.13-free` sendo escolhido como default de uma sessão generativa porque era o modelo mais recente. Isso falha porque JEV não é chat/tool model. O aprendizado é direto: visibilidade no catálogo não significa elegibilidade para qualquer papel.

## O que o Redcode já resolveu

O Redcode v0.40.3 separa três conceitos que o RedRouter ainda mistura:

1. **Papel:** principal/fast são generativos; evaluator é System One.
2. **Protocolo:** modelos conhecidos recebem `capabilities.protocol = "systemone"` e são excluídos dos seletores generativos.
3. **Transporte:** cada provider tem endpoint, autenticação, envelope e descoberta próprios.

### Matriz implementada no Redcode

| Transporte | Modelo default | Endpoint/adapter |
| --- | --- | --- |
| OpenCode Zen | `jev-1.13-free` | `/zen/v1/systemone`, corpo nativo |
| OpenRouter | `typesafe/jev-1.13` | `/api/alpha/decisions`, corpo nativo Decisions |
| TypeSafe | `jev-1.13.0` | `/v1/systemone`, corpo nativo |
| RedRouter | `jev-1.13.0` | `/v1/systemone`, corpo público canônico |
| Cloudflare AI Gateway | `typesafe/jev` | `/accounts/{account}/ai/run`, `state/questions` sob `input` |
| Vercel AI Gateway | `typesafe-ai/jev` | `/v4/ai/evaluation-model`, headers v4 e normalização de resposta |
| Vivgrid | `jev` | `/v1/systemone`, corpo nativo |
| NanoGPT | `typesafe/jev-latest` | `/api/v1/systemone`, corpo nativo |

Outros contratos positivos no Redcode:

- conexões já configuradas aparecem primeiro;
- a credencial do provider é reutilizada apenas no origin oficial esperado;
- Zen free é o default de instalação nova, mas não substitui configurações existentes;
- indisponibilidade do modelo gratuito não provoca fallback pago silencioso;
- avaliação malformada/ausente falha fechada e preserva o estado anterior;
- provider, modelo, policy, respostas, usage e decisão ficam registrados para auditoria.

Os testes focados do checkout Redcode passaram: **27 testes / 111 assertions** em Core (`intelligence` + `models`) e **4 testes / 13 assertions** no setup TUI. Isso valida os adapters com servidores locais/fixtures; não substitui smoke autenticado contra os providers externos.

## OpenRouter: correção da descoberta anterior

O lembrete do usuário estava correto. O modelo existe publicamente como `typesafe/jev-1.13`, mas é uma modalidade `decisions`, não um modelo de chat. Por isso sua ausência eventual em `/api/v1/models` ou em catálogos orientados a chat não é evidência de indisponibilidade.

O SDK oficial fixa:

```text
POST https://openrouter.ai/api/alpha/decisions
```

e recebe o mesmo núcleo semântico `{ model, state, questions }`. A resposta é `DecisionsResponse`, com `answers` e `usage`; exemplos oficiais mostram `noul`, `choice`, probabilidades e confidence. O adapter publicado pelo OpenRouter é `TypeSafeDecisionsAdapter`.

## Gap exato no RedRouter

Hoje o RedRouter possui uma boa superfície pública, mas uma implementação mono-rota:

- `POST /v1/systemone` preserva corretamente `state + questions`;
- `GET /v1/models/systemone` separa o catálogo por `kind`;
- erros, `Retry-After`, uso e rotação entre contas TypeSafe já existem;
- porém `SYSTEM_ONE_PROVIDER_ID` é constante `typesafe-ai`;
- `handleSystemOne()` sempre pede credenciais TypeSafe;
- `handleSystemOneCore()` sempre resolve `PROVIDER_MEDIA["typesafe-ai"].systemOneConfig`;
- `normalizeSystemOneModel()` remove prefixos como `typesafe/`, o que destruiria IDs necessários a OpenRouter e Cloudflare;
- o executor OpenCode atual conhece `/responses` apenas para IDs Muse e envia os demais modelos ao chat, portanto não pode ser reutilizado para JEV.

A correção não é ampliar uma lista de IDs no executor. É fazer System One resolver uma **rota tipada**.

## Arquitetura recomendada para o RedRouter

### 1. Descriptor de rota System One por provider

Cada registry elegível deve declarar algo equivalente a:

```js
systemOneConfig: {
  protocol: "systemone",
  baseUrl,
  modelIds,
  buildRequest,
  normalizeResponse,
  validateUrl,
  contextWindow,
  maxStateAndQuestionTokens,
}
```

Não é necessário expor callbacks no dado serializado; o registry pode apontar para um adapter nomeado. O importante é que endpoint e envelope pertençam à rota, não a condicionais globais em `handleSystemOneCore()`.

### 2. Manter `/v1/systemone` como contrato canônico

O cliente envia sempre `{ model, state, questions }`. O router:

1. resolve provider/connection/model sem apagar o ID específico;
2. converte para o envelope nativo da rota;
3. normaliza a resposta para o shape System One;
4. preserva headers seguros, usage e taxonomia de erros;
5. tenta fallback apenas entre rotas semanticamente compatíveis e autorizadas.

### 3. Separar identidade lógica de ID upstream

Um alias lógico como `jev-1.13` não deve ser enviado literalmente a todos:

- Zen quer `jev-1.13` ou `jev-1.13-free`;
- OpenRouter quer `typesafe/jev-1.13`;
- TypeSafe quer `jev-1.13.0`/aliases;
- Cloudflare quer `typesafe/jev`.

O combo/alias deve apontar para membros `{ provider, model }`, e a rota deve preservar o ID do membro.

### 4. Catálogo orientado a capacidade

JEV deve aparecer em `models/systemone`, nunca como generative default. O Redcode comprova que `protocol: systemone` é mais seguro que heurísticas por nome, `output=0` ou família. A issue #50032 do OpenCode é um teste de regressão pronto para essa fronteira.

### 5. Política explícita de custo e fallback

Zen free é temporário. Nenhuma falha nele deve ativar OpenRouter/TypeSafe pago sem opt-in. Uma rota pode declarar classe de custo (`free`, `paid`, `byok`) e os combos devem exigir uma política que autorize cruzar classes.

## Ordem de implementação revisada

### P0

1. Generalizar o core atual de `SYSTEM_ONE_PROVIDER_ID` para um descriptor de rota, preservando TypeSafe como primeiro adapter.
2. Adicionar OpenCode Zen nativo em `/zen/v1/systemone`; não passar pelo executor de chat OpenCode.
3. Adicionar OpenRouter Decisions em `/api/alpha/decisions`; não passar por `/api/v1/chat/completions`.
4. Cobrir preservação dos IDs upstream, auth, `Retry-After`, usage, 4xx request-scoped e 429/529 account-scoped.
5. Fazer o catálogo e `/v1/models/systemone` agregarem as rotas compatíveis sem colocá-las nos modelos generativos.

### P1

6. Adicionar Cloudflare `/ai/run` com account/gateway ID e envelope próprio.
7. Adicionar combos JEV com política de custo explícita e afinidade por sessão.
8. Expor no dashboard provider real, modelo upstream, custo e motivo do fallback.

### P2

9. Avaliar Vercel, Vivgrid e NanoGPT após testes de contrato autenticados.
10. Permitir descoberta via models.dev sem transformar catálogo em verdade suficiente sobre protocolo ou disponibilidade.

## Gotchas

- Mesmo corpo semântico não significa mesmo URL, auth ou envelope.
- `typesafe/jev-1.13` não deve ser normalizado para `jev-1.13` antes de chegar ao OpenRouter.
- O endpoint Decisions do OpenRouter fica em `/api/alpha`, fora da base `/api/v1` usada por chat e pelo SDK sem override.
- O `jev-1.13-free` do Zen é temporário e não garante acesso anônimo permanente.
- `x-session-affinity` no OpenCode é parte do comportamento do gateway; o RedRouter deve decidir se encaminha uma afinidade estável por sessão ou deixa o Zen atribuí-la.
- O Redcode está mais adiantado no desenho do consumidor, mas seus testes externos são fixtures. Ainda faltam credenciais/smokes reais para afirmar interoperabilidade operacional de todas as rotas.
- A adaptação Vercel muda `noul` para `boolean`; isso precisa de conformance tests de sentido/probabilidade antes de ser copiado para o router.

## Version Notes

- OpenCode `dev` inspecionado em `d870e22c70f27103016dcd479edcfebf86136d93` (2026-09-20).
- O suporte JEV do OpenCode entrou em `1573a7b6` em 2026-09-18 e ainda não consta na release mais recente `v1.18.31` (2026-09-14).
- Redcode `origin/main` inspecionado em `67ec7264db0dd8b8c7e37435da34952732d51ae7`, tag `v0.40.3`.
- RedRouter inspecionado em `468d2065`, branch `system-one-api`.

## Conclusão

O melhor aprendizado conjunto é simples: **System One é uma capacidade; JEV é uma família de modelos; TypeSafe, Zen, OpenRouter e Cloudflare são rotas com contratos de transporte diferentes**. O Redcode já modela essa distinção no consumidor. O próximo passo certo no RedRouter é torná-la nativa no roteador, mantendo `/v1/systemone` estável para os clientes.
