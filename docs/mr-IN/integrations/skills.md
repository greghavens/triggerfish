# Skills Platform

Skills हे Triggerfish चे primary extensibility mechanism आहे. Skill हे एक folder
आहे ज्यात `SKILL.md` file आहे -- instructions आणि metadata जे तुम्हाला plugin
लिहिण्याची किंवा custom code build करण्याची आवश्यकता नसताना एजंटला नवीन
capabilities देतात.

Skills हे आहे ज्याद्वारे एजंट नवीन गोष्टी करायला शिकतो: तुमचे calendar
check करणे, morning briefings prepare करणे, GitHub issues triage करणे, weekly
summaries draft करणे. त्या marketplace मधून install केल्या जाऊ शकतात, हाताने
लिहिल्या जाऊ शकतात, किंवा एजंटद्वारे स्वतः authored केल्या जाऊ शकतात.

## Skill म्हणजे काय?

Skill हे root वर `SKILL.md` file असलेले directory आहे. File मध्ये YAML
frontmatter (metadata) आणि markdown body (एजंटसाठी instructions) आहे. Optional
supporting files -- scripts, templates, configuration -- त्यासोबत राहू शकतात.

```
morning-briefing/
  SKILL.md
  briefing.ts        # Optional supporting code
  template.md        # Optional template
```

`SKILL.md` frontmatter skill काय करते, त्याला काय लागते, आणि कोणते security
constraints लागू होतात ते declare करतो:

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

Triggered (daily at 7 AM) किंवा user invoked असताना:

1. Google Calendar वरून आजचे calendar events fetch करा
2. Last 12 hours मधील unread emails summarize करा
3. User च्या location साठी weather forecast मिळवा
4. Concise briefing compile करा आणि configured channel ला deliver करा

Calendar, Email, आणि Weather साठी sections सह briefing format करा.
Scannable ठेवा -- bullet points, paragraphs नाही.
```

### Frontmatter Fields

| Field                                         | Required | वर्णन                                                                 |
| --------------------------------------------- | :------: | --------------------------------------------------------------------- |
| `name`                                        |   हो     | Unique skill identifier                                               |
| `description`                                 |   हो     | Skill काय करते याचे human-readable description                        |
| `version`                                     |   हो     | Semantic version                                                      |
| `category`                                    |   नाही   | Grouping category (productivity, development, communication, इ.)      |
| `tags`                                        |   नाही   | Discovery साठी searchable tags                                        |
| `triggers`                                    |   नाही   | Automatic invocation rules (cron schedules, event patterns)           |
| `metadata.triggerfish.classification_ceiling` |   नाही   | हा skill reach करू शकणारा maximum taint level (default: `PUBLIC`)    |
| `metadata.triggerfish.requires_tools`         |   नाही   | Skill depend करत असलेले tools (browser, exec, इ.)                    |
| `metadata.triggerfish.network_domains`        |   नाही   | Skill साठी allowed network endpoints                                  |

## Skill Types

Triggerfish तीन types चे skills support करतो, names conflict असताना clear
priority order सह.

### Bundled Skills

`skills/bundled/` directory मध्ये Triggerfish सह ship होतात. Project द्वारे
maintained. नेहमी available.

Triggerfish दहा bundled skills समाविष्ट करतो ज्या एजंटला day one पासून
self-sufficient बनवतात:

| Skill                     | वर्णन                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **tdd**                   | Deno 2.x साठी Test-Driven Development methodology. Red-green-refactor cycle, `Deno.test()` patterns, `@std/assert` usage, Result type testing, test helpers.       |
| **mastering-typescript**  | Deno आणि Triggerfish साठी TypeScript patterns. Strict mode, `Result<T, E>`, branded types, factory functions, immutable interfaces, `mod.ts` barrels.              |
| **skill-builder**         | नवीन skills कसे author करायचे. SKILL.md format, frontmatter fields, classification ceilings, self-authoring workflow, security scanning.                          |
| **integration-builder**   | Triggerfish integrations कसे build करायचे. सर्व सहा patterns: channel adapters, LLM providers, MCP servers, storage providers, exec tools, आणि plugins.           |
| **git-branch-management** | Development साठी Git branch workflow. Feature branches, atomic commits, `gh` CLI द्वारे PR creation, PR tracking, webhooks द्वारे review feedback loop, merge आणि cleanup. |
| **deep-research**         | Multi-step research methodology. Source evaluation, parallel searches, synthesis, आणि citation formatting.                                                         |
| **pdf**                   | PDF document processing. Text extraction, summarization, आणि PDF files मधून structured data extraction.                                                            |
| **triggerfish**            | Triggerfish internals बद्दल self-knowledge. Architecture, configuration, troubleshooting, आणि development patterns.                                               |
| **triggers**              | Proactive behavior authoring. Effective TRIGGER.md files लिहिणे, monitoring patterns, आणि escalation rules.                                                       |

हे bootstrap skills आहेत -- एजंट स्वतः extend करण्यासाठी त्यांचा वापर करतो.
Skill-builder एजंटला नवीन skills कसे create करायचे ते शिकवतो, आणि
integration-builder त्याला नवीन adapters आणि providers कसे build करायचे ते
शिकवतो.

स्वतःचे create करण्यासाठी hands-on guide साठी [Building Skills](/mr-IN/integrations/building-skills)
पहा.

### Managed Skills

**The Reef** (community skill marketplace) मधून Install केल्या जातात.
`~/.triggerfish/skills/` मध्ये downloaded आणि stored.

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### Workspace Skills

User द्वारे created किंवा [exec environment](./exec-environment) मध्ये एजंटद्वारे
authored. एजंटच्या workspace मध्ये `~/.triggerfish/workspace/<agent-id>/skills/`
येथे stored.

Workspace skills highest priority घेतात. Bundled किंवा managed skill प्रमाणेच
name सह skill create केल्यास, तुमची version precedence घेते.

```
Priority:  Workspace  >  Managed  >  Bundled
```

::: tip हा priority order म्हणजे तुम्ही नेहमी bundled किंवा marketplace skill
तुमच्या स्वतःच्या version ने override करू शकता. Updates द्वारे तुमचे
customizations कधीही overwritten होत नाहीत. :::

## Skill Discovery आणि Loading

एजंट start होतो किंवा skills बदलतात तेव्हा, Triggerfish skill discovery process
run करतो:

1. **Scanner** -- Bundled, managed, आणि workspace directories मध्ये सर्व
   installed skills शोधतो
2. **Loader** -- SKILL.md frontmatter वाचतो आणि metadata validate करतो
3. **Resolver** -- Priority order वापरून naming conflicts resolve करतो
4. **Registration** -- त्यांच्या declared capabilities आणि constraints सह skills
   एजंटला available बनवतो

Frontmatter मध्ये `triggers` असलेल्या Skills आपोआप scheduler मध्ये wired
होतात. `requires_tools` असलेल्या Skills एजंटच्या available tools विरुद्ध checked
होतात -- required tool available नसल्यास, skill flagged होते पण blocked नाही.

## Agent Self-Authoring

एक key differentiator: एजंट स्वतःच्या skills लिहू शकतो. त्याला माहित नसलेले
काहीतरी करण्यास सांगतो तेव्हा, एजंट `SKILL.md` आणि supporting code create
करण्यासाठी [exec environment](./exec-environment) वापरू शकतो, नंतर workspace
skill म्हणून package करू शकतो.

### Self-Authoring Flow

```
1. तुम्ही:   "I need you to check my Notion for new tasks every morning"
2. Agent: ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/ येथे skill create करतो
          Metadata आणि instructions सह SKILL.md लिहितो
          Supporting code (notion-tasks.ts) लिहितो
          Exec environment मध्ये code test करतो
