# Skills Platform

Skills என்பது Triggerfish இன் primary extensibility mechanism. ஒரு skill என்பது ஒரு `SKILL.md` file கொண்ட folder -- plugin எழுதவோ custom code build செய்யவோ தேவையில்லாமல் agent க்கு புதிய திறன்கள் கொடுக்கும் instructions மற்றும் metadata.

Skills agent புதிய செயல்களை கற்றுக்கொள்ளும் விதம்: calendar சரிபார்க்கவும், morning briefings தயார் செய்யவும், GitHub issues triage செய்யவும், weekly summaries draft செய்யவும். அவை marketplace இலிருந்து install செய்யலாம், கையால் எழுதலாம், அல்லது agent தன்னே author செய்யலாம்.

## ஒரு Skill என்றால் என்ன?

ஒரு skill என்பது அதன் root இல் ஒரு `SKILL.md` file உடன் ஒரு folder. File க்கு YAML frontmatter (metadata) மற்றும் markdown body (agent க்கான instructions) உள்ளது. Optional supporting files -- scripts, templates, configuration -- அருகில் இருக்கலாம்.

```
morning-briefing/
  SKILL.md
  briefing.ts        # Optional supporting code
  template.md        # Optional template
```

`SKILL.md` frontmatter skill என்ன செய்கிறது, என்ன தேவை, மற்றும் எந்த பாதுகாப்பு constraints பொருந்தும் என்று declare செய்கிறது:

```yaml
---
name: morning-briefing
description: Calendar, email, மற்றும் weather உடன் daily morning briefing தயார் செய்யவும்
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

Triggered ஆகும்போது (daily 7 AM இல்) அல்லது பயனர் invoke செய்யும்போது:

1. Google Calendar இலிருந்து இன்றைய calendar events fetch செய்யவும்
2. கடந்த 12 மணிநேரத்தில் unread emails summarize செய்யவும்
3. பயனரின் location க்கான weather forecast பெறவும்
4. ஒரு concise briefing compile செய்து கட்டமைக்கப்பட்ட channel க்கு deliver செய்யவும்

Calendar, Email, மற்றும் Weather sections உடன் briefing format செய்யவும்.
Scannable ஆக வைக்கவும் -- bullet points, paragraphs அல்ல.
```

### Frontmatter Fields

| Field                                         | Required | விளக்கம்                                                      |
| --------------------------------------------- | :------: | --------------------------------------------------------------- |
| `name`                                        | ஆம்      | Unique skill identifier                                         |
| `description`                                 | ஆம்      | Skill என்ன செய்கிறது என்ற Human-readable description           |
| `version`                                     | ஆம்      | Semantic version                                                |
| `category`                                    | இல்லை   | Grouping category (productivity, development, communication, போன்றவை) |
| `tags`                                        | இல்லை   | Discovery க்கான Searchable tags                                |
| `triggers`                                    | இல்லை   | Automatic invocation rules (cron schedules, event patterns)    |
| `metadata.triggerfish.classification_ceiling` | இல்லை   | இந்த skill அடையக்கூடிய Maximum taint நிலை (default: `PUBLIC`) |
| `metadata.triggerfish.requires_tools`         | இல்லை   | Skill depend செய்யும் Tools (browser, exec, போன்றவை)           |
| `metadata.triggerfish.network_domains`        | இல்லை   | Skill க்கான Allowed network endpoints                          |

## Skill வகைகள்

Triggerfish மூன்று வகை skills support செய்கிறது, names conflict ஆகும்போது ஒரு clear priority order உடன்.

### Bundled Skills

`skills/bundled/` directory இல் Triggerfish உடன் ship ஆகின்றன. Project பராமரிக்கிறது. எப்போதும் available.

Triggerfish day one இலிருந்தே agent ஐ self-sufficient ஆக்கும் பத்து bundled skills சேர்க்கிறது:

| Skill                     | விளக்கம்                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **tdd**                   | Deno 2.x க்கான Test-Driven Development methodology. Red-green-refactor cycle, `Deno.test()` patterns, `@std/assert` usage, Result type testing. |
| **mastering-typescript**  | Deno மற்றும் Triggerfish க்கான TypeScript patterns. Strict mode, `Result<T, E>`, branded types, factory functions, immutable interfaces. |
| **skill-builder**         | புதிய skills author எவ்வாறு செய்வது. SKILL.md format, frontmatter fields, classification ceilings, self-authoring workflow. |
| **integration-builder**   | Triggerfish integrations எவ்வாறு build செய்வது. ஆறு patterns: channel adapters, LLM providers, MCP servers, storage providers, exec tools, plugins. |
| **git-branch-management** | Development க்கான Git branch workflow. Feature branches, atomic commits, `gh` CLI மூலம் PR creation, PR tracking, merge மற்றும் cleanup. |
| **deep-research**         | Multi-step research methodology. Source evaluation, parallel searches, synthesis, மற்றும் citation formatting. |
| **pdf**                   | PDF document processing. Text extraction, summarization, மற்றும் PDF files இலிருந்து structured data extraction. |
| **triggerfish**           | Triggerfish internals பற்றிய Self-knowledge. Architecture, configuration, troubleshooting, மற்றும் development patterns. |
| **triggers**              | Proactive behavior authoring. Effective TRIGGER.md files எழுதுவது, monitoring patterns, மற்றும் escalation rules. |

இவை bootstrap skills -- agent தன்னை extend செய்ய இவற்றை பயன்படுத்துகிறது. skill-builder agent புதிய skills எவ்வாறு create செய்வது என்று கற்பிக்கிறது, மற்றும் integration-builder புதிய adapters மற்றும் providers எவ்வாறு build செய்வது என்று கற்பிக்கிறது.

சொந்த skills உருவாக்குவதற்கான hands-on guide க்கு [Building Skills](/ta-IN/integrations/building-skills) பாருங்கள்.

### Managed Skills

**The Reef** (community skill marketplace) இலிருந்து Install ஆகின்றன. Download செய்யப்பட்டு `~/.triggerfish/skills/` இல் stored ஆகின்றன.

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### Workspace Skills

பயனர் உருவாக்கியவை அல்லது [exec environment](./exec-environment) இல் agent author செய்தவை. `~/.triggerfish/workspace/<agent-id>/skills/` இல் agent இன் workspace இல் stored ஆகின்றன.

Workspace skills highest priority பெறுகின்றன. Bundled அல்லது managed skill போல் அதே பெயரில் ஒரு skill உருவாக்கினால், உங்கள் version முன்னுரிமை பெறுகிறது.

```
Priority:  Workspace  >  Managed  >  Bundled
```

::: tip இந்த priority order உங்களுக்கு எப்போதும் ஒரு bundled அல்லது marketplace skill ஐ சொந்த version உடன் override செய்ய அனுமதிக்கிறது. உங்கள் customizations updates மூலம் overwritten ஆவதில்லை. :::

## Skill Discovery மற்றும் Loading

Agent தொடங்கும்போது அல்லது skills மாறும்போது, Triggerfish ஒரு skill discovery process இயக்குகிறது:

1. **Scanner** -- Bundled, managed, மற்றும் workspace directories முழுவதும் installed skills கண்டுபிடிக்கிறது
2. **Loader** -- SKILL.md frontmatter படிக்கிறது மற்றும் metadata validate செய்கிறது
3. **Resolver** -- Priority order பயன்படுத்தி naming conflicts resolve செய்கிறது
4. **Registration** -- Skills ஐ declared capabilities மற்றும் constraints உடன் agent க்கு available ஆக்குகிறது

Frontmatter இல் `triggers` உடன் skills தானாக scheduler க்கு wired ஆகின்றன. `requires_tools` உடன் Skills agent இன் available tools க்கு எதிராக checked -- required tool available இல்லையென்றால், skill flagged ஆகிறது ஆனால் blocked ஆவதில்லை.

## Agent Self-Authoring

ஒரு key differentiator: agent தன்னுடைய சொந்த skills எழுதலாம். எவ்வாறு செய்வது என்று தெரியாத ஒன்று செய்யுமாறு கேட்கப்படும்போது, agent ஒரு `SKILL.md` மற்றும் supporting code உருவாக்க [exec environment](./exec-environment) பயன்படுத்தலாம், பின்னர் அதை workspace skill ஆக package செய்யலாம்.

### Self-Authoring Flow

