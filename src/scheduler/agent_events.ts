/** Durable admission of classified, metadata-only events to configured agents. */
/// <reference path="../core/sqlite_types.d.ts" />

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { redactCredentialText } from "../core/logger/redactor.ts";

export const agentEventKinds = [
  "finding",
  "goal_completed",
  "timeout",
  "task_created",
  "tool_completed",
  "interval",
] as const;
type AgentEventKind = typeof agentEventKinds[number];

export interface AgentEventSubscription {
  readonly id: string;
  readonly agent: string;
  readonly kinds: readonly AgentEventKind[];
  readonly caseId?: string;
  readonly tool?: string;
  readonly tools?: readonly string[];
  readonly includeToolErrors?: boolean;
  readonly instructions?: Readonly<Partial<Record<AgentEventKind, string>>>;
  readonly intervalMs?: number;
  readonly fireOnStart?: boolean;
  readonly merge: "none" | "by_case" | "all";
  readonly maxConcurrent: number;
  readonly enabled: boolean;
}

export interface AgentEvent {
  readonly kind: AgentEventKind;
  /** Trusted immutable receipt identity. No source arguments or results. */
  readonly receipt: string;
  readonly caseId?: string;
  readonly tool?: string;
  readonly outcome?: "error";
  readonly recordedAt?: number;
}

function eventTime(event: AgentEvent) {
  return event.recordedAt ??
    (event.kind === "interval"
      ? Number(event.receipt)
      : Number.MAX_SAFE_INTEGER);
}

/** Oldest retained record first, with a stable identity order for equal clocks. */
export function compareAgentEvents(a: AgentEvent, b: AgentEvent): number {
  return eventTime(a) - eventTime(b) ||
    a.kind.localeCompare(b.kind) ||
    (a.caseId ?? "").localeCompare(b.caseId ?? "") ||
    (a.tool ?? "").localeCompare(b.tool ?? "") ||
    a.receipt.localeCompare(b.receipt);
}

const id = /^[a-z][a-z0-9_-]{0,63}$/;
const receipt = /^[a-zA-Z0-9:_.-]{1,200}$/;
const caseId = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const toolName = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/;

export function parseAgentEventSubscription(
  input: unknown,
): AgentEventSubscription | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const raw = input as Record<string, unknown>;
  const kinds = agentEventKinds.filter((kind) =>
    Array.isArray(raw.kinds) && raw.kinds.includes(kind)
  );
  const tools = raw.tools;
  const instructions: Partial<Record<AgentEventKind, string>> = {};
  if (raw.instructions !== undefined) {
    if (
      !raw.instructions || typeof raw.instructions !== "object" ||
      Array.isArray(raw.instructions)
    ) return;
    for (const [kind, value] of Object.entries(raw.instructions)) {
      const selected = kinds.find((entry) => entry === kind);
      if (
        !selected || typeof value !== "string" || !value.trim() ||
        value.length > 1000 ||
        /[\p{Cc}\p{Cf}]/u.test(value.replaceAll("\n", "")) ||
        redactCredentialText(value) !== value
      ) return;
      instructions[selected] = value.trim();
    }
  }
  if (
    Object.keys(raw).some((key) =>
      ![
        "id",
        "agent",
        "kinds",
        "caseId",
        "tool",
        "tools",
        "includeToolErrors",
        "instructions",
        "intervalMs",
        "fireOnStart",
        "merge",
        "maxConcurrent",
        "enabled",
      ].includes(key)
    ) ||
    typeof raw.id !== "string" || !id.test(raw.id) ||
    typeof raw.agent !== "string" || !id.test(raw.agent) ||
    !Array.isArray(raw.kinds) || !kinds.length ||
    raw.kinds.length !== kinds.length ||
    (raw.caseId !== undefined &&
      (typeof raw.caseId !== "string" || !caseId.test(raw.caseId))) ||
    (kinds.includes("tool_completed")
      ? tools === undefined
        ? typeof raw.tool !== "string" || !toolName.test(raw.tool)
        : raw.tool !== undefined || !Array.isArray(tools) ||
          tools.length < 1 || tools.length > 16 ||
          !tools.every((name) =>
            typeof name === "string" && toolName.test(name)
          ) ||
          new Set(tools).size !== tools.length
      : raw.tool !== undefined || tools !== undefined) ||
    (raw.includeToolErrors !== undefined &&
      (!kinds.includes("tool_completed") ||
        typeof raw.includeToolErrors !== "boolean")) ||
    (kinds.includes("interval")
      ? typeof raw.intervalMs !== "number" ||
        !Number.isSafeInteger(raw.intervalMs) ||
        raw.intervalMs < 60_000 || raw.intervalMs > 30 * 86_400_000
      : raw.intervalMs !== undefined) ||
    (raw.fireOnStart !== undefined &&
      (!kinds.includes("interval") || typeof raw.fireOnStart !== "boolean")) ||
    typeof raw.enabled !== "boolean" ||
    (raw.merge !== "none" && raw.merge !== "by_case" && raw.merge !== "all") ||
    typeof raw.maxConcurrent !== "number" ||
    !Number.isSafeInteger(raw.maxConcurrent) ||
    raw.maxConcurrent < 1 || raw.maxConcurrent > 16
  ) return;
  return {
    id: raw.id,
    agent: raw.agent,
    kinds,
    merge: raw.merge,
    maxConcurrent: raw.maxConcurrent,
    enabled: raw.enabled,
    ...(typeof raw.caseId === "string" && { caseId: raw.caseId }),
    ...(typeof raw.tool === "string" && { tool: raw.tool }),
    ...(Array.isArray(tools) && { tools: [...tools].sort() }),
    ...(raw.includeToolErrors === true && { includeToolErrors: true }),
    ...(Object.keys(instructions).length && { instructions }),
    ...(typeof raw.intervalMs === "number" && { intervalMs: raw.intervalMs }),
    ...(raw.fireOnStart === true && { fireOnStart: true }),
  };
}

