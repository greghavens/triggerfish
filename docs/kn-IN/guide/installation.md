# ಸ್ಥಾಪನೆ ಮತ್ತು ನಿಯೋಜನೆ

Triggerfish macOS, Linux, Windows ಮತ್ತು Docker ನಲ್ಲಿ ಒಂದೇ ಆಜ್ಞೆಯಿಂದ ಸ್ಥಾಪಿಸಲ್ಪಡುತ್ತದೆ.
ಬೈನರಿ ಇನ್‌ಸ್ಟಾಲರ್‌ಗಳು ಪೂರ್ವನಿರ್ಮಿತ ರಿಲೀಸ್ ಡೌನ್‌ಲೋಡ್ ಮಾಡುತ್ತವೆ, ಅದರ SHA256 ಚೆಕ್‌ಸಮ್ ಪರಿಶೀಲಿಸುತ್ತವೆ
ಮತ್ತು ಸೆಟಪ್ ವಿಝಾರ್ಡ್ ಚಲಾಯಿಸುತ್ತವೆ.

## ಒಂದು-ಆಜ್ಞೆ ಸ್ಥಾಪನೆ

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

### ಬೈನರಿ ಇನ್‌ಸ್ಟಾಲರ್ ಏನು ಮಾಡುತ್ತದೆ

1. **ನಿಮ್ಮ ಪ್ಲ್ಯಾಟ್‌ಫಾರ್ಮ್ ಮತ್ತು ಆರ್ಕಿಟೆಕ್ಚರ್ ಪತ್ತೆ ಮಾಡುತ್ತದೆ**
2. GitHub Releases ನಿಂದ ಇತ್ತೀಚಿನ ಪೂರ್ವನಿರ್ಮಿತ ಬೈನರಿ **ಡೌನ್‌ಲೋಡ್** ಮಾಡುತ್ತದೆ
3. ಸಮಗ್ರತೆ ಖಚಿತಪಡಿಸಲು **SHA256 ಚೆಕ್‌ಸಮ್ ಪರಿಶೀಲಿಸುತ್ತದೆ**
4. `/usr/local/bin` ಗೆ ಬೈನರಿ **ಸ್ಥಾಪಿಸುತ್ತದೆ** (ಅಥವಾ `~/.local/bin` / `%LOCALAPPDATA%\Triggerfish`)
5. ನಿಮ್ಮ ಏಜೆಂಟ್, LLM ಪ್ರದಾಯಕ ಮತ್ತು ಚಾನೆಲ್‌ಗಳನ್ನು ಕಾನ್ಫಿಗರ್ ಮಾಡಲು **ಸೆಟಪ್ ವಿಝಾರ್ಡ್ ಚಲಾಯಿಸುತ್ತದೆ** (`triggerfish dive`)
6. ನಿಮ್ಮ ಏಜೆಂಟ್ ಯಾವಾಗಲೂ ಚಾಲೂ ಇರಲು **ಹಿನ್ನೆಲೆ ಡೀಮನ್ ಪ್ರಾರಂಭಿಸುತ್ತದೆ**

ಇನ್‌ಸ್ಟಾಲರ್ ಮುಗಿದ ನಂತರ, ನಿಮಗೆ ಸಂಪೂರ್ಣ ಕಾರ್ಯನಿರ್ವಹಿಸುವ ಏಜೆಂಟ್ ಇದೆ. ಯಾವುದೇ ಹೆಚ್ಚುವರಿ
ಹಂತಗಳ ಅಗತ್ಯವಿಲ್ಲ.

### ನಿರ್ದಿಷ್ಟ ಆವೃತ್ತಿ ಸ್ಥಾಪಿಸಿ

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## ಸಿಸ್ಟಂ ಅವಶ್ಯಕತೆಗಳು

