# Plateforme de skills

Les skills sont le mecanisme d'extensibilite principal de Triggerfish. Une skill
est un dossier contenant un fichier `SKILL.md` -- des instructions et metadonnees
qui donnent a l'agent de nouvelles capacites sans necessite d'ecrire un plugin ou
de construire du code personnalise.

Les skills sont la facon dont l'agent apprend a faire de nouvelles choses :
consulter votre calendrier, preparer des briefings matinaux, trier les issues
GitHub, rediger des resumes hebdomadaires. Elles peuvent etre installees depuis
un marketplace, ecrites a la main ou creees par l'agent lui-meme.

## Qu'est-ce qu'une skill ?

Une skill est un dossier avec un fichier `SKILL.md` a sa racine. Le fichier
contient un frontmatter YAML (metadonnees) et un corps markdown (instructions
pour l'agent). Des fichiers de support optionnels -- scripts, modeles,
configuration -- peuvent cohabiter.

```
morning-briefing/
  SKILL.md
  briefing.ts        # Code de support optionnel
  template.md        # Modele optionnel
```

Le frontmatter du `SKILL.md` declare ce que fait la skill, ce dont elle a besoin
et quelles contraintes de securite s'appliquent :

```yaml
---
name: morning-briefing
description: Prepare a daily morning briefing with calendar, email, and weather
version: 1.0.0
category: productivity
tags:
  - calendar
  - email
  - daily
triggers:
  - cron: "0 7 * * *"
metadata:
  triggerfish:
    classification_ceiling: INTERNAL
    requires_tools:
      - browser
      - exec
    network_domains:
      - api.openweathermap.org
      - www.googleapis.com
---

## Instructions

Lorsque declenche (quotidiennement a 7h) ou invoque par l'utilisateur :

1. Recuperer les evenements du calendrier du jour depuis Google Calendar
2. Resumer les emails non lus des 12 dernieres heures
3. Obtenir les previsions meteo pour la localisation de l'utilisateur
4. Compiler un briefing concis et le livrer au canal configure

Formater le briefing avec des sections pour Calendrier, Email et Meteo.
Le garder scannable -- des puces, pas des paragraphes.
```

### Champs du frontmatter

| Champ                                         | Requis | Description                                                                |
| --------------------------------------------- | :----: | -------------------------------------------------------------------------- |
| `name`                                        |  Oui   | Identifiant unique de la skill                                             |
| `description`                                 |  Oui   | Description lisible de ce que fait la skill                                |
| `version`                                     |  Oui   | Version semantique                                                         |
| `category`                                    |  Non   | Categorie de regroupement (productivity, development, communication, etc.) |
| `tags`                                        |  Non   | Tags recherchables pour la decouverte                                      |
| `triggers`                                    |  Non   | Regles d'invocation automatique (plannings cron, motifs d'evenements)      |
| `metadata.triggerfish.classification_ceiling` |  Non   | Niveau de taint maximum que cette skill peut atteindre (defaut : `PUBLIC`) |
| `metadata.triggerfish.requires_tools`         |  Non   | Outils dont la skill depend (browser, exec, etc.)                          |
| `metadata.triggerfish.network_domains`        |  Non   | Points de terminaison reseau autorises pour la skill                       |

## Types de skills

Triggerfish prend en charge trois types de skills, avec un ordre de priorite
clair en cas de conflit de noms.

### Skills fournies

Livrees avec Triggerfish dans le repertoire `skills/bundled/`. Maintenues par le
projet. Toujours disponibles.

Triggerfish inclut dix skills fournies qui rendent l'agent autonome des le
premier jour :

