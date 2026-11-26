# Configuration

Triggerfish is configured through a single YAML file at
`~/.triggerfish/triggerfish.yaml`. The setup wizard (`triggerfish dive`) creates
this file for you, but you can edit it manually at any time.

## Config File Location

```
~/.triggerfish/triggerfish.yaml
```

You can set individual values from the command line using dotted paths:

```bash
triggerfish config set <key> <value>
triggerfish config get <key>
```

Boolean and integer values are auto-coerced. Secrets are masked in output.

Validate your configuration with:

```bash
triggerfish config validate
```

## Models

The `models` section configures your LLM providers and failover behavior.

To reload approved chat providers between turns, set
`models.live_route_allowlists` to a mapping such as
`{ INTERNAL: [anthropic, openai] }`. The allowlist takes effect at startup.
Under the gateway base directory, create the operator-controlled
`data/model-routes.json` with one exact provider and model per allowlisted
classification. This example selects OpenAI for INTERNAL turns.

```json
{"INTERNAL":{"provider":"openai","model":"gpt-4o"}}
```

Use a private file and replace it atomically to select a different approved
route. The provider and model must already exist in the configured provider
registry. Each new turn reads the same selection across gateway and
background agents. Uninterrupted turns keep their existing routes. A turn recovered from a
checkpoint resolves the current route on restart. Missing,
invalid, or revoked selections stop new turns while reload is enabled.
Unlisted classifications retain their startup routes. Omit the allowlist to
leave live reload disabled.

```yaml
models:
  # Which provider and model to use by default
  primary:
    provider: anthropic
    model: claude-sonnet-4-5-20250929

  # Optional: vision model for automatic image description when primary
  # model lacks vision support
  # vision: gemini-2.0-flash

  # Streaming responses (default: true)
  # streaming: true

  providers:
    anthropic:
      model: claude-sonnet-4-5-20250929

    openai:
      model: gpt-4o

    google:
      model: gemini-2.5-pro

    ollama:
      model: llama3
      endpoint: "http://localhost:11434" # Ollama default

    lmstudio:
      model: lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF
      endpoint: "http://localhost:1234" # LM Studio default

    openrouter:
      model: anthropic/claude-sonnet-4-5

    zenmux:
      model: openai/gpt-5

    zai:
      model: glm-4.7

  # Failover chain: if primary fails, try these in order
  failover:
    - openai
    - google
```

API keys are stored in the OS keychain, not in this file. The setup wizard
(`triggerfish dive`) prompts for your API key and stores it securely. Ollama and
LM Studio are local and require no authentication.

## Channels

The `channels` section defines which messaging platforms your agent connects to
and the classification level for each.

```yaml
channels:
  cli:
    enabled: true
    classification: INTERNAL

  telegram:
    enabled: true
    ownerId: 123456789
    classification: INTERNAL

  signal:
    enabled: true
    endpoint: "tcp://127.0.0.1:7583"
    account: "+14155552671"
    classification: PUBLIC
    defaultGroupMode: mentioned-only

  slack:
    enabled: true
    classification: PUBLIC

  discord:
    enabled: true
    ownerId: "your-discord-user-id"
    classification: PUBLIC

  whatsapp:
    enabled: true
    phoneNumberId: "your-phone-number-id"
    classification: PUBLIC

  webchat:
    enabled: true
    classification: PUBLIC
    port: 18790

  email:
    enabled: true
    imapHost: "imap.gmail.com"
    smtpApiUrl: "https://api.sendgrid.com/v3/mail/send"
    imapUser: "you@gmail.com"
    fromAddress: "bot@example.com"
    ownerEmail: "you@gmail.com"
    classification: CONFIDENTIAL
```

Tokens, passwords, and API keys for each channel are stored in the OS keychain.
Run `triggerfish config add-channel <name>` to enter credentials interactively
-- they are saved to the keychain, never to this file.

### Channel Configuration Keys

Non-secret configuration in `triggerfish.yaml`:

| Channel  | Config Keys                                                    | Optional Keys                                                           |
| -------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| CLI      | `enabled`                                                      | `classification`                                                        |
| Telegram | `enabled`, `ownerId`                                           | `classification`                                                        |
| Signal   | `enabled`, `endpoint`, `account`                               | `classification`, `defaultGroupMode`, `groups`, `ownerPhone`, `pairing` |
| Slack    | `enabled`                                                      | `classification`, `ownerId`                                             |
| Discord  | `enabled`, `ownerId`                                           | `classification`                                                        |
| WhatsApp | `enabled`, `phoneNumberId`                                     | `classification`, `ownerPhone`, `webhookPort`                           |
| WebChat  | `enabled`                                                      | `classification`, `port`, `allowedOrigins`                              |
| Email    | `enabled`, `smtpApiUrl`, `imapHost`, `imapUser`, `fromAddress` | `classification`, `ownerEmail`, `imapPort`, `pollInterval`              |

Secrets (bot tokens, API keys, passwords, signing secrets) are entered during
channel setup and stored in the OS keychain.

### Default Classification Levels

| Channel  | Default        |
| -------- | -------------- |
| CLI      | `INTERNAL`     |
| Telegram | `INTERNAL`     |
| Signal   | `PUBLIC`       |
| Slack    | `PUBLIC`       |
| Discord  | `PUBLIC`       |
| WhatsApp | `PUBLIC`       |
| WebChat  | `PUBLIC`       |
| Email    | `CONFIDENTIAL` |

All defaults are configurable. Set any channel to any classification level.

## MCP Servers

Connect external MCP servers to give your agent access to additional tools. See
[MCP Gateway](/integrations/mcp-gateway) for the full security model.

```yaml
mcp_servers:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_PERSONAL_ACCESS_TOKEN: "keychain:github-pat"
    classification: CONFIDENTIAL

  filesystem:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/you/docs"]
    classification: INTERNAL
```

Each server must have a `classification` level or it will be rejected (default
deny). Use `command` + `args` for local servers (spawned as subprocesses) or
`url` for remote servers (HTTP SSE). Environment values prefixed with
`keychain:` are resolved from the OS keychain.

For help choosing classification levels, see the
[Classification Guide](./classification-guide).

## Classification

The `classification` section controls how Triggerfish classifies and protects
data.

```yaml
classification:
  mode: personal # "personal" or "enterprise" (coming soon)
```

**Classification levels:**

| Level          | Description     | Examples                                              |
| -------------- | --------------- | ----------------------------------------------------- |
| `RESTRICTED`   | Most sensitive  | M&A documents, PII, bank accounts, medical records    |
| `CONFIDENTIAL` | Sensitive       | CRM data, financials, contracts, tax records          |
| `INTERNAL`     | Internal only   | Internal wikis, personal notes, contacts              |
| `PUBLIC`       | Safe for anyone | Marketing materials, public info, general web content |

For detailed guidance on choosing the right level for your integrations,
channels, and MCP servers, see the
[Classification Guide](./classification-guide).

## Policy

The `policy` section configures custom enforcement rules beyond the built-in
protections.

```yaml
policy:
  # Default action when no rule matches
  default_action: ALLOW

  # Custom rules
  rules:
    # Block tool responses containing SSN patterns
    - hook: POST_TOOL_RESPONSE
      conditions:
        - tool_name: "salesforce.*"
        - content_matches: '\b\d{3}-\d{2}-\d{4}\b'
      action: REDACT
      redaction_pattern: "[SSN REDACTED]"
      log_level: ALERT

    # Rate limit external API calls
    - hook: PRE_TOOL_CALL
      conditions:
        - tool_category: external_api
      rate_limit: 100/hour
      action: BLOCK
```

::: info The core security rules -- no write-down, session taint escalation,
audit logging -- are always enforced and cannot be disabled. Custom policy rules
add additional controls on top of these fixed protections. :::

### Tool approval inbox

Use `tool_approval` to require owner confirmation for exact root tool names.

```yaml
tool_approval:
  - sentinel_publish_graph_fact
```

In authenticated terminal chat, `/approvals` lists requests. Use
`/approve UUID` or `/deny UUID` to decide one request. The inbox retains the
session, run, assignment when available, tool name, status, and outcome.
Tool arguments and results stay out of the inbox.

An operator can reconnect while the original call is waiting. Dispatch checks
current policy and assignment scope again after approval. Requests expire with
the live turn or the inbox deadline. A gateway restart retains the journal and
ends held calls. It does not retry a claimed action with an unknown outcome.

