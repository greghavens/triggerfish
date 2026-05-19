---
title: "Segurança de IA Zero Trust: Por que as defesas tradicionais de perímetro falham para IA e o que construir em seu lugar"
date: 2026-04-04
description: A segurança de IA zero trust aplica verificação contínua e acesso de privilégio mínimo aos sistemas de IA, tratando cada modelo, usuário e fluxo de dados como não confiável por padrão.
author: triggerfish
tags:
  - AI agent
draft: false
---
A segurança de IA zero trust é a aplicação dos princípios de zero trust aos sistemas de inteligência artificial, exigindo que cada usuário, modelo, fonte de dados e ponto de integração seja continuamente verificado e receba apenas o acesso mínimo necessário para desempenhar sua função, sem confiança implícita estendida com base na localização da rede ou autenticação anterior. Ela trata os sistemas de IA como alvos de alto valor que exigem os mesmos controles rigorosos de acesso que qualquer outra infraestrutura privilegiada.

O modelo tradicional de perímetro de segurança presumia que as ameaças vinham de fora da rede e que os sistemas dentro dela podiam ser confiáveis. Essa suposição já estava sob pressão antes da chegada da IA. As implantações de IA a quebram completamente. Um sistema de IA conectado a bancos de dados internos, e-mails, repositórios de documentos e APIs externas opera através de uma fronteira de confiança que um modelo de perímetro não consegue definir, muito menos defender. Ele aceita entradas de qualquer lugar, recupera conteúdo de várias fontes e realiza ações em sistemas conectados em sequências que nenhum modelo tradicional de controle de acesso foi projetado para governar. A superfície de ataque não é um perímetro definido. É o conjunto completo de conexões que um sistema de IA pode percorrer, a gama completa de conteúdo que processará e o escopo completo de ações que está autorizado a realizar. A segurança de IA zero trust aborda essa realidade substituindo a suposição de perímetro por verificação contínua em cada interação, cada acesso a dados e cada ação que o sistema de IA realiza. Este guia explica como os princípios de zero trust se aplicam especificamente às implantações de IA, como os sete pilares são em um contexto de IA e o que as organizações precisam construir para fazer o modelo funcionar na prática.



![AI agent](/blog/images/architectural.jpg)

## **Por que a segurança de perímetro falha especificamente para sistemas de IA**

### **O problema da IA conectada**

Uma aplicação corporativa convencional tem um conjunto definido de usuários, um conjunto definido de funções e um conjunto relativamente previsível de padrões de acesso a dados. As equipes de segurança podem construir controles de acesso em torno dessas definições, monitorar desvios e tratar anomalias como sinais de potencial comprometimento. A previsibilidade do comportamento é o que torna a segurança de perímetro viável, mesmo que imperfeita.

Os sistemas de IA, particularmente os sistemas de IA agêntica e aqueles conectados a pipelines de recuperação, não têm comportamento previsível no mesmo sentido. Suas respostas variam com as entradas. Os dados que acessam dependem do que as consultas geram em tempo de execução, em vez de uma lista de acesso predefinida. As ações que realizam por meio de ferramentas conectadas dependem das tarefas que lhes são atribuídas, em vez de um conjunto fixo de funções. A segurança de perímetro construída em torno de uma definição estática do que o sistema faz não consegue acompanhar a realidade dinâmica do que ele realmente acessa e executa.

Os ataques de prompt injection exploram essa lacuna diretamente. Um invasor que consiga introduzir instruções maliciosas em qualquer conteúdo que um sistema de IA recupere ou receba pode potencialmente redirecionar o comportamento do sistema por completo, fazendo com que ele acesse dados, execute ações ou exponha informações de maneiras que contornam todos os controles de perímetro que governam o comportamento normal do sistema. O ataque não cruza uma fronteira de rede. Ele cruza uma fronteira de confiança dentro do próprio processamento do sistema, em um canal que as defesas de perímetro não estão posicionadas para monitorar.

A segurança de IA zero trust aborda isso movendo a verificação do perímetro da rede para cada interação individual. Em vez de perguntar se um usuário ou sistema está dentro da rede confiável, ela pergunta se esta solicitação específica, desta identidade específica, para este recurso específico, neste momento específico, está autorizada. Essa pergunta é feita continuamente, não uma única vez na autenticação.

