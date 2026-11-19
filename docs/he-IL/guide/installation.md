# התקנה ופריסה

Triggerfish מותקנת בפקודה אחת על macOS, Linux, Windows ו-Docker. תוכניות
ההתקנה הבינאריות מורידות גרסה מוכנה מראש, מאמתות את סכום הביקורת SHA256
ומריצות את אשף ההגדרה.

## התקנה בפקודה אחת

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

### מה עושה תוכנית ההתקנה הבינארית

1. **מזהה את הפלטפורמה** והארכיטקטורה שלכם
2. **מורידה** את הבינארי המוכן האחרון מ-GitHub Releases
3. **מאמתת את סכום הביקורת SHA256** להבטחת שלמות
4. **מתקינה** את הבינארי ב-`/usr/local/bin` (או `~/.local/bin` / `%LOCALAPPDATA%\Triggerfish`)
5. **מריצה את אשף ההגדרה** (`triggerfish dive`) להגדרת הסוכן, ספק ה-LLM והערוצים
6. **מפעילה את ה-daemon ברקע** כך שהסוכן שלכם תמיד פעיל

לאחר סיום ההתקנה, יש לכם סוכן עובד לחלוטין. אין צורך בשלבים נוספים.

### התקנת גרסה ספציפית

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## דרישות מערכת

| דרישה          | פרטים                                                          |
| -------------- | -------------------------------------------------------------- |
| מערכת הפעלה    | macOS, Linux או Windows                                        |
| שטח דיסק       | כ-100 MB עבור הבינארי המהודר                                   |
| רשת            | נדרשת עבור קריאות API ל-LLM; כל העיבוד רץ באופן מקומי          |

::: tip ללא Docker, ללא קונטיינרים, ללא חשבונות ענן נדרשים. Triggerfish הוא
בינארי יחיד שרץ על המכשיר שלכם. Docker זמין כשיטת פריסה חלופית. :::

## Docker

פריסת Docker מספקת עטיפת CLI של `triggerfish` שנותנת לכם את אותה חוויית
פקודות כמו הבינארי המקורי. כל הנתונים נמצאים ב-volume מוגדר של Docker.

### התחלה מהירה

תוכנית ההתקנה מושכת את ה-image, מתקינה את עטיפת ה-CLI ומריצה את אשף ההגדרה:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

או הריצו את תוכנית ההתקנה מ-checkout מקומי:

```bash
./deploy/docker/install.sh
```

תוכנית ההתקנה:

1. מזהה את סביבת הריצה של הקונטיינר (podman או docker)
2. מתקינה את עטיפת CLI של `triggerfish` ב-`~/.local/bin` (או `/usr/local/bin`)
3. מעתיקה את קובץ ה-compose ל-`~/.triggerfish/docker/`
4. מושכת את ה-image האחרון
5. מריצה את אשף ההגדרה (`triggerfish dive`) בקונטיינר חד-פעמי
6. מפעילה את השירות

### שימוש יומיומי

לאחר ההתקנה, פקודת `triggerfish` עובדת באותו אופן כמו הבינארי המקורי:

```bash
triggerfish chat              # סשן צ'אט אינטראקטיבי
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # אבחון בריאות
triggerfish logs              # צפייה ביומני הקונטיינר
triggerfish status            # בדיקה אם הקונטיינר רץ
triggerfish stop              # עצירת הקונטיינר
triggerfish start             # הפעלת הקונטיינר
triggerfish update            # משיכת image אחרון והפעלה מחדש
triggerfish dive              # הרצת אשף ההגדרה מחדש
```

### כיצד עובדת העטיפה

סקריפט העטיפה (`deploy/docker/triggerfish`) מנתב פקודות:

| פקודה           | התנהגות                                                        |
| --------------- | -------------------------------------------------------------- |
| `start`         | הפעלת קונטיינר דרך compose                                     |
| `stop`          | עצירת קונטיינר דרך compose                                     |
| `run`           | הרצה בחזית (Ctrl+C לעצירה)                                     |
| `status`        | הצגת מצב ריצת הקונטיינר                                        |
| `logs`          | הזרמת יומני הקונטיינר                                          |
| `update`        | משיכת image אחרון, הפעלה מחדש                                   |
| `dive`          | קונטיינר חד-פעמי אם לא רץ; exec + הפעלה מחדש אם רץ            |
| כל השאר         | `exec` לתוך הקונטיינר הרץ                                      |

העטיפה מזהה אוטומטית `podman` לעומת `docker`. ניתן לדרוס עם
`TRIGGERFISH_CONTAINER_RUNTIME=docker`.

### Docker Compose

קובץ ה-compose נמצא ב-`~/.triggerfish/docker/docker-compose.yml` לאחר
ההתקנה. ניתן גם להשתמש בו ישירות:

```bash
cd deploy/docker
docker compose up -d
```

### משתני סביבה

