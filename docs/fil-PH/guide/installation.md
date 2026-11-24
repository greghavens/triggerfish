# Installation at Deployment

Nag-i-install ang Triggerfish sa isang command sa macOS, Linux, Windows, at Docker.
Ang mga binary installer ay nagda-download ng pre-built release, nag-ve-verify ng SHA256 checksum,
at nagpapatakbo ng setup wizard.

## One-Command Install

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

### Ano ang Ginagawa ng Binary Installer

1. **Dine-detect ang iyong platform** at architecture
2. **Nagda-download** ng pinakabagong pre-built binary mula sa GitHub Releases
3. **Nag-ve-verify ng SHA256 checksum** para matiyak ang integrity
4. **Nag-i-install** ng binary sa `/usr/local/bin` (o `~/.local/bin` /
   `%LOCALAPPDATA%\Triggerfish`)
5. **Pinapatakbo ang setup wizard** (`triggerfish dive`) para i-configure ang iyong agent, LLM
   provider, at channels
6. **Sinisimulan ang background daemon** para palaging tumatakbo ang iyong agent

Pagkatapos matapos ang installer, mayroon ka nang gumaganang agent. Walang karagdagang
mga hakbang na kailangan.

### Mag-install ng Partikular na Bersyon

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## Mga Kinakailangan sa System

| Kinakailangan    | Mga Detalye                                                     |
| ---------------- | --------------------------------------------------------------- |
| Operating System | macOS, Linux, o Windows                                         |
| Disk Space       | Humigit-kumulang 100 MB para sa compiled binary                 |
| Network          | Kinakailangan para sa LLM API calls; lahat ng processing ay lokal |

::: tip Walang Docker, walang containers, walang cloud accounts na kailangan. Ang Triggerfish ay isang
single binary na tumatakbo sa iyong machine. Ang Docker ay available bilang alternatibong
deployment method. :::

## Docker

Ang Docker deployment ay nagbibigay ng `triggerfish` CLI wrapper na nagbibigay sa iyo ng
parehong command experience tulad ng native binary. Lahat ng data ay nasa isang named Docker
volume.

### Quick Start

Ang installer ay nagpu-pull ng image, nag-i-install ng CLI wrapper, at pinapatakbo ang setup
wizard:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

O patakbuhin ang installer mula sa isang local checkout:

```bash
./deploy/docker/install.sh
```

Ang installer ay:

1. Dine-detect ang iyong container runtime (podman o docker)
2. Nag-i-install ng `triggerfish` CLI wrapper sa `~/.local/bin` (o
   `/usr/local/bin`)
3. Kino-copy ang compose file sa `~/.triggerfish/docker/`
4. Nagpu-pull ng pinakabagong image
5. Pinapatakbo ang setup wizard (`triggerfish dive`) sa isang one-shot container
6. Sinisimulan ang serbisyo

### Pang-araw-araw na Paggamit

Pagkatapos ng installation, ang `triggerfish` command ay gumagana nang katulad ng native
binary:

```bash
triggerfish chat              # Interactive chat session
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # Health diagnostics
triggerfish logs              # Tingnan ang container logs
triggerfish status            # Tingnan kung tumatakbo ang container
triggerfish stop              # Ihinto ang container
triggerfish start             # Simulan ang container
triggerfish update            # I-pull ang pinakabagong image at i-restart
triggerfish dive              # Patakbuhin ulit ang setup wizard
```

### Paano Gumagana ang Wrapper

Ang wrapper script (`deploy/docker/triggerfish`) ay nagro-route ng mga commands:

| Command         | Behavior                                                             |
| --------------- | -------------------------------------------------------------------- |
| `start`         | Simulan ang container sa pamamagitan ng compose                      |
| `stop`          | Ihinto ang container sa pamamagitan ng compose                       |
| `run`           | Patakbuhin sa foreground (Ctrl+C para ihinto)                        |
| `status`        | Ipakita ang running state ng container                               |
| `logs`          | I-stream ang container logs                                          |
| `update`        | I-pull ang pinakabagong image, i-restart                             |
| `dive`          | One-shot container kung hindi tumatakbo; exec + restart kung tumatakbo |
| Lahat ng iba pa | `exec` sa tumatakbong container                                      |

Awtomatikong dine-detect ng wrapper ang `podman` vs `docker`. I-override gamit ang
`TRIGGERFISH_CONTAINER_RUNTIME=docker`.

### Docker Compose

Ang compose file ay matatagpuan sa `~/.triggerfish/docker/docker-compose.yml` pagkatapos ng
installation. Maaari mo rin itong gamitin nang direkta:

```bash
cd deploy/docker
docker compose up -d
```

### Environment Variables

