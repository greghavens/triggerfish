# Skills Platform

Skills ಎಂಬವು Triggerfish ನ ಪ್ರಾಥಮಿಕ extensibility mechanism. ಒಂದು skill ಎಂಬುದು
`SKILL.md` ಫೈಲ್ ಒಳಗೊಂಡ ಒಂದು folder -- plugin ಬರೆಯಲು ಅಥವಾ custom code build
ಮಾಡಲು ಅಗತ್ಯವಿಲ್ಲದೆ agent ಗೆ ಹೊಸ capabilities ನೀಡುವ ಸೂಚನೆಗಳು ಮತ್ತು metadata.

Skills agent ಹೊಸ ಕೆಲಸ ಕಲಿಯಲು ಹೇಗೆ: calendar ತಪಾಸಿಸಿ, ಬೆಳಿಗ್ಗೆ briefings ತಯಾರಿಸಿ,
GitHub issues ವಿಂಗಡಿಸಿ, ವಾರದ summaries ರಚಿಸಿ. ಇವನ್ನು marketplace ನಿಂದ install
ಮಾಡಬಹುದು, ಕೈಯಿಂದ ಬರೆಯಬಹುದು, ಅಥವಾ agent ತಾನೇ author ಮಾಡಬಹುದು.

## Skill ಎಂದರೇನು?

Skill ಎಂಬುದು root ನಲ್ಲಿ `SKILL.md` ಫೈಲ್ ಇರುವ folder. ಫೈಲ್ YAML frontmatter
(metadata) ಮತ್ತು markdown body (agent ಗಾಗಿ ಸೂಚನೆಗಳು) ಒಳಗೊಂಡಿರುತ್ತದೆ. ಐಚ್ಛಿಕ
supporting files -- scripts, templates, configuration -- ಅದರ ಜೊತೆ ಇರಬಹುದು.

```
morning-briefing/
  SKILL.md
  briefing.ts        # Optional supporting code
  template.md        # Optional template
```

`SKILL.md` frontmatter skill ಏನು ಮಾಡುತ್ತದೆ, ಏನು ಅಗತ್ಯ, ಮತ್ತು ಯಾವ security
ನಿರ್ಬಂಧಗಳು ಅನ್ವಯಿಸುತ್ತವೆ ಎಂದು declare ಮಾಡುತ್ತದೆ:

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
| `name`                                        |   Yes    | ಅನನ್ಯ skill identifier                                             |
| `description`                                 |   Yes    | Skill ಏನು ಮಾಡುತ್ತದೆ ಎಂಬ human-readable ವಿವರಣೆ                    |
| `version`                                     |   Yes    | Semantic version                                                   |
| `category`                                    |    No    | Grouping category (productivity, development, communication, ಇತ್ಯಾದಿ) |
| `tags`                                        |    No    | Discovery ಗಾಗಿ searchable tags                                     |
| `triggers`                                    |    No    | ಸ್ವಯಂಚಾಲಿತ invocation rules (cron schedules, event patterns)      |
| `metadata.triggerfish.classification_ceiling` |    No    | Skill ತಲುಪಬಹುದಾದ ಗರಿಷ್ಠ taint ಮಟ್ಟ (ಡಿಫಾಲ್ಟ್: `PUBLIC`)         |
| `metadata.triggerfish.requires_tools`         |    No    | Skill ಅವಲಂಬಿಸುವ tools (browser, exec, ಇತ್ಯಾದಿ)                  |
| `metadata.triggerfish.network_domains`        |    No    | Skill ಗಾಗಿ allowed network endpoints                               |

## Skill Types

Triggerfish ಮೂರು ಬಗೆಯ skills ಬೆಂಬಲಿಸುತ್ತದೆ, ಹೆಸರುಗಳು conflict ಆದಾಗ ಸ್ಪಷ್ಟ
priority order ಜೊತೆ.

### Bundled Skills

`skills/bundled/` directory ನಲ್ಲಿ Triggerfish ಜೊತೆ ship ಮಾಡಲ್ಪಡುತ್ತವೆ. Project
ನಿಂದ ನಿರ್ವಹಿಸಲ್ಪಡುತ್ತವೆ. ಯಾವಾಗಲೂ ಲಭ್ಯ.

