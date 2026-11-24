# Building Integrations

Triggerfish is designed to be extended. Whether you want to connect a new data
source, automate a workflow, give your agent new skills, or react to external
events, there is a well-defined integration pathway -- and every pathway
respects the same security model.

## Integration Pathways

Triggerfish offers five distinct ways to extend the platform. Each serves a
different purpose, but all share the same security guarantees: classification
enforcement, taint tracking, policy hooks, and full audit logging.

| Pathway                                            | Purpose                                          | Best For                                                                      |
| -------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------- |
| [MCP Gateway](./mcp-gateway)                       | Connect external tool servers                    | Standardised agent-to-tool communication via the Model Context Protocol       |
| [Plugin SDK](./plugins)                            | Run sandboxed custom code                        | CRUD operations on external systems, complex data transformations, workflows  |
| [Exec Environment](./exec-environment)             | Agent writes and runs its own code               | Building integrations, prototyping, testing, and iterating in a feedback loop |
| [Skills](./skills)                                 | Give the agent new capabilities via instructions | Reusable behaviours, community marketplace, agent self-authoring              |
| [Browser Automation](./browser)                    | Control a browser instance via CDP               | Web research, form filling, scraping, automated web workflows                 |
| [Webhooks](./webhooks)                             | Receive inbound events from external services    | Real-time reactions to emails, alerts, CI/CD events, calendar changes         |
| [GitHub](./github)                                 | Full GitHub workflow integration                 | PR review loops, issue triage, branch management via webhooks + exec + skills |
| [Google Workspace](./google-workspace)             | Connect Gmail, Calendar, Tasks, Drive, Sheets    | Bundled OAuth2 integration with 14 tools for Google Workspace                 |
| [Obsidian](./obsidian)                             | Read, write, and search Obsidian vault notes     | Classification-gated note access with folder mappings, wikilinks, daily notes |

## Security Model

Every integration -- regardless of pathway -- operates under the same security
constraints.

### Everything Starts as UNTRUSTED

New MCP servers, plugins, channels, and webhook sources all default to the
`UNTRUSTED` state. They cannot exchange data with the agent until they are
explicitly classified by the owner (personal tier) or admin (enterprise tier).

```
UNTRUSTED  -->  CLASSIFIED  (after review, assigned a classification level)
UNTRUSTED  -->  BLOCKED     (explicitly prohibited)
```

### Classification Flows Through

When an integration returns data, that data carries a classification level.
Accessing classified data escalates the session taint to match. Once tainted,
the session cannot output to a lower-classification destination. This is the
[No Write-Down rule](/en-GB/security/no-write-down) -- it is fixed and cannot be
overridden.

### Policy Hooks Enforce at Every Boundary

All integration actions pass through deterministic policy hooks:

| Hook                    | When It Fires                                                       |
| ----------------------- | ------------------------------------------------------------------- |
| `PRE_CONTEXT_INJECTION` | External data enters the agent context (webhooks, plugin responses) |
| `PRE_TOOL_CALL`         | Agent requests a tool call (MCP, exec, browser)                     |
| `POST_TOOL_RESPONSE`    | Tool returns data (classify response, update taint)                 |
| `PRE_OUTPUT`            | Response leaves the system (final classification check)             |

These hooks are pure functions -- no LLM calls, no randomness, no bypass. Same
input always produces the same decision.

### Audit Trail

Every integration action is logged: what was called, who called it, what the
policy decision was, and how session taint changed. This audit trail is
immutable and available for compliance review.

::: warning SECURITY The LLM cannot bypass, modify, or influence policy hook
decisions. Hooks run in code below the LLM layer. The AI requests actions -- the
policy layer decides. :::

## Choosing the Right Pathway

Use this decision guide to pick the integration pathway that fits your use case:

- **You want to connect a standard tool server** -- Use the
  [MCP Gateway](./mcp-gateway). If a tool speaks MCP, this is the path.
- **You need to run custom code against an external API** -- Use the
  [Full plugin guide](./plugins).
- **You want the agent to build and iterate on code** -- Use the
  [Exec Environment](./exec-environment). The agent gets a workspace with a full
  write/run/fix loop.
- **You want to teach the agent a new behaviour** -- Use [Skills](./skills).
  Write a `SKILL.md` with instructions, or let the agent author its own.
- **You need to automate web interactions** -- Use
  [Browser Automation](./browser). CDP-controlled Chromium with domain policy
  enforcement.
- **You need to react to external events in real time** -- Use
  [Webhooks](./webhooks). Inbound events verified, classified, and routed to the
  agent.

::: tip These pathways are not mutually exclusive. A skill might use browser
automation internally. A plugin might be triggered by a webhook. An
agent-authored integration in the exec environment can be persisted as a skill.
They compose naturally. :::
