# நிறுவல் மற்றும் Deployment

Triggerfish macOS, Linux, Windows மற்றும் Docker இல் ஒரே கட்டளையுடன் நிறுவல் செய்கிறது. binary installer கள் முன்கூட்டியே உருவாக்கப்பட்ட release ஐ பதிவிறக்கி, அதன் SHA256 checksum ஐ சரிபார்த்து, setup wizard ஐ இயக்குகின்றன.

## ஒரே கட்டளையில் நிறுவல்

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

### Binary Installer என்ன செய்கிறது

1. **உங்கள் platform மற்றும் architecture ஐ கண்டறிகிறது**
2. **GitHub Releases இலிருந்து** சமீபத்திய முன்கூட்டியே-உருவாக்கப்பட்ட binary ஐ **பதிவிறக்குகிறது**
3. **SHA256 checksum ஐ சரிபார்க்கிறது** — ஒருமைப்பாட்டை உறுதிப்படுத்த
4. `/usr/local/bin` (அல்லது `~/.local/bin` / `%LOCALAPPDATA%\Triggerfish`) க்கு binary ஐ **நிறுவுகிறது**
5. உங்கள் agent, LLM வழங்குநர் மற்றும் சேனல்களை கட்டமைக்க **setup wizard ஐ இயக்குகிறது** (`triggerfish dive`)
6. உங்கள் agent எப்போதும் இயங்குவதற்காக **background daemon ஐ தொடங்குகிறது**

installer முடிந்த பிறகு, முழுமையாக செயல்படும் agent உங்களிடம் இருக்கும். கூடுதல் படிகள் தேவையில்லை.

### குறிப்பிட்ட பதிப்பை நிறுவல்

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## கணினி தேவைகள்

| தேவை              | விவரங்கள்                                                        |
| ----------------- | ----------------------------------------------------------------- |
| இயக்க முறைமை      | macOS, Linux அல்லது Windows                                      |
| disk இடம்         | compiled binary க்கு தோராயமாக 100 MB                            |
| நெட்வொர்க்         | LLM API அழைப்புகளுக்கு தேவை; அனைத்து செயலாக்கமும் உள்ளூரில் இயங்குகிறது |

::: tip Docker இல்லை, container இல்லை, cloud account தேவையில்லை. Triggerfish உங்கள் கணினியில் இயங்கும் ஒரே binary ஆகும். Docker மாற்று deployment முறையாக கிடைக்கிறது. :::

## Docker

Docker deployment உங்களுக்கு native binary போலவே ஒரே கட்டளை அனுபவத்தை வழங்கும் `triggerfish` CLI wrapper வழங்குகிறது. அனைத்து data வும் பெயரிடப்பட்ட Docker volume இல் வாழ்கிறது.

### விரைவு தொடக்கம்

installer image ஐ இழுத்து, CLI wrapper ஐ நிறுவி, setup wizard ஐ இயக்குகிறது:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

அல்லது local checkout இலிருந்து installer ஐ இயக்கவும்:

```bash
./deploy/docker/install.sh
```

installer:

1. உங்கள் container runtime (podman அல்லது docker) ஐ கண்டறிகிறது
2. `~/.local/bin` (அல்லது `/usr/local/bin`) க்கு `triggerfish` CLI wrapper ஐ நிறுவுகிறது
3. `~/.triggerfish/docker/` க்கு compose file ஐ நகலெடுக்கிறது
4. சமீபத்திய image ஐ இழுக்கிறது
5. ஒரு one-shot container இல் setup wizard (`triggerfish dive`) ஐ இயக்குகிறது
6. service ஐ தொடங்குகிறது

### நாளுக்கு நாள் பயன்பாடு

நிறுவலுக்குப் பிறகு, `triggerfish` கட்டளை native binary போலவே செயல்படுகிறது:

```bash
triggerfish chat              # Interactive chat session
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # Health diagnostics
triggerfish logs              # View container logs
triggerfish status            # Check if the container is running
triggerfish stop              # Stop the container
triggerfish start             # Start the container
triggerfish update            # Pull latest image and restart
triggerfish dive              # Re-run setup wizard
```