Triggerfish ಹತ್ತು bundled skills ಒಳಗೊಂಡಿದ್ದು agent ಅನ್ನು ಮೊದಲ ದಿನದಿಂದ self-sufficient
ಮಾಡುತ್ತದೆ:

| Skill                     | Description                                                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tdd**                   | Deno 2.x ಗಾಗಿ Test-Driven Development methodology. Red-green-refactor cycle, `Deno.test()` patterns, `@std/assert` ಬಳಕೆ, Result type testing.                    |
| **mastering-typescript**  | Deno ಮತ್ತು Triggerfish ಗಾಗಿ TypeScript patterns. Strict mode, `Result<T, E>`, branded types, factory functions, immutable interfaces.                             |
| **skill-builder**         | ಹೊಸ skills ಹೇಗೆ author ಮಾಡಬೇಕು. SKILL.md format, frontmatter fields, classification ceilings, self-authoring workflow.                                           |
| **integration-builder**   | Triggerfish integrations ಹೇಗೆ build ಮಾಡಬೇಕು. ಆರು patterns: channel adapters, LLM providers, MCP servers, storage providers, exec tools, ಮತ್ತು plugins.           |
| **git-branch-management** | Development ಗಾಗಿ Git branch workflow. Feature branches, atomic commits, PR creation via `gh` CLI, PR tracking.                                                    |
| **deep-research**         | ಮಲ್ಟಿ-ಸ್ಟೆಪ್ ಸಂಶೋಧನಾ methodology. Source evaluation, parallel searches, synthesis, ಮತ್ತು citation formatting.                                                   |
| **pdf**                   | PDF document processing. Text extraction, summarization, ಮತ್ತು PDF files ನಿಂದ structured data extraction.                                                       |
| **triggerfish**            | Triggerfish internals ಬಗ್ಗೆ self-knowledge. Architecture, configuration, troubleshooting, ಮತ್ತು development patterns.                                             |
| **triggers**              | Proactive behavior authoring. ಪರಿಣಾಮಕಾರಿ TRIGGER.md files ಬರೆಯುವುದು, monitoring patterns, ಮತ್ತು escalation rules.                                              |

ಇವು bootstrap skills -- agent ತನ್ನನ್ನು ತಾನೇ ವಿಸ್ತರಿಸಲು ಇವನ್ನು ಬಳಸುತ್ತದೆ.
Skill-builder agent ಗೆ ಹೊಸ skills ಹೇಗೆ ರಚಿಸಬೇಕು ಮತ್ತು integration-builder ಹೊಸ
adapters ಮತ್ತು providers ಹೇಗೆ build ಮಾಡಬೇಕು ಕಲಿಸುತ್ತದೆ.

ನಿಮ್ಮ ಸ್ವಂತ ರಚಿಸಲು hands-on guide ಗಾಗಿ [Building Skills](/kn-IN/integrations/building-skills)
ನೋಡಿ.

### Managed Skills

**The Reef** (community skill marketplace) ನಿಂದ Install ಮಾಡಲ್ಪಡುತ್ತವೆ.
`~/.triggerfish/skills/` ನಲ್ಲಿ download ಮಾಡಿ ಉಳಿಸಲ್ಪಡುತ್ತವೆ.

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### Workspace Skills

[Exec environment](./exec-environment) ನಲ್ಲಿ ಬಳಕೆದಾರ ಅಥವಾ agent author ಮಾಡಿ
ರಚಿಸಲ್ಪಡುತ್ತವೆ. Agent ನ workspace ನಲ್ಲಿ `~/.triggerfish/workspace/<agent-id>/skills/`
ನಲ್ಲಿ ಉಳಿಸಲ್ಪಡುತ್ತವೆ.

Workspace skills ಹೆಚ್ಚು priority ಹೊಂದಿವೆ. Bundled ಅಥವಾ managed skill ಅದೇ ಹೆಸರಿನ
skill ರಚಿಸಿದರೆ, ನಿಮ್ಮ ಆವೃತ್ತಿ ಆದ್ಯತೆ ಪಡೆಯುತ್ತದೆ.

```
Priority:  Workspace  >  Managed  >  Bundled
```

