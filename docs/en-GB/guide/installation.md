# Installation & Deployment

Triggerfish installs with a single command on macOS, Linux, Windows, and Docker.
The binary installers download a pre-built release, verify its SHA256 checksum,
and run the setup wizard.

## One-Command Install

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

### What the Binary Installer Does

1. **Detects your platform** and architecture
2. **Downloads** the latest pre-built binary from GitHub Releases
3. **Verifies the SHA256 checksum** to ensure integrity
4. **Installs** the binary to `/usr/local/bin` (or `~/.local/bin` /
   `%LOCALAPPDATA%\Triggerfish`)
5. **Runs the setup wizard** (`triggerfish dive`) to configure your agent, LLM
   provider, and channels
6. **Starts the background daemon** so your agent is always running

After the installer finishes, you have a fully working agent. No additional
steps required.

### Install a Specific Version

```bash
# Bash
curl -fsSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | TRIGGERFISH_VERSION=v0.7.19 bash

# PowerShell
$env:TRIGGERFISH_VERSION = "v0.1.0"; irm .../scripts/install.ps1 | iex
```

## System Requirements

| Requirement      | Details                                                 |
| ---------------- | ------------------------------------------------------- |
| Operating System | macOS, Linux, or Windows                                |
| Disk Space       | Approximately 100 MB for the compiled binary            |
| Network          | Required for LLM API calls; all processing runs locally |

::: tip No Docker, no containers, no cloud accounts required. Triggerfish is a
single binary that runs on your machine. Docker is available as an alternative
deployment method. :::

## Docker

The Docker deployment provides a `triggerfish` CLI wrapper that gives you the
same command experience as the native binary. All data lives in a named Docker
volume.

### Quick Start

The installer pulls the image, installs the CLI wrapper, and runs the setup
wizard:

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

Or run the installer from a local checkout:

```bash
./deploy/docker/install.sh
```

The installer:

1. Detects your container runtime (podman or docker)
2. Installs the `triggerfish` CLI wrapper to `~/.local/bin` (or
   `/usr/local/bin`)
3. Copies the compose file to `~/.triggerfish/docker/`
4. Pulls the latest image
5. Runs the setup wizard (`triggerfish dive`) in a one-shot container
6. Starts the service

### Day-to-Day Usage

After installation, the `triggerfish` command works the same as the native
binary:

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

### How the Wrapper Works

The wrapper script (`deploy/docker/triggerfish`) routes commands:

| Command         | Behaviour                                                    |
| --------------- | ------------------------------------------------------------ |
| `start`         | Start container via compose                                  |
| `stop`          | Stop container via compose                                   |
| `run`           | Run in foreground (Ctrl+C to stop)                           |
| `status`        | Show container running state                                 |
| `logs`          | Stream container logs                                        |
| `update`        | Pull latest image, restart                                   |
| `dive`          | One-shot container if not running; exec + restart if running |
| Everything else | `exec` into the running container                            |

The wrapper auto-detects `podman` vs `docker`. Override with
`TRIGGERFISH_CONTAINER_RUNTIME=docker`.

### Docker Compose

The compose file lives at `~/.triggerfish/docker/docker-compose.yml` after
installation. You can also use it directly:

```bash
cd deploy/docker
docker compose up -d
```

### Environment Variables

Copy `.env.example` to `.env` alongside the compose file to set API keys via
environment variables:

```bash
cp deploy/docker/.env.example ~/.triggerfish/docker/.env
# Edit ~/.triggerfish/docker/.env
```

API keys are typically stored via `triggerfish config set-secret` (persisted in
the data volume), but environment variables work as an alternative.

### Secrets in Docker

Since the OS keychain is unavailable in containers, Triggerfish uses a
file-backed secret store at `/data/secrets.json` inside the volume. Use the CLI
wrapper to manage secrets:

```bash
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
triggerfish config set-secret provider:brave:apiKey BSA...
```

### Data Persistence

The container stores all data under `/data`:

