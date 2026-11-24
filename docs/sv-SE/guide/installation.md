# Installation och driftsättning

Triggerfish installeras med ett enda kommando på macOS, Linux, Windows och Docker. De binära installationsprogrammen laddar ned en förbyggd version, verifierar dess SHA256-kontrollsumma och startar installationsguiden.

## Installera med ett kommando

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

### Vad det binära installationsprogrammet gör

1. **Identifierar din plattform** och arkitektur
2. **Laddar ned** den senaste förbyggda binärfilen från GitHub Releases
3. **Verifierar SHA256-kontrollsumman** för att säkerställa integriteten
4. **Installerar** binärfilen till `/usr/local/bin` (eller `~/.local/bin` / `%LOCALAPPDATA%\Triggerfish`)
5. **Kör installationsguiden** (`triggerfish dive`) för att konfigurera din agent, LLM-leverantör och kanaler
6. **Startar bakgrundsdaemonen** så att din agent alltid körs

När installationsprogrammet är klart har du en fullt fungerande agent. Inga ytterligare steg krävs.

### Installera en specifik version

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
| Diskutrymme      | Ungefär 100 MB för den kompilerade binärfilen                    |
| Nätverk          | Krävs för LLM API-anrop; all bearbetning sker lokalt            |

::: tip Ingen Docker, inga containers, inga molnkonton krävs. Triggerfish är en enskild binärfil som körs på din dator. Docker finns tillgängligt som alternativ driftsättningsmetod. :::

## Docker

Docker-driftsättningen tillhandahåller en `triggerfish` CLI-omslutning som ger dig samma kommandoupplevelse som den inbyggda binärfilen. All data lagras i en namngiven Docker-volym.

### Snabbstart

Installationsprogrammet hämtar bilden, installerar CLI-omslutningen och kör installationsguiden:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

Eller kör installationsprogrammet från en lokal klon:

```bash
./deploy/docker/install.sh
```

Installationsprogrammet:

1. Identifierar din container-runtime (podman eller docker)
2. Installerar `triggerfish` CLI-omslutningen till `~/.local/bin` (eller `/usr/local/bin`)
3. Kopierar compose-filen till `~/.triggerfish/docker/`
4. Hämtar den senaste bilden
5. Kör installationsguiden (`triggerfish dive`) i en engångscontainer
6. Startar tjänsten

### Daglig användning

Efter installationen fungerar `triggerfish`-kommandot på samma sätt som den inbyggda binärfilen:

```bash
triggerfish chat              # Interaktiv chattsession
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # Hälsodiagnostik
triggerfish logs              # Visa containerloggar
triggerfish status            # Kontrollera om containern körs
triggerfish stop              # Stoppa containern
triggerfish start             # Starta containern
triggerfish update            # Hämta senaste bild och starta om
triggerfish dive              # Kör om installationsguiden
```

### Hur omslutningen fungerar

Omslutningsskriptet (`deploy/docker/triggerfish`) dirigerar kommandon:

| Kommando        | Beteende                                                            |
| --------------- | ------------------------------------------------------------------- |
| `start`         | Starta container via compose                                        |
| `stop`          | Stoppa container via compose                                        |
| `run`           | Kör i förgrunden (Ctrl+C för att stoppa)                           |
| `status`        | Visa container-körningsstatus                                       |
| `logs`          | Streama containerloggar                                             |
| `update`        | Hämta senaste bild, starta om                                       |
| `dive`          | Engångscontainer om inte igång; exec + omstart om igång            |
| Allt annat      | `exec` in i den körande containern                                  |

Omslutningen identifierar automatiskt `podman` kontra `docker`. Åsidosätt med `TRIGGERFISH_CONTAINER_RUNTIME=docker`.

### Docker Compose

Compose-filen finns på `~/.triggerfish/docker/docker-compose.yml` efter installationen. Du kan också använda den direkt:

```bash
cd deploy/docker
docker compose up -d
```

### Miljövariabler

