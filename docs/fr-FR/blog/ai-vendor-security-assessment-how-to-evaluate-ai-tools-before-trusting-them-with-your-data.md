---
title: "Évaluation de Sécurité des Fournisseurs d'AI : Comment Évaluer les Outils d'AI Avant de Leur Confier vos Données"
date: 2026-04-05
description: Une évaluation de sécurité des fournisseurs d'AI vérifie que les outils d'AI répondent à vos normes de protection des données, de conformité et de sécurité avant leur déploiement. Voici comment procéder correctement.
author: triggerfish
tags:
  - AI agent
draft: false
---
Une évaluation de sécurité des fournisseurs d'AI est un processus d'évaluation structuré qui détermine si un outil ou une plateforme d'intelligence artificielle répond aux exigences de sécurité, de conformité et de protection des données d'une organisation avant que ce fournisseur ne se voie accorder l'accès aux données organisationnelles ou ne soit intégré dans les flux de travail de l'entreprise. Elle remplace la supposition par la preuve, au moment du processus d'achat où les conséquences d'une erreur restent gérables.

La plupart des organisations disposent de processus d'évaluation de sécurité des fournisseurs qui fonctionnent raisonnablement bien pour les logiciels conventionnels. Le fournisseur remplit un questionnaire. Le service juridique examine le contrat. L'informatique vérifie les certifications. L'outil est déployé. Pour les fournisseurs d'AI, ce processus passe à côté de suffisamment d'éléments pour que cela soit important. Les questions qui révèlent les risques les plus significatifs dans les relations avec les fournisseurs d'AI ne sont pas celles des questionnaires standard pour fournisseurs informatiques. Ce sont des questions sur l'utilisation des données d'entraînement des modèles, sur la juridiction de l'infrastructure d'inférence, sur ce qui arrive aux données à la fin d'une conversation, et sur la question de savoir si la certification de sécurité présentée par le fournisseur couvre le produit spécifique déployé ou une partie entièrement différente de son infrastructure. Les organisations qui découvrent ces lacunes après la signature des contrats et après que des données sensibles ont circulé dans des systèmes qu'elles n'avaient pas correctement évalués sont celles qui mènent cette évaluation avec plus de soin la deuxième fois. Ce guide explique comment mener une évaluation de sécurité des fournisseurs d'AI qui détecte ce qui compte, quelles preuves exiger plutôt que d'accepter une affirmation, et comment intégrer le processus d'évaluation dans une capacité organisationnelle reproductible.



![AI agent](/blog/images/procurement.jpg)

## **Pourquoi les Évaluations Standards des Fournisseurs Sont Insuffisantes pour l'AI**

### **Les Lacunes Que les Questionnaires Génériques Manquent**

Les questionnaires standards de sécurité des fournisseurs informatiques ont été développés pour un environnement logiciel où les principales préoccupations de sécurité étaient la sécurité du stockage des données, les contrôles d'accès et la protection du réseau. Ces préoccupations s'appliquent également aux fournisseurs d'AI. Mais les systèmes d'AI introduisent un ensemble de préoccupations supplémentaires que les questionnaires génériques n'ont pas été conçus pour faire émerger et que les fournisseurs ne révéleront pas spontanément si on ne les leur demande pas spécifiquement.

L'utilisation des données d'entraînement des modèles est la première lacune. Savoir si un fournisseur utilise les données soumises via son produit pour entraîner ou améliorer ses modèles d'AI est l'une des questions les plus lourdes de conséquences en matière de gestion des données pour les organisations qui traitent des informations propriétaires ou sensibles via des outils d'AI. C'est aussi une question que les questionnaires standards des fournisseurs n'incluent pas, car elle n'a pas d'équivalent dans l'achat de logiciels conventionnels. Un fournisseur de bases de données n'entraîne pas son produit sur vos données. Un fournisseur d'AI le pourrait, et que cela soit le cas ou non est souvent enfoui dans le langage des conditions d'utilisation plutôt que clairement divulgué.

L'emplacement de l'infrastructure d'inférence est la deuxième lacune. L'endroit où un modèle d'AI traite physiquement vos données détermine quels cadres juridiques s'appliquent à ce traitement, si des mécanismes de transfert transfrontalier de données sont requis, et quel processus juridique de quelle juridiction peut contraindre à la divulgation de ces données. Les évaluations standards des fournisseurs demandent où les données sont stockées. Les évaluations d'AI doivent demander séparément où les données sont traitées pendant l'inférence, ce qui peut être une infrastructure différente dans un emplacement différent.

