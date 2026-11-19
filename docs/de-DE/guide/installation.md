# Installation & Bereitstellung

Triggerfish wird mit einem einzigen Befehl auf macOS, Linux, Windows und Docker installiert. Die Binaer-Installer laden ein vorgefertigtes Release herunter, ueberpruefen dessen SHA256-Pruefsumme und starten den Einrichtungsassistenten.

## Installation mit einem Befehl

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

### Was der Binaer-Installer tut

1. **Erkennt Ihre Plattform** und Architektur
2. **Laedt** die neueste vorgefertigte Binaerdatei von GitHub Releases herunter
3. **Ueberpruefen die SHA256-Pruefsumme** zur Sicherstellung der Integritaet
4. **Installiert** die Binaerdatei nach `/usr/local/bin` (oder `~/.local/bin` / `%LOCALAPPDATA%\Triggerfish`)
5. **Startet den Einrichtungsassistenten** (`triggerfish dive`) zur Konfiguration Ihres Agenten, LLM-Anbieters und der Kanaele
6. **Startet den Hintergrund-Daemon**, damit Ihr Agent immer laeuft

Nach Abschluss des Installers haben Sie einen voll funktionsfaehigen Agenten. Keine weiteren Schritte erforderlich.

### Eine bestimmte Version installieren

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## Systemanforderungen

| Anforderung     | Details                                                         |
| --------------- | --------------------------------------------------------------- |
| Betriebssystem  | macOS, Linux oder Windows                                       |
| Speicherplatz   | Ungefaehr 100 MB fuer die kompilierte Binaerdatei               |
| Netzwerk        | Erforderlich fuer LLM-API-Aufrufe; die gesamte Verarbeitung laeuft lokal |

::: tip Kein Docker, keine Container, keine Cloud-Konten erforderlich. Triggerfish ist eine einzelne Binaerdatei, die auf Ihrem Rechner laeuft. Docker ist als alternative Bereitstellungsmethode verfuegbar. :::

## Docker

Die Docker-Bereitstellung bietet einen `triggerfish`-CLI-Wrapper, der Ihnen die gleiche Befehlserfahrung wie die native Binaerdatei bietet. Alle Daten befinden sich in einem benannten Docker-Volume.

### Schnellstart

Der Installer zieht das Image, installiert den CLI-Wrapper und startet den Einrichtungsassistenten:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

Oder starten Sie den Installer aus einem lokalen Checkout:

```bash
./deploy/docker/install.sh
```

Der Installer:

1. Erkennt Ihre Container-Runtime (podman oder docker)
2. Installiert den `triggerfish`-CLI-Wrapper nach `~/.local/bin` (oder `/usr/local/bin`)
3. Kopiert die Compose-Datei nach `~/.triggerfish/docker/`
4. Zieht das neueste Image
5. Startet den Einrichtungsassistenten (`triggerfish dive`) in einem Einmal-Container
6. Startet den Dienst

### Taegliche Nutzung

Nach der Installation funktioniert der `triggerfish`-Befehl genauso wie die native Binaerdatei:

```bash
triggerfish chat              # Interaktive Chat-Sitzung
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # Gesundheitsdiagnose
triggerfish logs              # Container-Logs anzeigen
triggerfish status            # Pruefen, ob der Container laeuft
triggerfish stop              # Container stoppen
triggerfish start             # Container starten
triggerfish update            # Neuestes Image ziehen und neu starten
triggerfish dive              # Einrichtungsassistenten erneut ausfuehren
```

### Wie der Wrapper funktioniert

Das Wrapper-Skript (`deploy/docker/triggerfish`) leitet Befehle weiter:

| Befehl          | Verhalten                                                        |
| --------------- | ---------------------------------------------------------------- |
| `start`         | Container ueber Compose starten                                 |
| `stop`          | Container ueber Compose stoppen                                 |
| `run`           | Im Vordergrund ausfuehren (Strg+C zum Stoppen)                  |
| `status`        | Container-Laufzustand anzeigen                                  |
| `logs`          | Container-Logs streamen                                          |
| `update`        | Neuestes Image ziehen, neu starten                               |
| `dive`          | Einmal-Container wenn nicht laufend; exec + Neustart wenn laufend |
| Alles andere    | `exec` in den laufenden Container                                |

Der Wrapper erkennt automatisch `podman` vs `docker`. Ueberschreiben mit `TRIGGERFISH_CONTAINER_RUNTIME=docker`.

### Docker Compose

Die Compose-Datei befindet sich nach der Installation unter `~/.triggerfish/docker/docker-compose.yml`. Sie koennen sie auch direkt verwenden:

```bash
cd deploy/docker
docker compose up -d
```

### Umgebungsvariablen

