# Pentatonic/9router: routing, ferramentas e oportunidades para RedRouter

Data: 2026-09-22. Janela examinada: 2026-08-25 a 2026-09-22.

## Conclusão

Há oportunidades fortes, principalmente observabilidade das decisões, execução em shadow, seleção entre modelos realmente disponíveis, shortlist de ferramentas e limites de reasoning. Recomendo adaptações pequenas sobre o System One nativo do RedRouter, não merge integral do fork. O núcleo novo mudou várias vezes nos últimos dois dias e ainda tem falhas de contrato não cobertas pelos testes existentes.

Esta é uma investigação com proposta de implementação; nenhuma feature do fork foi ativada no RedRouter.

## Escopo e fontes fixadas

- Fork: [PentatonicDev/9router em 0635f966d693998ed788d12dfa16a951603c6c23](https://github.com/PentatonicDev/9router/tree/0635f966d693998ed788d12dfa16a951603c6c23).
- RedRouter: `8660b5ae7953e1d451911c1d3a885b20408095a3`, release **v0.11.9**, consultado no worktree `/tmp/red-router-catalog-release`. O HEAD do checkout original é anterior; não foi usado como baseline final.
- Ancestral comum: `17c4cc76877bd1755030a8414f8d0083f48dcccf`.
- Distância entre linhas: 191 commits do RedRouter / 151 do fork; 121 commits recentes do lado do fork sem equivalência de patch detectada por `--cherry-pick --no-merges`. Isso não significa 121 funcionalidades ausentes.
- Inventário de 271 commits na janela, incluindo merges. O filtro Git usa data de committer; algumas datas de autoria são anteriores.
- Estudo profundo: pipeline de decisões, integração no chat, tradução de ferramentas, contabilização, testes e benchmark. Bedrock, administração, orçamento e coordenação distribuída receberam triagem arquitetural, não validação completa de produção.

Artefatos locais da investigação: `/tmp/pentatonic-9router-review`, `/tmp/pentatonic-all-recent-commits.txt`, `/tmp/pentatonic-unmatched-recent.txt`.

## O que mudou nas últimas semanas

| Frente | Implementação observada | Valor para nós |
| --- | --- | --- |
| Model routing com Jev | Escolha entre membros expandidos de combos; fitness primeiro, preço como desempate; confirmação antes de algumas trocas | Evoluir além do classificador por tier existente |
| Tool routing | Shortlist determinística, pergunta tipada, hint ou escolha forçada depois da tradução | Ajudar agentes com catálogos grandes de ferramentas |
| Observabilidade | Decisão como requisição própria, custo separado, perguntas/respostas/probabilidades e motivo no detalhe do chat | Medir benefício e explicar mudanças de rota |
| Reasoning | Teto por combo, membro e turno; sinal de deliberação reutilizado | Controlar custo sem trocar sempre o modelo |
| Bedrock Converse | Executor, IAM/API key, discovery, inference profiles, cache, thinking, preço por ID | Novo provider completo; precisa ser portado como conjunto |
| Web search | Emulação da server tool Anthropic em providers sem execução nativa | Compatibilidade para clientes Claude |
| Distribuição | Leases no banco e coordenação de refresh OAuth | Evitar corridas entre processos que compartilham credenciais |
| Gestão | Chaves administrativas/management, spend ledger/caps, escopo dos detalhes | Útil para instâncias compartilhadas; exige revisão de autorização |
| Qualidade | Banco isolado por execução de testes, restauração de globals, provas usando transporte real | Melhorar confiabilidade da nossa suite |

Marcos do núcleo novo: [28847b0e](https://github.com/PentatonicDev/9router/commit/28847b0e) introduz decisões; [9693f02a](https://github.com/PentatonicDev/9router/commit/9693f02a) introduz shortlist; [7f8fa41d](https://github.com/PentatonicDev/9router/commit/7f8fa41d) limita reasoning por turno; [2a78c085](https://github.com/PentatonicDev/9router/commit/2a78c085) separa fitness de custo; [f0bf82ef](https://github.com/PentatonicDev/9router/commit/f0bf82ef) corrige o conjunto perguntado; [0635f966](https://github.com/PentatonicDev/9router/commit/0635f966) muda o gate para winner strength. A implementação intermediária de perguntar só profundidade de reasoning já foi substituída.

## Como o model routing funciona no HEAD estudado

1. Apenas combos com estratégia `auto` entram na decisão; configuração `off` preserva a ordem.
2. `rankPool` expande um nível de combos, elimina duplicatas e ordena por preço de input conhecido. Não é expansão recursiva geral.
3. A pergunta descreve os modelos do conjunto efetivamente expandido. O estado textual tem orçamento de 24 mil caracteres; conteúdos multimodais são reduzidos a representações textuais/placeholders.
4. Jev responde uma escolha de modelo e um sinal `needs_reasoning`.
5. O código desempata por preço entre probabilidades dentro de uma banda absoluta de 0,15. Matemática de preço fica fora do modelo.
6. O gate usa `(max(p) - 1/n) / (1 - 1/n)`, com limiar padrão 0,35 e troca imediata em 0,60. Na faixa intermediária, exige repetir o último veredito.
7. Em enforce, o escolhido vai à frente dos demais membros; a cadeia normal de fallback continua. Em shadow, registra a decisão sem mudar a ordem.

Fontes: `src/sse/services/decisionRouter.js`, `src/sse/handlers/chat.js`, `open-sse/decision/{decide,questions,state,modelBriefs,jev}.js`.

**O que já temos:** `jevClassifier.js` classifica SIMPLE/MEDIUM/COMPLEX/REASONING, `reorderModelsForTier` aplica uma política explícita e `reorderByCapabilities` mantém modalidades como critério posterior. Temos timeout, circuit breaker, preservação de ordem quando a avaliação falha, provider TypeSafe e `/v1/systemone` nativo com fallback de contas e proxy. Não precisamos substituir essa infraestrutura por uma chamada direta ao gateway do fork.

**O salto útil:** escolher entre candidatos elegíveis do turno em vez de depender apenas de um mapa estático de tiers. Elegibilidade deve continuar determinística: permissões, modalidade, contexto, endpoint, disponibilidade e limites. Só depois Jev compara adequação; custo estimado pode desempatar. Preço de input sozinho não representa custo total, especialmente com cache e reasoning/output caros.

Winner strength é uma heurística de seleção, não uma probabilidade calibrada de sucesso da tarefa. Os thresholds do fork não devem virar defaults nossos sem dados locais. Nosso classificador atual tem quatro tiers fixos; o problema de variar a quantidade de opções não se transfere automaticamente para ele.

## Como o tool routing funciona

1. A decisão ocorre depois da tradução do corpo e antes do executor: trabalha com os nomes que o provider realmente recebe.
2. A shortlist usa sobreposição lexical com a última solicitação e algumas ferramentas anteriores; limita a 24 candidatos. O módulo também mantém limite geral de 120 opções e helpers de uma estratégia anterior.
3. Pergunta separadamente necessidade de ferramenta e escolha. O estado tem orçamento de 6 mil caracteres.
4. `off` não chama o avaliador; `hint` adiciona recomendação; `forced` escreve `tool_choice`. Shadow apenas observa.
5. Extended thinking Anthropic rebaixa forced para hint. Executores binários/NDJSON como Kiro e Cursor ficam fora desse caminho.
6. Uma closure por requisição memoriza decisões para não cobrar novamente em toda tentativa de conta.

Isso escolhe **qual ferramenta pedir ao modelo**. Não é um executor MCP, não executa as ferramentas do cliente e não transfere autorização ao Jev. A emulação de web search é uma funcionalidade separada que realmente executa busca no gateway.

Para nós, hint deve ser o primeiro modo ativo. Forçar ferramenta só deve existir como opção explícita, respeitando `none`, ferramenta fixada pelo cliente, schemas de cada protocolo e restrições de thinking. A shortlist precisa medir recall: uma escolha confiante não ajuda se a ferramenta correta foi excluída antes da pergunta.

## Problemas confirmados e riscos de portar literalmente

### 1. Mutação de instrução explícita do cliente — reproduzido

`applyToolChoice({tool_choice:'none'}, OPENAI, {mode:'forced',tool:'Bash'})` troca `none` por uma função forçada. O caminho inspecionado não bloqueia a decisão por existir escolha explícita anterior. Preservar `none`, escolhas fixadas e demais contratos do chamador deve ser uma condição anterior ao avaliador.

### 2. Veredito pode sair do conjunto permitido — reproduzido no resolvedor

`resolveModelDecision` valida a escolha inicial, mas `cheapestWithinBand` percorre todos os IDs em `probabilities`. Com modelos `[a,b]`, probabilidades `{a:0.57, outsider:0.43, b:0}`, preço menor para `outsider`, deliberação 0,1 e veredito anterior `outsider`, retorna `{apply:true, model:'outsider', reason:'confirmed'}`. O caller coloca esse ID à frente da lista.

É um teste com resposta inconsistente do avaliador, não evidência de que o serviço real produziu esse payload. Ainda assim, o contrato precisa rejeitar IDs extras, números inválidos e distribuições inválidas antes de desempatar, e validar novamente o modelo final.

### 3. Confirmação compartilhada entre sessões — confirmado por leitura

O Map `lastVerdicts` usa somente `comboName`, e o caller passa exatamente esse nome. Uma decisão de outro usuário/sessão no mesmo combo pode confirmar a próxima. Não há TTL nesse Map. Usar identidade de sessão e escopo de credencial/owner, com expiração; sem identidade confiável, não supor continuidade de sessão.

### 4. Forced tool no protocolo Responses — reproduzido no serializador

`applyToolChoice` produz `{type:'function', function:{name:'Read'}}` também para Responses. Esse é o shape de Chat Completions; Responses usa o nome no nível superior. Não fiz chamada externa para medir a rejeição. Precisamos de contratos separados por formato e teste via executor real.

### 5. Função exportada quebrada — reproduzido, alcance limitado

`decideSwitch({confidence:1,verdict:'a'})` lança `ReferenceError: DEFAULT_SWITCH_CONFIDENCE is not defined`. O pipeline novo usa `decideStrength`, portanto isso não prova quebra do caminho principal. É resíduo da refatoração e não aparece nos testes verdes.

### 6. Memoização por tamanho, não conteúdo — confirmado por leitura

`decisionSignature` concatena número de turnos, tamanho serializado do último turno e quantidade de ferramentas. Corpos diferentes com os mesmos tamanhos colidem. O cache é restrito à requisição, o que limita o alcance; ainda é inadequado quando retries/transformações mudam conteúdo mantendo os tamanhos. Usar hash do estado relevante, roster e restrições.

### 7. Outros pontos que exigem adaptação

- `priceOf` considera apenas preço de input. Não chamar isso de otimização do custo total.
- Histórico truncado e descrições curadas afetam a qualidade. O estado é texto lossy, especialmente para tarefas multimodais.
- O cliente Jev tem timeout por tentativa e retry de algumas falhas; alinhar o orçamento total ao prazo da requisição e propagar cancelamento/proxy pela nossa infraestrutura.
- Hint modifica a última mensagem de usuário, que pode não ser a última posição do histórico. O impacto em cache precisa ser medido, não inferido de comentários.
- O gate de ferramenta ainda usa confidence bruta; a mudança para winner strength só foi feita para modelo.
- A configuração de teto de reasoning é opt-in, mas o sinal pode ser transportado mesmo quando o gate não aplica a troca de modelo. Definir separadamente quando o sinal de esforço é utilizável.

## Funcionalidades adjacentes

**Bedrock:** [5f84f41f](https://github.com/PentatonicDev/9router/commit/5f84f41f) e correções posteriores formam um pacote: SDK, credenciais, discovery, IDs de inference profiles, tradutores Converse, cache, thinking, preços e testes. Não basta copiar o executor. A UI de quotas teve adição e revert; avaliar a árvore final. Não havia executor correspondente no baseline consultado.

**Busca emulada:** [bf08d9df](https://github.com/PentatonicDev/9router/commit/bf08d9df), `webSearchEmulation.js`. Converte a server tool, executa buscas, reinjeta resultados e reconstrói blocos Anthropic. Há até oito rodadas de busca e uma chamada final adicional. As chamadas intermediárias usam `stream:false`; resposta SSE sintetizada não equivale a streaming progressivo do provider. Verificar latência, desconexão, soma do uso de todas as rodadas, domínios permitidos e turns que misturam busca com ferramentas do cliente.

**Leases/OAuth:** `db/leases.js` e `refreshCoordinator.js` usam lease por provider/conexão, TTL de 30 segundos e releitura das credenciais. Evitam reaplicar `expiresIn` relativo de uma linha antiga. Bons candidatos quando múltiplos processos compartilham o mesmo banco. Dois RedRouters em PCs distintos, com bancos distintos e conectados por HTTP, não ganham coordenação automaticamente com esse mecanismo.

**Contexto em combos:** [1f6a0e4e](https://github.com/PentatonicDev/9router/commit/1f6a0e4e) expõe contexto do membro atual. Para nosso catálogo remoto, a capacidade anunciada deve ter política explícita: fallback para membro menor não pode invalidar silenciosamente a promessa feita ao cliente. Metadata de capabilities por modelo/conexão tem mais valor do que copiar um número isolado.

## Evidência e limitações dos benchmarks

`scripts/bench-harness.mjs` executa Claude Code com diretório/config isolados em três tarefas: rename, correção de desconto e slugify. Confere falha antes e sucesso depois. Isso é melhor que avaliar apenas respostas textuais.

Porém, o harness pode editar os próprios arquivos de checagem, os testes não são um holdout e o conjunto é pequeno. Não mede por si só custo total, qualidade ampla ou latência de cauda; o custo é consultado na UI. Para nosso benchmark, os validadores precisam ficar fora do workspace editável e verificar também alterações indevidas, com repetições e pareamento entre configurações.

Números relatados pelo autor — latência Jev de 300–400 ms, shortlist 280→24, calibração sobre 383 vereditos e redução de 28% em saída/latência em uma amostra — são evidências exploratórias do fork. Não foram reproduzidos com credenciais reais nesta investigação e não são garantias para nossos usuários.

## Validação executada

- `decision.test.js`, `decision-accounting.test.js`, `decision-detail-row.test.js`: **69 testes passaram**.
- `combo-routing.test.js`, `web-search-emulation.test.js`: **15 testes passaram**.
- `evaluation-routing.test.js`: falhou na coleta por falta de `@aws-sdk/client-bedrock-runtime` no ambiente com dependências compartilhadas. Não contado como suíte aprovada.
- Reproduções locais Node dos itens 1, 2, 4 e 5 acima, sem rede.
- Relatórios JSON: `/tmp/pentatonic-decision-tests.json`, `/tmp/pentatonic-adjacent-tests.json`.
- Não executei a suite inteira do fork, benchmark pago, chamada Jev real, Bedrock real ou testes de distribuição contra Postgres.

## Ordem recomendada para o RedRouter

1. **Observabilidade + shadow sobre o System One existente.** Registrar candidatos elegíveis, decisão proposta/aplicada, motivo de abstenção, custo, latência e policy version, com escopo de acesso e minimização de payload. Garantir por testes que shadow preserva corpo e rota.
2. **Harness de qualidade reproduzível.** Validadores externos, tasks representativas de Redcode/Claude Code, tool rosters grandes e controles off/shadow/hint/enforce. Medir sucesso da tarefa, custo total, TTFT p50/p95, retries e abstenções. Estabelecer limites a partir do baseline.
3. **Escolha dinâmica de modelo opcional.** Filtrar candidatos deterministicamente; perguntar sobre o mesmo conjunto; validar saída; preservar fallback e modalidades; isolar confirmação por sessão. Reutilizar `/v1/systemone`, contas e proxy.
4. **Tool hints opcionais.** Shortlist com recall medido, nomes pós-tradução, respeito ao cliente, hash de conteúdo, cancelamento e budget. Forced só após comprovação por protocolo e executor.
5. **Teto de reasoning por combo/membro e depois por turno.** Começar com política explícita e opt-in. Nunca aumentar limites ou violar o protocolo; avaliar qualidade antes de habilitar heurística.
6. **Portes independentes conforme necessidade:** Bedrock completo, busca emulada e coordenação OAuth. Cada frente com contratos e validação próprios; não acoplar ao lançamento de smart routing.

Critério comum: indisponibilidade/inconclusão do avaliador preserva a política determinística e aparece como abstenção. Jev assessora escolhas; permissões, orçamento, conjunto autorizado e validade de protocolos continuam no código.

## Relação com o catálogo remoto e a release

O problema RedRouter → RedRouter já foi tratado separadamente na **v0.11.9**: discovery persistido localmente, refresh de catálogo e encaminhamento pelo executor real. Esse patch não depende das decisões experimentais do fork. A instalação exata do pacote publicado passou pelo smoke de catálogo e chat; npm e mise resolveram 0.11.9 na verificação da release.

O próximo ganho nessa integração é enriquecer e preservar metadata de capacidades/limites/endpoint dos modelos remotos, sem exigir cadastro manual. Um catálogo completo é pré-requisito para seleção dinâmica, mas não autoriza supor capacidades que o remoto não informou.
