---
title: "AI et confidentialité des données de santé : ce que chaque prestataire
  et patient·e doit comprendre"
date: 2026-03-23
description: L'AI pour la confidentialité des données de santé soulève de
  véritables préoccupations de conformité et de sécurité. Découvrez les risques,
  comment fonctionnent les protections, et à quoi ressemble un déploiement
  responsable.
author: triggerfish
tags:
  - AI agent
draft: false
---



L'AI pour la confidentialité des données de santé se situe à l'intersection de deux choses qui ont des conséquences énormes lorsque quelque chose tourne mal : les informations médicales et les systèmes automatisés qui les traitent à grande échelle. L'AI dans le domaine de la santé peut réellement améliorer les résultats des patient·es, réduire les erreurs de diagnostic et alléger la charge administrative qui consomme le temps du personnel clinique qui devrait être consacré aux soins. Mais les mêmes systèmes qui rendent ces améliorations possibles soulèvent aussi de nouvelles questions sur qui a accès aux informations de santé sensibles, comment elles sont utilisées au-delà de l'objectif clinique immédiat, et ce qui se passe lorsqu'un système échoue ou est compromis.

Comprendre comment fonctionnent ces risques, quelles protections existent et à quoi ressemble un déploiement responsable de l'AI dans un contexte de santé n'est pas une connaissance optionnelle pour les prestataires, les administrateur·rices ou les patient·es qui naviguent dans un système qui évolue plus rapidement que la plupart des gens ne le réalisent.



![AI agent](/blog/images/medical.jpg)

## **Pourquoi les données de santé méritent une norme différente**

Toutes les données personnelles n'ont pas la même sensibilité. Les informations financières sont sérieuses. Les données de localisation ont des implications importantes. Mais les données de santé occupent une catégorie distincte en raison de ce qu'elles révèlent et de ce qu'elles permettent. L'historique médical d'une personne, les dossiers de diagnostic, les informations sur les médicaments, les données génétiques et les antécédents de santé mentale peuvent affecter son éligibilité à l'assurance, ses perspectives d'emploi, ses relations personnelles et sa sécurité physique s'ils tombent entre de mauvaises mains ou sont utilisés de manière à laquelle la personne n'a jamais consenti.

C'est pourquoi le secteur de la santé a historiquement fonctionné selon des règles de protection des données plus strictes que la plupart des autres secteurs. En Australie, la Privacy Act et les Australian Privacy Principles s'appliquent aux informations de santé avec des exigences supplémentaires spécifiques. La My Health Records Act régit le système national de dossiers de santé numériques. La législation des États sur les dossiers de santé ajoute des obligations supplémentaires dans plusieurs juridictions. À l'international, des cadres comme HIPAA aux États-Unis et le GDPR en Europe établissent des normes qui affectent tout système d'AI opérant à travers les frontières ou utilisant des modèles développés internationalement.

Ce que l'AI apporte à ce paysage, c'est une nouvelle complexité à chaque point où les données circulent, sont traitées ou éclairent une décision. Un système traditionnel de dossier de santé électronique stocke les données et les rend accessibles aux utilisateur·rices autorisé·es. Un système d'AI entraîné sur des données de santé, déployé pour assister les décisions cliniques, ou utilisé pour traiter des dossiers administratifs fait quelque chose de structurellement différent. Il apprend des données. Il fait des inférences. Il produit des résultats qui peuvent contenir des traces des informations sur lesquelles il a été entraîné de manière qui n'est pas toujours transparente ou prévisible.

