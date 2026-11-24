# التثبيت والنشر

يُثبت Triggerfish بأمر واحد على macOS و Linux و Windows و Docker. مُثبتات الملف
التنفيذي تُنزل إصداراً مُسبق البناء، وتتحقق من مجموع SHA256، وتُشغل معالج
الإعداد.

## التثبيت بأمر واحد

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

### ماذا يفعل مُثبت الملف التنفيذي

1. **يكتشف منصتك** وبنيتها
2. **يُنزل** أحدث ملف تنفيذي مُسبق البناء من GitHub Releases
3. **يتحقق من مجموع SHA256** لضمان السلامة
4. **يُثبت** الملف التنفيذي في `/usr/local/bin` (أو `~/.local/bin` /
   `%LOCALAPPDATA%\Triggerfish`)
5. **يُشغل معالج الإعداد** (`triggerfish dive`) لتكوين وكيلك ومزود LLM والقنوات
6. **يبدأ daemon الخلفية** لكي يعمل وكيلك دائماً

بعد انتهاء المُثبت، لديك وكيل يعمل بالكامل. لا خطوات إضافية مطلوبة.

### تثبيت إصدار محدد

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## متطلبات النظام

| المتطلب          | التفاصيل                                                |
| ---------------- | ------------------------------------------------------- |
| نظام التشغيل     | macOS أو Linux أو Windows                               |
| مساحة القرص      | حوالي 100 ميجابايت للملف التنفيذي المُجمع               |
| الشبكة           | مطلوبة لاستدعاءات API لـ LLM؛ جميع المعالجة تعمل محلياً |

::: tip لا Docker، ولا حاويات، ولا حسابات سحابية مطلوبة. Triggerfish هو ملف تنفيذي
واحد يعمل على جهازك. Docker متاح كطريقة نشر بديلة. :::

## Docker

يوفر نشر Docker غلاف CLI `triggerfish` يمنحك نفس تجربة الأوامر كالملف التنفيذي
الأصلي. جميع البيانات تعيش في Docker volume مُسمى.

### البداية السريعة

يسحب المُثبت الصورة، ويُثبت غلاف CLI، ويُشغل معالج الإعداد:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

أو شغل المُثبت من نسخة محلية:

```bash
./deploy/docker/install.sh
```

يقوم المُثبت بـ:

1. كشف بيئة الحاويات (podman أو docker)
2. تثبيت غلاف CLI `triggerfish` في `~/.local/bin` (أو `/usr/local/bin`)
3. نسخ ملف compose إلى `~/.triggerfish/docker/`
4. سحب أحدث صورة
5. تشغيل معالج الإعداد (`triggerfish dive`) في حاوية لمرة واحدة
6. بدء الخدمة

### الاستخدام اليومي

بعد التثبيت، يعمل أمر `triggerfish` بنفس طريقة الملف التنفيذي الأصلي:

```bash
triggerfish chat              # جلسة محادثة تفاعلية
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # تشخيصات صحية
triggerfish logs              # عرض سجلات الحاوية
triggerfish status            # التحقق مما إذا كانت الحاوية تعمل
triggerfish stop              # إيقاف الحاوية
triggerfish start             # بدء الحاوية
triggerfish update            # سحب أحدث صورة وإعادة التشغيل
triggerfish dive              # إعادة تشغيل معالج الإعداد
```

### كيف يعمل الغلاف

يوجه سكريبت الغلاف (`deploy/docker/triggerfish`) الأوامر:

| الأمر           | السلوك                                                       |
| --------------- | ------------------------------------------------------------ |
| `start`         | بدء الحاوية عبر compose                                      |
| `stop`          | إيقاف الحاوية عبر compose                                    |
| `run`           | تشغيل في المقدمة (Ctrl+C للإيقاف)                            |
| `status`        | عرض حالة تشغيل الحاوية                                       |
| `logs`          | بث سجلات الحاوية                                              |
| `update`        | سحب أحدث صورة، إعادة التشغيل                                 |
| `dive`          | حاوية لمرة واحدة إذا لم تكن تعمل؛ exec + إعادة تشغيل إذا تعمل |
| بقية الأوامر    | `exec` في الحاوية العاملة                                     |

يكتشف الغلاف تلقائياً `podman` مقابل `docker`. التجاوز بـ
`TRIGGERFISH_CONTAINER_RUNTIME=docker`.

### Docker Compose

يقع ملف compose في `~/.triggerfish/docker/docker-compose.yml` بعد التثبيت. يمكنك
أيضاً استخدامه مباشرةً:

```bash
cd deploy/docker
docker compose up -d
```

### متغيرات البيئة