La limite de portée des certifications de sécurité est la troisième lacune. Un fournisseur peut présenter un rapport SOC 2 Type 2 couvrant son infrastructure cloud alors que le produit d'AI spécifique évalué fonctionne sur une infrastructure différente qui n'est pas dans le périmètre d'audit. Sans vérifier que les certifications présentées couvrent le produit spécifique et l'infrastructure pertinente pour votre déploiement, un examen de certification peut fournir une fausse confiance concernant un déploiement qui n'a jamais été examiné.

Comprendre comment les exigences d'évaluation[ AI security](https://trigger.fish/security/) diffèrent de l'évaluation conventionnelle de sécurité des fournisseurs aide les organisations à construire des processus d'évaluation qui répondent au paysage réel des risques liés à l'AI plutôt qu'au paysage conventionnel des risques logiciels pour lesquels ces processus ont été initialement conçus.



![AI agent](/blog/images/security-reviewing.jpg)

## **Construire le Cadre d'Évaluation de Sécurité des Fournisseurs d'AI**

### **Les Cinq Domaines Que Toute Évaluation Doit Couvrir**

Une évaluation efficace de sécurité des fournisseurs d'AI organise son évaluation à travers cinq domaines qui, ensemble, fournissent une image complète de la posture de sécurité du fournisseur pour le déploiement spécifique envisagé. Chaque domaine traite d'une dimension distincte du risque que les autres ne couvrent pas, raison pour laquelle les évaluations qui se concentrent sur un ou deux domaines tout en sautant les autres manquent systématiquement des risques importants.

**Sécurité technique** couvre les contrôles d'infrastructure qui protègent les données traitées par les systèmes d'AI du fournisseur. C'est le domaine qui chevauche le plus l'évaluation conventionnelle de sécurité des fournisseurs et couvre les normes de chiffrement, l'architecture de sécurité réseau, les pratiques de gestion des vulnérabilités, les capacités de détection et de réponse aux incidents, et la sécurité physique de l'infrastructure exécutant les charges de travail d'AI.

**Gouvernance des données** couvre ce que le fournisseur fait avec les données organisationnelles tout au long de leur cycle de vie dans ses systèmes. Ce domaine comprend les politiques d'utilisation des données d'entraînement, les pratiques de conservation des journaux d'inférence, les capacités et délais de suppression des données, les relations avec les sous-traitants et leur accès aux données, les mécanismes de transfert transfrontalier de données, et les protections contractuelles qui régissent tout ce qui précède.

**Conformité et certification** couvre la vérification indépendante des affirmations de sécurité du fournisseur et les cadres réglementaires que son produit peut prendre en charge. Ce domaine comprend l'examen des documents de certification spécifiques plutôt que l'acceptation des déclarations du fournisseur, la vérification de la portée et de l'actualité de la certification, l'évaluation de la disponibilité des accords de données requis, et la confirmation de la prise en charge des exigences de conformité spécifiques au secteur applicables à votre organisation.

**Sécurité spécifique à l'AI** couvre les risques propres aux systèmes d'AI qui n'ont pas d'équivalent dans les évaluations conventionnelles de fournisseurs de logiciels. Ce domaine comprend la sensibilité à l'injection de prompts et les contrôles d'atténuation, les tests de robustesse adversariale, les protections contre l'extraction de modèles, les taux d'hallucination et les approches d'atténuation pour le cas d'usage spécifique déployé, et l'approche du fournisseur concernant les mises à jour des modèles et la gestion du changement comportemental.

**Sécurité opérationnelle** couvre les pratiques de sécurité du fournisseur en tant qu'organisation plutôt que les contrôles techniques de son produit spécifique. Ce domaine comprend la structure et l'expertise de l'équipe de sécurité, les pratiques de divulgation de sécurité et de gestion des vulnérabilités, les processus de notification de violation et l'historique des incidents, et la propre sécurité de la chaîne d'approvisionnement du fournisseur pour les composants et services dont dépend son produit d'AI.