### Wrapper எவ்வாறு செயல்படுகிறது

wrapper script (`deploy/docker/triggerfish`) கட்டளைகளை route செய்கிறது:

| கட்டளை          | நடத்தை                                                           |
| --------------- | ----------------------------------------------------------------- |
| `start`         | compose மூலம் container ஐ தொடங்குகிறது                           |
| `stop`          | compose மூலம் container ஐ நிறுத்துகிறது                          |
| `run`           | foreground இல் இயக்குகிறது (நிறுத்த Ctrl+C)                     |
| `status`        | container இயங்கும் நிலையை காட்டுகிறது                           |
| `logs`          | container logs ஐ stream செய்கிறது                                |
| `update`        | சமீபத்திய image ஐ இழுத்து, மறுதொடக்கம் செய்கிறது               |
| `dive`          | இயங்கவில்லை என்றால் one-shot container; இயங்கினால் exec + restart |
| மற்ற எல்லாமே   | இயங்கும் container க்கு `exec` செய்கிறது                        |

wrapper `podman` vs `docker` ஐ தானாக கண்டறிகிறது. `TRIGGERFISH_CONTAINER_RUNTIME=docker` மூலம் override செய்யவும்.

### Docker Compose

compose file நிறுவலுக்குப் பிறகு `~/.triggerfish/docker/docker-compose.yml` இல் உள்ளது. நேரடியாகவும் பயன்படுத்தலாம்:

```bash
cd deploy/docker
docker compose up -d
```

### Environment Variables

API விசைகளை environment variables மூலம் அமைக்க `.env.example` ஐ `.env` க்கு நகலெடுக்கவும்:

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# Edit ~/.triggerfish/docker/.env
```

API விசைகள் பொதுவாக `triggerfish config set-secret` மூலம் சேமிக்கப்படுகின்றன (data volume இல் நிலைத்திருக்கும்), ஆனால் environment variables மாற்றாக செயல்படும்.

### Docker இல் Secrets

OS keychain container களில் கிடைக்காததால், Triggerfish volume க்கு உள்ளே `/data/secrets.json` இல் file-backed secret store ஐ பயன்படுத்துகிறது. secrets நிர்வகிக்க CLI wrapper பயன்படுத்தவும்:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### Data நிலைத்தன்மை

container அனைத்து data வையும் `/data` இல் சேமிக்கிறது:

| பாதை                        | உள்ளடக்கங்கள்                                   |
| --------------------------- | ------------------------------------------------ |
| `/data/triggerfish.yaml`    | கட்டமைப்பு                                      |
| `/data/secrets.json`        | File-backed secret store                         |
| `/data/data/triggerfish.db` | SQLite database (sessions, cron, memory)         |
| `/data/workspace/`          | Agent workspaces                                 |
| `/data/skills/`             | நிறுவப்பட்ட skills                              |
| `/data/logs/`               | Log files                                        |
| `/data/SPINE.md`            | Agent அடையாளம்                                  |

container மறுதொடக்கங்களில் நிலைத்திருக்க பெயரிடப்பட்ட volume (`-v triggerfish-data:/data`) அல்லது bind mount பயன்படுத்தவும்.

### Docker Image ஐ உள்ளூரில் உருவாக்குதல்

```bash
make docker
# or
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### Version Pinning (Docker)

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## மூலத்திலிருந்து நிறுவல்

மூலத்திலிருந்து build செய்வதை விரும்பினால் அல்லது பங்களிக்க விரும்பினால்:

```bash
# 1. Deno நிறுவுங்கள் (இல்லையென்றால்)
curl -fsSL https://deno.land/install.sh | sh

# 2. repository ஐ clone செய்யுங்கள்
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. Compile செய்யுங்கள்
deno task compile

# 4. setup wizard ஐ இயக்குங்கள்
./triggerfish dive

# 5. (ஐச்சரியமாக) background daemon ஆக நிறுவுங்கள்
./triggerfish start
```

