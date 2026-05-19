---
title: "Prévention des fuites de données par l'IA : ce que chaque entreprise
  doit faire avant l'envoi du prochain prompt"
date: 2026-04-03
description: La prévention des fuites de données par l'IA protège les
  informations sensibles de l'entreprise contre l'exposition via les outils
  d'IA. Voici ce qui les provoque, où elles se produisent et comment les
  arrêter.
author: triggerfish
tags:
  - AI agent
draft: false
---
La prévention des fuites de données par l'IA désigne les politiques, contrôles techniques et pratiques organisationnelles qui empêchent l'exposition, la conservation ou l'utilisation abusive d'informations sensibles de l'entreprise lorsque le personnel et les systèmes interagissent avec des outils d'intelligence artificielle. Elle s'attaque à une catégorie de perte de données que les outils de prévention traditionnels n'ont pas été conçus pour détecter.

Le problème est trompeusement simple dans son fonctionnement et trompeusement répandu dans sa survenance. Une personne salariée colle un contrat client dans un outil d'IA pour obtenir un résumé. Une développeuse alimente un assistant de codage avec du code source propriétaire pour corriger un bogue. Un membre de l'équipe financière soumet un projet de rapport de résultats à un outil de rédaction par IA pour le peaufiner. Dans chaque cas, la personne salariée a accompli quelque chose d'utile. Dans chaque cas, des données organisationnelles sensibles ont voyagé vers une infrastructure que l'organisation ne contrôle pas, selon des conditions de service que la personne salariée n'a jamais lues, avec des pratiques de conservation et d'utilisation qui peuvent inclure l'entraînement du modèle sur ce contenu. Aucun pare-feu ne l'a signalé. Aucune alerte DLP ne s'est déclenchée. Aucun journal d'audit ne l'a capturé sous une forme exploitable par les équipes de conformité. C'est cela, le problème des fuites de données par l'IA, et il se manifeste dans des organisations de toutes tailles et de tous secteurs à une échelle que la plupart des programmes de sécurité n'ont pas encore rattrapée. Ce guide explique ce qui provoque les fuites de données par l'IA, où elles créent l'exposition la plus grave, et ce que les organisations doivent mettre en place pour les prévenir.



![AI agent](/blog/images/submitting.jpg)

## **Comprendre pourquoi les outils d'IA créent leur propre catégorie de fuite de données**

### **Le canal qui contourne les contrôles existants**

Les outils traditionnels de prévention des pertes de données fonctionnent en surveillant les canaux de données connus et en appliquant des règles pour détecter le contenu sensible qui les traverse. Les pièces jointes aux e-mails sont analysées. Les transferts de fichiers vers le stockage cloud sont examinés. Les écritures sur périphériques USB sont consignées. Ces contrôles reflètent un modèle de mouvement de données qui était précis avant que les outils d'IA ne deviennent un élément standard du lieu de travail.

Les outils d'IA représentent un canal de données que la plupart des architectures DLP existantes ne classent ni ne surveillent correctement. Du point de vue du trafic réseau, une personne salariée soumettant un document confidentiel à un outil d'IA est identique à une personne utilisant toute autre application web. La requête HTTPS vers les serveurs de l'outil d'IA est indiscernable au niveau réseau d'une requête vers une application de productivité, une base de données de recherche ou un site d'actualités. L'outil DLP voit du trafic web autorisé. L'équipe sécurité ne voit rien. Les données sensibles ont quitté le bâtiment.

Cet écart architectural est la raison pour laquelle la prévention des fuites de données par l'IA nécessite une attention dédiée plutôt que de supposer que les contrôles existants la couvrent. Le modèle de menace est différent, le canal de données est différent, et les contrôles nécessaires pour le traiter sont différents de ceux qui gèrent les scénarios conventionnels de perte de données.

### **Ce qui arrive aux données après leur entrée dans un outil d'IA**

Les risques spécifiques de fuite de données dépendent de ce que les fournisseurs d'IA font des données soumises à leurs systèmes, ce qui varie considérablement selon les fournisseurs, les produits et les niveaux. Comprendre l'éventail des pratiques aide les organisations à calibrer leurs efforts de prévention autour du risque réel plutôt que d'une préoccupation généralisée.

