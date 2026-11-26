import { parseSentinelTemplateToolRules } from "../sentinel/assessment_store.ts";
import {
  parseOperatorRunAdmissionCategory,
  parseOperatorRunCategorySelection,
  readAdmissionRunCategory,
} from "../core/operator_run_categories.ts";
import {
  openOperatorRunLinkStore,
  withOperatorRunLinks,
} from "../core/operator_runs.ts";
import { isDeepStrictEqual } from "node:util";
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
        category TEXT,
        interceptRules TEXT,
        PRIMARY KEY(id, version)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS assessment_template_withdrawals (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        requestId TEXT NOT NULL UNIQUE,
        at TEXT NOT NULL
      ) STRICT;
    `);
    const hasColumn = (column: string) =>
      db.prepare(
        "PRAGMA table_info(assessment_templates)",
      ).all().some(({ name }) => name === column);
    for (const column of ["category", "interceptRules"] as const) {
      if (hasColumn(column)) continue;
      db.exec("BEGIN IMMEDIATE");
      try {
        if (!hasColumn(column)) {
          db.exec(`ALTER TABLE assessment_templates ADD COLUMN ${column} TEXT`);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
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
  const category = typeof row.category === "string"
    ? parseOperatorRunAdmissionCategory(JSON.parse(row.category))
    : undefined;
  if (row.category != null && !category) return;
  const interceptRules = typeof row.interceptRules === "string"
    ? parseSentinelTemplateToolRules(JSON.parse(row.interceptRules))
    : undefined;
  if (row.interceptRules != null && !interceptRules) return;
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    description: row.description,
    objective: row.objective,
    ...(category && { category }),
    ...(interceptRules && { interceptRules }),
  };
}

function latest(db: DatabaseSync, id: string) {
  return project(
    db.prepare(`
    SELECT * FROM assessment_templates WHERE id = ? ORDER BY version DESC LIMIT 1
  `).get(id),
  );
}

function withdrawn(db: DatabaseSync, id: string) {
  return !!db.prepare(
    "SELECT 1 FROM assessment_template_withdrawals WHERE id = ?",
  ).get(id);
}

function writeRequestExists(db: DatabaseSync, requestId: string) {
  return !!db.prepare("SELECT 1 FROM assessment_templates WHERE requestId = ?")
    .get(requestId);
}

async function withdrawTemplate(
  baseDir: string,
  args: Record<string, unknown>,
  authorize: (args: Record<string, unknown>) => Promise<boolean>,
  confirm: (summary: string) => Promise<boolean>,
) {
  const selector = parseAssessmentTemplateSelector({
    id: args.templateId,
    version: args.templateVersion,
  });
  if (
    !selector || typeof args.requestId !== "string" ||
    !uuid.test(args.requestId) ||
    Object.keys(args).some((key) =>
      !["action", "templateId", "templateVersion", "requestId"].includes(key)
    )
  ) return;
  const { id, version } = selector;
  const requestId = args.requestId.toLowerCase();
  const db = open(baseDir);
  const prior = () =>
    db.prepare(
      "SELECT * FROM assessment_template_withdrawals WHERE requestId = ?",
    ).get(requestId);
  const exactReceipt = (row: NonNullable<ReturnType<typeof prior>>) =>
    row.id === id && row.version === version && typeof row.at === "string"
      ? { withdrawal: { id, version, requestId, at: row.at } }
      : undefined;
  try {
    const priorRequest = prior();
    if (priorRequest) return exactReceipt(priorRequest);
    const template = latest(db, id);
    if (
      template?.version !== version || withdrawn(db, id) ||
      writeRequestExists(db, requestId)
    ) return;
    if (
      !await confirm(
        `Withdraw this exact Sentinel template from future starts?