Kopiera `.env.example` till `.env` bredvid compose-filen för att ange API-nycklar via miljövariabler:

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# Redigera ~/.triggerfish/docker/.env
```

API-nycklar lagras vanligtvis via `triggerfish config set-secret` (sparas i datavolymen), men miljövariabler fungerar som alternativ.

### Hemligheter i Docker

Eftersom OS-nyckelringen inte är tillgänglig i containers använder Triggerfish ett filbaserat hemlighetslager på `/data/secrets.json` inuti volymen. Använd CLI-omslutningen för att hantera hemligheter:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### Datapersistens

Containern lagrar all data under `/data`:

| Sökväg                      | Innehåll                                       |
| --------------------------- | ---------------------------------------------- |
| `/data/triggerfish.yaml`    | Konfiguration                                  |
| `/data/secrets.json`        | Filbaserat hemlighetslager                     |
| `/data/data/triggerfish.db` | SQLite-databas (sessioner, cron, minne)        |
| `/data/workspace/`          | Agent-arbetsytor                               |
| `/data/skills/`             | Installerade skills                            |
| `/data/logs/`               | Loggfiler                                      |
| `/data/SPINE.md`            | Agentidentitet                                 |

Använd en namngiven volym (`-v triggerfish-data:/data`) eller bind mount för att bevara data över omstarter av containern.

### Bygga Docker-bilden lokalt

```bash
make docker
# eller
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### Versionsfixering (Docker)

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## Installera från källkod

Om du föredrar att bygga från källkod eller vill bidra:

```bash
# 1. Installera Deno (om du inte redan har det)
curl -fsSL https://deno.land/install.sh | sh

# 2. Klona repositoriet
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. Kompilera
deno task compile

# 4. Kör installationsguiden
./triggerfish dive

# 5. (Valfritt) Installera som bakgrundsdaemon
./triggerfish start
```

Alternativt kan du använda de arkiverade installationsskripten från källkod:

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info Att bygga från källkod kräver Deno 2.x och git. Kommandot `deno task compile` producerar en fristående binärfil utan externa beroenden. :::

## Plattformsövergripande binärbyggen

För att bygga binärfiler för alla plattformar från valfri värd:

```bash
make release
```

Detta producerar alla 5 binärfiler plus kontrollsummor i `dist/`:

| Fil                           | Plattform                    |
| ----------------------------- | ---------------------------- |
| `triggerfish-linux-x64`       | Linux x86_64                 |
| `triggerfish-linux-arm64`     | Linux ARM64                  |
| `triggerfish-macos-x64`       | macOS Intel                  |
| `triggerfish-macos-arm64`     | macOS Apple Silicon          |
| `triggerfish-windows-x64.exe` | Windows x86_64               |
| `SHA256SUMS.txt`              | Kontrollsummor för alla filer |

## Körningskatalog

Efter att ha kört `triggerfish dive` finns din konfiguration och data på `~/.triggerfish/`:

```
~/.triggerfish/
├── triggerfish.yaml          # Huvudkonfiguration
├── SPINE.md                  # Agentidentitet och uppdrag (systemprompt)
├── TRIGGER.md                # Proaktiva beteendetriggers
├── workspace/                # Agents kodarbetsyta
├── skills/                   # Installerade skills
├── data/                     # SQLite-databas, sessionstillstånd
└── logs/                     # Daemon- och körningsloggar
```

I Docker mappas detta till `/data/` inuti containern.

## Daemonhantering

Installationsprogrammet ställer in Triggerfish som en OS-native bakgrundstjänst:

| Plattform | Tjänstehanterare                     |
| --------- | ------------------------------------ |
| macOS     | launchd                              |
| Linux     | systemd                              |
| Windows   | Windows Service / Task Scheduler     |

Efter installationen hanterar du daemonen med:

```bash
triggerfish start     # Installera och starta daemonen
triggerfish stop      # Stoppa daemonen
triggerfish status    # Kontrollera om daemonen körs
triggerfish logs      # Visa daemonloggar
```

## Versionsprocess

Versioner automatiseras via GitHub Actions. För att skapa en ny version:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Detta utlöser versionsarbetsflödet som bygger alla 5 plattformsbinärfiler, skapar en GitHub Release med kontrollsummor och skickar en multi-arch Docker-bild till GHCR. Installationsskripten laddar automatiskt ned den senaste versionen.

## Uppdatering

För att söka efter och installera uppdateringar:

```bash
triggerfish update
```

## Plattformsstöd

| Plattform    | Binär | Docker | Installationsskript  |
| ------------ | ----- | ------ | -------------------- |
| Linux x64    | ja    | ja     | ja                   |
| Linux arm64  | ja    | ja     | ja                   |
| macOS x64    | ja    | —      | ja                   |
| macOS arm64  | ja    | —      | ja                   |
| Windows x64  | ja    | —      | ja (PowerShell)      |

## Nästa steg

Med Triggerfish installerat, gå till guiden [Snabbstart](./quickstart) för att konfigurera din agent och börja chatta.
