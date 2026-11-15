# Agent Delegation

Agent operations use managed sessions, classification checks, and
policy-enforced tools. The runtime supplies the caller's identity and
classification for access checks.

## Session Access

Session tools filter session metadata by classification. A session can inspect
metadata only when the target session's taint can flow to the caller's
classification level.

## Inter-Session Classification Checks

For a session-to-session send, Triggerfish looks up both sessions and compares
their current taint levels. The destination classification comes from the target
session's stored state. Tool arguments cannot supply a lower destination
classification to bypass the check.

The no-write-down rule requires the source taint to be at or below the target
taint. For example:

| Source taint | Target taint | Result                              |
| ------------ | ------------ | ----------------------------------- |
| PUBLIC       | INTERNAL     | Allowed by the classification check |
| CONFIDENTIAL | CONFIDENTIAL | Allowed by the classification check |
| CONFIDENTIAL | PUBLIC       | Blocked                             |

## Channel Output

Channel sends compare the caller's live session taint with the destination
channel's classification. A session that accesses CONFIDENTIAL data cannot send
that data to a PUBLIC channel. These checks run in code before the channel send.

Managed tool calls also pass through the normal policy hooks for tool access,
response classification, and output.

## Related Pages

- [Policy Engine](/architecture/policy-engine) — enforcement hooks
- [No Write-Down Rule](./no-write-down) — classification flow checks
- [Identity & Auth](./identity) — channel identity
- [Audit & Compliance](./audit-logging) — policy decision records
