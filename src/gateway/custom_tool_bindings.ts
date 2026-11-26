/** Owner-staged, declarative aliases for local read-only Triggerfish diagnostics. */
/// <reference path="../core/sqlite_types.d.ts" />

import { join } from "@std/path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  customToolManageName,
  isCustomToolName,
  parseCustomToolMutation,
} from "../core/custom_tool_intent.ts";
import { isRealPathWithinJail } from "../core/security/path_jail.ts";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../core/types/tool.ts";

interface Binding {
  readonly name: string;
  readonly component: "providers" | "config";
  readonly cronJobId?: string;
}

export const customToolManage: ToolDefinition = {
  name: customToolManageName,
  description:
    "Review an exact operator-staged diagnostic binding with inspect, list active bindings, or request approval to test or apply the reviewed revision. Testing does not register the tool. Read status for an active revision to retire.",
  parameters: {
    action: {
      type: "string",
      description: "Management operation",
      enum: ["list", "inspect", "test", "apply", "status", "retire"],
      required: true,
    },
    name: { type: "string", description: "Exact staged custom tool name." },
    revision: {
      type: "string",
      description:
        "Revision returned by inspect for test or apply, or status for retire.",
    },
  },
};

function parseBinding(raw: unknown): Binding | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const { name, component, cronJobId } = raw as Record<string, unknown>;
  if (
    Object.keys(raw).length === (cronJobId === undefined ? 2 : 3) &&
    isCustomToolName(name) &&
    (component === "providers" || component === "config") &&
    (cronJobId === undefined ||
      (typeof cronJobId === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(cronJobId)))
  ) {
    return { name, component, ...(cronJobId && { cronJobId }) };
  }
}

function storedBinding(row: Record<string, unknown> | undefined) {
  if (!row) return;
  const { name, component, cronJobId } = row;
  return parseBinding({
    name,
    component,
    ...(cronJobId !== null && { cronJobId }),
  });
}

function privateFile(path: string) {
  const info = Deno.lstatSync(path);
  return info.isFile && !info.isSymlink && (info.nlink ?? 1) === 1 &&
    ((info.mode ?? 0) & 0o077) === 0;
}

