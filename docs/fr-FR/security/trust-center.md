---
title: Centre de confiance
description: Contrôles de sécurité, posture de conformité et transparence architecturale pour Triggerfish.
---

# Centre de confiance

Triggerfish applique la sécurité dans du code déterministe sous la couche LLM -- pas dans des prompts que le modèle pourrait ignorer. Chaque décision de politique est prise par du code qui ne peut être influencé par l'injection de prompt, l'ingénierie sociale ou le mauvais comportement du modèle. Consultez la page complète [Conception axée sécurité](/fr-FR/security/) pour l'explication technique détaillée.

## Contrôles de sécurité

Ces contrôles sont actifs dans la version actuelle. Chacun est appliqué dans le code, testé en CI et auditable dans le dépôt open source.

| Contrôle                                | Statut                           | Description                                                                                                                                             |
| --------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application de politique sous le LLM    | <StatusBadge status="active" />  | Huit hooks déterministes interceptent chaque action avant et après le traitement LLM. Le modèle ne peut pas contourner, modifier ou influencer les décisions de sécurité. |
| Système de classification des données   | <StatusBadge status="active" />  | Hiérarchie à quatre niveaux (PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED) avec application obligatoire du no-write-down.                                  |
| Suivi du taint de session               | <StatusBadge status="active" />  | Chaque session suit le plus haut niveau de classification des données consultées. Le taint ne fait que s'élever, jamais diminuer.                        |
| Journalisation d'audit immuable         | <StatusBadge status="active" />  | Toutes les décisions de politique sont journalisées avec le contexte complet. La journalisation d'audit ne peut être désactivée par aucun composant du système. |
| Isolation des secrets                   | <StatusBadge status="active" />  | Identifiants stockés dans le trousseau de clés du système d'exploitation ou le vault. Jamais dans les fichiers de configuration, le stockage, les logs ou le contexte LLM. |
| Sandboxing des plugins                  | <StatusBadge status="active" />  | [Extensions](../integrations/plugins) |
| Analyse des dépendances                 | <StatusBadge status="active" />  | Analyse automatique des vulnérabilités via GitHub Dependabot. Les PR sont ouvertes automatiquement pour les CVE en amont.                                |
| Code source ouvert                      | <StatusBadge status="active" />  | L'architecture de sécurité complète est sous licence Apache 2.0 et auditable publiquement.                                                               |
| Déploiement sur site                    | <StatusBadge status="active" />  | S'exécute entièrement sur votre infrastructure. Aucune dépendance cloud, aucune télémétrie, aucun traitement de données externe.                        |
| Chiffrement                             | <StatusBadge status="active" />  | TLS pour toutes les données en transit. Chiffrement au niveau du système d'exploitation au repos. Intégration vault entreprise disponible.               |
| Programme de divulgation responsable    | <StatusBadge status="active" />  | Processus documenté de signalement des vulnérabilités avec des délais de réponse définis. Voir la [politique de divulgation](/fr-FR/security/responsible-disclosure). |
| Image conteneur durcie                  | <StatusBadge status="planned" /> | Images Docker sur base Google Distroless avec quasi-zéro CVE. Analyse automatisée Trivy en CI.                                                           |

## Défense en profondeur -- 13 couches indépendantes

Aucune couche n'est suffisante seule. Si une couche est compromise, les couches restantes continuent à protéger le système.

| Couche | Nom                              | Application                                                |
| ------ | -------------------------------- | ---------------------------------------------------------- |
| 01     | Authentification des canaux      | Identité vérifiée par code à l'établissement de session    |
| 02     | Accès aux données tenant compte des permissions | Permissions du système source, pas d'identifiants système |
| 03     | Suivi du taint de session        | Automatique, obligatoire, escalade uniquement              |
| 04     | Lignage des données              | Chaîne de provenance complète pour chaque élément de données |
| 05     | Hooks d'application de politique | Déterministes, non contournables, journalisés              |
| 06     | MCP Gateway                      | Permissions par outil, classification du serveur           |
| 07     | Sandbox de plugin                | [Extensions](../integrations/plugins) |
| 08     | Isolation des secrets            | Trousseau de clés du système d'exploitation ou vault, sous la couche LLM |
| 09     | Sandbox des outils de système de fichiers | Prison de chemin, classification des chemins, E/S limitées au taint |
| 10     | Identité et délégation d'agent   | Chaînes de délégation cryptographiques                     |
| 11     | Journalisation d'audit           | Ne peut être désactivée                                    |
| 12     | Prévention SSRF                  | Liste de blocage IP + vérifications de résolution DNS      |
| 13     | Contrôle de classification de la mémoire | Écriture à son propre niveau, lecture vers le bas uniquement |

Consultez la documentation complète de l'architecture [Défense en profondeur](/fr-FR/architecture/defense-in-depth).

## Pourquoi l'application sous le LLM est importante

::: info La plupart des plateformes d'agent IA appliquent la sécurité via des prompts système -- des instructions au LLM disant « ne partagez pas de données sensibles ». Les attaques d'injection de prompt peuvent outrepasser ces instructions.

Triggerfish adopte une approche différente : le LLM a **zéro autorité** sur les décisions de sécurité. Toute l'application se fait dans du code déterministe sous la couche LLM. Il n'y a aucun chemin de la sortie du LLM vers la configuration de sécurité. :::

## Feuille de route de conformité

Triggerfish est en pré-certification. Notre posture de sécurité est architecturale et vérifiable dans le code source dès aujourd'hui. Les certifications formelles sont prévues dans la feuille de route.

| Certification                     | Statut                           | Notes                                                                  |
| --------------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| SOC 2 Type I                      | <StatusBadge status="planned" /> | Critères de services de confiance Sécurité + Confidentialité           |
| SOC 2 Type II                     | <StatusBadge status="planned" /> | Efficacité soutenue des contrôles sur la période d'observation         |
| HIPAA BAA                         | <StatusBadge status="planned" /> | Accord de partenaire commercial pour les clients du secteur de la santé|
| ISO 27001                         | <StatusBadge status="planned" /> | Système de management de la sécurité de l'information                  |
| Test d'intrusion par un tiers     | <StatusBadge status="planned" /> | Évaluation de sécurité indépendante                                    |
| Conformité RGPD                   | <StatusBadge status="planned" /> | Architecture auto-hébergée avec rétention et suppression configurables |

## Une note sur la confiance

::: tip Le cœur de sécurité est open source sous Apache 2.0. Vous pouvez lire chaque ligne de code d'application de politique, exécuter la suite de tests et vérifier les affirmations vous-même. Les certifications sont prévues dans la feuille de route. :::

## Auditer le code source

Le code source complet de Triggerfish est disponible sur
[github.com/greghavens/triggerfish](https://github.com/greghavens/triggerfish) --
sous licence Apache 2.0.

## Signaler une vulnérabilité

Si vous découvrez une vulnérabilité de sécurité, veuillez la signaler via notre
[Politique de divulgation responsable](/fr-FR/security/responsible-disclosure). N'ouvrez pas d'issues publiques sur GitHub pour les vulnérabilités de sécurité.
