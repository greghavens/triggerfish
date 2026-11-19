# इंस्टॉलेशन और परिनियोजन

Triggerfish macOS, Linux, Windows, और Docker पर एक ही कमांड से इंस्टॉल होता है।
बाइनरी इंस्टॉलर एक पूर्व-निर्मित रिलीज़ डाउनलोड करते हैं, इसके SHA256 चेकसम की
पुष्टि करते हैं, और सेटअप विज़ार्ड चलाते हैं।

## एक-कमांड इंस्टॉल

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

### बाइनरी इंस्टॉलर क्या करता है

1. **आपके प्लेटफ़ॉर्म** और आर्किटेक्चर का पता लगाता है
2. GitHub Releases से नवीनतम पूर्व-निर्मित बाइनरी **डाउनलोड** करता है
3. अखंडता सुनिश्चित करने के लिए **SHA256 चेकसम सत्यापित** करता है
4. बाइनरी को `/usr/local/bin` (या `~/.local/bin` / `%LOCALAPPDATA%\Triggerfish`) में **इंस्टॉल** करता है
5. आपके एजेंट, LLM प्रदाता, और चैनल को कॉन्फ़िगर करने के लिए **सेटअप विज़ार्ड** (`triggerfish dive`) चलाता है
6. **बैकग्राउंड डेमन शुरू** करता है ताकि आपका एजेंट हमेशा चलता रहे

इंस्टॉलर समाप्त होने के बाद, आपके पास एक पूरी तरह काम करने वाला एजेंट है। कोई
अतिरिक्त कदम आवश्यक नहीं।

### विशिष्ट संस्करण इंस्टॉल करें

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## सिस्टम आवश्यकताएँ

| आवश्यकता        | विवरण                                                     |
| --------------- | --------------------------------------------------------- |
| ऑपरेटिंग सिस्टम | macOS, Linux, या Windows                                   |
| डिस्क स्थान      | संकलित बाइनरी के लिए लगभग 100 MB                           |
| नेटवर्क          | LLM API कॉल के लिए आवश्यक; सभी प्रसंस्करण स्थानीय रूप से चलता है |

::: tip Docker, कंटेनर, या क्लाउड खातों की आवश्यकता नहीं। Triggerfish एक
एकल बाइनरी है जो आपकी मशीन पर चलती है। Docker एक वैकल्पिक परिनियोजन
विधि के रूप में उपलब्ध है। :::

## Docker

Docker परिनियोजन एक `triggerfish` CLI रैपर प्रदान करता है जो आपको नेटिव
बाइनरी जैसा ही कमांड अनुभव देता है। सभी डेटा एक नामित Docker वॉल्यूम में रहता है।

### त्वरित शुरुआत

इंस्टॉलर इमेज पुल करता है, CLI रैपर इंस्टॉल करता है, और सेटअप विज़ार्ड चलाता है:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

या स्थानीय चेकआउट से इंस्टॉलर चलाएँ:

```bash
./deploy/docker/install.sh
```

### दैनिक उपयोग

इंस्टॉलेशन के बाद, `triggerfish` कमांड नेटिव बाइनरी की तरह ही काम करता है:

```bash
triggerfish chat              # इंटरैक्टिव चैट सत्र
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # स्वास्थ्य निदान
triggerfish logs              # कंटेनर लॉग देखें
triggerfish status            # जाँचें कि कंटेनर चल रहा है या नहीं
triggerfish stop              # कंटेनर बंद करें
triggerfish start             # कंटेनर शुरू करें
triggerfish update            # नवीनतम इमेज पुल करें और पुनः आरंभ करें
triggerfish dive              # सेटअप विज़ार्ड पुनः चलाएँ
```

### रैपर कैसे काम करता है

रैपर स्क्रिप्ट (`deploy/docker/triggerfish`) कमांड रूट करती है:

| कमांड           | व्यवहार                                                        |
| --------------- | ------------------------------------------------------------- |
| `start`         | compose के माध्यम से कंटेनर शुरू करें                          |
| `stop`          | compose के माध्यम से कंटेनर बंद करें                           |
| `run`           | फ़ोरग्राउंड में चलाएँ (रोकने के लिए Ctrl+C)                    |
| `status`        | कंटेनर की चालू स्थिति दिखाएँ                                   |
| `logs`          | कंटेनर लॉग स्ट्रीम करें                                       |
| `update`        | नवीनतम इमेज पुल करें, पुनः आरंभ करें                          |
| `dive`          | चल नहीं रहा तो एक-बारगी कंटेनर; चल रहा तो exec + पुनः आरंभ |
| बाकी सब कुछ     | चल रहे कंटेनर में `exec`                                     |

रैपर स्वचालित रूप से `podman` बनाम `docker` का पता लगाता है।
`TRIGGERFISH_CONTAINER_RUNTIME=docker` से ओवरराइड करें।

### Docker Compose