Comprendre l'[architecture de l'AI](https://trigger.fish/architecture/) de tout système déployé dans un contexte de santé est le point de départ pour comprendre quels risques de confidentialité des données il crée réellement, car l'architecture détermine où vont les données, ce qui est conservé et quelles protections sont techniquement possibles.

## **Les véritables préoccupations en matière de confidentialité de l'AI dans les données de santé**

Les risques de confidentialité que l'AI introduit dans le domaine de la santé ne sont pas hypothétiques. Ils sont spécifiques, documentés et grandissants à mesure que le déploiement de l'AI dans les contextes cliniques et administratifs s'accélère.

**L'exposition des données d'entraînement** est l'un des risques les plus importants et les moins visibles. De nombreux systèmes d'AI utilisés dans le domaine de la santé ont été entraînés sur de grands jeux de données qui incluaient des informations réelles de patient·es. Si cet entraînement n'a pas été effectué selon des normes appropriées de désidentification, le modèle peut avoir effectivement encodé les données des patient·es dans ses paramètres de manière qui peut parfois être extraite par des requêtes ciblées. Le ou la patient·e dont les dossiers ont contribué à l'entraînement d'un système d'AI diagnostique n'a pas nécessairement consenti à cet usage et peut n'avoir aucun moyen de savoir que cela s'est produit.

**Le risque d'inférence et de réidentification** se produit lorsque les systèmes d'AI sont utilisés pour tirer des conclusions à partir des données de santé qui vont au-delà de ce que le ou la patient·e a partagé ou consenti. Une AI analysant des motifs dans les dossiers de santé électroniques peut inférer une condition de santé mentale à partir des dossiers de médication, une grossesse à partir des modèles de prescription, ou une prédisposition génétique à partir de l'historique diagnostique. Chacune de ces inférences crée une nouvelle information sensible qui n'existait pas dans le dossier original et que le ou la patient·e peut ne pas avoir divulguée ou consenti à partager.

**L'exposition aux fournisseurs tiers** est un risque structurel dans la plupart des déploiements d'AI en santé. Les outils d'AI utilisés dans les contextes cliniques sont presque jamais conçus par l'organisation de santé qui les utilise. Ce sont des produits d'entreprises technologiques dont les pratiques de traitement des données, les normes de sécurité et les engagements contractuels varient considérablement. Chaque relation avec un fournisseur introduit un accord de partage de données qui doit être évalué par rapport aux obligations de confidentialité, et ces évaluations sont fréquemment moins rigoureuses que l'évaluation clinique des mêmes outils.

**L'agrégation de données entre systèmes** crée des risques de confidentialité qui n'existent pas lorsque les informations sont conservées dans un seul dossier. Les systèmes d'AI qui puisent dans plusieurs sources de données, combinant des dossiers cliniques avec des données administratives, des informations de facturation et potentiellement des ensembles de données externes, créent des profils qui sont beaucoup plus révélateurs que n'importe quelle source unique. La sensibilité des données de santé agrégées augmente de manière non linéaire avec le nombre de sources combinées.



![AI agent](/blog/images/data.jpg)

## **Quels systèmes d'AI sont considérés comme plus sûrs pour la confidentialité des données de santé**

La sécurité dans le contexte de l'AI en santé et de la confidentialité des données n'est pas binaire. C'est une fonction de la manière dont un système est conçu, des données qu'il traite, des contrôles en place et de la manière dont il est gouverné lors du déploiement. Cela dit, certaines caractéristiques distinguent systématiquement les systèmes d'AI qui gèrent les données de santé de manière plus responsable de ceux qui créent un risque inutile.

Les systèmes qui traitent les données localement plutôt que de les transmettre à des serveurs externes réduisent considérablement la surface d'exposition. Les déploiements sur site ou en cloud privé où l'organisation de santé conserve le contrôle sur l'emplacement des données et sur qui peut y accéder présentent structurellement un risque plus faible que les systèmes basés sur le cloud où les données sont transmises et traitées par l'infrastructure du fournisseur. Cela ne rend pas l'AI de santé basée sur le cloud intrinsèquement non sûre, mais cela signifie que le processus d'évaluation du fournisseur doit être plus rigoureux.

Les systèmes qui fonctionnent sur des données désidentifiées ou synthétiques lorsque la tâche clinique le permet réduisent le risque de confidentialité pour le ou la patient·e sans nécessairement réduire l'utilité clinique. L'AI diagnostique qui peut être entraînée et validée sur des jeux de données correctement désidentifiés fournit la même capacité analytique avec un risque considérablement réduit d'exposition des données réelles des patient·es.

Les systèmes qui ont reçu une certification de sécurité indépendante pertinente pour les contextes de santé, tels que SOC 2 Type II, ISO 27001, et de plus en plus ISO 42001 pour la gouvernance spécifique à l'AI, fournissent une certaine assurance que les contrôles de sécurité ont été vérifiés de manière indépendante plutôt qu'auto-déclarés.

Les systèmes avec des engagements contractuels clairs sur la conservation des données, les restrictions d'utilisation secondaire et la notification des violations fournissent le cadre juridique qui rend la responsabilité du fournisseur possible plutôt qu'aspirationnelle. Les fournisseurs qui ne peuvent pas ou ne veulent pas prendre d'engagements contractuels spécifiques sur ce qu'ils font avec les données de santé que leurs systèmes traitent ne conviennent pas au déploiement clinique, quelles que soient leurs capacités techniques.

La[ posture de sécurité de l'AI](https://trigger.fish/security/) d'un fournisseur d'AI en santé doit être évaluée avec la même rigueur appliquée à tout outil clinique. Le fait qu'il s'agisse d'un logiciel plutôt que d'un dispositif médical ne réduit pas les conséquences de son échec ou de sa compromission lorsque des données de santé sont en jeu.

## **Comment l'AI peut réellement aider à la confidentialité des données de santé**

La relation entre l'AI et la confidentialité des données de santé n'est pas purement antagoniste. Les outils d'AI, correctement conçus et déployés, peuvent activement améliorer la protection de la confidentialité dans les contextes de santé d'une manière que les processus manuels ne peuvent pas égaler à grande échelle.

**La désidentification automatisée** est l'un des exemples les plus clairs. La suppression ou la dissimulation d'informations identifiantes dans les dossiers cliniques avant qu'ils ne soient utilisés pour la recherche, l'amélioration de la qualité ou la formation est une tâche chronophage et sujette aux erreurs lorsqu'elle est effectuée manuellement. Les systèmes d'AI entraînés à identifier et à expurger les informations identifiantes peuvent traiter de gros volumes de dossiers avec une plus grande cohérence que les équipes d'examen humain, réduisant le risque qu'un nom, une adresse ou un détail identifiant unique passe à travers les mailles d'un ensemble de données qui devrait être anonyme.

**La détection d'anomalies d'accès** utilise l'AI pour surveiller qui accède aux dossiers des patient·es, quand et dans quel but apparent. Les modèles d'accès inhabituels, un·e membre du personnel téléchargeant un grand nombre de dossiers en dehors des heures normales de travail, un·e utilisateur·rice accédant à des dossiers de patient·es en dehors de sa charge clinique, ou des modèles de requête suggérant une collecte de données plutôt qu'une utilisation clinique, sont des signaux détectables que les systèmes de surveillance d'AI peuvent signaler pour examen. Ce type de surveillance serait peu pratique à effectuer manuellement dans un grand système de santé.

**L'automatisation de la gestion du consentement** aide les organisations de santé à suivre quel·les patient·es ont consenti à quelle utilisation de leurs données et à garantir que les systèmes d'AI ne traitent que les données dans le cadre de ces limites de consentement. À mesure que l'utilisation des données devient plus complexe avec l'AI, la gestion programmatique du consentement devient de plus en plus nécessaire plutôt qu'un atout.

**L'application de la minimisation des données** utilise l'AI pour garantir que les systèmes ne collectent et ne conservent que les données dont ils ont besoin pour leur objectif déclaré. C'est un principe fondamental du droit à la confidentialité difficile à appliquer de manière cohérente dans les grands systèmes de santé complexes sans assistance automatisée.


<table>
  <thead>
    <tr>
      <th>Application d'AI pour la confidentialité</th>
      <th>Ce que cela fait</th>
      <th>Avantage en matière de confidentialité</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Désidentification automatisée</td>
      <td>Supprime les informations identifiantes des dossiers à grande échelle</td>
      <td>Permet l'utilisation des données pour la recherche tout en protégeant l'identité du ou de la patient·e</td>
    </tr>
    <tr>
      <td>Détection d'anomalies d'accès</td>
      <td>Surveille et signale les modèles d'accès inhabituels aux dossiers</td>
      <td>Détection précoce d'accès non autorisé ou d'utilisation abusive interne</td>
    </tr>
    <tr>
      <td>Gestion du consentement</td>
      <td>Suit et applique l'utilisation des données dans les limites du consentement</td>
      <td>Garantit que les systèmes d'AI respectent le consentement du ou de la patient·e de manière programmatique</td>
    </tr>
    <tr>
      <td>Application de la minimisation des données</td>
      <td>Limite la collecte et la conservation des données à l'objectif déclaré</td>
      <td>Réduit l'exposition due aux données conservées au-delà de leur période nécessaire</td>
    </tr>
    <tr>
      <td>Détection et réponse aux violations</td>
      <td>Identifie les compromissions potentielles de données en temps réel</td>
      <td>Une réponse plus rapide réduit la portée des incidents de confidentialité</td>
    </tr>
  </tbody>
</table>



## **Les risques de l'AI dans le domaine de la santé au-delà de la confidentialité**

L'AI pour la confidentialité des données de santé se situe dans un paysage de risques plus large que les prestataires et les administrateur·rices doivent comprendre dans toute son étendue, car les défaillances de confidentialité surviennent rarement isolément d'autres types de défaillances du système.

**L'amplification des erreurs cliniques** est le risque qu'un système d'AI faisant des recommandations incorrectes le fasse de manière cohérente et à grande échelle, d'une manière qu'un·e clinicien·ne humain·e commettant des erreurs individuelles ne ferait pas. Une AI diagnostique avec un biais systématique pour ou contre un diagnostic particulier peut affecter des centaines ou des milliers de patient·es avant que le modèle ne soit détecté, en particulier si les clinicien·nes font confiance à la sortie de l'AI sans vérification indépendante.

**Le biais algorithmique** dans l'AI de santé a été documenté dans plusieurs domaines cliniques. Les systèmes d'AI entraînés sur des données de santé historiques héritent des biais présents dans ces données, y compris la sous-représentation systémique de certains groupes démographiques dans les jeux de données cliniques et les inégalités historiques dans la façon dont différentes populations ont été diagnostiquées et traitées. Un système d'AI qui fonctionne bien sur la population qui a dominé ses données d'entraînement peut fonctionner significativement moins bien sur les patient·es de groupes sous-représentés, créant une qualité de soins différentielle qui aggrave les inégalités de santé existantes.

**L'exposition réglementaire et de responsabilité** est un risque croissant à mesure que les régulateurs en Australie et à l'international développent des attentes plus spécifiques pour l'AI en santé. La Therapeutic Goods Administration a publié des orientations sur le logiciel en tant que dispositif médical qui s'appliquent à de nombreuses applications cliniques d'AI. Les organisations de santé qui déploient l'AI sans évaluation réglementaire adéquate font face à la fois à une exposition juridique et à la perturbation opérationnelle de devoir supprimer ou modifier des systèmes qui sont devenus intégrés dans les flux de travail cliniques.



![AI agent](/blog/images/tablet.jpg)

Un[ guide structuré pour un déploiement responsable de l'AI dans les industries réglementées](https://trigger.fish/guide/) peut aider les organisations de santé à naviguer à l'intersection des exigences cliniques, de confidentialité et réglementaires dans une séquence qui aborde d'abord les éléments à plus haut risque.

## **Normes pratiques pour les organisations de santé déployant l'AI**

La distance entre la pratique actuelle de déploiement de l'AI dans la plupart des organisations de santé et une gouvernance véritablement robuste de la confidentialité et de la sécurité est réelle mais surmontable. Plusieurs normes pratiques fournissent la structure nécessaire pour déployer l'AI dans les contextes de santé de manière responsable.

**Les analyses d'impact sur la protection des données** doivent précéder tout nouveau déploiement d'AI impliquant des données de patient·es. Ces évaluations évaluent les données traitées par le système, les risques créés par ce traitement, les mesures d'atténuation en place et si le risque résiduel est acceptable compte tenu de l'avantage clinique. Elles sont requises par plusieurs cadres de confidentialité et constituent une bonne pratique indépendamment de l'obligation légale.

**Les protocoles de diligence raisonnable des fournisseurs** doivent établir des exigences minimales pour tout fournisseur d'AI dont le système traitera des données de patient·es. Ces exigences doivent couvrir les certifications de sécurité, les accords de traitement des données, les engagements de notification des violations, la divulgation des sous-traitants et les politiques de conservation et de suppression des données. Les fournisseurs qui ne peuvent pas répondre à ces exigences ne doivent pas être déployés dans des contextes cliniques, quelles que soient les capacités cliniques offertes par leurs outils.

**L'intégration à la gouvernance clinique** signifie traiter les systèmes d'AI en santé comme des outils cliniques soumis aux mêmes processus de gouvernance appliqués à d'autres outils cliniques, y compris l'évaluation des preuves cliniques, le suivi continu des performances, la déclaration des événements indésirables et l'examen régulier pour déterminer si l'outil continue de fonctionner comme prévu dans l'environnement clinique où il est déployé.

**La formation du personnel sur l'AI et la confidentialité** garantit que les clinicien·nes et les administrateur·rices utilisant des outils d'AI comprennent leurs obligations en matière de confidentialité dans un environnement assisté par AI, y compris les données qui peuvent être saisies dans les systèmes d'AI, comment interpréter les sorties de l'AI sans trop s'y fier, et comment soulever des préoccupations concernant un comportement de l'AI qui semble incompatible avec les attentes cliniques ou les exigences de confidentialité.


<table>
  <thead>
    <tr>
      <th>Norme de gouvernance</th>
      <th>Ce qu'elle exige</th>
      <th>Qui est responsable</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Analyse d'impact sur la protection des données</td>
      <td>Évaluation formelle des risques de confidentialité avant le déploiement</td>
      <td>Délégué·e à la protection des données et responsable de l'informatique clinique</td>
    </tr>
    <tr>
      <td>Protocole de diligence raisonnable du fournisseur</td>
      <td>Exigences de sécurité et de traitement des données pour tous les fournisseurs d'AI</td>
      <td>Juridique, sécurité informatique et achats</td>
    </tr>
    <tr>
      <td>Intégration à la gouvernance clinique</td>
      <td>AI traitée comme un outil clinique soumis à la gouvernance clinique</td>
      <td>Comité de gouvernance clinique</td>
    </tr>
    <tr>
      <td>Examen du cadre de consentement</td>
      <td>Consentement existant du ou de la patient·e évalué par rapport à l'utilisation des données par l'AI</td>
      <td>Juridique et délégué·e à la protection des données</td>
    </tr>
    <tr>
      <td>Programme de formation du personnel</td>
      <td>Formation des clinicien·nes et administrateur·rices sur l'AI et la confidentialité</td>
      <td>RH, formation clinique et informatique</td>
    </tr>
    <tr>
      <td>Suivi continu des performances</td>
      <td>Examen régulier du comportement et des résultats du système d'AI</td>
      <td>Informatique clinique et équipe qualité</td>
    </tr>
  </tbody>
</table>



## **Ce qu'il faut savoir sur l'AI pour la confidentialité des données de santé**

* Les informations de santé sont classées comme informations sensibles en vertu de la loi australienne sur la confidentialité, ce qui signifie qu'elles requièrent des exigences de protection plus élevées que les informations personnelles générales et ne peuvent être collectées ou utilisées sans base juridique claire ou consentement.
* Les systèmes d'AI qui utilisent les données des patient·es pour l'amélioration du modèle sans consentement explicite peuvent enfreindre les obligations de confidentialité même si les données sont désidentifiées, car les méthodes de désidentification ne sont pas uniformément robustes et le risque de réidentification dépend de la richesse du jeu de données.
* Le système My Health Records en Australie dispose de protections législatives spécifiques qui affectent ce que les systèmes d'AI peuvent faire avec les dossiers consultés via ce système, et les organisations de santé doivent comprendre ces restrictions avant de déployer une AI qui interagit avec les données de My Health Records.
* Le consentement du ou de la patient·e pour les soins assistés par AI est un domaine en évolution. Certaines juridictions s'orientent vers des exigences selon lesquelles les patient·es doivent être informé·es lorsque des systèmes d'AI sont impliqués dans leurs soins cliniques, que l'AI prenne ou soutienne des décisions cliniques.
* L'AI pour la confidentialité des données de santé n'est pas uniquement un problème technologique. Les défaillances de confidentialité les plus importantes dans les déploiements d'AI de santé ont généralement impliqué des lacunes de gouvernance, des échecs dans la gestion des fournisseurs ou le comportement du personnel plutôt qu'une compromission technique du système.
* Les modèles internationaux d'AI utilisés dans les contextes de santé australiens sont soumis à la loi australienne sur la confidentialité, quel que soit le lieu de développement du modèle ou la base du fournisseur, si les données traitées concernent des patient·es australien·nes.
* La planification de la réponse aux incidents pour les violations de confidentialité liées à l'AI dans le domaine de la santé doit tenir compte des obligations de notification des violations de données en vertu de la Privacy Act, qui exigent une notification à la fois à l'OAIC et aux personnes concernées lorsqu'une violation grave de données se produit.

## **Naviguer dans l'AI pour la confidentialité des données de santé de manière responsable**

Le secteur de la santé ne va pas ralentir son adoption de l'AI, et il y a de véritables raisons pour lesquelles il ne devrait pas le faire. Le potentiel de l'AI pour soutenir un diagnostic plus précoce, réduire les erreurs cliniques, alléger la charge administrative et étendre la portée de l'expertise spécialisée à des zones mal desservies est réel et significatif. Le défi n'est pas de résister à l'AI dans le domaine de la santé, mais de la déployer d'une manière à laquelle les patient·es peuvent faire confiance et que les prestataires peuvent défendre.

La confiance dans ce contexte n'est pas un concept abstrait. C'est le résultat pratique d'une protection démontrable de la confidentialité, d'un traitement transparent des données, d'une sécurité rigoureuse et d'une gouvernance clinique qui soumet les systèmes d'AI aux mêmes normes de preuve et de responsabilité que celles appliquées aux autres outils cliniques. Les patient·es qui comprennent que leurs données de santé sont utilisées pour entraîner des systèmes d'AI, que ces systèmes font des recommandations qui influencent leurs soins, et qu'il existe des garanties solides sur la façon dont ces données sont traitées sont des patient·es qui peuvent donner un consentement éclairé aux soins assistés par AI.

Les[ fonctionnalités d'AI](https://trigger.fish/features/) qui rendent l'AI de santé attrayante dans un contexte clinique doivent être accompagnées de fonctionnalités de confidentialité et de sécurité qui les rendent acceptables dans un contexte de gouvernance. Les organisations qui construisent ces deux choses ensemble dès le départ se trouveront beaucoup mieux positionnées à mesure que les attentes réglementaires dans ce domaine continueront d'évoluer et de devenir plus spécifiques.

## **FAQ sur l'AI pour la confidentialité des données de santé**

### **Quelles sont les préoccupations en matière de confidentialité de l'AI dans les données de santé ?**

**Les principales préoccupations en matière de confidentialité incluent l'exposition des données d'entraînement où les informations des patient·es sont intégrées dans les modèles d'AI sans consentement adéquat, le risque de réidentification où l'AI infère des conditions sensibles à partir des données disponibles, le partage de données avec des fournisseurs tiers sans garanties adéquates, et l'agrégation de dossiers entre systèmes créant des profils plus sensibles que n'importe quelle source unique.** Chacun de ces risques nécessite des réponses de gouvernance spécifiques plutôt qu'une seule mesure de protection globale.

### **Quelle AI est sûre pour la confidentialité des données ?**

**Les systèmes d'AI qui traitent les données localement plutôt que de les transmettre à des serveurs externes, fonctionnent selon des restrictions contractuelles claires d'utilisation des données, détiennent des certifications de sécurité indépendantes comme SOC 2 Type II et ISO 27001, et ont été évalués par une analyse formelle d'impact sur la protection des données sont généralement considérés comme plus sûrs pour la confidentialité des données de santé.** La sécurité est une fonction de la gouvernance et de l'architecture plutôt qu'une caractéristique d'un outil ou d'un fournisseur particulier.

### **Comment l'AI contribue-t-elle à la confidentialité des données ?**

**L'AI soutient activement la confidentialité des données grâce à la désidentification automatisée des dossiers cliniques, à la détection des anomalies pour l'accès non autorisé aux données, à l'application de la gestion du consentement et aux contrôles de minimisation des données qui limitent la collecte et la conservation à ce qui est cliniquement nécessaire.** Ces capacités permettent d'appliquer les protections de la confidentialité de manière cohérente à grande échelle d'une manière que les processus manuels ne peuvent pas atteindre de manière fiable dans les grands systèmes de santé.

### **Dans quelle mesure l'AI est-elle sûre dans le domaine de la santé ?**

**La sécurité de l'AI en santé varie considérablement en fonction du fournisseur, du modèle de déploiement et du cadre de gouvernance appliqué par l'organisation de santé.** Les systèmes déployés selon une diligence raisonnable rigoureuse du fournisseur, avec une certification de sécurité indépendante, un traitement local des données lorsque cela est possible et une surveillance active des comportements anormaux sont nettement plus sûrs que ceux déployés sans ces contrôles, quelle que soit la capacité clinique qu'ils offrent.

### **Quels sont les risques de l'AI dans le domaine de la santé ?**

**Les risques couvrent des dimensions cliniques, de confidentialité et opérationnelles, notamment l'amplification des erreurs de diagnostic à grande échelle, le biais algorithmique à l'encontre des populations de patient·es sous-représentées, l'exposition réglementaire due à un déploiement non conforme, les violations de la confidentialité dues à une gestion inadéquate des fournisseurs et une dépendance excessive aux sorties de l'AI sans vérification clinique suffisante.** La gestion de ces risques nécessite une gouvernance qui traite l'AI comme un outil clinique soumis aux mêmes normes de preuve et de responsabilité que celles appliquées à d'autres technologies cliniques.
