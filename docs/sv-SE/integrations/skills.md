# Kunskapsplattformen

Kunskaper är Triggerfish primära utökningsmekanism. En kunskap är en mapp som innehåller en `SKILL.md`-fil — instruktioner och metadata som ger agenten nya funktioner utan att du behöver skriva ett plugin eller bygga anpassad kod.

Kunskaper är hur agenten lär sig göra nya saker: kontrollera din kalender, förbereda morgonbriefingar, prioritera GitHub-ärenden, skriva veckosammanfattningar. De kan installeras från en marknadsplats, skrivas för hand eller författas av agenten själv.

## Vad är en kunskap?

En kunskap är en mapp med en `SKILL.md`-fil i roten. Filen innehåller YAML-frontmatter (metadata) och markdown-kropp (instruktioner för agenten). Valfria stödfiler — skript, mallar, konfiguration — kan leva bredvid den.

```
morning-briefing/
  SKILL.md
  briefing.ts        # Valfri stödkod
  template.md        # Valfri mall
```

Frontmattern i `SKILL.md` deklarerar vad kunskapen gör, vad den behöver och vilka säkerhetsbegränsningar som gäller:

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

### Frontmatterfält

| Fält                                          | Obligatorisk | Beskrivning                                                          |
| --------------------------------------------- | :----------: | -------------------------------------------------------------------- |
| `name`                                        |     Ja       | Unikt kunskapsidentifierare                                          |
| `description`                                 |     Ja       | Mänskligt läsbar beskrivning av vad kunskapen gör                   |
| `version`                                     |     Ja       | Semantisk version                                                    |
| `category`                                    |     Nej      | Grupperingskategori (productivity, development, communication osv.)  |
| `tags`                                        |     Nej      | Sökbara taggar för identifiering                                     |
| `triggers`                                    |     Nej      | Automatiska anropsregler (cron-scheman, händelsemönster)            |
| `metadata.triggerfish.classification_ceiling` |     Nej      | Maximal taint-nivå denna kunskap kan nå (standard: `PUBLIC`)        |
| `metadata.triggerfish.requires_tools`         |     Nej      | Verktyg som kunskapen är beroende av (browser, exec osv.)           |
| `metadata.triggerfish.network_domains`        |     Nej      | Tillåtna nätverksslutpunkter för kunskapen                          |

## Kunskapstyper

Triggerfish stöder tre typer av kunskaper, med en tydlig prioritetsordning när namn konfliktar.

### Inbyggda kunskaper

Medföljer Triggerfish i katalogen `skills/bundled/`. Underhålls av projektet. Alltid tillgängliga.

Triggerfish inkluderar tio inbyggda kunskaper som gör agenten självförsörjande från dag ett:

| Kunskap                   | Beskrivning                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **tdd**                   | Test-Driven Development-metodik för Deno 2.x. Red-green-refactor-cykel, `Deno.test()`-mönster, `@std/assert`-användning, Result-typstest, testhjälpare.                 |
| **mastering-typescript**  | TypeScript-mönster för Deno och Triggerfish. Strikt läge, `Result<T, E>`, branded types, fabriksfunktioner, oföränderliga gränssnitt, `mod.ts`-barrels.                  |
| **skill-builder**         | Hur man skapar nya kunskaper. SKILL.md-format, frontmatterfält, klassificeringstak, självförfattandearbetsflöde, säkerhetsskanning.                                      |
| **integration-builder**   | Hur man bygger Triggerfish-integrationer. Alla sex mönster: kanaladaptrar, LLM-leverantörer, MCP-servrar, lagringsleverantörer, exec-verktyg och plugins.               |
| **git-branch-management** | Git-grenarbetsflöde för utveckling. Funktionsgrenar, atomära commits, PR-skapande via `gh` CLI, PR-spårning, granskningsfeedbackslinga via webhooks, merge och cleanup. |
| **deep-research**         | Flerstegig forskningsmetodik. Källutvärdering, parallella sökningar, syntes och citatsformatering.                                                                       |
| **pdf**                   | PDF-dokumentbearbetning. Textextraktion, sammanfattning och strukturerad datautvinning från PDF-filer.                                                                   |
| **triggerfish**           | Självkännedom om Triggerfish-internals. Arkitektur, konfiguration, felsökning och utvecklingsmönster.                                                                    |
| **triggers**              | Proaktivt beteendeförfattande. Skriva effektiva TRIGGER.md-filer, övervakningmönster och eskaleringsregler.                                                             |

Dessa är bootstrap-kunskaperna — agenten använder dem för att utöka sig själv. Skill-builder lär agenten hur man skapar nya kunskaper, och integration-builder lär den hur man bygger nya adaptrar och leverantörer.

Se [Bygga kunskaper](/sv-SE/integrations/building-skills) för en praktisk guide till att skapa egna.

### Hanterade kunskaper

Installeras från **Revet** (community-kunskapsmarknadsplatsen). Laddas ner och lagras i `~/.triggerfish/skills/`.

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### Arbetsytakunskaper

Skapas av användaren eller författas av agenten i [exec-miljön](./exec-environment). Lagras i agentens arbetsyta på `~/.triggerfish/workspace/<agent-id>/skills/`.

Arbetsytakunskaper har högst prioritet. Om du skapar en kunskap med samma namn som en inbyggd eller hanterad kunskap har din version företräde.

