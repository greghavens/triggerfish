# Ferdighetsplattform

Ferdigheter er Triggerfish sin primære utvidelsesmekanisme. En ferdighet er en mappe som inneholder en `SKILL.md`-fil — instruksjoner og metadata som gir agenten nye evner uten at du trenger å skrive en plugin eller bygge egendefinert kode.

Ferdigheter er hvordan agenten lærer å gjøre nye ting: sjekke kalenderen din, forberede morgenbriefinger, triagere GitHub-problemer, utarbeide ukentlige sammendrag. De kan installeres fra en markedsplass, skrives for hånd, eller forfattes av agenten selv.

## Hva er en ferdighet?

En ferdighet er en mappe med en `SKILL.md`-fil ved roten. Filen inneholder YAML-frontmatter (metadata) og markdown-kropp (instruksjoner for agenten). Valgfrie støttefiler — skript, maler, konfigurasjon — kan leve ved siden av den.

```
morning-briefing/
  SKILL.md
  briefing.ts        # Valgfri støttekode
  template.md        # Valgfri mal
```

`SKILL.md`-frontmatteren deklarerer hva ferdigheten gjør, hva den trenger og hvilke sikkerhetsbegrensninger som gjelder:

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

### Frontmatter-felter

| Felt                                          | Påkrevd | Beskrivelse                                                               |
| --------------------------------------------- | :-----: | ------------------------------------------------------------------------- |
| `name`                                        |   Ja    | Unik ferdighetsidentifikator                                              |
| `description`                                 |   Ja    | Menneskelig lesbar beskrivelse av hva ferdigheten gjør                    |
| `version`                                     |   Ja    | Semantisk versjon                                                         |
| `category`                                    |   Nei   | Grupperingskategori (produktivitet, utvikling, kommunikasjon osv.)        |
| `tags`                                        |   Nei   | Søkbare tagger for oppdagelse                                             |
| `triggers`                                    |   Nei   | Automatiske invokasjonregler (cron-tidsplaner, hendelsesmønstre)          |
| `metadata.triggerfish.classification_ceiling` |   Nei   | Maksimalt taint-nivå denne ferdigheten kan nå (standard: `PUBLIC`)       |
| `metadata.triggerfish.requires_tools`         |   Nei   | Verktøy ferdigheten avhenger av (browser, exec osv.)                     |
| `metadata.triggerfish.network_domains`        |   Nei   | Tillatte nettverksendepunkter for ferdigheten                             |

## Ferdighetstyper

Triggerfish støtter tre typer ferdigheter, med en klar prioriteringsrekkefølge når navn er i konflikt.

### Bundlede ferdigheter

Leveres med Triggerfish i `skills/bundled/`-mappen. Vedlikeholdt av prosjektet. Alltid tilgjengelig.

Triggerfish inkluderer ti bundlede ferdigheter som gjør agenten selvforsynt fra dag én:

| Ferdighet                 | Beskrivelse                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tdd**                   | Test-Driven Development-metodologi for Deno 2.x. Rød-grønn-refaktor-syklus, `Deno.test()`-mønstre, `@std/assert`-bruk, Result-typetest, testhjelpeere.                  |
| **mastering-typescript**  | TypeScript-mønstre for Deno og Triggerfish. Streng modus, `Result<T, E>`, brandede typer, fabrikkfunksjoner, uforanderlige grensesnitt, `mod.ts`-tønner.                 |
| **skill-builder**         | Hvordan forfatte nye ferdigheter. SKILL.md-format, frontmatter-felter, klassifiseringstak, selvforfattingsarbeidsflyt, sikkerhetsskanning.                                |
| **integration-builder**   | Hvordan bygge Triggerfish-integrasjoner. Alle seks mønstre: kanaladaptere, LLM-leverandører, MCP-servere, lagringsleverandører, exec-verktøy og plugins.                 |
| **git-branch-management** | Git-grenearbeidsflyt for utvikling. Funksjongrener, atomære commits, PR-opprettelse via `gh` CLI, PR-sporing, gjennomgangsresponsloop via webhooks, sammenslåing og opprydning. |
| **deep-research**         | Flertrinnsforskningsmotodologi. Kildevurdering, parallelle søk, syntese og sitatformatering.                                                                              |
| **pdf**                   | PDF-dokumentbehandling. Tekstutvinning, oppsummering og strukturert datauttrekking fra PDF-filer.                                                                         |
| **triggerfish**           | Selvkunnskap om Triggerfish-internaler. Arkitektur, konfigurasjon, feilsøking og utviklingsmønstre.                                                                       |
| **triggers**              | Proaktiv atferdsforfatting. Skrive effektive TRIGGER.md-filer, overvåkningsmønstre og eskalasjonsregler.                                                                  |

Se [Bygge ferdigheter](/nb-NO/integrations/building-skills) for en praktisk guide til å lage dine egne.

### Administrerte ferdigheter

