---
name: workflow-builder
description: Author CNCF Serverless Workflow YAML definitions for Triggerfish automation
classification_ceiling: RESTRICTED
requires_tools: [workflow_save, workflow_run, workflow_list, workflow_get, workflow_delete, workflow_history]
network_domains: []
tags: [automation, workflow, productivity]
---

# Workflow Builder

Teaches the agent to write, validate, save, and execute YAML workflows using the CNCF Serverless Workflow DSL 1.0 with Triggerfish extensions.

## When to Use This Skill

Use workflow_save + workflow_run when the user wants to:
- Automate a multi-step process that mixes HTTP calls, LLM reasoning, memory operations, and messaging
- Schedule recurring automation (combined with the scheduler)
- Chain tools in a repeatable, auditable sequence
- Create an automation that others can inspect, modify, and rerun

## Workflow Authoring Guidelines

### Structure

Every workflow must have:
- `document.dsl: "1.0.0"` — CNCF DSL version
- `document.name` — unique identifier (kebab-case)
- `document.do` — ordered list of tasks

### Task Types

**Deterministic (safe for automated scheduling):**
- `call: http` — HTTP request to any URL
- `call: triggerfish:memory` — CRUD on persistent memory (operation: save/search/get/list/delete)
- `call: triggerfish:web_search` — web search (query, maxResults)
- `call: triggerfish:web_fetch` — fetch and extract web content (url)
- `call: triggerfish:mcp` — call any MCP server tool (server, tool, arguments)
- `call: triggerfish:message` — send a message (channel, recipient, text)
- `call: triggerfish:tool` — **invoke any registered agent tool by name** (tool, arguments)
- `run: shell` — shell command (with.command)
- `set` — set workflow data variables
- `switch` — conditional branching
- `for` — loop over a collection

**Non-deterministic (requires approvalRequired: true):**
- `call: triggerfish:llm` — spawn a sub-agent to complete a task using natural language
- `call: triggerfish:agent` — delegate to a named agent

### Triggerfish Extensions (metadata.triggerfish)

```yaml
metadata:
  triggerfish:
    classification_ceiling: CONFIDENTIAL  # optional: halt if taint exceeds this
    requires_tools: [web_search, memory_save]  # declared tool dependencies
    network_domains: [api.example.com]  # declared outbound domains
    tags: [daily, briefing]
```

### Expression Syntax

Use `${ }` delimiters for runtime expressions:
- `.field` — current workflow data
- `$input.field` — original workflow input
- `$context.date` — current date (ISO 8601)
- `$context.session.taint` — current session classification
- `$secrets.my_api_key` — secret value (resolved securely, never logged)
- `${ .items | map(.name) | join(", ") }` — jq-compatible pipe chains

### Output Transforms

Each task can define `output.as` to store the result:
```yaml
output:
  as: .myVariable  # stores result in .myVariable for later steps
```

### Conditional Execution

Tasks can be skipped with `if`:
```yaml
- notifyIfSignificant:
    if: ${ .significance >= 4 }
    call: triggerfish:message
    with: ...
```

### Flow Control

Use `then` to control execution flow:
- `then: continue` — next task (default)
- `then: end` — complete workflow successfully
- `then: exit` — abort workflow
- `then: taskName` — jump to named task

### switch for Branching

```yaml
- routeByType:
    switch:
      - highPriority:
          when: ${ .priority == "high" }
          then: alertOwner
      - default:
          then: logToMemory
```

## Example: Daily Summary Workflow

```yaml
document:
  dsl: "1.0.0"
  namespace: personal
  name: daily-summary
  version: "1.0.0"
  metadata:
    triggerfish:
      requires_tools: [web_search, memory_search, memory_save]
      tags: [daily, productivity]
do:
  - getNews:
      call: triggerfish:web_search
      with:
        query: "AI technology news today"
        maxResults: 5
      output:
        as: .news

  - getPendingTasks:
      call: triggerfish:memory
      with:
        operation: search
        query: "todo task pending deadline"
      output:
        as: .tasks

  - composeSummary:
      call: triggerfish:llm
      with:
        task: |
          Compose a brief daily summary.
          Top news: ${ .news }
          Pending tasks from memory: ${ .tasks }
          Keep it under 200 words. Format as bullet points.
      output:
        as: .summary

  - saveSummary:
      call: triggerfish:memory
      with:
        operation: save
        key: "daily-summary:${ $context.date }"
        content: ${ .summary }
        tags: [daily, summary]

  - deliver:
      call: triggerfish:message
      with:
        channel: preferred
        recipient: owner
        text: ${ .summary }
```

## Using `call: triggerfish:tool`

`triggerfish:tool` exposes the full agent tool surface to workflows. Use it to invoke any tool registered in the agent's execution context — including file operations, browser automation, exec workspace tools, or any dynamically registered tool.

```yaml
- readWorkspaceFile:
    call: triggerfish:tool
    with:
      tool: file_read
      arguments:
        path: /workspace/output.txt
    output:
      as: .fileContent

- screenshotPage:
    call: triggerfish:tool
    with:
      tool: browser_screenshot
      arguments:
        selector: "#main"
    output:
      as: .screenshot
```

**`with.tool`** (required) — The exact tool name as registered in the agent context (e.g. `file_read`, `browser_navigate`, `code_exec`).

**`with.arguments`** (optional) — Arguments passed directly to the tool. Maps one-to-one to the tool's parameter schema.

Declare tool dependencies in `requires_tools` so validation runs before execution:
```yaml
metadata:
  triggerfish:
    requires_tools: [file_read, browser_navigate]
```

## Security Reminders

1. Workflows with `triggerfish:llm` have `approvalRequired: true` — review before scheduling
2. The `classification_ceiling` prevents workflows from touching data above the ceiling level
3. `$secrets.*` values are resolved securely and never stored in execution history
4. A workflow cannot escalate taint below the starting session taint level
5. `call: triggerfish:tool` dispatches through the same `ToolExecutor` as all other call types — PRE_TOOL_CALL and POST_TOOL_RESPONSE hooks fire automatically. Classification enforcement cannot be bypassed.
