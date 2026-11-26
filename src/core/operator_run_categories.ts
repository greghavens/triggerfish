/** Workspace taxonomy for operator run display metadata. */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { redactCredentialText } from "./logger/redactor.ts";

export interface OperatorRunCategory {
  readonly id: string;
  readonly title: string;
  readonly version: number;
}

export type OperatorRunCategorySelection = Pick<
  OperatorRunCategory,
  "id" | "version"
>;

export function parseOperatorRunCategorySelection(
  raw: unknown,
): OperatorRunCategorySelection | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const { id, version } = raw as Partial<OperatorRunCategorySelection>;
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) ||
    typeof version !== "number" || !Number.isSafeInteger(version) ||
    version < 1 ||
    Object.keys(raw).length !== 2
  ) return;
  return { id: id.toLowerCase(), version };
}

export function parseOperatorRunAdmissionCategory(
  raw: unknown,
): OperatorRunCategory | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const { id, version, title } = raw as Partial<OperatorRunCategory>;
  const selection = parseOperatorRunCategorySelection({ id, version });
  if (
    !selection || Object.keys(raw).length !== 3 ||
    typeof title !== "string" || !title || title !== title.trim() ||
    Array.from(title).length > 80 || /[\p{Cc}\p{Cf}]/u.test(title) ||
    redactCredentialText(title) !== title
  ) return;
  return { ...selection, title };
}

/** Resolve the selected category inside the caller's shared run-admission transaction. */
export function readAdmissionRunCategory(
  db: DatabaseSync,
  selected: OperatorRunCategorySelection,
): OperatorRunCategory | undefined {
  const tables = db.prepare(
    "SELECT 1 FROM run_links.sqlite_schema WHERE name = 'run_categories' AND type = 'table'",
  ).get();
  if (!tables) return;
  const row = db.prepare(
    "SELECT title FROM run_links.run_categories WHERE id = ? AND version = ?",
  )
    .get(selected.id, selected.version);
  return parseOperatorRunAdmissionCategory({ ...selected, title: row?.title });
}

/** Bind an admitted run to the already reviewed exact workspace category. */
export function assignAdmissionRunCategory(
  db: DatabaseSync,
  run: CategorizedOperatorRun,
  category: OperatorRunCategory,
) {
  db.prepare("INSERT INTO run_links.run_category_members VALUES (?, ?)")
    .run(runKey(run), category.id);
}

export interface CategorizedOperatorRun {
  readonly kind: "sentinel" | "workflow";
  readonly id: string;
  readonly runId: string;
  readonly revision?: number;
}

export type OperatorRunCategoryChange =
  | { readonly kind: "create"; readonly title: string }
  | {
    readonly kind: "rename";
    readonly categoryId: string;
    readonly version: number;
    readonly title: string;
  }
  | {
    readonly kind: "delete";
    readonly categoryId: string;
    readonly version: number;
  }
  | {
    readonly kind: "assign";
    readonly categoryId?: string;
    readonly version?: number;
    readonly runs: readonly CategorizedOperatorRun[];
  };

function runKey(run: CategorizedOperatorRun): string {
  return JSON.stringify([run.kind, run.id, run.runId]);
}

function titleKey(title: string) {
  return title.normalize("NFKC").toLowerCase();
}

interface CategoryPreview {
  readonly change: OperatorRunCategoryChange;
  readonly category?: OperatorRunCategory;
  readonly previous?: readonly (string | null)[];
  readonly memberCount?: number;
  readonly memberDigest?: string;
}

interface CategoryReceipt {
  readonly requestId: string;
  readonly kind: OperatorRunCategoryChange["kind"];
  readonly category?: OperatorRunCategory;
  readonly categoryId?: string;
  readonly affected: number;
}

