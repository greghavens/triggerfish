---
title: "GDPR et outils d'AI : ce que toute entreprise doit savoir avant de
  déployer l'AI en Europe"
date: 2026-03-03
description: Le GDPR et les outils d'AI se croisent autour du traitement des
  données, du consentement et des décisions automatisées. Voici ce que les
  entreprises doivent comprendre pour rester conformes lors du déploiement
  d'AI en Europe.
author: triggerfish
tags:
  - AI agent
draft: false
---



Le GDPR et les outils d'AI se rencontrent en un point critique pour toute organisation qui traite des données personnelles de résidents européens à l'aide de systèmes d'intelligence artificielle. Le règlement s'applique pleinement aux déploiements d'AI, ce qui signifie que tout outil qui collecte, traite ou agit sur des données personnelles doit satisfaire aux exigences du GDPR en matière de base légale, de transparence et de minimisation des données, sous peine de subir des sanctions significatives.

De nombreuses organisations ont avancé rapidement sur l'adoption de l'AI sans s'arrêter pour se demander si leurs nouveaux outils sont réellement légaux au regard du droit européen de la protection des données. La réponse n'est pas toujours confortable. L'AI introduit des activités de traitement de données que le GDPR n'a pas été écrit à l'origine pour aborder, mais qu'il couvre absolument dans le cadre de son périmètre existant. Le profilage automatisé, le traitement à grande échelle de données personnelles, les transferts transfrontaliers de données déclenchés par l'infrastructure d'AI en nuage et les systèmes opaques de prise de décision se situent tous pleinement dans le champ réglementaire du GDPR. Comprendre exactement où se situent les obligations et comment construire des déploiements d'AI qui les satisfont n'est plus optionnel pour les entreprises opérant ou vendant sur les marchés européens. Ce guide parcourt ce que la conformité exige réellement et où la plupart des équipes ont tendance à se tromper.



![Ai agent](/blog/images/flag.jpg)

## **Pourquoi le GDPR s'applique aux outils d'AI plus largement que la plupart des équipes ne le réalisent**

### **Chaque interaction d'AI impliquant des données personnelles est un événement de traitement**

Le GDPR définit le traitement des données de manière extensive. Toute opération effectuée sur des données personnelles, y compris la collecte, le stockage, l'extraction, l'utilisation, la divulgation et l'effacement, relève du champ d'application du règlement. Lorsqu'un outil d'AI reçoit un nom, une adresse électronique, un schéma comportemental, un enregistrement vocal ou toute autre information se rapportant à une personne identifiable, il traite des données personnelles selon la définition du GDPR dès l'instant où ces données entrent dans le système.

Cela prend de nombreuses organisations au dépourvu, car le modèle mental intuitif de la conformité au GDPR est centré sur les bases de données et le stockage. Si vous stockez des dossiers clients, vous vous conformez aux règles de stockage. Mais le traitement par AI est un traitement, qu'un élément soit ou non stocké de manière permanente. Un outil d'AI qui analyse la transcription d'un service client pour classer le sentiment et qui jette immédiatement la transcription a tout de même traité des données personnelles. La base légale pour le faire, et les obligations de transparence qui l'accompagnent, s'appliquent à cette interaction.

L'implication pratique est que votre évaluation de la conformité au GDPR ne peut pas s'arrêter à vos bases de données et systèmes CRM. Chaque outil d'AI que votre organisation utilise doit être évalué quant aux données personnelles qu'il touche, sur quelle base légale et dans quelles conditions.

### **Le problème de la base légale avec les outils d'AI**

Le GDPR exige que chaque activité de traitement impliquant des données personnelles ait une base légale valide. Les six bases disponibles sont le consentement, l'exécution d'un contrat, l'obligation légale, les intérêts vitaux, la mission d'intérêt public et les intérêts légitimes. Pour la plupart des déploiements commerciaux d'AI, les options pertinentes sont le consentement, l'exécution du contrat et les intérêts légitimes.

Le défi avec les outils d'AI est que les activités de traitement qu'ils effectuent sont souvent difficiles à décrire avec suffisamment de précision pour satisfaire aux exigences de transparence du GDPR en matière de consentement ou de mise en balance des intérêts légitimes. Dire aux utilisateurs que leurs données seront traitées par des systèmes d'AI pour l'amélioration du service n'est pas assez précis. Expliquer exactement quelles données circulent dans quel système d'AI, dans quel but, conservées pendant combien de temps, partagées avec quels sous-traitants et utilisées pour éclairer quelles décisions, c'est ce que le règlement exige réellement.