L'utilisation pour l'entraînement de modèles est le risque qui transforme le plus directement un événement d'exposition de données en un problème de fuite persistant. Lorsque les conditions de service d'un fournisseur permettent d'utiliser le contenu soumis pour améliorer son modèle, les données ne font pas que transiter temporairement par ses systèmes. Elles influencent potentiellement les sorties futures du modèle de manières qui pourraient faire apparaître des fragments de ces informations dans les réponses à d'autres personnes utilisatrices. Les accords entreprise avec les principaux fournisseurs interdisent cela en tant que clause standard, mais les niveaux grand public et gratuits l'autorisent couramment, et le personnel utilisant des comptes personnels pour des tâches professionnelles opère typiquement selon des conditions grand public.

La conservation des journaux d'inférence crée une fenêtre d'exposition limitée dans le temps plutôt qu'un risque d'entraînement persistant. La plupart des fournisseurs d'IA conservent des journaux des requêtes et des réponses pendant des périodes définies à des fins de débogage, d'assurance qualité et de conformité légale. Pendant cette période de conservation, les données sensibles soumises dans ces requêtes existent sur l'infrastructure du fournisseur et sont potentiellement accessibles au personnel du fournisseur, soumises aux propres contrôles de sécurité du fournisseur, et potentiellement réactives à une procédure judiciaire dirigée contre le fournisseur.

Le transfert transfrontalier de données se produit lorsque l'infrastructure d'inférence d'IA se trouve dans une juridiction différente de celle de l'organisation qui soumet les données. Pour les organisations soumises à des obligations de résidence des données, cela crée une exposition de conformité indépendante de toute défaillance de sécurité. Les données peuvent être techniquement sécurisées sur l'infrastructure du fournisseur tout en violant simultanément les exigences réglementaires concernant l'endroit où elles peuvent être traitées.