```
1. நீங்கள்: "ஒவ்வொரு காலையும் Notion ஐ புதிய tasks க்காக சரிபார்க்க வேண்டும்"
2. Agent: ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/ இல் skill உருவாக்குகிறது
           Metadata மற்றும் instructions உடன் SKILL.md எழுதுகிறது
           Supporting code (notion-tasks.ts) எழுதுகிறது
           Exec environment இல் code test செய்கிறது
3. Agent: Skill ஐ PENDING_APPROVAL என்று mark செய்கிறது
4. நீங்கள்: Notification பெறுகிறீர்கள்: "New skill created: notion-tasks. Review and approve?"
5. நீங்கள்: Skill approve செய்கிறீர்கள்
6. Agent: Daily execution க்கு cron job க்கு skill ஐ wire செய்கிறது
```

::: warning SECURITY Agent-authored skills active ஆவதற்கு முன்பு எப்போதும் owner approval தேவை. Agent தன்னுடைய skills ஐ self-approve செய்ய முடியாது. இது agent உங்கள் oversight bypass செய்யும் capabilities உருவாக்குவதை தடுக்கிறது. :::

### Enterprise Controls

Enterprise deployments இல், self-authored skills க்கு கூடுதல் controls பொருந்துகின்றன:

- Agent-authored skills எப்போதும் owner அல்லது admin approval தேவை
- Skills பயனரின் clearance க்கு மேல் ஒரு classification ceiling declare செய்ய முடியாது
- Network endpoint declarations audited ஆகின்றன
- அனைத்து self-authored skills உம் compliance review க்கு log ஆகின்றன

## The Reef <ComingSoon :inline="true" />

The Reef என்பது Triggerfish இன் community skill marketplace -- skills discover, install, publish, மற்றும் share செய்யக்கூடிய ஒரு registry.

| Feature             | விளக்கம்                                                    |
| ------------------- | ------------------------------------------------------------- |
| Search and browse   | Category, tag, அல்லது popularity மூலம் skills கண்டுபிடிக்கவும் |
| One-command install | `triggerfish skill install <name>`                            |
| Publish             | Community உடன் skills share செய்யவும்                        |
| Security scanning   | Listing க்கு முன்பு malicious patterns க்கான Automated scanning |
| Versioning          | Skills update management உடன் versioned                      |
| Reviews and ratings | Skill quality பற்றிய Community feedback                      |

### CLI Commands

```bash
# Skills தேடவும்
triggerfish skill search "calendar"

# The Reef இலிருந்து ஒரு skill install செய்யவும்
triggerfish skill install google-cal

# Installed skills பட்டியலிடவும்
triggerfish skill list

# அனைத்து managed skills update செய்யவும்
triggerfish skill update --all

# The Reef க்கு ஒரு skill publish செய்யவும்
triggerfish skill publish

# ஒரு skill நீக்கவும்
triggerfish skill remove google-cal
```

### பாதுகாப்பு

The Reef இலிருந்து install ஆகும் Skills மற்ற எந்த integration போலவும் அதே lifecycle மூலம் செல்கின்றன:

1. Managed skills directory க்கு Download செய்யப்படுகின்றன
2. Malicious patterns க்காக scanned ஆகின்றன (code injection, unauthorized network access, போன்றவை)
3. நீங்கள் அவற்றை classify செய்யும் வரை `UNTRUSTED` நிலைக்கு enter செய்கின்றன
4. Owner அல்லது admin மூலம் Classified மற்றும் activated

::: info The Reef அனைத்து published skills ஐயும் listing க்கு முன்பு known malicious patterns க்காக scan செய்கிறது. ஆனால், குறிப்பாக `exec` அல்லது `browser` போன்ற powerful tools தேவைப்படும் அல்லது network access declare செய்யும் skills ஐ classify செய்வதற்கு முன்பு நீங்கள் இன்னும் review செய்ய வேண்டும். :::

## Skill பாதுகாப்பு சுருக்கம்

- Skills தங்கள் பாதுகாப்பு requirements முன்கூட்டியே declare செய்கின்றன (classification ceiling, tools, network domains)
- Tool access policy மூலம் gated -- `requires_tools: [browser]` declare செய்யும் ஒரு skill browser access policy மூலம் blocked ஆனால் வேலை செய்யாது
- Network domains enforced -- ஒரு skill declare செய்யாத endpoints அணுக முடியாது
- Agent-authored skills explicit owner/admin approval தேவை
- அனைத்து skill invocations உம் policy hooks மூலம் செல்கின்றன மற்றும் முழுமையாக audited
