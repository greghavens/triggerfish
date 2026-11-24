# Skills-Plattform

Skills sind Triggerfishs primaerer Erweiterungsmechanismus. Ein Skill ist ein Ordner mit einer `SKILL.md`-Datei -- Anweisungen und Metadaten, die dem Agenten neue Faehigkeiten verleihen, ohne dass Sie ein Plugin schreiben oder benutzerdefinierten Code erstellen muessen.

Skills sind die Art, wie der Agent lernt, neue Dinge zu tun: Ihren Kalender pruefen, Morgen-Briefings vorbereiten, GitHub-Issues triagieren, Wochen-Zusammenfassungen erstellen. Sie koennen von einem Marktplatz installiert, handgeschrieben oder vom Agenten selbst erstellt werden.

## Was ist ein Skill?

Ein Skill ist ein Ordner mit einer `SKILL.md`-Datei an seiner Wurzel. Die Datei enthaelt YAML-Frontmatter (Metadaten) und einen Markdown-Body (Anweisungen fuer den Agenten). Optionale unterstuetzende Dateien -- Skripte, Vorlagen, Konfiguration -- koennen daneben liegen.

```
morning-briefing/
  SKILL.md
  briefing.ts        # Optionaler unterstuetzender Code
  template.md        # Optionale Vorlage
```

Das `SKILL.md`-Frontmatter deklariert, was der Skill tut, was er benoetigt und welche Sicherheitsbeschraenkungen gelten:

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

### Frontmatter-Felder

| Feld                                          | Erforderlich | Beschreibung                                                       |
| --------------------------------------------- | :----------: | ------------------------------------------------------------------ |
| `name`                                        |     Ja       | Eindeutiger Skill-Bezeichner                                       |
| `description`                                 |     Ja       | Menschenlesbare Beschreibung, was der Skill tut                    |
| `version`                                     |     Ja       | Semantische Version                                                |
| `category`                                    |    Nein      | Gruppierungskategorie (productivity, development, communication usw.) |
| `tags`                                        |    Nein      | Durchsuchbare Tags fuer die Erkennung                              |
| `triggers`                                    |    Nein      | Automatische Aufrufregeln (Cron-Zeitplaene, Ereignismuster)        |
| `metadata.triggerfish.classification_ceiling` |    Nein      | Maximale Taint-Stufe, die dieser Skill erreichen darf (Standard: `PUBLIC`) |
| `metadata.triggerfish.requires_tools`         |    Nein      | Tools, von denen der Skill abhaengt (browser, exec usw.)           |
| `metadata.triggerfish.network_domains`        |    Nein      | Erlaubte Netzwerk-Endpunkte fuer den Skill                        |

## Skill-Typen

Triggerfish unterstuetzt drei Arten von Skills mit einer klaren Prioritaetsreihenfolge bei Namenskonflikten.

### Gebundelte Skills

Werden mit Triggerfish im `skills/bundled/`-Verzeichnis ausgeliefert. Vom Projekt gewartet. Immer verfuegbar.

Triggerfish enthaelt zehn gebundelte Skills, die den Agenten vom ersten Tag an eigenstaendig machen:

| Skill                     | Beschreibung                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tdd**                   | Test-Driven-Development-Methodik fuer Deno 2.x. Red-Green-Refactor-Zyklus, `Deno.test()`-Muster, `@std/assert`-Verwendung, Result-Typ-Tests, Test-Helfer.          |
| **mastering-typescript**  | TypeScript-Muster fuer Deno und Triggerfish. Strict Mode, `Result<T, E>`, Branded Types, Factory-Funktionen, unveraenderliche Interfaces, `mod.ts`-Barrels.         |
| **skill-builder**         | Skills erstellen. SKILL.md-Format, Frontmatter-Felder, Klassifizierungs-Obergrenzen, Selbsterstellungs-Workflow, Sicherheits-Scanning.                              |
| **integration-builder**   | Triggerfish-Integrationen erstellen. Alle sechs Muster: Channel-Adapter, LLM-Provider, MCP-Server, Storage-Provider, Exec-Tools und Plugins.                       |
| **git-branch-management** | Git-Branch-Workflow fuer Entwicklung. Feature-Branches, atomare Commits, PR-Erstellung ueber `gh` CLI, PR-Tracking, Review-Feedback-Schleife ueber Webhooks, Merge und Bereinigung. |
| **deep-research**         | Mehrstufige Forschungsmethodik. Quellenauswertung, parallele Suchen, Synthese und Zitierformatierung.                                                                |
| **pdf**                   | PDF-Dokumentenverarbeitung. Textextraktion, Zusammenfassung und strukturierte Datenextraktion aus PDF-Dateien.                                                       |
| **triggerfish**            | Selbstwissen ueber Triggerfish-Interna. Architektur, Konfiguration, Fehlerbehebung und Entwicklungsmuster.                                                          |
| **triggers**              | Proaktives Verhalten erstellen. Effektive TRIGGER.md-Dateien schreiben, Ueberwachungsmuster und Eskalationsregeln.                                                   |

