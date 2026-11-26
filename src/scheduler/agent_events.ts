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
  readonly instructions?: Readonly<Partial<Record<AgentEventKind, string>>>;
  readonly intervalMs?: number;
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
  readonly recordedAt?: number;
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
        "instructions",
        "intervalMs",
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
    (kinds.includes("interval")
      ? typeof raw.intervalMs !== "number" ||
        !Number.isSafeInteger(raw.intervalMs) ||
        raw.intervalMs < 60_000 || raw.intervalMs > 30 * 86_400_000
      : raw.intervalMs !== undefined) ||
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
    ...(Object.keys(instructions).length && { instructions }),
    ...(typeof raw.intervalMs === "number" && { intervalMs: raw.intervalMs }),
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
        ? !event.tool || !toolName.test(event.tool)
        : event.tool !== undefined)
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

  function admit() {
    const subscriptions = db.prepare("SELECT * FROM agent_event_subscriptions")
      .all();
    for (const row of subscriptions) {
      const { subscription: s, version } = decode(row);
      if (!s.enabled) continue;
      const events = db.prepare(
        "SELECT sequence,event FROM agent_event_receipts WHERE sequence > ? ORDER BY sequence LIMIT 64",
      ).all(Number(row.cursor));
      const seen = events.flatMap(({ event }) => {
        const e = JSON.parse(String(event)) as AgentEvent;
        return (e.recordedAt ?? 0) >= Number(row.registered_at) &&
            s.kinds.includes(e.kind) &&
            (!s.caseId || e.caseId === s.caseId) &&
            (e.kind !== "tool_completed" ||
              (e.tool !== undefined &&
                (e.tool === s.tool || s.tools?.includes(e.tool))))
          ? [e]
          : [];
      });
      const due = Number(row.next_interval);
      if (s.intervalMs && due <= now()) {
        seen.push({ kind: "interval", receipt: String(due), caseId: s.caseId });
        db.prepare(
          "UPDATE agent_event_subscriptions SET next_interval=? WHERE id=?",
        )
          .run(now() + s.intervalMs, s.id);
      }
      if (events.length) {
        db.prepare(
          "UPDATE agent_event_subscriptions SET cursor=? WHERE id=?",
        ).run(Number(events.at(-1)?.sequence), s.id);
      }
      if (s.merge === "all" && seen.length) enqueue(s, version, seen);
      else if (s.merge === "by_case") {
        const cases = new Map<string, AgentEvent[]>();
        for (const event of seen) {
          if (!event.caseId) {
            enqueue(s, version, [event]);
            continue;
          }
          const group = cases.get(event.caseId) ?? [];
          group.push(event);
          cases.set(event.caseId, group);
        }
        for (const group of cases.values()) enqueue(s, version, group);
      } else for (const event of seen) enqueue(s, version, [event]);
    }
  }

  return {
    close: () => db.close(),
    publish,
    list: () =>
      db.prepare(
        "SELECT version,spec FROM agent_event_subscriptions ORDER BY id",
      ).all().map(decode),
    deliveries: () =>
      db.prepare(
        "SELECT id,subscription,version,agent,state FROM agent_event_deliveries ORDER BY rowid DESC LIMIT 20",
      ).all(),
    set(input: unknown, expectedVersion: number) {
      const s = parseAgentEventSubscription(input);
      if (
        !s || !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER
      ) return;
      return transact(() => {
        const current = at(s.id);
        if (Number(current?.version ?? 0) !== expectedVersion) return;
        const version = expectedVersion + 1;
        const cursor = Number(
          db.prepare(
            "SELECT COALESCE(MAX(sequence),0) maximum FROM agent_event_receipts",
          ).get()?.maximum,
        );
        db.prepare(`INSERT INTO agent_event_subscriptions VALUES (?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET version=excluded.version,spec=excluded.spec,
          cursor=excluded.cursor,next_interval=excluded.next_interval,registered_at=excluded.registered_at`)
          .run(
            s.id,
            version,
            JSON.stringify(s),
            cursor,
            s.intervalMs ? now() + s.intervalMs : null,
            now(),
          );
        db.prepare(`UPDATE agent_event_deliveries SET state='revoked'
          WHERE subscription=? AND state='queued'`).run(s.id);
        return { subscription: s, version };
      });
    },
    claim(): AgentEventDelivery | undefined {
      return transact(() => {
        admit();
        // A crashed dispatch may have had side effects. Leave its receipt for review.
        db.prepare(`UPDATE agent_event_deliveries SET state='interrupted'
          WHERE state='running' AND lease_until <= ?`).run(now());
        const row = db.prepare(`
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
        `).get();
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
