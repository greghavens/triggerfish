/** Operator-reviewed reusable metadata for exact Sentinel linked starts. */

import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { redactCredentialText } from "../core/logger/redactor.ts";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
interface Selector {
  readonly id: string;
  readonly version: number;
}

export function parseAssessmentTemplateSelector(
  raw: unknown,
): Selector | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const { id, version } = raw as Partial<Selector>;
  if (
    typeof id !== "string" || !uuid.test(id) ||
    typeof version !== "number" || !Number.isSafeInteger(version) ||
    version < 1 ||
    Object.keys(raw).length !== 2
  ) return;
  return { id: id.toLowerCase(), version };
}

function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= limit &&
    !/[\p{Cc}\p{Cf}]/u.test(value) && redactCredentialText(value) === value;
}

function open(baseDir: string) {
  const path = join(baseDir, "sentinel-assessment-templates.db");
  try {
    Deno.openSync(path, { createNew: true, write: true, mode: 0o600 }).close();
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  const info = Deno.lstatSync(path);
  if (
    !info.isFile || info.isSymlink || info.nlink !== 1 ||
    ((info.mode ?? 0) & 0o077) !== 0
  ) throw new Error("Invalid assessment template store");
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA trusted_schema = OFF;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS assessment_templates (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        objective TEXT NOT NULL,
        requestId TEXT NOT NULL UNIQUE,
        PRIMARY KEY(id, version)
      ) STRICT;
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function project(row?: Record<string, unknown>) {
  if (
    !row || typeof row.id !== "string" || typeof row.version !== "number" ||
    !text(row.name, 80) || !text(row.description, 160) ||
    !text(row.objective, 500)
  ) return;
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    description: row.description,
    objective: row.objective,
  };
}

function latest(db: DatabaseSync, id: string) {
  return project(
    db.prepare(`
    SELECT * FROM assessment_templates WHERE id = ? ORDER BY version DESC LIMIT 1
  `).get(id),
  );
}

export function readAssessmentTemplate(baseDir: string, selection: Selector) {
  const db = open(baseDir);
  try {
    return project(
      db.prepare(
        "SELECT * FROM assessment_templates WHERE id = ? AND version = ?",
      ).get(selection.id, selection.version),
    );
  } finally {
    db.close();
  }
}

/** Fence template edits against the synchronous exact linked-start transaction. */
export function withCurrentAssessmentTemplate<T>(
  baseDir: string,
  selection: Selector,
  action: () => T,
) {
  const db = open(baseDir);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      return latest(db, selection.id)?.version === selection.version
        ? action()
        : undefined;
    } finally {
      db.exec("ROLLBACK");
    }
  } finally {
    db.close();
  }
}

export async function executeAssessmentTemplates(
  baseDir: string,
  args: Record<string, unknown>,
  authorize: (args: Record<string, unknown>) => Promise<boolean>,
  confirm: (summary: string) => Promise<boolean>,
) {
  if (!await authorize(args)) return;
  const { action, templateId, templateVersion } = args;
  if (action === "assessment_templates") {
    const { offset = 0, limit = 8 } = args;
    if (
      typeof offset !== "number" || !Number.isSafeInteger(offset) ||
      offset < 0 || typeof limit !== "number" || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > 8 || Object.keys(args).some((key) =>
        !["action", "offset", "limit"].includes(key)
      )
    ) {
      return;
    }
    const db = open(baseDir);
    try {
      const rows = db.prepare(`
        SELECT * FROM assessment_templates AS entry
        WHERE version = (SELECT MAX(version) FROM assessment_templates WHERE id = entry.id)
        ORDER BY lower(name), id LIMIT ? OFFSET ?
      `).all(limit + 1, offset);
      return {
        templates: rows.slice(0, limit).map(project).filter((item) =>
          item !== undefined
        ),
        nextOffset: rows.length > limit ? offset + limit : null,
      };
    } finally {
      db.close();
    }
  }
  const { title, childDescription, childGoal, requestId } = args;
  if (
    action !== "set_assessment_template" || typeof templateId !== "string" ||
    !uuid.test(templateId) || typeof requestId !== "string" ||
    !uuid.test(requestId) ||
    typeof templateVersion !== "number" ||
    !Number.isSafeInteger(templateVersion) ||
    templateVersion < 0 || templateVersion >= Number.MAX_SAFE_INTEGER ||
    !text(title, 80) || !text(childDescription, 160) || !text(childGoal, 500) ||
    Object.keys(args).some((key) =>
      ![
        "action",
        "templateId",
        "templateVersion",
        "title",
        "childDescription",
        "childGoal",
        "requestId",
      ].includes(key)
    )
  ) return;
  const proposal = {
    id: templateId.toLowerCase(),
    version: templateVersion + 1,
    name: title,
    description: childDescription,
    objective: childGoal,
  };
  const request = requestId.toLowerCase();
  const db = open(baseDir);
  const prior = () =>
    db.prepare(
      "SELECT * FROM assessment_templates WHERE requestId = ?",
    ).get(request);
  const replay = (row: Record<string, unknown>) => {
    const template = project(row);
    return template && JSON.stringify(template) === JSON.stringify(proposal)
      ? { template }
      : undefined;
  };
  try {
    const priorRequest = prior();
    if (priorRequest) return replay(priorRequest);
    if ((latest(db, proposal.id)?.version ?? 0) !== templateVersion) return;
    if (
      !await confirm(
        `Save this exact Sentinel assessment template version?\n${
          JSON.stringify(proposal)
        }`,
      )
    ) {
      return { declined: true as const };
    }
    if (!await authorize(args)) return;
    db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const existing = prior();
      if (existing) return replay(existing);
      if ((latest(db, proposal.id)?.version ?? 0) !== templateVersion) return;
      db.prepare("INSERT INTO assessment_templates VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          proposal.id,
          proposal.version,
          proposal.name,
          proposal.description,
          proposal.objective,
          request,
        );
      db.exec("COMMIT");
      committed = true;
      return { template: proposal };
    } finally {
      if (!committed) db.exec("ROLLBACK");
    }
  } finally {
    db.close();
  }
}