| Skill                     | Description                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tdd**                   | Methodologie de developpement dirige par les tests pour Deno 2.x. Cycle red-green-refactor, motifs `Deno.test()`, utilisation de `@std/assert`, tests de type Result, helpers de test. |
| **mastering-typescript**  | Motifs TypeScript pour Deno et Triggerfish. Mode strict, `Result<T, E>`, types brandes, fonctions factory, interfaces immuables, barrels `mod.ts`.                  |
| **skill-builder**         | Comment creer de nouvelles skills. Format SKILL.md, champs du frontmatter, plafonds de classification, workflow d'auto-creation, scan de securite.                   |
| **integration-builder**   | Comment construire des integrations Triggerfish. Les six modeles : adaptateurs de canal, fournisseurs LLM, serveurs MCP, fournisseurs de stockage, outils exec et plugins. |
| **git-branch-management** | Workflow de branche Git pour le developpement. Branches de fonctionnalite, commits atomiques, creation de PR via CLI `gh`, suivi de PR, boucle de retour de revue via webhooks, merge et nettoyage. |
| **deep-research**         | Methodologie de recherche multi-etapes. Evaluation des sources, recherches paralleles, synthese et formatage des citations.                                          |
| **pdf**                   | Traitement de documents PDF. Extraction de texte, resume et extraction de donnees structurees depuis des fichiers PDF.                                                |
| **triggerfish**           | Auto-connaissance des mecanismes internes de Triggerfish. Architecture, configuration, depannage et motifs de developpement.                                         |
| **triggers**              | Creation de comportements proactifs. Ecriture de fichiers TRIGGER.md efficaces, motifs de surveillance et regles d'escalade.                                         |

Ce sont les skills d'amorcage -- l'agent les utilise pour s'etendre lui-meme. Le
skill-builder enseigne a l'agent comment creer de nouvelles skills, et
l'integration-builder lui enseigne comment construire de nouveaux adaptateurs et
fournisseurs.

Consultez [Construire des skills](/fr-FR/integrations/building-skills) pour un
guide pratique sur la creation des votres.

### Skills gerees

Installees depuis **The Reef** (le marketplace communautaire de skills).
Telechargees et stockees dans `~/.triggerfish/skills/`.

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### Skills d'espace de travail

Creees par l'utilisateur ou creees par l'agent dans
l'[environnement d'execution](./exec-environment). Stockees dans l'espace de
travail de l'agent a `~/.triggerfish/workspace/<agent-id>/skills/`.

Les skills d'espace de travail ont la priorite la plus elevee. Si vous creez une
skill avec le meme nom qu'une skill fournie ou geree, votre version a la
priorite.

```
Priorite :  Espace de travail  >  Geree  >  Fournie
```

::: tip Cet ordre de priorite signifie que vous pouvez toujours remplacer une
skill fournie ou du marketplace par votre propre version. Vos personnalisations ne
sont jamais ecrasees par les mises a jour. :::

## Decouverte et chargement des skills

Lorsque l'agent demarre ou lorsque les skills changent, Triggerfish lance un
processus de decouverte des skills :

1. **Scanner** -- Trouve toutes les skills installees dans les repertoires
   fournis, geres et d'espace de travail
2. **Chargeur** -- Lit le frontmatter du SKILL.md et valide les metadonnees
3. **Resolveur** -- Resout les conflits de noms en utilisant l'ordre de priorite
4. **Enregistrement** -- Rend les skills disponibles a l'agent avec leurs
   capacites et contraintes declarees

Les skills avec des `triggers` dans leur frontmatter sont automatiquement
connectees au planificateur. Les skills avec `requires_tools` sont verifiees par
rapport aux outils disponibles de l'agent -- si un outil requis n'est pas
disponible, la skill est signalee mais pas bloquee.

## Auto-creation par l'agent

Un facteur differentiant cle : l'agent peut ecrire ses propres skills. Lorsqu'on
lui demande de faire quelque chose qu'il ne sait pas faire, l'agent peut utiliser
l'[environnement d'execution](./exec-environment) pour creer un `SKILL.md` et
du code de support, puis l'empaqueter comme skill d'espace de travail.

