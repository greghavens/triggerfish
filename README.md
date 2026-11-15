<p align="center">
  <img src="https://img.shields.io/badge/🐠_Triggerfish-AI_Agent_Platform-0077B6?style=for-the-badge&labelColor=023E8A" alt="Triggerfish" />
</p>

<h1 align="center">🐠 Triggerfish</h1>

<p align="center">
  <strong>A secure, multi-channel AI agent platform with deterministic policy enforcement below the LLM layer.</strong>
</p>

<p align="center">
  Your data stays classified. Your policies stay enforced. No exceptions.
</p>

<p align="center">
  <a href="https://github.com/greghavens/triggerfish/releases/latest"><img src="https://img.shields.io/github/v/tag/greghavens/triggerfish?label=Release&style=for-the-badge&color=0077B6" alt="Latest Release" /></a>
  <a href="https://github.com/greghavens/triggerfish/releases/latest"><img src="https://img.shields.io/github/release-date/greghavens/triggerfish?label=Released&style=for-the-badge&color=023E8A" alt="Release Date" /></a>
  <img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=for-the-badge" alt="Apache 2.0 License" />
  <img src="https://img.shields.io/badge/Runtime-Deno_2.x-000000?style=for-the-badge&logo=deno&logoColor=white" alt="Deno" />
  <img src="https://img.shields.io/badge/LLM-Claude_%7C_GPT_%7C_Gemini_%7C_Ollama_%7C_8%2B_Providers-8A2BE2?style=for-the-badge" alt="LLMs" />
</p>

---

## 🌊 Quick Install

One command. That's it.

**Linux / macOS:**

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.sh | bash
```

**Windows:**

```powershell
irm https://raw.githubusercontent.com/greghavens/triggerfish/master/scripts/install.ps1 | iex
```

**Docker:**

```bash
curl -sSL https://raw.githubusercontent.com/greghavens/triggerfish/master/deploy/docker/install.sh | sh
```

The binary installers download a pre-built release, verify its checksum, and run
the setup wizard. The Docker installer pulls the container image, installs a
`triggerfish` CLI wrapper, and runs the setup wizard. See the
[Installation & Deployment guide](https://trigger.fish/guide/installation) for
Docker setup, building from source, and the release process.

---

## 🐚 Commands

| Command               | Description                              |
| --------------------- | ---------------------------------------- |
| `triggerfish dive`    | 🤿 First-run setup wizard                |
| `triggerfish run`     | 🏄 Run gateway in foreground             |
| `triggerfish start`   | 🚀 Install and start the daemon          |
| `triggerfish stop`    | 🛑 Stop the daemon                       |
| `triggerfish status`  | 📡 Check if the daemon is running        |
| `triggerfish logs`    | 📜 View daemon logs (`--tail` to follow) |
| `triggerfish patrol`  | 🔍 Run health diagnostics                |
| `triggerfish version` | 🏷️ Show version                          |

---

## 🏗️ How It Works

```
                       🪸 The Reef
                    (Skill Marketplace)
                           |
Telegram  Signal  Slack  Discord  WhatsApp  WebChat  Email  Google Chat  CLI
   |        |       |       |        |         |       |        |         |
   +--------+-------+-------+--------+---------+-------+--------+---------+
                           |
                     Channel Router
                  (classification gate)
                           |
                     Gateway Server
                  (WebSocket control plane)
                           |
               +-----------+-----------+
               |                       |
         Policy Engine            Agent Loop
        (deterministic)          (LLM provider)
               |                       |
         +-----+-----+          +-----+-----+
         |     |     |          |     |     |
       Hooks Taint  Audit    Claude  GPT  Gemini
             Track   Log     Ollama  ...  Any LLM