மாற்றாக, archived from-source install scripts பயன்படுத்தவும்:

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info மூலத்திலிருந்து build செய்ய Deno 2.x மற்றும் git தேவை. `deno task compile` கட்டளை வெளிப்புற dependencies இல்லாத self-contained binary உருவாக்குகிறது. :::

## Cross-Platform Binary Builds

எந்த host கணினியிலிருந்தும் அனைத்து platforms க்கும் binaries உருவாக்க:

```bash
make release
```

இது `dist/` இல் 5 binaries மற்றும் checksums உருவாக்குகிறது:

| கோப்பு                        | Platform                   |
| ----------------------------- | -------------------------- |
| `triggerfish-linux-x64`       | Linux x86_64               |
| `triggerfish-linux-arm64`     | Linux ARM64                |
| `triggerfish-macos-x64`       | macOS Intel                |
| `triggerfish-macos-arm64`     | macOS Apple Silicon        |
| `triggerfish-windows-x64.exe` | Windows x86_64             |
| `SHA256SUMS.txt`              | அனைத்து binaries க்கும் Checksums |

## Runtime Directory

`triggerfish dive` இயக்கிய பிறகு, உங்கள் கட்டமைப்பு மற்றும் data `~/.triggerfish/` இல் வாழ்கின்றன:

```
~/.triggerfish/
├── triggerfish.yaml          # முதன்மை கட்டமைப்பு
├── SPINE.md                  # Agent அடையாளம் மற்றும் mission (system prompt)
├── TRIGGER.md                # முன்கூட்டிய நடத்தை triggers
├── workspace/                # Agent கோட் workspace
├── skills/                   # நிறுவப்பட்ட skills
├── data/                     # SQLite database, session state
└── logs/                     # Daemon மற்றும் execution logs
```

Docker இல், இது container க்கு உள்ளே `/data/` க்கு map ஆகிறது.

## Daemon நிர்வாகம்

installer Triggerfish ஐ OS-native background service ஆக அமைக்கிறது:

| Platform | Service Manager                  |
| -------- | -------------------------------- |
| macOS    | launchd                          |
| Linux    | systemd                          |
| Windows  | Windows Service / Task Scheduler |

நிறுவலுக்குப் பிறகு, daemon ஐ நிர்வகிக்கவும்:

```bash
triggerfish start     # daemon ஐ நிறுவி தொடங்குங்கள்
triggerfish stop      # daemon ஐ நிறுத்துங்கள்
triggerfish status    # daemon இயங்குகிறதா என்று சரிபாருங்கள்
triggerfish logs      # daemon logs பாருங்கள்
```

## Release செயல்முறை

Releases GitHub Actions மூலம் தானியங்கி ஆகும். புதிய release உருவாக்க:

```bash
git tag v0.2.0
git push origin v0.2.0
```

இது release workflow ஐ தூண்டுகிறது, இது 5 platform binaries உருவாக்கி, checksums உடன் GitHub Release உருவாக்கி, GHCR க்கு multi-arch Docker image push செய்கிறது. install scripts தானாக சமீபத்திய release ஐ பதிவிறக்குகின்றன.

## புதுப்பிக்கிறது

புதுப்பிப்புகளை சரிபார்த்து நிறுவ:

```bash
triggerfish update
```

## Platform ஆதரவு

| Platform    | Binary | Docker | Install Script   |
| ----------- | ------ | ------ | ---------------- |
| Linux x64   | ஆம்    | ஆம்    | ஆம்              |
| Linux arm64 | ஆம்    | ஆம்    | ஆம்              |
| macOS x64   | ஆம்    | —      | ஆம்              |
| macOS arm64 | ஆம்    | —      | ஆம்              |
| Windows x64 | ஆம்    | —      | ஆம் (PowerShell) |

## அடுத்த படிகள்

Triggerfish நிறுவிய பிறகு, உங்கள் agent ஐ கட்டமைத்து chat தொடங்க [விரைவு தொடக்கம்](./quickstart) வழிகாட்டிக்கு செல்லுங்கள்.
