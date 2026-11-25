# Storage

All stateful data in Triggerfish flows through a unified `StorageProvider`
abstraction. No module creates its own storage mechanism -- every component that
needs persistence takes a `StorageProvider` as a dependency. This design makes
backends swappable without touching business logic and keeps all tests fast and
deterministic.

## StorageProvider Interface

```typescript
interface StorageProvider {
  /** Retrieve a value by key. Returns null if not found. */
  get(key: string): Promise<StorageValue | null>;

  /** Store a value at a key. Overwrites any existing value. */
  set(key: string, value: StorageValue): Promise<void>;

  /** Delete a key. No-op if key does not exist. */
  delete(key: string): Promise<void>;

  /** List all keys matching an optional prefix. */
  list(prefix?: string): Promise<string[]>;

  /** Delete all keys. Use with caution. */
  clear(): Promise<void>;
}
```

::: info `StorageValue` is a string. All structured data (sessions, lineage
records, configuration) is serialized to JSON before storage and deserialized on
read. This keeps the interface simple and backend-agnostic. :::

## Implementations

| Backend                 | Use Case                    | Persistence                                        | Configuration                   |
| ----------------------- | --------------------------- | -------------------------------------------------- | ------------------------------- |
| `MemoryStorageProvider` | Testing, ephemeral sessions | None (lost on restart)                             | No configuration needed         |
| `SqliteStorageProvider` | Default for personal tier   | SQLite WAL at `~/.triggerfish/data/triggerfish.db` | Zero configuration              |
| Enterprise backends     | Enterprise tier             | Customer-managed                                   | Postgres, S3, or other backends |

### MemoryStorageProvider

Used in all tests for speed and determinism. Data exists only in memory and is
lost when the process exits. Every test suite creates a fresh
`MemoryStorageProvider`, ensuring tests are isolated and reproducible.

### SqliteStorageProvider

The default for personal tier deployments. Uses SQLite in WAL (Write-Ahead
Logging) mode for concurrent read access and crash safety. The database lives
at:

```
~/.triggerfish/data/triggerfish.db
```

SQLite requires no configuration, no server process, and no network. A single
file stores all Triggerfish state. The `@db/sqlite` Deno package provides the
binding, which requires `--allow-ffi` permission.

::: tip SQLite WAL mode allows multiple readers to access the database
concurrently with a single writer. This is important for the Gateway, which may
read session state while the agent is writing tool results. :::

### Enterprise Backends

Enterprise deployments can plug in external storage backends (Postgres, S3,
etc.) without code changes. Any implementation of the `StorageProvider`
interface works. The backend is configured in `triggerfish.yaml`.

## Namespaced Keys

All keys in the storage system are namespaced with a prefix that identifies the
data type. This prevents collisions and makes it possible to query, retain, and
purge data by category.

| Namespace        | Key Pattern                                  | Description                                    |
| ---------------- | -------------------------------------------- | ---------------------------------------------- |
| `sessions:`      | `sessions:sess_abc123`                       | Session state (conversation history, metadata) |
| `taint:`         | `taint:sess_abc123`                          | Session taint level                            |
| `lineage:`       | `lineage:lin_789xyz`                         | Data lineage records (provenance tracking)     |
| `audit:`         | `audit:2025-01-29T10:23:45Z:hook_pre_output` | Audit log entries                              |
| `cron:`          | `cron:job_daily_report`                      | Cron job state and execution history           |
| `notifications:` | `notifications:notif_456`                    | Notification queue                             |
| `exec:`          | `exec:run_789`                               | Agent execution environment history            |
| `skills:`        | `skills:skill_weather`                       | Installed skill metadata                       |
| `config:`        | `config:v3`                                  | Configuration snapshots                        |

## Retention Policies

Each namespace has a default retention policy. Enterprise deployments can
customize these.

