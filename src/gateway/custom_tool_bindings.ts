/** Owner-staged, declarative aliases for local read-only Triggerfish diagnostics. */
/// <reference path="../core/sqlite_types.d.ts" />

import { join } from "@std/path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  customToolManageName,
  isCustomToolName,
  parseCustomToolApply,
} from "../core/custom_tool_intent.ts";
import { isRealPathWithinJail } from "../core/security/path_jail.ts";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "../core/types/tool.ts";

interface Binding {
  readonly name: string;
  readonly component: "providers" | "config";
}

export const customToolManage: ToolDefinition = {
  name: customToolManageName,
  description:
    "Review an exact operator-staged diagnostic binding with inspect, list active bindings, or request approval to apply the reviewed revision.",
  parameters: {
    action: {
      type: "string",
      description: "Management operation",
      enum: ["list", "inspect", "apply"],
      required: true,
    },
    name: { type: "string", description: "Exact staged custom tool name." },
    revision: {
      type: "string",
      description: "Revision returned by inspect. Required for apply.",
    },
  },
};

function parseBinding(raw: unknown): Binding | undefined {
  if (
    !raw || typeof raw !== "object" || Array.isArray(raw) ||
    Object.keys(raw).length !== 2
  ) return;
  const { name, component } = raw as Record<string, unknown>;
  if (
    isCustomToolName(name) &&
    (component === "providers" || component === "config")
  ) {
    return { name, component };
  }
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
      return action(db);
    } finally {
      db.close();
    }
  }

  function review(db: DatabaseSync, name: string) {
    const proposal = readProposal(name);
    if (!proposal) return;
    const current = db.prepare(
      "SELECT revision FROM custom_tools WHERE name = ?",
    ).get(name);
    const revision = createHash("sha256").update(JSON.stringify([
      name,
      current?.revision ?? null,
      proposal.source,
    ])).digest("hex");
    return { binding: proposal.binding, revision, replacing: !!current };
  }

  function active() {
    return withStore((db) =>
      db.prepare(
        "SELECT name, component FROM custom_tools ORDER BY name LIMIT 64",
      ).all()
        .flatMap((row) => {
          const binding = parseBinding(row);
          return binding ? [binding] : [];
        })
    );
  }

  function read(name: string) {
    if (!isCustomToolName(name)) return;
    try {
      if (!privateFile(databasePath)) return;
      const row = withStore((db) =>
        db.prepare("SELECT name, component FROM custom_tools WHERE name = ?")
          .get(name)
      );
      return parseBinding(row);
    } catch {
      return undefined;
    }
  }

  return {
    read,
    definitions(): ToolDefinition[] {
      try {
        if (!privateFile(databasePath)) return [];
        return active().map(({ name, component }) => ({
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
      const apply = parseCustomToolApply(customToolManageName, args);
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
        const approval = context?.toolApprovalRequestId;
        if (!apply || !approval) {
          return "Error: Apply requires the exact reviewed proposal and owner approval.";
        }
        return withStore((db) => {
          db.exec("BEGIN IMMEDIATE");
          let committed = false;
          try {
            const selected = review(db, apply.name);
            if (!owner() || !selected || selected.revision !== apply.revision) {
              return "Error: The reviewed binding or proposal changed before approval.";
            }
            if (
              !selected.replacing &&
              Number(
                  db.prepare("SELECT COUNT(*) AS n FROM custom_tools").get()?.n,
                ) >= 64
            ) {
              return "Error: The custom tool registry is full.";
            }
            db.prepare(
              "INSERT INTO custom_tools VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET component=excluded.component, revision=excluded.revision, approval_id=excluded.approval_id",
            ).run(
              apply.name,
              selected.binding.component,
              selected.revision,
              approval,
            );
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
