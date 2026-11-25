---
name: triggerfish
version: 1.0.0
description: >
  How to operate and configure Triggerfish itself. Covers all CLI commands and
  flags, triggerfish.yaml parameters, secrets management, daemon management,
  log analysis, health diagnostics, filesystem layout, and core architecture
  concepts. Use when the user asks about Triggerfish commands, configuration,
  channels, logs, diagnostics, or how the platform works.
classification_ceiling: INTERNAL
---

# Triggerfish — Platform Reference

Triggerfish is a secure, multi-channel AI agent platform with deterministic
policy enforcement below the LLM layer. This skill covers how to operate and
configure it.

---

## CLI Reference

### Top-Level Commands

| Command                             | Description                                                            |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `triggerfish`                       | If no config exists, runs `dive`; otherwise shows help                 |
| `triggerfish chat`                  | Start an interactive CLI chat session                                  |
| `triggerfish run`                   | Run the gateway in the foreground (not as daemon)                      |
| `triggerfish start`                 | Install and start the OS daemon                                        |
| `triggerfish stop`                  | Stop the OS daemon                                                     |
| `triggerfish status`                | Show daemon running state, PID, uptime, manager type                   |
| `triggerfish logs`                  | Show last 50 log lines                                                 |
| `triggerfish patrol`                | Run health diagnostics                                                 |
| `triggerfish dive`                  | First-run setup wizard (creates triggerfish.yaml)                      |
| `triggerfish changelog`             | Show release notes between versions                                    |
| `triggerfish update`                | Download latest release, verify SHA256, replace binary, restart daemon |
| `triggerfish version` / `--version` | Show version string                                                    |
| `triggerfish help`                  | Show help                                                              |
| `triggerfish tidepool url`          | Print the Tidepool A2UI URL                                            |

### `logs` Flags

| Flag              | Description                                                                             |
| ----------------- | --------------------------------------------------------------------------------------- |
| `--tail`          | Follow the log live (like `tail -f`)                                                    |
| `--level <LEVEL>` | Filter by level: `ERROR`, `WARN`, `INFO`, `DEBUG`, `TRACE` (shows that level and above) |

### `dive` Flags

| Flag               | Description                                                                        |
| ------------------ | ---------------------------------------------------------------------------------- |
| `--force`          | Re-run wizard even if config already exists (lets you selectively update sections) |
| `--install-daemon` | Auto-start daemon after wizard completes (used by the install script)              |

### `config` Subcommands

| Subcommand                        | Description                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `config set <dotted.key> <value>` | Set any YAML key by dotted path                                                        |
| `config get <dotted.key>`         | Read any YAML key (masks keys containing `key`/`secret`/`token`)                       |
| `config validate`                 | Parse YAML and check structure                                                         |
| `config add-channel [type]`       | Interactive channel setup (telegram, slack, discord, whatsapp, webchat, email, signal) |
| `config remove-channel [type]`    | Remove a channel and optionally restart daemon                                         |
| `config add-plugin [name]`        | Interactive plugin setup (obsidian)                                                    |
| `config set-secret <key> <value>` | Store a value in the OS keychain                                                       |
| `config get-secret <key>`         | Retrieve a value from the OS keychain                                                  |
| `config migrate-secrets`          | Find plaintext secrets in YAML, move to keychain, rewrite with `secret:` refs          |
| `config add-mcp`                  | Interactive MCP server setup (prompts for ID, transport, classification)               |
| `config remove-mcp [server_id]`   | Remove an MCP server from config                                                       |
| `config list-mcp`                 | List all configured MCP servers with transport and classification                      |

### `cron` Subcommands

| Subcommand                            | Description                                        |
| ------------------------------------- | -------------------------------------------------- |
| `cron add "<cron-expression>" <task>` | Create a scheduled job                             |
| `cron list`                           | Show all jobs with last-run time and run count     |
| `cron delete <job_id>`                | Remove a job by UUID                               |
| `cron history <job_id>`               | Show last 20 executions with status/duration/error |

**`cron add` flag:**

- `--classification <level>` — classification ceiling for this job's session
  (default: `INTERNAL`). Valid: `PUBLIC`, `INTERNAL`, `CONFIDENTIAL`,
  `RESTRICTED`.

### `connect` / `disconnect` Subcommands

| Subcommand          | Description                                           |
| ------------------- | ----------------------------------------------------- |
| `connect google`    | OAuth2 flow for Gmail, Calendar, Tasks, Drive, Sheets |
| `connect github`    | Store GitHub PAT in keychain                          |
| `disconnect google` | Remove Google tokens                                  |
| `disconnect github` | Remove GitHub token                                   |

