# इंस्टॉलेशन आणि डिप्लॉयमेंट

Triggerfish macOS, Linux, Windows आणि Docker वर एकाच कमांडने इंस्टॉल होते.
बायनरी इंस्टॉलर एक पूर्व-निर्मित रिलीझ डाउनलोड करतात, त्याचा SHA256 checksum
सत्यापित करतात आणि सेटअप विझार्ड चालवतात.

## एका कमांडमध्ये इंस्टॉल करा

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

### बायनरी इंस्टॉलर काय करतो

1. **तुमचा प्लॅटफॉर्म आणि आर्किटेक्चर शोधतो**
2. **डाउनलोड करतो** GitHub Releases वरून नवीनतम पूर्व-निर्मित बायनरी
3. **SHA256 checksum सत्यापित करतो** अखंडतेची खात्री करण्यासाठी
4. **इंस्टॉल करतो** बायनरी `/usr/local/bin` ला (किंवा `~/.local/bin` /
   `%LOCALAPPDATA%\Triggerfish`)
5. **सेटअप विझार्ड चालवतो** (`triggerfish dive`) तुमचा एजंट, LLM
   प्रदाता आणि channels कॉन्फिगर करण्यासाठी
6. **बॅकग्राउंड daemon सुरू करतो** जेणेकरून तुमचा एजंट नेहमी चालू असतो

इंस्टॉलर पूर्ण झाल्यावर, तुमच्याकडे पूर्णपणे कार्यरत एजंट असतो. कोणत्याही अतिरिक्त
पायऱ्या आवश्यक नाहीत.

### विशिष्ट आवृत्ती इंस्टॉल करा

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## सिस्टम आवश्यकता

| आवश्यकता         | तपशील                                                    |
| ---------------- | -------------------------------------------------------- |
| ऑपरेटिंग सिस्टम | macOS, Linux किंवा Windows                               |
| डिस्क स्पेस      | संकलित बायनरीसाठी अंदाजे 100 MB                          |
| नेटवर्क          | LLM API कॉलसाठी आवश्यक; सर्व प्रक्रिया स्थानिकरित्या चालते |

::: tip कोणता Docker नाही, containers नाहीत, cloud accounts आवश्यक नाहीत. Triggerfish हे
तुमच्या मशीनवर चालणारे एक एकल बायनरी आहे. Docker एक पर्यायी डिप्लॉयमेंट पद्धत म्हणून उपलब्ध आहे. :::

## Docker

Docker डिप्लॉयमेंट एक `triggerfish` CLI wrapper प्रदान करतो जे तुम्हाला मूळ बायनरीसारखाच
कमांड अनुभव देतो. सर्व डेटा नामित Docker volume मध्ये राहतो.

### जलद सुरुवात

इंस्टॉलर इमेज pull करतो, CLI wrapper इंस्टॉल करतो आणि सेटअप विझार्ड चालवतो:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

किंवा स्थानिक checkout मधून इंस्टॉलर चालवा:

```bash
./deploy/docker/install.sh
```

इंस्टॉलर:

1. तुमचा container runtime (podman किंवा docker) शोधतो
2. `triggerfish` CLI wrapper `~/.local/bin` ला (किंवा `/usr/local/bin`) इंस्टॉल करतो
3. compose फाइल `~/.triggerfish/docker/` ला कॉपी करतो
4. नवीनतम इमेज pull करतो
5. one-shot container मध्ये सेटअप विझार्ड (`triggerfish dive`) चालवतो
6. सेवा सुरू करतो

### दैनंदिन वापर

इंस्टॉलेशन नंतर, `triggerfish` कमांड मूळ बायनरीसारखाच कार्य करते:

```bash
triggerfish chat              # इंटरॅक्टिव्ह chat session
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # आरोग्य निदान
triggerfish logs              # container logs पाहा
triggerfish status            # container चालू आहे का ते तपासा
triggerfish stop              # container थांबवा
triggerfish start             # container सुरू करा
triggerfish update            # नवीनतम इमेज pull करा आणि पुन्हा सुरू करा
triggerfish dive              # सेटअप विझार्ड पुन्हा चालवा
```