<table>
  <thead>
    <tr>
      <th>Domaine d'Évaluation</th>
      <th>Questions Principales</th>
      <th>Preuves Requises</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Sécurité Technique</td>
      <td>Normes de chiffrement, architecture réseau, gestion des vulnérabilités</td>
      <td>Rapport SOC 2 Type 2, résumés des tests d'intrusion</td>
    </tr>
    <tr>
      <td>Gouvernance des Données</td>
      <td>Utilisation des données d'entraînement, périodes de conservation, capacités de suppression, sous-traitants</td>
      <td>Conditions contractuelles, accord de traitement des données, liste des sous-traitants</td>
    </tr>
    <tr>
      <td>Conformité et Certification</td>
      <td>Portée et actualité de certification, disponibilité d'accord de données, prise en charge réglementaire</td>
      <td>Documents de certification actuels, DPA ou BAA signé</td>
    </tr>
    <tr>
      <td>Sécurité Spécifique à l'AI</td>
      <td>Contrôles d'injection de prompts, robustesse adversariale, pratiques de mise à jour des modèles</td>
      <td>Documentation technique, résultats des tests de sécurité</td>
    </tr>
    <tr>
      <td>Sécurité Opérationnelle</td>
      <td>Équipe de sécurité, pratiques de divulgation, historique des incidents, chaîne d'approvisionnement</td>
      <td>Divulgations de sécurité, historique des notifications d'incidents</td>
    </tr>
  </tbody>
</table>



### **Le Standard de Preuve Qui Sépare l'Évaluation de l'Acceptation**

La discipline la plus importante dans l'évaluation de sécurité des fournisseurs d'AI est d'exiger des preuves plutôt que d'accepter des affirmations. Les affirmations de sécurité des fournisseurs faites lors de conversations commerciales, dans les supports marketing et même dans les questionnaires remplis par les fournisseurs ne sont pas des déclarations de faits vérifiées de manière indépendante. Ce sont des représentations dont l'exactitude dépend de la propre évaluation du fournisseur de sa posture de sécurité et de son incitation commerciale à la présenter favorablement.

L'évaluation fondée sur les preuves exige que chaque affirmation significative de sécurité soit étayée par une documentation qu'une partie indépendante a vérifiée ou que l'organisation peut vérifier directement. Un fournisseur qui prétend être conforme SOC 2 devrait produire le véritable rapport SOC 2, et non un résumé ou un badge. Le rapport doit être lu, et pas seulement reçu, en prêtant attention à la limite de portée, à la période d'audit, aux contrôles spécifiques testés et à toute exception ou déviation notée. Un fournisseur qui prétend que son produit n'utilise pas les données client pour l'entraînement du modèle devrait avoir cette interdiction documentée dans les conditions contractuelles qui régiront la relation, et non simplement énoncée lors d'une conversation commerciale.

La discipline de vérification s'étend aux certifications elles-mêmes. Les auditeurs SOC 2 varient en qualité et en rigueur. Un rapport d'audit d'une entreprise reconnue avec une expertise démontrée dans le secteur technologique fournit une preuve plus solide qu'un rapport d'une entreprise inconnue avec un historique limité d'audit technologique. La période du rapport est importante car un rapport couvrant une période d'audit très courte peut refléter un audit initial conçu pour obtenir rapidement la certification plutôt qu'un programme de sécurité mature et soutenu.

