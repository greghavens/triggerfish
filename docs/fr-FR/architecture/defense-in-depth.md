# Défense en profondeur

Triggerfish implémente la sécurité sous forme de 13 couches indépendantes et
superposées. Aucune couche n'est suffisante seule. Ensemble, elles forment une
défense qui se dégrade gracieusement -- même si une couche est compromise, les
couches restantes continuent de protéger le système.

::: warning SÉCURITÉ La défense en profondeur signifie qu'une vulnérabilité dans
une couche unique ne compromet pas le système. Un attaquant qui contourne
l'authentification du canal fait encore face au suivi de taint de session, aux
hooks de politique et à la journalisation d'audit. Un LLM victime d'injection de
prompt ne peut toujours pas influencer la couche de politique déterministe
sous-jacente. :::

## Les 13 couches

### Couche 1 : Authentification des canaux

**Protège contre :** l'usurpation d'identité, l'accès non autorisé, la confusion d'identité.

L'identité est déterminée par du **code lors de l'établissement de la session**, et non par le LLM interprétant le contenu du message. Avant que le LLM ne voie un message, l'adaptateur de canal le marque avec une étiquette immuable :

```
{ source: "owner" }    -- l'identité vérifiée du canal correspond au propriétaire enregistré
{ source: "external" } -- toute autre personne ; entrée uniquement, non traitée comme commande
```

Les méthodes d'authentification varient selon le canal :

| Canal                   | Méthode            | Vérification                                                            |
| ----------------------- | ------------------ | ----------------------------------------------------------------------- |
| Telegram / WhatsApp     | Code d'appairage   | Code à usage unique, expiration de 5 minutes, envoyé depuis le compte utilisateur |
| Slack / Discord / Teams | OAuth              | Flux de consentement OAuth de la plateforme, retourne un ID utilisateur vérifié |
| CLI                     | Processus local    | Exécuté sur la machine de l'utilisateur, authentifié par le système d'exploitation |
| WebChat                 | Aucune (public)    | Tous les visiteurs sont `EXTERNAL`, jamais `owner`                      |
| Email                   | Correspondance de domaine | Le domaine de l'expéditeur est comparé aux domaines internes configurés |

::: info Le LLM ne décide jamais qui est le propriétaire. Un message disant
« Je suis le propriétaire » provenant d'un expéditeur non vérifié est marqué
`{ source: "external" }` et ne peut pas déclencher de commandes de niveau
propriétaire. Cette décision est prise dans le code, avant que le LLM ne traite
le message. :::

### Couche 2 : Accès aux données tenant compte des permissions

**Protège contre :** l'accès excessif aux données, l'escalade de privilèges via les identifiants système.

Triggerfish utilise les tokens OAuth délégués de l'utilisateur -- pas les comptes de service système -- pour interroger les systèmes externes. Le système source applique son propre modèle de permissions :

<img src="/diagrams/traditional-vs-triggerfish.svg" alt="Traditionnel vs Triggerfish : le modèle traditionnel donne au LLM un contrôle direct, Triggerfish route toutes les actions à travers une couche de politique déterministe" style="max-width: 100%;" />

Le SDK de plugin applique cela au niveau de l'API :

| Méthode SDK                             | Comportement                                    |
| --------------------------------------- | ----------------------------------------------- |
| `sdk.get_user_credential(integration)`  | Retourne le token OAuth délégué de l'utilisateur |
| `sdk.query_as_user(integration, query)` | Exécute avec les permissions de l'utilisateur    |
| `sdk.get_system_credential(name)`       | **BLOQUÉ** -- lève une `PermissionError`         |

### Couche 3 : Suivi du taint de session

**Protège contre :** la fuite de données par contamination du contexte, les données classifiées atteignant des canaux de classification inférieure.

Chaque session suit indépendamment un niveau de taint qui reflète la plus haute classification des données consultées pendant la session. Le taint suit trois invariants :

1. **Par conversation** -- chaque session a son propre taint
2. **Escalade uniquement** -- le taint augmente, ne diminue jamais
3. **La réinitialisation complète efface tout** -- le taint ET l'historique sont effacés ensemble