Les organisations qui n'ont pas cartographié leurs flux de données d'AI en détail ne peuvent pas satisfaire à cette exigence parce qu'elles ne savent véritablement pas ce qu'elles divulguent. Le travail de conformité et le travail de transparence sont le même travail.


<table>
  <thead>
    <tr>
      <th>Base légale</th>
      <th>Quand elle s'applique à l'AI</th>
      <th>Exigence clé</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Consentement</td>
      <td>Traitement d'AI non nécessaire au service, clairement facultatif</td>
      <td>Librement donné, spécifique, éclairé, univoque</td>
    </tr>
    <tr>
      <td>Exécution du contrat</td>
      <td>AI directement nécessaire à la fourniture d'un service contractualisé</td>
      <td>Traitement limité à ce que le contrat exige</td>
    </tr>
    <tr>
      <td>Intérêts légitimes</td>
      <td>Bénéfice commercial existant qui ne prévaut pas sur les droits individuels</td>
      <td>Évaluation des intérêts légitimes documentée</td>
    </tr>
    <tr>
      <td>Obligation légale</td>
      <td>AI utilisée pour se conformer à une exigence légale</td>
      <td>Une obligation légale spécifique doit exister et être documentée</td>
    </tr>
    <tr>
      <td>Mission d'intérêt public</td>
      <td>Autorités publiques et organisations investies de mandats publics</td>
      <td>Doit être fondée sur le droit de l'Union ou d'un État membre</td>
    </tr>
  </tbody>
</table>



