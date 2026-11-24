# Key Interfaces

This page documents the TypeScript interfaces that define Triggerfish's
extension points. If you are building a custom channel adapter, LLM provider,
storage backend, or policy integration, these are the contracts your code must
satisfy.

## Result\<T, E\>

Triggerfish uses a discriminated union result type instead of thrown exceptions
for all expected failures.

```typescript
type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
```

**Usage:**

```typescript
function parseConfig(raw: string): Result<Config, string> {
  try {
    const config = JSON.parse(raw);
    return { ok: true, value: config };
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
}

const result = parseConfig(input);
if (result.ok) {
  // result.value is Config
} else {
  // result.error is string
}
```

::: warning Never throw exceptions for expected failures. Use `Result<T, E>`
throughout. Thrown exceptions are reserved for truly unexpected, unrecoverable
errors (bugs). :::

## ClassificationLevel

The four-level classification system used for all data flow decisions.

```typescript
type ClassificationLevel =
  | "RESTRICTED"
  | "CONFIDENTIAL"
  | "INTERNAL"
  | "PUBLIC";
```

Ordered highest to lowest: `RESTRICTED > CONFIDENTIAL > INTERNAL > PUBLIC`. Data
can only flow to equal or higher levels (no write-down).

## StorageProvider

The unified persistence abstraction. All stateful data in Triggerfish flows
through this interface.

```typescript
interface StorageProvider {
  /** Store a value under the given key. Overwrites any existing value. */
  set(key: string, value: string): Promise<void>;

  /** Retrieve a value by key. Returns null when the key does not exist. */
  get(key: string): Promise<string | null>;

  /** Delete a key. No-op when the key does not exist. */
  delete(key: string): Promise<void>;

  /** List all keys matching an optional prefix. Returns all keys when no prefix is supplied. */
  list(prefix?: string): Promise<string[]>;

  /** Release resources held by this provider (e.g., close database handles). */
  close(): Promise<void>;
}
```

**Implementations:**

| Backend                 | Use Case                                                                       |
| ----------------------- | ------------------------------------------------------------------------------ |
| `MemoryStorageProvider` | Testing, ephemeral sessions                                                    |
| `SqliteStorageProvider` | Default for personal tier (SQLite WAL at `~/.triggerfish/data/triggerfish.db`) |
| Enterprise backends     | Customer-managed (Postgres, S3, etc.)                                          |

**Key namespaces:** `sessions:`, `taint:`, `lineage:`, `audit:`, `cron:`,
`notifications:`, `exec:`, `skills:`, `config:`

## ChannelAdapter

The common interface for all messaging channel adapters (CLI, Telegram, Slack,
Discord, WhatsApp, WebChat, Email).

```typescript
interface ChannelAdapter {
  /** The classification level assigned to this channel. */
  readonly classification: ClassificationLevel;

  /** Whether the current user is the owner. */
  readonly isOwner: boolean;

  /** Connect to the channel. */
  connect(): Promise<void>;

  /** Disconnect from the channel. */
  disconnect(): Promise<void>;

  /** Send a message to the channel. */
  send(message: ChannelMessage): Promise<void>;

  /** Register a handler for incoming messages. */
  onMessage(handler: MessageHandler): void;

  /** Get the current channel status. */
  status(): ChannelStatus;
}
```

**Supporting types:**

```typescript
interface ChannelMessage {
  readonly content: string;
  readonly sessionId?: string;
  readonly sessionTaint?: ClassificationLevel;
}

interface ChannelStatus {
  readonly connected: boolean;
  readonly channelType: string;
}

type MessageHandler = (message: ChannelMessage) => void;
```

## LlmProvider

The interface for LLM completions. Each provider (Anthropic, OpenAI, Google,
Local, OpenRouter) implements this interface.

```typescript
interface LlmProvider {
  /** Provider name identifier. */
  readonly name: string;

  /** Whether this provider supports streaming responses. */
  readonly supportsStreaming: boolean;

  /** Send messages to the LLM and receive a completion response. */
  complete(
    messages: readonly LlmMessage[],
    tools: readonly unknown[],
    options: Record<string, unknown>,
  ): Promise<LlmCompletionResult>;
}
```

**Provider registry:**

```typescript
interface LlmProviderRegistry {
  /** Register a provider. Replaces any existing provider with the same name. */
  register(provider: LlmProvider): void;

  /** Get a provider by name, or undefined if not registered. */
  get(name: string): LlmProvider | undefined;

  /** Set the default provider by name. Must already be registered. */
  setDefault(name: string): void;

  /** Get the default provider, or undefined if none set. */
  getDefault(): LlmProvider | undefined;
}
```

## NotificationService

The notification delivery abstraction. See
[Notifications](/features/notifications) for usage details.

```typescript
type NotificationPriority = "critical" | "normal" | "low";

interface Notification {
  readonly id: string;
  readonly userId: UserId;
  readonly message: string;
  readonly priority: NotificationPriority;
  readonly createdAt: Date;
}

interface DeliverOptions {
  readonly userId: UserId;
  readonly message: string;
  readonly priority: NotificationPriority;
}

interface NotificationService {
  /** Deliver or queue a notification for a user. */
  deliver(options: DeliverOptions): Promise<void>;

  /** Get pending (undelivered) notifications for a user. */
  getPending(userId: UserId): Promise<Notification[]>;

  /** Acknowledge a notification as delivered. */
  acknowledge(notificationId: string): Promise<void>;
}
```

## Hook Types

Policy enforcement hooks intercept actions at critical points in the data flow.
All hooks are deterministic, synchronous, logged, and unforgeable.

### HookType

```typescript
type HookType =
  | "PRE_CONTEXT_INJECTION"
  | "PRE_TOOL_CALL"
  | "POST_TOOL_RESPONSE"
  | "PRE_OUTPUT"
  | "SESSION_RESET"
  | "MCP_TOOL_CALL";
```

Five hook types are active runtime controls. `SESSION_RESET` is reserved.

### PolicyAction

```typescript
type PolicyAction = "ALLOW" | "BLOCK" | "REDACT" | "REQUIRE_APPROVAL";
```

### HookContext and HookResult

```typescript
interface HookContext {
  readonly session: SessionState;
  readonly input: Record<string, unknown>;
}

interface HookResult {
  readonly allowed: boolean;
  readonly action: PolicyAction;
  readonly ruleId: string | null;
  readonly message?: string;
  readonly duration: number;
}
```

## SessionState

The fundamental unit of conversation state with independent taint tracking.

```typescript
interface SessionState {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly channelId: ChannelId;
  readonly taint: ClassificationLevel;
  readonly createdAt: Date;
  readonly history: readonly TaintEvent[];
}
```

**Branded ID types:**

```typescript
type SessionId = string & { readonly __brand: "SessionId" };
type UserId = string & { readonly __brand: "UserId" };
type ChannelId = string & { readonly __brand: "ChannelId" };
```

Branded types prevent accidental misuse of IDs -- you cannot pass a `UserId`
where a `SessionId` is expected.

::: info All session operations are immutable. Functions return new
`SessionState` objects rather than mutating existing ones. This ensures
referential transparency and simplifies testing. :::