---

## Config File — `triggerfish.yaml`

**NEVER use `read_file`, `write_file`, `edit_file`, or `run_command` on
triggerfish.yaml.** It is a RESTRICTED file. Use `config_manage` to read/write
config values and `mcp_manage` to manage MCP servers. These tools handle backup,
validation, and runtime updates automatically. Direct file access is forbidden.

**Location:** `~/.triggerfish/triggerfish.yaml` (overridden by
`$TRIGGERFISH_DATA_DIR` env var; Docker uses `/data/triggerfish.yaml`)

A backup is automatically created in `~/.triggerfish/backups/` before every
config write (10 backups retained).

### Models

```yaml
models:
  primary:
    provider: anthropic
    model: claude-sonnet-4-5
  providers:
    anthropic:
      model: claude-sonnet-4-5
      apiKey: "secret:provider:anthropic:apiKey"
    openai:
      model: gpt-4o
      apiKey: "secret:provider:openai:apiKey"
    google:
      model: gemini-2.0-flash
      apiKey: "secret:provider:google:apiKey"
    openrouter:
      model: anthropic/claude-sonnet-4-5
      apiKey: "secret:provider:openrouter:apiKey"
    ollama:
      model: llama3
      endpoint: http://localhost:11434
    lmstudio:
      model: lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF
      endpoint: http://localhost:1234
```

**Common `config set` paths for models:**

- `models.primary.provider` — which provider to use
- `models.primary.model` — model ID
- `models.providers.anthropic.apiKey` — API key (use `secret:` reference)

### Channels

Each channel has a `classification` field controlling what data can flow through
it.

#### Telegram

```yaml
channels:
  telegram:
    botToken: "secret:telegram:botToken"
    ownerId: 123456789 # numeric Telegram user ID
    classification: INTERNAL
```

#### Slack

```yaml
channels:
  slack:
    botToken: "secret:slack:botToken" # xoxb-...
    appToken: "secret:slack:appToken" # xapp-... for Socket Mode
    signingSecret: "secret:slack:signingSecret"
    ownerId: "U012ABC3DEF" # optional
    classification: PUBLIC
```

#### Discord

```yaml
channels:
  discord:
    botToken: "secret:discord:botToken"
    ownerId: "123456789012345678" # optional snowflake
    classification: PUBLIC
```

#### WhatsApp

```yaml
channels:
  whatsapp:
    accessToken: "secret:whatsapp:accessToken"
    phoneNumberId: "123456789"
    verifyToken: "secret:whatsapp:webhookVerifyToken"
    webhookPort: 8443
    ownerPhone: "+15551234567" # optional
    classification: PUBLIC
```

#### WebChat

```yaml
channels:
  webchat:
    port: 8765
    classification: PUBLIC
```

#### Email

```yaml
channels:
  email:
    smtpApiUrl: "https://api.sendgrid.com/v3/mail/send"
    smtpApiKey: "secret:email:smtpApiKey"
    imapHost: "imap.gmail.com"
    imapPort: 993
    imapUser: "you@example.com"
    imapPassword: "secret:email:imapPassword"
    fromAddress: "you@example.com"
    pollInterval: 30000 # milliseconds
    ownerEmail: "you@example.com" # optional
    classification: CONFIDENTIAL
```

#### Signal

```yaml
channels:
  signal:
    account: "+15551234567" # E.164 format
    endpoint: "tcp://localhost:7583" # signal-cli daemon
    pairing: false # require pairing code for new contacts
    defaultGroupMode: "always" # always | mentioned-only | owner-only
    classification: PUBLIC
```

Signal requires a separate `signal-cli` binary and daemon. Run
`triggerfish config add-channel signal` for guided setup.

### Web

```yaml
web:
  search:
    provider: brave
    api_key: "secret:web:search:apiKey"
  fetch:
    enabled: true
```

### Scheduler

```yaml
scheduler:
  trigger:
    enabled: true
    interval_minutes: 30
    classification_ceiling: INTERNAL
    quiet_hours:
      start: 23 # 11pm local time
      end: 7 # 7am local time
  webhooks:
    sources:
      my-webhook:
        secret: "secret:webhook:my-webhook:secret"
```

### Plugins

```yaml
plugins:
  obsidian:
    enabled: true
    vault_path: ~/Documents/Obsidian
    classification: INTERNAL
    daily_notes:
      folder: daily
      date_format: YYYY-MM-DD
```

### Classification & Logging

