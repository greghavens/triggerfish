---
title: "Avaliação de segurança de fornecedores de AI: como avaliar ferramentas
  de AI antes de confiar a elas seus dados"
date: 2026-04-05
description: Uma avaliação de segurança de fornecedores de AI verifica se as
  ferramentas de AI atendem aos seus padrões de proteção de dados, conformidade
  e segurança antes da implantação. Veja como fazê-la corretamente.
author: triggerfish
tags:
  - AI agent
draft: false
---
Uma avaliação de segurança de fornecedores de AI é um processo de avaliação estruturado que determina se uma ferramenta ou plataforma de inteligência artificial atende aos requisitos de segurança, conformidade e proteção de dados de uma organização antes que esse fornecedor receba acesso aos dados organizacionais ou seja integrado aos fluxos de trabalho empresariais. Ela substitui suposições por evidências no ponto do processo de aquisição em que as consequências de um erro ainda são gerenciáveis.

A maioria das organizações possui processos de avaliação de segurança de fornecedores que funcionam razoavelmente bem para software convencional. O fornecedor preenche um questionário. O jurídico analisa o contrato. A TI verifica as certificações. A ferramenta é implantada. Para fornecedores de AI, esse processo deixa de captar o suficiente para importar. As perguntas que revelam os riscos mais significativos nas relações com fornecedores de AI não são aquelas presentes nos questionários padrão de fornecedores de TI. São perguntas sobre o uso dos dados de treinamento do modelo, sobre a jurisdição da infraestrutura de inferência, sobre o que acontece com os dados quando uma conversa termina, e sobre se a certificação de segurança que o fornecedor está apresentando cobre o produto específico que está sendo implantado ou uma parte totalmente diferente de sua infraestrutura. As organizações que descobrem essas lacunas depois de assinar contratos e depois que dados sensíveis fluíram por sistemas que não avaliaram adequadamente são aquelas que fazem essa avaliação com mais cuidado na segunda vez. Este guia explica como conduzir uma avaliação de segurança de fornecedores de AI que capte o que importa, quais evidências exigir em vez de aceitar por afirmação, e como construir o processo de avaliação como uma capacidade organizacional repetível.



![AI agent](/blog/images/procurement.jpg)

## **Por que as avaliações padrão de fornecedores são insuficientes para AI**

### **As lacunas que os questionários genéricos não captam**

Os questionários padrão de segurança de fornecedores de TI foram desenvolvidos para um ambiente de software no qual as principais preocupações de segurança eram a segurança do armazenamento de dados, controles de acesso e proteção de rede. Essas preocupações também se aplicam a fornecedores de AI. Mas os sistemas de AI introduzem um conjunto de preocupações adicionais que os questionários genéricos não foram projetados para revelar e que os fornecedores não divulgarão voluntariamente se não forem especificamente questionados.

O uso de dados de treinamento do modelo é a primeira lacuna. Se um fornecedor utiliza dados enviados através de seu produto para treinar ou melhorar seus modelos de AI é uma das perguntas mais consequentes sobre tratamento de dados para organizações que processam informações proprietárias ou sensíveis através de ferramentas de AI. É também uma pergunta que os questionários padrão de fornecedores não incluem porque não tem equivalente na aquisição de software convencional. Um fornecedor de banco de dados não treina seu produto com seus dados. Um fornecedor de AI pode fazê-lo, e se faz ou não, isso geralmente está enterrado na linguagem dos termos de serviço em vez de divulgado de forma proeminente.

A localização da infraestrutura de inferência é a segunda lacuna. Onde um modelo de AI processa fisicamente seus dados determina quais marcos legais se aplicam a esse processamento, se são necessários mecanismos de transferência transfronteiriça de dados, e qual processo legal de jurisdição pode obrigar à divulgação desses dados. As avaliações padrão de fornecedores perguntam onde os dados são armazenados. As avaliações de AI precisam perguntar separadamente onde os dados são processados durante a inferência, o que pode ser uma infraestrutura diferente em uma localização diferente.

