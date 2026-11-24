# Pangkalahatang-tanaw ng Architecture

Ang Triggerfish ay isang secure, multi-channel AI agent platform na may isang pangunahing
invariant:

::: warning SECURITY **Deterministic at sub-LLM ang security.** Lahat ng security
decision ay ginagawa ng pure code na hindi kayang i-bypass, i-override, o
i-influence ng LLM. Zero authority ang LLM -- humihiling ito ng actions; ang policy layer
ang nagde-decide. :::

Nagbibigay ang page na ito ng malaking larawan kung paano gumagana ang Triggerfish. Bawat
major component ay may link sa dedicated deep-dive page.

## System Architecture

<img src="/diagrams/system-architecture.svg" alt="System architecture: dumadaloy ang channels sa Channel Router papunta sa Gateway, na nag-coordinate ng Session Manager, Policy Engine, at Agent Loop" style="max-width: 100%;" />

### Data Flow

Bawat mensahe ay sumusunod sa path na ito sa system:

<img src="/diagrams/data-flow-9-steps.svg" alt="Data flow: 9-step pipeline mula sa inbound message hanggang sa outbound delivery sa pamamagitan ng policy hooks" style="max-width: 100%;" />

Sa bawat enforcement point, deterministic ang decision -- ang parehong input ay
palaging gumagawa ng parehong resulta. Walang LLM calls sa loob ng hooks, walang
randomness, at walang paraan para ma-influence ng LLM ang outcome.

## Mga Pangunahing Component

### Classification System

Dumadaloy ang data sa apat na ordered levels:
`RESTRICTED > CONFIDENTIAL > INTERNAL > PUBLIC`. Ang pangunahing rule ay **no
write-down**: ang data ay maaari lamang dumaloy sa equal o higher classification. Ang
`CONFIDENTIAL` session ay hindi makapagpadala ng data sa isang `PUBLIC` channel. Walang exceptions. Walang
LLM override.

[Magbasa pa tungkol sa Classification System.](/fil-PH/architecture/classification)

### Policy Engine at Hooks

Walong deterministic enforcement hooks ang humaharang sa bawat action sa mga kritikal na punto
sa data flow. Ang hooks ay pure functions: synchronous, logged, at
unforgeable. Sinusuportahan ng policy engine ang fixed rules (hindi configurable),
admin-tunable rules, at declarative YAML escape hatches para sa enterprise.

[Magbasa pa tungkol sa Policy Engine.](/fil-PH/architecture/policy-engine)

### Sessions at Taint

Bawat usapan ay isang session na may independent taint tracking. Kapag nag-access
ang session ng classified data, ine-escalate ang taint nito sa level na iyon at hindi na
mababawasan sa loob ng session. Ang full reset ay nagki-clear ng taint AT conversation history.
Bawat data element ay may kasamang provenance metadata sa pamamagitan ng lineage tracking
system.

[Magbasa pa tungkol sa Sessions at Taint.](/fil-PH/architecture/taint-and-sessions)

### Gateway

Ang Gateway ang central control plane -- isang long-running local service na
namamahala ng sessions, channels, tools, events, at agent processes sa pamamagitan ng
WebSocket JSON-RPC endpoint. Kino-coordinate nito ang notification service, cron
scheduler, webhook ingestion, at channel routing.

[Magbasa pa tungkol sa Gateway.](/fil-PH/architecture/gateway)

### Storage

Lahat ng stateful data ay dumadaan sa unified `StorageProvider` abstraction.
Ang namespaced keys (`sessions:`, `taint:`, `lineage:`, `audit:`) ay nagpapanatiling
hiwalay ng mga concerns habang pinapahintulutan ang backends na ma-swap nang hindi ginagalaw ang business logic.
Ang default ay SQLite WAL sa `~/.triggerfish/data/triggerfish.db`.

[Magbasa pa tungkol sa Storage.](/fil-PH/architecture/storage)

### Defense in Depth

Naka-layer ang security sa 13 independent mechanisms, mula sa channel
authentication at permission-aware data access hanggang sa session taint, policy
hooks, plugin sandboxing, filesystem tool sandboxing, at audit logging. Walang isang layer na sapat
mag-isa; magkasama sila ay bumubuo ng defense na gracefully nag-degrade kahit na ma-compromise ang isang layer.

[Magbasa pa tungkol sa Defense in Depth.](/fil-PH/architecture/defense-in-depth)

## Mga Prinsipyo ng Design

| Prinsipyo                     | Ano ang ibig sabihin                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Deterministic enforcement** | Gumagamit ang policy hooks ng pure functions. Walang LLM calls, walang randomness. Parehong input palaging gumagawa ng parehong decision.    |
| **Taint propagation**         | Lahat ng data ay may kasamang classification metadata. Ang session taint ay pataas lamang, hindi pababa.                                     |
| **No write-down**             | Hindi maaaring dumaloy ang data sa mas mababang classification level. Kailanman.                                                             |
| **Audit everything**          | Lahat ng policy decisions ay naka-log na may buong context: timestamp, hook type, session ID, input, result, rules evaluated.                |
| **Hooks are unforgeable**     | Hindi kayang i-bypass, baguhin, o i-influence ng LLM ang policy hook decisions. Tumatakbo ang hooks sa code sa ilalim ng LLM layer.          |
| **Session isolation**         | Bawat session ay nag-track ng taint nang independyente. Ang background sessions ay nag-spawn na may fresh PUBLIC taint. Fully isolated ang agent workspaces. |
| **Storage abstraction**       | Walang module ang gumagawa ng sariling storage. Lahat ng persistence ay dumadaan sa `StorageProvider`.                                       |

## Technology Stack

| Component          | Technology                                                                |
| ------------------ | ------------------------------------------------------------------------- |
| Runtime            | Deno 2.x (TypeScript strict mode)                                         |
| Testing            | Deno built-in test runner                                                 |
| Channels           | Baileys (WhatsApp), grammY (Telegram), Bolt (Slack), discord.js (Discord) |
| Browser automation | puppeteer-core (CDP)                                                      |
| Voice              | Whisper (local STT), ElevenLabs/OpenAI (TTS)                              |
| Storage            | SQLite WAL (default), enterprise backends (Postgres, S3)                  |
| Secrets            | OS keychain (personal), vault integration (enterprise)                    |

::: info Hindi nangangailangan ang Triggerfish ng external build tools, walang Docker, at walang cloud
dependency. Tumatakbo ito locally, nagpo-process ng data locally, at nagbibigay sa user ng buong
sovereignty sa kanilang data. :::