| ಅವಶ್ಯಕತೆ       | ವಿವರಗಳು                                                               |
| -------------- | --------------------------------------------------------------------- |
| ಆಪರೇಟಿಂಗ್ ಸಿಸ್ಟಂ | macOS, Linux ಅಥವಾ Windows                                             |
| ಡಿಸ್ಕ್ ಸ್ಥಳ     | ಸಂಕಲಿಸಿದ ಬೈನರಿಗಾಗಿ ಸರಿಸುಮಾರು 100 MB                                  |
| ನೆಟ್‌ವರ್ಕ್      | LLM API ಕರೆಗಳಿಗೆ ಅಗತ್ಯ; ಎಲ್ಲ ಪ್ರಕ್ರಿಯೆ ಸ್ಥಳೀಯವಾಗಿ ಚಲಿಸುತ್ತದೆ         |

::: tip Docker, containers, cloud accounts ಅಗತ್ಯವಿಲ್ಲ. Triggerfish ನಿಮ್ಮ ಯಂತ್ರದಲ್ಲಿ
ಚಲಿಸುವ ಒಂದೇ ಬೈನರಿ. Docker ಪರ್ಯಾಯ ನಿಯೋಜನಾ ವಿಧಾನವಾಗಿ ಲಭ್ಯ. :::

## Docker

Docker ನಿಯೋಜನೆ `triggerfish` CLI wrapper ಒದಗಿಸುತ್ತದೆ ಅದು ನಿಮಗೆ ಸ್ಥಳೀಯ ಬೈನರಿಯಂತೆಯೇ
ಆಜ್ಞೆ ಅನುಭವ ನೀಡುತ್ತದೆ. ಎಲ್ಲ ಡೇಟಾ ಹೆಸರಿಸಲಾದ Docker volume ನಲ್ಲಿ ಇರುತ್ತದೆ.

### ತ್ವರಿತ ಪ್ರಾರಂಭ

ಇನ್‌ಸ್ಟಾಲರ್ image ಎಳೆಯುತ್ತದೆ, CLI wrapper ಸ್ಥಾಪಿಸುತ್ತದೆ ಮತ್ತು ಸೆಟಪ್ ವಿಝಾರ್ಡ್ ಚಲಾಯಿಸುತ್ತದೆ:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

ಸ್ಥಳೀಯ ಚೆಕ್‌ಔಟ್‌ನಿಂದ ಇನ್‌ಸ್ಟಾಲರ್ ಚಲಾಯಿಸಿ:

```bash
./deploy/docker/install.sh
```

ಇನ್‌ಸ್ಟಾಲರ್ ಮಾಡುವುದು:

1. ನಿಮ್ಮ container runtime (podman ಅಥವಾ docker) ಪತ್ತೆ ಮಾಡುತ್ತದೆ
2. `triggerfish` CLI wrapper ಅನ್ನು `~/.local/bin` ಗೆ ಸ್ಥಾಪಿಸುತ್ತದೆ
3. compose ಫೈಲ್ ಅನ್ನು `~/.triggerfish/docker/` ಗೆ ಕಾಪಿ ಮಾಡುತ್ತದೆ
4. ಇತ್ತೀಚಿನ image ಎಳೆಯುತ್ತದೆ
5. ಒಂದು-ಶಾಟ್ container ನಲ್ಲಿ ಸೆಟಪ್ ವಿಝಾರ್ಡ್ ಚಲಾಯಿಸುತ್ತದೆ (`triggerfish dive`)
6. ಸೇವೆ ಪ್ರಾರಂಭಿಸುತ್ತದೆ

### ದಿನನಿತ್ಯ ಬಳಕೆ

ಸ್ಥಾಪನೆಯ ನಂತರ, `triggerfish` ಆಜ್ಞೆ ಸ್ಥಳೀಯ ಬೈನರಿಯಂತೆಯೇ ಕಾರ್ಯನಿರ್ವಹಿಸುತ್ತದೆ:

```bash
triggerfish chat              # ಸಂವಾದಾತ್ಮಕ ಚಾಟ್ ಸೆಷನ್
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # ಆರೋಗ್ಯ ರೋಗನಿರ್ಣಯ
triggerfish logs              # container ಲಾಗ್‌ಗಳು ನೋಡಿ
triggerfish status            # container ಚಾಲೂ ಆಗಿದೆಯೇ ಪರಿಶೀಲಿಸಿ
triggerfish stop              # container ನಿಲ್ಲಿಸಿ
triggerfish start             # container ಪ್ರಾರಂಭಿಸಿ
triggerfish update            # ಇತ್ತೀಚಿನ image ಎಳೆಯಿರಿ ಮತ್ತು ಮರುಪ್ರಾರಂಭಿಸಿ
triggerfish dive              # ಸೆಟಪ್ ವಿಝಾರ್ಡ್ ಮತ್ತೆ ಚಲಾಯಿಸಿ
```

### Docker ನಲ್ಲಿ Secrets

OS keychain containers ನಲ್ಲಿ ಲಭ್ಯವಿಲ್ಲದಿರುವುದರಿಂದ, Triggerfish volume ನಲ್ಲಿ
`/data/secrets.json` ನಲ್ಲಿ ಫೈಲ್-ಬ್ಯಾಕ್ಡ್ secret store ಬಳಸುತ್ತದೆ:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### ಡೇಟಾ ಸ್ಥಿರತೆ

Container `/data` ಅಡಿ ಎಲ್ಲ ಡೇಟಾ ಸಂಗ್ರಹಿಸುತ್ತದೆ:

| ಮಾರ್ಗ                        | ವಿಷಯಗಳು                                        |
| ---------------------------- | ---------------------------------------------- |
| `/data/triggerfish.yaml`     | ಕಾನ್ಫಿಗರೇಶನ್                                   |
| `/data/secrets.json`         | ಫೈಲ್-ಬ್ಯಾಕ್ಡ್ secret store                      |
| `/data/data/triggerfish.db`  | SQLite ಡೇಟಾಬೇಸ್ (sessions, cron, memory)       |
| `/data/workspace/`           | ಏಜೆಂಟ್ workspaces                               |
| `/data/skills/`              | ಸ್ಥಾಪಿಸಲಾದ skills                               |
| `/data/logs/`                | ಲಾಗ್ ಫೈಲ್‌ಗಳು                                   |
| `/data/SPINE.md`             | ಏಜೆಂಟ್ ಗುರುತು                                   |

## ಮೂಲದಿಂದ ಸ್ಥಾಪಿಸಿ

ನೀವು ಮೂಲದಿಂದ ನಿರ್ಮಿಸಲು ಬಯಸಿದರೆ ಅಥವಾ ಕೊಡುಗೆ ನೀಡಲು ಬಯಸಿದರೆ:

```bash
# 1. Deno ಸ್ಥಾಪಿಸಿ (ಇಲ್ಲದಿದ್ದರೆ)
curl -fsSL https://deno.land/install.sh | sh

# 2. repository ಕ್ಲೋನ್ ಮಾಡಿ
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. ಸಂಕಲಿಸಿ
deno task compile

# 4. ಸೆಟಪ್ ವಿಝಾರ್ಡ್ ಚಲಾಯಿಸಿ
./triggerfish dive

# 5. (ಐಚ್ಛಿಕ) ಹಿನ್ನೆಲೆ ಡೀಮನ್ ಸ್ಥಾಪಿಸಿ
./triggerfish start
```

## ರನ್‌ಟೈಮ್ ಡೈರೆಕ್ಟರಿ

`triggerfish dive` ಚಲಾಯಿಸಿದ ನಂತರ, ನಿಮ್ಮ ಕಾನ್ಫಿಗರೇಶನ್ ಮತ್ತು ಡೇಟಾ `~/.triggerfish/` ನಲ್ಲಿ ಇರುತ್ತದೆ:

```
~/.triggerfish/
├── triggerfish.yaml          # ಮುಖ್ಯ ಕಾನ್ಫಿಗರೇಶನ್
├── SPINE.md                  # ಏಜೆಂಟ್ ಗುರುತು ಮತ್ತು ಮಿಷನ್ (ಸಿಸ್ಟಂ ಪ್ರಾಂಪ್ಟ್)
├── TRIGGER.md                # ಸಕ್ರಿಯ ನಡವಳಿಕೆ ಟ್ರಿಗ್ಗರ್‌ಗಳು
├── workspace/                # ಏಜೆಂಟ್ ಕೋಡ್ workspace
├── skills/                   # ಸ್ಥಾಪಿಸಲಾದ skills
├── data/                     # SQLite ಡೇಟಾಬೇಸ್, session ಸ್ಥಿತಿ
└── logs/                     # ಡೀಮನ್ ಮತ್ತು ಎಕ್ಸಿಕ್ಯೂಶನ್ ಲಾಗ್‌ಗಳು
```

## ಡೀಮನ್ ನಿರ್ವಹಣೆ

ಇನ್‌ಸ್ಟಾಲರ್ Triggerfish ಅನ್ನು OS-ನೇಟಿವ್ ಹಿನ್ನೆಲೆ ಸೇವೆಯಾಗಿ ಸ್ಥಾಪಿಸುತ್ತದೆ:

| ಪ್ಲ್ಯಾಟ್‌ಫಾರ್ಮ್ | ಸೇವಾ ನಿರ್ವಾಹಕ                      |
| ------------- | ----------------------------------- |
| macOS         | launchd                             |
| Linux         | systemd                             |
| Windows       | Windows Service / Task Scheduler    |

ಸ್ಥಾಪನೆಯ ನಂತರ, ಡೀಮನ್ ನಿರ್ವಹಿಸಿ:

```bash
triggerfish start     # ಡೀಮನ್ ಸ್ಥಾಪಿಸಿ ಮತ್ತು ಪ್ರಾರಂಭಿಸಿ
triggerfish stop      # ಡೀಮನ್ ನಿಲ್ಲಿಸಿ
triggerfish status    # ಡೀಮನ್ ಚಾಲೂ ಆಗಿದೆಯೇ ಪರಿಶೀಲಿಸಿ
triggerfish logs      # ಡೀಮನ್ ಲಾಗ್‌ಗಳು ನೋಡಿ
```

## ಅಪ್‌ಡೇಟ್ ಮಾಡುವುದು

ಅಪ್‌ಡೇಟ್‌ಗಳನ್ನು ಪರಿಶೀಲಿಸಿ ಮತ್ತು ಸ್ಥಾಪಿಸಿ:

```bash
triggerfish update
```

## ಪ್ಲ್ಯಾಟ್‌ಫಾರ್ಮ್ ಬೆಂಬಲ

| ಪ್ಲ್ಯಾಟ್‌ಫಾರ್ಮ್    | ಬೈನರಿ | Docker | ಇನ್‌ಸ್ಟಾಲ್ ಸ್ಕ್ರಿಪ್ಟ್    |
| ---------------- | ----- | ------ | --------------------- |
| Linux x64        | ಹೌದು  | ಹೌದು   | ಹೌದು                  |
| Linux arm64      | ಹೌದು  | ಹೌದು   | ಹೌದು                  |
| macOS x64        | ಹೌದು  | —      | ಹೌದು                  |
| macOS arm64      | ಹೌದು  | —      | ಹೌದು                  |
| Windows x64      | ಹೌದು  | —      | ಹೌದು (PowerShell)     |

## ಮುಂದಿನ ಹೆಜ್ಜೆಗಳು

Triggerfish ಸ್ಥಾಪಿಸಿದ ನಂತರ, ನಿಮ್ಮ ಏಜೆಂಟ್ ಕಾನ್ಫಿಗರ್ ಮಾಡಲು ಮತ್ತು ಚಾಟ್ ಪ್ರಾರಂಭಿಸಲು
[ತ್ವರಿತ ಪ್ರಾರಂಭ](./quickstart) ಮಾರ್ಗದರ್ಶಿಗೆ ಹೋಗಿ.