```

---

## 🔒 Security Model

Triggerfish enforces security **below** the LLM layer. The AI cannot bypass,
modify, or influence policy decisions.

| Principle                  | How It Works                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 🏷️ **Classification**      | Every piece of data carries a sensitivity label: `PUBLIC`, `INTERNAL`, `CONFIDENTIAL`, or `RESTRICTED`       |
| 🎨 **Taint Propagation**   | Sessions absorb the classification of data they touch. Taint only escalates, never decreases                 |
| 🚫 **No Write-Down**       | `CONFIDENTIAL` data can never flow to a `PUBLIC` channel. The policy engine blocks it before the LLM sees it |
| ⚙️ **Deterministic Hooks** | Policy decisions are pure functions. No LLM calls, no randomness. Same input → same decision                 |
| 📋 **Audit Trail**         | Every policy decision is logged with full context: timestamp, hook, session, input, result                   |

---

## 💬 Channels

Triggerfish connects to your existing messaging platforms. Each channel has its
own classification level and owner settings.

| Channel        | Default Classification |
| -------------- | :--------------------: |
| 💻 CLI         |       `INTERNAL`       |
| ✈️ Telegram    |       `INTERNAL`       |
| 🔒 Signal      |        `PUBLIC`        |
| 💼 Slack       |        `PUBLIC`        |
| 🎮 Discord     |        `PUBLIC`        |
| 📱 WhatsApp    |        `PUBLIC`        |
| 🌐 WebChat     |        `PUBLIC`        |
| 📧 Email       |     `CONFIDENTIAL`     |
| 💬 Google Chat |        `PUBLIC`        |

> **Note:** All classifications are configurable. Set any channel to any level
> in your `triggerfish.yaml`.

---

## ⚙️ Configuration

After running `triggerfish dive`, your config lives at
`~/.triggerfish/triggerfish.yaml`:

```yaml
models:
  primary: claude-sonnet-4-5
  providers:
    anthropic:
      model: claude-sonnet-4-5
    openai:
      model: gpt-4o
    google:
      model: gemini-2.0-flash
    ollama:
      model: llama3
    fireworks:
      model: accounts/fireworks/models/llama-v3p1-70b-instruct

channels:
  telegram:
    botToken: "your-bot-token"
    ownerId: 123456789
  slack:
    botToken: "xoxb-..."
    appToken: "xapp-..."
    signingSecret: "..."
  discord:
    botToken: "your-discord-bot-token"
    ownerId: "your-discord-user-id"

classification:
  mode: personal