### Flux d'auto-creation

```
1. Vous :  "J'ai besoin que tu verifies mes taches Notion chaque matin"
2. Agent : Cree la skill dans ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/
           Ecrit SKILL.md avec metadonnees et instructions
           Ecrit le code de support (notion-tasks.ts)
           Teste le code dans l'environnement d'execution
3. Agent : Marque la skill comme PENDING_APPROVAL
4. Vous :  Recevez une notification : "Nouvelle skill creee : notion-tasks. Examiner et approuver ?"
5. Vous :  Approuvez la skill
6. Agent : Connecte la skill a un cron job pour execution quotidienne
```

::: warning SECURITE Les skills creees par l'agent necessitent toujours
l'approbation du proprietaire avant de devenir actives. L'agent ne peut pas
auto-approuver ses propres skills. Cela empeche l'agent de creer des capacites
qui contournent votre supervision. :::

### Controles d'entreprise

Dans les deploiements d'entreprise, des controles supplementaires s'appliquent
aux skills auto-creees :

- Les skills creees par l'agent necessitent toujours l'approbation du
  proprietaire ou de l'administrateur
- Les skills ne peuvent pas declarer un plafond de classification superieur a
  l'habilitation de l'utilisateur
- Les declarations de points de terminaison reseau sont auditees
- Toutes les skills auto-creees sont journalisees pour l'examen de conformite

## The Reef <ComingSoon :inline="true" />

The Reef est le marketplace communautaire de skills de Triggerfish -- un registre
ou vous pouvez decouvrir, installer, publier et partager des skills.

| Fonctionnalite        | Description                                                       |
| --------------------- | ----------------------------------------------------------------- |
| Recherche et navigation | Trouver des skills par categorie, tag ou popularite             |
| Installation en une commande | `triggerfish skill install <nom>`                          |
| Publication           | Partager vos skills avec la communaute                            |
| Scan de securite      | Scan automatise des motifs malveillants avant la mise en ligne    |
| Versionnement         | Les skills sont versionnees avec gestion des mises a jour         |
| Avis et notes         | Retours de la communaute sur la qualite des skills                |

### Commandes CLI

```bash
# Rechercher des skills
triggerfish skill search "calendar"

# Installer une skill depuis The Reef
triggerfish skill install google-cal

# Lister les skills installees
triggerfish skill list

# Mettre a jour toutes les skills gerees
triggerfish skill update --all

# Publier une skill sur The Reef
triggerfish skill publish

# Supprimer une skill
triggerfish skill remove google-cal
```

### Securite

Les skills installees depuis The Reef passent par le meme cycle de vie que toute
autre integration :

1. Telechargees dans le repertoire des skills gerees
2. Scannees pour les motifs malveillants (injection de code, acces reseau non
   autorise, etc.)
3. Entrent dans l'etat `UNTRUSTED` jusqu'a ce que vous les classifiiez
4. Classifiees et activees par le proprietaire ou l'administrateur

::: info The Reef scanne toutes les skills publiees pour les motifs malveillants
connus avant leur mise en ligne. Cependant, vous devriez toujours examiner les
skills avant de les classifier, en particulier les skills qui declarent un acces
reseau ou necessitent des outils puissants comme `exec` ou `browser`. :::

## Resume de la securite des skills

- Les skills declarent leurs exigences de securite a l'avance (plafond de
  classification, outils, domaines reseau)
- L'acces aux outils est controle par la politique -- une skill qui
  `requires_tools: [browser]` ne fonctionnera pas si l'acces au navigateur est
  bloque par la politique
- Les domaines reseau sont appliques -- une skill ne peut pas acceder a des points
  de terminaison qu'elle n'a pas declares
- Les skills creees par l'agent necessitent l'approbation explicite du
  proprietaire/administrateur
- Toutes les invocations de skills passent par les hooks de politique et sont
  entierement auditees
