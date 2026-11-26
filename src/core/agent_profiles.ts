/** Durable owner-reviewed agent definitions and prompt revisions. */
/// <reference path="./sqlite_types.d.ts" />

import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { redactCredentialText } from "./logger/redactor.ts";
import {
  isSelectedModelProfile,
  type SelectedModelProfile,
} from "./model_profile_selection.ts";

const profileId = /^[a-z][a-z0-9_-]{0,63}$/;
const requestId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const promptVariableName = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const promptPlaceholder = /\{\{\s*\.?([A-Za-z][A-Za-z0-9_-]{0,63})\s*\}\}/g;
const toolId = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/;

export interface AgentAutomaticAdmission {
  readonly enabled: boolean;
  readonly maxConcurrent: number;
}

export interface AgentProfileDefinition {
  readonly name: string;
  readonly description: string;
  readonly role: string;
  readonly prompt: string;
  readonly promptVariables?: Readonly<Record<string, string>>;
  readonly wrapupPrompt?: string;
  readonly timeoutWrapupPrompt?: string;
  readonly maxTurns?: number;
  readonly runSeconds?: number;
  readonly timeoutWrapupTurns?: number;
  readonly tools?: readonly string[];
  readonly skills?: readonly string[];
  readonly automaticAdmission?: AgentAutomaticAdmission;
  readonly modelProfile?: SelectedModelProfile;
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

function automaticAdmission(
  value: unknown,
): AgentAutomaticAdmission | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { enabled, maxConcurrent, ...extra } = value as Record<string, unknown>;
  if (
    Object.keys(extra).length || typeof enabled !== "boolean" ||
    typeof maxConcurrent !== "number" || !Number.isSafeInteger(maxConcurrent) ||
    maxConcurrent < 1 || maxConcurrent > 16
  ) return;
  return { enabled, maxConcurrent };
}

function promptValues(
  value: unknown,
  limit = 32,
): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const entries = Object.entries(value).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  if (entries.length > limit) return;
  const values: [string, string][] = [];
  for (const [name, input] of entries) {
    const parsed = safeText(input, 1000, true);
    if (!promptVariableName.test(name) || parsed === undefined) return;
    values.push([name, parsed]);
  }
  return Object.fromEntries(values);
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
    promptVariables,
    wrapupPrompt,
    timeoutWrapupPrompt,
    maxTurns,
    runSeconds,
    timeoutWrapupTurns,
    tools,
    skills,
    automaticAdmission: admission,
    modelProfile,
  } = fields;
  if (
    Object.keys(fields).some((key) =>
      ![
        "name",
        "description",
        "role",
        "prompt",
        "promptVariables",
        "wrapupPrompt",
        "timeoutWrapupPrompt",
        "maxTurns",
        "runSeconds",
        "timeoutWrapupTurns",
        "tools",
        "skills",
        "automaticAdmission",
        "modelProfile",
      ].includes(key)
    )
  ) return;
  const parsedName = safeText(name, 128);
  const parsedDescription = safeText(description, 1000, true);
  const parsedPrompt = safeText(prompt, 12000);
  const variables = promptValues(promptVariables);
  const wrapup = safeText(wrapupPrompt, 4000, true);
  const timeout = safeText(timeoutWrapupPrompt, 4000, true);
  const visibleTools = settingList(tools);
  const visibleSkills = settingList(skills);
  const reviewedAdmission = automaticAdmission(admission);
  const reviewedModel = isSelectedModelProfile(modelProfile) &&
      (modelProfile.model === undefined || safeText(modelProfile.model, 256))
    ? modelProfile
    : undefined;
  if (
    !parsedName || parsedDescription === undefined || !parsedPrompt ||
    !isAgentProfileId(role) ||
    (promptVariables !== undefined &&
      (!variables || Object.hasOwn(variables, "Now") ||
        previewAgentProfilePrompt(parsedPrompt, {
            ...variables,
            Now: "2000-01-01T00:00:00.000Z",
          }) === undefined)) ||
    (wrapupPrompt !== undefined && wrapup === undefined) ||
    (timeoutWrapupPrompt !== undefined && timeout === undefined) ||
    (tools !== undefined && !visibleTools) ||
    (skills !== undefined && !visibleSkills) ||
    (admission !== undefined && (role !== "reporter" || !reviewedAdmission)) ||
    (modelProfile !== undefined && !reviewedModel) ||
    (maxTurns !== undefined &&
      (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) ||
        maxTurns < 1 || maxTurns > 32)) ||
    (runSeconds !== undefined &&
      (typeof runSeconds !== "number" || !Number.isInteger(runSeconds) ||
        runSeconds < 1 || runSeconds > 900)) ||
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
    ...(variables !== undefined && { promptVariables: variables }),
    ...(wrapup !== undefined && { wrapupPrompt: wrapup }),
    ...(timeout !== undefined && { timeoutWrapupPrompt: timeout }),
    ...(typeof maxTurns === "number" && { maxTurns }),
    ...(typeof runSeconds === "number" && { runSeconds }),
    ...(typeof timeoutWrapupTurns === "number" && { timeoutWrapupTurns }),
    ...(visibleTools && { tools: visibleTools }),
    ...(visibleSkills && { skills: visibleSkills }),
    ...(reviewedAdmission && { automaticAdmission: reviewedAdmission }),
    ...(reviewedModel && { modelProfile: reviewedModel }),
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

