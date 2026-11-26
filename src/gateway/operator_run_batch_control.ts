/** Apply one reviewed pause or resume to exact authorized runs. */
import {
  type openOperatorRunLinkStore,
  type OperatorRunBatchItem,
  type OperatorRunBatchRequest,
  type OperatorRunBatchTarget,
  type OperatorRunController,
  type OperatorRunSummary,
} from "../core/operator_runs.ts";
import { canFlowTo } from "../core/types/classification.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";

interface OperatorRunBatchOptions {
  readonly request: OperatorRunBatchRequest;
  readonly controller: OperatorRunController;
  readonly journal: ReturnType<typeof openOperatorRunLinkStore>;
  readonly ceiling: ClassificationLevel;
  readonly confirm: (message: string) => Promise<boolean>;
}

export async function applyOperatorRunBatch(
  { request, controller, journal, ceiling, confirm }: OperatorRunBatchOptions,
) {
  const wanted = request.action === "pause" ? "paused" : "running";
  const before = request.action === "pause" ? "running" : "paused";
  function authorizedRun(
    run: OperatorRunSummary | undefined,
    target: OperatorRunBatchTarget,
  ) {
    return run && canFlowTo(run.classification ?? "INTERNAL", ceiling) &&
        (target.ref.kind === "workflow" || run.details?.runId === target.runId)
      ? run
      : undefined;
  }
  async function inspect(target: OperatorRunBatchTarget, keepRevision = true) {
    try {
      return authorizedRun(
        await controller.inspect(
          keepRevision ? target.ref : { ...target.ref, revision: undefined },
        ),
        target,
      );
    } catch {
      return undefined;
    }
  }
  let receipt = journal.readBatch(request);
  if (!receipt) {
    const items = await Promise.all(request.targets.map(
      async (target): Promise<OperatorRunBatchItem> => {
        const status = (await inspect(target))?.status;
        return {
          ...target,
          status: status === before
            ? "approved"
            : status === wanted
            ? "unchanged"
            : "unavailable",
        };
      },
    ));
    if (!items.some(({ status }) => status === "approved")) return { items };
    if (
      !await confirm(
        `Confirm this exact run ${request.action} batch?\n${
          JSON.stringify({
            requestId: request.requestId,
            action: request.action,
            items,
          })
        }`,
      )
    ) return { declined: true };
    receipt = journal.approveBatch(request, items);
  }
  for (const [index, item] of receipt.items.entries()) {
    if (item.status === "pending") {
      // A prior process may have applied the transition. Observe current
      // authorized state, and never send the uncertain operation again.
      const settled = await inspect(item, false);
      if (settled?.status === wanted) {
        journal.updateBatchItem(
          request,
          index,
          "pending",
          "observed",
          settled.ref,
        );
      }
      continue;
    }
    if (item.status !== "approved") continue;
    const checked = await inspect(item);
    if (checked?.status !== before) {
      journal.updateBatchItem(request, index, "approved", "stale");
      continue;
    }
    if (!journal.updateBatchItem(request, index, "approved", "pending")) {
      continue;
    }
    try {
      const completed = authorizedRun(
        await controller.mutate(
          request.action,
          item.ref,
          item.runId ? { expectedRunId: item.runId } : undefined,
        ),
        item,
      );
      if (completed?.status === wanted) {
        journal.updateBatchItem(
          request,
          index,
          "pending",
          "applied",
          completed.ref,
        );
      }
    } catch {
      // The outcome remains pending until observed by a later exact request.
    }
  }
  const saved = journal.readBatch(request);
  if (!saved) return;
  const items = await Promise.all(saved.items.map(async (item) => {
    if (
      (item.status === "applied" || item.status === "observed" ||
        item.status === "unchanged") && !await inspect(item, false)
    ) {
      return {
        ref: item.ref,
        runId: item.runId,
        status: "unavailable" as const,
      };
    }
    return item;
  }));
  return { items, approvedAt: saved.approvedAt, requestId: request.requestId };
}
