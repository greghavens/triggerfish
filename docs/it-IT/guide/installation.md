# Installazione e distribuzione

Triggerfish si installa con un singolo comando su macOS, Linux, Windows e Docker.
Gli installer binari scaricano una release pre-compilata, verificano il checksum
SHA256 e avviano la procedura guidata di configurazione.

## Installazione con un comando

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

### Cosa fa l'installer binario

1. **Rileva la piattaforma** e l'architettura
2. **Scarica** l'ultimo binario pre-compilato da GitHub Releases
3. **Verifica il checksum SHA256** per garantire l'integrità
4. **Installa** il binario in `/usr/local/bin` (o `~/.local/bin` /
   `%LOCALAPPDATA%\Triggerfish`)
5. **Avvia la procedura guidata** (`triggerfish dive`) per configurare agente,
   provider LLM e canali
6. **Avvia il daemon in background** affinché il Suo agente sia sempre attivo

Dopo che l'installer ha terminato, ha un agente completamente funzionante.
Nessun passaggio aggiuntivo richiesto.

### Installare una versione specifica

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## Requisiti di sistema

| Requisito        | Dettagli                                                |
| ---------------- | ------------------------------------------------------- |
| Sistema operativo | macOS, Linux o Windows                                 |
| Spazio su disco  | Circa 100 MB per il binario compilato                   |
| Rete             | Necessaria per le chiamate API LLM; tutta l'elaborazione è locale |

::: tip Nessun Docker, nessun container, nessun account cloud necessario.
Triggerfish è un singolo binario che funziona sulla Sua macchina. Docker è
disponibile come metodo di distribuzione alternativo. :::

## Docker

La distribuzione Docker fornisce un wrapper CLI `triggerfish` che offre la stessa
esperienza di comando del binario nativo. Tutti i dati risiedono in un volume
Docker nominato.

### Avvio rapido

L'installer scarica l'immagine, installa il wrapper CLI e avvia la procedura
guidata:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

### Uso quotidiano

Dopo l'installazione, il comando `triggerfish` funziona come il binario nativo:

```bash
triggerfish chat              # Sessione di chat interattiva
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish patrol            # Diagnostica di salute
triggerfish logs              # Visualizza i log del container
triggerfish status            # Verifica se il container è attivo
triggerfish stop              # Ferma il container
triggerfish start             # Avvia il container
triggerfish update            # Scarica l'ultima immagine e riavvia
triggerfish dive              # Riesegui la procedura guidata
```

### Come funziona il wrapper

Il wrapper script (`deploy/docker/triggerfish`) instrada i comandi:

| Comando         | Comportamento                                                |
| --------------- | ------------------------------------------------------------ |
| `start`         | Avvia il container tramite compose                           |
| `stop`          | Ferma il container tramite compose                           |
| `run`           | Esegui in primo piano (Ctrl+C per fermare)                   |
| `status`        | Mostra lo stato di esecuzione del container                  |
| `logs`          | Mostra i log del container                                   |
| `update`        | Scarica l'ultima immagine, riavvia                           |
| `dive`          | Container one-shot se non attivo; exec + restart se attivo   |
| Tutto il resto  | `exec` nel container in esecuzione                           |

Il wrapper rileva automaticamente `podman` vs `docker`. Sovrascriva con
`TRIGGERFISH_CONTAINER_RUNTIME=docker`.

### Docker Compose

Il file compose si trova in `~/.triggerfish/docker/docker-compose.yml` dopo
l'installazione.

### Secret in Docker

Poiché il portachiavi del SO non è disponibile nei container, Triggerfish
utilizza uno store di secret basato su file in `/data/secrets.json` all'interno
del volume. Utilizzi il wrapper CLI per gestire i secret:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### Persistenza dei dati

Il container memorizza tutti i dati sotto `/data`:

| Percorso                    | Contenuti                                |
| --------------------------- | ---------------------------------------- |
| `/data/triggerfish.yaml`    | Configurazione                           |
| `/data/secrets.json`        | Store di secret basato su file           |
| `/data/data/triggerfish.db` | Database SQLite (sessioni, cron, memoria)|
| `/data/workspace/`          | Workspace degli agenti                   |
| `/data/skills/`             | Skill installate                         |
| `/data/logs/`               | File di log                              |
| `/data/SPINE.md`            | Identità dell'agente                     |

## Installazione da sorgente

Se preferisce compilare da sorgente o desidera contribuire:

```bash
# 1. Installi Deno (se non lo ha)
curl -fsSL https://deno.land/install.sh | sh

# 2. Cloni il repository
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. Compili
deno task compile

# 4. Avvii la procedura guidata
./triggerfish dive

# 5. (Opzionale) Installi come daemon in background
./triggerfish start
```

::: info La compilazione da sorgente richiede Deno 2.x e git. Il comando
`deno task compile` produce un binario autonomo senza dipendenze esterne. :::

## Build binarie cross-platform

Per compilare binari per tutte le piattaforme da qualsiasi macchina host:

```bash
make release
```

## Directory di runtime

Dopo aver eseguito `triggerfish dive`, la Sua configurazione e i dati risiedono
in `~/.triggerfish/`:

```
~/.triggerfish/
├── triggerfish.yaml          # Configurazione principale
├── SPINE.md                  # Identità e missione dell'agente (prompt di sistema)
├── TRIGGER.md                # Trigger per comportamento proattivo
├── workspace/                # Workspace di codice dell'agente
├── skills/                   # Skill installate
├── data/                     # Database SQLite, stato sessione
└── logs/                     # Log del daemon e dell'esecuzione
```

## Gestione del daemon

L'installer configura Triggerfish come servizio nativo del SO in background:

| Piattaforma | Gestore servizi                        |
| ----------- | -------------------------------------- |
| macOS       | launchd                                |
| Linux       | systemd                               |
| Windows     | Windows Service / Task Scheduler       |

Dopo l'installazione, gestisca il daemon con:

```bash
triggerfish start     # Installa e avvia il daemon
triggerfish stop      # Ferma il daemon
triggerfish status    # Verifica se il daemon è attivo
triggerfish logs      # Visualizza i log del daemon
```

## Aggiornamento

Per verificare e installare aggiornamenti:

```bash
triggerfish update
```

## Supporto piattaforme

| Piattaforma | Binario | Docker | Script di installazione |
| ----------- | ------- | ------ | ----------------------- |
| Linux x64   | sì      | sì     | sì                      |
| Linux arm64 | sì      | sì     | sì                      |
| macOS x64   | sì      | —      | sì                      |
| macOS arm64 | sì      | —      | sì                      |
| Windows x64 | sì      | —      | sì (PowerShell)         |

## Prossimi passi

Con Triggerfish installato, prosegua con la guida [Avvio rapido](./quickstart)
per configurare il Suo agente e iniziare a chattare.
