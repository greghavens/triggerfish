# Skills Platform

Skills Triggerfish کا بنیادی extensibility mechanism ہے۔ ایک skill ایک `SKILL.md` فائل
پر مشتمل folder ہے — ہدایات اور metadata جو ایجنٹ کو plugin لکھنے یا custom code build
کیے بغیر نئی capabilities دیتے ہیں۔

Skills سے ایجنٹ نئی چیزیں کرنا سیکھتا ہے: آپ کا calendar چیک کریں، صبح کی briefings
تیار کریں، GitHub issues triage کریں، weekly summaries draft کریں۔ انہیں marketplace
سے install کیا جا سکتا ہے، ہاتھ سے لکھا جا سکتا ہے، یا خود ایجنٹ author کر سکتا ہے۔

## Skill کیا ہے؟

Skill ایک folder ہے جس کی root میں `SKILL.md` فائل ہے۔ فائل میں YAML frontmatter
(metadata) اور markdown body (ایجنٹ کے لیے ہدایات) ہوتی ہے۔ اختیاری supporting files
— scripts، templates، configuration — اس کے ساتھ رہ سکتی ہیں۔

```
morning-briefing/
  SKILL.md
  briefing.ts        # اختیاری supporting code
  template.md        # اختیاری template
```

`SKILL.md` frontmatter declare کرتا ہے کہ skill کیا کرتی ہے، اسے کیا چاہیے، اور کون
سی سیکیورٹی constraints لاگو ہیں:

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

| Field                                         | ضروری | تفصیل                                                                    |
| --------------------------------------------- | :---: | ------------------------------------------------------------------------ |
| `name`                                        |  ہاں  | منفرد skill identifier                                                    |
| `description`                                 |  ہاں  | Skill کیا کرتی ہے اس کی human-readable description                        |
| `version`                                     |  ہاں  | Semantic version                                                         |
| `category`                                    |  نہیں | Grouping category (productivity، development، communication، وغیرہ)      |
| `tags`                                        |  نہیں | Discovery کے لیے searchable tags                                          |
| `triggers`                                    |  نہیں | Automatic invocation rules (cron schedules، event patterns)              |
| `metadata.triggerfish.classification_ceiling` |  نہیں | زیادہ سے زیادہ taint level جو skill پہنچ سکتی ہے (ڈیفالٹ: `PUBLIC`)      |
| `metadata.triggerfish.requires_tools`         |  نہیں | Tools جن پر skill انحصار کرتی ہے (browser، exec، وغیرہ)                 |
| `metadata.triggerfish.network_domains`        |  نہیں | Skill کے لیے allowed network endpoints                                   |

## Skill کی اقسام

Triggerfish تین قسم کی skills support کرتا ہے، ناموں کے conflict میں واضح priority
order کے ساتھ۔

### Bundled Skills

Triggerfish کے ساتھ `skills/bundled/` directory میں ship ہوتی ہیں۔ Project کی طرف سے
maintained۔ ہمیشہ دستیاب۔

Triggerfish دس bundled skills شامل کرتا ہے جو ایجنٹ کو پہلے دن سے self-sufficient
بناتی ہیں:

| Skill                     | تفصیل                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **tdd**                   | Deno 2.x کے لیے Test-Driven Development methodology۔ Red-green-refactor cycle، `Deno.test()` patterns۔                          |
| **mastering-typescript**  | Deno اور Triggerfish کے لیے TypeScript patterns۔ Strict mode، `Result<T, E>`، branded types۔                                    |
| **skill-builder**         | نئی skills کیسے author کریں۔ SKILL.md format، frontmatter fields، classification ceilings۔                                      |
| **integration-builder**   | Triggerfish integrations کیسے build کریں۔ تمام چھ patterns: channel adapters، LLM providers، MCP servers، وغیرہ۔               |
| **git-branch-management** | Development کے لیے Git branch workflow۔ Feature branches، atomic commits، PR creation۔                                          |
| **deep-research**         | Multi-step research methodology۔ Source evaluation، parallel searches، synthesis، citation formatting۔                           |
| **pdf**                   | PDF document processing۔ Text extraction، summarization، اور PDF files سے structured data extraction۔                           |
| **triggerfish**           | Triggerfish internals کے بارے میں self-knowledge۔ Architecture، configuration، troubleshooting۔                                  |
| **triggers**              | Proactive behavior authoring۔ Effective TRIGGER.md files لکھنا، monitoring patterns، escalation rules۔                          |

یہ bootstrap skills ہیں — ایجنٹ انہیں خود کو extend کرنے کے لیے استعمال کرتا ہے۔

اپنی خود کی بنانے کے لیے hands-on guide کے لیے [Building Skills](/ur-PK/integrations/building-skills)
دیکھیں۔

