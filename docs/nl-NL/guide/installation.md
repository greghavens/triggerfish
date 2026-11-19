# Installatie en implementatie

Triggerfish installeert met één opdracht op macOS, Linux, Windows en Docker. De binaire installatieprogramma's downloaden een vooraf gebouwde release, verifiëren de SHA256-controlesom en starten de installatiewizard.

## Installeren met één opdracht

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

### Wat het binaire installatieprogramma doet

1. **Detecteert uw platform** en architectuur
2. **Downloadt** de nieuwste vooraf gebouwde binary van GitHub Releases
3. **Verifieert de SHA256-controlesom** om integriteit te garanderen
4. **Installeert** de binary naar `/usr/local/bin` (of `~/.local/bin` / `%LOCALAPPDATA%\Triggerfish`)
5. **Start de installatiewizard** (`triggerfish dive`) om uw agent, LLM-aanbieder en kanalen te configureren
6. **Start de achtergrond-daemon** zodat uw agent altijd actief is

Na afloop van het installatieprogramma beschikt u over een volledig werkende agent. Geen extra stappen vereist.

### Een specifieke versie installeren

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## Systeemvereisten

| Vereiste         | Details                                                           |
| ---------------- | ----------------------------------------------------------------- |
| Besturingssysteem | macOS, Linux of Windows                                          |
| Schijfruimte     | Ongeveer 100 MB voor de gecompileerde binary                      |
| Netwerk          | Vereist voor LLM-API-aanroepen; alle verwerking draait lokaal     |

::: tip Geen Docker, geen containers, geen cloudaccounts vereist. Triggerfish is één binary die op uw machine draait. Docker is beschikbaar als alternatieve implementatiemethode. :::

## Docker

De Docker-implementatie biedt een `triggerfish`-CLI-wrapper die u dezelfde opdrachtervaring geeft als de native binary. Alle gegevens worden opgeslagen in een benoemd Docker-volume.

### Snel starten

Het installatieprogramma haalt de image op, installeert de CLI-wrapper en start de installatiewizard:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

Of voer het installatieprogramma uit vanuit een lokale checkout:

```bash
./deploy/docker/install.sh
```

Het installatieprogramma:

1. Detecteert uw containerruntime (podman of docker)
2. Installeert de `triggerfish`-CLI-wrapper naar `~/.local/bin` (of `/usr/local/bin`)
3. Kopieert het compose-bestand naar `~/.triggerfish/docker/`
4. Haalt de nieuwste image op
5. Start de installatiewizard (`triggerfish dive`) in een eenmalige container
6. Start de service

### Dagelijks gebruik

Na installatie werkt de opdracht `triggerfish` hetzelfde als de native binary:

```bash
triggerfish chat              # Interactieve chatsessie
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # Gezondheidsdiagnostiek
triggerfish logs              # Containerlogboeken bekijken
triggerfish status            # Controleren of de container actief is
triggerfish stop              # Container stoppen
triggerfish start             # Container starten
triggerfish update            # Nieuwste image ophalen en opnieuw starten
triggerfish dive              # Installatiewizard opnieuw uitvoeren
```

### Hoe de wrapper werkt

Het wrapperscript (`deploy/docker/triggerfish`) routeert opdrachten:

| Opdracht        | Gedrag                                                           |
| --------------- | ---------------------------------------------------------------- |
| `start`         | Container starten via compose                                    |
| `stop`          | Container stoppen via compose                                    |
| `run`           | Uitvoeren op de voorgrond (Ctrl+C om te stoppen)                 |
| `status`        | Lopende status van container tonen                               |
| `logs`          | Containerlogboeken streamen                                      |
| `update`        | Nieuwste image ophalen en opnieuw starten                        |
| `dive`          | Eenmalige container als niet actief; exec + herstart als actief  |
| Overige         | `exec` in de actieve container                                   |

De wrapper detecteert automatisch `podman` vs `docker`. Overschrijven met `TRIGGERFISH_CONTAINER_RUNTIME=docker`.

### Docker Compose

Het compose-bestand bevindt zich na installatie in `~/.triggerfish/docker/docker-compose.yml`. U kunt het ook direct gebruiken:

```bash
cd deploy/docker
docker compose up -d
```

### Omgevingsvariabelen