| Namespace        | Default Retention         | Rationale                                  |
| ---------------- | ------------------------- | ------------------------------------------ |
| `sessions:`      | 30 days                   | Conversation history ages out              |
| `taint:`         | Matches session retention | Taint is meaningless without its session   |
| `lineage:`       | 90 days                   | Compliance-driven, audit trail             |
| `audit:`         | 1 year                    | Compliance-driven, legal and regulatory    |
| `cron:`          | 30 days                   | Execution history for debugging            |
| `notifications:` | Until delivered + 7 days  | Undelivered notifications must persist     |
| `exec:`          | 30 days                   | Execution artifacts for debugging          |
| `skills:`        | Permanent                 | Installed skill metadata should not expire |
| `config:`        | 10 versions               | Rolling config history for rollback        |

## Design Principles

### All Modules Use StorageProvider

No module in Triggerfish creates its own storage mechanism. Session management,
taint tracking, lineage recording, audit logging, cron state, notification
queues, execution history, and configuration -- all flow through
`StorageProvider`.

This means:

- Swapping backends requires changing one dependency injection point
- Tests use `MemoryStorageProvider` for speed -- no SQLite setup, no filesystem
- There is exactly one place to implement encryption-at-rest, backup, or
  replication

### Serialization

All structured data is serialized to JSON strings before storage. The
serialize/deserialize layer handles:

- `Date` objects (serialized as ISO 8601 strings via `toISOString()`,
  deserialized via `new Date()`)
- Branded types (serialized as their underlying string value)
- Nested objects and arrays

```typescript
// Storing a session
const session = {
  id: "sess_abc",
  taint: "CONFIDENTIAL",
  createdAt: new Date(),
};
await storage.set("sessions:sess_abc", JSON.stringify(session));

// Retrieving a session
const raw = await storage.get("sessions:sess_abc");
if (raw) {
  const session = JSON.parse(raw);
  session.createdAt = new Date(session.createdAt); // Restore Date
}
```

### Immutability

Session operations are immutable. Reading a session, modifying it, and writing
it back always produces a new object. Functions never mutate the stored object
in place. This aligns with the broader Triggerfish principle that functions
return new objects and never mutate.

## Directory Structure

```
~/.triggerfish/
  config/          # Agent configuration, SPINE.md, TRIGGER.md
  data/            # triggerfish.db (SQLite)
  workspace/       # Agent exec environment
    <agent-id>/    # Per-agent workspace (persists)
    background/    # Background session workspaces
  skills/          # Installed skills
  logs/            # Audit logs
  secrets/         # Encrypted credential store
```

::: warning SECURITY The `secrets/` directory contains encrypted credentials
managed by the OS keychain integration. Never store secrets in configuration
files or in the `StorageProvider`. Use the OS keychain (personal tier) or vault
integration (enterprise tier). :::
## Durable agent turns

Triggerfish holds tool exchange checkpoints separately from chat transcripts.
An admitted execution has an exact scope and request digest. It records a
pending batch before dispatch and commits approved tool exchanges before the
next model step. Recovery rechecks current tool policy and classification.
An interrupted batch remains pending for reconciliation. The protected turn
stores approved fields from tool calls and results, and keeps raw prompts,
reasoning, and final model prose out of its durable conversation record.

| Agent path | Start and durable admission | Resume |
| --- | --- | --- |
| Owner chat | The authenticated `/recover` command uses a caller-supplied UUID scoped to the owner session. | Send the same UUID and request to the gateway. |
| Subagent | Authenticated `/recover-subagent` uses the existing factory and a stable session derived from the parent and execution ID. | Retry the same command under the original parent session and ceiling. |
| Team member | An authorized team delivery binds its UUID, sender, team, and recipient. New eligible members also retain their workspace and execution context. | Retry the exact delivery. The team must still be active with the same member and caller authorization. |
| Cron | A configured job admits a UTC occurrence with its current task digest and ceiling. | The scheduler scans admitted runs and rechecks current job settings. |
| Periodic and manual triggers | The scheduler records an interval occurrence or manual execution ID with instruction and prior-history digests. | Startup rechecks those inputs and resumes a saved text continuation. |
| Signed webhook | Signature and replay checks precede an admission bound to the source, credential, and body digest. | The authenticated owner route accepts the original body for that admission. |
| Sentinel assessment worker | The coordinator leases an exact case assignment and evidence revision. The worker saves the completed exchange under that lease. | The coordinator reacquires an eligible assignment and rechecks the case revision, lease, and live-read scope. |
