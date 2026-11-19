# نصب و استقرار

Triggerfish با یک دستور واحد روی macOS، Linux، Windows و Docker نصب می‌شود.
نصب‌کننده‌های باینری یک نسخه از پیش ساخته‌شده دانلود می‌کنند، چک‌سام SHA256 آن
را تأیید می‌کنند و جادوگر راه‌اندازی را اجرا می‌کنند.

## نصب با یک دستور

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

### نصب‌کننده باینری چه می‌کند

۱. **پلتفرم و معماری** شما را شناسایی می‌کند
۲. آخرین باینری از پیش ساخته‌شده را از GitHub Releases **دانلود** می‌کند
۳. **چک‌سام SHA256 را تأیید** می‌کند تا یکپارچگی تضمین شود
۴. باینری را در `/usr/local/bin` (یا `~/.local/bin` / `%LOCALAPPDATA%\Triggerfish`) **نصب** می‌کند
۵. **جادوگر راه‌اندازی** (`triggerfish dive`) را برای پیکربندی عامل، ارائه‌دهنده LLM و کانال‌ها اجرا می‌کند
۶. **دیمن پس‌زمینه** را شروع می‌کند تا عامل شما همیشه در حال اجرا باشد

پس از اتمام نصب‌کننده، یک عامل کاملاً کارآمد دارید. هیچ مرحله اضافی لازم نیست.

### نصب یک نسخه خاص

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## الزامات سیستم

| الزام            | جزئیات                                                        |
| ---------------- | ------------------------------------------------------------- |
| سیستم‌عامل       | macOS، Linux یا Windows                                       |
| فضای دیسک        | حدود ۱۰۰ مگابایت برای باینری کامپایل‌شده                      |
| شبکه             | برای فراخوانی API LLM لازم است؛ تمام پردازش به‌صورت محلی اجرا می‌شود |

::: tip بدون Docker، بدون کانتینر، بدون حساب ابری لازم. Triggerfish یک
باینری واحد است که روی دستگاه شما اجرا می‌شود. Docker به‌عنوان یک روش استقرار
جایگزین در دسترس است. :::

## Docker

استقرار Docker یک wrapper CLI `triggerfish` ارائه می‌دهد که همان تجربه دستوری
باینری بومی را به شما می‌دهد. تمام داده‌ها در یک Docker volume نامگذاری‌شده
قرار دارند.

### شروع سریع

نصب‌کننده تصویر را pull می‌کند، wrapper CLI را نصب و جادوگر راه‌اندازی را اجرا
می‌کند:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

یا نصب‌کننده را از یک checkout محلی اجرا کنید:

```bash
./deploy/docker/install.sh
```

### استفاده روزانه

پس از نصب، دستور `triggerfish` مانند باینری بومی کار می‌کند:

```bash
triggerfish chat              # نشست گفتگوی تعاملی
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # تشخیص سلامت
triggerfish logs              # مشاهده لاگ‌های کانتینر
triggerfish status            # بررسی وضعیت اجرای کانتینر
triggerfish stop              # توقف کانتینر
triggerfish start             # شروع کانتینر
triggerfish update            # دریافت آخرین تصویر و شروع مجدد
triggerfish dive              # اجرای مجدد جادوگر راه‌اندازی
```

### نحوه کار wrapper

اسکریپت wrapper (`deploy/docker/triggerfish`) دستورات را مسیریابی می‌کند:

| دستور           | رفتار                                                        |
| --------------- | ------------------------------------------------------------ |
| `start`         | شروع کانتینر از طریق compose                                 |
| `stop`          | توقف کانتینر از طریق compose                                  |
| `run`           | اجرا در پیش‌زمینه (Ctrl+C برای توقف)                          |
| `status`        | نمایش وضعیت اجرای کانتینر                                    |
| `logs`          | پخش لاگ‌های کانتینر                                           |
| `update`        | دریافت آخرین تصویر، شروع مجدد                                 |
| `dive`          | کانتینر یکباره اگر در حال اجرا نباشد؛ exec + شروع مجدد اگر باشد |
| بقیه دستورات    | `exec` در کانتینر در حال اجرا                                 |

wrapper به‌صورت خودکار `podman` و `docker` را تشخیص می‌دهد. با
`TRIGGERFISH_CONTAINER_RUNTIME=docker` بازنویسی کنید.

### رمزها در Docker