${JSON.stringify({ requestId, template })}`,
      )
    ) return { declined: true as const };
    if (!await authorize(args)) return;
    db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      const existing = prior();
      if (existing) return exactReceipt(existing);
      if (
        latest(db, id)?.version !== version || withdrawn(db, id) ||
        writeRequestExists(db, requestId)
      ) return;
      const at = new Date().toISOString();
      db.prepare(
        "INSERT INTO assessment_template_withdrawals VALUES (?, ?, ?, ?)",
      )
        .run(id, version, requestId, at);
      db.exec("COMMIT");
      committed = true;
      return { withdrawal: { id, version, requestId, at } };
    } finally {
      if (!committed) db.exec("ROLLBACK");
    }
  } finally {
    db.close();
  }
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

/** Fence template edits while the caller validates or admits the exact selection. */
export function withAssessmentTemplateVersion<T>(
  baseDir: string,
  selection: Selector,
  action: (current: boolean) => T,
) {
  const db = open(baseDir);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      return action(
        latest(db, selection.id)?.version === selection.version &&
          !withdrawn(db, selection.id),
      );
    } finally {
      db.exec("ROLLBACK");
    }
  } finally {
    db.close();
  }
}

export function withCurrentAssessmentTemplate<T>(
  baseDir: string,
  selection: Selector,
  action: () => T,
) {
  return withAssessmentTemplateVersion(
    baseDir,
    selection,
    (current) => current ? action() : undefined,
  );
}

export async function executeAssessmentTemplates(
  baseDir: string,
  args: Record<string, unknown>,
  authorize: (args: Record<string, unknown>) => Promise<boolean>,
  confirm: (summary: string) => Promise<boolean>,
) {
  if (!await authorize(args)) return;
  const { action, templateId, templateVersion } = args;
  if (action === "withdraw_assessment_template") {
    return await withdrawTemplate(baseDir, args, authorize, confirm);
  }
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
          AND NOT EXISTS (SELECT 1 FROM assessment_template_withdrawals WHERE id = entry.id)
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
  const selectedCategory = parseOperatorRunCategorySelection(args.category);
  if (args.category !== undefined && !selectedCategory) return;
  const interceptRules = parseSentinelTemplateToolRules(args.interceptRules);
  if (args.interceptRules !== undefined && !interceptRules) return;
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
        "category",
        "interceptRules",
      ].includes(key)
    )
  ) return;
  const proposal = {
    id: templateId.toLowerCase(),
    version: templateVersion + 1,
    name: title,
    description: childDescription,
    objective: childGoal,
    ...(interceptRules && { interceptRules }),
  };
  const request = requestId.toLowerCase();
  const db = open(baseDir);
  const blocked = () =>
    withdrawn(db, proposal.id) || db.prepare(
      "SELECT 1 FROM assessment_template_withdrawals WHERE requestId = ?",
    ).get(request);
  const prior = () =>
    db.prepare(
      "SELECT * FROM assessment_templates WHERE requestId = ?",
    ).get(request);
  const replay = (row: Record<string, unknown>) => {
    const stored = project(row);
    if (!stored) return;
    const { category, ...metadata } = stored;
    const sameSelection = category
      ? category.id === selectedCategory?.id &&
        category.version === selectedCategory.version
      : selectedCategory === undefined;
    return sameSelection && isDeepStrictEqual(metadata, proposal)
      ? { template: stored }
      : undefined;
  };
  try {
    const priorRequest = prior();
    if (priorRequest) return replay(priorRequest);
    if (
      blocked() || (latest(db, proposal.id)?.version ?? 0) !== templateVersion
    ) return;
    const linkPath = selectedCategory && join(baseDir, "operator-run-links.db");
    const category = (() => {
      if (!linkPath || !selectedCategory) return;
      const links = openOperatorRunLinkStore(linkPath);
      try {
        return links.categories.atVersion(selectedCategory);
      } finally {
        links.close();
      }
    })();
    if (selectedCategory && !category) return;
    const reviewed = { ...proposal, ...(category && { category }) };
    if (
      !await confirm(
        `Save this exact Sentinel assessment template version?\n${
          JSON.stringify(reviewed)
        }`,
      )
    ) {
      return { declined: true as const };
    }
    if (!await authorize(args)) return;
    return withOperatorRunLinks(db, linkPath, () => {
      db.exec("BEGIN IMMEDIATE");
      let committed = false;
      try {
        const existing = prior();
        if (existing) return replay(existing);
        if (
          blocked() ||
          (latest(db, proposal.id)?.version ?? 0) !== templateVersion
        ) return;
        if (
          selectedCategory &&
          !isDeepStrictEqual(
            readAdmissionRunCategory(db, selectedCategory),
            category,
          )
        ) return;
        db.prepare(`
          INSERT INTO assessment_templates (id, version, name, description, objective, requestId, category, interceptRules)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          proposal.id,
          proposal.version,
          proposal.name,
          proposal.description,
          proposal.objective,
          request,
          category ? JSON.stringify(category) : null,
          interceptRules ? JSON.stringify(interceptRules) : null,
        );
        db.exec("COMMIT");
        committed = true;
        return { template: reviewed };
      } finally {
        if (!committed) db.exec("ROLLBACK");
      }
    });
  } finally {
    db.close();
  }
}