```yaml
classification:
  mode: personal
  levels: standard

logging:
  level: normal # quiet | normal | verbose | debug
```

### Policy

```yaml
policy:
  default_action: ALLOW
```

---

## Secrets Management

**Never store plaintext secrets in `triggerfish.yaml`.** Use `secret:`
references resolved from the OS keychain at runtime.

**Store a secret:**

```
triggerfish config set-secret provider:anthropic:apiKey sk-ant-...
```

**Reference it in config:**

```yaml
models:
  providers:
    anthropic:
      apiKey: "secret:provider:anthropic:apiKey"
```

**Migrate existing plaintext secrets:**

```
triggerfish config migrate-secrets
```

This scans known secret fields, stores values in keychain, rewrites config with
`secret:` refs, and creates a backup first.

**Known secret field → keychain key mappings:**

| Config path                      | Keychain key             |
| -------------------------------- | ------------------------ |
| `models.providers.<name>.apiKey` | `provider:<name>:apiKey` |
| `web.search.api_key`             | `web:search:apiKey`      |
| `channels.telegram.botToken`     | `telegram:botToken`      |
| `channels.discord.botToken`      | `discord:botToken`       |
| `channels.slack.botToken`        | `slack:botToken`         |
| `channels.slack.appToken`        | `slack:appToken`         |
| `channels.slack.signingSecret`   | `slack:signingSecret`    |
| `channels.whatsapp.accessToken`  | `whatsapp:accessToken`   |
| `channels.email.imapPassword`    | `email:imapPassword`     |

---

## Filesystem Layout

```
~/.triggerfish/                          # base dir
│                                        # ($TRIGGERFISH_DATA_DIR or /data in Docker)
├── triggerfish.yaml                     # config
├── SPINE.md                             # agent identity & mission (optional)
├── TRIGGER.md                           # proactive trigger prompt (optional)
├── logs/
│   ├── triggerfish.log                  # current log
│   └── triggerfish.1.log ... .10.log   # rotated (1 = most recent, 10 max)
├── data/
│   └── triggerfish.db                   # SQLite: cron, sessions, memory
├── skills/                              # managed (Reef-installed) skills
├── workspace/
│   └── <agent-id>/
│       └── skills/                      # workspace (agent-authored) skills
└── backups/                             # timestamped config backups (10 max)

# Binary locations:
# macOS/Linux: /usr/local/bin/triggerfish  or  ~/.local/bin/triggerfish
# Windows:     %LOCALAPPDATA%\Triggerfish\triggerfish.exe

# Daemon service files:
# macOS:   ~/Library/LaunchAgents/dev.triggerfish.agent.plist
# Linux:   ~/.config/systemd/user/triggerfish.service
# Windows: Windows Service "Triggerfish"
```

**Ports:**

- Gateway WebSocket: `18789`
- Tidepool A2UI: `18790`

---

## Daemon Management

| Platform | Manager         | Service name            | Notes                                           |
| -------- | --------------- | ----------------------- | ----------------------------------------------- |
| macOS    | launchd         | `dev.triggerfish.agent` | plist in `~/Library/LaunchAgents/`              |
| Linux    | systemd (user)  | `triggerfish.service`   | unit in `~/.config/systemd/user/`               |
| Windows  | Windows Service | `Triggerfish`           | installer registers; `start` triggers elevation |

- `triggerfish start` — installs service definition and starts it
- `triggerfish stop` — stops the service
- `triggerfish status` — shows PID, uptime, manager type
- `triggerfish run` — runs gateway in foreground (no service install)
- `triggerfish update` — fetches latest GitHub release → verifies SHA256 → stops
  daemon → replaces binary → restarts daemon

**Linux linger note:** systemd user services stop on logout by default. The
installer enables linger (`loginctl enable-linger $USER`). If not set, run:
`sudo loginctl enable-linger $USER`

---

## Log System

**Log path:** `~/.triggerfish/logs/triggerfish.log` **Rotation:** `.1.log`
through `.10.log` (`.1` = most recent), 10 files max

**Log line format:**

```
[2026-02-17T14:30:45.123Z] [LEVEL] [component] message
```

**Levels (most severe → least):** ERROR > WARN > INFO > DEBUG > TRACE

**CLI access:**

```
triggerfish logs                   # last 50 lines
triggerfish logs --tail            # follow live
triggerfish logs --level ERROR     # only ERROR and WARN
triggerfish logs --level WARN      # WARN and ERROR
```

**Classification:** Log output is INTERNAL — never share raw logs on PUBLIC
channels.

**Bug report prep:** Collect last 50 ERROR/WARN lines, redact tokens and keys,
exclude TRACE content.