I-copy ang `.env.example` sa `.env` katabi ng compose file para mag-set ng API keys sa pamamagitan ng
environment variables:

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# I-edit ang ~/.triggerfish/docker/.env
```

Ang mga API keys ay karaniwang iniimbak sa pamamagitan ng `triggerfish config set-secret` (naka-persist sa
data volume), ngunit ang environment variables ay gumagana bilang alternatibo.

### Mga Secrets sa Docker

Dahil hindi available ang OS keychain sa mga containers, gumagamit ang Triggerfish ng
file-backed na secret store sa `/data/secrets.json` sa loob ng volume. Gamitin ang CLI
wrapper para i-manage ang mga secrets:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### Data Persistence

Iniimbak ng container ang lahat ng data sa ilalim ng `/data`:

| Path                        | Nilalaman                                |
| --------------------------- | ---------------------------------------- |
| `/data/triggerfish.yaml`    | Configuration                            |
| `/data/secrets.json`        | File-backed secret store                 |
| `/data/data/triggerfish.db` | SQLite database (sessions, cron, memory) |
| `/data/workspace/`          | Agent workspaces                         |
| `/data/skills/`             | Mga naka-install na skills               |
| `/data/logs/`               | Log files                                |
| `/data/SPINE.md`            | Agent identity                           |

Gumamit ng named volume (`-v triggerfish-data:/data`) o bind mount para ma-persist sa mga
container restart.

### Pag-build ng Docker Image nang Lokal

```bash
make docker
# o
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### Version Pinning (Docker)

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## Mag-install mula sa Source

Kung mas gusto mong mag-build mula sa source o gustong mag-contribute:

```bash
# 1. I-install ang Deno (kung wala ka pa)
curl -fsSL https://deno.land/install.sh | sh

# 2. I-clone ang repository
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. I-compile
deno task compile

# 4. Patakbuhin ang setup wizard
./triggerfish dive

# 5. (Opsyonal) I-install bilang background daemon
./triggerfish start
```

Bilang alternatibo, gamitin ang mga archived from-source install scripts:

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info Ang pag-build mula sa source ay nangangailangan ng Deno 2.x at git. Ang `deno task compile`
command ay gumagawa ng self-contained binary na walang external dependencies. :::

## Cross-Platform Binary Builds

Para mag-build ng mga binary para sa lahat ng platforms mula sa kahit anong host machine:

```bash
make release
```

Gumagawa ito ng lahat ng 5 binaries kasama ang checksums sa `dist/`:

| File                          | Platform                   |
| ----------------------------- | -------------------------- |
| `triggerfish-linux-x64`       | Linux x86_64               |
| `triggerfish-linux-arm64`     | Linux ARM64                |
| `triggerfish-macos-x64`       | macOS Intel                |
| `triggerfish-macos-arm64`     | macOS Apple Silicon        |
| `triggerfish-windows-x64.exe` | Windows x86_64             |
| `SHA256SUMS.txt`              | Checksums para sa lahat ng binaries |

## Runtime Directory

Pagkatapos patakbuhin ang `triggerfish dive`, ang iyong configuration at data ay matatagpuan sa
`~/.triggerfish/`:

```
~/.triggerfish/
├── triggerfish.yaml          # Pangunahing configuration
├── SPINE.md                  # Agent identity at mission (system prompt)
├── TRIGGER.md                # Proactive behavior triggers
├── workspace/                # Agent code workspace
├── skills/                   # Mga naka-install na skills
├── data/                     # SQLite database, session state
└── logs/                     # Daemon at execution logs
```

Sa Docker, naka-map ito sa `/data/` sa loob ng container.

## Pamamahala ng Daemon

Ang installer ay nagse-setup ng Triggerfish bilang OS-native background service:

| Platform | Service Manager                  |
| -------- | -------------------------------- |
| macOS    | launchd                          |
| Linux    | systemd                          |
| Windows  | Windows Service / Task Scheduler |

Pagkatapos ng installation, i-manage ang daemon gamit ang:

```bash
triggerfish start     # I-install at simulan ang daemon
triggerfish stop      # Ihinto ang daemon
triggerfish status    # Tingnan kung tumatakbo ang daemon
triggerfish logs      # Tingnan ang daemon logs
```

## Release Process

Ang mga releases ay awtomatiko sa pamamagitan ng GitHub Actions. Para gumawa ng bagong release:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Pini-trigger nito ang release workflow na nagbu-build ng lahat ng 5 platform binaries, gumagawa
ng GitHub Release na may checksums, at nagpu-push ng multi-arch Docker image sa GHCR.
Awtomatikong dina-download ng mga install scripts ang pinakabagong release.

## Pag-update

Para mag-check at mag-install ng updates:

```bash
triggerfish update
```

## Platform Support

| Platform    | Binary | Docker | Install Script   |
| ----------- | ------ | ------ | ---------------- |
| Linux x64   | oo     | oo     | oo               |
| Linux arm64 | oo     | oo     | oo               |
| macOS x64   | oo     | —      | oo               |
| macOS arm64 | oo     | —      | oo               |
| Windows x64 | oo     | —      | oo (PowerShell)  |

## Mga Susunod na Hakbang

Kapag naka-install na ang Triggerfish, pumunta sa [Quick Start](./quickstart) guide para
i-configure ang iyong agent at magsimulang mag-chat.