```

> 9 providers are supported out of the box — see the table below.

---

## 🧠 LLM Providers

Switch between providers or configure failover chains.

| Provider          | Auth         | Models                          |
| ----------------- | ------------ | ------------------------------- |
| 🟠 **Anthropic**  | API key      | Claude Opus, Sonnet, Haiku      |
| 🟢 **OpenAI**     | API key      | GPT-4o, o1, o3                  |
| 🔵 **Google**     | API key      | Gemini Pro, Flash               |
| 🏠 **Ollama**     | None (local) | Llama, Mistral, CodeLlama, etc. |
| 🖥️ **LM Studio**  | None (local) | Any GGUF model                  |
| 🌐 **OpenRouter** | API key      | Any model on OpenRouter         |
| ⚡ **ZenMux**     | API key      | Multi-provider routing          |
| 🤖 **Z.AI**       | API key      | GLM-4.7, GLM-4.5, GLM-5         |
| 🔥 **Fireworks**  | API key      | Llama, Mixtral, and more        |

---

## 🔗 Integrations

### GitHub

Connect GitHub with a single command:

```bash
triggerfish connect github
```

This gives the agent 14 built-in tools for repos, PRs, issues, Actions, and code
search — all with classification-aware taint propagation (public repos = PUBLIC,
private = CONFIDENTIAL).

For the full development feedback loop (agent creates branches, opens PRs,
responds to code review), Triggerfish also supports webhooks and the `gh` CLI:

| Component                       | Role                                                   |
| ------------------------------- | ------------------------------------------------------ |
| **Built-in `github_*` tools**   | REST API access to repos, PRs, issues, Actions, search |
| **Webhooks**                    | Receive PR review events from GitHub in real time      |
| **`gh` CLI via exec**           | Create PRs, comment, merge from the agent              |
| **git-branch-management skill** | Teaches the agent the full branch/PR/review workflow   |

See the [GitHub integration docs](https://trigger.fish/integrations/github) for
full setup instructions.

### Google Workspace

Connect Google with a single command:

```bash
triggerfish connect google
```

5 tools covering the core Google Workspace suite:

| Tool                | Capabilities                                     |
| ------------------- | ------------------------------------------------ |
| **google_calendar** | List, create, update, and delete calendar events |
| **google_drive**    | Search, read, and manage Drive files             |
| **google_gmail**    | Read, search, send, and label emails             |
| **google_sheets**   | Read and write spreadsheet data                  |
| **google_tasks**    | Manage task lists and items                      |

### Notion

8 tools for full Notion workspace access:

| Tool                        | Capabilities                           |
| --------------------------- | -------------------------------------- |
| **notion.search**           | Search across pages and databases      |
| **notion.pages.read**       | Read page content                      |
| **notion.pages.create**     | Create new pages with rich text        |
| **notion.pages.update**     | Update page properties                 |
| **notion.databases.query**  | Query databases with filters and sorts |
| **notion.databases.create** | Create new databases                   |
| **notion.blocks.read**      | Read block content                     |
| **notion.blocks.append**    | Append blocks to a page                |

### CalDAV

7 tools for any CalDAV-compatible calendar server (Nextcloud, Radicale, etc.):

- List calendars, list/get/create/update/delete events, query free/busy

### Reddit

Read-only Reddit access with rate limiting. Browse subreddits, threads, and
comments.

### Obsidian

6 tools for Obsidian vault integration:

- Read, write, search, and list notes
- Daily notes with template support
- Wikilink and backlink extraction

---

## 🧩 Platform Capabilities

### Workflow Engine

Built-in [CNCF Serverless Workflow](https://serverlessworkflow.io/) DSL engine
for orchestrating multi-step automations. Workflows support self-healing
(automatic error recovery), version management, and can be triggered by
schedules, webhooks, or agent decisions.

### Exec Environment

Isolated code execution sandbox where the agent writes, runs, and debugs its own
code in a tight write→run→fix feedback loop. Each agent gets an isolated
workspace directory with controlled process spawning.

### MCP Support

Full [Model Context Protocol](https://modelcontextprotocol.io/) client with a
policy-enforced proxy layer. Connect external MCP servers and all tool calls
flow through the same classification and taint enforcement as built-in tools.

### Plugin System

Extend Triggerfish with explicitly enabled, trusted plugins and a namespace
registry for tool discovery. Plugins execute in process with Triggerfish's
permissions. Untrusted plugin execution is disabled; runtime isolation is not
implemented.

---

## 🎯 Skills

Triggerfish ships with 10 bundled skills that teach the agent specialized
workflows:

- **deep-research** — Multi-step web research with source synthesis
- **tdd** — Test-driven development loop
- **pdf** — PDF reading and analysis
- **git-branch-management** — Full branch/PR/review workflow
- **integration-builder** — Build new integrations
- **skill-builder** — Create new skills
- **triggers** — Configure proactive agent wakeups
- **mastering-typescript** / **mastering-python** — Language coaching
- **triggerfish** — Platform self-documentation

Skills are folders with a `SKILL.md` file. Install community skills from The
Reef or create your own. See the
[Skills guide](https://trigger.fish/guide/skills) for details.

---

## 🐠 Key Concepts

| Concept          | Description                                                                          |
| ---------------- | ------------------------------------------------------------------------------------ |
| 🦴 **SPINE.md**  | Agent identity and mission file — your system prompt foundation                      |
| 🤿 **Dive**      | First-run setup wizard that creates your `triggerfish.yaml`                          |
| 🔍 **Patrol**    | Health check — verifies gateway, LLM, channels, and policies                         |
| 🌊 **Ripple**    | Typing indicators and online status signals                                          |
| 🎯 **Skill**     | A folder with `SKILL.md` that gives the agent new capabilities                       |
| ⏰ **Trigger**   | Periodic agent wakeup for proactive autonomous behavior                              |
| 🏖️ **Tide Pool** | Visual workspace rendered via Agent-to-UI protocol                                   |
| 🪸 **The Reef**  | Skill marketplace for discovering, installing, and publishing skills _(coming soon)_ |

---

## 🌟 Get Involved

Triggerfish is open source and we'd love your help.

- **Get started** — Run `triggerfish dive` and have your agent running in
  minutes
- **Report bugs & request features** —
  [Open an issue](https://github.com/greghavens/triggerfish/issues)
- **Contribute** — PRs welcome! Check the issues for good first tasks
- **Star the repo** — It helps others discover the project ⭐
- **Read the docs** — [trigger.fish](https://trigger.fish/)

---

## 📄 License

Apache 2.0

---

<p align="center">
  <sub>🐠 Secured by design. Powered by the ocean. 🌊</sub>
</p>