---

## Diagnostics — `triggerfish patrol`

Checks runtime health and prints a report:

| Check    | What it verifies                                  |
| -------- | ------------------------------------------------- |
| Gateway  | WebSocket on port 18789 is reachable              |
| LLM      | Provider connected (inferred from gateway health) |
| Channels | Number of channels configured in YAML             |
| Policy   | Policy rules loaded (fixed rules when running)    |
| Skills   | Installed skill count in `~/.triggerfish/skills/` |

**Status values:** `HEALTHY` / `WARNING` / `CRITICAL`

Exit code 1 if any check is CRITICAL.

---

## Architecture Concepts

**Classification levels** (ascending sensitivity): `PUBLIC` < `INTERNAL` <
`CONFIDENTIAL` < `RESTRICTED`

**Taint** — Session-level classification that only escalates, never decreases.
The session taint is determined by the most sensitive data it has accessed.

**No write-down** — Data cannot flow to a lower classification channel.
CONFIDENTIAL data is blocked from reaching a PUBLIC channel at the policy layer.

**Deterministic hooks** — Pure functions running below the LLM. Same input
always produces the same decision. The LLM cannot bypass or influence them.

Hook types: `PRE_CONTEXT_INJECTION`, `PRE_TOOL_CALL`, `POST_TOOL_RESPONSE`,
`PRE_OUTPUT`

**Session isolation** — Each session tracks taint independently. Background
sessions (triggers, cron jobs) start with fresh PUBLIC taint.

**Default deny** — Tools, integrations, and channels with no configured
classification are rejected. Unclassified operations are a security violation.

**SSRF prevention** — All outbound HTTP (web_fetch, browser navigate) resolves
DNS first and checks against a hardcoded IP denylist. Private/reserved IP ranges
are always blocked. This is not user-configurable.

**Audit trail** — Every policy decision is logged with timestamp, hook type,
session ID, input, and result.

---

## SPINE.md — Agent Identity

`~/.triggerfish/SPINE.md` is the agent's identity and mission file. Its contents
form the foundation of the system prompt. Use it to define the agent's name,
personality, capabilities, and standing instructions.

If the file does not exist, a generic identity is used.

---

## TRIGGER.md — Proactive Monitoring

`~/.triggerfish/TRIGGER.md` defines what the agent monitors and acts on during
periodic trigger wakeups. The scheduler reads this file at each trigger interval
and sends it as the prompt to a fresh session.

If TRIGGER.md does not exist, the scheduler uses a vague fallback prompt.
**Create it** when setting up proactive monitoring.

```markdown
# Morning Briefing

Check and summarize:

- Weather forecast for today
- New GitHub notifications
- Upcoming calendar events

## Alerts

- If any email marked urgent, notify me immediately
```

**Trigger config in `triggerfish.yaml`:**

```yaml
scheduler:
  trigger:
    enabled: true
    interval_minutes: 30
    classification_ceiling: INTERNAL # session cannot exceed this
    quiet_hours:
      start: 23
      end: 7
```

---

## Skills System

**Skill structure:** a folder containing `SKILL.md` with YAML frontmatter and a
markdown body.

**Frontmatter fields:**

- `name` — unique skill identifier
- `description` — when to use this skill (used for skill selection)
- `classification_ceiling` — max classification the skill can access
- `requires_tools` — list of tool names the skill needs
- `network_domains` — domains this skill is permitted to fetch from

**Three-tier priority** (higher wins):

1. **Workspace** — agent-authored, at
   `~/.triggerfish/workspace/<agent-id>/skills/` Require owner approval before
   activation.
2. **Managed** — installed from The Reef, at `~/.triggerfish/skills/`
3. **Bundled** — ship with Triggerfish binary, read-only

**Approval states for workspace skills:** `PENDING_APPROVAL` → `APPROVED` /
`REJECTED`

Security scan checks for prompt injection, identity hijacking, and privilege
escalation patterns before approval.

---

## MCP Server Management (`mcp_manage` tool)

Use `mcp_manage` to manage saved MCP server configuration. Configuration writes
take effect after a daemon restart. Use `tools` to check which tool names the
running gateway currently advertises.

