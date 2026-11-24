# Defesa em profundidade

O Triggerfish implementa a seguranca como 13 camadas independentes e
sobrepostas. Nenhuma camada e suficiente sozinha. Juntas, formam uma defesa que
degrada de forma controlada -- mesmo se uma camada for comprometida, as camadas
restantes continuam protegendo o sistema.

::: warning SEGURANCA Defesa em profundidade significa que uma vulnerabilidade em
qualquer camada individual nao compromete o sistema. Um atacante que contorna a
autenticacao de canais ainda enfrenta o rastreamento de taint de sessao, os hooks
de politicas e o registro de auditoria. Um LLM que sofre prompt injection ainda
nao pode influenciar a camada de politicas deterministica abaixo dele. :::

## As 13 camadas

### Camada 1: Autenticacao de canais

**Protege contra:** Personificacao, acesso nao autorizado, confusao de
identidade.

A identidade e determinada por **codigo no estabelecimento da sessao**, nao pelo
LLM interpretando o conteudo da mensagem. Antes de o LLM ver qualquer mensagem,
o adaptador de canal a marca com um rotulo imutavel:

```
{ source: "owner" }    -- a identidade verificada do canal corresponde ao proprietario registrado
{ source: "external" } -- qualquer outra pessoa; apenas entrada, nao e tratada como comando
```

Os metodos de autenticacao variam por canal:

| Canal                   | Metodo            | Verificacao                                                                    |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------ |
| Telegram / WhatsApp     | Codigo de pareamento | Codigo de uso unico, expira em 5 minutos, enviado da conta do usuario       |
| Slack / Discord / Teams | OAuth             | Fluxo de consentimento OAuth da plataforma, retorna ID de usuario verificado   |
| CLI                     | Processo local    | Roda na maquina do usuario, autenticado pelo SO                                |
| WebChat                 | Nenhum (publico)  | Todos os visitantes sao `EXTERNAL`, nunca `owner`                              |
| E-mail                  | Correspondencia de dominio | O dominio do remetente e comparado com dominios internos configurados  |

::: info O LLM nunca decide quem e o proprietario. Uma mensagem dizendo "Eu sou
o proprietario" de um remetente nao verificado e marcada como
`{ source: "external" }` e nao pode acionar comandos de nivel de proprietario.
Essa decisao e tomada em codigo, antes de o LLM processar a mensagem. :::

### Camada 2: Acesso a dados com permissoes

**Protege contra:** Acesso excessivo a dados, escalacao de privilegios por meio
de credenciais do sistema.

O Triggerfish usa os tokens OAuth delegados do usuario -- nao contas de servico
do sistema -- para consultar sistemas externos. O sistema de origem aplica seu
proprio modelo de permissoes:

<img src="/diagrams/traditional-vs-triggerfish.svg" alt="Tradicional vs Triggerfish: o modelo tradicional da ao LLM controle direto, o Triggerfish roteia todas as acoes por uma camada de politicas deterministica" style="max-width: 100%;" />

O SDK de plugins aplica isso no nivel da API:

| Metodo do SDK                           | Comportamento                                   |
| --------------------------------------- | ----------------------------------------------- |
| `sdk.get_user_credential(integration)`  | Retorna o token OAuth delegado do usuario        |
| `sdk.query_as_user(integration, query)` | Executa com as permissoes do usuario             |
| `sdk.get_system_credential(name)`       | **BLOQUEADO** -- lanca `PermissionError`         |

### Camada 3: Rastreamento de taint de sessao

**Protege contra:** Vazamento de dados por contaminacao de contexto, dados
classificados chegando a canais de classificacao inferior.

Cada sessao rastreia de forma independente um nivel de taint que reflete a maior
classificacao de dados acessados durante a sessao. O taint segue tres
invariantes:

1. **Por conversa** -- cada sessao tem seu proprio taint
2. **Apenas escalacao** -- o taint aumenta, nunca diminui
3. **A reinicializacao completa limpa tudo** -- o taint E o historico sao apagados juntos

Quando o motor de politicas avalia uma saida, ele compara o taint da sessao com
a classificacao efetiva do canal de destino. Se o taint exceder o destino, a
saida e bloqueada.