Installert fra **The Reef** (fellesskapets ferdighetsmarkedsplass). Lastet ned og lagret i `~/.triggerfish/skills/`.

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### Arbeidsområdeferdigheter

Opprettet av brukeren eller forfattet av agenten i [exec-miljøet](./exec-environment). Lagret i agentens arbeidsområde på `~/.triggerfish/workspace/<agent-id>/skills/`.

Arbeidsområdeferdigheter tar høyest prioritet. Hvis du oppretter en ferdighet med samme navn som en bundlet eller administrert ferdighet, tar din versjon forrang.

```
Prioritet:  Arbeidsområde  >  Administrert  >  Bundlet
```

::: tip Denne prioriteringsrekkefølgen betyr at du alltid kan overstyre en bundlet eller markedsplassferdighet med din egen versjon. Tilpasningene dine overskrives aldri av oppdateringer. :::

## Ferdighetsoppdagelse og lasting

Når agenten starter eller når ferdigheter endres, kjører Triggerfish en ferdighetoppdagelsesprosess:

1. **Skanner** — Finner alle installerte ferdigheter på tvers av bundlede, administrerte og arbeidsområdemapper
2. **Laster** — Leser SKILL.md-frontmatter og validerer metadata
3. **Løser** — Løser navnekonflikter ved hjelp av prioriteringsrekkefølgen
4. **Registrering** — Gjør ferdigheter tilgjengelige for agenten med deklarerte evner og begrensninger

Ferdigheter med `triggers` i frontmatteren kobles automatisk til planleggeren. Ferdigheter med `requires_tools` sjekkes mot agentens tilgjengelige verktøy — hvis et nødvendig verktøy ikke er tilgjengelig, flagges ferdigheten men blokkeres ikke.

## Agent selvforfatning

En nøkkeldifferensiator: agenten kan skrive sine egne ferdigheter. Når den blir bedt om å gjøre noe den ikke vet hvordan den skal gjøre, kan agenten bruke [exec-miljøet](./exec-environment) til å lage en `SKILL.md` og støttekode, deretter pakke det som en arbeidsområdeferdighet.

### Selvforfattingsflyt

```
1. Du:    «Jeg trenger at du sjekker Notion for nye oppgaver hver morgen»
2. Agent: Oppretter ferdighet på ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/
          Skriver SKILL.md med metadata og instruksjoner
          Skriver støttekode (notion-tasks.ts)
          Tester koden i exec-miljøet
3. Agent: Markerer ferdigheten som PENDING_APPROVAL
4. Du:    Mottar varsel: «Ny ferdighet opprettet: notion-tasks. Gjennomgå og godkjenn?»
5. Du:    Godkjenner ferdigheten
6. Agent: Kobler ferdigheten inn i en cron-jobb for daglig utføring
```

::: warning SIKKERHET Agent-forfattede ferdigheter krever alltid eiergodkjenning før de blir aktive. Agenten kan ikke godkjenne egne ferdigheter. Dette forhindrer agenten fra å opprette evner som omgår ditt tilsyn. :::

## The Reef <ComingSoon :inline="true" />

The Reef er Triggerfish sin ferdighetsmarkedsplass for fellesskapet — et register der du kan oppdage, installere, publisere og dele ferdigheter.

| Funksjon              | Beskrivelse                                                       |
| --------------------- | ----------------------------------------------------------------- |
| Søk og bla            | Finn ferdigheter etter kategori, tag eller popularitet            |
| Enkommando-installasjon | `triggerfish skill install <navn>`                              |
| Publiser              | Del ferdighetene dine med fellesskapet                            |
| Sikkerhetsskanning    | Automatisk skanning for ondsinnede mønstre før oppføring          |
| Versjonering          | Ferdigheter er versjonert med oppdateringshåndtering              |
| Anmeldelser og vurderinger | Fellesskapets tilbakemelding om ferdighetskvalitet           |

### CLI-kommandoer

```bash
# Søk etter ferdigheter
triggerfish skill search "calendar"

# Installer en ferdighet fra The Reef
triggerfish skill install google-cal

# List installerte ferdigheter
triggerfish skill list

# Oppdater alle administrerte ferdigheter
triggerfish skill update --all

# Publiser en ferdighet til The Reef
triggerfish skill publish

# Fjern en ferdighet
triggerfish skill remove google-cal
```

## Sikkerhetsoversikt for ferdigheter

- Ferdigheter deklarerer sikkerhetskravene sine på forhånd (klassifiseringstak, verktøy, nettverksdomener)
- Verktøytilgang er gated av policy — en ferdighet som `requires_tools: [browser]` vil ikke fungere hvis nettlesertilgang er blokkert av policy
- Nettverksdomener håndheves — en ferdighet kan ikke aksessere endepunkter den ikke deklarerte
- Agent-forfattede ferdigheter krever eksplisitt eier/admin-godkjenning
- Alle ferdighetsinnvokasjonene passerer gjennom policy-hooks og er fullt reviderte
