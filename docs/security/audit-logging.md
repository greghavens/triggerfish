# Audit & Compliance

Every policy decision in Triggerfish is logged with full context. There are no
exceptions, no "debug mode" that disables logging, and no way for the LLM to
suppress audit records. This provides a complete, tamper-evident record of every
security decision the system has made.

## What Gets Recorded

Audit logging is a **fixed rule** -- it is always active and cannot be disabled.
Every enforcement hook execution produces an audit record containing:

| Field             | Description                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `timestamp`       | When the decision was made (ISO 8601, UTC)                                                                                 |
| `hook_type`       | Which enforcement hook ran (`PRE_CONTEXT_INJECTION`, `PRE_TOOL_CALL`, `POST_TOOL_RESPONSE`, `PRE_OUTPUT`, `MCP_TOOL_CALL`) |
| `session_id`      | The session in which the action occurred                                                                                   |
| `decision`        | `ALLOW`, `BLOCK`, or `REDACT`                                                                                              |
| `reason`          | Human-readable explanation of the decision                                                                                 |
| `input`           | The data or action that triggered the hook                                                                                 |
| `rules_evaluated` | Which policy rules were checked to reach the decision                                                                      |
| `taint_before`    | Session taint level before the action                                                                                      |
| `taint_after`     | Session taint level after the action (if changed)                                                                          |
| `metadata`        | Additional context specific to the hook type                                                                               |

## Audit Record Examples

### Allowed Output

```json
{
  "timestamp": "2025-01-29T10:23:47Z",
  "hook_type": "PRE_OUTPUT",
  "session_id": "sess_456",
  "decision": "ALLOW",
  "reason": "Classification check passed",
  "input": {
    "target_channel": "telegram",
    "recipient": "owner"
  },
  "rules_evaluated": [
    "no_write_down",
    "channel_classification"
  ],
  "taint_before": "INTERNAL",
  "taint_after": "INTERNAL"
}
```

### Blocked Write-Down

```json
{
  "timestamp": "2025-01-29T10:24:12Z",
  "hook_type": "PRE_OUTPUT",
  "session_id": "sess_456",
  "decision": "BLOCK",
  "reason": "Session taint (CONFIDENTIAL) exceeds effective classification (PUBLIC)",
  "input": {
    "target_channel": "whatsapp",
    "recipient": "external_user_789",
    "effective_classification": "PUBLIC"
  },
  "rules_evaluated": [
    "no_write_down",
    "channel_classification",
    "recipient_classification"
  ],
  "taint_before": "CONFIDENTIAL",
  "taint_after": "CONFIDENTIAL"
}
```

### Tool Call with Taint Escalation

```json
{
  "timestamp": "2025-01-29T10:23:45Z",
  "hook_type": "POST_TOOL_RESPONSE",
  "session_id": "sess_456",
  "decision": "ALLOW",
  "reason": "Tool response classified and taint updated",
  "input": {
    "tool_name": "salesforce.query_opportunities",
    "response_classification": "CONFIDENTIAL"
  },
  "rules_evaluated": [
    "tool_response_classification",
    "taint_escalation"
  ],
  "taint_before": "PUBLIC",
  "taint_after": "CONFIDENTIAL",
  "metadata": {
    "lineage_id": "lin_789xyz",
    "records_returned": 3
  }
}
```

## Audit Trace Capabilities

<img src="/diagrams/audit-trace-flow.svg" alt="Audit trace flow: forward trace, backward trace, and classification justification feed into compliance export" style="max-width: 100%;" />

Audit records can be queried in four ways, each serving a different compliance
and forensic need.

### Forward Trace

**Question:** "What happened to data from Salesforce record `opp_00123ABC`?"

A forward trace follows a data element from its point of origin through every
transformation, session, and output. It answers: where did this data go, who saw
it, and was it ever sent outside the organization?

```
Origin: salesforce.query_opportunities
  --> lineage_id: lin_789xyz
  --> classification: CONFIDENTIAL
  --> session: sess_456

Transformations:
  --> Extracted fields: name, amount, stage
  --> LLM summarized 3 records into pipeline overview

Outputs:
  --> Sent to owner via Telegram (ALLOWED)
  --> Blocked from WhatsApp external contact (BLOCKED)
```

### Backward Trace

**Question:** "What sources contributed to the message sent at 10:24 UTC?"

A backward trace starts from an output and walks back through the lineage chain
to identify every data source that influenced the output. This is essential for
understanding whether classified data was included in a response.

```
Output: Message sent to Telegram at 10:24:00Z
  --> session: sess_456
  --> lineage sources:
      --> lin_789xyz: Salesforce opportunity (CONFIDENTIAL)
      --> lin_790xyz: Salesforce opportunity (CONFIDENTIAL)
      --> lin_791xyz: Salesforce opportunity (CONFIDENTIAL)
      --> lin_792xyz: Weather API (PUBLIC)
```

### Classification Justification

**Question:** "Why is this data marked CONFIDENTIAL?"

Classification justification traces back to the rule or policy that assigned the
classification level:

```
Data: Pipeline summary (lin_789xyz)
Classification: CONFIDENTIAL
Reason: source_system_default
  --> Salesforce integration default classification: CONFIDENTIAL
  --> Configured by: admin_001 at 2025-01-10T08:00:00Z
  --> Policy rule: "All Salesforce data classified as CONFIDENTIAL"
```