| Path                        | Contents                                 |
| --------------------------- | ---------------------------------------- |
| `/data/triggerfish.yaml`    | Configuration                            |
| `/data/secrets.json`        | File-backed secret store                 |
| `/data/data/triggerfish.db` | SQLite database (sessions, cron, memory) |
| `/data/workspace/`          | Agent workspaces                         |
| `/data/skills/`             | Installed skills                         |
| `/data/logs/`               | Log files                                |
| `/data/SPINE.md`            | Agent identity                           |

Use a named volume (`-v triggerfish-data:/data`) or bind mount to persist across
container restarts.

### Building the Docker Image Locally

```bash
make docker
# or
docker build -f deploy/docker/Dockerfile -t triggerfish:local .
```

### Version Pinning (Docker)

```bash
docker pull ghcr.io/greghavens/triggerfish:v0.1.0
```

## Install from Source

If you prefer to build from source or want to contribute:

```bash
# 1. Install Deno (if you don't have it)
curl -fsSL https://deno.land/install.sh | sh

# 2. Clone the repository
git clone https://github.com/greghavens/triggerfish.git
cd triggerfish

# 3. Compile
deno task compile

# 4. Run the setup wizard
./triggerfish dive

# 5. (Optional) Install as a background daemon
./triggerfish start
```

Alternatively, use the archived from-source install scripts:

```bash
bash deploy/scripts/install-from-source.sh     # Linux / macOS
deploy/scripts/install-from-source.ps1          # Windows
```

::: info Building from source requires Deno 2.x and git. The `deno task compile`
command produces a self-contained binary with no external dependencies. :::

## Cross-Platform Binary Builds

To build binaries for all platforms from any host machine:

```bash
make release
```

This produces all 5 binaries plus checksums in `dist/`:

| File                          | Platform                   |
| ----------------------------- | -------------------------- |
| `triggerfish-linux-x64`       | Linux x86_64               |
| `triggerfish-linux-arm64`     | Linux ARM64                |
| `triggerfish-macos-x64`       | macOS Intel                |
| `triggerfish-macos-arm64`     | macOS Apple Silicon        |
| `triggerfish-windows-x64.exe` | Windows x86_64             |
| `SHA256SUMS.txt`              | Checksums for all binaries |

## Runtime Directory

After running `triggerfish dive`, your configuration and data live at
`~/.triggerfish/`:

```
~/.triggerfish/
├── triggerfish.yaml          # Main configuration
├── SPINE.md                  # Agent identity and mission (system prompt)
├── TRIGGER.md                # Proactive behaviour triggers
├── workspace/                # Agent code workspace
├── skills/                   # Installed skills
├── data/                     # SQLite database, session state
└── logs/                     # Daemon and execution logs
```

In Docker, this maps to `/data/` inside the container.

## Daemon Management

The installer sets up Triggerfish as an OS-native background service:

| Platform | Service Manager                  |
| -------- | -------------------------------- |
| macOS    | launchd                          |
| Linux    | systemd                          |
| Windows  | Windows Service / Task Scheduler |

After installation, manage the daemon with:

```bash
triggerfish start     # Install and start the daemon
triggerfish stop      # Stop the daemon
triggerfish status    # Check if the daemon is running
triggerfish logs      # View daemon logs
```

## Release Process

Releases are automated via GitHub Actions. To create a new release:

```bash
git tag v0.2.0
git push origin v0.2.0
```

This triggers the release workflow which builds all 5 platform binaries, creates
a GitHub Release with checksums, and pushes a multi-arch Docker image to GHCR.
The install scripts automatically download the latest release.

## Updating

To check for and install updates:

```bash
triggerfish update
```

## Platform Support

| Platform    | Binary | Docker | Install Script   |
| ----------- | ------ | ------ | ---------------- |
| Linux x64   | yes    | yes    | yes              |
| Linux arm64 | yes    | yes    | yes              |
| macOS x64   | yes    | —      | yes              |
| macOS arm64 | yes    | —      | yes              |
| Windows x64 | yes    | —      | yes (PowerShell) |

## Next Steps

With Triggerfish installed, head to the [Quick Start](./quickstart) guide to
configure your agent and start chatting.