### Wrapper कसे कार्य करते

wrapper script (`deploy/docker/triggerfish`) कमांड्स रूट करते:

| कमांड           | वर्तन                                                        |
| --------------- | ------------------------------------------------------------ |
| `start`         | compose द्वारे container सुरू करा                            |
| `stop`          | compose द्वारे container थांबवा                              |
| `run`           | foreground मध्ये चालवा (थांबवण्यासाठी Ctrl+C)               |
| `status`        | container चालू स्थिती दाखवा                                   |
| `logs`          | container logs stream करा                                    |
| `update`        | नवीनतम इमेज pull करा, पुन्हा सुरू करा                        |
| `dive`          | चालू नसल्यास one-shot container; चालू असल्यास exec + restart |
| इतर सर्व        | चालू container मध्ये `exec` करा                              |

wrapper स्वयंचलितपणे `podman` विरुद्ध `docker` शोधतो. `TRIGGERFISH_CONTAINER_RUNTIME=docker`
सह ओव्हरराइड करा.

### Docker Compose

compose फाइल इंस्टॉलेशन नंतर `~/.triggerfish/docker/docker-compose.yml` येथे असते.
तुम्ही ते थेट देखील वापरू शकता:

```bash
cd deploy/docker
docker compose up -d
```

### पर्यावरण चल

API keys पर्यावरण चलांद्वारे सेट करण्यासाठी compose फाइलच्या बाजूला `.env.example` ला
`.env` म्हणून कॉपी करा:

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# ~/.triggerfish/docker/.env संपादित करा
```

API keys सामान्यतः `triggerfish config set-secret` द्वारे संग्रहित केले जातात (data
volume मध्ये टिकवलेले), परंतु पर्यावरण चल एक पर्याय म्हणून कार्य करतात.

### Docker मधील Secrets

OS keychain containers मध्ये उपलब्ध नसल्याने, Triggerfish volume मध्ये
`/data/secrets.json` येथे file-backed secret store वापरतो. Secrets व्यवस्थापित
करण्यासाठी CLI wrapper वापरा:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### डेटा सातत्य

container सर्व डेटा `/data` खाली संग्रहित करतो:

| पथ                          | सामग्री                                    |
| --------------------------- | ------------------------------------------ |
| `/data/triggerfish.yaml`    | कॉन्फिगरेशन                                |
| `/data/secrets.json`        | File-backed secret store                   |
| `/data/data/triggerfish.db` | SQLite database (sessions, cron, memory)   |
| `/data/workspace/`          | एजंट workspaces                            |
| `/data/skills/`             | इंस्टॉल केलेल्या skills                    |
| `/data/logs/`               | Log फाइल्स                                 |
| `/data/SPINE.md`            | एजंट ओळख                                   |

container restarts मध्ये टिकवण्यासाठी नामित volume (`-v triggerfish-data:/data`) किंवा
bind mount वापरा.

### Docker इमेज स्थानिकरित्या बनवा

```bash
make docker
# किंवा
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### आवृत्ती Pinning (Docker)

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## स्रोतातून इंस्टॉल करा

जर तुम्हाला स्रोतातून बनवणे आवडत असेल किंवा योगदान द्यायचे असेल:

```bash
# 1. Deno इंस्टॉल करा (नसल्यास)
curl -fsSL https://deno.land/install.sh | sh

# 2. repository clone करा
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. संकलित करा
deno task compile

# 4. सेटअप विझार्ड चालवा
./triggerfish dive

# 5. (ऐच्छिक) बॅकग्राउंड daemon म्हणून इंस्टॉल करा
./triggerfish start
```

वैकल्पिकरित्या, archived from-source install scripts वापरा:

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info स्रोतातून बनवण्यासाठी Deno 2.x आणि git आवश्यक आहेत. `deno task compile`
कमांड कोणत्याही बाह्य अवलंबनांशिवाय self-contained बायनरी तयार करते. :::

