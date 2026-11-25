/** Typed restrictions for scheduling defensive assessment work. */
import { createHash } from "node:crypto";
import type { AdaptiveTaskKind } from "./adaptive_store.ts";
import type { loadSentinelGraph } from "./graph.ts";

const supportedKinds = {
  coverage: true,
  defense_coverage: true,
  impact: true,
  trace: true,
  case: true,
  incident_correlation: true,
  review_finding: true,
  report_finding: true,
  review_evidence: true,
  review_incident: true,
  verify_control_coverage: true,
} satisfies Record<AdaptiveTaskKind, true>;

export const sentinelOperatingConstraintKinds = Object.keys(supportedKinds);

type Snapshot = ReturnType<ReturnType<typeof loadSentinelGraph>["snapshot"]>;

export interface SentinelOperatingConstraints {
  readonly deniedKinds: readonly AdaptiveTaskKind[];
  readonly allowedAssetIds?: readonly string[];
  readonly note?: string;
}

export interface SentinelOperatingConstraintUpdate {
  readonly runId: string;
  readonly evidenceRevision: number;
  readonly expectedVersion: number;
  readonly requestId: string;
  readonly operatorScope: string;
  readonly constraints: SentinelOperatingConstraints;
}

export interface SentinelOperatingConstraintRecord
  extends SentinelOperatingConstraintUpdate {
  readonly version: number;
  readonly digest: string;
  readonly recordedAt: string;
}

export function normalizeSentinelOperatingConstraints(
  raw: unknown,
): SentinelOperatingConstraints {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid Sentinel operating constraints");
  }
  const { deniedKinds, allowedAssetIds, note } = raw as Record<string, unknown>;
  if (
    Object.keys(raw).some((key) =>
      !["deniedKinds", "allowedAssetIds", "note"].includes(key)
    ) ||
    !Array.isArray(deniedKinds) ||
    deniedKinds.length > Object.keys(supportedKinds).length ||
    deniedKinds.some((kind) =>
      typeof kind !== "string" || !Object.hasOwn(supportedKinds, kind)
    ) ||
    (allowedAssetIds !== undefined &&
      (!Array.isArray(allowedAssetIds) || allowedAssetIds.length > 128 ||
        allowedAssetIds.some((id) =>
          typeof id !== "string" || !id.trim() || id.length > 512 ||
          id.includes("\0")
        ))) ||
    (note !== undefined &&
      (typeof note !== "string" || !note.trim() || note.length > 1000 ||
        note.includes("\0")))
  ) throw new Error("Invalid Sentinel operating constraints");
  const constraints = {
    deniedKinds: [...new Set(deniedKinds as AdaptiveTaskKind[])].sort(),
    ...(allowedAssetIds !== undefined && {
      allowedAssetIds: [...new Set(allowedAssetIds as string[])].sort(),
    }),
    ...(typeof note === "string" && { note }),
  };
  if (JSON.stringify(constraints).length > 3400) {
    throw new Error(
      "Sentinel operating constraints exceed the serialized limit",
    );
  }
  return constraints;
}

export function digestSentinelOperatingConstraints(
  constraints: SentinelOperatingConstraints,
): string {
  return createHash("sha256").update(
    JSON.stringify(normalizeSentinelOperatingConstraints(constraints)),
  ).digest("hex");
}

/** Require exact published asset IDs when a new restriction is approved. */
export function validateSentinelOperatingConstraintAssets(
  constraints: SentinelOperatingConstraints,
  snapshot: Snapshot | null | undefined,
): boolean {
  if (constraints.allowedAssetIds === undefined) return true;
  const assets = new Set(
    snapshot?.nodes.flatMap(({ id, kind }) => kind === "asset" ? [id] : []),
  );
  return constraints.allowedAssetIds.every((id) => assets.has(id));
}

/** Under an asset boundary, a task must have a provable nonempty exact asset scope. */
export function sentinelOperatingConstraintsAllow(
  constraints: SentinelOperatingConstraints | undefined,
  task: { readonly kind: AdaptiveTaskKind; readonly nodeId?: string },
  snapshot: Snapshot | null | undefined,
): boolean {
  if (!constraints) return true;
  if (constraints.deniedKinds.includes(task.kind)) return false;
  if (constraints.allowedAssetIds === undefined) return true;
  const target = task.nodeId &&
    snapshot?.nodes.find(({ id }) => id === task.nodeId);
  if (!target || !snapshot) return false;
  const allowed = new Set(constraints.allowedAssetIds);
  if (target.kind === "asset") return allowed.has(target.id);
  const affected = new Set<string>();
  const findings = new Set<string>();
  if (target.kind === "finding") findings.add(target.id);
  if (target.kind === "evidence") {
    for (const { from, to, relation } of snapshot.edges) {
      if (from !== target.id) continue;
      if (relation === "observed_on") affected.add(to);
      if (relation === "supports") findings.add(to);
    }
  }
  for (const { from, to, relation } of snapshot.edges) {
    if (relation === "affects" && findings.has(from)) affected.add(to);
  }
  return affected.size > 0 && [...affected].every((id) => allowed.has(id));
}