Aligner la documentation de[ AI security](https://trigger.fish/security/) et de base légale tôt dans un déploiement évite la situation où vous avez un système d'AI techniquement sécurisé fonctionnant sur une fondation juridique fragile.



![AI agent](/blog/images/legal-compliance.jpg)

## **Ce que les évolutions du GDPR signifient spécifiquement pour l'AI**

### **L'interprétation réglementaire en évolution**

Le GDPR a été finalisé en 2016 et est entré en vigueur en 2018, précédant de plusieurs années la génération actuelle de grands modèles de langage. Le texte du règlement ne mentionne pas l'AI générative, les modèles de fondation ni les pipelines d'inférence. Ce qu'il contient, c'est un cadre fondé sur des principes suffisamment large pour englober ces technologies, et les autorités de protection des données des États membres de l'UE ont régulièrement publié des lignes directrices qui clarifient comment ces principes s'appliquent.

L'action coercitive de l'autorité italienne de protection des données contre ChatGPT en 2023 a été le signal le plus clair que les régulateurs étaient prêts à agir sur les préoccupations liées au GDPR spécifiques à l'AI. L'action portait sur l'absence d'une base légale claire d'OpenAI pour traiter les données des utilisateurs italiens, l'absence de mécanismes de vérification de l'âge et une transparence insuffisante quant à la manière dont les données personnelles étaient utilisées dans l'entraînement du modèle. L'outil a été temporairement suspendu en Italie et rétabli uniquement après qu'OpenAI a apporté des modifications de conformité spécifiques.

D'autres autorités nationales de protection des données dans l'UE ont depuis publié des lignes directrices traitant des données d'entraînement de l'AI, de la prise de décision automatisée et des conditions dans lesquelles les sorties générées par l'AI constituent un traitement de données personnelles concernant les personnes dont les données ont été utilisées pour entraîner le modèle.

La direction est claire. L'application du GDPR s'enfonce plus profondément dans le territoire spécifique de l'AI, et les organisations qui ont traité la conformité de l'AI comme un problème futur découvrent qu'il est devenu un problème actuel.

### **Comment l'AI Act de l'UE se superpose au GDPR**

L'AI Act de l'UE, entré en vigueur en 2024, ajoute une couche réglementaire parallèle qui fonctionne aux côtés du GDPR plutôt que de le remplacer. Là où le GDPR régit ce qui advient des données personnelles, l'AI Act régit les caractéristiques et le comportement des systèmes d'AI eux-mêmes, en particulier ceux classés comme à haut risque.

Pour les entreprises déployant des outils d'AI qui interagissent avec des données personnelles, les deux cadres s'appliquent simultanément. Un système d'AI utilisé dans la sélection à l'embauche, l'évaluation du crédit ou le triage sanitaire est soumis aux exigences de l'AI Act en matière de transparence, de supervision humaine et d'exactitude, tout en étant soumis aux exigences du GDPR pour chaque donnée personnelle qu'il traite.

Comprendre comment les décisions d'[ AI architecture](https://trigger.fish/architecture/) affectent la conformité au regard des deux cadres aide les organisations à concevoir des systèmes qui satisfont au tableau réglementaire complet plutôt que d'optimiser pour une réglementation aux dépens de l'autre.

## **L'article 22 et la prise de décision automatisée**

### **Ce que l'article 22 interdit réellement**

L'article 22 du GDPR confère aux personnes le droit de ne pas faire l'objet d'une décision fondée exclusivement sur un traitement automatisé, y compris le profilage, produisant des effets juridiques ou les affectant de manière significative de façon similaire. C'est l'une des dispositions les plus directement pertinentes pour l'AI dans le règlement et l'une des plus couramment incomprises.

L'interdiction ne porte pas sur l'utilisation de l'AI dans les processus de prise de décision. Elle porte spécifiquement sur des décisions prises exclusivement par des systèmes automatisés où aucun humain n'examine de manière significative le résultat avant qu'il n'affecte la personne. Une AI de notation de crédit qui génère une recommandation qu'un agent de prêt humain examine et confirme ou écarte ne déclenche pas l'article 22. Un système qui approuve ou rejette automatiquement les demandes de prêt sur la base d'une sortie algorithmique sans humain dans la boucle décisionnelle le déclenche.

Pour les outils d'AI utilisés dans les RH, la segmentation client, la détection de fraude et des contextes similaires, l'analyse de l'article 22 est essentielle. Si votre outil d'AI prend des décisions qui affectent l'accès des personnes à des services, des opportunités d'emploi ou des produits financiers, et qu'aucun humain n'examine véritablement ces décisions avant qu'elles ne se concrétisent, vous avez un problème de conformité à l'article 22.

Les trois exceptions à l'article 22 sont la nécessité contractuelle, le consentement explicite et l'autorisation légale. Chacune requiert des conditions supplémentaires spécifiques, notamment le droit à une révision humaine, le droit de contester la décision et le droit d'obtenir une explication de la logique impliquée.


<table>
  <thead>
    <tr>
      <th>Type de décision automatisée</th>
      <th>Article 22 déclenché ?</th>
      <th>Voie de conformité</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Recommandation d'AI examinée par un humain avant action</td>
      <td>Non</td>
      <td>Les obligations standard de traitement du GDPR s'appliquent</td>
    </tr>
    <tr>
      <td>Approbation ou refus entièrement automatisé avec effet juridique</td>
      <td>Oui</td>
      <td>Doit s'appuyer sur une exception avec droit à révision humaine</td>
    </tr>
    <tr>
      <td>Profilage automatisé utilisé pour segmenter des listes marketing</td>
      <td>Selon la portée</td>
      <td>Évaluer si les effets sont juridiquement significatifs</td>
    </tr>
    <tr>
      <td>Score de contenu généré par AI influençant une décision d'embauche</td>
      <td>Oui</td>
      <td>Exception contrat ou consentement plus révision humaine</td>
    </tr>
    <tr>
      <td>Signalement de fraude nécessitant une enquête humaine avant action sur le compte</td>
      <td>Non</td>
      <td>La révision humaine rompt la chaîne exclusivement automatisée</td>
    </tr>
  </tbody>
</table>



Examiner les[ AI features](https://trigger.fish/features/) dans les outils que vous envisagez de déployer aide à identifier ceux qui intègrent des points de contrôle humains significatifs et ceux qui acheminent les décisions automatiquement sans révision humaine.



![AI agent](/blog/images/a-person.jpg)

## **L'article 37 et l'exigence du Délégué à la Protection des Données**

### **Quand les déploiements d'AI exigent un DPO**

L'article 37 du GDPR exige que certaines organisations désignent un Délégué à la Protection des Données. L'exigence s'applique aux autorités et organismes publics, aux organisations dont les activités principales nécessitent un suivi systématique à grande échelle des personnes, et aux organisations dont les activités principales impliquent le traitement à grande échelle de catégories particulières de données ou de données relatives aux condamnations pénales.

Les outils d'AI déclenchent fréquemment cette évaluation. Une entreprise de commerce de détail qui déploie l'AI pour des analyses comportementales sur des millions d'interactions clients pratique un suivi systématique à grande échelle. Une organisation de santé qui utilise l'AI pour traiter les dossiers de patients à grande échelle traite des catégories particulières de données à grande échelle. Les deux scénarios pointent vers une exigence obligatoire de DPO.

Même là où l'exigence de DPO n'est pas strictement obligatoire, la fonction qu'elle remplit, supervision des activités de traitement des données, liaison avec les autorités de contrôle et conseil indépendant en conformité, est pratiquement essentielle pour les organisations exploitant des systèmes d'AI qui touchent à des volumes significatifs de données personnelles. De nombreuses entreprises qui ne sont pas techniquement tenues de nommer un DPO le font parce que la valeur opérationnelle le justifie.

Le DPO doit être impliqué dans les déploiements d'AI avant leur mise en production, et non consulté ensuite lorsque des problèmes surgissent. Faire entrer le DPO dans le processus d'évaluation de l'outil, l'Analyse d'Impact relative à la Protection des Données et la révision des accords fournisseur crée la trace documentée de supervision que les régulateurs s'attendent à voir.

### **Analyses d'impact relatives à la protection des données pour l'AI**

L'article 35 du GDPR exige une Analyse d'Impact relative à la Protection des Données avant de déployer tout traitement susceptible d'engendrer un risque élevé pour les personnes. Les systèmes d'AI qui impliquent du profilage à grande échelle, un suivi systématique ou une prise de décision automatisée avec des effets significatifs déclenchent presque toujours cette exigence.

Une AIPD adéquate pour un outil d'AI couvre quelles données personnelles le système traite et pourquoi, la nécessité et la proportionnalité du traitement, les risques pour les personnes et la façon dont ils seront atténués, et les mesures en place pour démontrer la conformité. Ce n'est pas un document unique. Lorsque l'outil d'AI change, lorsque les entrées de données changent ou lorsque le contexte commercial change de manière substantielle, l'AIPD doit être revisitée.

Un[ AI guide](https://trigger.fish/guide/) pratique sur la méthodologie d'AIPD pour les systèmes d'AI aide les équipes de conformité à structurer des évaluations qui satisfont aux attentes des autorités de contrôle plutôt que de produire une documentation qui paraît exhaustive mais qui passe à côté de l'analyse de risque substantielle que recherchent les régulateurs.

## **À savoir**

Plusieurs points importants concernant le GDPR et les outils d'AI qui ont tendance à n'émerger qu'après que des problèmes se sont déjà produits :

L'entraînement de modèles d'AI sur des données personnelles nécessite sa propre évaluation de base légale. Si vous procédez à l'ajustement fin d'un modèle sur des données clients, des données employés ou toute autre donnée personnelle détenue par votre organisation, cette activité d'entraînement constitue une finalité de traitement distincte qui nécessite sa propre base légale, séparée de la finalité initiale de collecte.

Les droits des personnes concernées s'appliquent aux données traitées par l'AI. Les individus conservent le droit d'accéder, de rectifier, d'effacer et de porter leurs données personnelles même lorsqu'elles ont été traitées par un système d'AI. Si votre outil d'AI ne peut pas soutenir opérationnellement ces droits, c'est une lacune de conformité, quelles que soient les autres mesures de sécurité de l'outil.

Les sous-traitants et sous-sous-traitants doivent être documentés. Chaque fournisseur d'AI qui traite des données personnelles pour votre compte doit figurer dans votre Registre des Activités de Traitement. Leurs sous-sous-traitants, les fournisseurs d'infrastructure, les sociétés d'hébergement et autres prestataires sur lesquels ils s'appuient doivent être divulgués dans vos Accords de Traitement de Données avec eux.

La pseudonymisation réduit le risque mais n'élimine pas les obligations du GDPR. Les données qui ont été pseudonymisées, c'est-à-dire que les identifiants ont été remplacés par des codes, restent des données personnelles selon le GDPR si une réidentification est raisonnablement possible. Les outils d'AI traitant des données pseudonymisées traitent encore des données personnelles.

Les transferts transfrontaliers déclenchés par l'infrastructure d'AI nécessitent des mécanismes de transfert. Si votre fournisseur d'AI traite des données sur une infrastructure située en dehors de l'UE ou de l'EEE, vous avez besoin d'un mécanisme de transfert valide tel que les Clauses Contractuelles Types ou une analyse d'impact de transfert. De nombreux services d'AI en nuage acheminent par défaut le traitement par des centres de données aux États-Unis ou en Asie.

Des durées de conservation doivent être définies pour les données traitées par l'AI. Le GDPR exige que les données personnelles ne soient pas conservées plus longtemps que nécessaire. Les systèmes d'AI qui conservent indéfiniment les journaux de conversation, les données d'entrée ou les données de sortie sans calendrier de conservation documenté ne sont pas conformes, quelles que soient les autres garanties.

## **Construire une pratique d'AI prête pour le GDPR**

Les organisations qui naviguent avec succès dans le GDPR et les outils d'AI partagent une approche commune. Elles évaluent la conformité avant le déploiement plutôt qu'après, elles maintiennent une documentation vivante de leurs flux de données d'AI et elles traitent la conformité au GDPR comme une discipline opérationnelle continue plutôt qu'un projet avec une date d'achèvement.

L'environnement réglementaire autour de l'AI en Europe se durcit, il ne se relâche pas. La combinaison d'une application du GDPR de plus en plus centrée sur l'AI et de l'AI Act de l'UE ajoutant un cadre parallèle signifie que les organisations dotées de fondations de gouvernance d'AI faibles accumulent une exposition à la conformité à chaque nouvel outil qu'elles déploient.

Construire cette fondation n'est pas aussi complexe qu'il y paraît. Cartographiez vos flux de données. Établissez les bases légales. Documentez vos traitements. Évaluez vos déploiements à haut risque. Mettez de l'ordre dans vos accords fournisseurs. Ce sont des pratiques de conformité éprouvées appliquées à une nouvelle catégorie de technologies. Les organisations qui l'abordent systématiquement constatent que la conformité et l'adoption efficace de l'AI ne sont pas en tension. Bien réalisées, elles se renforcent mutuellement.

## **Foire aux questions**

### **Les outils d'AI sont-ils soumis au GDPR ?**

**Oui, les outils d'AI sont pleinement soumis au GDPR dès lors qu'ils traitent des données personnelles relatives à des personnes dans l'UE, quel que soit le lieu d'établissement de la société d'AI ou l'emplacement de ses serveurs.** Le règlement s'applique en fonction de la localisation des personnes concernées, et non du fournisseur de technologie, ce qui signifie que tout outil d'AI utilisé sur des données de clients ou d'employés européens doit s'y conformer.

### **Qu'est-ce que la règle des 30 % pour l'AI ?**

**La règle des 30 % pour l'AI est une orientation pratique suggérant que l'automatisation par AI devrait couvrir environ 30 % d'un flux de travail tandis que le jugement et la supervision humains gèrent les 70 % restants.** Dans les contextes du GDPR, cette formulation est particulièrement utile pour la conformité à l'article 22, en aidant les organisations à concevoir des déploiements d'AI où les humains restent véritablement impliqués dans les décisions plutôt que de simplement valider sans examen les sorties automatisées.

### **Quels sont les changements du GDPR pour l'AI ?**

**Le GDPR lui-même n'a pas été formellement modifié pour l'AI, mais les autorités de protection des données à travers l'UE ont publié des orientations de plus en plus précises appliquant les principes existants du GDPR aux systèmes d'AI, en particulier autour des bases légales des données d'entraînement, de la prise de décision automatisée et des exigences de transparence pour les sorties générées par AI.** L'AI Act de l'UE, qui fonctionne aux côtés du GDPR plutôt que de le remplacer, ajoute des obligations supplémentaires pour les systèmes d'AI à haut risque qui traitent des données personnelles.

### **Qu'est-ce que l'article 22 du GDPR et l'AI ?**

**L'article 22 du GDPR confère aux personnes le droit de ne pas faire l'objet de décisions prises exclusivement sur la base d'un traitement automatisé produisant des effets juridiques ou les affectant de manière significative de façon similaire, ce qui s'applique directement aux systèmes d'AI qui prennent des décisions conséquentes sur des personnes sans révision humaine significative.** Les organisations utilisant l'AI pour la notation de crédit, la sélection à l'embauche ou l'accès aux services doivent s'assurer soit qu'un humain examine véritablement les sorties de l'AI avant que les décisions ne se concrétisent, soit qu'une des trois exceptions légales s'applique avec toutes les garanties supplémentaires requises en place.

### **Qu'est-ce que l'article 37 du GDPR ?**

**L'article 37 du GDPR établit l'exigence pour certaines organisations de désigner un Délégué à la Protection des Données, un rôle qui devient pratiquement essentiel pour toute entreprise exploitant des systèmes d'AI qui traitent de grands volumes de données personnelles ou qui s'engagent dans un suivi comportemental systématique.** Les organisations dont les activités principales d'AI impliquent du profilage à grande échelle, le traitement de catégories particulières de données ou un suivi individuel systématique sont susceptibles de déclencher l'obligation de nomination d'un DPO en vertu de cet article.
