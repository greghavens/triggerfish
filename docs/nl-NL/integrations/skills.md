# Skills-platform

Skills zijn het primaire uitbreidingsmechanisme van Triggerfish. Een skill is een map met een `SKILL.md`-bestand — instructies en metadata die de agent nieuwe mogelijkheden geven zonder dat u een plugin hoeft te schrijven of aangepaste code hoeft te bouwen.

Skills zijn hoe de agent nieuwe dingen leert doen: uw agenda controleren, ochtendoverzichten voorbereiden, GitHub-issues triage, wekelijkse samenvattingen opstellen. Ze kunnen worden geïnstalleerd vanuit een marktplaats, handmatig geschreven, of door de agent zelf worden geschreven.

## Wat is een skill?

Een skill is een map met een `SKILL.md`-bestand aan de root. Het bestand bevat YAML-frontmatter (metadata) en een markdown-body (instructies voor de agent). Optionele ondersteunende bestanden — scripts, sjablonen, configuratie — kunnen ernaast staan.

```
morning-briefing/
  SKILL.md
  briefing.ts        # Optional supporting code
  template.md        # Optional template
```

De `SKILL.md`-frontmatter declareert wat de skill doet, wat hij nodig heeft en welke beveiligingsbeperkingen van toepassing zijn:

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

When triggered (daily at 7 AM) or invoked by the user:

1. Fetch today's calendar events from Google Calendar
2. Summarize unread emails from the last 12 hours
3. Get the weather forecast for the user's location
4. Compile a concise briefing and deliver it to the configured channel

Format the briefing with sections for Calendar, Email, and Weather.
Keep it scannable -- bullet points, not paragraphs.
```

### Frontmatter-velden

| Veld                                          | Vereist | Beschrijving                                                          |
| --------------------------------------------- | :-----: | --------------------------------------------------------------------- |
| `name`                                        |   Ja    | Unieke skill-identificatie                                            |
| `description`                                 |   Ja    | Leesbare beschrijving van wat de skill doet                           |
| `version`                                     |   Ja    | Semantische versie                                                    |
| `category`                                    |   Nee   | Groeperingscategorie (productiviteit, ontwikkeling, communicatie, enz.) |
| `tags`                                        |   Nee   | Doorzoekbare tags voor ontdekking                                     |
| `triggers`                                    |   Nee   | Automatische aanroepregels (cron-planningen, gebeurtenispatronen)     |
| `metadata.triggerfish.classification_ceiling` |   Nee   | Maximaal taint-niveau dat deze skill kan bereiken (standaard: `PUBLIC`) |
| `metadata.triggerfish.requires_tools`         |   Nee   | Tools waarvan de skill afhankelijk is (browser, exec, enz.)           |
| `metadata.triggerfish.network_domains`        |   Nee   | Toegestane netwerkeindpunten voor de skill                            |

## Skill-typen

Triggerfish ondersteunt drie typen skills, met een duidelijke prioriteitsvolgorde wanneer namen conflicteren.

### Gebundelde skills

Worden geleverd met Triggerfish in de map `skills/bundled/`. Onderhouden door het project. Altijd beschikbaar.

Triggerfish bevat tien gebundelde skills die de agent van dag één zelfvoorzienend maken:

| Skill                     | Beschrijving                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tdd**                   | Test-Driven Development-methodologie voor Deno 2.x. Rood-groen-refactorcyclus, `Deno.test()`-patronen, `@std/assert`-gebruik, Result-type testen, testhulpers.                  |
| **mastering-typescript**  | TypeScript-patronen voor Deno en Triggerfish. Strikte modus, `Result<T, E>`, merktypen, fabriekspatronen, onveranderlijke interfaces, `mod.ts`-barrels.                         |
| **skill-builder**         | Hoe nieuwe skills te schrijven. SKILL.md-formaat, frontmatter-velden, classificatieplafonds, zelfbewerking-workflow, beveiligingsscanning.                                       |
| **integration-builder**   | Hoe Triggerfish-integraties te bouwen. Alle zes patronen: kanaaladapters, LLM-providers, MCP-servers, opslagproviders, exec-tools en plugins.                                    |
| **git-branch-management** | Git-branchworkflow voor ontwikkeling. Feature-branches, atomaire commits, PR maken via `gh` CLI, PR-tracking, reviewfeedbacklus via webhooks, samenvoegen en opschonen.         |
| **deep-research**         | Meerstapsmethodologie voor onderzoek. Bronevaluatie, parallelle zoekopdrachten, synthese en citatopmaak.                                                                        |
| **pdf**                   | PDF-documentverwerking. Tekstextractie, samenvatting en gestructureerde gegevensextractie uit PDF-bestanden.                                                                     |
| **triggerfish**           | Zelfkennis over Triggerfish-internals. Architectuur, configuratie, probleemoplossing en ontwikkelingspatronen.                                                                   |
| **triggers**              | Proactieve gedragsbewerking. Effectieve TRIGGER.md-bestanden schrijven, monitoringpatronen en escalatieregels.                                                                   |

Dit zijn de bootstrapskills — de agent gebruikt ze om zichzelf uit te breiden. De skill-builder leert de agent hoe nieuwe skills te maken, en de integration-builder leert hem hoe nieuwe adapters en providers te bouwen.

Zie [Skills bouwen](/nl-NL/integrations/building-skills) voor een praktische handleiding voor het maken van uw eigen skills.

### Beheerde skills

Geïnstalleerd vanuit **The Reef** (de communityskill-marktplaats). Gedownload en opgeslagen in `~/.triggerfish/skills/`.

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### Werkruimteskills

Aangemaakt door de gebruiker of geschreven door de agent in de [uitvoeringsomgeving](./exec-environment). Opgeslagen in de werkruimtemap van de agent op `~/.triggerfish/workspace/<agent-id>/skills/`.

Werkruimteskills hebben de hoogste prioriteit. Als u een skill maakt met dezelfde naam als een gebundelde of beheerde skill, heeft uw versie voorrang.

```
Prioriteit:  Werkruimte  >  Beheerd  >  Gebundeld
```

::: tip Deze prioriteitsvolgorde betekent dat u altijd een gebundelde of marktplaatsskill kunt overschrijven met uw eigen versie. Uw aanpassingen worden nooit overschreven door updates. :::

## Skill-ontdekking en -laden

Wanneer de agent start of wanneer skills veranderen, voert Triggerfish een skill-ontdekkingsproces uit:

1. **Scanner** — Zoekt alle geïnstalleerde skills in gebundelde, beheerde en werkruimtemappen
2. **Lader** — Leest SKILL.md-frontmatter en valideert metadata
3. **Resolver** — Lost naamconflicten op met de prioriteitsvolgorde
4. **Registratie** — Maakt skills beschikbaar voor de agent met hun gedeclareerde mogelijkheden en beperkingen

Skills met `triggers` in hun frontmatter worden automatisch verbonden met de planner. Skills met `requires_tools` worden gecontroleerd aan de hand van de beschikbare tools van de agent — als een vereiste tool niet beschikbaar is, wordt de skill gemarkeerd maar niet geblokkeerd.

## Zelfbewerking door de agent

Een belangrijk onderscheidend kenmerk: de agent kan zijn eigen skills schrijven. Wanneer gevraagd iets te doen wat hij niet weet hoe, kan de agent de [uitvoeringsomgeving](./exec-environment) gebruiken om een `SKILL.md` en ondersteunende code te maken en deze vervolgens te verpakken als een werkruimteskill.

### Zelfbewerkingsflow

```
1. U:     "I need you to check my Notion for new tasks every morning"
2. Agent: Creates skill at ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/
          Writes SKILL.md with metadata and instructions
          Writes supporting code (notion-tasks.ts)
          Tests the code in the exec environment
