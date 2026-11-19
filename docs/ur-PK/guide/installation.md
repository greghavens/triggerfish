# انسٹالیشن اور تعیناتی

Triggerfish macOS، Linux، Windows، اور Docker پر ایک ہی کمانڈ سے انسٹال ہوتا ہے۔
بائنری انسٹالرز ایک پہلے سے تیار ریلیز ڈاؤن لوڈ کرتے ہیں، اس کا SHA256 checksum تصدیق
کرتے ہیں، اور setup wizard چلاتے ہیں۔

## ایک کمانڈ میں انسٹال کریں

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

### بائنری انسٹالر کیا کرتا ہے

1. **آپ کا پلیٹ فارم** اور architecture کا پتہ لگاتا ہے
2. GitHub Releases سے سب سے نئی پہلے سے تیار بائنری **ڈاؤن لوڈ** کرتا ہے
3. سالمیت کو یقینی بنانے کے لیے **SHA256 checksum تصدیق** کرتا ہے
4. بائنری کو `/usr/local/bin` (یا `~/.local/bin` /
   `%LOCALAPPDATA%\Triggerfish`) میں **انسٹال** کرتا ہے
5. آپ کے ایجنٹ، LLM فراہم کنندہ، اور channels ترتیب دینے کے لیے **setup wizard** (`triggerfish dive`) **چلاتا ہے**
6. **بیک گراؤنڈ daemon شروع** کرتا ہے تاکہ آپ کا ایجنٹ ہمیشہ چلتا رہے

انسٹالر مکمل ہونے کے بعد آپ کے پاس مکمل طور پر کام کرنے والا ایجنٹ ہے۔ کوئی اضافی
اقدامات درکار نہیں۔

### ایک مخصوص ورژن انسٹال کریں

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## سسٹم کی ضروریات

| ضرورت             | تفصیلات                                                     |
| ----------------- | ----------------------------------------------------------- |
| آپریٹنگ سسٹم      | macOS، Linux، یا Windows                                    |
| ڈسک اسپیس         | مرتب شدہ بائنری کے لیے تقریباً 100 MB                      |
| نیٹ ورک           | LLM API کالز کے لیے درکار؛ تمام پروسیسنگ مقامی طور پر چلتی ہے |

::: tip کوئی Docker نہیں، کوئی containers نہیں، کوئی cloud accounts درکار نہیں۔ Triggerfish ایک
واحد بائنری ہے جو آپ کی مشین پر چلتی ہے۔ Docker متبادل تعیناتی طریقہ کے طور پر دستیاب ہے۔ :::

## Docker

Docker تعیناتی ایک `triggerfish` CLI wrapper فراہم کرتی ہے جو آپ کو مقامی بائنری
جیسا ہی کمانڈ تجربہ دیتی ہے۔ تمام ڈیٹا ایک named Docker volume میں رہتا ہے۔

### فوری شروعات

انسٹالر image کھینچتا ہے، CLI wrapper انسٹال کرتا ہے، اور setup wizard چلاتا ہے:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

یا مقامی checkout سے انسٹالر چلائیں:

```bash
./deploy/docker/install.sh
```

انسٹالر:

1. آپ کا container runtime (podman یا docker) تلاش کرتا ہے
2. `triggerfish` CLI wrapper کو `~/.local/bin` (یا
   `/usr/local/bin`) میں انسٹال کرتا ہے
3. compose file کو `~/.triggerfish/docker/` میں کاپی کرتا ہے
4. سب سے نئی image کھینچتا ہے
5. ایک one-shot container میں setup wizard (`triggerfish dive`) چلاتا ہے
6. سروس شروع کرتا ہے

### روزمرہ استعمال

انسٹالیشن کے بعد، `triggerfish` کمانڈ مقامی بائنری جیسی ہی کام کرتی ہے:

```bash
triggerfish chat              # انٹرایکٹو chat session
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # صحت تشخیص
triggerfish logs              # container logs دیکھیں
triggerfish status            # چیک کریں کہ container چل رہا ہے
triggerfish stop              # container بند کریں
triggerfish start             # container شروع کریں
triggerfish update            # سب سے نئی image کھینچیں اور دوبارہ شروع کریں
triggerfish dive              # setup wizard دوبارہ چلائیں
```

### Wrapper کیسے کام کرتا ہے

wrapper script (`deploy/docker/triggerfish`) کمانڈز کو route کرتا ہے:

| کمانڈ           | عمل                                                          |
| --------------- | ------------------------------------------------------------ |
| `start`         | compose کے ذریعے container شروع کریں                        |
| `stop`          | compose کے ذریعے container بند کریں                         |
| `run`           | پیش منظر میں چلائیں (Ctrl+C سے بند کریں)                   |
| `status`        | container چلنے کی حالت دکھائیں                              |
| `logs`          | container logs stream کریں                                   |
| `update`        | سب سے نئی image کھینچیں، دوبارہ شروع کریں                  |
| `dive`          | اگر نہیں چل رہا تو one-shot container؛ اگر چل رہا تو exec + restart |
| باقی سب کچھ    | چلتے container میں `exec`                                    |

wrapper خود بخود `podman` بمقابلہ `docker` تلاش کرتا ہے۔
`TRIGGERFISH_CONTAINER_RUNTIME=docker` سے اوور رائڈ کریں۔

### Docker Compose

compose file انسٹالیشن کے بعد `~/.triggerfish/docker/docker-compose.yml` میں رہتی ہے۔
آپ اسے براہ راست بھی استعمال کر سکتے ہیں:

```bash
cd deploy/docker
docker compose up -d
```

### ماحولیاتی متغیرات

API کلیدیں ماحولیاتی متغیرات کے ذریعے سیٹ کرنے کے لیے `.env.example` کو compose file
کے ساتھ `.env` میں کاپی کریں:

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# ~/.triggerfish/docker/.env ترمیم کریں
```

API کلیدیں عام طور پر `triggerfish config set-secret` کے ذریعے محفوظ کی جاتی ہیں
(data volume میں محفوظ)، لیکن ماحولیاتی متغیرات متبادل کے طور پر کام کرتے ہیں۔

### Docker میں Secrets

چونکہ OS keychain containers میں دستیاب نہیں، Triggerfish volume کے اندر
`/data/secrets.json` پر file-backed secret store استعمال کرتا ہے۔ secrets
منظم کرنے کے لیے CLI wrapper استعمال کریں:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### ڈیٹا کا تسلسل

container تمام ڈیٹا `/data` کے تحت محفوظ کرتا ہے:

| راستہ                       | مشمولات                                     |
| --------------------------- | ------------------------------------------ |
| `/data/triggerfish.yaml`    | ترتیب                                      |
| `/data/secrets.json`        | File-backed secret store                   |
| `/data/data/triggerfish.db` | SQLite database (sessions، cron، memory)   |
| `/data/workspace/`          | ایجنٹ workspaces                           |
| `/data/skills/`             | انسٹال شدہ skills                          |
| `/data/logs/`               | Log فائلیں                                 |
| `/data/SPINE.md`            | ایجنٹ کی شناخت                             |

Container restarts میں ڈیٹا محفوظ رکھنے کے لیے named volume (`-v triggerfish-data:/data`)
یا bind mount استعمال کریں۔

### Docker Image مقامی طور پر بنانا

```bash
make docker
# یا
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### ورژن پننگ (Docker)

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## سورس سے انسٹال کریں

اگر آپ سورس سے بلڈ کرنا پسند کرتے ہیں یا contribute کرنا چاہتے ہیں:

```bash
# 1. Deno انسٹال کریں (اگر نہیں ہے)
curl -fsSL https://deno.land/install.sh | sh

# 2. repository clone کریں
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. Compile کریں
deno task compile

# 4. setup wizard چلائیں
./triggerfish dive

# 5. (اختیاری) بیک گراؤنڈ daemon کے طور پر انسٹال کریں
./triggerfish start
```