## Web Search & Fetch

The `web` section configures web search and content fetching, including domain
security controls.

```yaml
web:
  search:
    provider: brave # Search backend (brave is currently supported)
    max_results: 10
    safe_search: moderate # off, moderate, strict
  fetch:
    rate_limit: 10 # Requests per minute
    max_content_length: 50000
    timeout: 30000
    default_mode: readability # readability or raw
  domains:
    denylist:
      - "*.malware-site.com"
    allowlist: [] # Empty = allow all (minus denylist)
    classifications:
      - pattern: "*.internal.corp"
        classification: CONFIDENTIAL
```

Set up search from the command line:

```bash
triggerfish config set web.search.provider brave
```

The Brave API key is entered during `triggerfish dive` and stored in the OS
keychain.

::: tip Get a Brave Search API key at
[brave.com/search/api](https://brave.com/search/api/). The free tier includes
2,000 queries/month. :::

## Cron Jobs

Schedule recurring tasks for your agent:

```yaml
cron:
  jobs:
    - id: morning-briefing
      schedule: "0 7 * * *" # 7 AM daily
      task: "Prepare morning briefing with calendar, unread emails, and weather"
      channel: telegram # Where to deliver results
      classification: INTERNAL # Max taint ceiling for this job

    - id: pipeline-check
      schedule: "0 */4 * * *" # Every 4 hours
      task: "Check Salesforce pipeline for changes"
      channel: slack
      classification: CONFIDENTIAL
```

Each cron job runs in its own isolated session with a classification ceiling.
All cron actions pass through the normal policy hooks.

## Trigger Timing

Configure how often your agent performs proactive check-ins:

```yaml
trigger:
  interval: 30m # Check every 30 minutes
  classification: INTERNAL # Max taint ceiling for trigger sessions
  quiet_hours: "22:00-07:00" # Don't trigger during quiet hours
```

The trigger system reads your `~/.triggerfish/TRIGGER.md` file to decide what to
check on each wakeup. See [SPINE and Triggers](./spine-and-triggers) for details
on writing your TRIGGER.md.

## Webhooks

Configure inbound sources under `scheduler.webhooks`:

```yaml
scheduler:
  webhooks:
    enabled: true
    max_age_ms: 300000
    sources:
      deploy:
        secret: secret:deploy-webhook
        classification: INTERNAL
```

POST to `/webhooks/deploy` with `x-timestamp` containing the current Unix time
in milliseconds and `x-signature` (or `x-hub-signature-256`) containing
`sha256=<hex HMAC-SHA256 of timestamp + "." + body>`. The signature
authenticates both freshness and body. Duplicate claims are rejected before
dispatch, and production replay records persist across daemon restarts.

Existing body-only signers must explicitly set `allow_body_signature: true`
under their source. This legacy mode does not authenticate the timestamp and
relies on the bounded replay cache; it does not provide the same freshness
guarantee. Timestamp checks still apply unless `max_age_ms` is explicitly `0`.

## Full Example

Here is a complete example configuration with comments:

```yaml
# ~/.triggerfish/triggerfish.yaml

# --- LLM Providers ---
models:
  primary:
    provider: anthropic
    model: claude-sonnet-4-5-20250929
  providers:
    anthropic:
      model: claude-sonnet-4-5-20250929
    openai:
      model: gpt-4o
  failover:
    - openai

# --- Channels ---
channels:
  cli:
    enabled: true
    classification: INTERNAL
  telegram:
    enabled: true
    ownerId: 123456789
    classification: INTERNAL
  signal:
    enabled: false
  slack:
    enabled: false

# --- Classification ---
classification:
  mode: personal

# --- Policy ---
policy:
  default_action: ALLOW

# --- Cron ---
cron:
  jobs:
    - id: morning-briefing
      schedule: "0 7 * * *"
      task: "Prepare morning briefing"
      channel: telegram
      classification: INTERNAL

# --- Triggers ---
trigger:
  interval: 30m
  classification: INTERNAL
  quiet_hours: "22:00-07:00"
```

## Next Steps

- Define your agent's identity in [SPINE.md](./spine-and-triggers)
- Set up proactive monitoring with [TRIGGER.md](./spine-and-triggers)
- Learn all CLI commands in the [Commands reference](./commands)