3. Agent: Marks the skill as PENDING_APPROVAL
4. U:     Receive notification: "New skill created: notion-tasks. Review and approve?"
5. U:     Approve the skill
6. Agent: Wires the skill into a cron job for daily execution
```

::: warning BEVEILIGING Door agents geschreven skills vereisen altijd goedkeuring van de eigenaar voordat ze actief worden. De agent kan zijn eigen skills niet zelf goedkeuren. Dit voorkomt dat de agent mogelijkheden creëert die uw toezicht omzeilen. :::

### Enterprise-besturingselementen

In enterprise-implementaties gelden aanvullende besturingselementen voor zelf geschreven skills:

- Door agents geschreven skills vereisen altijd goedkeuring van eigenaar of beheerder
- Skills kunnen geen classificatieplafond declareren boven de machtigingsdrempel van de gebruiker
- Declaraties van netwerkeindpunten worden geauditeerd
- Alle door agents geschreven skills worden geregistreerd voor nalevingscontrole

## The Reef <ComingSoon :inline="true" />

The Reef is de communityskill-marktplaats van Triggerfish — een register waar u skills kunt ontdekken, installeren, publiceren en delen.

| Functie              | Beschrijving                                                   |
| -------------------- | -------------------------------------------------------------- |
| Zoeken en bladeren   | Skills vinden op categorie, tag of populariteit                |
| Installatie met één opdracht | `triggerfish skill install <name>`                   |
| Publiceren           | Uw skills delen met de community                               |
| Beveiligingsscanning | Geautomatiseerde scanning op kwaadaardige patronen voor vermelding |
| Versiebeheer         | Skills worden beheerd met updatebeheer                         |
| Reviews en beoordelingen | Communityfeedback over skillkwaliteit                      |

### CLI-opdrachten

```bash
# Search for skills
triggerfish skill search "calendar"

# Install a skill from The Reef
triggerfish skill install google-cal

# List installed skills
triggerfish skill list

# Update all managed skills
triggerfish skill update --all

# Publish a skill to The Reef
triggerfish skill publish

# Remove a skill
triggerfish skill remove google-cal
```

### Beveiliging

Skills geïnstalleerd vanuit The Reef doorlopen dezelfde levenscyclus als elke andere integratie:

1. Gedownload naar de beheerde skillsmap
2. Gescand op kwaadaardige patronen (code-injectie, ongeoorloofde netwerktoegang, enz.)
3. Voeren de `UNTRUSTED`-status in totdat u ze classificeert
4. Geclassificeerd en geactiveerd door de eigenaar of beheerder

::: info The Reef scant alle gepubliceerde skills op bekende kwaadaardige patronen voordat ze worden vermeld. U moet echter skills altijd beoordelen voordat u ze classificeert, met name skills die netwerktoegang declareren of krachtige tools zoals `exec` of `browser` vereisen. :::

## Samenvatting skillbeveiliging

- Skills declareren van tevoren hun beveiligingsvereisten (classificatieplafond, tools, netwerkdomeinen)
- Toegang tot tools is geblokkeerd door beleid — een skill die `requires_tools: [browser]` vermeldt, werkt niet als browsertoegang door beleid is geblokkeerd
- Netwerkdomeinen worden gehandhaafd — een skill heeft geen toegang tot eindpunten die ze niet heeft gedeclareerd
- Door agents geschreven skills vereisen expliciete goedkeuring van eigenaar/beheerder
- Alle skillaanroepen doorlopen beleidshooks en worden volledig geauditeerd
