# Installasjon og distribusjon

Triggerfish installeres med én kommando på macOS, Linux, Windows og Docker. De binære installasjonsprogrammene laster ned en ferdigbygd utgivelse, verifiserer SHA256-sjekksummen og kjører oppsettveiviseren.

## Installer med én kommando

::: code-group

```bash [macOS / Linux]
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | bash
```

```powershell [Windows]
irm https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.ps1 | iex
```

```bash [Docker]
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

:::

### Hva det binære installasjonsprogrammet gjør

1. **Registrerer plattformen din** og arkitekturen
2. **Laster ned** den nyeste ferdigbygde binærfilen fra GitHub Releases
3. **Verifiserer SHA256-sjekksummen** for å sikre integritet
4. **Installerer** binærfilen til `/usr/local/bin` (eller `~/.local/bin` / `%LOCALAPPDATA%\Triggerfish`)
5. **Kjører oppsettveiviseren** (`triggerfish dive`) for å konfigurere agenten, LLM-leverandøren og kanalene dine
6. **Starter bakgrunnsdaemonen** slik at agenten alltid kjører

Etter at installasjonsprogrammet er ferdig, har du en fullt fungerende agent. Ingen ytterligere trinn nødvendig.

### Installer en bestemt versjon

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## Systemkrav

| Krav             | Detaljer                                                         |
| ---------------- | ---------------------------------------------------------------- |
| Operativsystem   | macOS, Linux eller Windows                                       |
| Diskplass        | Omtrent 100 MB for den kompilerte binærfilen                     |
| Nettverk         | Påkrevd for LLM API-kall; all behandling kjører lokalt           |

::: tip Ingen Docker, ingen containere, ingen skykontoer nødvendig. Triggerfish er én enkelt binærfil som kjører på maskinen din. Docker er tilgjengelig som en alternativ distribusjonsmetode. :::

## Docker

Docker-distribusjonen gir et `triggerfish` CLI-innpakningsskript som gir deg den samme kommandoopplevelsen som den native binærfilen. All data bor i et navngitt Docker-volum.

### Hurtigstart

Installasjonsprogrammet henter bildet, installerer CLI-innpakningsskriptet og kjører oppsettveiviseren:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

Eller kjør installasjonsprogrammet fra en lokal kopi:

```bash
./deploy/docker/install.sh
```

Installasjonsprogrammet:

1. Registrerer container-kjøretidsmiljøet ditt (podman eller docker)
2. Installerer `triggerfish` CLI-innpakningsskriptet til `~/.local/bin` (eller `/usr/local/bin`)
3. Kopierer compose-filen til `~/.triggerfish/docker/`
4. Henter det nyeste bildet
5. Kjører oppsettveiviseren (`triggerfish dive`) i en engangsbeholder
6. Starter tjenesten

### Daglig bruk

Etter installasjon fungerer `triggerfish`-kommandoen på samme måte som den native binærfilen:

```bash
triggerfish chat              # Interaktiv chattesession
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # Helsediagnostikk
triggerfish logs              # Vis containerlogger
triggerfish status            # Sjekk om containeren kjører
triggerfish stop              # Stopp containeren
triggerfish start             # Start containeren
triggerfish update            # Hent nyeste bilde og start på nytt
triggerfish dive              # Kjør oppsettveiviseren på nytt
```

### Slik fungerer innpakningsskriptet

Innpakningsskriptet (`deploy/docker/triggerfish`) ruter kommandoer:

| Kommando        | Oppførsel                                                                 |
| --------------- | ------------------------------------------------------------------------- |
| `start`         | Start container via compose                                               |
| `stop`          | Stopp container via compose                                               |
| `run`           | Kjør i forgrunnen (Ctrl+C for å stoppe)                                   |
| `status`        | Vis container-kjørestatus                                                 |
| `logs`          | Strøm containerlogger                                                     |
| `update`        | Hent nyeste bilde, start på nytt                                          |
| `dive`          | Engangscontainer hvis ikke kjørende; exec + omstart hvis kjørende         |
| Alt annet       | `exec` inn i den kjørende containeren                                     |

Innpakningsskriptet registrerer automatisk `podman` vs `docker`. Overstyr med `TRIGGERFISH_CONTAINER_RUNTIME=docker`.

### Docker Compose

Compose-filen bor på `~/.triggerfish/docker/docker-compose.yml` etter installasjon. Du kan også bruke den direkte:

```bash
cd deploy/docker
docker compose up -d
```

### Miljøvariabler

Kopier `.env.example` til `.env` ved siden av compose-filen for å angi API-nøkler via miljøvariabler:

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# Rediger ~/.triggerfish/docker/.env
```

API-nøkler lagres vanligvis via `triggerfish config set-secret` (vedvart i datavolum), men miljøvariabler fungerer som et alternativ.

### Hemmeligheter i Docker