## क्रॉस-प्लॅटफॉर्म बायनरी बिल्ड्स

कोणत्याही host मशीनवरून सर्व प्लॅटफॉर्मसाठी बायनरी बनवण्यासाठी:

```bash
make release
```

हे `dist/` मध्ये सर्व 5 बायनरी आणि checksums तयार करते:

| फाइल                          | प्लॅटफॉर्म                  |
| ----------------------------- | ---------------------------- |
| `triggerfish-linux-x64`       | Linux x86_64                 |
| `triggerfish-linux-arm64`     | Linux ARM64                  |
| `triggerfish-macos-x64`       | macOS Intel                  |
| `triggerfish-macos-arm64`     | macOS Apple Silicon          |
| `triggerfish-windows-x64.exe` | Windows x86_64               |
| `SHA256SUMS.txt`              | सर्व बायनरींसाठी Checksums   |

## Runtime निर्देशिका

`triggerfish dive` चालवल्यानंतर, तुमचे कॉन्फिगरेशन आणि डेटा
`~/.triggerfish/` येथे राहतात:

```
~/.triggerfish/
├── triggerfish.yaml          # मुख्य कॉन्फिगरेशन
├── SPINE.md                  # एजंट ओळख आणि मिशन (system prompt)
├── TRIGGER.md                # सक्रिय वर्तन triggers
├── workspace/                # एजंट कोड workspace
├── skills/                   # इंस्टॉल केलेल्या skills
├── data/                     # SQLite database, session state
└── logs/                     # Daemon आणि अंमलबजावणी logs
```

Docker मध्ये, हे container मध्ये `/data/` ला map होते.

## Daemon व्यवस्थापन

इंस्टॉलर Triggerfish ला OS-native बॅकग्राउंड सेवा म्हणून सेट करतो:

| प्लॅटफॉर्म | सेवा व्यवस्थापक                  |
| ---------- | -------------------------------- |
| macOS      | launchd                          |
| Linux      | systemd                          |
| Windows    | Windows Service / Task Scheduler |

इंस्टॉलेशन नंतर, daemon यासह व्यवस्थापित करा:

```bash
triggerfish start     # daemon इंस्टॉल करा आणि सुरू करा
triggerfish stop      # daemon थांबवा
triggerfish status    # daemon चालू आहे का ते तपासा
triggerfish logs      # daemon logs पाहा
```

## रिलीझ प्रक्रिया

रिलीझ GitHub Actions द्वारे स्वयंचलित आहेत. नवीन रिलीझ तयार करण्यासाठी:

```bash
git tag v0.2.0
git push origin v0.2.0
```

हे release workflow ट्रिगर करते जे सर्व 5 प्लॅटफॉर्म बायनरी बनवते, checksums
सह GitHub Release तयार करते आणि GHCR वर multi-arch Docker इमेज push करते.
install scripts स्वयंचलितपणे नवीनतम रिलीझ डाउनलोड करतात.

## अपडेट करणे

अपडेट तपासण्यासाठी आणि इंस्टॉल करण्यासाठी:

```bash
triggerfish update
```

## प्लॅटफॉर्म समर्थन

| प्लॅटफॉर्म   | बायनरी | Docker | Install Script   |
| ------------ | ------ | ------ | ---------------- |
| Linux x64    | हो     | हो     | हो               |
| Linux arm64  | हो     | हो     | हो               |
| macOS x64    | हो     | —      | हो               |
| macOS arm64  | हो     | —      | हो               |
| Windows x64  | हो     | —      | हो (PowerShell)  |

## पुढील पायऱ्या

Triggerfish इंस्टॉल झाल्यावर, तुमचा एजंट कॉन्फिगर करण्यासाठी आणि chat सुरू करण्यासाठी
[जलद सुरुवात](./quickstart) मार्गदर्शकाकडे जा.
