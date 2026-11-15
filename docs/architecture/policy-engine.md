# Policy Engine & Hooks

The policy engine is the enforcement layer that sits between the LLM and the
outside world. It intercepts every action at critical points in the data flow
and makes deterministic ALLOW, BLOCK, or REDACT decisions. The LLM cannot
bypass, modify, or influence these decisions.

## Core Principle: Enforcement Below the LLM

<img src="/diagrams/policy-enforcement-layers.svg" alt="Policy enforcement layers: LLM sits above the policy layer, which sits above the execution layer" style="max-width: 100%;" />

::: warning SECURITY The LLM sits above the policy layer. It can be
prompt-injected, jailbroken, or manipulated -- and it does not matter. The
policy layer is pure code that runs below the LLM, examining structured action
requests and making binary decisions based on classification rules. There is no
pathway from LLM output to hook bypass. :::

## Hook Types

Five active hooks cover context, tool calls and responses, output, and MCP
gateway calls. The `HookType` interface also includes the reserved value
`SESSION_RESET`.

### Hook Architecture

<img src="/diagrams/hook-chain-flow.svg" alt="Hook chain flow: PRE_CONTEXT_INJECTION → LLM Context → PRE_TOOL_CALL → Tool Execution → POST_TOOL_RESPONSE → LLM Response → PRE_OUTPUT → Output Channel" style="max-width: 100%;" />

### All Hook Types

| Hook                    | Trigger                        | Key Actions                                                      | Failure Mode    |
| ----------------------- | ------------------------------ | ---------------------------------------------------------------- | --------------- |
| `PRE_CONTEXT_INJECTION` | External input enters context  | Classify input, assign taint, create lineage, scan for injection | Reject input    |
| `PRE_TOOL_CALL`         | LLM requests tool execution    | Permission check, rate limit, parameter validation               | Block tool call |
| `POST_TOOL_RESPONSE`    | Tool returns data              | Classify response, update session taint, create/update lineage   | Redact or block |
| `PRE_OUTPUT`            | Response about to leave system | Final classification check against target, PII scan              | Block output    |
| `MCP_TOOL_CALL`         | MCP server tool invoked        | Gateway policy check (server status, tool permissions, schema)   | Block MCP call  |

## Hook Interface

Every hook receives a context and returns a result. The handler is a
synchronous, pure function.

```typescript
interface HookContext {
  readonly sessionId: SessionId;
  readonly hookType: HookType;
  readonly timestamp: Date;
  // Hook-specific payload varies by type
}

interface HookResult {
  readonly decision: "ALLOW" | "BLOCK" | "REDACT";
  readonly reason: string;
  readonly metadata?: Record<string, unknown>;
}

type HookHandler = (context: HookContext) => HookResult;
```

::: info `HookHandler` is synchronous and returns `HookResult` directly -- not a
Promise. This is by design. Hooks must complete before the action proceeds, and
making them synchronous eliminates any possibility of async bypass. If a hook
times out, the action is rejected. :::

## Hook Guarantees

Every hook execution carries four invariants:

| Guarantee         | What it means                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Deterministic** | Same input always produces the same decision. No randomness. No LLM calls within hooks. No external API calls that affect decisions. |
| **Synchronous**   | Hooks complete before the action proceeds. No async bypass is possible. Timeout equals rejection.                                    |
| **Logged**        | Every hook execution is recorded: input parameters, decision made, timestamp, and policy rules evaluated.                            |
| **Unforgeable**   | LLM output cannot contain hook bypass instructions. The hook layer has no "parse LLM output for commands" logic.                     |

## Policy Rules Hierarchy

Policy rules are organized into three tiers. Higher tiers cannot override lower
tiers.

### Fixed Rules (always enforced, NOT configurable)

These rules are hardcoded and cannot be disabled by any admin, user, or
configuration:

- **No write-down**: Classification flow is one-directional. Data cannot flow to
  a lower level.
- **UNTRUSTED channels**: No data in or out. Period.
- **Session taint**: Once elevated, stays elevated for the session lifetime.
- **Audit logging**: All actions logged. No exceptions. No way to disable.

### Configurable Rules (admin-tunable)

Administrators can adjust these through the UI or configuration files:

- Integration default classifications (e.g., Salesforce defaults to
  `CONFIDENTIAL`)
- Channel classifications
- Action allow/deny lists per integration
- Domain allowlists for external communications
- Rate limits per tool, per user, or per session

### Declarative Escape Hatch (enterprise)

Enterprise deployments can define custom policy rules in structured YAML for
advanced scenarios:

```yaml
# Block any Salesforce query containing SSN patterns
hook: POST_TOOL_RESPONSE
conditions:
  - tool_name: salesforce.*
  - content_matches: '\b\d{3}-\d{2}-\d{4}\b'
action: REDACT
redaction_pattern: "[SSN REDACTED]"
log_level: ALERT
notify: security-team@company.com
```

```yaml
# Require approval for high-value transactions
hook: PRE_TOOL_CALL
conditions:
  - tool_name: stripe.create_charge
  - parameter.amount: ">10000"
action: REQUIRE_APPROVAL
approvers:
  - role: finance-admin
timeout: 1h
timeout_action: DENY
```

```yaml
# Time-based restriction: no external sends after hours
hook: PRE_OUTPUT
conditions:
  - recipient_type: EXTERNAL
  - time_of_day: "18:00-08:00"
  - day_of_week: "Mon-Fri"
action: BLOCK
reason: "External communications restricted outside business hours"
```

::: tip Custom YAML rules must pass validation before activation. Invalid rules
are rejected at configuration time, not at runtime. This prevents
misconfiguration from creating security gaps. :::

## Denial User Experience

When the policy engine blocks an action, the user sees a clear explanation --
not a generic error.

**Default (specific):**

```
I can't send confidential data to a public channel.

  -> Reset session and send message
  -> Cancel
```

**Opt-in (educational):**

```
I can't send confidential data to a public channel.

Why: This session accessed Salesforce (CONFIDENTIAL).
WhatsApp personal is classified as PUBLIC.
Data can only flow to equal or higher classification.

Options:
  -> Reset session and send message
  -> Ask your admin to reclassify the WhatsApp channel
  -> Learn more: [docs link]
```

The educational mode is opt-in and helps users understand _why_ an action was
blocked, including which data source caused the taint escalation and what the
classification mismatch is. Both modes offer actionable next steps rather than
dead-end errors.

## How Hooks Chain Together

In a typical request/response cycle, multiple hooks fire in sequence. Each hook
has full visibility into the decisions made by earlier hooks in the chain.

```
User sends: "Check my Salesforce pipeline and message my wife"

1. PRE_CONTEXT_INJECTION
   - Input from owner, classified as PUBLIC
   - Session taint: PUBLIC

2. PRE_TOOL_CALL (salesforce.query_opportunities)
   - Tool permitted? YES
   - User has Salesforce connection? YES
   - Rate limit? OK
   - Decision: ALLOW

3. POST_TOOL_RESPONSE (salesforce results)
   - Data classified: CONFIDENTIAL
   - Session taint escalates: PUBLIC -> CONFIDENTIAL
   - Lineage record created

4. PRE_TOOL_CALL (whatsapp.send_message)
   - Tool permitted? YES
   - Decision: ALLOW (tool-level check passes)

5. PRE_OUTPUT (message to wife via WhatsApp)
   - Session taint: CONFIDENTIAL
   - Target effective classification: PUBLIC (external recipient)
   - CONFIDENTIAL -> PUBLIC: BLOCKED
   - Decision: BLOCK
   - Reason: "classification_violation"

6. Agent presents reset option to user
```