::: tip ಈ priority order ನೀವು bundled ಅಥವಾ marketplace skill ಅನ್ನು ನಿಮ್ಮ ಸ್ವಂತ
ಆವೃತ್ತಿಯಿಂದ ಯಾವಾಗಲೂ override ಮಾಡಬಹುದು ಎಂದರ್ಥ. ನಿಮ್ಮ customizations updates ನಿಂದ
ಎಂದಿಗೂ overwritten ಆಗುವುದಿಲ್ಲ. :::

## Skill Discovery ಮತ್ತು Loading

Agent ಪ್ರಾರಂಭವಾದಾಗ ಅಥವಾ skills ಬದಲಾದಾಗ, Triggerfish skill discovery process
ಚಲಾಯಿಸುತ್ತದೆ:

1. **Scanner** -- Bundled, managed, ಮತ್ತು workspace directories ನಾದ್ಯಂತ ಎಲ್ಲ
   installed skills ಹುಡುಕುತ್ತದೆ
2. **Loader** -- SKILL.md frontmatter ಓದಿ metadata validate ಮಾಡುತ್ತದೆ
3. **Resolver** -- Priority order ಬಳಸಿ naming conflicts resolve ಮಾಡುತ್ತದೆ
4. **Registration** -- Skills ಅನ್ನು ಅವುಗಳ declared capabilities ಮತ್ತು ನಿರ್ಬಂಧಗಳ
   ಜೊತೆ agent ಗೆ ಲಭ್ಯ ಮಾಡುತ್ತದೆ

Frontmatter ನಲ್ಲಿ `triggers` ಇರುವ Skills ಸ್ವಯಂಚಾಲಿತವಾಗಿ scheduler ಗೆ ಸಂಪರ್ಕಿಸಲ್ಪಡುತ್ತವೆ.
`requires_tools` ಇರುವ Skills agent ನ ಲಭ್ಯ tools ವಿರುದ್ಧ ತಪಾಸಿಸಲ್ಪಡುತ್ತವೆ --
ಅಗತ್ಯ tool ಲಭ್ಯವಿಲ್ಲದಿದ್ದರೆ, skill flag ಮಾಡಲ್ಪಡುತ್ತದೆ ಆದರೆ blocked ಅಲ್ಲ.

## Agent Self-Authoring

ಮುಖ್ಯ ವ್ಯತ್ಯಾಸ: agent ತನ್ನ ಸ್ವಂತ skills ಬರೆಯಬಹುದು. ಏನು ಮಾಡಬೇಕೆಂದು ತಿಳಿಯದಿದ್ದರೆ,
agent [exec environment](./exec-environment) ಬಳಸಿ `SKILL.md` ಮತ್ತು supporting
code ರಚಿಸಿ, workspace skill ಆಗಿ package ಮಾಡಬಹುದು.

### Self-Authoring Flow

```
1. You:   "I need you to check my Notion for new tasks every morning"
2. Agent: ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/ ನಲ್ಲಿ skill ರಚಿಸುತ್ತದೆ
          metadata ಮತ್ತು ಸೂಚನೆಗಳ ಜೊತೆ SKILL.md ಬರೆಯುತ್ತದೆ
          Supporting code (notion-tasks.ts) ಬರೆಯುತ್ತದೆ
          Exec environment ನಲ್ಲಿ code test ಮಾಡುತ್ತದೆ
3. Agent: Skill ಅನ್ನು PENDING_APPROVAL ಎಂದು mark ಮಾಡುತ್ತದೆ
4. You:   Notification ಸ್ವೀಕರಿಸುತ್ತೀರಿ: "New skill created: notion-tasks. Review and approve?"
5. You:   Skill approve ಮಾಡುತ್ತೀರಿ
6. Agent: Skill ಅನ್ನು daily execution ಗಾಗಿ cron job ಗೆ ಸಂಪರ್ಕಿಸುತ್ತದೆ
```

::: warning SECURITY Agent-authored skills active ಆಗುವ ಮೊದಲು ಯಾವಾಗಲೂ owner
approval ಅಗತ್ಯ. Agent ತನ್ನ ಸ್ವಂತ skills self-approve ಮಾಡಲಾಗದು. ಇದು agent ನಿಮ್ಮ
oversight bypass ಮಾಡುವ capabilities ರಚಿಸುವುದನ್ನು ತಡೆಯುತ್ತದೆ. :::

### Enterprise ನಿಯಂತ್ರಣಗಳು