interface Entry {
  subscription: AgentEventSubscription;
  version: number;
}
export interface AgentEventDelivery extends Entry {
  readonly id: string;
  readonly events: readonly AgentEvent[];
  readonly token: string;
}

/** A new subscription starts at the current high-water mark. */
export function openAgentEventSchedule(path: string, now = Date.now) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS agent_event_subscriptions (
      id TEXT PRIMARY KEY, version INTEGER NOT NULL, spec TEXT NOT NULL,
      cursor INTEGER NOT NULL, next_interval INTEGER, registered_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_event_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT UNIQUE NOT NULL,
      event TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_event_deliveries (
      id TEXT PRIMARY KEY, subscription TEXT NOT NULL, version INTEGER NOT NULL,
      agent TEXT NOT NULL, events TEXT NOT NULL, state TEXT NOT NULL,
      token TEXT, lease_until INTEGER
    );
  `);

  function transact<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  const at = (key: string) =>
    db.prepare(
      "SELECT * FROM agent_event_subscriptions WHERE id = ?",
    ).get(key);
  const decode = (row: Record<string, unknown>): Entry => ({
    subscription: JSON.parse(String(row.spec)),
    version: Number(row.version),
  });

  function publish(event: AgentEvent) {
    if (
      !agentEventKinds.includes(event.kind) || event.kind === "interval" ||
      !receipt.test(event.receipt) ||
      (event.caseId !== undefined && !caseId.test(event.caseId)) ||
      (event.kind === "tool_completed"
        ? !event.tool || !toolName.test(event.tool) ||
          (event.outcome !== undefined && event.outcome !== "error")
        : event.tool !== undefined || event.outcome !== undefined)
    ) return false;
    if (
      event.recordedAt !== undefined &&
      (!Number.isSafeInteger(event.recordedAt) || event.recordedAt < 0 ||
        event.recordedAt > now())
    ) return false;
    const normalized = {
      kind: event.kind,
      receipt: event.receipt,
      caseId: event.caseId,
      tool: event.tool,
      ...(event.outcome === "error" && { outcome: event.outcome }),
      recordedAt: event.recordedAt ?? now(),
    };
    return db.prepare(
      "INSERT OR IGNORE INTO agent_event_receipts(event_key,event) VALUES (?,?)",
    ).run(
      JSON.stringify([
        normalized.kind,
        normalized.caseId,
        normalized.receipt,
        normalized.tool,
      ]),
      JSON.stringify(normalized),
    ).changes === 1;
  }

  function enqueue(
    s: AgentEventSubscription,
    version: number,
    events: readonly AgentEvent[],
  ) {
    const mergeCase = s.merge === "by_case" ? events[0]?.caseId : undefined;
    if (s.merge === "all" || mergeCase) {
      const queued = db.prepare(`
        SELECT id,events FROM agent_event_deliveries
        WHERE subscription=? AND version=? AND state='queued'
          AND (? IS NULL OR json_extract(events,'$[0].caseId')=?)
          AND json_array_length(events) + ? <= 64
        ORDER BY rowid LIMIT 1
      `).get(
        s.id,
        version,
        mergeCase ?? null,
        mergeCase ?? null,
        events.length,
      );
      if (queued) {
        const batch = [
          ...JSON.parse(String(queued.events)) as AgentEvent[],
          ...events,
        ];
        db.prepare("UPDATE agent_event_deliveries SET events=? WHERE id=?")
          .run(JSON.stringify(batch), String(queued.id));
        return;
      }
    }
    const occurrence = createHash("sha256")
      .update(JSON.stringify([s.id, version, events])).digest("hex");
    db.prepare(
      "INSERT OR IGNORE INTO agent_event_deliveries(id,subscription,version,agent,events,state) VALUES (?,?,?,?,?,'queued')",
    ).run(occurrence, s.id, version, s.agent, JSON.stringify(events));
  }

  function admit(): boolean {
    const subscriptions = db.prepare("SELECT * FROM agent_event_subscriptions")
      .all().flatMap((row) => {
        if (row.spec === "null") return [];
        const entry = decode(row);
        return entry.subscription.enabled ? [{ row, ...entry }] : [];
      });
    if (!subscriptions.length) return false;
    // Advance all current subscriptions through the same receipt window. A
    // newer registration cannot enqueue from beyond this window while an
    // older subscription has yet to inspect it.
    const earliest = subscriptions.reduce(
      (cursor, { row }) => Math.min(cursor, Number(row.cursor)),
      Number.MAX_SAFE_INTEGER,
    );
    const receipts = db.prepare(
      "SELECT sequence,event FROM agent_event_receipts WHERE sequence > ? ORDER BY sequence LIMIT 65",
    ).all(earliest);
    const page = receipts.slice(0, 64).map(({ sequence, event }) => ({
      sequence: Number(sequence),
      event: JSON.parse(String(event)) as AgentEvent,
    }));
    const frontier = page.at(-1)?.sequence;
    const planned: {
      subscription: AgentEventSubscription;
      version: number;
      events: AgentEvent[];
    }[] = [];
    for (const { row, subscription: s, version } of subscriptions) {
      const cursor = Number(row.cursor);
      const registeredAt = Number(row.registered_at);
      const seen = page.flatMap(({ sequence, event: e }) =>
        sequence > cursor &&
          (e.recordedAt ?? 0) >= registeredAt &&
          s.kinds.includes(e.kind) &&
          (!s.caseId || e.caseId === s.caseId) &&
          (e.kind !== "tool_completed" ||
            (e.tool !== undefined && (!e.outcome || s.includeToolErrors) &&
              (e.tool === s.tool || s.tools?.includes(e.tool))))
          ? [e]
          : []
      );
      const due = Number(row.next_interval);
      if (s.intervalMs && due <= now()) {
        seen.push({ kind: "interval", receipt: String(due), caseId: s.caseId });
        db.prepare(
          "UPDATE agent_event_subscriptions SET next_interval=? WHERE id=?",
        ).run(now() + s.intervalMs, s.id);
      }
      if (frontier !== undefined && frontier > cursor) {
        db.prepare(
          "UPDATE agent_event_subscriptions SET cursor=? WHERE id=?",
        ).run(frontier, s.id);
      }
      seen.sort(compareAgentEvents);
      if (s.merge === "all" && seen.length) {
        planned.push({ subscription: s, version, events: seen });
      } else {
        const cases = new Map<string, AgentEvent[]>();
        for (const event of seen) {
          if (s.merge !== "by_case" || !event.caseId) {
            planned.push({ subscription: s, version, events: [event] });
            continue;
          }
          const grouped = cases.get(event.caseId) ?? [];
          grouped.push(event);
          cases.set(event.caseId, grouped);
        }
        for (const events of cases.values()) {
          planned.push({ subscription: s, version, events });
        }
      }
    }
    planned.sort((a, b) =>
      compareAgentEvents(a.events[0], b.events[0]) ||
      a.subscription.id.localeCompare(b.subscription.id)
    );
    for (const item of planned) {
      enqueue(item.subscription, item.version, item.events);
    }
    return receipts.length > page.length;
  }

  return {
    close: () => db.close(),
    publish,
    list: () =>
      db.prepare(
        "SELECT version,spec FROM agent_event_subscriptions WHERE spec != 'null' ORDER BY id",
      ).all().map(decode),
    earliestSubscriptionRegistration: () => {
      const registeredAt = db.prepare(`
        SELECT MIN(registered_at) AS at FROM agent_event_subscriptions
        WHERE json_extract(spec, '$.enabled') = 1
      `).get()?.at;
      return typeof registeredAt === "number" ? registeredAt : undefined;
    },
    deliveries: () =>
      db.prepare(
        "SELECT id,subscription,version,agent,state FROM agent_event_deliveries ORDER BY rowid DESC LIMIT 20",
      ).all(),
    deletion(key: string, expectedVersion: number) {
      const row = at(key);
      if (row?.spec === "null" && row.version === expectedVersion + 1) {
        return { id: key, version: expectedVersion + 1, deleted: true };
      }
    },
    remove(key: string, expectedVersion: number) {
      if (
        !id.test(key) || !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1 || expectedVersion >= Number.MAX_SAFE_INTEGER
      ) return;
      return transact(() => {
        const removed = db.prepare(`
          UPDATE agent_event_subscriptions
          SET spec='null', version=version+1, next_interval=NULL
          WHERE id=? AND version=? AND spec != 'null'
        `).run(key, expectedVersion);
        if (removed.changes !== 1) return;
        db.prepare(`UPDATE agent_event_deliveries SET state='revoked'
          WHERE subscription=? AND state='queued'`).run(key);
        return { id: key, version: expectedVersion + 1, deleted: true };
      });
    },
    set(input: unknown, expectedVersion: number) {
      const s = parseAgentEventSubscription(input);
      if (
        !s || !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER
      ) return;
      return transact(() => {
        const current = at(s.id);
        if (
          current?.spec === "null" ||
          Number(current?.version ?? 0) !== expectedVersion
        ) return;
        const version = expectedVersion + 1;
        const cursor = Number(
          db.prepare(
            "SELECT COALESCE(MAX(sequence),0) maximum FROM agent_event_receipts",
          ).get()?.maximum,
        );
        const registered = now();
        db.prepare(`INSERT INTO agent_event_subscriptions VALUES (?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET version=excluded.version,spec=excluded.spec,
          cursor=excluded.cursor,next_interval=excluded.next_interval,registered_at=excluded.registered_at`)
          .run(
            s.id,
            version,
            JSON.stringify(s),
            cursor,
            s.intervalMs
              ? registered + (s.fireOnStart ? 0 : s.intervalMs)
              : null,
            registered,
          );
        db.prepare(`UPDATE agent_event_deliveries SET state='revoked'
          WHERE subscription=? AND state='queued'`).run(s.id);
        return { subscription: s, version };
      });
    },
    claim(): AgentEventDelivery | undefined {
      return transact(() => {
        // A crashed dispatch may have had side effects. Leave its receipt for review.
        db.prepare(`UPDATE agent_event_deliveries SET state='interrupted'
          WHERE state='running' AND lease_until <= ?`).run(now());
        const next = db.prepare(`
          SELECT job.*, selected.spec FROM agent_event_deliveries AS job
          JOIN agent_event_subscriptions AS selected ON selected.id=job.subscription
            AND selected.version=job.version
          WHERE job.state='queued' AND json_extract(selected.spec,'$.enabled')=1
            AND (SELECT COUNT(*) FROM agent_event_deliveries AS active
              WHERE active.agent=job.agent AND active.state='running') <
              (SELECT MIN(json_extract(other.spec,'$.maxConcurrent'))
                FROM agent_event_subscriptions AS other
                WHERE json_extract(other.spec,'$.agent')=job.agent
                  AND json_extract(other.spec,'$.enabled')=1)
          ORDER BY job.rowid LIMIT 1
        `);
        let row: ReturnType<typeof next.get>;
        let more: boolean;
        do {
          more = admit();
          row = next.get();
        } while (!row && more);
        if (row) {
          const entry = decode(row);
          const token = crypto.randomUUID();
          db.prepare(
            `UPDATE agent_event_deliveries SET state='running',token=?,lease_until=?
            WHERE id=?`,
          ).run(token, now() + 5 * 60_000, String(row.id));
          return {
            ...entry,
            id: String(row.id),
            events: JSON.parse(String(row.events)),
            token,
          };
        }
      });
    },
    current(delivery: AgentEventDelivery) {
      const spec = at(delivery.subscription.id);
      return Number(spec?.version) === delivery.version && !!db.prepare(
        "SELECT 1 FROM agent_event_deliveries WHERE id=? AND token=? AND state='running' AND lease_until > ?",
      ).get(delivery.id, delivery.token, now());
    },
    finish(
      delivery: AgentEventDelivery,
      state: "completed" | "denied" | "failed",
    ) {
      return db.prepare(
        `UPDATE agent_event_deliveries SET state=?
        WHERE id=? AND token=? AND state='running'
          AND (? != 'completed' OR (lease_until > ? AND EXISTS (
            SELECT 1 FROM agent_event_subscriptions AS sub
            WHERE sub.id=subscription AND sub.version=agent_event_deliveries.version
              AND json_extract(sub.spec, '$.enabled')=1)))`,
      ).run(state, delivery.id, delivery.token, state, now()).changes === 1;
    },
  };
}