انسخ `.env.example` إلى `.env` بجوار ملف compose لتعيين مفاتيح API عبر متغيرات
البيئة:

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# حرر ~/.triggerfish/docker/.env
```

عادةً تُخزن مفاتيح API عبر `triggerfish config set-secret` (مخزنة في وحدة
البيانات)، لكن متغيرات البيئة تعمل كبديل.

### الأسرار في Docker

بما أن سلسلة مفاتيح نظام التشغيل غير متاحة في الحاويات، يستخدم Triggerfish مخزن
أسرار مدعوم بملفات في `/data/secrets.json` داخل الوحدة. استخدم غلاف CLI لإدارة
الأسرار:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### استمرارية البيانات

تخزن الحاوية جميع البيانات تحت `/data`:

| المسار                      | المحتويات                                |
| --------------------------- | ---------------------------------------- |
| `/data/triggerfish.yaml`    | التكوين                                  |
| `/data/secrets.json`        | مخزن أسرار مدعوم بملفات                  |
| `/data/data/triggerfish.db` | قاعدة بيانات SQLite (جلسات، cron، ذاكرة) |
| `/data/workspace/`          | مساحات عمل الوكيل                        |
| `/data/skills/`             | المهارات المُثبتة                         |
| `/data/logs/`               | ملفات السجل                               |
| `/data/SPINE.md`            | هوية الوكيل                               |

استخدم وحدة مُسماة (`-v triggerfish-data:/data`) أو ربط مباشر للاستمرار عبر
إعادات تشغيل الحاوية.

### بناء صورة Docker محلياً

```bash
make docker
# أو
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### تثبيت إصدار محدد (Docker)

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## التثبيت من المصدر

إذا كنت تفضل البناء من المصدر أو تريد المساهمة:

```bash
# 1. تثبيت Deno (إذا لم يكن لديك)
curl -fsSL https://deno.land/install.sh | sh

# 2. استنساخ المستودع
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. التجميع
deno task compile

# 4. تشغيل معالج الإعداد
./triggerfish dive

# 5. (اختياري) التثبيت كـ daemon خلفية
./triggerfish start
```

بدلاً من ذلك، استخدم سكريبتات التثبيت من المصدر المؤرشفة:

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info البناء من المصدر يتطلب Deno 2.x و git. أمر `deno task compile` يُنتج
ملفاً تنفيذياً مكتفياً ذاتياً بدون تبعيات خارجية. :::

## بناء ملفات تنفيذية متعددة المنصات

لبناء ملفات تنفيذية لجميع المنصات من أي جهاز مضيف:

```bash
make release
```

ينتج 5 ملفات تنفيذية بالإضافة إلى مجاميع التحقق في `dist/`:

| الملف                         | المنصة                     |
| ----------------------------- | -------------------------- |
| `triggerfish-linux-x64`       | Linux x86_64               |
| `triggerfish-linux-arm64`     | Linux ARM64                |
| `triggerfish-macos-x64`       | macOS Intel                |
| `triggerfish-macos-arm64`     | macOS Apple Silicon        |
| `triggerfish-windows-x64.exe` | Windows x86_64             |
| `SHA256SUMS.txt`              | مجاميع تحقق لجميع الملفات  |

## دليل وقت التشغيل

بعد تشغيل `triggerfish dive`، يقع تكوينك وبياناتك في `~/.triggerfish/`:

```
~/.triggerfish/
├── triggerfish.yaml          # التكوين الرئيسي
├── SPINE.md                  # هوية الوكيل والمهمة (prompt النظام)
├── TRIGGER.md                # مُشغلات السلوك الاستباقي
├── workspace/                # مساحة عمل كود الوكيل
├── skills/                   # المهارات المُثبتة
├── data/                     # قاعدة بيانات SQLite، حالة الجلسة
└── logs/                     # سجلات daemon والتنفيذ
```

في Docker، يتم تعيين هذا إلى `/data/` داخل الحاوية.

## إدارة Daemon

يُعد المُثبت Triggerfish كخدمة خلفية أصلية لنظام التشغيل:

| المنصة   | مدير الخدمة                      |
| -------- | -------------------------------- |
| macOS    | launchd                          |
| Linux    | systemd                          |
| Windows  | Windows Service / Task Scheduler |

بعد التثبيت، أدر daemon بـ:

```bash
triggerfish start     # تثبيت وبدء daemon
triggerfish stop      # إيقاف daemon
triggerfish status    # التحقق مما إذا كان daemon يعمل
triggerfish logs      # عرض سجلات daemon
```

## عملية الإصدار

الإصدارات مؤتمتة عبر GitHub Actions. لإنشاء إصدار جديد:

```bash
git tag v0.2.0
git push origin v0.2.0
```

يُشغل هذا سير عمل الإصدار الذي يبني 5 ملفات تنفيذية لجميع المنصات، ويُنشئ
GitHub Release مع مجاميع التحقق، ويدفع صورة Docker متعددة البنى إلى GHCR.
تُنزل سكريبتات التثبيت تلقائياً أحدث إصدار.

## التحديث

للتحقق من التحديثات وتثبيتها:

```bash
triggerfish update
```

## دعم المنصات

| المنصة      | ملف تنفيذي | Docker | سكريبت تثبيت     |
| ----------- | ---------- | ------ | ---------------- |
| Linux x64   | نعم        | نعم    | نعم              |
| Linux arm64 | نعم        | نعم    | نعم              |
| macOS x64   | نعم        | —      | نعم              |
| macOS arm64 | نعم        | —      | نعم              |
| Windows x64 | نعم        | —      | نعم (PowerShell) |

## الخطوات التالية

مع تثبيت Triggerfish، توجه إلى دليل [البداية السريعة](./quickstart) لتكوين وكيلك
والبدء بالمحادثة.