### **Como a IA amplifica as consequências de violações de confiança**

A razão pela qual a segurança de IA zero trust é mais importante do que o zero trust para aplicações convencionais não é que os sistemas de IA sejam inerentemente menos seguros. É que as consequências de uma violação de confiança em um sistema de IA conectado são amplificadas pela conectividade e autonomia do sistema de maneiras que violações equivalentes em sistemas convencionais não são.

Uma conta de usuário comprometida em uma aplicação convencional cria acesso ao que esse usuário pode acessar. Um agente de IA comprometido ou manipulado com amplo acesso a ferramentas pode potencialmente percorrer vários sistemas conectados, exfiltrar dados de várias fontes e realizar ações em várias plataformas em uma única sequência automatizada que exigiria um esforço extenso de invasor para ser replicada manualmente. A automação que torna os agentes de IA valiosos em tarefas legítimas também os torna eficientes em tarefas ilegítimas quando seu comportamento é manipulado ou seu acesso é explorado.

A segurança de IA zero trust reduz o blast radius das violações de confiança garantindo que mesmo um sistema de IA manipulado com sucesso só possa acessar e afetar os recursos específicos para os quais recebeu permissão no contexto atual, em vez de herdar amplo acesso que foi concedido na autenticação e nunca foi revisitado.