Enterprise deployments ನಲ್ಲಿ, self-authored skills ಗೆ ಹೆಚ್ಚುವರಿ ನಿಯಂತ್ರಣಗಳು
ಅನ್ವಯಿಸುತ್ತವೆ:

- Agent-authored skills ಯಾವಾಗಲೂ owner ಅಥವಾ admin approval ಅಗತ್ಯ
- Skills ಬಳಕೆದಾರನ clearance ಮೇಲಿನ classification ceiling declare ಮಾಡಲಾಗದು
- Network endpoint declarations audit ಮಾಡಲ್ಪಡುತ್ತವೆ
- ಎಲ್ಲ self-authored skills compliance ಪರಿಶೀಲನೆಗೆ log ಮಾಡಲ್ಪಡುತ್ತವೆ

## The Reef <ComingSoon :inline="true" />

The Reef ಎಂಬುದು Triggerfish ನ community skill marketplace -- ನೀವು skills
discover, install, publish, ಮತ್ತು share ಮಾಡಬಹುದಾದ registry.

| Feature             | Description                                              |
| ------------------- | -------------------------------------------------------- |
| Search ಮತ್ತು browse  | Category, tag, ಅಥವಾ popularity ಮೂಲಕ skills ಹುಡುಕಿ     |
| One-command install | `triggerfish skill install <name>`                       |
| Publish             | ನಿಮ್ಮ skills community ಜೊತೆ share ಮಾಡಿ                 |
| Security scanning   | Listing ಮೊದಲು malicious patterns ಗಾಗಿ automated scanning |
| Versioning          | Skills update management ಜೊತೆ versioned                 |
| Reviews ಮತ್ತು ratings | Skill quality ಮೇಲೆ community feedback                   |

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

### ಭದ್ರತೆ

The Reef ನಿಂದ install ಮಾಡಿದ Skills ಯಾವ ಇತರ integration ಅದೇ lifecycle ಮೂಲಕ ಹಾದು
ಹೋಗುತ್ತವೆ:

1. Managed skills directory ಗೆ download ಮಾಡಲ್ಪಡುತ್ತದೆ
2. Malicious patterns ಗಾಗಿ scan ಮಾಡಲ್ಪಡುತ್ತದೆ (code injection, unauthorized
   network access, ಇತ್ಯಾದಿ)
3. ನೀವು classify ಮಾಡುವ ತನಕ `UNTRUSTED` state ಗೆ ಪ್ರವೇಶಿಸುತ್ತವೆ
4. Owner ಅಥವಾ admin ನಿಂದ classified ಮತ್ತು activated

::: info The Reef ಎಲ್ಲ published skills ಅನ್ನು list ಮಾಡುವ ಮೊದಲು ತಿಳಿದ malicious
patterns ಗಾಗಿ scan ಮಾಡುತ್ತದೆ. ಆದಾಗ್ಯೂ, classify ಮಾಡುವ ಮೊದಲು skills review
ಮಾಡಬೇಕು, ವಿಶೇಷವಾಗಿ network access declare ಮಾಡುವ ಅಥವಾ `exec` ಅಥವಾ `browser`
ನಂತಹ ಪ್ರಬಲ tools ಅಗತ್ಯವಿರುವ skills. :::

## Skill Security ಸಾರಾಂಶ

- Skills ಅವುಗಳ security requirements upfront declare ಮಾಡುತ್ತವೆ (classification
  ceiling, tools, network domains)
- Tool access policy ನಿಂದ gated -- `requires_tools: [browser]` skill policy
  ನಿಂದ browser access blocked ಆಗಿದ್ದರೆ ಕೆಲಸ ಮಾಡುವುದಿಲ್ಲ
- Network domains ಜಾರಿಗೊಳಿಸಲ್ಪಡುತ್ತವೆ -- skill declare ಮಾಡದ endpoints ಪ್ರವೇಶಿಸಲಾಗದು
- Agent-authored skills ಸ್ಪಷ್ಟ owner/admin approval ಅಗತ್ಯ
- ಎಲ್ಲ skill invocations policy hooks ಮೂಲಕ ಹಾದು ಹೋಗಿ ಸಂಪೂರ್ಣ audit ಮಾಡಲ್ಪಡುತ್ತವೆ