```
Prioritet:  Arbetsyta  >  Hanterad  >  Inbyggd
```

::: tip Denna prioritetsordning innebär att du alltid kan åsidosätta en inbyggd eller marknadsplatsskunskap med din egen version. Dina anpassningar skrivs aldrig över av uppdateringar. :::

## Kunskapsdiscovery och laddning

När agenten startar eller när kunskaper ändras kör Triggerfish en discovery-process:

1. **Scanner** — Hittar alla installerade kunskaper i inbyggda, hanterade och arbetsytakataloger
2. **Laddare** — Läser SKILL.md-frontmatter och validerar metadata
3. **Resolver** — Löser upp namnkonflikter med prioritetsordningen
4. **Registrering** — Gör kunskaper tillgängliga för agenten med deras deklarerade funktioner och begränsningar

Kunskaper med `triggers` i deras frontmatter kopplas automatiskt in i schemaläggaren. Kunskaper med `requires_tools` kontrolleras mot agentens tillgängliga verktyg — om ett nödvändigt verktyg inte är tillgängligt flaggas kunskapen men blockeras inte.

## Agentens självförfattande

En viktig skillnad: agenten kan skriva sina egna kunskaper. När den ombeds göra något den inte vet hur man gör kan agenten använda [exec-miljön](./exec-environment) för att skapa en `SKILL.md` och stödkod, och sedan paketera det som en arbetsytakunskap.

### Självförfattandeflöde

```
1. Du:    "Jag behöver att du kontrollerar min Notion för nya uppgifter varje morgon"
2. Agent: Skapar kunskap på ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/
          Skriver SKILL.md med metadata och instruktioner
          Skriver stödkod (notion-tasks.ts)
          Testar koden i exec-miljön
3. Agent: Markerar kunskapen som PENDING_APPROVAL
4. Du:    Tar emot notifikation: "Ny kunskap skapad: notion-tasks. Granska och godkänn?"
5. Du:    Godkänner kunskapen
6. Agent: Kopplar kunskapen in i ett cron-jobb för daglig körning
```

::: warning SÄKERHET Agentförfattade kunskaper kräver alltid ägarens godkännande innan de aktiveras. Agenten kan inte godkänna sina egna kunskaper. Detta förhindrar agenten från att skapa funktioner som kringgår din tillsyn. :::

### Företagskontroller

I företagsdistributioner gäller ytterligare kontroller för självförfattade kunskaper:

- Agentförfattade kunskaper kräver alltid ägar- eller administratörsgodkännande
- Kunskaper kan inte deklarera ett klassificeringstak över användarens behörighet
- Nätverksslutpunktsdeklarationer granskas
- Alla självförfattade kunskaper loggas för efterlevnadsgranskning

## Revet <ComingSoon :inline="true" />

Revet är Triggerfishs community-kunskapsmarknadsplats — ett register där du kan hitta, installera, publicera och dela kunskaper.

| Funktion            | Beskrivning                                                   |
| ------------------- | ------------------------------------------------------------- |
| Sök och bläddra     | Hitta kunskaper efter kategori, tagg eller popularitet        |
| Enkommandoinstallation | `triggerfish skill install <namn>`                         |
| Publicera           | Dela dina kunskaper med communityn                            |
| Säkerhetsskanning   | Automatisk skanning för skadliga mönster innan listning       |
| Versionshantering   | Kunskaper versioneras med uppdateringshantering               |
| Recensioner och betyg | Community-feedback om kunskapskvalitet                      |

### CLI-kommandon

```bash
# Sök efter kunskaper
triggerfish skill search "calendar"

# Installera en kunskap från Revet
triggerfish skill install google-cal

# Lista installerade kunskaper
triggerfish skill list

# Uppdatera alla hanterade kunskaper
triggerfish skill update --all

# Publicera en kunskap till Revet
triggerfish skill publish

# Ta bort en kunskap
triggerfish skill remove google-cal
```

### Säkerhet

Kunskaper installerade från Revet genomgår samma livscykel som alla andra integrationer:

1. Laddas ner till katalogen för hanterade kunskaper
2. Skannas för skadliga mönster (kodinjektion, obehörig nätverksåtkomst osv.)
3. Går in i tillståndet `UNTRUSTED` tills du klassificerar dem
4. Klassificeras och aktiveras av ägaren eller administratören

::: info Revet skannar alla publicerade kunskaper efter kända skadliga mönster innan de listas. Du bör dock fortfarande granska kunskaper innan du klassificerar dem, särskilt kunskaper som deklarerar nätverksåtkomst eller kräver kraftfulla verktyg som `exec` eller `browser`. :::

## Kunskapssäkerhetssammanfattning

- Kunskaper deklarerar sina säkerhetskrav i förväg (klassificeringstak, verktyg, nätverksdomäner)
- Verktygstillgång styrs av policy — en kunskap som `requires_tools: [browser]` fungerar inte om webbläsaråtkomst är blockerad av policy
- Nätverksdomäner tillämpas — en kunskap kan inte komma åt slutpunkter den inte deklarerat
- Agentförfattade kunskaper kräver explicit ägar-/administratörsgodkännande
- Alla kunskapsanrop passerar genom policykrokar och granskas fullständigt