Kopieren Sie `.env.example` nach `.env` neben die Compose-Datei, um API-Schluessel ueber Umgebungsvariablen festzulegen:

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# ~/.triggerfish/docker/.env bearbeiten
```

API-Schluessel werden typischerweise ueber `triggerfish config set-secret` gespeichert (persistent im Daten-Volume), aber Umgebungsvariablen funktionieren als Alternative.

### Secrets in Docker

Da der Betriebssystem-Schluesselbund in Containern nicht verfuegbar ist, verwendet Triggerfish einen dateibasierten Secret-Store unter `/data/secrets.json` im Volume. Verwenden Sie den CLI-Wrapper zur Verwaltung von Secrets:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### Datenpersistenz

Der Container speichert alle Daten unter `/data`:

| Pfad                        | Inhalt                                   |
| --------------------------- | ---------------------------------------- |
| `/data/triggerfish.yaml`    | Konfiguration                            |
| `/data/secrets.json`        | Dateibasierter Secret-Store              |
| `/data/data/triggerfish.db` | SQLite-Datenbank (Sessions, Cron, Memory) |
| `/data/workspace/`          | Agent-Arbeitsbereiche                    |
| `/data/skills/`             | Installierte Skills                      |
| `/data/logs/`               | Log-Dateien                              |
| `/data/SPINE.md`            | Agent-Identitaet                         |

Verwenden Sie ein benanntes Volume (`-v triggerfish-data:/data`) oder Bind-Mount zur Persistenz ueber Container-Neustarts hinweg.

### Docker-Image lokal erstellen

```bash
make docker
# oder
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### Versionsverankerung (Docker)

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## Aus dem Quellcode installieren

Wenn Sie lieber aus dem Quellcode kompilieren oder beitragen moechten:

```bash
# 1. Deno installieren (falls noch nicht vorhanden)
curl -fsSL https://deno.land/install.sh | sh

# 2. Repository klonen
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. Kompilieren
deno task compile

# 4. Einrichtungsassistenten starten
./triggerfish dive

# 5. (Optional) Als Hintergrund-Daemon installieren
./triggerfish start
```

Alternativ koennen Sie die archivierten Source-Install-Skripte verwenden:

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info Die Kompilierung aus dem Quellcode erfordert Deno 2.x und git. Der `deno task compile`-Befehl erzeugt eine eigenstaendige Binaerdatei ohne externe Abhaengigkeiten. :::

## Plattformuebergreifende Binaer-Builds

Um Binaerdateien fuer alle Plattformen von einem beliebigen Host-Rechner zu erstellen:

```bash
make release
```

Dies erzeugt alle 5 Binaerdateien plus Pruefsummen in `dist/`:

| Datei                         | Plattform                |
| ----------------------------- | ------------------------ |
| `triggerfish-linux-x64`       | Linux x86_64             |
| `triggerfish-linux-arm64`     | Linux ARM64              |
| `triggerfish-macos-x64`       | macOS Intel              |
| `triggerfish-macos-arm64`     | macOS Apple Silicon      |
| `triggerfish-windows-x64.exe` | Windows x86_64           |
| `SHA256SUMS.txt`              | Pruefsummen fuer alle Binaerdateien |

## Laufzeitverzeichnis

Nach der Ausfuehrung von `triggerfish dive` befinden sich Ihre Konfiguration und Daten unter `~/.triggerfish/`:

```
~/.triggerfish/
├── triggerfish.yaml          # Hauptkonfiguration
├── SPINE.md                  # Agent-Identitaet und -Mission (System-Prompt)
├── TRIGGER.md                # Proaktive Verhaltens-Trigger
├── workspace/                # Agent-Code-Arbeitsbereich
├── skills/                   # Installierte Skills
├── data/                     # SQLite-Datenbank, Session-Zustand
└── logs/                     # Daemon- und Ausfuehrungs-Logs
```

In Docker wird dies auf `/data/` im Container abgebildet.

## Daemon-Verwaltung

Der Installer richtet Triggerfish als nativen Betriebssystem-Hintergrunddienst ein:

| Plattform | Dienst-Manager                   |
| --------- | -------------------------------- |
| macOS     | launchd                          |
| Linux     | systemd                          |
| Windows   | Windows Service / Task Scheduler |

Nach der Installation verwalten Sie den Daemon mit:

```bash
triggerfish start     # Daemon installieren und starten
triggerfish stop      # Daemon stoppen
triggerfish status    # Pruefen, ob der Daemon laeuft
triggerfish logs      # Daemon-Logs anzeigen
```

## Release-Prozess

Releases werden ueber GitHub Actions automatisiert. Um ein neues Release zu erstellen:

```bash
git tag v0.2.0
git push origin v0.2.0
```

Dies loest den Release-Workflow aus, der alle 5 Plattform-Binaerdateien erstellt, ein GitHub-Release mit Pruefsummen erstellt und ein Multi-Arch-Docker-Image nach GHCR pusht. Die Installationsskripte laden automatisch das neueste Release herunter.

## Aktualisierung

Um nach Updates zu suchen und diese zu installieren:

```bash
triggerfish update
```

## Plattformunterstuetzung

| Plattform   | Binaer | Docker | Installationsskript |
| ----------- | ------ | ------ | ------------------- |
| Linux x64   | ja     | ja     | ja                  |
| Linux arm64 | ja     | ja     | ja                  |
| macOS x64   | ja     | —      | ja                  |
| macOS arm64 | ja     | —      | ja                  |
| Windows x64 | ja     | —      | ja (PowerShell)     |

## Naechste Schritte

Nachdem Triggerfish installiert ist, gehen Sie zur [Schnellstart](./quickstart)-Anleitung, um Ihren Agenten zu konfigurieren und mit dem Chatten zu beginnen.