העתיקו `.env.example` ל-`.env` ליד קובץ ה-compose להגדרת מפתחות API
דרך משתני סביבה:

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# ערכו את ~/.triggerfish/docker/.env
```

מפתחות API נשמרים בדרך כלל דרך `triggerfish config set-secret` (מאוחסנים
ב-volume הנתונים), אך משתני סביבה עובדים כחלופה.

### סודות ב-Docker

מכיוון שה-keychain של מערכת ההפעלה אינו זמין בקונטיינרים, Triggerfish משתמשת
באחסון סודות מבוסס קובץ ב-`/data/secrets.json` בתוך ה-volume. השתמשו בעטיפת
ה-CLI לניהול סודות:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### שמירת נתונים

הקונטיינר מאחסן את כל הנתונים תחת `/data`:

| נתיב                        | תוכן                                      |
| --------------------------- | ------------------------------------------ |
| `/data/triggerfish.yaml`    | הגדרות                                     |
| `/data/secrets.json`        | אחסון סודות מבוסס קובץ                     |
| `/data/data/triggerfish.db` | מסד נתונים SQLite (סשנים, cron, זיכרון)    |
| `/data/workspace/`          | סביבות עבודה של הסוכן                       |
| `/data/skills/`             | מיומנויות מותקנות                           |
| `/data/logs/`               | קבצי יומן                                  |
| `/data/SPINE.md`            | זהות הסוכן                                 |

השתמשו ב-volume מוגדר (`-v triggerfish-data:/data`) או bind mount לשמירה
בין הפעלות מחדש של הקונטיינר.

### בניית Docker Image באופן מקומי

```bash
make docker
# או
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### נעילת גרסה (Docker)

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## התקנה מקוד מקור

אם אתם מעדיפים לבנות מקוד מקור או רוצים לתרום:

```bash
# 1. התקנת Deno (אם אין לכם)
curl -fsSL https://deno.land/install.sh | sh

# 2. שכפול המאגר
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. הידור
deno task compile

# 4. הרצת אשף ההגדרה
./triggerfish dive

# 5. (אופציונלי) התקנה כ-daemon ברקע
./triggerfish start
```

לחלופין, השתמשו בסקריפטי התקנה מקוד מקור:

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info בנייה מקוד מקור דורשת Deno 2.x ו-git. הפקודה `deno task compile`
מייצרת בינארי עצמאי ללא תלויות חיצוניות. :::

## בניית בינאריים חוצי-פלטפורמות

לבניית בינאריים לכל הפלטפורמות מכל מכשיר מארח:

```bash
make release
```

זה מייצר את כל 5 הבינאריים בתוספת checksums ב-`dist/`:

| קובץ                          | פלטפורמה                  |
| ----------------------------- | ------------------------- |
| `triggerfish-linux-x64`       | Linux x86_64              |
| `triggerfish-linux-arm64`     | Linux ARM64               |
| `triggerfish-macos-x64`       | macOS Intel               |
| `triggerfish-macos-arm64`     | macOS Apple Silicon       |
| `triggerfish-windows-x64.exe` | Windows x86_64            |
| `SHA256SUMS.txt`              | Checksums לכל הבינאריים   |

## תיקיית ריצה

לאחר הרצת `triggerfish dive`, ההגדרות והנתונים שלכם נמצאים ב-`~/.triggerfish/`:

```
~/.triggerfish/
├── triggerfish.yaml          # הגדרות ראשיות
├── SPINE.md                  # זהות הסוכן ומשימתו (system prompt)
├── TRIGGER.md                # טריגרים להתנהגות פרואקטיבית
├── workspace/                # סביבת עבודת קוד של הסוכן
├── skills/                   # מיומנויות מותקנות
├── data/                     # מסד נתונים SQLite, מצב סשן
└── logs/                     # יומני daemon וביצוע
```

ב-Docker, זה ממופה ל-`/data/` בתוך הקונטיינר.

## ניהול Daemon

תוכנית ההתקנה מגדירה את Triggerfish כשירות רקע מובנה במערכת ההפעלה:

| פלטפורמה | מנהל שירותים                     |
| --------- | -------------------------------- |
| macOS     | launchd                          |
| Linux     | systemd                          |
| Windows   | Windows Service / Task Scheduler |

לאחר ההתקנה, נהלו את ה-daemon עם:

```bash
triggerfish start     # התקנה והפעלת ה-daemon
triggerfish stop      # עצירת ה-daemon
triggerfish status    # בדיקה אם ה-daemon רץ
triggerfish logs      # צפייה ביומני ה-daemon
```

## תהליך שחרור

שחרורים מבוצעים אוטומטית דרך GitHub Actions. ליצירת שחרור חדש:

```bash
git tag v0.2.0
git push origin v0.2.0
```

זה מפעיל את תהליך השחרור שבונה את כל 5 הבינאריים לפלטפורמות, יוצר GitHub
Release עם checksums, ודוחף Docker image רב-ארכיטקטורה ל-GHCR. סקריפטי
ההתקנה מורידים אוטומטית את השחרור האחרון.

## עדכון

לבדיקה והתקנת עדכונים:

```bash
triggerfish update
```

## תמיכה בפלטפורמות

| פלטפורמה     | בינארי | Docker | סקריפט התקנה     |
| ------------- | ------ | ------ | ---------------- |
| Linux x64     | כן     | כן     | כן               |
| Linux arm64   | כן     | כן     | כן               |
| macOS x64     | כן     | —      | כן               |
| macOS arm64   | כן     | —      | כן               |
| Windows x64   | כן     | —      | כן (PowerShell)  |

## צעדים הבאים

עם Triggerfish מותקן, עברו למדריך [התחלה מהירה](./quickstart) כדי להגדיר
את הסוכן שלכם ולהתחיל לשוחח.