/** Preview plain named placeholders without evaluating expressions. */
export function previewAgentProfilePrompt(
  template: string,
  values: unknown,
): string | undefined {
  if (!safeText(template, 12000)) return;
  const variables = promptValues(values, 65);
  if (!variables) return;
  const rendered = template.replace(
    promptPlaceholder,
    (original, name: string) =>
      Object.hasOwn(variables, name) ? variables[name] : original,
  );
  return safeText(rendered, 16000);
}

export function agentProfilePromptVariables(profile: AgentProfileDefinition) {
  const names = new Set([
    ...[...profile.prompt.matchAll(promptPlaceholder)].map((match) => match[1]),
    "Now",
  ]);
  return [...names].sort().map((name) => {
    if (name === "Now") {
      return {
        name,
        source: "runtime",
        description: "Current UTC time when the agent turn is prepared.",
        example: "2000-01-01T00:00:00.000Z",
      };
    }
    const values = profile.promptVariables;
    return values && Object.hasOwn(values, name)
      ? { name, source: "profile", example: values[name] }
      : { name, source: "sample" };
  });
}

export function renderAgentProfilePrompt(
  profile: AgentProfileDefinition,
  samples?: unknown,
): string | undefined {
  const reviewed = profile.promptVariables ?? {};
  const overrides = samples === undefined ? {} : promptValues(samples);
  if (!overrides) return;
  return previewAgentProfilePrompt(profile.prompt, {
    ...reviewed,
    Now: new Date().toISOString(),
    ...overrides,
  });
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
        );
        CREATE TABLE IF NOT EXISTS agent_profile_selections (
          sessionId TEXT PRIMARY KEY, profileId TEXT NOT NULL
        ) STRICT;`);
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
    selectedForSession(
      sessionId: string,
    ): AgentProfileRevision | null | undefined {
      return useStore<AgentProfileRevision | null | undefined>(
        undefined,
        (db) => {
          if (
            !db.prepare(
              "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'agent_profile_selections'",
            ).get()
          ) return;
          const row = db.prepare(
            "SELECT profileId FROM agent_profile_selections WHERE sessionId = ?",
          ).get(sessionId);
          if (!row) return;
          const entry = latest(db, String(row.profileId));
          return entry?.definition ? entry : null;
        },
      );
    },
    selectForSession(sessionId: string, profileId?: string): boolean {
      return useStore(false, (db) => {
        if (profileId === undefined) {
          db.prepare("DELETE FROM agent_profile_selections WHERE sessionId = ?")
            .run(sessionId);
          return true;
        }
        if (!isAgentProfileId(profileId)) return false;
        return db.prepare(`
          INSERT INTO agent_profile_selections (sessionId, profileId)
          SELECT ?, ? WHERE (
            SELECT json_type(record, '$.definition') FROM agent_profile_revisions
            WHERE id = ? ORDER BY version DESC LIMIT 1
          ) = 'object'
          ON CONFLICT(sessionId) DO UPDATE SET profileId = excluded.profileId
        `).run(sessionId, profileId, profileId).changes === 1;
      }, true);
    },
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
