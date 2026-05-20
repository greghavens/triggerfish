---
title: "Sécurité de l'AI en entreprise : ce qu'elle couvre, pourquoi elle diffère
  de la sécurité informatique standard, et comment la mettre en œuvre correctement"
date: 2026-04-01
description: La sécurité de l'AI en entreprise protège les données, modèles et
  flux de travail face aux menaces propres aux déploiements d'AI. Voici ce que
  les grandes organisations doivent construire et gérer avec soin.
author: triggerfish
tags:
  - AI agent
draft: false
---
La sécurité de l'AI en entreprise désigne les politiques, contrôles techniques, cadres de gouvernance et pratiques opérationnelles qui protègent les grandes organisations contre les menaces, vulnérabilités et risques de données spécifiques qui émergent lorsque les systèmes d'intelligence artificielle sont déployés à grande échelle dans les opérations métier. Elle va bien au-delà de la cybersécurité conventionnelle pour traiter les vecteurs d'attaque, les modes de défaillance et les obligations de conformité propres aux systèmes d'AI.

La plupart des programmes de sécurité d'entreprise ont été conçus pour un environnement logiciel où les applications se comportent de manière prévisible, où les entrées sont structurées, où les sorties sont déterministes et où la surface d'attaque est définie par les limites du réseau et les points de terminaison connus. Les systèmes d'AI violent simultanément chacune de ces hypothèses. Ils acceptent des entrées en langage naturel non structurées qui ne peuvent pas être entièrement validées, produisent des sorties probabilistes qui varient dans des conditions identiques, et entreprennent de plus en plus des actions autonomes sur des systèmes connectés qui amplifient les conséquences de toute compromission. Les organisations qui appliquent leurs cadres de sécurité existants aux déploiements d'AI sans modification protègent une catégorie de technologie fondamentalement différente avec des outils conçus pour autre chose. Les lacunes ainsi créées ne sont pas théoriques. Elles sont exploitées par des attaquants qui comprennent que les systèmes d'AI sont à la fois des cibles de grande valeur et des surfaces d'attaque inédites que de nombreuses équipes de sécurité apprennent encore à défendre. Ce guide explique ce qu'exige la sécurité de l'AI en entreprise, où se concentrent les risques les plus importants, et ce que font les organisations les plus efficaces pour construire des programmes de sécurité adaptés au véritable paysage des menaces liées à l'AI.



![AI agent](/blog/images/senior-enterprise.jpg)

## **Pourquoi la sécurité de l'AI en entreprise nécessite une approche différente**

### **Le problème d'échelle et de connectivité**

Les déploiements d'AI en entreprise diffèrent de l'utilisation expérimentale ou à petite échelle de l'AI de manières qui affectent directement l'approche de sécurité requise. À l'échelle de l'entreprise, les systèmes d'AI ne sont pas des outils que les employés individuels utilisent occasionnellement. Ils sont intégrés aux flux de travail opérationnels essentiels, connectés à des référentiels de données sensibles, et prennent ou éclairent des décisions conséquentes à des volumes qui rendent impossible la supervision manuelle de chaque sortie.

Cette échelle modifie l'équation du risque de manière importante. Un système d'AI traitant des milliers d'interactions clients quotidiennes avec un taux d'erreur de deux pour cent sur le traitement de données sensibles génère une exposition absolue significative même si le pourcentage semble gérable. Un agent d'AI autorisé à entreprendre des actions sur plusieurs systèmes d'entreprise connectés qui est susceptible à l'injection de prompts crée un rayon d'impact bien plus large que la même vulnérabilité dans un déploiement isolé. Et un système d'AI intégré si profondément dans les flux de travail opérationnels que sa suppression entraînerait une perturbation opérationnelle a accumulé une dépendance organisationnelle qui rend la résolution des vulnérabilités de sécurité après leur découverte considérablement plus compliquée que de le faire avant le déploiement.

La dimension de connectivité de l'AI en entreprise ajoute une surface d'attaque que les évaluations de sécurité ponctuelles sous-estiment systématiquement. Un assistant d'AI d'entreprise connecté à la messagerie, à l'agenda, à la gestion documentaire, au CRM et aux bases de connaissances internes a accès à une partie significative des informations les plus sensibles de l'organisation à travers chacune de ces intégrations. Le périmètre de sécurité de ce système d'AI n'est pas l'outil d'AI lui-même. C'est la posture de sécurité combinée de chaque système auquel il se connecte et de chaque flux de données qui les relie.