3. Agent: Skill PENDING_APPROVAL म्हणून mark करतो
4. तुम्ही:   Notification receive करता: "New skill created: notion-tasks. Review and approve?"
5. तुम्ही:   Skill approve करता
6. Agent: Daily execution साठी cron job मध्ये skill wire करतो
```

::: warning SECURITY Agent-authored skills active होण्यापूर्वी नेहमी owner
approval आवश्यक आहे. एजंट स्वतःच्या skills self-approve करू शकत नाही. हे
एजंटला तुमचा oversight bypass करणाऱ्या capabilities create करण्यापासून रोखते. :::

### Enterprise Controls

Enterprise deployments मध्ये, self-authored skills ला additional controls लागू
होतात:

- Agent-authored skills नेहमी owner किंवा admin approval आवश्यक करतात
- Skills user च्या clearance च्या वर classification ceiling declare करू शकत नाहीत
- Network endpoint declarations audited आहेत
- सर्व self-authored skills compliance review साठी logged आहेत

## The Reef <ComingSoon :inline="true" />

The Reef हे Triggerfish चे community skill marketplace आहे -- एक registry जिथे
तुम्ही skills discover, install, publish, आणि share करू शकता.

| Feature             | वर्णन                                                       |
| ------------------- | ----------------------------------------------------------- |
| Search आणि browse   | Category, tag, किंवा popularity नुसार skills शोधा           |
| One-command install | `triggerfish skill install <name>`                          |
| Publish             | Community शी तुमच्या skills share करा                      |
| Security scanning   | Listing पूर्वी malicious patterns साठी automated scanning   |
| Versioning          | Skills update management सह versioned आहेत                  |
| Reviews आणि ratings | Skill quality वर community feedback                         |

### CLI Commands

```bash
# Skills शोधा
triggerfish skill search "calendar"

# The Reef मधून skill install करा
triggerfish skill install google-cal

# Installed skills list करा
triggerfish skill list

# सर्व managed skills update करा
triggerfish skill update --all

# The Reef ला skill publish करा
triggerfish skill publish

# Skill remove करा
triggerfish skill remove google-cal
```

### Security

The Reef मधून install केल्या जाणाऱ्या Skills इतर कोणत्याही integration प्रमाणेच
lifecycle मधून जातात:

1. Managed skills directory ला downloaded
2. Malicious patterns साठी scanned (code injection, unauthorized network access, इ.)
3. Owner द्वारे classify होईपर्यंत `UNTRUSTED` state मध्ये enter होतात
4. Owner किंवा admin द्वारे classified आणि activated

::: info The Reef listed होण्यापूर्वी published सर्व skills known malicious
patterns साठी scan करतो. तथापि, तुम्ही अजूनही skills classify करण्यापूर्वी
review करावे, विशेषतः network access declare करणाऱ्या किंवा `exec` किंवा `browser`
सारखे powerful tools आवश्यक करणाऱ्या skills. :::

## Skill Security Summary

- Skills त्यांच्या security requirements upfront declare करतात (classification
  ceiling, tools, network domains)
- Tool access policy द्वारे gated आहे -- `requires_tools: [browser]` असलेली
  skill policy द्वारे browser access blocked असल्यास काम करणार नाही
- Network domains enforced आहेत -- skill declared नसलेल्या endpoints access करू
  शकत नाही
- Agent-authored skills ला explicit owner/admin approval आवश्यक आहे
- सर्व skill invocations policy hooks मधून जातात आणि fully audited आहेत