Comprendre comment les cadres de[ sécurité de l'IA](https://trigger.fish/security/) traitent chacune de ces catégories spécifiques de risques liés au traitement des données aide les organisations à bâtir des programmes de prévention ciblant les risques réels que crée leur paysage d'outils d'IA plutôt que des préoccupations génériques de perte de données.



![AI agent](/blog/images/concerned.jpg)

## **Où les fuites de données par l'IA créent l'exposition la plus grave**

### **Catégories de données réglementées et confidentielles les plus à risque**

Toutes les données organisationnelles ne présentent pas le même risque de fuite. Les catégories de données qui créent l'exposition la plus grave lorsqu'elles entrent dans des systèmes d'IA non autorisés partagent une caractéristique commune : leur traitement est régi par des obligations légales, des engagements contractuels ou une sensibilité concurrentielle qui rend la divulgation non autorisée coûteuse de manières qui vont au-delà de la perte immédiate d'information.

Les données personnelles soumises au RGPD, à la HIPAA ou à des cadres équivalents créent une exposition réglementaire lorsqu'elles sont traitées par des outils d'IA sans la base juridique, les accords avec les fournisseurs et les garanties techniques qu'exigent ces cadres. Une seule personne salariée soumettant une feuille de calcul d'informations personnelles de clientèle à un outil d'IA grand public pour le nettoyage de données a potentiellement créé une violation de données déclarable selon le RGPD, une violation de l'accord d'associé commercial selon la HIPAA, et un incident de conformité selon un nombre quelconque de réglementations sectorielles, le tout dans le temps nécessaire pour coller du contenu dans une fenêtre de discussion.

Le contenu juridiquement privilégié soumis à des outils d'IA crée des préoccupations concernant le secret professionnel avocat-client que les équipes juridiques de la plupart des organisations n'ont pas encore pleinement résolues. La question de savoir si le traitement par un outil d'IA constitue une divulgation qui renonce au privilège est une question juridique en évolution dans la plupart des juridictions, et la posture organisationnelle la plus sûre consiste à empêcher le contenu privilégié d'atteindre des outils d'IA dont le traitement n'est pas spécifiquement conçu et contracté pour les exigences du secteur juridique.

Les informations techniques propriétaires, notamment le code source, les spécifications de produits, les algorithmes et les données de recherche, représentent une intelligence concurrentielle que les organisations investissent significativement à protéger. Les assistants de codage par IA et les outils d'analyse de documents figurent parmi les outils d'IA les plus couramment utilisés dans les organisations technologiques et de recherche, et ce sont aussi les outils les plus fréquemment utilisés avec exactement les catégories de données que les organisations souhaiteraient le plus tenir à l'écart des systèmes externes.


<table>
  <thead>
    <tr>
      <th>Catégorie de données</th>
      <th>Risque principal de fuite par l'IA</th>
      <th>Conséquence réglementaire ou juridique</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Données personnelles de la clientèle</td>
      <td>Traitement par un tiers non autorisé</td>
      <td>Notification de violation RGPD, violation HIPAA, sanctions sectorielles</td>
    </tr>
    <tr>
      <td>Données personnelles du personnel</td>
      <td>Exposition de données RH via des outils d'IA RH</td>
      <td>Violations du droit du travail et de la protection des données</td>
    </tr>
    <tr>
      <td>Contenu juridiquement privilégié</td>
      <td>Renonciation potentielle au privilège par divulgation</td>
      <td>Perte de protection juridique pour les questions sensibles</td>
    </tr>
    <tr>
      <td>Code source propriétaire</td>
      <td>Exposition de l'intelligence concurrentielle</td>
      <td>Perte de PI, rupture contractuelle avec la clientèle</td>
    </tr>
    <tr>
      <td>Informations financières provisoires</td>
      <td>Informations non publiques importantes avant divulgation</td>
      <td>Exposition au droit des valeurs mobilières, risque de divulgation sélective</td>
    </tr>
    <tr>
      <td>Informations confidentielles de la clientèle</td>
      <td>Violation des obligations professionnelles de confidentialité</td>
      <td>Détérioration de la relation client, responsabilité professionnelle</td>
    </tr>
    <tr>
      <td>Secrets commerciaux</td>
      <td>Intelligence concurrentielle par l'entraînement de modèles</td>
      <td>Perte de protection du secret commercial en cas de divulgation publique</td>
    </tr>
  </tbody>
</table>



### **La dimension de l'IA fantôme**

Le défi le plus difficile de la prévention des fuites de données par l'IA n'est pas constitué par les outils que les organisations ont approuvés et déployés dans le cadre de cadres de gouvernance. Ce sont les outils que le personnel utilise sans connaissance ni surveillance organisationnelle. L'IA fantôme, c'est-à-dire l'utilisation d'outils d'IA en dehors de tout programme approuvé, génère la majorité des incidents de fuite de données par l'IA dans la plupart des organisations parce qu'elle opère entièrement en dehors des contrôles qu'établit un programme de gouvernance de l'IA.

L'utilisation de l'IA fantôme n'est pas principalement un échec de conformité de la part d'acteurs malveillants. C'est une réponse de productivité de la part de personnes salariées qui ont découvert que les outils d'IA aident leur travail et qui ont adopté ce qui est accessible plutôt que d'attendre des processus d'approbation organisationnels dont les délais peuvent ne pas être clairs. Comprendre cette motivation est essentiel pour concevoir des approches de prévention qui réduisent réellement les fuites plutôt que de pousser l'utilisation encore plus dans la clandestinité.

La prévention la plus efficace de l'IA fantôme combine la visibilité sur les outils d'IA utilisés dans l'ensemble de l'organisation, un programme d'outils approuvés clair et accessible qui répond aux besoins réels du personnel, et un canal de divulgation non punitif pour les personnes qui ont déjà utilisé des outils en dehors du programme approuvé. Les organisations qui répondent à l'IA fantôme principalement par l'interdiction constatent que le besoin de productivité sous-jacent continue d'être satisfait par des moyens progressivement moins visibles, créant une exposition à la fuite plus importante plutôt que moindre.

Examiner comment les décisions d'[architecture d'IA](https://trigger.fish/architecture/) concernant le déploiement d'outils d'IA approuvés affectent l'attractivité des alternatives fantômes aide les organisations à concevoir leur programme approuvé pour qu'il soit la voie de moindre résistance plutôt que la voie de plus grande friction de conformité.

## **Les contrôles techniques et organisationnels qui fonctionnent vraiment**

### **Contrôles techniques pour la prévention des fuites de données par l'IA**

Les contrôles techniques de prévention des fuites de données par l'IA opèrent à plusieurs niveaux, chacun traitant différents aspects de la façon dont les données sensibles atteignent les systèmes d'IA. Les programmes efficaces superposent ces contrôles plutôt que de s'appuyer sur une approche unique.

Les contrôles au niveau du réseau peuvent restreindre l'accès aux services d'IA non approuvés depuis les réseaux et appareils organisationnels en bloquant ou en surveillant le trafic vers les domaines d'outils d'IA qui ne figurent pas sur la liste approuvée. Cette approche est plus efficace sur les réseaux d'entreprise gérés que dans les environnements de travail à distance où le personnel peut utiliser des réseaux et appareils personnels, et elle nécessite une maintenance continue à mesure que de nouveaux outils d'IA émergent et que les outils existants modifient leur infrastructure de domaine.

La prévention de la perte de données sur les points de terminaison configurée pour reconnaître les schémas de téléversement des outils d'IA et appliquer une inspection de contenu aux données soumises via les interfaces d'IA étend la couverture DLP au canal d'IA que les architectures DLP héritées manquent. Cela nécessite des outils DLP configurés spécifiquement pour les schémas de trafic des outils d'IA plutôt que pour les seuls canaux conventionnels d'exfiltration.

Les extensions de navigateur et les contrôles basés sur des agents qui appliquent des politiques de classification des données au point de soumission, empêchant le contenu classé au-dessus d'un seuil de sensibilité défini d'être soumis à des outils d'IA en dehors du programme approuvé, représentent une approche plus ciblée que le blocage au niveau du réseau. Ces contrôles peuvent être configurés pour avertir les personnes utilisatrices approchant d'une limite politique plutôt que de simplement bloquer après son franchissement, créant un mécanisme de renforcement comportemental aux côtés du contrôle technique.

Les produits de passerelle d'IA d'entreprise sont apparus comme une catégorie de contrôle dédiée qui achemine tout le trafic d'IA organisationnel par une couche centralisée d'inspection et d'application de politiques. Ces produits fournissent une visibilité sur l'utilisation des outils d'IA dans toute l'organisation, appliquent la classification des données et l'inspection du contenu à toutes les soumissions à l'IA, font respecter les politiques relatives aux outils approuvés, et génèrent des journaux d'audit dans des formats avec lesquels les équipes de conformité et de sécurité peuvent travailler.


<table>
  <thead>
    <tr>
      <th>Type de contrôle</th>
      <th>Ce qu'il traite</th>
      <th>Limitation</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Blocage réseau</td>
      <td>Empêche l'accès aux outils d'IA non approuvés sur le réseau d'entreprise</td>
      <td>Inefficace sur les réseaux personnels et les appareils non gérés</td>
    </tr>
    <tr>
      <td>DLP de point de terminaison pour l'IA</td>
      <td>Inspecte le contenu soumis via les interfaces d'IA</td>
      <td>Nécessite une configuration spécifique à l'IA au-delà du DLP standard</td>
    </tr>
    <tr>
      <td>Contrôles d'extension de navigateur</td>
      <td>Application de politique au point de soumission à l'IA</td>
      <td>Couverture limitée aux environnements de navigateur gérés</td>
    </tr>
    <tr>
      <td>Passerelle d'IA d'entreprise</td>
      <td>Visibilité, inspection et application de politique centralisées</td>
      <td>Nécessite d'acheminer tout le trafic d'IA par l'infrastructure de la passerelle</td>
    </tr>
    <tr>
      <td>Étiquettes de classification des données</td>
      <td>Guide les décisions du personnel sur l'adéquation des outils d'IA</td>
      <td>S'appuie sur la conformité du personnel plutôt que sur l'application technique</td>
    </tr>
    <tr>
      <td>Contrôles d'accès Zero Trust</td>
      <td>Limite l'accès aux outils d'IA aux personnes autorisées dans des contextes définis</td>
      <td>Ne traite pas le contenu des soumissions autorisées</td>
    </tr>
  </tbody>
</table>



### **Contrôles organisationnels qui complètent la prévention technique**

Les contrôles techniques réduisent les fuites par l'application automatisée. Les contrôles organisationnels réduisent les fuites par le jugement et le comportement du personnel qui déterminent si les contrôles techniques sont contournés, évités ou véritablement intégrés dans la façon dont le travail s'accomplit.

Une politique claire de classification des données qui associe les niveaux de sensibilité à des environnements de traitement par IA autorisés donne au personnel une règle de décision qu'il peut appliquer de manière cohérente sans consulter des documents de politique pour chaque tâche. Lorsqu'une personne salariée sait que les données classées comme confidentielles ne peuvent être traitées que par des outils d'IA sur site ou par des outils cloud de niveau entreprise avec des accords de données signés, elle dispose d'un guide exploitable plutôt que d'une instruction vague d'être prudente.

Une formation utilisant des scénarios concrets et spécifiques au rôle plutôt qu'un contenu générique de sensibilisation à la protection des données produit un changement comportemental que la formation abstraite ne produit pas. Une ingénieure capable de décrire ce qu'il advient du code source soumis à un assistant de codage populaire selon ses conditions de service par défaut possède des connaissances pratiques qui changent son comportement. Un ingénieur qui a assisté à une formation sur les principes de protection des données possède une conscience qui peut ou non se traduire par un comportement différent lorsqu'une échéance crée une pression pour utiliser l'outil le plus rapide disponible.

Les processus de divulgation d'incidents qui traitent les premières divulgations d'utilisations passées d'IA fantôme comme des opportunités d'apprentissage plutôt que comme des violations de conformité créent la sécurité psychologique qui encourage le personnel à faire remonter une exposition existante plutôt qu'à la cacher. Le coût organisationnel des fuites inconnues est plus élevé que le coût des fuites connues qui peuvent être évaluées et traitées.

Comprendre comment les[ fonctionnalités d'IA](https://trigger.fish/features/) des outils d'IA d'entreprise approuvés communiquent leurs pratiques de traitement des données aux personnes utilisatrices aide les organisations à bâtir une formation qui relie les exigences de politique aux comportements spécifiques des outils que le personnel rencontre en pratique plutôt que de traiter le lien entre la politique et l'outil comme quelque chose que le personnel devrait découvrir indépendamment.



![AI agent](/blog/images/session.jpg)

## **Mettre en place un programme de prévention des fuites de données par l'IA**

### **Le fondement de l'inventaire et de l'évaluation**

Les programmes de prévention des fuites de données par l'IA qui fonctionnent commencent par une image précise des outils d'IA utilisés dans l'ensemble de l'organisation, et non pas seulement des outils officiellement approuvés. L'écart entre ces deux inventaires définit la portée immédiate du programme de prévention.

Construire l'inventaire réel des outils d'IA nécessite de combiner plusieurs sources de données car aucune source unique ne capture l'image complète. Les inventaires logiciels gérés par l'informatique capturent les outils officiellement acquis. L'analyse du trafic réseau fait remonter les domaines que le trafic des outils d'IA atteint dans l'ensemble de l'organisation. Les enquêtes auprès du personnel et les entretiens départementaux révèlent les outils que les personnes salariées utilisent et que l'approvisionnement informatique ne voit jamais. Les extensions de navigateur et les inventaires de points de terminaison identifient les outils d'IA installés au niveau des appareils individuels. L'inventaire complet est l'union de toutes ces sources, et il est presque toujours plus important et plus varié que ne s'y attend toute organisation avant d'effectuer l'exercice.

Une fois l'inventaire constitué, chaque outil nécessite une évaluation par rapport aux exigences de sécurité des données couvrant les pratiques de traitement des données du fournisseur, le statut de certification, la disponibilité de la protection contractuelle, et les catégories de données avec lesquelles le personnel l'utilise réellement. Le résultat de l'évaluation est une classification par niveaux de risque de chaque outil d'IA de l'inventaire, allant d'approuvé pour toutes les catégories de données, à approuvé avec restrictions, à interdit en attente d'examen, à interdit purement et simplement.

### **Protections fournisseur et contractuelles**

Les programmes de prévention qui s'appuient uniquement sur des contrôles comportementaux et techniques sans protections contractuelles correspondantes créent une structure de gouvernance incomplète à sa base. Les contrôles techniques réduisent la probabilité de fuites via des outils non autorisés. Les protections contractuelles définissent quelles protections s'appliquent lorsque des outils autorisés sont utilisés et quel recours l'organisation possède lorsque ces protections ne sont pas honorées.

Tout fournisseur d'IA dont les outils traitent des données organisationnelles au-dessus du niveau de sensibilité le plus bas a besoin d'un accord de traitement des données signé qui interdit explicitement l'utilisation des données d'entraînement, définit des limites de conservation, s'engage à notifier les violations dans les délais requis et documente les contrôles de sécurité appliqués aux données organisationnelles. Pour les organisations de santé, un accord d'associé commercial couvrant le produit d'IA spécifique est une exigence légale plutôt qu'une préférence contractuelle.

Le programme de protection contractuelle nécessite un entretien tout comme les contrôles techniques. Les fournisseurs mettent à jour leurs conditions de service. Les produits couverts par un accord peuvent en être séparés par un changement de portefeuille de produits. Les périodes de certification expirent. Intégrer un cycle annuel de révision des accords fournisseurs dans le programme évite la situation où les données organisationnelles sont traitées dans le cadre d'accords qui ne reflètent plus les pratiques réelles du fournisseur.

Un[ guide d'IA](https://trigger.fish/guide/) complet sur la structuration des programmes de prévention des fuites de données par l'IA, de l'inventaire et de l'évaluation aux contrôles techniques et à la gestion des fournisseurs, aide les organisations à bâtir des programmes qui traitent l'ensemble du défi de prévention plutôt que sa partie la plus visible.

## **Choses à savoir**

Plusieurs réalités importantes concernant la prévention des fuites de données par l'IA que les organisations rencontrent constamment lorsqu'elles bâtissent leurs programmes :

Les produits de niveau grand public des fournisseurs d'IA d'entreprise ont des pratiques de traitement des données différentes de leurs produits entreprise, parfois de manière spectaculaire. La même capacité d'IA sous-jacente accédée via un compte personnel et via un compte entreprise peut avoir des politiques de données d'entraînement, des pratiques de conservation et une disponibilité de protection contractuelle complètement différentes. Le personnel qui accède aux outils d'IA d'entreprise via des comptes personnels parce que les comptes organisationnels nécessitent une approbation ou coûtent de l'argent utilise des protections de niveau grand public sur des données professionnelles sans reconnaître la différence.

La règle des 30 % pour l'IA s'applique utilement à la conception de programmes de prévention des fuites de données. Les contrôles techniques automatisés devraient gérer environ 30 % du travail de prévention, en particulier les tâches d'application de politique à haute fréquence que l'automatisation gère de manière cohérente à grande échelle. Le jugement humain et la gouvernance organisationnelle couvrent les 70 % restants impliquant l'évaluation des risques, l'évaluation des fournisseurs, la réponse aux incidents, ainsi que la formation et la construction culturelle qui déterminent si les contrôles techniques sont intégrés dans la manière dont le travail s'accomplit réellement ou traités comme des obstacles à contourner.

L'utilisation d'outils d'IA basés sur navigateur est la catégorie la plus difficile à contrôler par le seul blocage au niveau du réseau. Le personnel travaillant à distance sur des réseaux personnels, utilisant des appareils personnels pour des tâches professionnelles, ou accédant à des outils d'IA via des interfaces de navigateur qui ressemblent à un usage web général présente un défi de contrôle que les approches basées sur les points de terminaison traitent mieux que celles basées sur le réseau.

Les outils d'IA générative intégrés dans des logiciels de productivité largement utilisés créent une exposition aux fuites qui ne ressemble pas à un usage d'outils d'IA pour la plupart des personnes salariées. Lorsqu'un traitement de texte utilise l'IA pour suggérer des compléments de texte, qu'un tableur utilise l'IA pour interpréter la saisie de données, ou qu'un client de messagerie utilise l'IA pour rédiger des réponses, la personne salariée utilise l'IA sans aucune des prises de décision délibérées qui pourraient l'inciter à considérer la classification des données. Les programmes de gouvernance qui ne traitent que les outils d'IA autonomes ont des angles morts ici.

L'avertissement de Stephen Hawking sur l'IA portait sur le risque existentiel des systèmes superintelligents plutôt que sur la fuite de données en particulier, mais sa mise en garde plus large concernant l'avancée plus rapide de la capacité d'IA que de la gouvernance de l'IA se traduit directement dans le problème de la fuite de données. Les organisations qui déploient des outils d'IA plus rapidement que leurs cadres de protection des données ne peuvent s'adapter créent exactement l'exposition non gérée vers laquelle pointait la préoccupation générale de Hawking concernant une gouvernance de l'IA insuffisante. La leçon pratique pour la prévention des fuites de données est que l'infrastructure de gouvernance doit se développer en avance sur l'échelle de déploiement plutôt que de la rattraper.

La qualité de la piste d'audit détermine dans quelle mesure les organisations peuvent répondre aux incidents de fuite lorsqu'ils se produisent. Savoir qu'une personne salariée a soumis des données sensibles à un outil d'IA non autorisé est utile. Savoir quelles données spécifiques ont été soumises, quand, quelle a été la réponse de l'outil d'IA, et ce que la personne salariée a fait de cette réponse est ce qui rend possible une réponse efficace aux incidents. L'infrastructure de journalisation pour la prévention des fuites de données par l'IA doit être construite pour l'utilité d'enquête sur les incidents, pas seulement pour la satisfaction des cases à cocher de conformité.

Les personnes salariées et bureaux internationaux ajoutent une complexité de résidence des données à la prévention des fuites. Un outil d'IA approuvé pour une utilisation avec des données professionnelles non personnelles dans une juridiction peut déclencher des violations de résidence de données lorsqu'il est utilisé avec les mêmes catégories de données dans une autre. Les organisations multinationales ont besoin de programmes de prévention des fuites de données qui tiennent compte de la variation juridictionnelle plutôt que d'appliquer des politiques mondiales uniformes sans sensibilité géographique.

## **Prévenir les fuites de données par l'IA en tant que discipline continue**

La prévention des fuites de données par l'IA n'est pas un projet avec une date d'achèvement. C'est une discipline opérationnelle continue qui doit évoluer au rythme du paysage des outils d'IA, de l'environnement réglementaire et de l'empreinte d'IA organisationnelle qu'elle gouverne. Des outils qui n'existaient pas il y a douze mois sont aujourd'hui des éléments standard des flux de travail de nombreuses personnes salariées. Des réglementations qui étaient ambitieuses il y a un an sont aujourd'hui des exigences exécutoires. Des capacités d'IA qui se limitaient à des outils autonomes sont intégrées dans l'infrastructure opérationnelle de manières qui brouillent la frontière entre l'utilisation des outils d'IA et l'utilisation régulière des systèmes.

Les organisations qui bâtissent la prévention des fuites de données par l'IA comme un programme opérationnel durable, avec l'infrastructure de visibilité, les processus de gouvernance et les fondements culturels qui le rendent auto-renforçant plutôt que dépendant de l'application, construisent une protection qui se cumule au fil du temps. Chaque outil approuvé ajouté au programme réduit l'attractivité des alternatives fantômes. Chaque cycle de formation améliore le jugement du personnel sur la classification des données et la sélection des outils. Chaque révision d'accord fournisseur détecte la dérive entre les protections documentées et réelles avant qu'elle ne crée une exposition non détectée.

Les données qui circulent par les outils d'IA de votre organisation comptent parmi les informations les plus sensibles que votre entreprise génère, traitées dans des contextes où les contrôles normaux qui régissent le traitement des données sont les moins matures. Bâtir le programme de prévention qui les protège de manière appropriée n'est pas un exercice de conformité. C'est un investissement de sécurité fondamental dans l'entreprise habilitée par l'IA que votre organisation est déjà en train de devenir.

## **Foire aux questions**

### **Qu'est-ce que la fuite de données dans l'IA ?**

**La fuite de données dans l'IA désigne l'exposition d'informations organisationnelles sensibles par l'utilisation d'outils d'IA, qui se produit lorsque le personnel soumet des données confidentielles à des systèmes d'IA dont les pratiques de traitement des données du fournisseur, les politiques de conservation ou l'utilisation des données d'entraînement créent une divulgation non autorisée au-delà de l'objectif de traitement prévu.** Elle diffère de la fuite de données conventionnelle parce qu'elle se produit par un canal que les outils DLP existants ne surveillent souvent pas, par des actions du personnel qui sont véritablement productives plutôt que négligentes ou malveillantes, et avec des conséquences qui peuvent inclure non seulement une exposition immédiate mais aussi un encodage persistant d'informations sensibles dans l'infrastructure du modèle du fournisseur.

### **Quelle est la règle des 30 % pour l'IA ?**

**La règle des 30 % pour l'IA est le principe selon lequel les systèmes d'IA et les contrôles automatisés devraient gérer environ 30 % d'une fonction de flux de travail ou de programme, en particulier les tâches à haute fréquence, bien définies et exécutables de manière cohérente où l'automatisation fournit des avantages clairs en termes d'efficacité et de fiabilité, tandis que le jugement humain et la gouvernance couvrent les 70 % restants impliquant l'évaluation contextuelle, les décisions de risque et la responsabilité qui doit reposer sur les personnes plutôt que sur des systèmes automatisés.** Dans la prévention des fuites de données par l'IA en particulier, cela signifie que les contrôles techniques automatisés gèrent l'application routinière des politiques tandis que la gouvernance humaine est propriétaire de l'évaluation des risques, de l'évaluation des fournisseurs, de la réponse aux incidents, et des dimensions culturelles et de formation qui déterminent si les contrôles techniques sont intégrés dans le comportement réel.

### **Quel était l'avertissement de Stephen Hawking sur l'IA ?**

**L'avertissement principal de Stephen Hawking sur l'IA concernait le risque existentiel potentiel d'une intelligence artificielle générale qui surpasse les capacités cognitives humaines et poursuit des objectifs mal alignés avec le bien-être humain, exprimant sa préoccupation que l'humanité avançait trop rapidement sur le développement de la capacité d'IA sans accorder une attention adéquate à la sécurité et à la gouvernance.** Bien que sa préoccupation visait le risque existentiel à long terme plutôt que la sécurité des données d'entreprise à court terme, le principe sous-jacent de gouvernance se traduit directement dans le déploiement pratique de l'IA : les organisations qui font progresser la capacité d'IA plus rapidement que leurs cadres de gouvernance ne peuvent s'adapter créent le risque non géré qui résulte de la capacité sans responsabilité.

### **Comment utiliser l'IA sans laisser fuir des données ?**

**Utiliser l'IA sans laisser fuir de données nécessite quatre pratiques appliquées de manière cohérente : ne soumettre que des données qui ont été évaluées par rapport aux catégories de données approuvées de l'outil d'IA avant chaque utilisation, s'appuyer exclusivement sur des outils d'IA de niveau entreprise avec des accords de traitement des données signés qui interdisent l'utilisation des données d'entraînement, comprendre les pratiques spécifiques de traitement des données de chaque outil d'IA utilisé pour des tâches professionnelles, y compris ceux intégrés dans les logiciels de productivité, et suivre les politiques organisationnelles de classification des données qui définissent quels niveaux de sensibilité sont autorisés avec quels outils d'IA.** Pour les catégories de données les plus sensibles, la seule approche entièrement à l'abri des fuites consiste à utiliser des outils d'IA déployés sur une infrastructure privée où les données ne quittent jamais le périmètre réseau propre de l'organisation.

### **Que ne faudrait-il pas dire à ChatGPT ?**

**Via l'interface grand public standard de ChatGPT, le personnel ne devrait pas soumettre d'informations personnelles de clientèle, de dossiers du personnel, de communications juridiquement privilégiées, de code source ou d'algorithmes propriétaires, de projets de divulgations financières ou d'informations non publiques importantes, de secrets commerciaux, d'informations confidentielles de la clientèle, ou toute autre donnée dont la divulgation non autorisée créerait des conséquences juridiques, réglementaires, concurrentielles ou contractuelles pour l'organisation.** La version grand public de ChatGPT opère selon des conditions de service qui n'incluent pas les accords de traitement des données, les interdictions de données d'entraînement et les protections contractuelles qui rendent les outils d'IA de niveau entreprise appropriés pour les données professionnelles, ce qui signifie que le contenu soumis via des comptes personnels peut être conservé et potentiellement utilisé de manières que les organisations ne peuvent ni contrôler ni même découvrir.