export function createCustomToolBindings(baseDir: string) {
  const proposalRoot = join(baseDir, "custom-tool-proposals");
  const databasePath = join(baseDir, "custom-tools.db");

  function readProposal(name: string) {
    const path = join(proposalRoot, name + ".json");
    try {
      const root = Deno.lstatSync(proposalRoot);
      if (
        !root.isDirectory || ((root.mode ?? 0) & 0o022) !== 0 ||
        !privateFile(path) || !isRealPathWithinJail(path, proposalRoot) ||
        Deno.statSync(path).size > 4096
      ) return;
      const source = Deno.readTextFileSync(path);
      if (source.length > 4096) return;
      const binding = parseBinding(JSON.parse(source));
      if (binding?.name !== name) return;
      return { binding, source };
    } catch {
      return undefined;
    }
  }

  function withStore<T>(action: (db: DatabaseSync) => T): T {
    const directory = Deno.lstatSync(baseDir);
    if (!directory.isDirectory || ((directory.mode ?? 0) & 0o022) !== 0) {
      throw new Error("The custom tool directory is not private.");
    }
    try {
      Deno.openSync(databasePath, { createNew: true, write: true, mode: 0o600 })
        .close();
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
    if (!privateFile(databasePath)) {
      throw new Error("The custom tool registry is not private.");
    }
    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000;");
      db.exec(
        "CREATE TABLE IF NOT EXISTS custom_tools (name TEXT PRIMARY KEY, component TEXT NOT NULL, revision TEXT NOT NULL, approval_id TEXT NOT NULL)",
      );
      db.exec(
        "CREATE TABLE IF NOT EXISTS retired_custom_tools (name TEXT PRIMARY KEY, revision TEXT NOT NULL, approval_id TEXT NOT NULL)",
      );
      db.exec(
        "CREATE TABLE IF NOT EXISTS custom_tool_cron_grants (name TEXT PRIMARY KEY, job_id TEXT NOT NULL)",
      );
      return action(db);
    } finally {
      db.close();
    }
  }

  function currentRevision(db: DatabaseSync, name: string) {
    const active = db.prepare(
      "SELECT revision FROM custom_tools WHERE name = ?",
    ).get(name);
    if (typeof active?.revision === "string") {
      return { revision: active.revision, retired: false };
    }
    const retired = db.prepare(
      "SELECT revision FROM retired_custom_tools WHERE name = ?",
    ).get(name);
    if (typeof retired?.revision === "string") {
      return { revision: retired.revision, retired: true };
    }
  }

  function review(db: DatabaseSync, name: string) {
    const proposal = readProposal(name);
    if (!proposal) return;
    const current = currentRevision(db, name);
    const revision = createHash("sha256").update(JSON.stringify([
      name,
      current?.revision ?? null,
      proposal.source,
    ])).digest("hex");
    return {
      binding: proposal.binding,
      revision,
      replacing: current?.retired === false,
    };
  }

  const bindingQuery = `
    SELECT tool.name, tool.component, tool.revision, grant.job_id AS cronJobId
    FROM custom_tools AS tool
    LEFT JOIN custom_tool_cron_grants AS grant ON grant.name = tool.name
  `;

  function active(cronJobId?: string) {
    return withStore((db) =>
      db.prepare(bindingQuery + " ORDER BY tool.name LIMIT 64").all()
        .flatMap((row) => {
          const binding = storedBinding(row);
          return binding &&
              (cronJobId === undefined || binding.cronJobId === cronJobId)
            ? [binding]
            : [];
        })
    );
  }

  function read(name: string, cronJobId?: string) {
    if (!isCustomToolName(name)) return;
    try {
      if (!privateFile(databasePath)) return;
      const row = withStore((db) =>
        db.prepare(bindingQuery + " WHERE tool.name = ?").get(name)
      );
      const binding = storedBinding(row);
      if (
        !binding || !row || typeof row.revision !== "string" ||
        (cronJobId !== undefined && binding.cronJobId !== cronJobId)
      ) return;
      return { ...binding, revision: row.revision };
    } catch {
      return undefined;
    }
  }

  return {
    read,
    reviewedDiagnostic(
      args: Record<string, unknown>,
      context?: ToolExecutionContext,
    ) {
      const selected = parseCustomToolMutation(customToolManageName, args);
      if (
        selected?.action !== "test" || !context?.toolApprovalRequestId ||
        !context.isCurrentInteractiveOwner?.()
      ) return;
      try {
        const current = withStore((db) => review(db, selected.name));
        if (current?.revision === selected.revision) return current.binding;
      } catch {
        return;
      }
    },
    definitions(cronJobId?: string): ToolDefinition[] {
      try {
        if (!privateFile(databasePath)) return [];
        return active(cronJobId).map(({ name, component }) => ({
          name,
          description:
            `Read the approved Triggerfish ${component} health diagnostic.`,
          parameters: {},
        }));
      } catch {
        return [];
      }
    },
    manage(
      args: Record<string, unknown>,
      context?: ToolExecutionContext,
    ): string {
      const owner = context?.isCurrentInteractiveOwner;
      if (!owner?.()) return "Error: Custom tools require the active owner.";
      const { action, name } = args;
      const mutation = parseCustomToolMutation(customToolManageName, args);
      try {
        if (action === "list" && Object.keys(args).length === 1) {
          return JSON.stringify({
            bindings: active(),
            _classification: "INTERNAL",
          });
        }
        if (
          action === "inspect" && isCustomToolName(name) &&
          Object.keys(args).length === 2
        ) {
          const selected = withStore((db) => review(db, name));
          return selected
            ? JSON.stringify({ ...selected, _classification: "INTERNAL" })
            : "Error: The operator proposal is unavailable.";
        }
        if (
          action === "status" && isCustomToolName(name) &&
          Object.keys(args).length === 2
        ) {
          const status = withStore((db) => currentRevision(db, name));
          return status
            ? JSON.stringify({ name, ...status, _classification: "INTERNAL" })
            : "Error: The custom tool binding is unavailable.";
        }
        const approval = context?.toolApprovalRequestId;
        if (!mutation || mutation.action === "test" || !approval) {
          return "Error: Custom tool changes require the exact reviewed revision and owner approval.";
        }
        return withStore((db) => {
          db.exec("BEGIN IMMEDIATE");
          let committed = false;
          try {
            const current = currentRevision(db, mutation.name);
            if (mutation.action === "retire") {
              if (
                !owner() || !current || current.retired ||
                current.revision !== mutation.revision
              ) {
                return "Error: The active binding revision changed before retirement.";
              }
              const revision = createHash("sha256").update(JSON.stringify([
                "retire",
                mutation.name,
                current.revision,
                approval,
              ])).digest("hex");
              db.prepare("INSERT INTO retired_custom_tools VALUES (?, ?, ?)")
                .run(mutation.name, revision, approval);
              db.prepare("DELETE FROM custom_tools WHERE name = ?").run(
                mutation.name,
              );
              db.prepare("DELETE FROM custom_tool_cron_grants WHERE name = ?")
                .run(mutation.name);
              db.exec("COMMIT");
              committed = true;
              return JSON.stringify({
                name: mutation.name,
                retired: true,
                revision,
                approvalRequestId: approval,
                _classification: "INTERNAL",
              });
            }
            const selected = review(db, mutation.name);
            if (
              !owner() || !selected || selected.revision !== mutation.revision
            ) {
              return "Error: The reviewed binding or proposal changed before approval.";
            }
            if (
              !selected.replacing &&
              Number(
                  db.prepare(
                    "SELECT COUNT(*) AS n FROM custom_tools",
                  ).get()?.n,
                ) >= 64
            ) {
              return "Error: The custom tool registry is full.";
            }
            db.prepare(
              "INSERT INTO custom_tools VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET component=excluded.component, revision=excluded.revision, approval_id=excluded.approval_id",
            ).run(
              mutation.name,
              selected.binding.component,
              selected.revision,
              approval,
            );
            if (selected.binding.cronJobId) {
              db.prepare(`
                INSERT INTO custom_tool_cron_grants VALUES (?, ?)
                ON CONFLICT(name) DO UPDATE SET job_id=excluded.job_id
              `).run(mutation.name, selected.binding.cronJobId);
            } else {
              db.prepare("DELETE FROM custom_tool_cron_grants WHERE name = ?")
                .run(mutation.name);
            }
            if (current?.retired) {
              db.prepare("DELETE FROM retired_custom_tools WHERE name = ?").run(
                mutation.name,
              );
            }
            db.exec("COMMIT");
            committed = true;
            return JSON.stringify({
              ...selected,
              approvalRequestId: approval,
              _classification: "INTERNAL",
            });
          } finally {
            if (!committed) db.exec("ROLLBACK");
          }
        });
      } catch {
        return "Error: The custom tool registry is unavailable.";
      }
    },
  };
}