### **Comment les exigences réglementaires d'entreprise façonnent les obligations de sécurité**

Les organisations d'entreprise dans les secteurs réglementés portent des obligations de sécurité d'AI qui vont bien au-delà de ce que la bonne pratique de sécurité exigerait seule. Les régulateurs des services financiers attendent une documentation de gestion des risques de modèles pour les systèmes d'AI utilisés dans des activités réglementées. Les régulateurs de la santé exigent des garanties techniques spécifiques pour les systèmes d'AI traitant des informations de santé protégées. Les autorités de protection des données dans l'UE, au Royaume-Uni et dans une liste croissante d'autres juridictions attendent des mesures de sécurité documentées pour les systèmes d'AI qui traitent des données personnelles à grande échelle.

Ces obligations réglementaires créent une dimension de conformité à la sécurité de l'AI en entreprise que les cadres de sécurité purement techniques ne capturent pas entièrement. Un déploiement d'AI en entreprise techniquement sécurisé mais qui manque de la documentation, des pistes d'audit et des structures de gouvernance que les régulateurs s'attendent à voir n'est pas conforme, même si aucune défaillance de sécurité réelle ne s'est produite. Intégrer la génération de preuves de conformité dans l'architecture de sécurité de l'AI dès le départ coûte considérablement moins cher que d'adapter la documentation après une enquête réglementaire.