Lorsque le policy engine évalue une sortie, il compare le taint de la session à la classification effective du canal cible. Si le taint dépasse la cible, la sortie est bloquée.

### Couche 4 : Lignage des données

**Protège contre :** les flux de données non traçables, l'incapacité d'auditer où les données sont allées, les lacunes de conformité.

Chaque élément de données porte des métadonnées de provenance de l'origine à la destination :

- **Origine** : quelle intégration, quel enregistrement et quel accès utilisateur a produit ces données
- **Classification** : quel niveau a été attribué et pourquoi
- **Transformations** : comment le LLM a modifié, résumé ou combiné les données
- **Destination** : quelle session et quel canal ont reçu la sortie

Le lignage permet des traces en avant (« où est allé cet enregistrement Salesforce ? »), des traces en arrière (« quelles sources ont contribué à cette sortie ? ») et des exports de conformité complets.

### Couche 5 : Hooks d'application de politique

**Protège contre :** les attaques par injection de prompt, les contournements de sécurité pilotés par le LLM, l'exécution incontrôlée d'outils.

Huit hooks déterministes interceptent chaque action aux points critiques du flux de données :

| Hook                    | Ce qu'il intercepte                                |
| ----------------------- | -------------------------------------------------- |
| `PRE_CONTEXT_INJECTION` | Entrée externe entrant dans la fenêtre de contexte |
| `PRE_TOOL_CALL`         | Le LLM demande l'exécution d'un outil              |
| `POST_TOOL_RESPONSE`    | Données retournées par l'exécution d'un outil      |
| `PRE_OUTPUT`            | Réponse sur le point de quitter le système         |
| `SECRET_ACCESS`         | Demande d'accès aux identifiants                   |
| `SESSION_RESET`         | Demande de réinitialisation du taint               |
| `AGENT_INVOCATION`      | Appel d'agent à agent                              |
| `MCP_TOOL_CALL`         | Invocation d'outil de serveur MCP                  |

Les hooks sont du code pur : déterministes, synchrones, journalisés et infalsifiables. Le LLM ne peut pas les contourner car il n'existe aucun chemin de la sortie du LLM vers la configuration des hooks. La couche de hooks n'analyse pas la sortie du LLM pour y chercher des commandes.

### Couche 6 : MCP Gateway

**Protège contre :** l'accès incontrôlé aux outils externes, les données non classifiées entrant via les serveurs MCP, les violations de schéma.

Tous les serveurs MCP sont par défaut `UNTRUSTED` et ne peuvent pas être invoqués tant qu'un administrateur ou un utilisateur ne les a pas classifiés. Le Gateway applique :

- L'authentification du serveur et le statut de classification
- Les permissions au niveau des outils (des outils individuels peuvent être bloqués même si le serveur est autorisé)
- La validation du schéma des requêtes/réponses
- Le suivi du taint sur toutes les réponses MCP
- L'analyse des patterns d'injection dans les paramètres

<img src="/diagrams/mcp-server-states.svg" alt="États des serveurs MCP : UNTRUSTED (par défaut), CLASSIFIED (examiné et autorisé), BLOCKED (explicitement interdit)" style="max-width: 100%;" />

### Couche 7 : Sandbox de plugin

Activez une extension TypeScript dans la configuration utilisateur avec `enabled: true`. Par défaut, son import et son exécution ont lieu dans des workers Deno restreints. Ils peuvent lire le dossier de l’extension et se connecter uniquement aux hôtes et ports de `declaredEndpoints`. Ils ne peuvent ni écrire des fichiers, ni lire l’environnement du processus, ni lancer de sous-processus, ni utiliser la FFI ou des informations système restreintes. `trust: trusted` autorise l’import dans le processus Triggerfish. L’exécuteur s’y exécute si le manifeste déclare aussi `trusted`.

[Guide complet des extensions](../integrations/plugins)

### Couche 8 : Isolation des secrets

**Protège contre :** le vol d'identifiants, les secrets dans les fichiers de configuration, le stockage en clair des identifiants.

