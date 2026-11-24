# Conception axée sécurité

Triggerfish repose sur un principe unique : **le LLM n'a aucune autorité**. Il
demande des actions ; la couche de politique décide. Chaque décision de sécurité
est prise par du code déterministe que l'IA ne peut ni contourner, ni outrepasser,
ni influencer.

Cette page explique pourquoi Triggerfish adopte cette approche, en quoi elle
diffère des plateformes d'agent IA traditionnelles et où trouver les détails sur
chaque composant du modèle de sécurité.

## Pourquoi la sécurité doit être sous le LLM

Les grands modèles de langage peuvent être victimes d'injection de prompt. Une
entrée soigneusement conçue -- qu'il s'agisse d'un message externe malveillant,
d'un document empoisonné ou d'une réponse d'outil compromise -- peut amener un
LLM à ignorer ses instructions et à entreprendre des actions qu'il était censé
ne pas faire. Ce n'est pas un risque théorique. C'est un problème bien documenté
et non résolu dans l'industrie de l'IA.

Si votre modèle de sécurité dépend du fait que le LLM suive les règles, une seule
injection réussie peut contourner chaque protection que vous avez construite.

Triggerfish résout cela en déplaçant toute l'application de sécurité vers une
couche de code qui se situe **sous** le LLM. L'IA ne voit jamais les décisions
de sécurité. Elle n'évalue jamais si une action doit être autorisée. Elle demande
simplement des actions, et la couche d'application de politique -- exécutée en
tant que code pur et déterministe -- décide si ces actions se poursuivent.

<img src="/diagrams/enforcement-layers.svg" alt="Couches d'application : le LLM n'a aucune autorité, la couche de politique prend toutes les décisions de manière déterministe, seules les actions autorisées atteignent l'exécution" style="max-width: 100%;" />

::: warning SÉCURITÉ La couche LLM n'a aucun mécanisme pour outrepasser, ignorer
ou influencer la couche d'application de politique. Il n'existe aucune logique
« parser la sortie du LLM pour des commandes de contournement ». La séparation
est architecturale, pas comportementale. :::

## L'invariant fondamental

Chaque décision de conception dans Triggerfish découle d'un seul invariant :

> **Même entrée produit toujours la même décision de sécurité. Pas d'aléatoire,
> pas d'appels LLM, pas de discrétion.**

Cela signifie que le comportement de sécurité est :

- **Auditable** -- vous pouvez rejouer n'importe quelle décision et obtenir le même résultat
- **Testable** -- le code déterministe peut être couvert par des tests automatisés
- **Vérifiable** -- le policy engine est open source (licence Apache 2.0) et tout le monde peut l'inspecter

## Principes de sécurité