O limite de escopo das certificações de segurança é a terceira lacuna. Um fornecedor pode apresentar um relatório SOC 2 Type 2 que cobre sua infraestrutura em nuvem, enquanto o produto de AI específico que está sendo avaliado roda em infraestrutura diferente que não está dentro do escopo de auditoria. Sem verificar que as certificações apresentadas cobrem o produto específico e a infraestrutura relevante para sua implantação, uma revisão de certificação pode fornecer falsa confiança sobre uma implantação que nunca foi examinada.

Compreender como os requisitos de avaliação de [AI security](https://trigger.fish/security/) diferem da avaliação convencional de segurança de fornecedores ajuda as organizações a construir processos de avaliação que abordem o cenário real de riscos de AI em vez do cenário convencional de riscos de software para o qual esses processos foram originalmente projetados.



![AI agent](/blog/images/security-reviewing.jpg)

## **Construindo o framework de avaliação de segurança de fornecedores de AI**

### **Os cinco domínios que toda avaliação deve cobrir**

Uma avaliação eficaz de segurança de fornecedores de AI organiza sua avaliação em cinco domínios que juntos fornecem uma visão completa da postura de segurança do fornecedor para a implantação específica em consideração. Cada domínio aborda uma dimensão distinta de risco que os outros não cobrem, razão pela qual avaliações que se concentram em um ou dois domínios e ignoram o restante consistentemente deixam de captar riscos materiais.

**Segurança técnica** cobre os controles de infraestrutura que protegem os dados processados pelos sistemas de AI do fornecedor. Este é o domínio que mais se sobrepõe à avaliação convencional de segurança de fornecedores e cobre padrões de criptografia, arquitetura de segurança de rede, práticas de gestão de vulnerabilidades, capacidades de detecção e resposta a incidentes, e a segurança física da infraestrutura que executa as cargas de trabalho de AI.

**Governança de dados** cobre o que o fornecedor faz com os dados organizacionais ao longo de seu ciclo de vida em seus sistemas. Este domínio inclui políticas de uso de dados de treinamento, práticas de retenção de logs de inferência, capacidades e cronogramas de exclusão de dados, relacionamentos com suboperadores e seu acesso a dados, mecanismos de transferência transfronteiriça de dados, e as proteções contratuais que regem tudo o acima.

**Conformidade e certificação** cobre a verificação independente das alegações de segurança do fornecedor e os marcos regulatórios que seu produto pode suportar. Este domínio inclui a revisão de documentos específicos de certificação em vez de aceitar declarações do fornecedor, a verificação do escopo e atualidade da certificação, a avaliação da disponibilidade de acordos de dados exigidos e a confirmação de suporte para requisitos de conformidade setoriais aplicáveis à sua organização.

**Segurança específica de AI** cobre os riscos exclusivos de sistemas de AI que não têm equivalente em avaliações convencionais de fornecedores de software. Este domínio inclui suscetibilidade a prompt injection e controles de mitigação, testes de robustez adversária, proteções contra extração de modelo, taxas de alucinação e abordagens de mitigação para o caso de uso específico que está sendo implantado, e a abordagem do fornecedor para atualizações de modelo e gestão de mudanças comportamentais.

**Segurança operacional** cobre as práticas de segurança do fornecedor como organização, em vez dos controles técnicos de seu produto específico. Este domínio inclui a estrutura e expertise da equipe de segurança, práticas de divulgação de segurança e gestão de vulnerabilidades, processos de notificação de violações e histórico de incidentes, e a própria segurança da cadeia de suprimentos do fornecedor para os componentes e serviços dos quais seu produto de AI depende.


<table>
  <thead>
    <tr>
      <th>Domínio de avaliação</th>
      <th>Perguntas principais</th>
      <th>Evidência exigida</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Segurança técnica</td>
      <td>Padrões de criptografia, arquitetura de rede, gestão de vulnerabilidades</td>
      <td>Relatório SOC 2 Type 2, resumos de testes de penetração</td>
    </tr>
    <tr>
      <td>Governança de dados</td>
      <td>Uso de dados de treinamento, períodos de retenção, capacidades de exclusão, suboperadores</td>
      <td>Termos contratuais, acordo de processamento de dados, lista de suboperadores</td>
    </tr>
    <tr>
      <td>Conformidade e certificação</td>
      <td>Escopo e atualidade da certificação, disponibilidade de acordo de dados, suporte regulatório</td>
      <td>Documentos atuais de certificação, DPA ou BAA assinado</td>
    </tr>
    <tr>
      <td>Segurança específica de AI</td>
      <td>Controles contra prompt injection, robustez adversária, práticas de atualização de modelo</td>
      <td>Documentação técnica, resultados de testes de segurança</td>
    </tr>
    <tr>
      <td>Segurança operacional</td>
      <td>Equipe de segurança, práticas de divulgação, histórico de incidentes, cadeia de suprimentos</td>
      <td>Divulgações de segurança, histórico de notificações de incidentes</td>
    </tr>
  </tbody>
</table>



### **O padrão de evidência que separa avaliação de aceitação**

A disciplina mais importante na avaliação de segurança de fornecedores de AI é exigir evidência em vez de aceitar afirmações. As alegações de segurança do fornecedor feitas em conversas de vendas, materiais de marketing e até questionários preenchidos pelo fornecedor não são declarações de fato verificadas de forma independente. São representações cuja precisão depende da própria avaliação do fornecedor sobre sua postura de segurança e de seu incentivo comercial para apresentá-la de forma favorável.

A avaliação baseada em evidências exige que cada alegação significativa de segurança seja apoiada por documentação que uma parte independente tenha verificado ou que a organização possa verificar diretamente. Um fornecedor que alega conformidade com SOC 2 deve produzir o relatório SOC 2 real, não um resumo ou um selo. O relatório deve ser lido, não apenas recebido, com atenção ao limite do escopo, o período de auditoria, os controles específicos testados, e quaisquer exceções ou desvios observados. Um fornecedor que alega que seu produto não usa dados do cliente para treinamento de modelo deve ter essa proibição documentada nos termos contratuais que governarão o relacionamento, não apenas declarada em uma conversa de vendas.

A disciplina de verificação se estende às próprias certificações. Os auditores SOC 2 variam em qualidade e rigor. Um relatório de auditoria de uma empresa reconhecida com expertise demonstrada no setor de tecnologia fornece evidência mais forte do que um de uma empresa desconhecida com histórico limitado de auditoria de tecnologia. O período do relatório importa porque um relatório que cobre um período de auditoria muito curto pode refletir uma primeira auditoria projetada para obter certificação rapidamente, em vez de um programa de segurança maduro e sustentado.

Revisar como a documentação de [AI architecture](https://trigger.fish/architecture/) dos fornecedores descreve seus controles de segurança ajuda os avaliadores a determinar se a arquitetura técnica apresentada é coerente e defensável ou se descreve segurança em um nível de abstração que esconde lacunas significativas.

## **As perguntas específicas de AI que mais importam**

### **O que perguntar sobre o uso de dados de treinamento**

A questão do uso de dados de treinamento exige mais precisão do que uma resposta sim-ou-não, porque as práticas que criam risco significativo são mais específicas do que a pergunta geral capta. Um fornecedor que responde que não usa dados do cliente para treinamento pode estar querendo dizer algo mais restrito do que a pergunta implica.

Pergunte se o conteúdo da conversa, incluindo tanto prompts quanto respostas, é usado para treinamento ou fine-tuning do modelo em qualquer circunstância, inclusive com consentimento do cliente obtido através dos termos de serviço. Pergunte se versões agregadas ou anonimizadas dos dados do cliente contribuem para a melhoria do modelo. Pergunte se a proibição se aplica a todos os níveis de produto ou apenas ao nível enterprise que está sendo avaliado. Pergunte se a proibição é absoluta ou se pode ser renunciada por acordo com o cliente. E pergunte como a proibição é aplicada tecnicamente, não apenas contratualmente, já que uma proibição contratual que não é aplicada tecnicamente depende inteiramente da conformidade operacional do fornecedor em vez de garantias arquitetônicas.

As respostas a essas perguntas específicas de acompanhamento frequentemente revelam que as práticas de uso de dados de treinamento são mais sutis do que as declarações iniciais do fornecedor sugerem, e que as proteções disponíveis no nível enterprise que a organização está avaliando podem diferir dos termos padrão do produto de maneiras que importam para o caso de uso específico que está sendo avaliado.

### **O que perguntar sobre infraestrutura de inferência e residência de dados**

A questão da infraestrutura para sistemas de AI exige perguntar separadamente onde os pesos do modelo são armazenados, onde a inferência acontece computacionalmente, onde os dados de entrada são processados, onde os dados de saída e logs são armazenados, e onde cada um destes ocorre no contexto do nível específico do produto que está sendo implantado em vez da infraestrutura do fornecedor em geral.

Para organizações com obrigações de residência de dados, a questão da localização da inferência é frequentemente mais imediatamente consequente do que a questão da localização do armazenamento, porque os marcos regulatórios que impulsionam os requisitos de residência na maioria das jurisdições tratam a jurisdição de processamento de forma equivalente à jurisdição de armazenamento. Um fornecedor cuja infraestrutura de armazenamento está localizada na jurisdição exigida, mas cujo processamento de inferência ocorre em outro lugar, não satisfez o requisito de residência mesmo que os controles de armazenamento estejam totalmente em conformidade.

Peça ao fornecedor que forneça um diagrama de fluxo de dados que rastreie os dados organizacionais desde a submissão até a inferência, passando pela saída e pelo registro até a exclusão, com a localização física de cada estágio claramente indicada. Se o fornecedor não puder produzir essa documentação, a lacuna em sua própria compreensão de seus fluxos de dados é, por si só, uma constatação significativa de segurança.



![AI agent](/blog/images/security-team-review.jpg)

### **O que perguntar sobre atualizações de modelo e mudanças comportamentais**

Os fornecedores de AI atualizam seus modelos subjacentes em cronogramas que nem sempre são comunicados aos clientes com antecedência. Uma atualização de modelo pode alterar o comportamento de um sistema de AI de maneiras que afetam sua postura de segurança, sua conformidade com os requisitos de uso aceitável do cliente, ou a qualidade de sua saída para o caso de uso específico para o qual o cliente o implantou.

Pergunte como o fornecedor notifica os clientes sobre atualizações de modelo que afetam o comportamento relevante para segurança ou conformidade. Pergunte se os clientes enterprise têm a opção de permanecer em uma versão específica do modelo em vez de receber atualizações automáticas. Pergunte como o fornecedor testa as atualizações de modelo para regressões de segurança antes de implantá-las em ambientes de clientes. E pergunte qual é o recurso do cliente se uma atualização de modelo alterar o comportamento de maneiras que afetem a conformidade ou a segurança na implantação do cliente.

As respostas revelam o grau de controle que a organização terá sobre um componente central de seu sistema de AI implantado e a filosofia do fornecedor sobre a participação do cliente no ciclo de vida do modelo. Organizações cujos sistemas de AI implantados são usados em contextos regulados ou suporte à decisão de alto risco têm interesses mais fortes em estabilidade de modelo e notificação de atualização do que aquelas que usam AI para aplicações de produtividade de menor risco.

## **Proteções contratuais que a avaliação deve estabelecer**

### **Os acordos que precisam estar em vigor antes que os dados fluam**

A fase contratual de uma avaliação de segurança de fornecedores de AI traduz as constatações técnicas e de governança em proteções juridicamente exequíveis. Os controles técnicos protegem os dados na infraestrutura do fornecedor. As proteções contratuais definem as obrigações legais que governam como essa infraestrutura é operada e quais recursos a organização tem quando as obrigações não são cumpridas.

Um acordo de processamento de dados que cubra o produto de AI específico que está sendo implantado é o requisito contratual fundamental para qualquer fornecedor que processe dados pessoais sujeitos ao GDPR, CCPA ou marcos equivalentes. O DPA precisa abordar explicitamente a proibição de dados de treinamento, limites de retenção por categoria, obrigações de gestão de suboperadores, cronogramas de exclusão de dados e requisitos de notificação de violações. Um modelo de DPA do fornecedor que foi elaborado para serviços de nuvem gerais pode não abordar adequadamente as considerações específicas de AI que a avaliação identificou como relevantes.

Para organizações de saúde, um Business Associate Agreement é um pré-requisito legal antes que quaisquer dados que possam constituir informações de saúde protegidas fluam através do sistema de AI do fornecedor. O BAA precisa cobrir o produto específico que está sendo implantado, não apenas a infraestrutura do fornecedor em geral, e precisa confirmar que as práticas de tratamento de dados do produto de AI são consistentes com os requisitos de salvaguardas técnicas da HIPAA.

Compreender como os [AI features](https://trigger.fish/features/) em plataformas de AI enterprise estão estruturados em relação às proteções contratuais que estão sendo negociadas ajuda as organizações a identificar onde o comportamento do produto e os termos contratuais são consistentes e onde a realidade técnica do produto requer especificidade contratual adicional para alcançar a proteção que a organização exige.


<table>
  <thead>
    <tr>
      <th>Acordo exigido</th>
      <th>Quando se aplica</th>
      <th>Termos críticos para AI</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Acordo de processamento de dados</td>
      <td>Qualquer processamento de dados pessoais sob GDPR ou equivalente</td>
      <td>Proibição de dados de treinamento, limites de retenção, lista de suboperadores</td>
    </tr>
    <tr>
      <td>Business Associate Agreement</td>
      <td>Qualquer processamento de PHI sob HIPAA</td>
      <td>Cobertura específica do produto, confirmação de salvaguardas técnicas</td>
    </tr>
    <tr>
      <td>Master Services Agreement</td>
      <td>Todos os relacionamentos comerciais com fornecedores</td>
      <td>Alocação de responsabilidade, recursos por violação, devolução de dados na rescisão</td>
    </tr>
    <tr>
      <td>Adendo de segurança</td>
      <td>Contextos de processamento de dados de alta sensibilidade</td>
      <td>Obrigações específicas de segurança além dos termos padrão</td>
    </tr>
    <tr>
      <td>Documentação de risco do modelo</td>
      <td>AI em atividades financeiras reguladas</td>
      <td>Documentação do modelo, direitos de validação, notificação de atualização</td>
    </tr>
    <tr>
      <td>Acordo de confidencialidade</td>
      <td>Processo de avaliação em si e constatações sensíveis</td>
      <td>Escopo cobrindo metodologia de avaliação e requisitos organizacionais</td>
    </tr>
  </tbody>
</table>



### **Negociando além dos termos padrão**

A maioria dos acordos com fornecedores enterprise de AI começa com termos padrão elaborados para favorecer o fornecedor. O processo de avaliação deve identificar os termos específicos que requerem modificação com base nas constatações de segurança e nos requisitos de conformidade da organização, em vez de negociar contra os termos padrão em sua totalidade sem priorização.

Os termos com maior prioridade para negociação são aqueles que afetam mais diretamente os riscos de segurança e conformidade que a avaliação identificou. Cláusulas de uso de dados de treinamento que permitem uso que a organização precisa proibir. Limitações de responsabilidade insuficientes para as categorias de dados que estão sendo processadas. Prazos de notificação de violações que não satisfazem os requisitos regulatórios. Direitos de aprovação de suboperadores que dão ao fornecedor mais flexibilidade para alterar sua infraestrutura do que os requisitos de conformidade da organização podem acomodar.

Organizações com alavancagem significativa de aquisição, seja por tamanho do negócio, valor de marca ou posição de mercado, frequentemente alcançam melhorias significativas nos termos padrão de fornecedores de AI exatamente nesses pontos, porque os fornecedores valorizam o relacionamento o suficiente para acomodar requisitos que vão além de seu modelo padrão. Organizações com alavancagem limitada podem às vezes alcançar o mesmo resultado enquadrando os requisitos em termos de necessidade regulatória em vez de preferência, já que os fornecedores têm interesses comerciais em apoiar implantações em conformidade que se estendem além de qualquer relacionamento individual com o cliente.

Um [AI guide](https://trigger.fish/guide/) completo sobre estruturação de acordos com fornecedores de AI para segurança e conformidade ajuda as organizações a construir estruturas de negociação que priorizem os termos que mais afetam sua exposição real ao risco, em vez de tentar negociar cada cláusula com a mesma intensidade.

## **Construindo a avaliação em um processo repetível**

### **O fluxo de trabalho de avaliação que escala**

Organizações que conduzem avaliações de segurança de fornecedores de AI como projetos pontuais para cada aquisição significativa de AI constroem conhecimento institucional que não é transferido eficientemente para avaliações subsequentes. Organizações que constroem a avaliação como um processo repetível com metodologia documentada, modelos padrão de evidência e critérios de decisão definidos desenvolvem uma capacidade que torna cada avaliação mais rápida e mais consistente do que a anterior.

Um processo repetível de avaliação de segurança de fornecedores de AI inclui um questionário padronizado desenvolvido especificamente para fornecedores de AI que cobre os cinco domínios de avaliação, uma lista de solicitações de documentos que especifica as evidências exatas exigidas para cada alegação importante de segurança, uma estrutura de pontuação ou decisão que traduz as constatações da avaliação em recomendações de implantação, um processo de revisão que envolve as partes interessadas certas em segurança, jurídico, conformidade e funções de negócios, e um padrão de documentação que produz registros úteis tanto para a governança interna quanto para o exame regulatório externo.

O questionário e a lista de solicitações de documentos devem ser revisados e atualizados pelo menos anualmente para incorporar novas considerações de segurança específicas de AI que surgiram do cenário de fornecedores, do ambiente regulatório e da própria experiência de implantação da organização. A ferramenta de avaliação que era abrangente há doze meses pode ter lacunas significativas hoje, à medida que o cenário de ameaças à segurança de AI e as expectativas regulatórias em torno dele continuam a se desenvolver.

### **Avaliação contínua além da aquisição inicial**

Uma avaliação de segurança de fornecedores de AI conduzida no momento da aquisição fornece uma avaliação pontual da postura de segurança do fornecedor. Não fornece garantia contínua de que a postura permaneça adequada à medida que o produto do fornecedor evolui, sua infraestrutura muda, sua propriedade ou situação financeira se altera, ou novas vulnerabilidades de segurança surgem em sua stack tecnológica.

A avaliação contínua para fornecedores significativos de AI deve incluir revisão anual de certificações atualizadas e documentação de segurança, revisão de quaisquer divulgações de incidentes de segurança ou notificações de violações do fornecedor, avaliação de mudanças materiais nos termos de serviço ou políticas de privacidade do fornecedor que afetam as práticas de tratamento de dados que a avaliação inicial avaliou, e revisão de quaisquer mudanças significativas no produto de AI do fornecedor, infraestrutura ou propriedade que possam afetar as suposições de segurança subjacentes à avaliação inicial.

Organizações que tratam a avaliação de segurança de fornecedores de AI como um ponto de verificação de aquisição em vez de uma prática contínua de gestão de relacionamento acumulam o desvio gradual entre suas suposições de segurança documentadas e a postura real de segurança do fornecedor que torna a descoberta de incidentes tão custosa em relação ao monitoramento proativo.

## **Coisas para saber**

Várias realidades importantes sobre a avaliação de segurança de fornecedores de AI que as organizações encontram consistentemente à medida que seus programas amadurecem:

O escopo da avaliação precisa corresponder exatamente ao escopo da implantação. Uma avaliação de segurança que cobre a API enterprise de um fornecedor não fornece garantia sobre o produto de consumo do fornecedor. Uma avaliação que cobre o produto de geração de texto de um fornecedor não cobre seu produto de geração de imagem, mesmo que ambos tenham o mesmo nome de marca. Defina o produto específico, nível e configuração de implantação que está sendo avaliado e confirme que cada certificação e proteção contratual revisada cobre esse escopo específico.

As conversas com clientes de referência complementam a revisão de documentos de maneiras que a documentação não pode replicar. Falar com organizações de tamanho, indústria e perfil regulatório semelhantes que implantaram o mesmo produto de AI do fornecedor fornece insight qualitativo sobre a capacidade de resposta do fornecedor, as práticas reais de tratamento de dados versus as documentadas, e a experiência prática de operar o relacionamento com o fornecedor que nenhuma revisão de documentos capta.

A estabilidade financeira do fornecedor é uma dimensão legítima da avaliação de segurança. Um fornecedor de AI que cessa as operações cria desafios de portabilidade de dados, exclusão e trilha de auditoria que podem se tornar problemas de conformidade. Avaliar a saúde financeira, o horizonte de financiamento e a posição de mercado do fornecedor é apropriado para fornecedores de AI sendo considerados para implantações significativas em produção, particularmente aquelas em que dados extraídos ou treinados criam dependências contínuas.

O princípio dos 30% se aplica à alocação de esforço de avaliação. Aproximadamente 30% do esforço de avaliação deve ir para o domínio de segurança técnica em que os processos de avaliação mais comumente investem em excesso em relação à sua contribuição real para o risco. Os 70% restantes devem cobrir a governança de dados, proteções contratuais, riscos específicos de AI e as dimensões de segurança operacional que revelam os diferenciadores mais significativos entre fornecedores cujas certificações parecem semelhantes superficialmente.

As constatações da avaliação precisam ser comunicadas às partes interessadas de negócios em termos de risco, em vez de linguagem técnica. Uma constatação de que o escopo de auditoria SOC 2 de um fornecedor exclui a infraestrutura de inferência de AI é tecnicamente precisa, mas não acionável para tomadores de decisão de negócios sem tradução em termos de risco de negócios. A constatação de que o fornecedor não verificou independentemente a segurança dos sistemas que processarão seus dados mais sensíveis é a mesma constatação em linguagem que produz decisões.

Os gatilhos de reavaliação precisam ser definidos com antecedência. Eventos específicos que devem desencadear uma avaliação fresca ou parcial de segurança do fornecedor de AI, incluindo incidentes significativos do fornecedor, mudanças materiais nos termos de serviço, aquisição do fornecedor ou mudanças de propriedade, e mudanças significativas na arquitetura do produto, devem ser definidos no processo de avaliação em vez de determinados ad hoc quando esses eventos ocorrem.

## **Avaliação de segurança de fornecedores de AI como ferramenta de seleção competitiva**

Organizações que conduzem avaliações completas de segurança de fornecedores de AI consistentemente descobrem que o processo faz mais do que identificar fornecedores inaceitáveis. Ele revela diferenciação significativa entre fornecedores cujas certificações e marketing parecem semelhantes, mas cujas práticas reais de segurança diferem significativamente quando examinadas no nível de evidência em vez de no nível de afirmação.

Essa diferenciação é comercialmente útil além de seu valor de gestão de risco. Fornecedores que investem em infraestrutura de segurança genuína, mantêm certificações atuais e abrangentes, operam práticas transparentes de tratamento de dados e suportam as proteções contratuais que organizações reguladas exigem, fizeram da segurança um ativo competitivo em vez de um custo de conformidade. Identificar esses fornecedores por meio de avaliação rigorosa e construir relacionamentos duradouros com eles produz resultados de aquisição que compõem em valor à medida que o cenário de ferramentas de AI continua a evoluir e os requisitos de segurança continuam a se intensificar.

A avaliação de segurança de fornecedores de AI é onde o compromisso com a adoção responsável de AI encontra a realidade operacional de escolher em quem confiar com os dados que mais importam. Organizações que fazem esse trabalho de forma completa, consistente e com os padrões de evidência que merecem constroem relacionamentos com fornecedores que apoiam suas ambições de AI em vez de criar os passivos não descobertos que a avaliação inadequada inevitavelmente deixa para trás.

## **Perguntas frequentes**

### **Como avaliar fornecedores de AI?**

**Avaliar fornecedores de AI requer uma avaliação estruturada em cinco domínios: controles de segurança técnica verificados por meio de documentos atuais de certificação, práticas de governança de dados cobrindo uso de dados de treinamento e retenção verificadas por meio de termos contratuais, escopo e atualidade da certificação de conformidade verificados por meio de relatórios reais em vez de declarações do fornecedor, considerações de segurança específicas de AI incluindo controles contra prompt injection e práticas de atualização de modelo, e segurança operacional cobrindo as práticas de segurança organizacional e histórico de incidentes do fornecedor.** A avaliação produz decisões de implantação baseadas em evidências em vez de afirmações do fornecedor, com proteções contratuais estabelecidas antes que quaisquer dados organizacionais fluam através do sistema do fornecedor.

### **O que é a avaliação de segurança usando AI?**

**Uma avaliação de segurança usando AI refere-se à aplicação de ferramentas de inteligência artificial para melhorar a eficiência e a cobertura dos processos de avaliação de segurança, incluindo o uso de AI para analisar a documentação do fornecedor em busca de cláusulas relevantes para segurança, automatizar a análise de respostas a questionários em várias submissões de fornecedores, monitorar continuamente as divulgações de segurança e notificações de incidentes do fornecedor, e identificar padrões em dados de postura de segurança do fornecedor que processos de revisão manual perderiam.** É distinta da avaliação de segurança de fornecedores de AI, que avalia a segurança das próprias ferramentas de AI, embora organizações com programas de segurança maduros estejam cada vez mais usando AI para aprimorar tanto seus processos de avaliação de fornecedores de AI quanto suas capacidades mais amplas de avaliação de segurança.

### **O que é uma avaliação de segurança de fornecedor?**

**Uma avaliação de segurança de fornecedor é uma avaliação estruturada dos controles de segurança, práticas de tratamento de dados, certificações de conformidade e proteções contratuais de um provedor de tecnologia terceirizado antes que esse fornecedor receba acesso aos dados organizacionais ou seja integrado aos sistemas de negócios.** Para fornecedores de AI especificamente, a avaliação se estende além da avaliação convencional de segurança de fornecedores para abordar os riscos específicos de AI de uso de dados de treinamento, jurisdição da infraestrutura de inferência, práticas de atualização de modelo e as superfícies de ataque específicas de AI que os questionários padrão de fornecedores de TI não foram projetados para revelar.

### **Quais medidas podem ser implementadas para garantir que um fornecedor de AI seja seguro?**

**As cinco medidas mais importantes para garantir que um fornecedor de AI seja seguro são exigir documentos atuais de certificação SOC 2 Type 2 ou equivalentes cobrindo o produto e a infraestrutura específicos que estão sendo implantados, obter acordos de processamento de dados assinados com proibições explícitas de dados de treinamento e limites definidos de retenção antes que quaisquer dados organizacionais sejam processados, verificar que a infraestrutura de inferência está localizada em jurisdições que satisfazem os requisitos aplicáveis de residência de dados, confirmar por meio de termos contratuais e documentação técnica que os controles de segurança do fornecedor abordam os riscos específicos de AI incluindo prompt injection e extração de modelo, e estabelecer um processo contínuo de monitoramento do fornecedor que revisa renovações de certificação, divulgações de incidentes e mudanças materiais nos termos de serviço em um ciclo anual definido.** Juntas, essas medidas criam um relacionamento de segurança com o fornecedor de AI baseado em evidências verificadas e obrigações exequíveis em vez de afirmações não verificadas e boa fé presumida.

### **Quais são as 5 medidas de segurança?**

**As cinco medidas fundamentais de segurança que se aplicam aos relacionamentos com fornecedores de AI são criptografia de dados em trânsito e em repouso usando padrões atuais com práticas documentadas de gestão de chaves, controles de acesso que limitam quem na organização do fornecedor pode acessar dados organizacionais e sob quais condições, registro abrangente de todos os eventos de acesso e processamento de dados com períodos de retenção que apoiam investigação de incidentes, práticas de gestão de vulnerabilidades incluindo testes regulares de segurança e prazos definidos de remediação para vulnerabilidades identificadas, e processos de notificação de violações que comprometem o fornecedor com divulgação oportuna com prazos específicos que satisfaçam as obrigações regulatórias de notificação da organização.** Essas cinco medidas representam a linha de base técnica de segurança que deve ser verificada por meio de evidências para cada fornecedor de AI sendo avaliado para responsabilidades significativas de processamento de dados, com as dimensões de avaliação específicas de AI sobrepostas a essa base de segurança convencional.
