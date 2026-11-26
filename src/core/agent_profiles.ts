/** Durable owner-reviewed agent definitions and prompt revisions. */
/// <reference path="./sqlite_types.d.ts" />

import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { redactCredentialText } from "./logger/redactor.ts";

const profileId = /^[a-z][a-z0-9_-]{0,63}$/;
const requestId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const toolId = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/;

export interface AgentProfileDefinition {
  readonly name: string;
  readonly description: string;
  readonly role: string;
  readonly prompt: string;
  readonly wrapupPrompt?: string;
  readonly timeoutWrapupPrompt?: string;
  readonly maxTurns?: number;
  readonly timeoutWrapupTurns?: number;
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
}

export interface AgentProfileRevision {
  readonly id: string;
  readonly version: number;
  readonly requestId: string;
  readonly recordedAt: string;
  readonly operatorSessionId: string;
  readonly definition: AgentProfileDefinition | null;
}

export function isAgentProfileId(value: unknown): value is string {
  return typeof value === "string" && profileId.test(value);
}

function safeText(value: unknown, max: number, allowEmpty = false) {
  if (
    typeof value !== "string" || value.length > max ||
    (!allowEmpty && !value.trim()) ||
    /[\p{Cc}\p{Cf}]/u.test(value.replaceAll("\n", "").replaceAll("\t", "")) ||
    redactCredentialText(value) !== value
  ) return;
  return value;
}

function settingList(value: unknown) {
  if (
    !Array.isArray(value) || value.length > 128 ||
    !value.every((item) => typeof item === "string" && toolId.test(item))
  ) return;
  return [...new Set<string>(value)].sort();
}

export function parseAgentProfileDefinition(
  value: unknown,
): AgentProfileDefinition | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const fields = value as Record<string, unknown>;
  const {
    name,
    description,
    role,
    prompt,
    wrapupPrompt,
    timeoutWrapupPrompt,
    maxTurns,
    timeoutWrapupTurns,
    tools,
    skills,
  } = fields;
  if (
    Object.keys(fields).some((key) =>
      ![
        "name",
        "description",
        "role",
        "prompt",
        "wrapupPrompt",
        "timeoutWrapupPrompt",
        "maxTurns",
        "timeoutWrapupTurns",
        "tools",
        "skills",
      ].includes(key)
    )
  ) return;
  const parsedName = safeText(name, 128);
  const parsedDescription = safeText(description, 1000, true);
  const parsedPrompt = safeText(prompt, 12000);
  const wrapup = safeText(wrapupPrompt, 4000, true);
  const timeout = safeText(timeoutWrapupPrompt, 4000, true);
  const visibleTools = settingList(tools);
  const visibleSkills = settingList(skills);
  if (
    !parsedName || parsedDescription === undefined || !parsedPrompt ||
    !isAgentProfileId(role) ||
    (wrapupPrompt !== undefined && wrapup === undefined) ||
    (timeoutWrapupPrompt !== undefined && timeout === undefined) ||
    (tools !== undefined && !visibleTools) ||
    (skills !== undefined && !visibleSkills) ||
    (maxTurns !== undefined &&
      (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) ||
        maxTurns < 1 || maxTurns > 32)) ||
    (timeoutWrapupTurns !== undefined &&
      (typeof timeoutWrapupTurns !== "number" ||
        !Number.isInteger(timeoutWrapupTurns) ||
        timeoutWrapupTurns < 1 || timeoutWrapupTurns > 8))
  ) return;

  return {
    name: parsedName,
    description: parsedDescription,
    role,
    prompt: parsedPrompt,
    ...(wrapup !== undefined && { wrapupPrompt: wrapup }),
    ...(timeout !== undefined && { timeoutWrapupPrompt: timeout }),
    ...(typeof maxTurns === "number" && { maxTurns }),
    ...(typeof timeoutWrapupTurns === "number" && { timeoutWrapupTurns }),
    ...(visibleTools && { tools: visibleTools }),
    ...(visibleSkills && { skills: visibleSkills }),
  };
}

export interface AgentProfileMutation {
  readonly id: string;
  readonly expectedVersion: number;
  readonly requestId: string;
  readonly definition: AgentProfileDefinition | null;
}

export function parseAgentProfileMutation(
  value: Record<string, unknown>,
): AgentProfileMutation | undefined {
  const { id, expectedVersion, requestId: request, definition } = value;
  if (
    !isAgentProfileId(id) || typeof request !== "string" ||
    !requestId.test(request) || typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
    expectedVersion >= Number.MAX_SAFE_INTEGER
  ) return;
  const parsed = definition === null
    ? null
    : parseAgentProfileDefinition(definition);
  if (parsed === undefined || (parsed === null && expectedVersion === 0)) {
    return;
  }
  return { id, expectedVersion, requestId: request, definition: parsed };
}

