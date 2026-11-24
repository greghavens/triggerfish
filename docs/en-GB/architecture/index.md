# Architecture Overview

Triggerfish is a secure, multi-channel AI agent platform with a single core
invariant:

::: warning SECURITY **Security is deterministic and sub-LLM.** Every security
decision is made by pure code that the LLM cannot bypass, override, or
influence. The LLM has zero authority -- it requests actions; the policy layer
decides. :::

This page provides the big picture of how Triggerfish works. Each major
component links to a dedicated deep-dive page.

## System Architecture

<img src="/diagrams/system-architecture.svg" alt="System architecture: channels flow through the Channel Router to the Gateway, which coordinates Session Manager, Policy Engine, and Agent Loop" style="max-width: 100%;" />

### Data Flow

Every message follows this path through the system:

<img src="/diagrams/data-flow-9-steps.svg" alt="Data flow: 9-step pipeline from inbound message through policy hooks to outbound delivery" style="max-width: 100%;" />

At every enforcement point, the decision is deterministic -- the same input
always produces the same result. There are no LLM calls inside hooks, no
randomness, and no way for the LLM to influence the outcome.

## Major Components

### Classification System

Data flows through four ordered levels:
`RESTRICTED > CONFIDENTIAL > INTERNAL > PUBLIC`. The core rule is **no
write-down**: data can only flow to equal or higher classification. A
`CONFIDENTIAL` session cannot send data to a `PUBLIC` channel. No exceptions. No
LLM override.

[Read more about the Classification System.](./classification)

### Policy Engine and Hooks

Eight deterministic enforcement hooks intercept every action at critical points
in the data flow. Hooks are pure functions: synchronous, logged, and
unforgeable. The policy engine supports fixed rules (never configurable),
admin-tunable rules, and declarative YAML escape hatches for enterprise.

[Read more about the Policy Engine.](./policy-engine)

### Sessions and Taint

Each conversation is a session with independent taint tracking. When a session
accesses classified data, its taint escalates to that level and can never
decrease within the session. A full reset clears taint AND conversation history.
Every data element carries provenance metadata through a lineage tracking
system.

[Read more about Sessions and Taint.](./taint-and-sessions)

### Gateway

The Gateway is the central control plane -- a long-running local service that
manages sessions, channels, tools, events, and agent processes through a
WebSocket JSON-RPC endpoint. It coordinates the notification service, cron
scheduler, webhook ingestion, and channel routing.

[Read more about the Gateway.](./gateway)

### Storage

All stateful data flows through a unified `StorageProvider` abstraction.
Namespaced keys (`sessions:`, `taint:`, `lineage:`, `audit:`) keep concerns
separated while allowing backends to be swapped without touching business logic.
The default is SQLite WAL at `~/.triggerfish/data/triggerfish.db`.

[Read more about Storage.](./storage)

### Defence in Depth

Security is layered across 13 independent mechanisms, from channel
authentication and permission-aware data access through session taint, policy
hooks, plugin sandboxing, filesystem tool sandboxing, and audit logging. No single layer is sufficient
alone; together they form a defence that degrades gracefully even if one layer
is compromised.

[Read more about Defence in Depth.](./defense-in-depth)

## Design Principles

| Principle                     | What it means                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Deterministic enforcement** | Policy hooks use pure functions. No LLM calls, no randomness. Same input always produces same decision.                          |
| **Taint propagation**         | All data carries classification metadata. Session taint can only escalate, never decrease.                                       |
| **No write-down**             | Data cannot flow to a lower classification level. Ever.                                                                          |
| **Audit everything**          | All policy decisions logged with full context: timestamp, hook type, session ID, input, result, rules evaluated.                 |
| **Hooks are unforgeable**     | The LLM cannot bypass, modify, or influence policy hook decisions. Hooks run in code below the LLM layer.                        |
| **Session isolation**         | Each session tracks taint independently. Background sessions spawn with fresh PUBLIC taint. Agent workspaces are fully isolated. |
| **Storage abstraction**       | No module creates its own storage. All persistence flows through `StorageProvider`.                                              |

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

::: info Triggerfish requires no external build tools, no Docker, and no cloud
dependency. It runs locally, processes data locally, and gives the user full
sovereignty over their data. :::