### Managed Skills

**The Reef** (community skill marketplace) سے install کی جاتی ہیں۔ Download ہو کر
`~/.triggerfish/skills/` میں محفوظ ہوتی ہیں۔

```bash
triggerfish skill install google-cal
triggerfish skill install github-triage
```

### Workspace Skills

User کی طرف سے بنائی یا [exec environment](./exec-environment) میں ایجنٹ کی authored۔
ایجنٹ کی workspace میں `~/.triggerfish/workspace/<agent-id>/skills/` پر محفوظ۔

Workspace skills سب سے اونچی priority لیتی ہیں۔ اگر آپ کوئی skill بنائیں جس کا نام
bundled یا managed skill سے match کرے، آپ کا version precedence لیتا ہے۔

```
Priority:  Workspace  >  Managed  >  Bundled
```

::: tip یہ priority order مطلب ہے آپ ہمیشہ bundled یا marketplace skill کو اپنے version
سے override کر سکتے ہیں۔ آپ کی customizations updates سے کبھی overwrite نہیں ہوتیں۔ :::

## Skill Discovery اور Loading

جب ایجنٹ شروع ہوتا ہے یا skills تبدیل ہوتی ہیں، Triggerfish ایک skill discovery
process چلاتا ہے:

1. **Scanner** — bundled، managed، اور workspace directories میں تمام installed skills
   تلاش کرتا ہے
2. **Loader** — SKILL.md frontmatter پڑھتا اور metadata validate کرتا ہے
3. **Resolver** — priority order استعمال کر کے naming conflicts resolve کرتا ہے
4. **Registration** — skills کو declared capabilities اور constraints کے ساتھ ایجنٹ
   کے لیے دستیاب کرتا ہے

اپنے frontmatter میں `triggers` والی skills خود بخود scheduler میں wire ہو جاتی ہیں۔
`requires_tools` والی skills ایجنٹ کے available tools کے خلاف چیک ہوتی ہیں۔

## Agent Self-Authoring

ایک اہم differentiator: ایجنٹ اپنی skills خود لکھ سکتا ہے۔ جب کوئی ایسی چیز کرنے
کو کہا جائے جو وہ نہیں جانتا کیسے کرے، ایجنٹ [exec environment](./exec-environment)
استعمال کر کے `SKILL.md` اور supporting code بنا سکتا ہے، پھر اسے workspace skill کے
طور پر package کر سکتا ہے۔

### Self-Authoring Flow

```
1. آپ:    "مجھے ہر صبح Notion کو نئے tasks کے لیے چیک کرنا ہے"
2. Agent: ~/.triggerfish/workspace/<agent-id>/skills/notion-tasks/ میں skill بناتا ہے
          SKILL.md metadata اور ہدایات کے ساتھ لکھتا ہے
          Supporting code لکھتا ہے (notion-tasks.ts)
          Exec environment میں code test کرتا ہے
3. Agent: Skill PENDING_APPROVAL mark کرتا ہے
4. آپ:   Notification receive کرتے ہیں: "New skill created: notion-tasks. Review and approve?"
5. آپ:   Skill approve کرتے ہیں
6. Agent: Skill کو daily execution کے لیے cron job میں wire کرتا ہے
```

::: warning سیکیورٹی Agent-authored skills ہمیشہ active ہونے سے پہلے owner approval
ضروری ہے۔ ایجنٹ اپنی skills خود approve نہیں کر سکتا۔ یہ ایجنٹ کو ایسی capabilities
بنانے سے روکتا ہے جو آپ کی نگرانی کو bypass کریں۔ :::

## The Reef <ComingSoon :inline="true" />

The Reef Triggerfish کا community skill marketplace ہے — ایک registry جہاں آپ skills
دریافت، install، publish، اور share کر سکتے ہیں۔

### CLI Commands

```bash
# Skills تلاش کریں
triggerfish skill search "calendar"

# The Reef سے skill install کریں
triggerfish skill install google-cal

# Installed skills list کریں
triggerfish skill list

# تمام managed skills اپ ڈیٹ کریں
triggerfish skill update --all

# The Reef پر skill publish کریں
triggerfish skill publish

# Skill ہٹائیں
triggerfish skill remove google-cal
```

## Skill Security خلاصہ

- Skills اپنی سیکیورٹی requirements پیشگی declare کرتی ہیں (classification ceiling،
  tools، network domains)
- Tool access policy کے ذریعے gated ہے
- Network domains نافذ ہیں — skill وہ endpoints access نہیں کر سکتی جو اس نے declare
  نہیں کیے
- Agent-authored skills کے لیے explicit owner/admin approval ضروری ہے
- تمام skill invocations policy hooks سے گزرتی ہیں اور مکمل audited ہیں