### Compliance Export

For legal, regulatory, or internal review, Triggerfish can export the full chain
of custody for any data element or time range:

```
Export request:
  --> Time range: 2025-01-29T00:00:00Z to 2025-01-29T23:59:59Z
  --> Scope: All sessions for user_456
  --> Format: JSON

Export includes:
  --> All audit records in the time range
  --> All lineage records referenced by audit records
  --> All session state transitions
  --> All policy decisions (ALLOW, BLOCK, REDACT)
  --> All taint changes
```

::: tip Compliance exports are structured JSON files that can be ingested by
SIEM systems, compliance dashboards, or legal review tools. The export format is
stable and versioned. :::

## Data Lineage

Audit logging works in conjunction with Triggerfish's data lineage system. Every
data element processed by Triggerfish carries provenance metadata:

```json
{
  "lineage_id": "lin_789xyz",
  "content_hash": "sha256:a1b2c3d4...",
  "origin": {
    "source_type": "integration",
    "source_name": "salesforce",
    "record_id": "opp_00123ABC",
    "record_type": "Opportunity",
    "accessed_at": "2025-01-29T10:23:45Z",
    "accessed_by": "user_456",
    "access_method": "plugin_query"
  },
  "classification": {
    "level": "CONFIDENTIAL",
    "reason": "source_system_default",
    "assigned_at": "2025-01-29T10:23:45Z",
    "can_be_downgraded": false
  },
  "transformations": [
    {
      "type": "extraction",
      "description": "Selected fields: name, amount, stage",
      "timestamp": "2025-01-29T10:23:46Z",
      "agent_id": "agent_123"
    },
    {
      "type": "summarization",
      "description": "LLM summarized 3 records into pipeline overview",
      "timestamp": "2025-01-29T10:23:47Z",
      "input_lineage_ids": ["lin_789xyz", "lin_790xyz", "lin_791xyz"],
      "agent_id": "agent_123"
    }
  ],
  "current_location": {
    "session_id": "sess_456",
    "context_position": "assistant_response_3"
  }
}
```

Lineage records are created at `POST_TOOL_RESPONSE` (when data enters the
system) and updated as data is transformed. Aggregated data inherits
`max(input classifications)` -- if any input is CONFIDENTIAL, the output is at
least CONFIDENTIAL.

| Event                                 | Lineage Action                              |
| ------------------------------------- | ------------------------------------------- |
| Data read from integration            | Create lineage record with origin           |
| Data transformed by LLM               | Append transformation, link input lineages  |
| Data aggregated from multiple sources | Merge lineage, classification = max(inputs) |
| Data sent to channel                  | Record destination, verify classification   |
| Session reset                         | Archive lineage records, clear from context |

## Storage and Retention

Audit logs are persisted through the `StorageProvider` abstraction under the
`audit:` namespace. Lineage records are stored under the `lineage:` namespace.

| Data Type       | Namespace   | Default Retention         |
| --------------- | ----------- | ------------------------- |
| Audit logs      | `audit:`    | 1 year                    |
| Lineage records | `lineage:`  | 90 days                   |
| Session state   | `sessions:` | 30 days                   |
| Taint history   | `taint:`    | Matches session retention |

::: warning SECURITY Retention periods are configurable, but audit logs default
to 1 year to support compliance requirements (SOC 2, GDPR, HIPAA). Reducing the
retention period below your organization's regulatory requirement is the
administrator's responsibility. :::

### Storage Backends

| Tier           | Backend   | Details                                                                                                                                                         |
| -------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Personal**   | SQLite    | WAL-mode database at `~/.triggerfish/data/triggerfish.db`. Audit records are stored as structured JSON in the same database as all other Triggerfish state.     |
| **Enterprise** | Pluggable | Enterprise backends (Postgres, S3, etc.) can be used via the `StorageProvider` interface. This allows integration with existing log aggregation infrastructure. |

## Immutability and Integrity

Audit records are append-only. Once written, they cannot be modified or deleted
by any component of the system -- including the LLM, the agent, or plugins.
Deletion occurs only through retention policy expiration.

Each audit record includes a content hash that can be used to verify integrity.
If records are exported for compliance review, the hashes can be validated
against the stored records to detect tampering.

## Enterprise Compliance Features

Enterprise deployments can extend audit logging with:

| Feature                   | Description                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| **Legal hold**            | Suspend retention-based deletion for specified users, sessions, or time ranges                |
| **SIEM integration**      | Stream audit events to Splunk, Datadog, or other SIEM systems in real time                    |
| **Compliance dashboards** | Visual overview of policy decisions, blocked actions, and taint patterns                      |
| **Scheduled exports**     | Automatic periodic exports for regulatory review                                              |
| **Alert rules**           | Trigger notifications when specific audit patterns occur (e.g., repeated blocked write-downs) |

## Related Pages

- [Security-First Design](./) -- overview of the security architecture
- [No Write-Down Rule](./no-write-down) -- the classification flow rule whose
  enforcement is logged
- [Identity & Auth](./identity) -- how identity decisions are recorded
- [Agent Delegation](./agent-delegation) -- session access and classification
  checks
- [Secrets Management](./secrets) -- credential storage and integration access
