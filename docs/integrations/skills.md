# Skills Platform

Skills are Triggerfish's primary extensibility mechanism. A skill is a folder
containing a `SKILL.md` file -- instructions and metadata that give the agent
new capabilities without requiring you to write a plugin or build custom code.

Skills are how the agent learns to do new things: check your calendar, prepare
morning briefings, triage GitHub issues, draft weekly summaries. They can be
installed from a marketplace, written by hand, or authored by the agent itself.

## What Is a Skill?

A skill is a folder with a `SKILL.md` file at its root. The file contains YAML
frontmatter (metadata) and markdown body (instructions for the agent). Optional
supporting files -- scripts, templates, configuration -- can live alongside it.

```
morning-briefing/
  SKILL.md
  briefing.ts        # Optional supporting code
  template.md        # Optional template
```

The `SKILL.md` frontmatter declares what the skill does, what it needs, and what
security constraints apply:

```yaml
---
name: morning-briefing
description: Prepare a daily morning briefing with calendar, email, and weather
version: 1.0.0
category: productivity
tags:
  - calendar
  - email
  - daily
triggers:
  - cron: "0 7 * * *"
metadata:
  triggerfish:
    classification_ceiling: INTERNAL
    requires_tools:
      - browser
      - exec
    network_domains:
      - api.openweathermap.org
      - www.googleapis.com
---

## Instructions

When triggered (daily at 7 AM) or invoked by the user:

1. Fetch today's calendar events from Google Calendar
2. Summarize unread emails from the last 12 hours
3. Get the weather forecast for the user's location
4. Compile a concise briefing and deliver it to the configured channel

Format the briefing with sections for Calendar, Email, and Weather.
Keep it scannable -- bullet points, not paragraphs.
```

### Frontmatter Fields

| Field                                         | Required | Description                                                        |
| --------------------------------------------- | :------: | ------------------------------------------------------------------ |
| `name`                                        |   Yes    | Unique skill identifier                                            |
| `description`                                 |   Yes    | Human-readable description of what the skill does                  |
| `version`                                     |   Yes    | Semantic version                                                   |
| `category`                                    |    No    | Grouping category (productivity, development, communication, etc.) |
| `tags`                                        |    No    | Searchable tags for discovery                                      |
| `triggers`                                    |    No    | Automatic invocation rules (cron schedules, event patterns)        |
| `metadata.triggerfish.classification_ceiling` |    No    | Maximum taint level this skill can reach (default: `PUBLIC`)      |
| `metadata.triggerfish.requires_tools`         |    No    | Tools the skill depends on (browser, exec, etc.)                   |
| `metadata.triggerfish.network_domains`        |    No    | Allowed network endpoints for the skill                            |

## Skill Types

Triggerfish supports three types of skills, with a clear priority order when
names conflict.

### Bundled Skills

Ship with Triggerfish in the `skills/bundled/` directory. Maintained by the
project. Always available.

Triggerfish includes ten bundled skills that make the agent self-sufficient from
day one:

| Skill                     | Description                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tdd**                   | Test-Driven Development methodology for Deno 2.x. Red-green-refactor cycle, `Deno.test()` patterns, `@std/assert` usage, Result type testing, test helpers.         |
| **mastering-typescript**  | TypeScript patterns for Deno and Triggerfish. Strict mode, `Result<T, E>`, branded types, factory functions, immutable interfaces, `mod.ts` barrels.                |
| **skill-builder**         | How to author new skills. SKILL.md format, frontmatter fields, classification ceilings, self-authoring workflow, security scanning.                                 |
| **integration-builder**   | How to build Triggerfish integrations. All six patterns: channel adapters, LLM providers, MCP servers, storage providers, exec tools, and plugins.                  |
| **git-branch-management** | Git branch workflow for development. Feature branches, atomic commits, PR creation via `gh` CLI, PR tracking, review feedback loop via webhooks, merge and cleanup. |
| **deep-research**         | Multi-step research methodology. Source evaluation, parallel searches, synthesis, and citation formatting.                                                           |
| **pdf**                   | PDF document processing. Text extraction, summarization, and structured data extraction from PDF files.                                                              |
| **triggerfish**            | Self-knowledge about Triggerfish internals. Architecture, configuration, troubleshooting, and development patterns.                                                  |
| **triggers**              | Proactive behavior authoring. Writing effective TRIGGER.md files, monitoring patterns, and escalation rules.                                                         |