| Action                        | Parameters                                           | Description                                                               |
| ----------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `list`                        | (none)                                               | List saved servers                                                        |
| `creation_status`             | `server_id`                                          | Review redacted metadata for an operator-supplied proposal                |
| `add`                         | `server_id`, `lifecycle_revision`                    | Request owner approval to save the exact proposal as a disabled connector |
| `update`                      | `server_id`, `tool_call_timeout_ms?`, `max_retries?` | Request owner confirmation for runtime settings                           |
| `status`                      | `server_id`                                          | Read detailed saved settings                                              |
| `lifecycle_status`            | `server_id`                                          | Read enabled state and an opaque revision                                 |
| `enable`, `disable`, `remove` | `server_id`, `lifecycle_revision`                    | Send an exact lifecycle request to the owner approval inbox               |
| `tools`                       | `server_id`                                          | List currently registered tool names                                      |

Read the current `lifecycle_revision` with `lifecycle_status` before enabling,
disabling, or removing a saved connector. The approval applies to the reviewed
connector and revision. After a successful write with `restart_needed: true`,
use `daemon_manage(action: "restart")` to apply it.

For creation, the operator supplies `mcp-proposals/<server_id>.yaml` beside the
daemon configuration file. The file contains one connector entry with an
explicit classification, a command or URL, and optional arguments and named
credential references where supported. Read its revision with `creation_status`
and use that revision in `add`. Review the exact proposal before approving the
inbox request. Use the separate `enable` workflow before restarting to connect
it.

Manually maintained connector configuration is still supported. The
model-callable `add` action accepts a reviewed proposal revision. Credential
environment bindings support `secret:<name>` and `keychain:<name>` references to
existing keys. Supply only non-secret command arguments because approved
arguments are saved in the configuration. HTTP connector proposals must use a
URL without inline credentials, query parameters, or a fragment.

---

## Configuration Management (`config_manage` tool)

Use the `config_manage` tool to read or modify triggerfish.yaml settings.

| Action                      | Parameters                                  | Description                     |
| --------------------------- | ------------------------------------------- | ------------------------------- |
| `get`                       | `key` (dotted path)                         | Read a config value             |
| `set`                       | `key`, `value`                              | Set a config value              |
| `show`                      | (none)                                      | Full config (secrets redacted)  |
| `add_channel`               | `channel_type`, `channel_config` (JSON)     | Add a channel                   |
| `remove_channel`            | `channel_type`                              | Remove a channel                |
| `list_channels`             | (none)                                      | List configured channels        |
| `set_search`                | `provider`, `api_key_secret?`               | Configure search provider       |
| `set_models`                | `provider`, `model`                         | Configure LLM models            |
| `set_integration`           | `integration`, `enabled`, `classification?` | Enable/disable an integration   |
| `set_domain_classification` | `domain_pattern`, `classification`          | Classify a domain pattern       |
| `set_tool_floor`            | `tool_prefix`, `classification`             | Set minimum tool classification |
| `set_filesystem_path`       | `path`, `classification`                    | Classify a filesystem path      |
| `set_logging`               | `level` (quiet/normal/verbose/debug)        | Set log level                   |

Most config writes require a daemon restart. Secret values must use
`secret:<name>` references.

**Common dotted key paths:**

| Key                                  | Example value                |
| ------------------------------------ | ---------------------------- |
| `models.primary.provider`            | `anthropic`                  |
| `models.primary.model`               | `claude-sonnet-4-5-20250514` |
| `web.search.provider`                | `brave`                      |
| `scheduler.trigger.enabled`          | `true`                       |
| `scheduler.trigger.interval_minutes` | `30`                         |

---

## Common Tasks

**Start fresh / initial setup:**

```
triggerfish dive
triggerfish start
```

**Add a channel:**

```
triggerfish config add-channel telegram
```

**Check if everything works:**

```
triggerfish patrol
triggerfish status
triggerfish logs --level WARN
```

**Change LLM model:**

```
triggerfish config set models.primary.model claude-opus-4-5
triggerfish config set models.primary.provider anthropic
```

**Add a daily 9am scheduled task:**

```
triggerfish cron add "0 9 * * *" morning briefing — check weather and email
triggerfish cron list
```

**Connect Google Workspace:**

```
triggerfish connect google
```

**Update to latest version:**

```
triggerfish update
```

**View release notes between versions:**

```
triggerfish changelog                       # Latest releases
triggerfish changelog v0.2.16 v0.3.3       # Between two versions
triggerfish changelog v0.2.16              # From version to current
triggerfish changelog --latest 10          # Last 10 releases
```

In chat, use the `release_notes` tool to fetch and summarize changes between
versions. Example: ask "What changed between v0.2.16 and v0.3.3?" and the agent
will fetch and summarize the release notes.

**Migrate plaintext secrets to keychain:**

```
triggerfish config migrate-secrets
```

**Re-run setup wizard to update a section:**

```
triggerfish dive --force
```