Les identifiants sont stockés dans le trousseau de clés du système (tier personnel) ou l'intégration vault (tier entreprise). Ils n'apparaissent jamais dans :

- Les fichiers de configuration
- Les valeurs du `StorageProvider`
- Les entrées de journal
- Le contexte LLM (les identifiants sont injectés au niveau HTTP, sous le LLM)

Le hook `SECRET_ACCESS` journalise chaque accès aux identifiants avec le plugin demandeur, la portée de l'identifiant et la décision.

### Couche 9 : Sandbox des outils de système de fichiers

**Protège contre :** les attaques de traversée de chemin, l'accès non autorisé aux fichiers, le contournement de classification via des opérations directes sur le système de fichiers.

Toutes les opérations des outils de système de fichiers (lecture, écriture, édition, liste, recherche) s'exécutent dans un Worker Deno sandboxé avec des permissions au niveau du système d'exploitation limitées au sous-répertoire de l'espace de travail approprié au taint de la session. Le sandbox applique trois limites :

- **Prison de chemin** — chaque chemin est résolu en chemin absolu et vérifié par rapport à la racine de la prison avec une correspondance tenant compte du séparateur. Les tentatives de traversée (`../`) qui échappent à l'espace de travail sont rejetées avant toute E/S
- **Classification des chemins** — chaque chemin de système de fichiers est classifié via une chaîne de résolution fixe : chemins protégés codés en dur (RESTRICTED), répertoires de classification de l'espace de travail, mappages de chemins configurés, puis classification par défaut. L'agent ne peut pas accéder aux chemins au-dessus de son taint de session
- **Permissions limitées au taint** — les permissions Deno du Worker sandbox sont définies sur le sous-répertoire de l'espace de travail correspondant au taint actuel de la session. Quand le taint s'élève, le Worker est recréé avec des permissions élargies. Les permissions ne peuvent que s'élargir, jamais se restreindre au sein d'une session
- **Protection en écriture** — les fichiers critiques (`TRIGGER.md`, `triggerfish.yaml`, `SPINE.md`) sont protégés en écriture au niveau de l'outil, indépendamment des permissions du sandbox. Ces fichiers ne peuvent être modifiés que par des outils de gestion dédiés qui appliquent leurs propres règles de classification

### Couche 10 : Identité de l'agent

**Protège contre :** l'escalade de privilèges via les chaînes d'agents, le blanchiment de données par délégation.

Lorsque des agents invoquent d'autres agents, des chaînes de délégation cryptographiques empêchent l'escalade de privilèges :