متبادل طور پر، archived from-source install scripts استعمال کریں:

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info سورس سے بلڈ کرنے کے لیے Deno 2.x اور git درکار ہیں۔ `deno task compile`
کمانڈ بغیر کسی بیرونی dependencies کے ایک self-contained بائنری بناتی ہے۔ :::

## تمام پلیٹ فارمز کے لیے بائنری بلڈز

کسی بھی host مشین سے تمام پلیٹ فارمز کے لیے بائنریز بنانے کے لیے:

```bash
make release
```

یہ `dist/` میں تمام 5 بائنریز اور checksums بناتا ہے:

| فائل                          | پلیٹ فارم                  |
| ----------------------------- | -------------------------- |
| `triggerfish-linux-x64`       | Linux x86_64               |
| `triggerfish-linux-arm64`     | Linux ARM64                |
| `triggerfish-macos-x64`       | macOS Intel                |
| `triggerfish-macos-arm64`     | macOS Apple Silicon        |
| `triggerfish-windows-x64.exe` | Windows x86_64             |
| `SHA256SUMS.txt`              | تمام بائنریز کے Checksums  |

## Runtime ڈائریکٹری

`triggerfish dive` چلانے کے بعد، آپ کی ترتیب اور ڈیٹا
`~/.triggerfish/` میں رہتا ہے:

```
~/.triggerfish/
├── triggerfish.yaml          # مرکزی ترتیب
├── SPINE.md                  # ایجنٹ کی شناخت اور مشن (system prompt)
├── TRIGGER.md                # فعال رویے کے triggers
├── workspace/                # ایجنٹ کوڈ workspace
├── skills/                   # انسٹال شدہ skills
├── data/                     # SQLite database، session state
└── logs/                     # Daemon اور execution logs
```

Docker میں، یہ container کے اندر `/data/` سے map ہوتا ہے۔

## Daemon مینجمنٹ

انسٹالر Triggerfish کو OS-native بیک گراؤنڈ سروس کے طور پر ترتیب دیتا ہے:

| پلیٹ فارم | سروس مینیجر                      |
| --------- | -------------------------------- |
| macOS     | launchd                          |
| Linux     | systemd                          |
| Windows   | Windows Service / Task Scheduler |

انسٹالیشن کے بعد، daemon کو ان کمانڈز سے منظم کریں:

```bash
triggerfish start     # Daemon انسٹال اور شروع کریں
triggerfish stop      # Daemon بند کریں
triggerfish status    # چیک کریں کہ daemon چل رہا ہے
triggerfish logs      # Daemon logs دیکھیں
```

## ریلیز پروسیس

ریلیزز GitHub Actions کے ذریعے خودکار ہیں۔ نئی ریلیز بنانے کے لیے:

```bash
git tag v0.2.0
git push origin v0.2.0
```

یہ release workflow کو trigger کرتا ہے جو تمام 5 پلیٹ فارم بائنریز بناتا ہے، checksums کے
ساتھ GitHub Release بناتا ہے، اور GHCR پر multi-arch Docker image push کرتا ہے۔
install scripts خود بخود سب سے نئی ریلیز ڈاؤن لوڈ کرتے ہیں۔

## اپ ڈیٹ کرنا

اپ ڈیٹس چیک کرنے اور انسٹال کرنے کے لیے:

```bash
triggerfish update
```

## پلیٹ فارم سپورٹ

| پلیٹ فارم   | بائنری | Docker | Install Script     |
| ----------- | ------ | ------ | ------------------ |
| Linux x64   | ہاں    | ہاں    | ہاں                |
| Linux arm64 | ہاں    | ہاں    | ہاں                |
| macOS x64   | ہاں    | —      | ہاں                |
| macOS arm64 | ہاں    | —      | ہاں                |
| Windows x64 | ہاں    | —      | ہاں (PowerShell)   |

## اگلے اقدامات

Triggerfish انسٹال ہونے کے بعد، اپنا ایجنٹ ترتیب دینے اور chat شروع کرنے کے لیے
[فوری شروعات](./quickstart) گائیڈ پر جائیں۔