export function createOperatorRunCategories(
  db: DatabaseSync,
  transaction: <T>(operation: () => T) => T,
) {
  const available = () =>
    !!db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE name = 'run_categories' AND type = 'table'",
    ).get();

  function category(id: string) {
    return available()
      ? db.prepare("SELECT id, title, version FROM run_categories WHERE id = ?")
        .get(id) as unknown as OperatorRunCategory | undefined
      : undefined;
  }

  function memberCategory(run: CategorizedOperatorRun): string | null {
    if (!available()) return null;
    const row = db.prepare(
      "SELECT categoryId FROM run_category_members WHERE runKey = ?",
    ).get(runKey(run));
    return typeof row?.categoryId === "string" ? row.categoryId : null;
  }

  function preview(
    change: OperatorRunCategoryChange,
  ): CategoryPreview | undefined {
    const selected = change.kind !== "create" && change.categoryId
      ? category(change.categoryId)
      : undefined;
    if (
      change.kind !== "create" && change.categoryId &&
      (!selected || selected.version !== change.version)
    ) return;
    if (change.kind === "create" || change.kind === "rename") {
      const duplicate = available() &&
        db.prepare("SELECT id FROM run_categories WHERE titleKey = ?").get(
          titleKey(change.title),
        );
      if (duplicate && duplicate.id !== selected?.id) return;
    }
    if (change.kind === "assign") {
      return {
        change,
        category: selected,
        previous: change.runs.map(memberCategory),
      };
    }
    if (change.kind === "delete" && selected) {
      const memberKeys = db.prepare(
        "SELECT runKey FROM run_category_members WHERE categoryId = ? ORDER BY runKey",
      ).all(selected.id).map(({ runKey }) => String(runKey));
      return {
        change,
        category: selected,
        memberCount: memberKeys.length,
        memberDigest: createHash("sha256").update(JSON.stringify(memberKeys))
          .digest("hex"),
      };
    }
    return { change, category: selected };
  }

  function initialize() {
    db.exec(`CREATE TABLE IF NOT EXISTS run_categories (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, titleKey TEXT NOT NULL UNIQUE, version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS run_category_members (
      runKey TEXT PRIMARY KEY, categoryId TEXT NOT NULL REFERENCES run_categories(id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS run_category_requests (
      requestId TEXT PRIMARY KEY, change TEXT NOT NULL, receipt TEXT NOT NULL
    ) STRICT;`);
  }

  return {
    list(offset: number, limit: number) {
      return available()
        ? db.prepare(
          "SELECT id, title, version FROM run_categories ORDER BY titleKey LIMIT ? OFFSET ?",
        ).all(limit, offset) as unknown as OperatorRunCategory[]
        : [];
    },
    atVersion(selected: OperatorRunCategorySelection) {
      const current = category(selected.id);
      return current?.version === selected.version
        ? parseOperatorRunAdmissionCategory(current)
        : undefined;
    },
    forRun(run: CategorizedOperatorRun) {
      const id = memberCategory(run);
      return id ? category(id) : undefined;
    },
    review(
      requestId: string,
      change: OperatorRunCategoryChange,
      approved?: CategoryPreview,
    ): { preview?: CategoryPreview; receipt?: CategoryReceipt } | undefined {
      return transaction(() => {
        if (available()) {
          const prior = db.prepare(
            "SELECT change, receipt FROM run_category_requests WHERE requestId = ?",
          ).get(requestId);
          if (prior) {
            return isDeepStrictEqual(JSON.parse(String(prior.change)), change)
              ? {
                receipt: JSON.parse(String(prior.receipt)) as CategoryReceipt,
              }
              : undefined;
          }
        }
        const proposed = preview(change);
        if (!proposed || (approved && !isDeepStrictEqual(proposed, approved))) {
          return;
        }
        if (!approved) return { preview: proposed };
        initialize();
        if (
          Number(
            db.prepare("SELECT COUNT(*) AS count FROM run_category_requests")
              .get()?.count,
          ) >= 4096
        ) return;
        let receipt: CategoryReceipt;
        if (change.kind === "create") {
          if (
            Number(
              db.prepare("SELECT COUNT(*) AS count FROM run_categories").get()
                ?.count,
            ) >= 128
          ) return;
          const category = { id: requestId, title: change.title, version: 1 };
          db.prepare("INSERT INTO run_categories VALUES (?, ?, ?, 1)")
            .run(category.id, category.title, titleKey(category.title));
          receipt = { requestId, kind: change.kind, category, affected: 0 };
        } else if (change.kind === "rename") {
          const category = {
            id: change.categoryId,
            title: change.title,
            version: change.version + 1,
          };
          db.prepare(
            "UPDATE run_categories SET title = ?, titleKey = ?, version = ? WHERE id = ?",
          )
            .run(
              category.title,
              titleKey(category.title),
              category.version,
              category.id,
            );
          receipt = { requestId, kind: change.kind, category, affected: 0 };
        } else if (change.kind === "delete") {
          const affected = Number(
            db.prepare("DELETE FROM run_category_members WHERE categoryId = ?")
              .run(change.categoryId).changes,
          );
          db.prepare("DELETE FROM run_categories WHERE id = ?").run(
            change.categoryId,
          );
          receipt = {
            requestId,
            kind: change.kind,
            categoryId: change.categoryId,
            affected,
          };
        } else {
          const update = change.categoryId
            ? db.prepare(`INSERT INTO run_category_members VALUES (?, ?)
              ON CONFLICT(runKey) DO UPDATE SET categoryId = excluded.categoryId`)
            : db.prepare("DELETE FROM run_category_members WHERE runKey = ?");
          let affected = 0;
          for (const [index, run] of change.runs.entries()) {
            if (
              (proposed.previous?.[index] ?? null) ===
                (change.categoryId ?? null)
            ) continue;
            affected += Number(
              (change.categoryId
                ? update.run(runKey(run), change.categoryId)
                : update.run(runKey(run))).changes,
            );
          }
          receipt = {
            requestId,
            kind: change.kind,
            category: proposed.category,
            affected,
          };
        }
        db.prepare("INSERT INTO run_category_requests VALUES (?, ?, ?)")
          .run(requestId, JSON.stringify(change), JSON.stringify(receipt));
        return { receipt };
      });
    },
  };
}