| Principe                      | Signification                                                                                                                                                   | Page détaillée                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Classification des données** | Toutes les données portent un niveau de sensibilité (RESTRICTED, CONFIDENTIAL, INTERNAL, PUBLIC). La classification est attribuée par le code à l'entrée des données. | [Architecture : Classification](/fr-FR/architecture/classification) |
| **No Write-Down**             | Les données ne peuvent circuler que vers des canaux et destinataires de classification égale ou supérieure. Les données CONFIDENTIAL ne peuvent atteindre un canal PUBLIC. Sans exception. | [Règle du No Write-Down](./no-write-down)                          |
| **Taint de session**          | Quand une session accède à des données d'un certain niveau, la session entière est marquée à ce niveau. Le taint ne peut que s'élever, jamais diminuer.        | [Architecture : Taint](/fr-FR/architecture/taint-and-sessions)      |
| **Hooks déterministes**       | Huit hooks d'application s'exécutent aux points critiques de chaque flux de données. Chaque hook est synchrone, journalisé et infalsifiable.                    | [Architecture : Policy Engine](/fr-FR/architecture/policy-engine)   |
| **Identité dans le code**     | L'identité de l'utilisateur est déterminée par le code lors de l'établissement de session, pas par le LLM interprétant le contenu du message.                  | [Identité et authentification](./identity)                          |
| **Délégation d'agent**        | Les appels d'agent à agent sont gouvernés par des certificats cryptographiques, des plafonds de classification et des limites de profondeur.                    | [Délégation d'agent](./agent-delegation)                            |
| **Isolation des secrets**     | Les identifiants sont stockés dans les trousseaux de clés ou les vaults, jamais dans les fichiers de configuration. Les plugins ne peuvent pas accéder aux identifiants système. | [Gestion des secrets](./secrets)                                    |
| **Tout auditer**              | Chaque décision de politique est journalisée avec le contexte complet : horodatage, type de hook, ID de session, entrée, résultat et règles évaluées.          | [Audit et conformité](./audit-logging)                              |

## Agents IA traditionnels vs. Triggerfish

La plupart des plateformes d'agent IA s'appuient sur le LLM pour appliquer la
sécurité. Le prompt système dit « ne partagez pas de données sensibles » et
l'agent est censé se conformer. Cette approche présente des faiblesses
fondamentales.

| Aspect                             | Agent IA traditionnel                         | Triggerfish                                                          |
| ---------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| **Application de la sécurité**     | Instructions du prompt système au LLM         | Code déterministe sous le LLM                                        |
| **Défense contre l'injection de prompt** | Espérer que le LLM résiste              | Le LLM n'a aucune autorité pour commencer                           |
| **Contrôle du flux de données**    | Le LLM décide ce qui est sûr à partager       | Étiquettes de classification + règle no-write-down dans le code     |
| **Vérification d'identité**        | Le LLM interprète « je suis l'admin »         | Le code vérifie l'identité cryptographique du canal                  |
| **Piste d'audit**                  | Journaux de conversation du LLM               | Journaux structurés de décisions de politique avec contexte complet  |
| **Accès aux identifiants**         | Compte de service système pour tous            | Identifiants délégués de l'utilisateur ; permissions du système source héritées |
| **Testabilité**                    | Floue -- dépend de la formulation du prompt    | Déterministe -- même entrée, même décision, à chaque fois           |
| **Ouvert à la vérification**       | Généralement propriétaire                      | Licence Apache 2.0, entièrement auditable                           |

::: tip Triggerfish ne prétend pas que les LLMs sont peu fiables. Il affirme que les LLMs sont la mauvaise couche pour l'application de la sécurité. Un LLM bien prompté suivra ses instructions la plupart du temps. Mais « la plupart du temps » n'est pas une garantie de sécurité. Triggerfish fournit une garantie : la couche de politique est du code, et le code fait ce qu'on lui dit, à chaque fois. :::

## Défense en profondeur

Triggerfish implémente treize couches de défense. Aucune couche n'est suffisante seule ; ensemble, elles forment une frontière de sécurité :

1. **Authentification des canaux** -- identité vérifiée par code lors de l'établissement de session
2. **Accès aux données tenant compte des permissions** -- permissions du système source, pas d'identifiants système
3. **Suivi du taint de session** -- automatique, obligatoire, escalade uniquement
4. **Lignage des données** -- chaîne de provenance complète pour chaque élément de données
5. **Hooks d'application de politique** -- déterministes, non contournables, journalisés
6. **MCP Gateway** -- accès sécurisé aux outils externes avec permissions par outil
7. **[Sandbox de plugin](../integrations/plugins)**
8. **Isolation des secrets** -- trousseau de clés ou vault, jamais de fichiers de configuration
9. **Sandbox des outils de système de fichiers** -- prison de chemin, classification des chemins, permissions E/S limitées au taint au niveau système
10. **Identité de l'agent** -- chaînes de délégation cryptographiques
11. **Journalisation d'audit** -- toutes les décisions enregistrées, sans exception
12. **Prévention SSRF** -- liste de blocage IP + vérifications de résolution DNS sur toutes les requêtes HTTP sortantes
13. **Contrôle de classification de la mémoire** -- écritures forcées au niveau du taint de session, lectures filtrées par `canFlowTo`

## Prochaines étapes

| Page                                                          | Description                                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Guide de classification](/fr-FR/guide/classification-guide)  | Guide pratique pour choisir le bon niveau pour les canaux, serveurs MCP et intégrations          |
| [Règle du No Write-Down](./no-write-down)                     | La règle fondamentale de flux de données et comment elle est appliquée                          |
| [Identité et authentification](./identity)                    | Authentification des canaux et vérification de l'identité du propriétaire                       |
| [Délégation d'agent](./agent-delegation)                      | Identité d'agent à agent, certificats et chaînes de délégation                                  |
| [Gestion des secrets](./secrets)                              | Comment Triggerfish gère les identifiants selon les tiers                                        |
| [Audit et conformité](./audit-logging)                        | Structure de la piste d'audit, traçage et exports de conformité                                 |