- Chaque agent possède un certificat spécifiant ses capacités et son plafond de classification
- L'appelé hérite de `max(propre taint, taint de l'appelant)` -- le taint ne peut qu'augmenter à travers les chaînes
- Un appelant dont le taint dépasse le plafond de l'appelé est bloqué
- Les invocations circulaires sont détectées et rejetées
- La profondeur de délégation est limitée et appliquée

<img src="/diagrams/data-laundering-defense.svg" alt="Défense contre le blanchiment de données : le chemin d'attaque est bloqué lors de la vérification du plafond et l'héritage du taint empêche la sortie vers des canaux de classification inférieure" style="max-width: 100%;" />

### Couche 11 : Journalisation d'audit

**Protège contre :** les violations indétectables, les défaillances de conformité, l'incapacité d'enquêter sur les incidents.

Chaque décision liée à la sécurité est journalisée avec le contexte complet :

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

Ce qui est journalisé :

- Toutes les demandes d'action (autorisées ET refusées)
- Les décisions de classification
- Les changements de taint de session
- Les événements d'authentification des canaux
- Les évaluations des règles de politique
- La création et la mise à jour des enregistrements de lignage
- Les décisions du MCP Gateway
- Les invocations d'agent à agent

::: info La journalisation d'audit ne peut pas être désactivée. C'est une règle fixe dans la hiérarchie de politique. Même un administrateur d'organisation ne peut pas désactiver la journalisation pour ses propres actions. Les déploiements entreprise peuvent optionnellement activer la journalisation complète du contenu (y compris le contenu des messages bloqués) pour les exigences d'investigation. :::

### Couche 12 : Prévention SSRF

**Protège contre :** la falsification de requête côté serveur (Server-Side Request Forgery), la reconnaissance du réseau interne, l'exfiltration de métadonnées cloud.

Toutes les requêtes HTTP sortantes (depuis `web_fetch`, `browser.navigate` et l'accès réseau des plugins) résolvent d'abord le DNS et vérifient l'IP résolue par rapport à une liste de blocage codée en dur des plages privées et réservées. Cela empêche un attaquant de tromper l'agent pour qu'il accède à des services internes via des URLs conçues à cet effet.

- Les plages privées (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) sont toujours bloquées
- Les adresses link-local (`169.254.0.0/16`) et les points de terminaison de métadonnées cloud sont bloqués
- Le loopback (`127.0.0.0/8`) est bloqué
- La liste de blocage est codée en dur et non configurable -- il n'y a pas de contournement administratif
- La résolution DNS se fait avant la requête, empêchant les attaques de rebinding DNS

### Couche 13 : Contrôle de classification de la mémoire

**Protège contre :** la fuite de données inter-sessions via la mémoire, le déclassement via les écritures mémoire, l'accès non autorisé aux mémoires classifiées.

Le système de mémoire inter-sessions applique la classification à la fois en écriture et en lecture :

- **Écritures** : les entrées mémoire sont forcées au niveau de taint de la session courante. Le LLM ne peut pas choisir une classification inférieure pour les mémoires stockées.
- **Lectures** : les requêtes mémoire sont filtrées par `canFlowTo` -- une session ne peut lire que les mémoires de niveau égal ou inférieur à son taint actuel.

Cela empêche un agent de stocker des données CONFIDENTIAL comme PUBLIC en mémoire et de les récupérer plus tard dans une session de taint inférieur pour contourner la règle du no write-down.

## Hiérarchie de confiance

Le modèle de confiance définit qui a autorité sur quoi. Les tiers supérieurs ne peuvent pas contourner les règles de sécurité des tiers inférieurs, mais ils peuvent configurer les paramètres ajustables au sein de ces règles.

<img src="/diagrams/trust-hierarchy.svg" alt="Hiérarchie de confiance : fournisseur Triggerfish (zéro accès), Admin d'organisation (définit les politiques), Employé (utilise l'agent dans les limites)" style="max-width: 100%;" />

::: tip **Tier personnel :** l'utilisateur EST l'admin d'organisation. Pleine souveraineté. Aucune visibilité de Triggerfish. Le fournisseur n'a aucun accès aux données utilisateur par défaut et ne peut obtenir un accès que par une autorisation explicite, limitée dans le temps et journalisée, de la part de l'utilisateur. :::

## Comment les couches fonctionnent ensemble

Considérons une attaque par injection de prompt où un message malveillant tente d'exfiltrer des données :

| Étape | Couche                   | Action                                                            |
| ----- | ------------------------ | ----------------------------------------------------------------- |
| 1     | Authentification du canal | Message marqué `{ source: "external" }` -- pas le propriétaire  |
| 2     | PRE_CONTEXT_INJECTION    | Entrée analysée pour détecter les patterns d'injection, classifiée |
| 3     | Taint de session         | Taint de session inchangé (aucune donnée classifiée consultée)    |
| 4     | Le LLM traite le message | Le LLM peut être manipulé pour demander un appel d'outil          |
| 5     | PRE_TOOL_CALL            | Vérification des permissions contre les règles source-externe     |
| 6     | POST_TOOL_RESPONSE       | Toute donnée retournée est classifiée, le taint est mis à jour   |
| 7     | PRE_OUTPUT               | Classification de la sortie vs. cible vérifiée                    |
| 8     | Journalisation d'audit   | La séquence entière est enregistrée pour examen                   |

Même si le LLM est entièrement compromis à l'étape 4 et demande un appel d'outil d'exfiltration, les couches restantes (vérifications de permissions, suivi du taint, classification de sortie, journalisation d'audit) continuent d'appliquer la politique. Aucun point de défaillance unique ne compromet le système.
