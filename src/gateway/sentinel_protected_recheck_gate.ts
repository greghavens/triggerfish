/** Authorize an exact protected recheck before it can satisfy a queued gate. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { AdaptiveTask } from "../sentinel/adaptive_store.ts";
import type { SentinelRepositoryVisibilityReference } from "../sentinel/github_repository_visibility.ts";
import { readSentinelCaseFindingReceipts } from "../sentinel/worker_finding_store.ts";
import { readExactSentinelNativeRepositoryVerdict } from "./sentinel_native_repository_recheck.ts";

export function readProtectedPassingRecheck(
  path: string,
  runId: string,
  revision: number,
  task: AdaptiveTask,
  verdictId: string,
) {
  const round = task.plannerRound;
  if (
    task.kind !== "trace" || task.depth !== 1 || !task.nodeId ||
    !round || (!round.passingRecheckId && !round.passingRecheckForFindingId)
  ) return;
  const proof = readExactSentinelNativeRepositoryVerdict(
    path,
    runId,
    revision,
    task.nodeId,
    verdictId,
  );
  if (
    !proof || proof.verdict.outcome !== "pass" ||
    proof.reference.taskId === task.id ||
    (round.passingRecheckId
      ? round.passingRecheckId !== verdictId
      : round.passingRecheckForFindingId !== proof.verdict.findingId)
  ) return;
  const receipt = readSentinelCaseFindingReceipts(path, [verdictId]).get(
    verdictId,
  );
  if (
    receipt?.kind !== "recheck" ||
    !isDeepStrictEqual(receipt.nativeRepositoryVisibility, proof.source)
  ) return;
  return {
    receipt,
    reference: proof.reference,
    receiptSha256: createHash("sha256").update(JSON.stringify(receipt)).digest(
      "hex",
    ),
  };
}

type ProtectedPassingRecheck = NonNullable<
  ReturnType<typeof readProtectedPassingRecheck>
>;

/** The returned proof lasts for one immediate scheduler transition. */
export async function authorizeProtectedPassingRecheck(
  read: () => ProtectedPassingRecheck | undefined,
  authorize: (
    reference: SentinelRepositoryVisibilityReference,
    current: () => boolean,
  ) => Promise<boolean>,
  eligible: () => boolean,
) {
  const proof = eligible() ? read() : undefined;
  if (!proof) return;
  if (
    await authorize(proof.reference, eligible) && eligible() &&
    isDeepStrictEqual(read(), proof)
  ) return proof;
}

/** Select only explicitly settled protected gates among this task's ancestors. */
export function protectedGateAncestors(
  task: AdaptiveTask,
  tasks: ReadonlyMap<string, AdaptiveTask>,
) {
  const dependencies = new Set(task.prerequisites);
  const gates = [];
  for (const id of dependencies) {
    const gate = tasks.get(id);
    const verdictId = gate?.factSatisfaction?.protectedRepositoryVerdict
      ?.verdictId;
    if (gate?.status === "completed" && verdictId) {
      gates.push({ gate, verdictId });
    }
    for (const ancestor of gate?.prerequisites ?? []) {
      dependencies.add(ancestor);
    }
  }
  return gates;
}