Kopieer `.env.example` naar `.env` naast het compose-bestand om API-sleutels via omgevingsvariabelen in te stellen:

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# Bewerk ~/.triggerfish/docker/.env
```

API-sleutels worden doorgaans opgeslagen via `triggerfish config set-secret` (opgeslagen in het datavolume), maar omgevingsvariabelen werken als alternatief.

### Geheimen in Docker

Omdat de OS-sleutelhanger niet beschikbaar is in containers, gebruikt Triggerfish een op bestanden gebaseerde geheimensopslag op `/data/secrets.json` in het volume. Gebruik de CLI-wrapper om geheimen te beheren:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### Gegevenspersistentie

De container slaat alle gegevens op onder `/data`:

| Pad                         | Inhoud                                          |
| --------------------------- | ----------------------------------------------- |
| `/data/triggerfish.yaml`    | Configuratie                                    |
| `/data/secrets.json`        | Op bestanden gebaseerde geheimensopslag         |
| `/data/data/triggerfish.db` | SQLite-database (sessies, cron, geheugen)       |
| `/data/workspace/`          | Agent-werkruimten                               |
| `/data/skills/`             | Geïnstalleerde skills                           |
| `/data/logs/`               | Logbestanden                                    |
| `/data/SPINE.md`            | Agent-identiteit                                |

Gebruik een benoemd volume (`-v triggerfish-data:/data`) of een bind mount om gegevens te bewaren bij containerrestarts.

### De Docker-image lokaal bouwen

```bash
make docker
# of
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### Versievergrendeling (Docker)

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## Installeren vanuit broncode

Als u de voorkeur geeft aan bouwen vanuit broncode of wilt bijdragen:

```bash
# 1. Installeer Deno (als u dat nog niet heeft)
curl -fsSL https://deno.land/install.sh | sh

# 2. Kloon de repository
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. Compileer
deno task compile

# 4. Start de installatiewizard
./triggerfish dive

# 5. (Optioneel) Installeer als achtergrond-daemon
./triggerfish start
```

U kunt ook de gearchiveerde installatiescripts vanuit broncode gebruiken:

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info Bouwen vanuit broncode vereist Deno 2.x en git. De opdracht `deno task compile` produceert een zelfstandige binary zonder externe afhankelijkheden. :::

## Cross-platform binary-builds

Om binaries voor alle platforms te bouwen vanaf elke hostmachine:

```bash
make release
```

Dit produceert alle 5 binaries plus controlesommen in `dist/`:

| Bestand                       | Platform                   |
| ----------------------------- | -------------------------- |
| `triggerfish-linux-x64`       | Linux x86_64               |
| `triggerfish-linux-arm64`     | Linux ARM64                |
| `triggerfish-macos-x64`       | macOS Intel                |
| `triggerfish-macos-arm64`     | macOS Apple Silicon        |
| `triggerfish-windows-x64.exe` | Windows x86_64             |
| `SHA256SUMS.txt`              | Controlesommen voor alle binaries |

## Runtime-map

Na het uitvoeren van `triggerfish dive` bevinden uw configuratie en gegevens zich in `~/.triggerfish/`:

```
~/.triggerfish/
├── triggerfish.yaml          # Hoofdconfiguratie
├── SPINE.md                  # Agent-identiteit en missie (systeemprompt)
├── TRIGGER.md                # Proactieve gedragstriggers
├── workspace/                # Code-werkruimte van de agent
├── skills/                   # Geïnstalleerde skills
├── data/                     # SQLite-database, sessiestatus
└── logs/                     # Daemon- en uitvoeringslogboeken
```

In Docker wordt dit toegewezen aan `/data/` in de container.

## Daemonbeheer

Het installatieprogramma stelt Triggerfish in als een OS-native achtergrondservice:

| Platform | Servicebeheerder                 |
| -------- | -------------------------------- |
| macOS    | launchd                          |
| Linux    | systemd                          |
| Windows  | Windows Service / Taakplanner    |

Na installatie beheert u de daemon met:

```bash
triggerfish start     # Daemon installeren en starten
triggerfish stop      # Daemon stoppen
triggerfish status    # Controleren of de daemon actief is
triggerfish logs      # Daemonlogboeken bekijken
```

## Releaseproces

Releases worden geautomatiseerd via GitHub Actions. Om een nieuwe release te maken:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Dit activeert de release-workflow die alle 5 platform-binaries bouwt, een GitHub Release aanmaakt met controlesommen en een multi-arch Docker-image pusht naar GHCR. De installatiescripts downloaden automatisch de nieuwste release.

## Updaten

Om te controleren op en updates te installeren:

```bash
triggerfish update
```

## Platformondersteuning

| Platform    | Binary | Docker | Installatiescript |
| ----------- | ------ | ------ | ----------------- |
| Linux x64   | ja     | ja     | ja                |
| Linux arm64 | ja     | ja     | ja                |
| macOS x64   | ja     | —      | ja                |
| macOS arm64 | ja     | —      | ja                |
| Windows x64 | ja     | —      | ja (PowerShell)   |

## Volgende stappen

Nu Triggerfish is geïnstalleerd, gaat u naar de [Snel starten](./quickstart)-gids om uw agent te configureren en te beginnen met chatten.
