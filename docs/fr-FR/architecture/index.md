# Vue d'ensemble de l'architecture

Triggerfish est une plateforme d'agent IA sécurisée et multicanal, fondée sur un
seul invariant :

::: warning SÉCURITÉ **La sécurité est déterministe et sous-jacente au LLM.** Chaque
décision de sécurité est prise par du code pur que le LLM ne peut ni contourner,
ni outrepasser, ni influencer. Le LLM n'a aucune autorité -- il demande des
actions ; la couche de politique décide. :::

Cette page fournit une vue d'ensemble du fonctionnement de Triggerfish. Chaque
composant majeur renvoie vers une page détaillée dédiée.

## Architecture du système

<img src="/diagrams/system-architecture.svg" alt="Architecture du système : les canaux passent par le Channel Router vers le Gateway, qui coordonne le Session Manager, le Policy Engine et la boucle de l'agent" style="max-width: 100%;" />

### Flux de données

Chaque message suit ce parcours à travers le système :

<img src="/diagrams/data-flow-9-steps.svg" alt="Flux de données : pipeline en 9 étapes depuis le message entrant jusqu'à la livraison sortante, en passant par les hooks de politique" style="max-width: 100%;" />

À chaque point d'application, la décision est déterministe -- la même entrée
produit toujours le même résultat. Il n'y a aucun appel LLM dans les hooks,
aucune composante aléatoire, et aucun moyen pour le LLM d'influencer le résultat.

## Composants majeurs

### Système de classification

Les données circulent à travers quatre niveaux ordonnés :
`RESTRICTED > CONFIDENTIAL > INTERNAL > PUBLIC`. La règle fondamentale est
**l'interdiction d'écriture descendante** (no write-down) : les données ne
peuvent circuler que vers un niveau de classification égal ou supérieur. Une
session `CONFIDENTIAL` ne peut pas envoyer de données vers un canal `PUBLIC`.
Aucune exception. Aucun contournement par le LLM.

[En savoir plus sur le système de classification.](./classification)

### Policy Engine et hooks

Huit hooks d'application déterministes interceptent chaque action aux points
critiques du flux de données. Les hooks sont des fonctions pures : synchrones,
journalisées et infalsifiables. Le policy engine prend en charge les règles
fixes (jamais configurables), les règles ajustables par l'administrateur et les
échappatoires déclaratives en YAML pour l'entreprise.

[En savoir plus sur le Policy Engine.](./policy-engine)

### Sessions et taint

Chaque conversation est une session avec un suivi de taint indépendant. Lorsqu'une
session accède à des données classifiées, son taint s'élève à ce niveau et ne
peut jamais diminuer au sein de la session. Une réinitialisation complète efface
le taint ET l'historique de conversation. Chaque élément de données porte des
métadonnées de provenance via un système de suivi de lignage.

[En savoir plus sur les sessions et le taint.](./taint-and-sessions)

### Gateway

Le Gateway est le plan de contrôle central -- un service local persistant qui
gère les sessions, les canaux, les outils, les événements et les processus
d'agent via un point de terminaison WebSocket JSON-RPC. Il coordonne le service
de notifications, le planificateur cron, l'ingestion de webhooks et le routage
des canaux.

[En savoir plus sur le Gateway.](./gateway)

### Stockage

Toutes les données avec état transitent par une abstraction unifiée
`StorageProvider`. Des clés à espaces de noms (`sessions:`, `taint:`,
`lineage:`, `audit:`) séparent les préoccupations tout en permettant de changer
de backend sans toucher à la logique métier. Par défaut, SQLite WAL est utilisé
à `~/.triggerfish/data/triggerfish.db`.

[En savoir plus sur le stockage.](./storage)

### Défense en profondeur

La sécurité est répartie sur 13 mécanismes indépendants, de l'authentification
des canaux et l'accès aux données tenant compte des permissions, en passant par
le taint de session, les hooks de politique, le sandboxing des plugins, le sandboxing
des outils de système de fichiers et la journalisation d'audit. Aucune couche n'est
suffisante seule ; ensemble, elles forment une défense qui se dégrade
gracieusement même si une couche est compromise.

[En savoir plus sur la défense en profondeur.](./defense-in-depth)

## Principes de conception

| Principe                            | Signification                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Application déterministe**        | Les hooks de politique utilisent des fonctions pures. Pas d'appels LLM, pas d'aléatoire. Même entrée, même décision, toujours.      |
| **Propagation du taint**            | Toutes les données portent des métadonnées de classification. Le taint de session ne peut que s'élever, jamais diminuer.             |
| **Pas d'écriture descendante**      | Les données ne peuvent jamais circuler vers un niveau de classification inférieur. Jamais.                                          |
| **Tout auditer**                    | Toutes les décisions de politique sont journalisées avec le contexte complet : horodatage, type de hook, ID de session, entrée, résultat, règles évaluées. |
| **Hooks infalsifiables**            | Le LLM ne peut ni contourner, ni modifier, ni influencer les décisions des hooks. Les hooks s'exécutent dans du code sous la couche LLM. |
| **Isolation des sessions**          | Chaque session suit son taint indépendamment. Les sessions d'arrière-plan démarrent avec un taint PUBLIC. Les espaces de travail des agents sont entièrement isolés. |
| **Abstraction du stockage**         | Aucun module ne crée son propre stockage. Toute la persistance passe par `StorageProvider`.                                         |

## Stack technologique

| Composant              | Technologie                                                                       |
| ---------------------- | --------------------------------------------------------------------------------- |
| Runtime                | Deno 2.x (TypeScript strict mode)                                                 |
| Tests                  | Deno built-in test runner                                                         |
| Canaux                 | Baileys (WhatsApp), grammY (Telegram), Bolt (Slack), discord.js (Discord)         |
| Automatisation navigateur | puppeteer-core (CDP)                                                           |
| Voix                   | Whisper (STT local), ElevenLabs/OpenAI (TTS)                                     |
| Stockage               | SQLite WAL (par défaut), backends entreprise (Postgres, S3)                       |
| Secrets                | Trousseau de clés du système (personnel), intégration vault (entreprise)          |

::: info Triggerfish ne nécessite aucun outil de build externe, aucun Docker et
aucune dépendance cloud. Il s'exécute localement, traite les données localement
et donne à l'utilisateur la pleine souveraineté sur ses données. :::