compose फ़ाइल इंस्टॉलेशन के बाद `~/.triggerfish/docker/docker-compose.yml` पर होती है।

```bash
cd deploy/docker
docker compose up -d
```

### Docker में सीक्रेट्स

चूँकि कंटेनरों में OS कीचेन उपलब्ध नहीं है, Triggerfish वॉल्यूम के अंदर
`/data/secrets.json` पर फ़ाइल-आधारित सीक्रेट स्टोर का उपयोग करता है:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### डेटा स्थायित्व

कंटेनर `/data` के तहत सभी डेटा संग्रहीत करता है:

| पथ                          | सामग्री                                    |
| --------------------------- | ----------------------------------------- |
| `/data/triggerfish.yaml`    | कॉन्फ़िगरेशन                               |
| `/data/secrets.json`        | फ़ाइल-आधारित सीक्रेट स्टोर                  |
| `/data/data/triggerfish.db` | SQLite डेटाबेस (सत्र, cron, मेमोरी)       |
| `/data/workspace/`          | एजेंट कार्यक्षेत्र                         |
| `/data/skills/`             | इंस्टॉल की गई स्किल्स                      |
| `/data/logs/`               | लॉग फ़ाइलें                                |
| `/data/SPINE.md`            | एजेंट पहचान                               |

## सोर्स से इंस्टॉल करें

यदि आप सोर्स से बिल्ड करना पसंद करते हैं या योगदान करना चाहते हैं:

```bash
# 1. Deno इंस्टॉल करें (यदि आपके पास नहीं है)
curl -fsSL https://deno.land/install.sh | sh

# 2. रिपॉजिटरी क्लोन करें
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. कंपाइल करें
deno task compile

# 4. सेटअप विज़ार्ड चलाएँ
./triggerfish dive

# 5. (वैकल्पिक) बैकग्राउंड डेमन के रूप में इंस्टॉल करें
./triggerfish start
```

::: info सोर्स से बिल्ड करने के लिए Deno 2.x और git की आवश्यकता है। `deno task compile`
कमांड बिना किसी बाहरी निर्भरता के एक स्व-निहित बाइनरी उत्पन्न करता है। :::

## क्रॉस-प्लेटफ़ॉर्म बाइनरी बिल्ड

किसी भी होस्ट मशीन से सभी प्लेटफ़ॉर्म के लिए बाइनरी बनाने के लिए:

```bash
make release
```

## रनटाइम डायरेक्टरी

`triggerfish dive` चलाने के बाद, आपकी कॉन्फ़िगरेशन और डेटा `~/.triggerfish/` में रहती है:

```
~/.triggerfish/
├── triggerfish.yaml          # मुख्य कॉन्फ़िगरेशन
├── SPINE.md                  # एजेंट पहचान और मिशन (सिस्टम प्रॉम्प्ट)
├── TRIGGER.md                # सक्रिय व्यवहार ट्रिगर
├── workspace/                # एजेंट कोड कार्यक्षेत्र
├── skills/                   # इंस्टॉल की गई स्किल्स
├── data/                     # SQLite डेटाबेस, सत्र स्थिति
└── logs/                     # डेमन और निष्पादन लॉग
```

## डेमन प्रबंधन

इंस्टॉलर Triggerfish को एक OS-नेटिव बैकग्राउंड सेवा के रूप में सेट करता है:

| प्लेटफ़ॉर्म | सेवा प्रबंधक                      |
| ---------- | -------------------------------- |
| macOS      | launchd                          |
| Linux      | systemd                          |
| Windows    | Windows Service / Task Scheduler |

इंस्टॉलेशन के बाद, डेमन को इन कमांड से प्रबंधित करें:

```bash
triggerfish start     # डेमन इंस्टॉल और शुरू करें
triggerfish stop      # डेमन बंद करें
triggerfish status    # जाँचें कि डेमन चल रहा है या नहीं
triggerfish logs      # डेमन लॉग देखें
```

## अपडेट करना

अपडेट जाँचने और इंस्टॉल करने के लिए:

```bash
triggerfish update
```

## प्लेटफ़ॉर्म समर्थन

| प्लेटफ़ॉर्म    | बाइनरी | Docker | इंस्टॉल स्क्रिप्ट  |
| ------------ | ------ | ------ | ----------------- |
| Linux x64    | हाँ    | हाँ    | हाँ               |
| Linux arm64  | हाँ    | हाँ    | हाँ               |
| macOS x64    | हाँ    | —      | हाँ               |
| macOS arm64  | हाँ    | —      | हाँ               |
| Windows x64  | हाँ    | —      | हाँ (PowerShell)  |

## अगले कदम

Triggerfish इंस्टॉल होने के बाद, अपने एजेंट को कॉन्फ़िगर करने और चैटिंग शुरू करने
के लिए [त्वरित शुरुआत](./quickstart) गाइड पर जाएँ।
