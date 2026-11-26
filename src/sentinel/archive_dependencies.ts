import { DatabaseSync } from "node:sqlite";
import { isSentinelCaseId } from "./cases.ts";
import { parseSentinelLinkedCaseSources } from "./linked_case_sources.ts";

export interface ArchiveDependency {
  readonly kind: string;
  readonly id: string;
  readonly revision?: number;
  readonly runId?: string;
}

export function readRunArchivePlanDependencies(
  path: string,
): ArchiveDependency[] | undefined {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA trusted_schema = OFF");
    const row = db.prepare("SELECT plan FROM assessment WHERE id = 1")
      .get();
    if (typeof row?.plan !== "string") return;
    const plan = JSON.parse(row.plan);
    const linked = parseSentinelLinkedCaseSources(plan.linkedCaseSources);
    if (plan.linkedCaseSources !== undefined && !linked) return;
    const parent: ArchiveDependency | undefined = plan.spawnParent;
    if (
      parent !== undefined && (
        !parent || typeof parent !== "object" ||
        !["sentinel", "workflow", "delegated", "scheduled"].includes(
          parent.kind,
        ) ||
        typeof parent.id !== "string" || !parent.id ||
        (parent.kind === "sentinel" && (
          !isSentinelCaseId(parent.id) || typeof parent.revision !== "number" ||
          !Number.isSafeInteger(parent.revision) || parent.revision < 1 ||
          (parent.runId !== undefined && typeof parent.runId !== "string")
        ))
      )
    ) return;
    return [
      ...(parent ? [parent] : []),
      ...(linked ?? []).map(({ caseId, revision, runId }) => ({
        kind: "sentinel",
        id: caseId,
        revision,
        runId,
      })),
    ];
  } finally {
    db.close();
  }
}