These are the bootstrap skills -- the agent uses them to extend itself. The
skill-builder teaches the agent how to create new skills, and the
integration-builder teaches it how to build new adapters and providers.

See [Building Skills](/integrations/building-skills) for a hands-on guide to
creating your own.

### Managed Skills

Installed from **The Reef** (the community skill marketplace). Downloaded and
stored in `~/.triggerfish/skills/`.

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### Workspace Skills

Created by the user or authored by the agent in the
[exec environment](./exec-environment). Stored in the agent's workspace at
`~/.triggerfish/workspace/<agent-id>/skills/`.

Workspace skills take the highest priority. If you create a skill with the same
name as a bundled or managed skill, your version takes precedence.

```
Priority:  Workspace  >  Managed  >  Bundled
```

::: tip This priority order means you can always override a bundled or
marketplace skill with your own version. Your customizations are never
overwritten by updates. :::

## Skill Discovery and Loading

When the agent starts or when skills change, Triggerfish runs a skill discovery
process:

1. **Scanner** -- Finds all installed skills across bundled, managed, and
   workspace directories
2. **Loader** -- Reads SKILL.md frontmatter and validates metadata
3. **Resolver** -- Resolves naming conflicts using the priority order
4. **Registration** -- Makes skills available to the agent with their declared
   capabilities and constraints

Skills with `triggers` in their frontmatter are automatically wired into the
scheduler. Skills with `requires_tools` are checked against the agent's
available tools -- if a required tool is not available, the skill is flagged but
not blocked.

## Agent Self-Authoring

A key differentiator: the agent can write its own skills. When asked to do
something it does not know how to do, the agent can use the
[exec environment](./exec-environment) to create a `SKILL.md` and supporting
code, then package it as a workspace skill.

### Self-Authoring Flow

```
1. You:   "I need you to check my Notion for new tasks every morning"
2. Agent: Creates skill at ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/
          Writes SKILL.md with metadata and instructions
          Writes supporting code (notion-tasks.ts)
          Tests the code in the exec environment
3. Agent: Marks the skill as PENDING_APPROVAL
4. You:   Receive notification: "New skill created: notion-tasks. Review and approve?"
5. You:   Approve the skill
6. Agent: Wires the skill into a cron job for daily execution
```

::: warning SECURITY Agent-authored skills always require owner approval before
they become active. The agent cannot self-approve its own skills. This prevents
the agent from creating capabilities that bypass your oversight. :::

### Enterprise Controls

In enterprise deployments, additional controls apply to self-authored skills:

- Agent-authored skills always require owner or admin approval
- Skills cannot declare a classification ceiling above the user's clearance
- Network endpoint declarations are audited
- All self-authored skills are logged for compliance review

## The Reef <ComingSoon :inline="true" />

The Reef is Triggerfish's community skill marketplace -- a registry where you
can discover, install, publish, and share skills.

| Feature             | Description                                              |
| ------------------- | -------------------------------------------------------- |
| Search and browse   | Find skills by category, tag, or popularity              |
| One-command install | `triggerfish skill install <name>`                       |
| Publish             | Share your skills with the community                     |
| Security scanning   | Automated scanning for malicious patterns before listing |
| Versioning          | Skills are versioned with update management              |
| Reviews and ratings | Community feedback on skill quality                      |

### CLI Commands

```bash
# Search for skills
triggerfish skill search "calendar"

# Install a skill from The Reef
triggerfish skill install google-cal

# List installed skills
triggerfish skill list

# Update all managed skills
triggerfish skill update --all

# Publish a skill to The Reef
triggerfish skill publish

# Remove a skill
triggerfish skill remove google-cal
```

### Security

Skills installed from The Reef go through the same lifecycle as any other
integration:

1. Downloaded to the managed skills directory
2. Scanned for malicious patterns (code injection, unauthorized network access,
   etc.)
3. Enter `UNTRUSTED` state until you classify them
4. Classified and activated by the owner or admin

::: info The Reef scans all published skills for known malicious patterns before
they are listed. However, you should still review skills before classifying
them, especially skills that declare network access or require powerful tools
like `exec` or `browser`. :::

## Skill Security Summary

- Skills declare their security requirements upfront (classification ceiling,
  tools, network domains)
- Tool access is gated by policy -- a skill that `requires_tools: [browser]`
  will not work if browser access is blocked by policy
- Network domains are enforced -- a skill cannot access endpoints it did not
  declare
- Agent-authored skills require explicit owner/admin approval
- All skill invocations pass through policy hooks and are fully audited