Examiner comment les exigences de[ sécurité de l'AI](https://trigger.fish/security/) interagissent avec les cadres réglementaires sectoriels aide les équipes de sécurité d'entreprise à construire des programmes qui satisfont à la fois leurs objectifs de sécurité technique et les obligations de conformité applicables à leur secteur et à leurs catégories de données spécifiques.



![AI agent](/blog/images/security-team.jpg)

## **Les principales catégories de risque dans la sécurité de l'AI en entreprise**

### **Risques de la couche modèle et inférence**

Le modèle d'AI lui-même représente une surface d'attaque que les équipes de sécurité d'entreprise développent encore les outils et l'expertise pour évaluer et défendre. Les risques au niveau du modèle incluent les attaques adverses qui manipulent les sorties du modèle via des entrées soigneusement élaborées, l'injection de prompts qui remplace les instructions du modèle via le contenu fourni par l'utilisateur ou récupéré, et les attaques d'extraction de modèle qui reconstruisent les capacités du modèle propriétaire par interrogation systématique.

Pour les entreprises qui ont investi dans le réglage fin de modèles d'AI sur des données propriétaires, l'extraction de modèle représente à la fois un risque de propriété intellectuelle et un risque de renseignement concurrentiel. Une série suffisamment systématique de requêtes adressées à un modèle ajusté peut révéler des informations significatives sur les données d'entraînement et les adaptations spécifiques effectuées pendant le réglage fin, même lorsque le modèle lui-même n'est pas accessible au public. Les entreprises qui déploient des modèles propriétaires ajustés ont besoin d'une limitation de débit, d'une surveillance des requêtes et d'une détection d'anomalies sur les modèles d'accès au modèle dans le cadre de leur architecture de sécurité.

L'injection de prompts à l'échelle de l'entreprise entraîne des conséquences qui vont au-delà des sorties embarrassantes ou nuisibles qui font les gros titres dans les contextes grand public. Un agent d'AI d'entreprise connecté aux systèmes financiers, aux bases de données RH ou aux dossiers clients qui est manipulé avec succès par injection de prompt peut exfiltrer des données sensibles, exécuter des transactions non autorisées ou corrompre des dossiers de manières qui créent à la fois des dommages opérationnels immédiats et une exposition de conformité difficile à corriger. La relation directe entre la connectivité de l'AI et le rayon d'impact de l'injection de prompts est l'une des considérations de sécurité architecturale les plus importantes dans le déploiement d'AI en entreprise.

### **Sécurité du pipeline de données et du RAG**

Les systèmes d'AI d'entreprise s'appuient de plus en plus sur des architectures de Génération Augmentée par Récupération qui connectent les modèles à des bases de connaissances organisationnelles en direct, à des référentiels de documents et à des sources de données opérationnelles. La sécurité de ces pipelines de données est aussi importante que la sécurité du modèle lui-même, car le contenu récupéré façonne ce que le modèle produit de manières que les attaques sur le pipeline de données peuvent exploiter.

Un système RAG qui récupère du contenu à partir d'une base de connaissances aux contrôles d'accès insuffisants peut renvoyer des documents à des utilisateurs qui ne devraient pas y avoir accès, intégrés dans des réponses générées par l'AI qui ressemblent à la propre connaissance de l'AI plutôt qu'à du contenu organisationnel récupéré. Le contrôle d'accès sur ce que l'AI peut récupérer doit imposer les mêmes limites d'information que celles qui régissent l'accès direct aux documents, et tester cette application doit faire partie du programme de sécurité plutôt que d'être une hypothèse.

L'empoisonnement des données par la manipulation du contenu indexé est une préoccupation émergente de sécurité de l'AI en entreprise. Si un attaquant peut modifier des documents dans une base de connaissances RAG, il peut influencer les réponses du système d'AI pour chaque utilisateur qui interroge des sujets qui récupèrent le contenu empoisonné. L'intégrité du contenu de la base de connaissances est une propriété de sécurité que les déploiements RAG doivent maintenir grâce aux mêmes contrôles d'accès, à la journalisation des modifications et à la vérification d'intégrité qui s'appliquent à d'autres données d'entreprise sensibles.


<table>
  <thead>
    <tr>
      <th>Catégorie de risque</th>
      <th>Vecteur d'attaque principal</th>
      <th>Préoccupation spécifique à l'entreprise</th>
      <th>Contrôle clé</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Injection de prompts</td>
      <td>Instructions malveillantes dans l'entrée utilisateur ou le contenu récupéré</td>
      <td>Amplifiée par la connectivité des outils d'entreprise</td>
      <td>Validation d'entrée, surveillance de sortie, outils à privilèges minimaux</td>
    </tr>
    <tr>
      <td>Exfiltration de données</td>
      <td>Modèle d'AI utilisé pour récupérer et exposer des données non autorisées</td>
      <td>Échelle et automatisation de l'exfiltration</td>
      <td>Contrôles d'accès sur la récupération, filtrage des sorties, détection d'anomalies</td>
    </tr>
    <tr>
      <td>Extraction de modèle</td>
      <td>Interrogation systématique pour reconstruire un modèle propriétaire</td>
      <td>Exposition de PI et de renseignement concurrentiel</td>
      <td>Limitation de débit, surveillance des requêtes, contrôles d'accès</td>
    </tr>
    <tr>
      <td>Empoisonnement de données RAG</td>
      <td>Manipulation du contenu indexé de la base de connaissances</td>
      <td>Influence tous les utilisateurs récupérant le contenu affecté</td>
      <td>Contrôles d'intégrité de la base de connaissances, journalisation des modifications</td>
    </tr>
    <tr>
      <td>AI fantôme</td>
      <td>Utilisation d'outils d'AI non autorisés contournant les contrôles de sécurité</td>
      <td>Échelle d'exposition dans les grandes organisations</td>
      <td>Surveillance de visibilité, programme d'outils approuvés, DLP</td>
    </tr>
    <tr>
      <td>Chaîne d'approvisionnement</td>
      <td>Poids de modèle compromis ou intégrations tierces</td>
      <td>Difficile à détecter par des contrôles standard</td>
      <td>Vérification de l'intégrité du modèle, évaluation de la sécurité du fournisseur</td>
    </tr>
  </tbody>
</table>



### **Risques d'identité, d'accès et de gouvernance**

Les systèmes d'AI d'entreprise qui opèrent avec un large accès aux systèmes et données organisationnels sous des identifiants de compte de service représentent un défi de gestion des accès privilégiés que de nombreuses entreprises n'ont pas encore pleinement intégré dans leurs programmes de gouvernance des identités. Un agent d'AI opérant avec le même accès système qu'un employé senior, mais sans le contexte comportemental, les structures de responsabilité ou le jugement de cet employé, est une cible de grande valeur qui mérite la même rigueur de gestion des accès privilégiés appliquée aux utilisateurs humains privilégiés.

Les comptes de service utilisés par les systèmes d'AI doivent être inventoriés, leur accès limité aux exigences opérationnelles, leur utilisation surveillée pour détecter les anomalies, et leurs identifiants gérés avec les mêmes normes de rotation et de protection que celles appliquées aux autres comptes de service privilégiés. Dans de nombreux environnements d'entreprise, les comptes de service des systèmes d'AI ont accumulé des autorisations d'accès grâce à un travail d'intégration itératif sans la révision périodique d'accès que subissent les comptes utilisateurs humains, créant une lacune dans l'inventaire des accès privilégiés que les attaquants qui prennent le contrôle de ces identifiants peuvent exploiter de manière extensive.

Le risque de gouvernance dans l'AI en entreprise s'étend aux structures de responsabilité organisationnelle entourant l'opération du système d'AI. Lorsqu'un système d'AI commet une erreur, entreprend une action non autorisée ou contribue à une violation de conformité, la responsabilité de ce résultat doit reposer clairement sur un propriétaire humain nommé qui a la responsabilité et l'autorité pour superviser le système. Les entreprises où les systèmes d'AI opèrent sans propriété humaine claire sont des organisations où les obligations de sécurité et de conformité n'ont personne pour s'assurer qu'elles sont respectées.

Comprendre comment les décisions d'[architecture d'AI](https://trigger.fish/architecture/) concernant la conception des comptes de service, la délimitation des accès et la propriété du système affectent à la fois la posture de sécurité et la clarté de la gouvernance aide les entreprises à construire des déploiements d'AI avec les structures de responsabilité que les programmes de sécurité efficaces exigent.

## **Construire un programme de sécurité de l'AI en entreprise**

### **Les quatre piliers appliqués à l'échelle de l'entreprise**

Les quatre piliers de la sécurité de l'AI, la sécurité des entrées, la sécurité des sorties, la sécurité d'accès et d'intégration, et la surveillance et l'observabilité, s'appliquent tous à l'échelle de l'entreprise mais nécessitent une mise en œuvre de qualité entreprise qui va au-delà de ce dont les déploiements plus petits ont besoin.

La sécurité des entrées à l'échelle de l'entreprise nécessite une application cohérente des politiques sur des centaines ou des milliers d'utilisateurs qui peuvent interagir avec les systèmes d'AI via plusieurs interfaces et points d'intégration. Un filtre d'injection de prompts appliqué à une interface qui est contourné via une intégration API représente une lacune. La sécurité des entrées d'entreprise exige une application cohérente des contrôles sur chaque voie par laquelle un contenu non fiable peut atteindre le modèle, y compris les interfaces utilisateur, les points de terminaison API, les pipelines de contenu récupéré et les flux de sortie des outils.

La sécurité des sorties à l'échelle de l'entreprise nécessite une couverture de surveillance sur l'intégralité du volume des sorties générées par l'AI, qui peut être trop élevé pour un examen humain de chaque élément. La surveillance des sorties assistée par AI, qui utilise des modèles de classification pour signaler les sorties qui méritent un examen humain plutôt que de tenter un examen humain de chaque sortie, est l'approche pratique pour les déploiements d'entreprise à volume élevé. Les critères de signalement doivent être suffisamment spécifiques pour faire émerger les préoccupations véritables sans générer des volumes de faux positifs qui submergeraient la capacité d'examen allouée pour les gérer.

La sécurité d'accès et d'intégration à l'échelle de l'entreprise nécessite le type d'architecture systématique que les environnements informatiques à grande échelle appliquent à la gestion des accès privilégiés. Les intégrations de chaque système d'AI doivent être documentées, les autorisations de chaque compte de service doivent être délimitées et révisées, et l'empreinte d'accès combinée de tous les systèmes d'AI de l'entreprise doit être visible pour l'équipe de sécurité comme une image agrégée, et non simplement comme des évaluations individuelles du système.

La surveillance et l'observabilité à l'échelle de l'entreprise nécessitent un investissement en infrastructure proportionnel à l'empreinte de déploiement. Une entreprise comptant des dizaines de systèmes d'AI opérant dans plusieurs unités commerciales et régions géographiques a besoin d'une infrastructure centralisée de journalisation et de surveillance qui agrège les événements de sécurité de l'AI sur tous les déploiements dans une image cohérente avec laquelle les opérations de sécurité peuvent travailler. Une journalisation cloisonnée par système crée un environnement d'enquête où la corrélation des événements entre les systèmes d'AI nécessite un travail manuel qui sape la rapidité et la rigueur de la réponse aux incidents.

### **Évaluation de la sécurité des fournisseurs pour l'AI en entreprise**

Les organisations d'entreprise déploient généralement des capacités d'AI provenant de plusieurs fournisseurs simultanément, y compris les fournisseurs d'API de modèles de fondation, les fournisseurs de plateformes d'AI d'entreprise, l'AI intégrée dans les produits logiciels existants et, potentiellement, les déploiements open source gérés en interne. Chaque relation fournisseur représente un composant de la posture de sécurité de l'AI en entreprise qui nécessite une évaluation individuelle et une gestion continue.

L'évaluation de la sécurité des fournisseurs pour l'AI en entreprise doit aborder plusieurs dimensions que les évaluations standard des fournisseurs informatiques sous-pondèrent souvent pour les risques spécifiques à l'AI.

La question de l'utilisation des données d'entraînement est particulièrement importante à l'échelle de l'entreprise où le volume de données organisationnelles circulant dans les systèmes d'AI rend l'exposition cumulative aux conditions permissives d'utilisation des données d'entraînement substantielle. Les accords d'entreprise avec les fournisseurs d'AI doivent explicitement interdire l'utilisation des données d'entraînement comme condition contractuelle standard, et cette interdiction doit être vérifiée dans l'accord réel plutôt qu'assumée à partir du matériel marketing du fournisseur.

La transparence des sous-traitants est importante pour les fournisseurs d'AI d'entreprise, car l'infrastructure prenant en charge un service d'AI peut impliquer plusieurs tiers au-delà du fournisseur principal. Un modèle de fondation accédé via une plateforme d'entreprise peut fonctionner sur une infrastructure cloud d'un autre fournisseur, avec des poids de modèle stockés par un tiers et une utilisation enregistrée par un quatrième. Comprendre la chaîne complète des sous-traitants et les contrôles de sécurité appliqués à chaque point est nécessaire pour une évaluation complète de la sécurité de l'AI en entreprise.

La validité et la portée des certifications de sécurité nécessitent une vérification active plutôt qu'une confirmation ponctuelle. Les programmes de sécurité d'entreprise doivent intégrer la vérification annuelle des certifications des fournisseurs dans leur calendrier de gestion des fournisseurs, ainsi que des processus de révision des changements matériels dans les pratiques de sécurité et l'infrastructure des fournisseurs qui surviennent entre les cycles de certification.

Examiner comment les[ fonctionnalités d'AI](https://trigger.fish/features/) des plateformes d'AI d'entreprise mettent en œuvre des contrôles de sécurité sur l'ensemble de la pile de déploiement aide les équipes de sécurité à identifier où les contrôles fournis par le fournisseur sont robustes et où les contrôles côté entreprise doivent compenser les lacunes.



![AI agent](/blog/images/security-professional.jpg)

## **Opérationnaliser la sécurité de l'AI en entreprise**

### **Intégrer la sécurité de l'AI dans les programmes de sécurité existants**

Les programmes de sécurité de l'AI en entreprise les plus efficaces ne fonctionnent pas comme des fonctions distinctes parallèles aux programmes de sécurité existants. Ils intègrent les exigences spécifiques à l'AI dans les processus de sécurité, les outils et les structures de gouvernance que l'entreprise exploite déjà, en étendant ces structures pour couvrir les considérations spécifiques à l'AI plutôt que de créer des programmes parallèles qui fragmentent la responsabilité en matière de sécurité.

Les programmes de gestion des vulnérabilités doivent intégrer des catégories de vulnérabilités spécifiques à l'AI, notamment la susceptibilité à l'injection de prompts, la robustesse adverse et la résistance à l'extraction de modèle, aux côtés des vulnérabilités logicielles conventionnelles que les programmes existants traitent. Les tests de pénétration de l'AI et les exercices de red teaming doivent être inclus dans le calendrier des tests aux côtés des tests de pénétration conventionnels.

Les plans de réponse aux incidents nécessitent des manuels spécifiques à l'AI qui traitent des types de preuves, des approches d'investigation et des obligations de notification pertinentes pour les incidents de sécurité de l'AI. Un agent d'AI compromis qui a entrepris des actions non autorisées sur plusieurs systèmes connectés crée un défi d'investigation que les procédures conventionnelles de réponse aux incidents, construites autour de comptes utilisateurs compromis et d'infections par des logiciels malveillants, ne traitent pas entièrement.

Les processus de gestion des changements doivent inclure les mises à jour du système d'AI et les changements de modèle comme événements de changement qui déclenchent une révision de sécurité. Une mise à jour de modèle qui modifie le comportement du système d'AI, une nouvelle intégration qui étend l'accès aux données du système, ou un changement d'ingénierie de prompt qui modifie la façon dont le système répond aux cas limites sont tous des changements avec des implications potentielles de sécurité qui méritent la même attention de révision que les changements apportés aux logiciels d'entreprise conventionnels.

Un[ guide d'AI](https://trigger.fish/guide/) approfondi sur l'intégration de la sécurité de l'AI dans les opérations de sécurité d'entreprise aide les organisations à construire les extensions de programme qui couvrent les risques spécifiques à l'AI sans créer de silos organisationnels qui fragmentent la responsabilité en matière de sécurité entre les systèmes d'AI et les systèmes non-AI.

### **Indicateurs de sécurité pour les programmes d'AI en entreprise**

Les programmes de sécurité de l'AI en entreprise ont besoin d'indicateurs mesurables de la posture de sécurité qui permettent à la direction d'évaluer l'efficacité du programme et de prendre des décisions d'investissement éclairées. L'absence d'incidents n'est pas un indicateur de sécurité suffisant car il ne peut pas distinguer entre un programme sécurisé et un programme qui n'a pas encore connu d'incident visible.

Les indicateurs utiles de sécurité de l'AI en entreprise couvrent la couverture, l'efficacité du contrôle et la capacité de réponse sur l'empreinte de déploiement de l'AI.


<table>
  <thead>
    <tr>
      <th>Catégorie d'indicateur</th>
      <th>Exemple d'indicateur</th>
      <th>Ce qu'il indique</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Couverture de l'inventaire</td>
      <td>Pourcentage de systèmes d'AI avec des évaluations de sécurité complétées</td>
      <td>Quelle part de l'empreinte AI est sous gouvernance active</td>
    </tr>
    <tr>
      <td>Déploiement des contrôles</td>
      <td>Pourcentage de systèmes d'AI avec journalisation et surveillance configurées</td>
      <td>Couverture d'observabilité sur le déploiement</td>
    </tr>
    <tr>
      <td>Gestion des vulnérabilités</td>
      <td>Temps moyen pour corriger les vulnérabilités de sécurité de l'AI identifiées</td>
      <td>Rapidité d'amélioration de la posture de sécurité</td>
    </tr>
    <tr>
      <td>Gouvernance des accès</td>
      <td>Pourcentage de comptes de service d'AI avec des révisions d'accès documentées</td>
      <td>Maturité de la gestion des accès privilégiés</td>
    </tr>
    <tr>
      <td>Évaluation des fournisseurs</td>
      <td>Pourcentage de fournisseurs d'AI avec des évaluations de sécurité actuelles</td>
      <td>Couverture de sécurité de la chaîne d'approvisionnement</td>
    </tr>
    <tr>
      <td>Réponse aux incidents</td>
      <td>Temps moyen pour détecter et contenir les incidents de sécurité de l'AI</td>
      <td>Efficacité de la capacité de réponse</td>
    </tr>
    <tr>
      <td>AI fantôme</td>
      <td>Nombre d'outils d'AI non autorisés identifiés et traités</td>
      <td>Efficacité de l'application de la gouvernance</td>
    </tr>
  </tbody>
</table>



## **Ce qu'il faut savoir**

Plusieurs réalités importantes concernant la sécurité de l'AI en entreprise que les grandes organisations rencontrent systématiquement à mesure que leurs programmes mûrissent :

L'écart de compétences en sécurité de l'AI est réel et nécessite un investissement délibéré. La combinaison de connaissances techniques en AI et d'expertise en sécurité nécessaire pour évaluer, concevoir et exploiter efficacement les programmes de sécurité de l'AI en entreprise est véritablement rare. Les entreprises qui attendent que le marché livre des professionnels de la sécurité de l'AI prêts à l'emploi attendent une offre qui ne répondra pas à la demande à grande échelle. Le développement des capacités internes par la formation du personnel de sécurité existant sur les menaces et contrôles spécifiques à l'AI est une voie plus rapide et plus fiable que l'embauche externe seule.

L'attention réglementaire portée à la sécurité de l'AI en entreprise s'intensifie dans toutes les juridictions. Les exigences du EU AI Act pour les systèmes d'AI à haut risque incluent des obligations de sécurité spécifiques que les entreprises déployant l'AI dans des cas d'usage réglementés doivent satisfaire. Les régulateurs financiers des principaux marchés intègrent des questions spécifiques à l'AI dans les cadres d'examen. Les régulateurs de la santé clarifient comment les exigences existantes de sécurité des données s'appliquent aux systèmes d'AI. Les entreprises qui construisent des programmes de sécurité qui satisfont les attentes réglementaires actuelles sont mieux positionnées pour s'adapter aux exigences supplémentaires qui arrivent clairement.

Le principe des 30 % s'applique spécifiquement aux décisions de gouvernance de sécurité de l'AI en entreprise. Les programmes de sécurité d'entreprise devraient s'appuyer sur des contrôles automatisés et une surveillance assistée par AI pour gérer environ 30 % des opérations de sécurité, le travail de détection et de réponse à volume élevé basé sur des modèles que l'automatisation gère de manière cohérente, tandis que les professionnels de la sécurité concentrent leur expertise sur les 70 % impliquant des investigations complexes, le jugement des risques, la gestion des relations réglementaires et les décisions stratégiques de sécurité qui exigent une responsabilité humaine.

Les déploiements d'AI multi-cloud et multi-fournisseurs créent une complexité de sécurité que les environnements à fournisseur unique évitent. La volonté des entreprises de maintenir une optionalité entre les fournisseurs d'AI, qui est stratégiquement sensée pour des raisons commerciales et concurrentielles, crée un défi d'intégration de sécurité car différents fournisseurs implémentent les contrôles de sécurité, les formats de journalisation et les comportements d'API différemment. Construire une infrastructure de sécurité qui normalise les différences entre fournisseurs est un investissement réel que la simplicité d'un fournisseur unique évite.

Les incidents de sécurité de l'AI ont un retard de découverte plus long que les incidents de sécurité conventionnels en moyenne. Les modes de défaillance des systèmes d'AI se manifestent souvent comme une dégradation de la qualité, des changements comportementaux subtils ou des violations de conformité plutôt que les pannes système et le vol évident de données que produisent les incidents de sécurité conventionnels. Construire des approches de détection capables d'identifier ces modes de défaillance plus subtils, plutôt que seulement les plus évidents, nécessite une surveillance spécifique à l'AI qui s'étend au-delà de la détection conventionnelle d'événements de sécurité.

La communication avec le conseil d'administration et les dirigeants sur la sécurité de l'AI en entreprise nécessite de traduire des concepts techniques en termes de risque commercial sur lesquels la direction non technique peut agir. Les équipes de sécurité qui communiquent la sécurité de l'AI en termes techniques constatent souvent que leurs programmes sont sous-financés par rapport au risque réel parce que la direction ne peut pas relier le langage technique à l'impact commercial. Développer un cadrage de risque commercial pour les propositions d'investissement en sécurité de l'AI est une capacité de maturité du programme qui rapporte des dividendes en termes de soutien organisationnel et d'allocation de ressources.

## **Construire la sécurité de l'AI en entreprise comme une capacité organisationnelle**

Les entreprises qui développent de solides programmes de sécurité de l'AI partagent systématiquement une caractéristique au-delà de leurs contrôles techniques spécifiques et de leurs structures de gouvernance. Elles traitent la sécurité de l'AI en entreprise comme une capacité organisationnelle qui mûrit avec le temps plutôt que comme un projet avec un état d'achèvement. Le paysage des menaces évolue. L'environnement réglementaire se durcit. L'empreinte de déploiement de l'AI s'étend. La capacité organisationnelle d'évaluer, de gouverner et de répondre aux défis de sécurité de l'AI doit évoluer en parallèle.

Ce développement de capacité nécessite un investissement dans trois dimensions simultanément. Une infrastructure technique qui offre visibilité et contrôle sur l'empreinte de déploiement de l'AI. Une expertise humaine qui combine la profondeur de la sécurité avec la compréhension du système d'AI d'une manière qu'aucune des deux disciplines seule ne fournit. Et des structures de gouvernance qui créent une responsabilité claire pour les résultats de sécurité de l'AI à chaque niveau de l'organisation, du conseil d'administration au propriétaire individuel du système d'AI.

La sécurité de l'AI en entreprise n'est pas un problème qui se résout et reste résolu. C'est une capacité qui se construit et se développe continuellement à mesure que la technologie, les menaces et le contexte organisationnel dans lequel elle opère continuent de changer. Les entreprises qui abordent la question de cette manière, avec un investissement soutenu, une propriété claire et un développement délibéré des capacités, construisent la base de sécurité qui rend possible l'adoption confiante de l'AI en entreprise à l'échelle et dans les contextes sensibles au risque où elle compte le plus.

## **Questions fréquentes**

### **Qu'est-ce que la protection des données d'entreprise dans l'AI ?**

**La protection des données d'entreprise dans l'AI désigne la combinaison de contrôles techniques, de protections contractuelles et de pratiques de gouvernance qui garantissent que les données organisationnelles traitées par les systèmes d'AI restent sécurisées, dûment restreintes et traitées conformément aux exigences réglementaires applicables tout au long de leur cycle de vie dans les flux de travail d'AI.** Elle couvre les données en transit et au repos au sein de l'infrastructure d'AI, les interdictions contractuelles concernant l'utilisation de ces données par le fournisseur pour l'entraînement de modèles, les contrôles d'accès régissant qui et quels systèmes peuvent soumettre des données aux outils d'AI, et les pratiques de conservation et de suppression qui déterminent la durée pendant laquelle ces données restent dans l'infrastructure du fournisseur après utilisation.

### **Que sont les outils d'AI d'entreprise ?**

**Les outils d'AI d'entreprise sont des produits d'intelligence artificielle spécifiquement conçus et contractés pour un déploiement organisationnel, se distinguant des produits d'AI grand public par des fonctionnalités telles que les accords de traitement des données, les interdictions de données d'entraînement, les certifications SOC 2 et autres certifications de conformité, les contrôles d'accès basés sur les rôles, la journalisation d'audit et les capacités d'intégration qui leur permettent de se connecter en toute sécurité aux systèmes d'entreprise existants.** Ils opèrent généralement à un prix plus élevé que les équivalents grand public spécifiquement parce qu'ils incluent l'infrastructure légale, technique et opérationnelle requise par la gouvernance des données d'entreprise, ce que les outils grand public ne fournissent pas.

### **Comment l'AI peut-elle être utilisée pour la sécurité ?**

**L'AI est utilisée pour la sécurité afin d'alimenter les systèmes de détection des menaces qui identifient les anomalies comportementales sur l'activité réseau et utilisateur à des volumes que la détection basée sur des règles ne peut pas traiter, automatiser la classification des données et la prévention de la perte de données sur les flux de documents et de communication à volume élevé, aider les analystes de sécurité avec les flux de travail de triage et d'investigation des alertes, et surveiller les systèmes d'AI eux-mêmes pour les entrées adverses, les sorties anormales et les modèles d'accès inhabituels qui indiquent des incidents de sécurité spécifiques à l'AI.** Les programmes de sécurité d'entreprise les plus matures utilisent l'AI à la fois comme cible de leur gouvernance de sécurité et comme outil au sein de leurs opérations de sécurité, traitant les deux dimensions comme de véritables priorités plutôt que de permettre que l'attention portée à l'une supplante l'attention portée à l'autre.

### **Quels sont les risques de l'AI en entreprise ?**

**Les principaux risques de l'AI en entreprise se répartissent en quatre catégories : les risques opérationnels liés aux défaillances du système d'AI, aux sorties inexactes et à la dégradation des performances qui perturbent les processus métier ; les risques de données liés à l'accès non autorisé, à la conservation non intentionnelle et aux pratiques de traitement des données par le fournisseur qui exposent des informations organisationnelles sensibles ; les risques de conformité liés aux déploiements d'AI qui violent les exigences réglementaires applicables pour le traitement des données, la prise de décision automatisée ou la gouvernance de l'AI spécifique au secteur ; et les risques réputationnels liés aux défaillances de l'AI qui deviennent visibles pour les clients, les régulateurs ou le public de manière à nuire à la confiance et aux relations organisationnelles.** L'échelle de l'entreprise amplifie chacune de ces catégories de risque car le volume de traitement de l'AI, l'étendue de l'intégration du système et la dépendance organisationnelle aux sorties de l'AI augmentent toutes les conséquences des défaillances qui pourraient être contenues et gérables à des échelles de déploiement plus petites.

### **Quels sont les 4 types de risque d'AI ?**

**Les quatre types de risque d'AI sont le risque opérationnel couvrant les défaillances du système et les inexactitudes des sorties qui perturbent les processus métier, le risque de données couvrant l'accès non autorisé et le traitement inapproprié des informations traitées par les systèmes d'AI, le risque de conformité couvrant les violations réglementaires déclenchées par le déploiement et l'exploitation de l'AI, et le risque réputationnel couvrant les conséquences sur la confiance du public et des parties prenantes des incidents et défaillances de l'AI.** Dans les contextes d'entreprise, ces quatre catégories interagissent et se cumulent de manières que les déploiements plus petits ne connaissent pas, car l'échelle, la connectivité et la dépendance organisationnelle de l'AI d'entreprise amplifient les conséquences de toute défaillance qui n'est pas détectée et contenue avant qu'elle ne se propage à travers les processus métier et les relations avec les parties prenantes qui en dépendent.
