# Arkitektoversikt

Triggerfish er en sikker, flerkanal AI-agentplattform med én kjerneinvariant:

::: warning SIKKERHET **Sikkerhet er deterministisk og sub-LLM.** Alle sikkerhetsbeslutninger fattes av ren kode som LLM-en ikke kan omgå, overstyre eller påvirke. LLM-en har null autoritet — den ber om handlinger; policy-laget bestemmer. :::

Denne siden gir det store bildet av hvordan Triggerfish fungerer. Hver hovedkomponent lenker til en dedikert dypdykkside.

## Systemarkitektur

<img src="/diagrams/system-architecture.svg" alt="Systemarkitektur: kanaler flyter gjennom kanalruteren til Gateway, som koordinerer Sesjonsbehandler, Policy-motor og Agent-sløyfe" style="max-width: 100%;" />

### Dataflyt

Hver melding følger denne banen gjennom systemet:

<img src="/diagrams/data-flow-9-steps.svg" alt="Dataflyt: 9-trinns pipeline fra innkommende melding gjennom policy-hooks til utgående levering" style="max-width: 100%;" />

Ved hvert håndhevelsespunkt er beslutningen deterministisk — den samme inndataen gir alltid det samme resultatet. Det er ingen LLM-kall inne i hooks, ingen tilfeldighet, og ingen måte for LLM-en å påvirke utfallet på.

## Hovedkomponenter

### Klassifiseringssystem

Data flyter gjennom fire ordnede nivåer: `RESTRICTED > CONFIDENTIAL > INTERNAL > PUBLIC`. Kjerneregelen er **no write-down**: data kan bare flyte til lik eller høyere klassifisering. En `CONFIDENTIAL`-sesjon kan ikke sende data til en `PUBLIC`-kanal. Ingen unntak. Ingen LLM-overstyring.

[Les mer om klassifiseringssystemet.](./classification)

### Policy-motor og hooks

Åtte deterministiske håndhevingshooks avskjærer hver handling på kritiske punkter i dataflyten. Hooks er rene funksjoner: synkrone, loggede og uforfalskebare. Policy-motoren støtter faste regler (aldri konfigurerbare), admin-justerbare regler og deklarative YAML-unntak for bedrifter.

[Les mer om Policy-motoren.](./policy-engine)

### Sesjoner og Taint

Hver samtale er en sesjon med uavhengig taint-sporing. Når en sesjon får tilgang til klassifiserte data, eskalerer taint til det nivået og kan aldri synke innen sesjonen. En full tilbakestilling tømmer taint OG samtalehistorikk. Hvert dataelement bærer provenansmetadata gjennom et sporingssystem for datalinjer.

[Les mer om Sesjoner og Taint.](./taint-and-sessions)

### Gateway

Gateway er den sentrale kontrollplanet — en langkjørende lokal tjeneste som administrerer sesjoner, kanaler, verktøy, hendelser og agentprosesser gjennom et WebSocket JSON-RPC-endepunkt. Det koordinerer varslingstjenesten, cron-planleggeren, webhook-inntak og kanalruting.

[Les mer om Gateway.](./gateway)

### Lagring

Alle tilstandsbaserte data flyter gjennom en enhetlig `StorageProvider`-abstraksjon. Navnedelte nøkler (`sessions:`, `taint:`, `lineage:`, `audit:`) holder problemstillinger atskilt mens backends kan byttes uten å berøre forretningslogikken. Standarden er SQLite WAL på `~/.triggerfish/data/triggerfish.db`.

[Les mer om Lagring.](./storage)

### Forsvar i dybden

Sikkerhet er lagdelt over 13 uavhengige mekanismer, fra kanalautentisering og tillatelsesbevisst datatilgang gjennom session taint, policy-hooks, plugin-sandkasse, filsystemverktøysandkasse og revisjonslogging. Ingen enkelt lag er tilstrekkelig alene; sammen danner de et forsvar som degraderer elegrant selv om ett lag kompromitteres.

[Les mer om Forsvar i dybden.](./defense-in-depth)

## Designprinsipper

| Prinsipp                      | Hva det betyr                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Deterministisk håndhevelse** | Policy-hooks bruker rene funksjoner. Ingen LLM-kall, ingen tilfeldighet. Samme inndata gir alltid samme beslutning.                  |
| **Taint-propagering**         | All data bærer klassifiseringsmetadata. Session taint kan bare eskalere, aldri synke.                                                 |
| **Ingen write-down**          | Data kan ikke flyte til et lavere klassifiseringsnivå. Noensinne.                                                                    |
| **Revidér alt**               | Alle policy-beslutninger logges med full kontekst: tidsstempel, hook-type, sesjons-ID, inndata, resultat, evaluerte regler.           |
| **Hooks er uforfalskebare**   | LLM-en kan ikke omgå, endre eller påvirke policy-hook-beslutninger. Hooks kjører i kode under LLM-laget.                             |
| **Sesjonsisolasjon**          | Hver sesjon sporer taint uavhengig. Bakgrunnssesjoner spawnes med frisk PUBLIC taint. Agent-arbeidsområder er fullstendig isolerte.   |
| **Lagringsabstraksjon**       | Ingen modul oppretter sin egen lagring. All persistens flyter gjennom `StorageProvider`.                                             |

## Teknologistakk

| Komponent            | Teknologi                                                                 |
| -------------------- | ------------------------------------------------------------------------- |
| Kjøretid             | Deno 2.x (TypeScript streng modus)                                        |
| Testing              | Denos innebygde testkjører                                                |
| Kanaler              | Baileys (WhatsApp), grammY (Telegram), Bolt (Slack), discord.js (Discord) |
| Nettleserautomatisering | puppeteer-core (CDP)                                                   |
| Stemme               | Whisper (lokal STT), ElevenLabs/OpenAI (TTS)                             |
| Lagring              | SQLite WAL (standard), bedriftsbackends (Postgres, S3)                    |
| Hemmeligheter        | OS-nøkkelring (personlig), vault-integrasjon (bedrift)                   |

::: info Triggerfish krever ingen eksterne byggeverktøy, ingen Docker og ingen sky-avhengighet. Det kjører lokalt, behandler data lokalt og gir brukeren full suverenitet over dataene sine. :::
