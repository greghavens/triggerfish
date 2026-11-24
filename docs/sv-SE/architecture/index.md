# Arkitekturöversikt

Triggerfish är en säker, flerkanals AI-agentplattform med en enda kärnprincip:

::: warning SÄKERHET **Säkerhet är deterministisk och sub-LLM.** Varje säkerhetsbeslut fattas av ren kod som LLM:en inte kan kringgå, åsidosätta eller påverka. LLM:en har noll auktoritet — den föreslår åtgärder; policylagret beslutar. :::

Den här sidan ger en överblick över hur Triggerfish fungerar. Varje huvudkomponent länkar till en dedikerad fördjupningssida.

## Systemarkitektur

<img src="/diagrams/system-architecture.svg" alt="Systemarkitektur: kanaler till vänster ansluter via den centrala Gateway till tjänster till höger" style="max-width: 100%;" />

### Dataflöde

Varje meddelande följer den här vägen genom systemet:

<img src="/diagrams/data-flow-9-steps.svg" alt="Dataflöde: 9-stegs pipeline från inkommande meddelande via policy-hooks till utgående leverans" style="max-width: 100%;" />

Vid varje hanteringspunkt är beslutet deterministiskt — samma indata ger alltid samma resultat. Det finns inga LLM-anrop inuti hooks, ingen slumpmässighet och inget sätt för LLM:en att påverka utfallet.

## Huvudkomponenter

### Klassificeringssystem

Data flödar genom fyra ordnade nivåer: `RESTRICTED > CONFIDENTIAL > INTERNAL > PUBLIC`. Kärnregeln är **inget nedskrivningsförbud**: data kan bara flöda till lika eller högre klassificering. En `CONFIDENTIAL`-session kan inte skicka data till en `PUBLIC`-kanal. Inga undantag. Ingen LLM-åsidosättning.

[Läs mer om klassificeringssystemet.](./classification)

### Policymotor och Hooks

Åtta deterministiska hanteringshooks fångar upp varje åtgärd vid kritiska punkter i dataflödet. Hooks är rena funktioner: synkrona, loggade och ofalsknliga. Policymotorn stöder fasta regler (aldrig konfigurerbara), administratörsjusterbara regler och deklarativa YAML-undantag för företag.

[Läs mer om policymotorn.](./policy-engine)

### Sessioner och Taint

Varje konversation är en session med oberoende taint-spårning. När en session kommer åt klassificerade data eskalerar dess taint till den nivån och kan aldrig minska inom sessionen. En fullständig återställning rensar taint OCH konversationshistorik. Varje dataelement bär provenansmetadata via ett lineage-spårningssystem.

[Läs mer om Sessioner och Taint.](./taint-and-sessions)

### Gateway

Gateway är det centrala kontrollplanet — en långvarig lokal tjänst som hanterar sessioner, kanaler, verktyg, händelser och agentprocesser via en WebSocket JSON-RPC-endpoint. Den koordinerar notifieringstjänsten, cron-schemaläggaren, webhook-intagning och kanalroutning.

[Läs mer om Gateway.](./gateway)

### Lagring

All tillståndsdata flödar via en enhetlig `StorageProvider`-abstraktion. Namnrymdsnycklar (`sessions:`, `taint:`, `lineage:`, `audit:`) håller ansvarsområden separerade samtidigt som backends kan bytas utan att påverka affärslogiken. Standard är SQLite WAL på `~/.triggerfish/data/triggerfish.db`.

[Läs mer om Lagring.](./storage)

### Försvar på djupet

Säkerheten är lagrad över 13 oberoende mekanismer, från kanalautentisering och behörighetsmedveten dataåtkomst via session-taint, policy-hooks, plugin-sandlåda, filsystemsverktygssandlåda och revisionsloggning. Inget enskilt lager är tillräckligt ensamt; tillsammans bildar de ett försvar som försämras varsamt även om ett lager komprometteras.

[Läs mer om Försvar på djupet.](./defense-in-depth)

## Designprinciper

| Princip                       | Vad det innebär                                                                                                                               |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deterministisk hantering**  | Policy-hooks använder rena funktioner. Inga LLM-anrop, ingen slumpmässighet. Samma indata ger alltid samma beslut.                            |
| **Taint-spridning**           | All data bär klassificeringsmetadata. Session-taint kan bara eskalera, aldrig minska.                                                         |
| **Inget nedskrivningsförbud** | Data kan inte flöda till en lägre klassificeringsnivå. Aldrig.                                                                                |
| **Granska allt**              | Alla policybeslut loggas med fullständigt sammanhang: tidsstämpel, hooktyp, sessions-ID, indata, resultat, utvärderade regler.                 |
| **Hooks är ofalsknliga**      | LLM:en kan inte kringgå, ändra eller påverka policy-hook-beslut. Hooks körs i kod under LLM-lagret.                                           |
| **Sessionsisolering**         | Varje session spårar taint oberoende. Bakgrundssessioner skapas med rent PUBLIC taint. Agent-arbetsytor är fullt isolerade.                   |
| **Lagringsabstraktion**       | Ingen modul skapar sin egen lagring. All persistens flödar via `StorageProvider`.                                                             |

## Teknikstack

| Komponent            | Teknik                                                                    |
| -------------------- | ------------------------------------------------------------------------- |
| Runtime              | Deno 2.x (TypeScript strikt läge)                                         |
| Testning             | Denos inbyggda testverktyg                                                |
| Kanaler              | Baileys (WhatsApp), grammY (Telegram), Bolt (Slack), discord.js (Discord) |
| Webbläsarautomation  | puppeteer-core (CDP)                                                      |
| Röst                 | Whisper (lokal STT), ElevenLabs/OpenAI (TTS)                              |
| Lagring              | SQLite WAL (standard), företagsbackends (Postgres, S3)                    |
| Hemligheter          | OS-nyckelring (personlig), vault-integration (företag)                    |

::: info Triggerfish kräver inga externa byggverktyg, ingen Docker och inget molnberoende. Det körs lokalt, bearbetar data lokalt och ger användaren full suveränitet över sina data. :::
