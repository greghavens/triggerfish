# Architekturuebersicht

Triggerfish ist eine sichere, mehrkanalige KI-Agenten-Plattform mit einer einzigen Kerninvariante:

::: warning SICHERHEIT **Sicherheit ist deterministisch und sub-LLM.** Jede Sicherheitsentscheidung wird durch reinen Code getroffen, den das LLM nicht umgehen, ueberschreiben oder beeinflussen kann. Das LLM hat keinerlei Autoritaet -- es fordert Aktionen an; die Policy-Schicht entscheidet. :::

Diese Seite bietet einen Gesamtueberblick ueber die Funktionsweise von Triggerfish. Jede Hauptkomponente verweist auf eine dedizierte Detailseite.

## Systemarchitektur

<img src="/diagrams/system-architecture.svg" alt="Systemarchitektur: Kanaele fliessen durch den Channel Router zum Gateway, das Session Manager, Policy Engine und Agent Loop koordiniert" style="max-width: 100%;" />

### Datenfluss

Jede Nachricht durchlaeuft diesen Pfad durch das System:

<img src="/diagrams/data-flow-9-steps.svg" alt="Datenfluss: 9-Schritte-Pipeline von der eingehenden Nachricht durch Policy Hooks zur ausgehenden Zustellung" style="max-width: 100%;" />

An jedem Durchsetzungspunkt ist die Entscheidung deterministisch -- die gleiche Eingabe erzeugt immer das gleiche Ergebnis. Es gibt keine LLM-Aufrufe innerhalb von Hooks, keine Zufaelligkeit und keine Moeglichkeit fuer das LLM, das Ergebnis zu beeinflussen.

## Hauptkomponenten

### Klassifizierungssystem

Daten fliessen durch vier geordnete Stufen:
`RESTRICTED > CONFIDENTIAL > INTERNAL > PUBLIC`. Die Kernregel ist **kein Write-Down**: Daten koennen nur zu gleicher oder hoeherer Klassifizierung fliessen. Eine `CONFIDENTIAL`-Session kann keine Daten an einen `PUBLIC`-Kanal senden. Keine Ausnahmen. Kein LLM-Override.

[Mehr ueber das Klassifizierungssystem erfahren.](./classification)

### Policy Engine und Hooks

Acht deterministische Durchsetzungs-Hooks fangen jede Aktion an kritischen Punkten im Datenfluss ab. Hooks sind reine Funktionen: synchron, protokolliert und unfaelschbar. Die Policy Engine unterstuetzt feste Regeln (nie konfigurierbar), administrativ anpassbare Regeln und deklarative YAML-Ausnahmen fuer Unternehmen.

[Mehr ueber die Policy Engine erfahren.](./policy-engine)

### Sessions und Taint

Jedes Gespraech ist eine Session mit unabhaengigem Taint-Tracking. Wenn eine Session auf klassifizierte Daten zugreift, eskaliert ihr Taint auf diese Stufe und kann innerhalb der Session niemals sinken. Ein vollstaendiger Reset loescht sowohl Taint ALS AUCH den Gespraechsverlauf. Jedes Datenelement traegt Herkunftsmetadaten durch ein Lineage-Tracking-System.

[Mehr ueber Sessions und Taint erfahren.](./taint-and-sessions)

### Gateway

Das Gateway ist die zentrale Steuerungsebene -- ein dauerhaft laufender lokaler Dienst, der Sessions, Kanaele, Tools, Ereignisse und Agentenprozesse ueber einen WebSocket JSON-RPC-Endpunkt verwaltet. Es koordiniert den Benachrichtigungsdienst, den Cron-Scheduler, die Webhook-Verarbeitung und das Kanal-Routing.

[Mehr ueber das Gateway erfahren.](./gateway)

### Speicherung

Alle zustandsbehafteten Daten fliessen durch eine einheitliche `StorageProvider`-Abstraktion. Namensraum-Schluessel (`sessions:`, `taint:`, `lineage:`, `audit:`) halten die Belange getrennt und ermoeglichen den Wechsel von Backends, ohne Geschaeftslogik aendern zu muessen. Der Standard ist SQLite WAL unter `~/.triggerfish/data/triggerfish.db`.

[Mehr ueber die Speicherung erfahren.](./storage)

### Gestaffelte Verteidigung

Sicherheit ist in 13 unabhaengigen Mechanismen geschichtet, von der Kanalauthentifizierung und berechtigungsbewusstem Datenzugriff ueber Session-Taint, Policy Hooks, Plugin-Sandboxing, Dateisystem-Tool-Sandboxing bis hin zum Audit-Logging. Keine einzelne Schicht ist allein ausreichend; zusammen bilden sie eine Verteidigung, die auch bei Kompromittierung einer einzelnen Schicht robust bleibt.

[Mehr ueber gestaffelte Verteidigung erfahren.](./defense-in-depth)

## Designprinzipien

| Prinzip                              | Was es bedeutet                                                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Deterministische Durchsetzung**    | Policy Hooks verwenden reine Funktionen. Keine LLM-Aufrufe, keine Zufaelligkeit. Gleiche Eingabe erzeugt immer gleiche Entscheidung.    |
| **Taint-Propagierung**               | Alle Daten tragen Klassifizierungsmetadaten. Session-Taint kann nur eskalieren, niemals sinken.                                          |
| **Kein Write-Down**                  | Daten koennen niemals zu einer niedrigeren Klassifizierungsstufe fliessen. Niemals.                                                     |
| **Alles auditieren**                 | Alle Policy-Entscheidungen werden mit vollstaendigem Kontext protokolliert: Zeitstempel, Hook-Typ, Session-ID, Eingabe, Ergebnis, ausgewertete Regeln. |
| **Hooks sind unfaelschbar**          | Das LLM kann Policy-Hook-Entscheidungen nicht umgehen, modifizieren oder beeinflussen. Hooks laufen im Code unterhalb der LLM-Schicht.  |
| **Session-Isolation**                | Jede Session verfolgt Taint unabhaengig. Hintergrund-Sessions starten mit frischem PUBLIC-Taint. Agenten-Arbeitsbereiche sind vollstaendig isoliert. |
| **Speicherabstraktion**              | Kein Modul erstellt seine eigene Speicherung. Alle Persistenz laeuft ueber `StorageProvider`.                                           |

## Technologie-Stack

| Komponente             | Technologie                                                                       |
| ---------------------- | --------------------------------------------------------------------------------- |
| Laufzeitumgebung       | Deno 2.x (TypeScript strict mode)                                                 |
| Tests                  | Deno integrierter Test-Runner                                                     |
| Kanaele                | Baileys (WhatsApp), grammY (Telegram), Bolt (Slack), discord.js (Discord)         |
| Browser-Automatisierung| puppeteer-core (CDP)                                                              |
| Sprache                | Whisper (lokale STT), ElevenLabs/OpenAI (TTS)                                     |
| Speicherung            | SQLite WAL (Standard), Enterprise-Backends (Postgres, S3)                         |
| Secrets                | Betriebssystem-Schluesselbund (persoenlich), Vault-Integration (Enterprise)       |

::: info Triggerfish erfordert keine externen Build-Tools, kein Docker und keine Cloud-Abhaengigkeit. Es laeuft lokal, verarbeitet Daten lokal und gibt dem Benutzer volle Souveraenitaet ueber seine Daten. :::