Siden OS-nøkkelringen ikke er tilgjengelig i containere, bruker Triggerfish et filbasert hemmelighetslager på `/data/secrets.json` inne i volumet. Bruk CLI-innpakningsskriptet til å administrere hemmeligheter:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### Datapersistens

Containeren lagrer all data under `/data`:

| Sti                         | Innhold                                          |
| --------------------------- | ------------------------------------------------ |
| `/data/triggerfish.yaml`    | Konfigurasjon                                    |
| `/data/secrets.json`        | Filbasert hemmelighetslager                      |
| `/data/data/triggerfish.db` | SQLite-database (sesjoner, cron, minne)          |
| `/data/workspace/`          | Agent-arbeidsområder                             |
| `/data/skills/`             | Installerte skills                               |
| `/data/logs/`               | Loggfiler                                        |
| `/data/SPINE.md`            | Agent-identitet                                  |

Bruk et navngitt volum (`-v triggerfish-data:/data`) eller bind-montering for å vedvare på tvers av container-omstarter.

### Bygge Docker-bildet lokalt

```bash
make docker
# eller
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### Versjonsfesting (Docker)

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## Installer fra kildekode

Hvis du foretrekker å bygge fra kildekode eller ønsker å bidra:

```bash
# 1. Installer Deno (hvis du ikke har det)
curl -fsSL https://deno.land/install.sh | sh

# 2. Klon repositoriet
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. Kompiler
deno task compile

# 4. Kjør oppsettveiviseren
./triggerfish dive

# 5. (Valgfritt) Installer som bakgrunnsdaemon
./triggerfish start
```

Alternativt kan du bruke de arkiverte installasjonsskriptene fra kildekode:

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info Bygging fra kildekode krever Deno 2.x og git. `deno task compile`-kommandoen produserer en selvstendig binærfil uten eksterne avhengigheter. :::

## Plattformovergripende binærbygging

For å bygge binærfiler for alle plattformer fra en hvilken som helst vertmaskin:

```bash
make release
```

Dette produserer alle 5 binærfiler pluss sjekksummer i `dist/`:

| Fil                           | Plattform                  |
| ----------------------------- | -------------------------- |
| `triggerfish-linux-x64`       | Linux x86_64               |
| `triggerfish-linux-arm64`     | Linux ARM64                |
| `triggerfish-macos-x64`       | macOS Intel                |
| `triggerfish-macos-arm64`     | macOS Apple Silicon        |
| `triggerfish-windows-x64.exe` | Windows x86_64             |
| `SHA256SUMS.txt`              | Sjekksummer for alle       |

## Kjøretidskatalog

Etter å ha kjørt `triggerfish dive`, bor konfigurasjonen og dataene dine i `~/.triggerfish/`:

```
~/.triggerfish/
├── triggerfish.yaml          # Hovedkonfigurasjon
├── SPINE.md                  # Agent-identitet og oppdrag (systemprompt)
├── TRIGGER.md                # Proaktive atferdstriggers
├── workspace/                # Agent-kodearbeidsområde
├── skills/                   # Installerte skills
├── data/                     # SQLite-database, sesjonstilstand
└── logs/                     # Daemon- og utførelseslogger
```

I Docker tilsvarer dette `/data/` inne i containeren.

## Daemon-administrasjon

Installasjonsprogrammet setter opp Triggerfish som en OS-nativ bakgrunnsjeneste:

| Plattform | Tjenesteadministrator            |
| --------- | -------------------------------- |
| macOS     | launchd                          |
| Linux     | systemd                          |
| Windows   | Windows Service / Task Scheduler |

Etter installasjon kan du administrere daemonen med:

```bash
triggerfish start     # Installer og start daemonen
triggerfish stop      # Stopp daemonen
triggerfish status    # Sjekk om daemonen kjører
triggerfish logs      # Vis daemon-logger
```

## Utgivelsesprosess

Utgivelser er automatisert via GitHub Actions. For å opprette en ny utgivelse:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Dette utløser utgivelsesarbeidsflyten som bygger alle 5 plattformbinærfiler, oppretter en GitHub Release med sjekksummer og pusher et multi-arch Docker-bilde til GHCR. Installasjonsskriptene laster automatisk ned den nyeste utgivelsen.

## Oppdatering

For å sjekke og installere oppdateringer:

```bash
triggerfish update
```

## Plattformstøtte

| Plattform   | Binær | Docker | Installasjonsskript |
| ----------- | ----- | ------ | ------------------- |
| Linux x64   | ja    | ja     | ja                  |
| Linux arm64 | ja    | ja     | ja                  |
| macOS x64   | ja    | —      | ja                  |
| macOS arm64 | ja    | —      | ja                  |
| Windows x64 | ja    | —      | ja (PowerShell)     |

## Neste steg

Med Triggerfish installert, gå til [Hurtigstart](./quickstart)-veiledningen for å konfigurere agenten din og begynne å chatte.