Revisar como as decisões de arquitetura de[ AI security](https://trigger.fish/security/) em torno do escopo de acesso e da verificação contínua afetam o blast radius prático do comprometimento do sistema de IA ajuda as organizações a construir implantações onde as consequências das falhas de segurança são limitadas em vez de ilimitadas.



![AI agent](/blog/images/enterprise-security.jpg)

## **Os sete pilares do Zero Trust aplicados aos sistemas de IA**

A segurança zero trust é organizada em torno de sete pilares que, juntos, definem a arquitetura completa de verificação e controle. Cada pilar assume características e requisitos específicos quando aplicado a sistemas de IA em vez de aplicações convencionais.

### **Pilar Um: Verificação de Identidade**

No zero trust convencional, a verificação de identidade cobre usuários humanos e contas de serviço. Na segurança de IA zero trust, a superfície de identidade se expande para incluir o próprio modelo de IA como uma identidade que precisa ser verificada, os agentes que atuam em nome dos usuários que precisam ser distinguidos desses usuários para fins de controle de acesso, e as contas de serviço que os sistemas de IA usam para acessar recursos conectados, que precisam ser gerenciadas com o mesmo rigor que contas privilegiadas humanas.

A autenticação contínua, em vez da autenticação baseada em sessão, é o padrão zero trust para usuários humanos que acessam sistemas de IA. Autenticação multifator, análise comportamental que monitora padrões de uso anômalos e políticas de acesso sensíveis ao contexto que ajustam os requisitos de verificação com base na sensibilidade do que está sendo solicitado se aplicam em implantações de sistemas de IA.

Para agentes de IA que operam de forma autônoma, o desafio de identidade é manter o princípio de que o acesso do agente é restrito à tarefa específica que está executando, em vez de herdar o acesso completo do usuário humano que o iniciou. Um agente executando uma tarefa de pesquisa em nome de um usuário deve ter acesso de pesquisa, não a pegada completa de acesso do usuário. Esse escopo requer uma arquitetura de identidade explícita, em vez da herança padrão que muitos frameworks de agentes implementam.

### **Pilar Dois: Segurança de Dispositivos**

A segurança de dispositivos em um contexto de IA zero trust cobre tanto os endpoints a partir dos quais os usuários acessam os sistemas de IA quanto a infraestrutura na qual os modelos de IA são executados. Para dispositivos de usuário, aplicam-se os controles zero trust padrão: verificação de saúde do dispositivo antes da concessão de acesso, cobertura de detecção e resposta de endpoint e políticas de acesso que variam com base no status de gerenciamento do dispositivo.

A camada de infraestrutura requer atenção específica porque o hardware de inferência de IA representa um alvo de alto valor para o qual a segurança tradicional de endpoint não foi projetada. Os servidores GPU executando modelos grandes contêm tanto os pesos do modelo, que representam propriedade intelectual significativa, quanto os dados sendo processados através da inferência, que podem incluir informações organizacionais sensíveis. A segurança física e lógica da infraestrutura de inferência de IA merece o mesmo gerenciamento de acesso privilegiado, monitoramento de integridade e registro de acesso que outros ativos de infraestrutura de alto valor.

### **Pilar Três: Segmentação de Rede**

A arquitetura de rede zero trust substitui a rede plana confiável por zonas microssegmentadas, onde o tráfego entre segmentos requer autorização explícita, em vez de fluir livremente dentro do perímetro. Para sistemas de IA, a segmentação de rede determina quais componentes da arquitetura de IA podem se comunicar com quais outros e quais recursos externos o sistema de IA pode alcançar.

Os servidores de inferência de IA devem ser segmentados em rede dos recursos que não precisam acessar. Um modelo que serve consultas de atendimento ao cliente não precisa de acesso de rede a sistemas financeiros. Uma ferramenta de IA de pesquisa não precisa de acesso a bancos de dados de RH. A arquitetura de rede deve impor essas separações, em vez de depender do comportamento do sistema de IA para respeitá-las voluntariamente, porque a prompt injection e outras técnicas de manipulação podem potencialmente substituir as restrições comportamentais, enquanto a segmentação de rede as impõe fisicamente.

O acesso à rede externa para sistemas de IA, incluindo acesso a pesquisa na web, APIs externas e serviços em nuvem, deve ser explicitamente permitido por meio de allowlists, em vez de permitido por padrão com exceções bloqueadas. O padrão para conectividade externa de sistemas de IA em uma arquitetura zero trust é nenhum acesso, com destinos específicos permitidos adicionados com base em requisitos operacionais documentados.

### **Pilar Quatro: Segurança de Aplicações**

A segurança de aplicações no contexto de IA zero trust cobre a segurança da própria camada de aplicação de IA, incluindo a infraestrutura de prompting, os pipelines de recuperação, as integrações de ferramentas e a lógica de manipulação de saída que, juntas, definem como o sistema de IA processa solicitações e produz respostas.

A validação e sanitização de entrada na camada de aplicação representa o princípio zero trust de verificar conteúdo, não apenas identidade, aplicado aos sistemas de IA. Cada entrada que chega ao modelo, seja de usuários, documentos recuperados, saídas de ferramentas ou mensagens do sistema, deve ser tratada como potencialmente adversária e processada por meio de filtragem apropriada, em vez de implicitamente confiada.

A validação de saída aplica o mesmo princípio de forma reversa. Cada saída que o sistema de IA produz antes de chegar aos usuários, sistemas conectados ou processos downstream deve ser inspecionada contra critérios definidos que detectam conteúdo prejudicial, vazamento de dados sensíveis e anomalias comportamentais que sugerem que o modelo foi manipulado.

Entender como as decisões de[ AI architecture](https://trigger.fish/architecture/) na camada de aplicação afetam a implementação prática dos controles de entrada e saída zero trust ajuda as organizações a construir sistemas de IA onde a segurança está incorporada no pipeline de processamento, em vez de aparafusada no perímetro.



![AI agent](/blog/images/layered-security.jpg)

### **Pilar Cinco: Segurança de Dados**

A segurança de dados sob o IA zero trust requer tratar cada acesso a dados por um sistema de IA como exigindo autorização explícita, em vez de herdar permissões amplas. Este pilar é onde as implantações de IA mais diretamente exigem controles zero trust criados para o propósito, porque as arquiteturas de segurança de dados existentes não foram projetadas para os padrões dinâmicos e orientados por consultas de acesso a dados que os sistemas de recuperação de IA criam.

A classificação de dados que os sistemas de IA respeitam em seu comportamento de recuperação e processamento requer integração entre a infraestrutura de governança de dados e a camada de controle de acesso de IA. Quando o nível de autorização de um usuário determina quais documentos ele pode acessar diretamente em um sistema de gerenciamento de documentos, o sistema de IA que recupera documentos em nome desse usuário deve respeitar o mesmo limite de autorização, retornando apenas documentos que o usuário está autorizado a ver, em vez de tudo na base de conhecimento que seja relevante para sua consulta.

A minimização de dados, um princípio central de dados zero trust, requer que os sistemas de IA acessem e processem apenas os dados específicos necessários para a tarefa atual. Um assistente de IA solicitado a redigir uma resposta de e-mail não precisa de acesso ao histórico completo do cliente. Uma ferramenta de IA que resume um documento específico não precisa de acesso à pasta circundante. A implementação da minimização de dados em sistemas de IA requer controles de acesso que operam no nível granular de dados, em vez do nível de sistema ou banco de dados.

Revisar como os[ AI features](https://trigger.fish/features/) em plataformas corporativas de IA implementam controles de acesso a dados e autorização de recuperação ajuda as organizações a avaliar se a arquitetura de segurança de dados de um fornecedor suporta princípios zero trust ou requer controles suplementares para alcançar o mesmo efeito.

### **Pilar Seis: Visibilidade e Análise**

A segurança zero trust é baseada na capacidade de detectar anomalias que indicam violações de confiança, o que requer visibilidade abrangente de tudo o que o sistema de IA faz. Sem cobertura de registro e monitoramento em cada interação do sistema de IA, a verificação zero trust não produz sinal quando ocorrem violações, porque as evidências necessárias para detectá-las não existem.

Para sistemas de IA, os requisitos de visibilidade se estendem além do registro convencional de aplicações. Cada consulta submetida ao modelo, cada documento recuperado por meio de pipelines RAG, cada chamada de ferramenta executada por um agente, cada saída produzida pelo sistema e cada decisão de controle de acesso tomada em cada ponto de verificação precisa ser capturada em logs que as equipes de operações de segurança podem monitorar e investigar.

A análise comportamental aplicada aos logs de atividade do sistema de IA cria a capacidade de detecção de anomalias que torna a visibilidade zero trust acionável. Modelos de linha de base do comportamento normal do sistema de IA, incluindo padrões típicos de consulta, volumes usuais de recuperação e frequências padrão de uso de ferramentas, permitem a detecção de desvios que podem indicar prompt injection, tentativas de exfiltração de dados ou padrões de acesso não autorizados que seriam invisíveis sem pontos de referência comportamentais.

### **Pilar Sete: Automação e Orquestração**

O zero trust em escala empresarial não pode ser operado manualmente. As decisões de verificação, as respostas a anomalias e as atualizações de políticas de acesso que a verificação contínua requer acontecem em uma frequência e em uma complexidade de sistema que a operação humana não consegue igualar. Automação e orquestração, o pilar final do zero trust, cobre os sistemas que tornam o zero trust operacional em escala, em vez de teórico em documentos de arquitetura.

Especificamente para sistemas de IA, a resposta automatizada a anomalias detectadas, incluindo limitação de taxa acionada por padrões de consulta incomuns, restrição de acesso acionada por anomalias comportamentais e escalonamento de alertas acionado por possíveis assinaturas de prompt injection, fornece a velocidade de resposta que torna a detecção zero trust significativa. A detecção sem resposta automatizada cria um sistema que identifica ameaças mais rapidamente do que os humanos podem agir sobre elas.


<table>
  <thead>
    <tr>
      <th>Pilar Zero Trust</th>
      <th>Aplicação Convencional</th>
      <th>Extensão Específica para Sistemas de IA</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Identidade</td>
      <td>Verificação de contas de usuário e serviço</td>
      <td>Mais identidade de agente de IA, credenciais de tarefa com escopo</td>
    </tr>
    <tr>
      <td>Dispositivo</td>
      <td>Saúde do endpoint e status de gerenciamento</td>
      <td>Mais integridade da infraestrutura de inferência de IA</td>
    </tr>
    <tr>
      <td>Rede</td>
      <td>Microssegmentação entre zonas</td>
      <td>Mais allowlists específicas de IA para acesso externo</td>
    </tr>
    <tr>
      <td>Aplicação</td>
      <td>Validação de entrada e monitoramento de saída</td>
      <td>Mais detecção de prompt injection, filtragem de saída</td>
    </tr>
    <tr>
      <td>Dados</td>
      <td>Controle de acesso baseado em classificação</td>
      <td>Mais autorização de recuperação, minimização de dados em consultas</td>
    </tr>
    <tr>
      <td>Visibilidade</td>
      <td>Logs de aplicação e acesso</td>
      <td>Mais logs de consulta de modelo, recuperação, chamada de ferramenta e saída</td>
    </tr>
    <tr>
      <td>Automação</td>
      <td>Aplicação de políticas e resposta a anomalias</td>
      <td>Mais análise comportamental e resposta específicas de IA</td>
    </tr>
  </tbody>
</table>



## **Construindo Segurança de IA Zero Trust na Prática**

### **Começando com uma Auditoria de Acesso**

O ponto de partida prático para a segurança de IA zero trust é uma auditoria honesta do que cada sistema de IA na implantação da organização pode acessar atualmente versus o que ele realmente precisa acessar para sua função definida. A lacuna entre esses dois inventários define o trabalho de remediação de privilégio mínimo que aproxima a implantação dos princípios zero trust.

A maioria dos sistemas de IA, particularmente aqueles que evoluíram por meio de trabalho iterativo de integração, acumulou permissões de acesso que refletem a história do que foi conectado, em vez de uma avaliação deliberada do que é necessário. Uma ferramenta de IA de pesquisa que foi integrada com e-mail para recuperar documentos referenciados, depois conectada ao sistema de gerenciamento de documentos para um contexto mais amplo, depois vinculada ao CRM para referência de clientes, pode agora ter acesso a três sistemas que contêm dados sensíveis muito além do que qualquer tarefa de pesquisa específica requer.

A auditoria de acesso produz um mapa de capacidades, cada sistema que uma ferramenta de IA pode acessar, cada ação que pode realizar e cada categoria de dados que pode recuperar, juntamente com um mapa de requisitos operacionais, cada sistema que ela realmente precisa para sua função definida, cada ação que essa função legitimamente requer e cada categoria de dados que a função genuinamente precisa. A remediação é fechar a lacuna entre as duas por meio da redução do escopo de acesso, segmentação de rede e implantação de padrões de acesso just-in-time para capacidades que o sistema precisa ocasionalmente, em vez de continuamente.

### **Implementando Verificação Contínua sem Degradar o Desempenho**

Uma preocupação comum sobre a aplicação de princípios zero trust a sistemas de IA é que a verificação contínua introduzirá latência que degradará a experiência do usuário de ferramentas de IA que precisam responder rapidamente. Essa preocupação é real, mas gerenciável por meio de escolhas arquiteturais que localizam a verificação nos pontos certos, em vez de adicioná-la uniformemente a cada interação.

A verificação em nível de sessão para acesso autenticado do usuário lida com a maioria da sobrecarga de verificação de identidade humana com um único evento de autenticação, em vez de por consulta. Decisões de autorização em cache para padrões de acesso a dados que se repetem frequentemente reduzem a sobrecarga de verificação para operações de recuperação sem abandonar o requisito de verificação. A verificação assíncrona para operações de menor sensibilidade que podem tolerar resolução de autorização ligeiramente atrasada preserva o rastro de auditoria zero trust sem latência síncrona em cada interação.

Os pontos de verificação que genuinamente requerem comportamento síncrono de bloqueio antes de prosseguir são aqueles que governam o acesso a dados de alta sensibilidade, ações com consequências significativas ou irreversíveis e anomalias comportamentais que acionam escrutínio elevado. Para operações de rotina dentro de linhas de base comportamentais estabelecidas, a verificação pode ser tratada eficientemente sem latência visível ao usuário por meio de cache bem projetado e arquiteturas assíncronas.

Um[ AI guide](https://trigger.fish/guide/) abrangente sobre a implementação de arquiteturas de segurança de IA zero trust que equilibram o rigor da verificação com o desempenho operacional ajuda as organizações a evitar a falsa escolha entre segurança e usabilidade que implementações mal projetadas criam.

**IMAGE SUGGESTION: A developer or security architect at a dual-monitor workstation reviewing access control configuration settings for an AI system deployment, organized technical environment, code or configuration visible on one screen and a system diagram on the other, no readable text visible on either screen.**

## **Coisas a Saber**

Várias realidades importantes sobre segurança de IA zero trust que as organizações encontram ao passar dos princípios de arquitetura para a implementação operacional:

O zero trust é um processo contínuo, não um estado de implantação. As organizações não alcançam o zero trust e o mantêm passivamente. Elas se movem continuamente em direção ao zero trust por meio da redução contínua do escopo de acesso, expansão da cobertura de monitoramento e melhoria da arquitetura de verificação. O objetivo é direcional e contínuo, em vez de um estado de conclusão definido.

As integrações legadas de IA são os alvos mais difíceis de remediação zero trust. Os sistemas de IA que foram integrados à infraestrutura existente antes que os princípios zero trust fossem aplicados à implantação geralmente têm padrões de acesso que são tecnicamente difíceis de delimitar sem quebrar a funcionalidade. Remediar essas integrações requer entender tanto o requisito zero trust quanto a dependência operacional, o que muitas vezes significa trabalhar pelas integrações uma por uma, em vez de aplicar uma mudança de política uniforme.

O princípio dos 30% se aplica à automação de verificação zero trust. Os controles automatizados de verificação devem lidar com aproximadamente 30% das operações de segurança, especificamente as decisões de acesso baseadas em políticas de alta frequência e o monitoramento comportamental que a automação executa consistentemente em escala. Os profissionais de segurança e os proprietários de governança lidam com os 70% restantes que envolvem avaliação de risco, design de políticas, investigação de anomalias e as decisões de segurança intensivas em julgamento que exigem responsabilidade humana, em vez de execução algorítmica.

O zero trust não elimina a necessidade de segurança de perímetro. Ele se sobrepõe aos controles de perímetro, em vez de substituí-los. As organizações que se movem para a segurança de IA zero trust mantêm os controles de perímetro de rede enquanto adicionam as camadas de verificação de identidade, dados e comportamento que o zero trust fornece. O perímetro se torna uma camada entre muitas, em vez da defesa primária.

Os impactos na experiência do usuário da implementação zero trust determinam o sucesso da adoção. Arquiteturas de segurança que tornam as ferramentas de IA significativamente mais difíceis de usar levam os funcionários a alternativas shadow AI que operam fora de qualquer controle zero trust. Projetar fluxos de verificação que sejam minimamente intrusivos para uso legítimo, mantendo controles rigorosos para operações anômalas ou de alto risco, é um requisito de qualidade de implementação, não um aprimoramento opcional.

O suporte zero trust do fornecedor varia significativamente entre as plataformas corporativas de IA. Algumas ferramentas corporativas de IA são projetadas com pontos de integração zero trust, incluindo federação de identidade, controles de acesso granulares, APIs de registro abrangentes e suporte ao monitoramento comportamental. Outras requerem infraestrutura suplementar significativa para alcançar cobertura zero trust equivalente. Avaliar o suporte zero trust do fornecedor como parte da seleção de ferramentas de IA reduz a carga de implementação em relação à adaptação posterior de controles zero trust em ferramentas que não foram projetadas para eles.

A responsabilidade conjunta entre equipes de segurança e operações de IA é essencial para programas de segurança de IA zero trust que funcionam na prática. As equipes de segurança trazem a expertise zero trust. As equipes de operações de IA trazem o entendimento do comportamento do sistema de IA, dependências de integração e requisitos operacionais que determinam onde os controles de verificação são práticos e onde requerem soluções arquiteturais. Programas projetados por equipes de segurança sem input das operações de IA tendem a criar arquiteturas de segurança teóricas que falham na implantação.

## **Zero Trust como a Base Certa para Implantação Confiante de IA**

A segurança de IA zero trust não é a arquitetura de segurança mais conveniente para sistemas de IA. Ela requer um design de acesso mais deliberado, mais investimento em infraestrutura de verificação e mais disciplina operacional do que a segurança de perímetro ou modelos de confiança implícita. As organizações que fazem esse investimento consistentemente descobrem que ele permite, em vez de restringir, suas ambições de IA, porque cria a base de segurança que permite que os sistemas de IA sejam conectados mais amplamente, confiados mais profundamente e implantados em contextos de maior risco do que sistemas operando sem rigor de verificação equivalente.

Os sistemas de IA que, em última análise, carregarão o maior valor organizacional são aqueles confiados com os dados mais sensíveis, conectados aos sistemas mais consequenciais e autorizados a realizar as ações mais impactantes. A segurança de IA zero trust é a arquitetura que torna essa confiança defensável em vez de aspiracional, fornecendo a verificação contínua, a visibilidade comportamental e a delimitação de acesso que permite que as organizações estendam confiança significativa aos sistemas de IA, em vez de aceitar a exposição como o custo da capacidade.

## **Perguntas Frequentes**

### **O que é Zero Trust em IA?**

**Zero trust em IA é a aplicação de princípios de verificação contínua e acesso de privilégio mínimo aos sistemas de inteligência artificial, exigindo que cada usuário, modelo, agente, acesso a dados e interação de ferramenta seja verificado contra a autorização atual, em vez de depender da confiança implícita concedida na autenticação inicial ou com base na localização da rede.** Ele trata os sistemas de IA como alvos de alto valor com comportamento dinâmico e conectado que requer uma arquitetura de verificação especificamente projetada para como os sistemas de IA realmente operam, em vez de modelos convencionais de segurança de aplicações que não consideram as superfícies de ataque específicas de IA.

### **O que é segurança zero trust?**

**A segurança zero trust é um modelo de segurança baseado no princípio de que nenhum usuário, dispositivo ou sistema deve ser implicitamente confiável com base em sua localização de rede, exigindo, em vez disso, que cada solicitação de acesso seja continuamente verificada contra políticas de identidade, saúde do dispositivo e autorização contextual antes que o acesso seja concedido.** Ela substitui o modelo tradicional de perímetro que confiava em tudo dentro do limite da rede por um modelo que trata cada interação como potencialmente não confiável e requer verificação em cada ponto de acesso, independentemente de onde a solicitação se origine.

### **Qual é um exemplo de modelo de segurança zero trust?**

**Um exemplo prático de um modelo de segurança zero trust em uma implantação de IA é um assistente corporativo de IA onde cada usuário se autentica com autenticação multifator antes de acessar o sistema, o pipeline de recuperação da IA impõe as permissões de documento do usuário solicitante para que ele só possa exibir conteúdo que ele está autorizado a ver, todas as chamadas de ferramenta que o agente de IA faz requerem autorização explícita por ação, em vez de herdar amplas permissões de conta de serviço, e cada consulta, recuperação e ação é registrada para monitoramento comportamental que sinaliza anomalias para revisão de segurança.** Este exemplo ilustra o zero trust aplicado nas dimensões de identidade, dados e ação de um sistema de IA, em vez de apenas no perímetro da rede.

### **Como o Zero Trust melhora a segurança?**

**O zero trust melhora a segurança reduzindo o blast radius de ataques bem-sucedidos por meio da delimitação de acesso de privilégio mínimo que limita o que uma identidade comprometida ou um sistema de IA manipulado pode acessar, permitindo a detecção mais rápida de anomalias por meio do registro abrangente de todos os eventos de acesso contra linhas de base comportamentais, e eliminando as suposições de confiança implícita que os atacantes exploram por meio de movimento lateral uma vez que estão dentro de um perímetro de rede.** Especificamente para sistemas de IA, o zero trust melhora a segurança aplicando verificação contínua ao comportamento dinâmico e conectado dos agentes de IA que as defesas de perímetro não podem governar porque não têm um limite definido para proteger.

### **Quais são os 7 pilares do Zero Trust?**

**Os sete pilares do zero trust são a verificação de identidade que requer autenticação contínua de usuários e sistemas, a segurança de dispositivos garantindo a saúde do endpoint antes que o acesso seja concedido, a segmentação de rede substituindo a rede plana confiável por zonas microssegmentadas que requerem autorização explícita entre elas, a segurança de aplicações aplicando validação de entrada e monitoramento de saída na camada de aplicação, a segurança de dados impondo controles de acesso baseados em classificação e minimização de dados, a visibilidade e análise fornecendo registro abrangente e detecção de anomalias comportamentais, e a automação e orquestração permitindo aplicação de políticas e resposta a anomalias na escala e velocidade que a verificação contínua requer.** Aplicados a sistemas de IA, cada pilar assume extensões específicas que abordam as características únicas do comportamento de IA, conectividade e superfície de ataque que a segurança convencional de aplicações não foi projetada para governar.
