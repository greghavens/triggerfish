# Visao geral da arquitetura

O Triggerfish e uma plataforma segura de agentes de IA multicanal com um unico
invariante fundamental:

::: warning SEGURANCA **A seguranca e deterministica e esta abaixo do LLM.** Cada
decisao de seguranca e tomada por codigo puro que o LLM nao pode contornar,
anular ou influenciar. O LLM tem zero autoridade -- ele solicita acoes; a camada
de politicas decide. :::

Esta pagina oferece uma visao geral de como o Triggerfish funciona. Cada
componente principal possui um link para uma pagina dedicada com mais detalhes.

## Arquitetura do sistema

<img src="/diagrams/system-architecture.svg" alt="Arquitetura do sistema: os canais fluem pelo Channel Router ate o Gateway, que coordena o Session Manager, o Policy Engine e o Agent Loop" style="max-width: 100%;" />

### Fluxo de dados

Cada mensagem segue este caminho pelo sistema:

<img src="/diagrams/data-flow-9-steps.svg" alt="Fluxo de dados: pipeline de 9 etapas desde a mensagem de entrada, passando pelos hooks de politicas, ate a entrega de saida" style="max-width: 100%;" />

Em cada ponto de aplicacao, a decisao e deterministica -- a mesma entrada sempre
produz o mesmo resultado. Nao ha chamadas ao LLM dentro dos hooks, nao ha
aleatoriedade e nao ha como o LLM influenciar o resultado.

## Componentes principais

### Sistema de classificacao

Os dados fluem por quatro niveis ordenados:
`RESTRICTED > CONFIDENTIAL > INTERNAL > PUBLIC`. A regra fundamental e **no
write-down**: os dados so podem fluir para um nivel de classificacao igual ou
superior. Uma sessao `CONFIDENTIAL` nao pode enviar dados para um canal `PUBLIC`.
Sem excecoes. Sem anulacao pelo LLM.

[Leia mais sobre o sistema de classificacao.](/pt-BR/architecture/classification)

### Motor de politicas e hooks

Oito hooks de aplicacao deterministica interceptam cada acao em pontos criticos
do fluxo de dados. Os hooks sao funcoes puras: sincronas, registradas e
infalsificaveis. O motor de politicas suporta regras fixas (nunca configuraveis),
regras ajustaveis por administradores e escotilhas de escape declarativas em YAML
para empresas.

[Leia mais sobre o motor de politicas.](/pt-BR/architecture/policy-engine)

### Sessoes e taint

Cada conversa e uma sessao com rastreamento de taint independente. Quando uma
sessao acessa dados classificados, seu taint escala para esse nivel e nunca pode
diminuir dentro da sessao. Uma reinicializacao completa limpa o taint E o
historico de conversa. Cada elemento de dados carrega metadados de procedencia
por meio de um sistema de rastreamento de linhagem.

[Leia mais sobre sessoes e taint.](/pt-BR/architecture/taint-and-sessions)

### Gateway

O Gateway e o plano de controle central -- um servico local de longa execucao que
gerencia sessoes, canais, ferramentas, eventos e processos de agentes por meio de
um endpoint WebSocket JSON-RPC. Ele coordena o servico de notificacoes, o
agendador cron, a ingestao de webhooks e o roteamento de canais.

[Leia mais sobre o Gateway.](/pt-BR/architecture/gateway)

### Armazenamento

Todos os dados com estado fluem por uma abstracao unificada `StorageProvider`.
Chaves com namespace (`sessions:`, `taint:`, `lineage:`, `audit:`) mantem as
responsabilidades separadas enquanto permitem trocar backends sem alterar a
logica de negocio. O padrao e SQLite WAL em
`~/.triggerfish/data/triggerfish.db`.

[Leia mais sobre o armazenamento.](/pt-BR/architecture/storage)

### Defesa em profundidade

A seguranca e implementada em camadas por meio de 13 mecanismos independentes,
desde a autenticacao de canais e o acesso a dados com permissoes, passando pelo
taint de sessao, hooks de politicas, sandboxing de plugins, sandboxing de
ferramentas do sistema de arquivos, ate o registro de auditoria. Nenhuma camada e
suficiente sozinha; juntas formam uma defesa que degrada de forma controlada
mesmo se uma camada for comprometida.

[Leia mais sobre a defesa em profundidade.](/pt-BR/architecture/defense-in-depth)

## Principios de design

| Principio                         | O que significa                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Aplicacao deterministica**      | Os hooks de politicas usam funcoes puras. Sem chamadas ao LLM, sem aleatoriedade. A mesma entrada sempre produz a mesma decisao.   |
| **Propagacao de taint**           | Todos os dados carregam metadados de classificacao. O taint de sessao so pode escalar, nunca diminuir.                             |
| **No write-down**                 | Os dados nao podem fluir para um nivel de classificacao inferior. Nunca.                                                           |
| **Auditar tudo**                  | Todas as decisoes de politicas sao registradas com contexto completo: timestamp, tipo de hook, ID de sessao, entrada, resultado, regras avaliadas. |
| **Hooks infalsificaveis**         | O LLM nao pode contornar, modificar ou influenciar as decisoes dos hooks de politicas. Os hooks sao executados em codigo abaixo da camada do LLM. |
| **Isolamento de sessoes**         | Cada sessao rastreia o taint de forma independente. Sessoes em segundo plano iniciam com taint PUBLIC limpo. Os workspaces dos agentes sao totalmente isolados. |
| **Abstracao de armazenamento**    | Nenhum modulo cria seu proprio armazenamento. Toda a persistencia flui por meio do `StorageProvider`.                              |

## Stack tecnologico

| Componente                | Tecnologia                                                                |
| ------------------------- | ------------------------------------------------------------------------- |
| Runtime                   | Deno 2.x (TypeScript em modo estrito)                                     |
| Testes                    | Runner de testes integrado do Deno                                        |
| Canais                    | Baileys (WhatsApp), grammY (Telegram), Bolt (Slack), discord.js (Discord) |
| Automacao de navegador    | puppeteer-core (CDP)                                                      |
| Voz                       | Whisper (STT local), ElevenLabs/OpenAI (TTS)                              |
| Armazenamento             | SQLite WAL (padrao), backends empresariais (Postgres, S3)                 |
| Segredos                  | Chaveiro do SO (pessoal), integracao com vault (empresarial)              |

::: info O Triggerfish nao requer ferramentas de build externas, nem Docker, nem
dependencia de nuvem. Ele roda localmente, processa os dados localmente e da ao
usuario soberania total sobre seus dados. :::
