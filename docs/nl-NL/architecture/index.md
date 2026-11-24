# Architectuuroverzicht

Triggerfish is een veilig, multi-kanaal AI-agentplatform met één kernprincipe:

::: warning BEVEILIGING **Beveiliging is deterministisch en sub-LLM.** Elke beveiligingsbeslissing wordt genomen door pure code die het LLM niet kan omzeilen, overschrijven of beïnvloeden. Het LLM heeft nul autoriteit — het vraagt acties aan; de beleidslaag beslist. :::

Deze pagina geeft een overzicht van hoe Triggerfish werkt. Elke hoofdcomponent linkt naar een toegewijde verdiepingspagina.

## Systeemarchitectuur

<img src="/diagrams/system-architecture.svg" alt="Systeemarchitectuur: kanalen stromen via de Channel Router naar de Gateway, die de Session Manager, Policy Engine en Agent Loop coördineert" style="max-width: 100%;" />

### Gegevensstroom

Elk bericht volgt dit pad door het systeem:

<img src="/diagrams/data-flow-9-steps.svg" alt="Gegevensstroom: 9-staps pijplijn van inkomend bericht via beleidshooks naar uitgaande bezorging" style="max-width: 100%;" />

Bij elk handhavingspunt is de beslissing deterministisch — dezelfde invoer levert altijd hetzelfde resultaat op. Er zijn geen LLM-aanroepen in hooks, geen willekeur en geen manier voor het LLM om de uitkomst te beïnvloeden.

## Hoofdcomponenten

### Classificatiesysteem

Gegevens stromen door vier geordende niveaus: `RESTRICTED > CONFIDENTIAL > INTERNAL > PUBLIC`. De kernregel is **geen write-down**: gegevens kunnen alleen stromen naar een gelijke of hogere classificatie. Een `CONFIDENTIAL`-sessie kan geen gegevens sturen naar een `PUBLIC`-kanaal. Geen uitzonderingen. Geen LLM-overschrijving.

[Lees meer over het classificatiesysteem.](./classification)

### Beleidsengine en hooks

Acht deterministische handhavingshooks onderscheppen elke actie op kritieke punten in de gegevensstroom. Hooks zijn pure functies: synchroon, vastgelegd en onvervalsbaar. De beleidsengine ondersteunt vaste regels (nooit configureerbaar), door beheerders afgestemde regels en declaratieve YAML-ontsnappingspaden voor enterprise.

[Lees meer over de beleidsengine.](./policy-engine)

### Sessies en Taint

Elk gesprek is een sessie met onafhankelijke taint-tracking. Wanneer een sessie geclassificeerde gegevens raadpleegt, escaleert zijn taint naar dat niveau en kan nooit afnemen binnen de sessie. Een volledige reset wist taint EN gespreksgeschiedenis. Elk gegevenselement draagt provenancemetadata via een lineage-tracking-systeem.

[Lees meer over sessies en taint.](./taint-and-sessions)

### Gateway

De Gateway is het centrale controlevlak — een langlopende lokale service die sessies, kanalen, tools, evenementen en agentprocessen beheert via een WebSocket JSON-RPC-eindpunt. Het coördineert de meldingsservice, cron-planner, webhook-inname en kanaalroutering.

[Lees meer over de Gateway.](./gateway)

### Opslag

Alle statische gegevens stromen via een uniforme `StorageProvider`-abstractie. Naamruimtesleutels (`sessions:`, `taint:`, `lineage:`, `audit:`) houden zorgen gescheiden, terwijl backends kunnen worden verwisseld zonder bedrijfslogica aan te raken. De standaard is SQLite WAL op `~/.triggerfish/data/triggerfish.db`.

[Lees meer over opslag.](./storage)

### Verdediging in diepte

Beveiliging is gelaagd over 13 onafhankelijke mechanismen, van kanaalverificatie en machtigingsbewust gegevenstoegang via sessie-taint, beleidshooks, plugin-sandboxing, bestandssysteem-tool-sandboxing tot auditregistratie. Geen enkele laag is op zichzelf voldoende; samen vormen ze een verdediging die graceful degradeert, zelfs als een laag is gecompromitteerd.

[Lees meer over verdediging in diepte.](./defense-in-depth)

## Ontwerpprincipes

| Principe                      | Wat het betekent                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Deterministische handhaving** | Beleidshooks gebruiken pure functies. Geen LLM-aanroepen, geen willekeur. Dezelfde invoer levert altijd dezelfde beslissing op. |
| **Taint-propagatie**          | Alle gegevens dragen classificatiemetadata. Sessie-taint kan alleen escaleren, nooit afnemen.                                     |
| **Geen write-down**           | Gegevens kunnen niet stromen naar een lager classificatieniveau. Nooit.                                                           |
| **Alles auditen**             | Alle beleidsbeslissingen vastgelegd met volledige context: tijdstempel, hook-type, sessie-ID, invoer, resultaat, geëvalueerde regels. |
| **Hooks zijn onvervalsbaar**  | Het LLM kan beleidshook-beslissingen niet omzeilen, wijzigen of beïnvloeden. Hooks worden uitgevoerd in code onder de LLM-laag. |
| **Sessieisolatie**            | Elke sessie volgt taint onafhankelijk. Achtergrondssessies starten met frisse PUBLIC-taint. Agent-werkruimten zijn volledig geïsoleerd. |
| **Opslagabstractie**          | Geen module maakt zijn eigen opslag. Alle persistentie stroomt via `StorageProvider`.                                             |

## Technologiestack

| Component          | Technologie                                                               |
| ------------------ | ------------------------------------------------------------------------- |
| Runtime            | Deno 2.x (TypeScript strikte modus)                                       |
| Testen             | Deno ingebouwde testrunner                                                |
| Kanalen            | Baileys (WhatsApp), grammY (Telegram), Bolt (Slack), discord.js (Discord) |
| Browserautomatisering | puppeteer-core (CDP)                                                   |
| Spraak             | Whisper (lokale STT), ElevenLabs/OpenAI (TTS)                             |
| Opslag             | SQLite WAL (standaard), enterprise-backends (Postgres, S3)                |
| Geheimen           | OS-sleutelhanger (persoonlijk), vault-integratie (enterprise)             |

::: info Triggerfish vereist geen externe bouwtools, geen Docker en geen cloudafhankelijkheid. Het draait lokaal, verwerkt gegevens lokaal en geeft de gebruiker volledige soevereiniteit over zijn gegevens. :::