Dies sind die Bootstrap-Skills -- der Agent verwendet sie, um sich selbst zu erweitern. Der Skill-Builder lehrt den Agenten, neue Skills zu erstellen, und der Integration-Builder lehrt ihn, neue Adapter und Provider zu erstellen.

Siehe [Skills erstellen](/de-DE/integrations/building-skills) fuer eine praktische Anleitung zur Erstellung eigener Skills.

### Verwaltete Skills

Von **The Reef** (dem Community-Skill-Marktplatz) installiert. Heruntergeladen und in `~/.triggerfish/skills/` gespeichert.

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### Workspace-Skills

Vom Benutzer erstellt oder vom Agenten in der [Exec-Umgebung](./exec-environment) verfasst. Im Workspace des Agenten unter `~/.triggerfish/workspace/<agent-id>/skills/` gespeichert.

Workspace-Skills haben die hoechste Prioritaet. Wenn Sie einen Skill mit demselben Namen wie ein gebundelter oder verwalteter Skill erstellen, hat Ihre Version Vorrang.

```
Prioritaet:  Workspace  >  Verwaltet  >  Gebundelt
```

::: tip Diese Prioritaetsreihenfolge bedeutet, dass Sie immer einen gebundelten oder Marktplatz-Skill mit Ihrer eigenen Version ueberschreiben koennen. Ihre Anpassungen werden nie durch Updates ueberschrieben. :::

## Skill-Erkennung und -Laden

Wenn der Agent startet oder sich Skills aendern, fuehrt Triggerfish einen Skill-Erkennungsprozess durch:

1. **Scanner** -- Findet alle installierten Skills in gebundelten, verwalteten und Workspace-Verzeichnissen
2. **Loader** -- Liest SKILL.md-Frontmatter und validiert Metadaten
3. **Resolver** -- Loest Namenskonflikte anhand der Prioritaetsreihenfolge auf
4. **Registrierung** -- Macht Skills dem Agenten mit ihren deklarierten Faehigkeiten und Beschraenkungen verfuegbar

Skills mit `triggers` in ihrem Frontmatter werden automatisch in den Scheduler verdrahtet. Skills mit `requires_tools` werden gegen die verfuegbaren Tools des Agenten geprueft -- wenn ein erforderliches Tool nicht verfuegbar ist, wird der Skill markiert, aber nicht blockiert.

## Agenten-Selbsterstellung

Ein wichtiges Unterscheidungsmerkmal: Der Agent kann seine eigenen Skills schreiben. Wenn er gebeten wird, etwas zu tun, das er nicht kann, kann der Agent die [Exec-Umgebung](./exec-environment) verwenden, um eine `SKILL.md` und unterstuetzenden Code zu erstellen und als Workspace-Skill zu verpacken.

### Selbsterstellungs-Ablauf

```
1. Sie:    "Ich moechte, dass du mein Notion taeglich auf neue Aufgaben pruefst"
2. Agent:  Erstellt Skill unter ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/
           Schreibt SKILL.md mit Metadaten und Anweisungen
           Schreibt unterstuetzenden Code (notion-tasks.ts)
           Testet den Code in der Exec-Umgebung
3. Agent:  Markiert den Skill als PENDING_APPROVAL
4. Sie:    Erhalten Benachrichtigung: "Neuer Skill erstellt: notion-tasks. Pruefen und genehmigen?"
5. Sie:    Genehmigen den Skill
6. Agent:  Verdrahtet den Skill in einen Cron-Job fuer taegliche Ausfuehrung
```