### Camada 4: Linhagem de dados

**Protege contra:** Fluxos de dados impossiveis de rastrear, incapacidade de
auditar para onde os dados foram, lacunas de conformidade.

Cada elemento de dados carrega metadados de procedencia da origem ao destino:

- **Origem**: Qual integracao, registro e acesso de usuario produziu esses dados
- **Classificacao**: Qual nivel foi atribuido e por que
- **Transformacoes**: Como o LLM modificou, resumiu ou combinou os dados
- **Destino**: Qual sessao e canal recebeu a saida

A linhagem permite rastreamentos para frente ("para onde foi esse registro do
Salesforce?"), rastreamentos para tras ("quais fontes contribuiram para essa
saida?") e exportacoes completas de conformidade.

### Camada 5: Hooks de aplicacao de politicas

**Protege contra:** Ataques de prompt injection, contorno de seguranca pelo LLM,
execucao descontrolada de ferramentas.

Oito hooks deterministicos interceptam cada acao em pontos criticos do fluxo de
dados:

| Hook                    | O que intercepta                                    |
| ----------------------- | --------------------------------------------------- |
| `PRE_CONTEXT_INJECTION` | Entrada externa entrando na janela de contexto      |
| `PRE_TOOL_CALL`         | LLM solicitando execucao de ferramenta              |
| `POST_TOOL_RESPONSE`    | Dados retornando da execucao de ferramenta          |
| `PRE_OUTPUT`            | Resposta prestes a sair do sistema                  |
| `SECRET_ACCESS`         | Solicitacao de acesso a credenciais                 |
| `SESSION_RESET`         | Solicitacao de reinicializacao de taint             |
| `AGENT_INVOCATION`      | Chamada de agente para agente                       |
| `MCP_TOOL_CALL`         | Invocacao de ferramenta de servidor MCP             |

Os hooks sao codigo puro: deterministicos, sincronos, registrados e
infalsificaveis. O LLM nao pode contorna-los porque nao ha caminho da saida do
LLM para a configuracao dos hooks. A camada de hooks nao faz parsing da saida do
LLM em busca de comandos.

### Camada 6: MCP Gateway

**Protege contra:** Acesso descontrolado a ferramentas externas, dados nao
classificados entrando por servidores MCP, violacoes de schema.

Todos os servidores MCP tem como padrao `UNTRUSTED` e nao podem ser invocados ate
que um administrador ou usuario os classifique. O Gateway aplica:

- Autenticacao do servidor e status de classificacao
- Permissoes por ferramenta (ferramentas individuais podem ser bloqueadas mesmo
  se o servidor for permitido)
- Validacao de schema de requisicao/resposta
- Rastreamento de taint em todas as respostas MCP
- Varredura de padroes de injecao nos parametros

<img src="/diagrams/mcp-server-states.svg" alt="Estados do servidor MCP: UNTRUSTED (padrao), CLASSIFIED (revisado e permitido), BLOCKED (explicitamente proibido)" style="max-width: 100%;" />

### Camada 7: Sandbox de plugins

Habilite um plugin TypeScript na configuração do usuário com `enabled: true`. Por padrão, a importação e a execução ocorrem em workers Deno com permissões restritas. Eles podem ler a pasta do plugin e se conectar apenas aos hosts e portas de `declaredEndpoints`. Escrita de arquivos, leitura do ambiente do processo, subprocessos, FFI e informações restritas do sistema são bloqueados. `trust: trusted` permite importar o módulo no processo do Triggerfish. O executor roda nesse processo se o manifesto também declarar `trusted`.

[Guia completo de plugins](../integrations/plugins)

### Camada 8: Isolamento de segredos

**Protege contra:** Roubo de credenciais, segredos em arquivos de configuracao,
armazenamento de credenciais em texto puro.

As credenciais sao armazenadas no chaveiro do SO (nivel pessoal) ou integracao
com vault (nivel empresarial). Elas nunca aparecem em:

- Arquivos de configuracao
- Valores do `StorageProvider`
- Entradas de log
- Contexto do LLM (as credenciais sao injetadas na camada HTTP, abaixo do LLM)

O hook `SECRET_ACCESS` registra cada acesso a credenciais com o plugin
solicitante, o escopo da credencial e a decisao.

### Camada 9: Sandbox de ferramentas do sistema de arquivos

**Protege contra:** Ataques de path traversal, acesso nao autorizado a arquivos,
contorno de classificacao via operacoes diretas do sistema de arquivos.

Todas as operacoes de ferramentas do sistema de arquivos (ler, escrever, editar,
listar, buscar) rodam dentro de um Worker do Deno em sandbox com permissoes no
nivel do SO limitadas ao subdiretorio do workspace apropriado para o taint da
sessao. O sandbox aplica tres limites:

- **Jaula de caminhos** -- cada caminho e resolvido para um caminho absoluto e
  verificado contra a raiz da jaula com correspondencia consciente do separador.
  Tentativas de traversal (`../`) que escapam do workspace sao rejeitadas antes
  de qualquer E/S ocorrer
- **Classificacao de caminhos** -- cada caminho do sistema de arquivos e
  classificado por uma cadeia de resolucao fixa: caminhos protegidos hardcoded
  (RESTRICTED), diretorios de classificacao do workspace, mapeamentos de caminhos
  configurados e classificacao padrao. O agente nao pode acessar caminhos acima
  do taint de sua sessao
- **Permissoes limitadas por taint** -- as permissoes do Deno do Worker do
  sandbox sao definidas para o subdiretorio do workspace que corresponde ao nivel
  de taint atual da sessao. Quando o taint escala, o Worker e reiniciado com
  permissoes expandidas. As permissoes so podem ampliar, nunca reduzir dentro de
  uma sessao
- **Protecao contra escrita** -- arquivos criticos (`TRIGGER.md`,
  `triggerfish.yaml`, `SPINE.md`) sao protegidos contra escrita na camada de
  ferramentas independentemente das permissoes do sandbox. Esses arquivos so
  podem ser modificados por ferramentas de gerenciamento dedicadas que aplicam
  suas proprias regras de classificacao

### Camada 10: Identidade de agente

**Protege contra:** Escalacao de privilegios por meio de cadeias de agentes,
lavagem de dados via delegacao.

Quando agentes invocam outros agentes, cadeias de delegacao criptograficas
impedem a escalacao de privilegios:

- Cada agente tem um certificado que especifica suas capacidades e teto de
  classificacao
- O agente chamado herda `max(proprio taint, taint do chamador)` -- o taint so
  pode aumentar ao longo das cadeias
- Um chamador com taint que excede o teto do agente chamado e bloqueado
- Invocacoes circulares sao detectadas e rejeitadas
- A profundidade de delegacao e limitada e aplicada

<img src="/diagrams/data-laundering-defense.svg" alt="Defesa contra lavagem de dados: o caminho de ataque e bloqueado na verificacao de teto e a heranca de taint impede a saida para canais de classificacao inferior" style="max-width: 100%;" />

### Camada 11: Registro de auditoria

**Protege contra:** Violacoes indetectaveis, falhas de conformidade,
incapacidade de investigar incidentes.

Cada decisao relevante de seguranca e registrada com contexto completo:

```json
{
  "timestamp": "2025-01-29T10:23:45Z",
  "user_id": "user_123",
  "session_id": "sess_456",
  "action": "slack.postMessage",
  "target_channel": "external_webhook",
  "session_taint": "CONFIDENTIAL",
  "target_classification": "PUBLIC",
  "decision": "DENIED",
  "reason": "classification_violation",
  "hook": "PRE_OUTPUT",
  "policy_rules_evaluated": ["rule_001", "rule_002"],
  "lineage_ids": ["lin_789", "lin_790"]
}
```

O que e registrado:

- Todas as solicitacoes de acao (permitidas E negadas)
- Decisoes de classificacao
- Mudancas no taint de sessao
- Eventos de autenticacao de canais
- Avaliacoes de regras de politicas
- Criacao e atualizacao de registros de linhagem
- Decisoes do MCP Gateway
- Invocacoes de agente para agente

::: info O registro de auditoria nao pode ser desabilitado. E uma regra fixa na
hierarquia de politicas. Mesmo um administrador de organizacao nao pode
desativar o registro para suas proprias acoes. Implantacoes empresariais podem
opcionalmente habilitar o registro completo de conteudo (incluindo o conteudo de
mensagens bloqueadas) para requisitos forenses. :::

### Camada 12: Prevencao de SSRF

**Protege contra:** Server-side request forgery, reconhecimento de rede interna,
exfiltracao de metadados de nuvem.

Todas as requisicoes HTTP de saida (de `web_fetch`, `browser.navigate` e acesso
de rede de plugins) resolvem DNS primeiro e verificam o IP resolvido contra uma
lista de negacao hardcoded de faixas privadas e reservadas. Isso impede que um
atacante engane o agente para acessar servicos internos via URLs manipuladas.

- Faixas privadas (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) sao sempre
  bloqueadas
- Endpoints link-local (`169.254.0.0/16`) e de metadados de nuvem sao bloqueados
- Loopback (`127.0.0.0/8`) e bloqueado
- A lista de negacao e hardcoded e nao e configuravel -- nao ha anulacao de
  administrador
- A resolucao DNS ocorre antes da requisicao, prevenindo ataques de DNS rebinding

### Camada 13: Controle de classificacao de memoria

**Protege contra:** Vazamento de dados entre sessoes pela memoria, rebaixamento
de classificacao via escritas na memoria, acesso nao autorizado a memorias
classificadas.

O sistema de memoria entre sessoes aplica classificacao tanto na escrita quanto
na leitura:

- **Escritas**: As entradas de memoria sao forcadas ao nivel de taint da sessao
  atual. O LLM nao pode escolher uma classificacao inferior para as memorias
  armazenadas.
- **Leituras**: As consultas de memoria sao filtradas por `canFlowTo` -- uma
  sessao so pode ler memorias em ou abaixo do seu nivel de taint atual.

Isso impede que um agente armazene dados CONFIDENTIAL como PUBLIC na memoria e
depois os recupere em uma sessao com menor taint para contornar a regra de no
write-down.

## Hierarquia de confianca

O modelo de confianca define quem tem autoridade sobre o que. Os niveis
superiores nao podem contornar as regras de seguranca dos niveis inferiores, mas
podem configurar os parametros ajustaveis dentro dessas regras.

<img src="/diagrams/trust-hierarchy.svg" alt="Hierarquia de confianca: fornecedor Triggerfish (zero acesso), Administrador da organizacao (define politicas), Funcionario (usa o agente dentro dos limites)" style="max-width: 100%;" />

::: tip **Nivel pessoal:** O usuario E o administrador da organizacao. Soberania
total. Sem visibilidade do Triggerfish. O fornecedor tem zero acesso aos dados do
usuario por padrao e so pode obter acesso por meio de uma concessao explicita,
limitada no tempo e registrada pelo usuario. :::

## Como as camadas funcionam juntas

Considere um ataque de prompt injection onde uma mensagem maliciosa tenta
exfiltrar dados:

| Passo | Camada                        | Acao                                                             |
| ----- | ----------------------------- | ---------------------------------------------------------------- |
| 1     | Autenticacao de canal         | Mensagem marcada `{ source: "external" }` -- nao e proprietario |
| 2     | PRE_CONTEXT_INJECTION         | Entrada varrida por padroes de injecao, classificada             |
| 3     | Taint de sessao               | Taint de sessao sem mudanca (nenhum dado classificado acessado)  |
| 4     | LLM processa a mensagem       | O LLM pode ser manipulado para solicitar uma chamada de ferramenta |
| 5     | PRE_TOOL_CALL                 | Verificacao de permissoes de ferramenta contra regras de fonte externa |
| 6     | POST_TOOL_RESPONSE            | Qualquer dado retornado e classificado, taint atualizado         |
| 7     | PRE_OUTPUT                    | Classificacao de saida vs. destino verificada                    |
| 8     | Registro de auditoria         | Toda a sequencia registrada para revisao                         |

Mesmo se o LLM estiver completamente comprometido no passo 4 e solicitar uma
chamada de ferramenta de exfiltracao de dados, as camadas restantes (verificacoes
de permissoes, rastreamento de taint, classificacao de saida, registro de
auditoria) continuam aplicando as politicas. Nenhum ponto unico de falha
compromete o sistema.