از آنجایی که کلیدزنجیر سیستم‌عامل در کانتینرها در دسترس نیست، Triggerfish از
ذخیره‌ساز رمز مبتنی بر فایل در `/data/secrets.json` داخل volume استفاده می‌کند.

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### پایداری داده‌ها

کانتینر تمام داده‌ها را تحت `/data` ذخیره می‌کند:

| مسیر                        | محتویات                                  |
| --------------------------- | ---------------------------------------- |
| `/data/triggerfish.yaml`    | پیکربندی                                 |
| `/data/secrets.json`        | ذخیره‌ساز رمز مبتنی بر فایل               |
| `/data/data/triggerfish.db` | پایگاه داده SQLite (نشست‌ها، cron، حافظه) |
| `/data/workspace/`          | فضاهای کاری عامل                         |
| `/data/skills/`             | مهارت‌های نصب‌شده                         |
| `/data/logs/`               | فایل‌های لاگ                              |
| `/data/SPINE.md`            | هویت عامل                                |

## نصب از سورس

اگر ترجیح می‌دهید از سورس بسازید یا می‌خواهید مشارکت کنید:

```bash
# ۱. نصب Deno (اگر ندارید)
curl -fsSL https://deno.land/install.sh | sh

# ۲. کلون مخزن
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# ۳. کامپایل
deno task compile

# ۴. اجرای جادوگر راه‌اندازی
./triggerfish dive

# ۵. (اختیاری) نصب به‌عنوان دیمن پس‌زمینه
./triggerfish start
```

::: info ساخت از سورس نیاز به Deno 2.x و git دارد. دستور `deno task compile`
یک باینری خودکفا بدون وابستگی‌های خارجی تولید می‌کند. :::

## ساخت‌های باینری چندپلتفرمی

```bash
make release
```

| فایل                          | پلتفرم                    |
| ----------------------------- | ------------------------- |
| `triggerfish-linux-x64`       | Linux x86_64              |
| `triggerfish-linux-arm64`     | Linux ARM64               |
| `triggerfish-macos-x64`       | macOS Intel               |
| `triggerfish-macos-arm64`     | macOS Apple Silicon       |
| `triggerfish-windows-x64.exe` | Windows x86_64            |
| `SHA256SUMS.txt`              | چک‌سام‌ها برای تمام باینری‌ها |

## دایرکتوری اجرا

پس از اجرای `triggerfish dive`، پیکربندی و داده‌های شما در `~/.triggerfish/` قرار دارند:

```
~/.triggerfish/
├── triggerfish.yaml          # پیکربندی اصلی
├── SPINE.md                  # هویت و مأموریت عامل (system prompt)
├── TRIGGER.md                # محرک‌های رفتار فعالانه
├── workspace/                # فضای کاری کد عامل
├── skills/                   # مهارت‌های نصب‌شده
├── data/                     # پایگاه داده SQLite، وضعیت نشست
└── logs/                     # لاگ‌های دیمن و اجرا
```

## مدیریت دیمن

نصب‌کننده Triggerfish را به‌عنوان یک سرویس پس‌زمینه بومی سیستم‌عامل تنظیم می‌کند:

| پلتفرم  | مدیر سرویس                       |
| ------- | -------------------------------- |
| macOS   | launchd                          |
| Linux   | systemd                          |
| Windows | Windows Service / Task Scheduler |

```bash
triggerfish start     # نصب و شروع دیمن
triggerfish stop      # توقف دیمن
triggerfish status    # بررسی وضعیت دیمن
triggerfish logs      # مشاهده لاگ‌های دیمن
```

## فرآیند انتشار

انتشارها از طریق GitHub Actions خودکار هستند:

```bash
git tag v0.2.0
git push origin v0.2.0
```

## به‌روزرسانی

```bash
triggerfish update
```

## پشتیبانی پلتفرم

| پلتفرم     | باینری | Docker | اسکریپت نصب     |
| ---------- | ------ | ------ | --------------- |
| Linux x64  | بله    | بله    | بله             |
| Linux arm64| بله    | بله    | بله             |
| macOS x64  | بله    | —      | بله             |
| macOS arm64| بله    | —      | بله             |
| Windows x64| بله    | —      | بله (PowerShell)|

## مراحل بعدی

با نصب Triggerfish، به راهنمای [شروع سریع](./quickstart) بروید تا عامل خود
را پیکربندی کنید و شروع به گفتگو کنید.