::: warning SICHERHEIT Vom Agenten erstellte Skills erfordern immer die Genehmigung des Eigentuemers, bevor sie aktiv werden. Der Agent kann seine eigenen Skills nicht selbst genehmigen. Dies verhindert, dass der Agent Faehigkeiten erstellt, die Ihre Aufsicht umgehen. :::

### Enterprise-Kontrollen

In Enterprise-Bereitstellungen gelten zusaetzliche Kontrollen fuer selbst erstellte Skills:

- Vom Agenten erstellte Skills erfordern immer Eigentuemer- oder Administrator-Genehmigung
- Skills koennen keine Klassifizierungs-Obergrenze ueber der Freigabestufe des Benutzers deklarieren
- Netzwerk-Endpunkt-Deklarationen werden auditiert
- Alle selbst erstellten Skills werden fuer Compliance-Pruefung protokolliert

## The Reef <ComingSoon :inline="true" />

The Reef ist Triggerfishs Community-Skill-Marktplatz -- eine Registry, in der Sie Skills entdecken, installieren, veroeffentlichen und teilen koennen.

| Funktion            | Beschreibung                                             |
| ------------------- | -------------------------------------------------------- |
| Suchen und Stoebern | Skills nach Kategorie, Tag oder Beliebtheit finden       |
| Ein-Befehl-Installation | `triggerfish skill install <name>`                   |
| Veroeffentlichen    | Teilen Sie Ihre Skills mit der Community                 |
| Sicherheits-Scanning | Automatisiertes Scanning auf boesartige Muster vor der Listung |
| Versionierung       | Skills werden versioniert mit Update-Verwaltung          |
| Bewertungen und Rezensionen | Community-Feedback zur Skill-Qualitaet            |

### CLI-Befehle

```bash
# Nach Skills suchen
triggerfish skill search "calendar"

# Einen Skill von The Reef installieren
triggerfish skill install google-cal

# Installierte Skills auflisten
triggerfish skill list

# Alle verwalteten Skills aktualisieren
triggerfish skill update --all

# Einen Skill bei The Reef veroeffentlichen
triggerfish skill publish

# Einen Skill entfernen
triggerfish skill remove google-cal
```

### Sicherheit

Von The Reef installierte Skills durchlaufen denselben Lebenszyklus wie jede andere Integration:

1. In das Verzeichnis verwalteter Skills heruntergeladen
2. Auf boesartige Muster gescannt (Code-Injection, nicht autorisierter Netzwerkzugriff usw.)
3. Gehen in den `UNTRUSTED`-Zustand, bis Sie sie klassifizieren
4. Vom Eigentuemer oder Administrator klassifiziert und aktiviert

::: info The Reef scannt alle veroeffentlichten Skills auf bekannte boesartige Muster, bevor sie gelistet werden. Sie sollten Skills dennoch vor der Klassifizierung pruefen, insbesondere Skills, die Netzwerkzugriff deklarieren oder leistungsstarke Tools wie `exec` oder `browser` erfordern. :::

## Skill-Sicherheitszusammenfassung

- Skills deklarieren ihre Sicherheitsanforderungen im Voraus (Klassifizierungs-Obergrenze, Tools, Netzwerk-Domains)
- Tool-Zugriff wird durch Policy gesteuert -- ein Skill, der `requires_tools: [browser]` hat, funktioniert nicht, wenn Browser-Zugriff durch Policy blockiert ist
- Netzwerk-Domains werden durchgesetzt -- ein Skill kann nicht auf Endpunkte zugreifen, die er nicht deklariert hat
- Vom Agenten erstellte Skills erfordern explizite Eigentuemer-/Administrator-Genehmigung
- Alle Skill-Aufrufe durchlaufen Policy-Hooks und werden vollstaendig auditiert