Examiner comment la documentation[ AI architecture](https://trigger.fish/architecture/) des fournisseurs décrit leurs contrôles de sécurité aide les évaluateurs à évaluer si l'architecture technique présentée est cohérente et défendable ou si elle décrit la sécurité à un niveau d'abstraction qui dissimule des lacunes significatives.

## **Les Questions Spécifiques à l'AI Qui Comptent le Plus**

### **Ce Qu'il Faut Demander Sur l'Utilisation des Données d'Entraînement**

La question de l'utilisation des données d'entraînement nécessite plus de précision qu'une réponse par oui ou par non, car les pratiques qui créent un risque significatif sont plus spécifiques que ce que capte la question générale. Un fournisseur qui répond qu'il n'utilise pas les données client pour l'entraînement peut vouloir dire quelque chose de plus étroit que ce que la question implique.

Demandez si le contenu de la conversation, y compris à la fois les prompts et les réponses, est utilisé pour l'entraînement du modèle ou le fine-tuning dans toutes les circonstances, y compris avec le consentement du client obtenu via les conditions d'utilisation. Demandez si des versions agrégées ou anonymisées des données client contribuent à l'amélioration du modèle. Demandez si l'interdiction s'applique à tous les niveaux de produit ou uniquement au niveau entreprise évalué. Demandez si l'interdiction est absolue ou si elle peut être levée par accord du client. Et demandez comment l'interdiction est appliquée techniquement, et pas seulement contractuellement, puisqu'une interdiction contractuelle qui n'est pas appliquée techniquement repose entièrement sur la conformité opérationnelle du fournisseur plutôt que sur des garanties architecturales.

Les réponses à ces questions de suivi spécifiques révèlent souvent que les pratiques d'utilisation des données d'entraînement sont plus nuancées que ne le suggèrent les déclarations initiales du fournisseur, et que les protections disponibles au niveau entreprise que l'organisation évalue peuvent différer des conditions standards du produit de manière à compter pour le cas d'usage spécifique évalué.

### **Ce Qu'il Faut Demander Sur l'Infrastructure d'Inférence et la Résidence des Données**

La question d'infrastructure pour les systèmes d'AI nécessite de demander séparément où sont stockés les poids du modèle, où se produit l'inférence sur le plan informatique, où les données d'entrée sont traitées, où les données de sortie et les journaux sont stockés, et où chacune de ces étapes se produit dans le contexte du niveau de produit spécifique déployé plutôt que de l'infrastructure du fournisseur en général.

Pour les organisations ayant des obligations de résidence des données, la question de l'emplacement de l'inférence est souvent plus immédiatement importante que la question de l'emplacement de stockage, car les cadres réglementaires qui motivent les exigences de résidence dans la plupart des juridictions traitent la juridiction de traitement de manière équivalente à la juridiction de stockage. Un fournisseur dont l'infrastructure de stockage est située dans la juridiction requise mais dont le traitement d'inférence se produit ailleurs n'a pas satisfait à l'exigence de résidence même si les contrôles de stockage sont entièrement conformes.

Demandez au fournisseur de fournir un schéma de flux de données qui retrace les données organisationnelles depuis la soumission jusqu'à l'inférence, jusqu'à la sortie, jusqu'à la journalisation, jusqu'à la suppression, avec l'emplacement physique de chaque étape clairement indiqué. Si le fournisseur ne peut pas produire cette documentation, la lacune dans sa propre compréhension de ses flux de données est elle-même une constatation de sécurité significative.



![AI agent](/blog/images/security-team-review.jpg)

### **Ce Qu'il Faut Demander Sur les Mises à Jour des Modèles et le Changement Comportemental**

Les fournisseurs d'AI mettent à jour leurs modèles sous-jacents selon des calendriers qui ne sont pas toujours communiqués aux clients à l'avance. Une mise à jour de modèle peut modifier le comportement d'un système d'AI de manière à affecter sa posture de sécurité, sa conformité aux exigences d'utilisation acceptable du client, ou la qualité de sa sortie pour le cas d'usage spécifique pour lequel le client l'a déployé.

Demandez comment le fournisseur notifie aux clients les mises à jour de modèle qui affectent le comportement pertinent pour la sécurité ou la conformité. Demandez si les clients entreprise ont la possibilité de rester sur une version de modèle spécifique plutôt que de recevoir des mises à jour automatiques. Demandez comment le fournisseur teste les mises à jour de modèle pour les régressions de sécurité avant de les déployer dans les environnements clients. Et demandez quel est le recours du client si une mise à jour de modèle modifie le comportement de manière à affecter la conformité ou la sécurité dans le déploiement du client.

Les réponses révèlent le degré de contrôle que l'organisation aura sur un composant central de son système d'AI déployé et la philosophie du fournisseur concernant la participation du client au cycle de vie du modèle. Les organisations dont les systèmes d'AI déployés sont utilisés dans des contextes réglementés ou pour un soutien décisionnel à enjeux élevés ont des intérêts plus forts dans la stabilité du modèle et la notification des mises à jour que celles qui utilisent l'AI pour des applications de productivité à plus faibles enjeux.

## **Protections Contractuelles Que l'Évaluation Doit Établir**

### **Les Accords Qui Doivent Être en Place Avant que les Données ne Circulent**

La phase contractuelle d'une évaluation de sécurité des fournisseurs d'AI traduit les constatations techniques et de gouvernance en protections juridiquement exécutoires. Les contrôles techniques protègent les données sur l'infrastructure du fournisseur. Les protections contractuelles définissent les obligations légales qui régissent la manière dont cette infrastructure est exploitée et les recours dont dispose l'organisation lorsque les obligations ne sont pas respectées.

Un accord de traitement des données couvrant le produit d'AI spécifique déployé est l'exigence contractuelle fondamentale pour tout fournisseur traitant des données personnelles soumises au RGPD, au CCPA, ou à des cadres équivalents. Le DPA doit traiter explicitement l'interdiction des données d'entraînement, les limites de conservation des données par catégorie, les obligations de gestion des sous-traitants, les délais de suppression des données et les exigences de notification de violation. Un modèle de DPA de fournisseur rédigé pour les services cloud généraux peut ne pas traiter adéquatement les considérations spécifiques à l'AI que l'évaluation a identifiées comme pertinentes.

Pour les organisations de santé, un Business Associate Agreement est une condition préalable légale avant que toute donnée pouvant constituer des informations de santé protégées ne circule via le système d'AI du fournisseur. Le BAA doit couvrir le produit spécifique déployé, et pas seulement l'infrastructure du fournisseur en général, et doit confirmer que les pratiques de gestion des données du produit d'AI sont cohérentes avec les exigences de protection technique HIPAA.

Comprendre comment les[ AI features](https://trigger.fish/features/) dans les plateformes d'AI d'entreprise sont structurées par rapport aux protections contractuelles négociées aide les organisations à identifier où le comportement du produit et les conditions contractuelles sont cohérents et où la réalité technique du produit nécessite une spécificité contractuelle supplémentaire pour atteindre la protection requise par l'organisation.


<table>
  <thead>
    <tr>
      <th>Accord Requis</th>
      <th>Quand Il S'Applique</th>
      <th>Conditions Critiques pour l'AI</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Accord de Traitement des Données</td>
      <td>Tout traitement de données personnelles sous RGPD ou équivalent</td>
      <td>Interdiction des données d'entraînement, limites de conservation, liste des sous-traitants</td>
    </tr>
    <tr>
      <td>Business Associate Agreement</td>
      <td>Tout traitement de PHI sous HIPAA</td>
      <td>Couverture spécifique au produit, confirmation de protection technique</td>
    </tr>
    <tr>
      <td>Accord Cadre de Services</td>
      <td>Toutes les relations commerciales avec les fournisseurs</td>
      <td>Allocation de responsabilité, recours en cas de violation, retour des données à la résiliation</td>
    </tr>
    <tr>
      <td>Avenant de Sécurité</td>
      <td>Contextes de traitement de données à haute sensibilité</td>
      <td>Obligations de sécurité spécifiques au-delà des conditions standards</td>
    </tr>
    <tr>
      <td>Documentation des Risques du Modèle</td>
      <td>AI dans les activités financières réglementées</td>
      <td>Documentation du modèle, droits de validation, notification de mise à jour</td>
    </tr>
    <tr>
      <td>Accord de Non-Divulgation</td>
      <td>Le processus d'évaluation lui-même et les constatations sensibles</td>
      <td>Portée couvrant la méthodologie d'évaluation et les exigences organisationnelles</td>
    </tr>
  </tbody>
</table>



### **Négocier Au-Delà des Conditions Standards**

La plupart des accords d'entreprise avec les fournisseurs d'AI commencent par des conditions standards rédigées pour favoriser le fournisseur. Le processus d'évaluation doit identifier les conditions spécifiques nécessitant une modification en fonction des constatations de sécurité et des exigences de conformité de l'organisation, plutôt que de négocier contre les conditions standards dans leur intégralité sans priorisation.

Les conditions ayant la priorité la plus élevée pour la négociation sont celles qui affectent le plus directement les risques de sécurité et de conformité identifiés par l'évaluation. Les clauses d'utilisation des données d'entraînement qui permettent une utilisation que l'organisation a besoin d'interdire. Les limitations de responsabilité insuffisantes pour les catégories de données traitées. Les délais de notification de violation qui ne satisfont pas aux exigences réglementaires. Les droits d'approbation des sous-traitants qui donnent au fournisseur plus de flexibilité pour modifier son infrastructure que les exigences de conformité de l'organisation ne peuvent en accommoder.

Les organisations ayant un fort pouvoir d'achat, que ce soit par la taille de l'accord, la valeur de la marque ou la position sur le marché, obtiennent souvent des améliorations significatives des conditions standards des fournisseurs d'AI sur exactement ces points, car les fournisseurs valorisent suffisamment la relation pour accommoder des exigences qui vont au-delà de leur modèle standard. Les organisations ayant un pouvoir limité peuvent parfois obtenir le même résultat en formulant les exigences en termes de nécessité réglementaire plutôt que de préférence, puisque les fournisseurs ont des intérêts commerciaux à soutenir des déploiements conformes qui s'étendent au-delà de toute relation individuelle avec le client.

Un[ AI guide](https://trigger.fish/guide/) approfondi sur la structuration des accords avec les fournisseurs d'AI pour la sécurité et la conformité aide les organisations à construire des cadres de négociation qui priorisent les conditions qui affectent le plus leur exposition réelle au risque plutôt que de tenter de négocier chaque clause avec une intensité égale.

## **Intégrer l'Évaluation dans un Processus Reproductible**

### **Le Flux de Travail d'Évaluation Qui Passe à l'Échelle**

Les organisations qui mènent des évaluations de sécurité des fournisseurs d'AI comme des projets ponctuels pour chaque acquisition significative d'AI construisent des connaissances institutionnelles qui ne se transfèrent pas efficacement aux évaluations ultérieures. Les organisations qui construisent l'évaluation comme un processus reproductible avec une méthodologie documentée, des modèles de preuves standards et des critères de décision définis développent une capacité qui rend chaque évaluation plus rapide et plus cohérente que la précédente.

Un processus reproductible d'évaluation de sécurité des fournisseurs d'AI comprend un questionnaire standardisé développé spécifiquement pour les fournisseurs d'AI qui couvre les cinq domaines d'évaluation, une liste de demande de documents qui spécifie les preuves exactes requises pour chaque affirmation majeure de sécurité, un cadre de notation ou de décision qui traduit les constatations d'évaluation en recommandations de déploiement, un processus d'examen qui implique les bonnes parties prenantes dans les fonctions de sécurité, juridique, conformité et métier, et un standard de documentation qui produit des dossiers utiles à la fois pour la gouvernance interne et l'examen réglementaire externe.

Le questionnaire et la liste de demande de documents devraient être revus et mis à jour au moins annuellement pour incorporer de nouvelles considérations de sécurité spécifiques à l'AI qui ont émergé du paysage des fournisseurs, de l'environnement réglementaire et de la propre expérience de déploiement de l'organisation. L'outil d'évaluation qui était complet il y a douze mois peut avoir des lacunes significatives aujourd'hui à mesure que le paysage des menaces de sécurité d'AI et les attentes réglementaires à son égard continuent de se développer.

### **Évaluation Continue Au-Delà de l'Acquisition Initiale**

Une évaluation de sécurité des fournisseurs d'AI menée au moment de l'acquisition fournit une évaluation ponctuelle de la posture de sécurité du fournisseur. Elle ne fournit pas d'assurance continue que la posture reste adéquate à mesure que le produit du fournisseur évolue, que son infrastructure change, que sa propriété ou sa situation financière évolue, ou que de nouvelles vulnérabilités de sécurité émergent dans sa pile technologique.

L'évaluation continue pour les fournisseurs d'AI significatifs devrait inclure l'examen annuel des certifications mises à jour et de la documentation de sécurité, l'examen de toute divulgation d'incident de sécurité ou notification de violation du fournisseur, l'évaluation des changements matériels apportés aux conditions d'utilisation ou aux politiques de confidentialité du fournisseur qui affectent les pratiques de gestion des données évaluées par l'évaluation initiale, et l'examen de tout changement significatif apporté au produit d'AI, à l'infrastructure ou à la propriété du fournisseur qui pourrait affecter les hypothèses de sécurité sous-jacentes à l'évaluation initiale.

Les organisations qui traitent l'évaluation de sécurité des fournisseurs d'AI comme un point de contrôle d'acquisition plutôt qu'une pratique continue de gestion des relations accumulent la dérive progressive entre leurs hypothèses de sécurité documentées et la posture de sécurité réelle du fournisseur qui rend la découverte d'incidents si coûteuse par rapport à la surveillance proactive.

## **Choses à Savoir**

Plusieurs réalités importantes concernant l'évaluation de sécurité des fournisseurs d'AI que les organisations rencontrent systématiquement à mesure que leurs programmes mûrissent :

La portée de l'évaluation doit correspondre exactement à la portée du déploiement. Une évaluation de sécurité couvrant l'API d'entreprise d'un fournisseur ne fournit pas d'assurance sur le produit grand public du fournisseur. Une évaluation couvrant le produit de génération de texte d'un fournisseur ne couvre pas son produit de génération d'images, même si les deux portent le même nom de marque. Définissez le produit spécifique, le niveau et la configuration de déploiement évalués et confirmez que chaque certification et protection contractuelle examinée couvre cette portée spécifique.

Les conversations avec les clients de référence complètent l'examen de la documentation de manière que la documentation ne peut pas reproduire. Parler avec des organisations de taille, d'industrie et de profil réglementaire similaires qui ont déployé le même produit d'AI du fournisseur fournit un aperçu qualitatif de la réactivité du fournisseur, des pratiques réelles de gestion des données par rapport à celles documentées, et de l'expérience pratique d'exploitation de la relation avec le fournisseur qu'aucun examen de documents ne capture.

La stabilité financière du fournisseur est une dimension légitime de l'évaluation de sécurité. Un fournisseur d'AI qui cesse ses activités crée des défis de portabilité des données, de suppression et de piste d'audit qui peuvent devenir des problèmes de conformité. Évaluer la santé financière du fournisseur, sa marge de financement et sa position sur le marché est approprié pour les fournisseurs d'AI envisagés pour des déploiements de production significatifs, en particulier ceux où les données extraites ou entraînées créent des dépendances continues.

Le principe des 30 % s'applique à l'allocation de l'effort d'évaluation. Environ 30 % de l'effort d'évaluation devrait aller au domaine de la sécurité technique que les processus d'évaluation surinvestissent le plus souvent par rapport à sa contribution réelle au risque. Les 70 % restants devraient couvrir la gouvernance des données, les protections contractuelles, les risques spécifiques à l'AI et les dimensions de sécurité opérationnelle qui révèlent les différenciateurs les plus significatifs entre des fournisseurs dont les certifications semblent similaires en surface.

Les constatations d'évaluation doivent être communiquées aux parties prenantes de l'entreprise en termes de risque plutôt qu'en langage technique. Une constatation selon laquelle la portée de l'audit SOC 2 d'un fournisseur exclut l'infrastructure d'inférence d'AI est techniquement exacte mais non exploitable pour les décideurs commerciaux sans traduction en termes de risque commercial. La constatation que le fournisseur n'a pas vérifié de manière indépendante la sécurité des systèmes qui traiteront vos données les plus sensibles est la même constatation dans un langage qui produit des décisions.

Les déclencheurs de réévaluation doivent être définis à l'avance. Les événements spécifiques qui devraient déclencher une nouvelle évaluation de sécurité des fournisseurs d'AI ou une évaluation partielle, y compris les incidents significatifs du fournisseur, les changements matériels des conditions d'utilisation, l'acquisition du fournisseur ou les changements de propriété, et les changements significatifs d'architecture du produit, devraient être définis dans le processus d'évaluation plutôt que déterminés ad hoc lorsque ces événements se produisent.

## **L'Évaluation de Sécurité des Fournisseurs d'AI Comme Outil Compétitif de Sélection**

Les organisations qui mènent des évaluations approfondies de sécurité des fournisseurs d'AI constatent systématiquement que le processus fait plus qu'identifier les fournisseurs inacceptables. Il révèle une différenciation significative entre des fournisseurs dont les certifications et le marketing semblent similaires mais dont les pratiques de sécurité réelles diffèrent significativement lorsqu'elles sont examinées au niveau de la preuve plutôt que de l'affirmation.

Cette différenciation est commercialement utile au-delà de sa valeur de gestion des risques. Les fournisseurs qui investissent dans une véritable infrastructure de sécurité, maintiennent des certifications actuelles et complètes, exploitent des pratiques transparentes de gestion des données, et soutiennent les protections contractuelles requises par les organisations réglementées ont fait de la sécurité un atout compétitif plutôt qu'un coût de conformité. Identifier ces fournisseurs grâce à une évaluation rigoureuse et construire des relations durables avec eux produit des résultats d'acquisition dont la valeur se cumule à mesure que le paysage des outils d'AI continue d'évoluer et que les exigences de sécurité continuent de se durcir.

L'évaluation de sécurité des fournisseurs d'AI est l'endroit où l'engagement envers l'adoption responsable de l'AI rencontre la réalité opérationnelle du choix des personnes à qui confier les données qui comptent le plus. Les organisations qui font ce travail de manière approfondie, cohérente et avec les standards de preuve qu'il mérite construisent des relations avec les fournisseurs qui soutiennent leurs ambitions d'AI plutôt que de créer les responsabilités non découvertes qu'une évaluation inadéquate laisse inévitablement derrière.

## **Questions Fréquentes**

### **Comment évaluer les fournisseurs d'AI ?**

**Évaluer les fournisseurs d'AI nécessite une évaluation structurée à travers cinq domaines : les contrôles de sécurité technique vérifiés à travers des documents de certification actuels, les pratiques de gouvernance des données couvrant l'utilisation des données d'entraînement et la conservation vérifiées à travers les conditions contractuelles, la portée et l'actualité de la certification de conformité vérifiées à travers des rapports réels plutôt que des déclarations du fournisseur, les considérations de sécurité spécifiques à l'AI y compris les contrôles d'injection de prompts et les pratiques de mise à jour des modèles, et la sécurité opérationnelle couvrant les pratiques de sécurité organisationnelle du fournisseur et l'historique des incidents.** L'évaluation produit des décisions de déploiement basées sur des preuves plutôt que sur des affirmations du fournisseur, avec des protections contractuelles établies avant que toute donnée organisationnelle ne circule via le système du fournisseur.

### **Qu'est-ce que l'évaluation de sécurité utilisant l'AI ?**

**Une évaluation de sécurité utilisant l'AI fait référence à l'application d'outils d'intelligence artificielle pour améliorer l'efficacité et la couverture des processus d'évaluation de sécurité, y compris l'utilisation de l'AI pour analyser la documentation du fournisseur pour les clauses pertinentes en matière de sécurité, automatiser l'analyse des réponses aux questionnaires à travers de multiples soumissions de fournisseurs, surveiller en continu les divulgations de sécurité et les notifications d'incidents du fournisseur, et identifier des modèles dans les données de posture de sécurité du fournisseur que les processus d'examen manuel manqueraient.** Elle est distincte de l'évaluation de sécurité des fournisseurs d'AI, qui évalue la sécurité des outils d'AI eux-mêmes, bien que les organisations dotées de programmes de sécurité matures utilisent de plus en plus l'AI pour améliorer à la fois leurs processus d'évaluation des fournisseurs d'AI et leurs capacités plus larges d'évaluation de sécurité.

### **Qu'est-ce qu'une évaluation de sécurité des fournisseurs ?**

**Une évaluation de sécurité des fournisseurs est une évaluation structurée des contrôles de sécurité, des pratiques de gestion des données, des certifications de conformité et des protections contractuelles d'un fournisseur de technologie tiers avant que ce fournisseur ne se voie accorder l'accès aux données organisationnelles ou ne soit intégré dans les systèmes commerciaux.** Pour les fournisseurs d'AI spécifiquement, l'évaluation s'étend au-delà de l'évaluation conventionnelle de sécurité des fournisseurs pour traiter des risques spécifiques à l'AI de l'utilisation des données d'entraînement, de la juridiction de l'infrastructure d'inférence, des pratiques de mise à jour des modèles et des surfaces d'attaque spécifiques à l'AI que les questionnaires standards des fournisseurs informatiques n'ont pas été conçus pour faire émerger.

### **Quelles mesures peuvent être mises en place pour s'assurer qu'un fournisseur d'AI est sécurisé ?**

**Les cinq mesures les plus importantes pour s'assurer qu'un fournisseur d'AI est sécurisé sont d'exiger des documents de certification SOC 2 Type 2 actuels ou équivalents couvrant le produit spécifique et l'infrastructure déployés, d'obtenir des accords signés de traitement des données avec des interdictions explicites de données d'entraînement et des limites de conservation définies avant que toute donnée organisationnelle ne soit traitée, de vérifier que l'infrastructure d'inférence est située dans des juridictions qui satisfont aux exigences applicables de résidence des données, de confirmer à travers les conditions contractuelles et la documentation technique que les contrôles de sécurité du fournisseur traitent les risques spécifiques à l'AI y compris l'injection de prompts et l'extraction de modèles, et d'établir un processus continu de surveillance du fournisseur qui examine les renouvellements de certification, les divulgations d'incidents et les changements matériels des conditions d'utilisation sur un cycle annuel défini.** Ensemble, ces mesures créent une relation de sécurité avec le fournisseur d'AI fondée sur des preuves vérifiées et des obligations exécutoires plutôt que sur des affirmations non vérifiées et une bonne foi supposée.

### **Quelles sont 5 mesures de sécurité ?**

**Les cinq mesures de sécurité fondamentales qui s'appliquent à travers les relations avec les fournisseurs d'AI sont le chiffrement des données en transit et au repos en utilisant des standards actuels avec des pratiques documentées de gestion des clés, des contrôles d'accès qui limitent qui dans l'organisation du fournisseur peut accéder aux données organisationnelles et dans quelles conditions, une journalisation complète de tous les événements d'accès et de traitement des données avec des périodes de conservation qui soutiennent l'investigation des incidents, des pratiques de gestion des vulnérabilités y compris des tests de sécurité réguliers et des délais de remédiation définis pour les vulnérabilités identifiées, et des processus de notification de violation qui engagent le fournisseur à une divulgation rapide avec des délais spécifiques qui satisfont aux obligations réglementaires de notification de l'organisation.** Ces cinq mesures représentent la base de référence de la sécurité technique qui devrait être vérifiée à travers des preuves pour chaque fournisseur d'AI évalué pour des responsabilités significatives de traitement des données, avec les dimensions d'évaluation spécifiques à l'AI superposées à cette fondation conventionnelle de sécurité.