export function previewAgentProfilePrompt(
  template: string,
  values: unknown,
): string | undefined {
  if (
    !safeText(template, 12000) || !values || typeof values !== "object" ||
    Array.isArray(values)
  ) return;
  const variables = new Map<string, string>();
  const entries = Object.entries(values);
  if (entries.length > 32) return;
  for (const [key, value] of entries) {
    const parsed = safeText(value, 1000, true);
    if (!profileId.test(key) || parsed === undefined) return;
    variables.set(key, parsed);
  }
  const rendered = template.replace(
    /\{\{\s*([a-z][a-z0-9_-]{0,63})\s*\}\}/g,
    (original, key: string) => variables.get(key) ?? original,
  );
  return safeText(rendered, 16000);
}

export function openAgentProfiles(baseDir: string) {
  const path = join(baseDir, "agent-profiles.db");
  function useStore<T>(
    fallback: T,
    read: (db: DatabaseSync) => T,
    write = false,
  ) {
    if (!write) {
      try {
        Deno.statSync(path);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return fallback;
        throw error;
      }
    }
    const db = new DatabaseSync(path, { readOnly: !write });
    try {
      db.exec("PRAGMA busy_timeout = 3000");
      if (write) {
        db.exec(`CREATE TABLE IF NOT EXISTS agent_profile_revisions (
          id TEXT NOT NULL, version INTEGER NOT NULL,
          request_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL,
          PRIMARY KEY(id, version)
        )`);
      }
      return read(db);
    } finally {
      db.close();
    }
  }

  function decode(row: Record<string, unknown> | undefined) {
    return row
      ? JSON.parse(String(row.record)) as AgentProfileRevision
      : undefined;
  }

  function latest(db: DatabaseSync, id: string) {
    return decode(
      db.prepare(
        "SELECT record FROM agent_profile_revisions WHERE id = ? ORDER BY version DESC LIMIT 1",
      ).get(id),
    );
  }

  function existing(db: DatabaseSync, mutation: AgentProfileMutation) {
    const old = decode(
      db.prepare(
        "SELECT record FROM agent_profile_revisions WHERE request_id = ?",
      ).get(mutation.requestId),
    );
    if (!old) return;
    return old.id === mutation.id &&
        old.version === mutation.expectedVersion + 1 &&
        JSON.stringify(old.definition) === JSON.stringify(mutation.definition)
      ? old
      : false;
  }

  return {
    read(id: string) {
      return useStore(undefined, (db) => latest(db, id));
    },
    version(id: string, version: number) {
      return useStore(undefined, (db) =>
        decode(
          db.prepare(
            "SELECT record FROM agent_profile_revisions WHERE id = ? AND version = ?",
          ).get(id, version),
        ));
    },
    list() {
      return useStore(
        [] as AgentProfileRevision[],
        (db) =>
          db.prepare(`SELECT current.record FROM agent_profile_revisions current
          WHERE current.version = (SELECT MAX(version) FROM agent_profile_revisions
            WHERE id = current.id)
          ORDER BY current.id LIMIT 512`).all()
            .flatMap((row) => {
              const entry = decode(row);
              return entry?.definition ? [entry] : [];
            }),
      );
    },
    history(id: string, before = Number.MAX_SAFE_INTEGER) {
      return useStore(
        [] as AgentProfileRevision[],
        (db) =>
          db.prepare(
            `SELECT record FROM agent_profile_revisions WHERE id = ? AND version < ?
          ORDER BY version DESC LIMIT 32`,
          ).all(id, before)
            .map((row) => decode(row)!),
      );
    },
    receipt(mutation: AgentProfileMutation) {
      return useStore(undefined, (db) => existing(db, mutation));
    },
    commit(mutation: AgentProfileMutation, operatorSessionId: string) {
      return useStore(undefined, (db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const duplicate = existing(db, mutation);
          if (duplicate !== undefined) {
            db.exec("COMMIT");
            return duplicate || undefined;
          }
          const current = latest(db, mutation.id);
          if (
            (current?.version ?? 0) !== mutation.expectedVersion ||
            (mutation.definition === null && !current?.definition)
          ) {
            db.exec("ROLLBACK");
            return;
          }
          const entry: AgentProfileRevision = {
            id: mutation.id,
            version: mutation.expectedVersion + 1,
            requestId: mutation.requestId,
            definition: mutation.definition,
            operatorSessionId,
            recordedAt: new Date().toISOString(),
          };
          db.prepare("INSERT INTO agent_profile_revisions VALUES (?, ?, ?, ?)")
            .run(
              entry.id,
              entry.version,
              entry.requestId,
              JSON.stringify(entry),
            );
          db.exec("COMMIT");
          return entry;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }, true);
    },
  };
}

export function readAgentProfile(baseDir: string, id: string) {
  if (!isAgentProfileId(id)) return;
  const profile = openAgentProfiles(baseDir).read(id);
  return profile?.definition ? profile : undefined;
}
