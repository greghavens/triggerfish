import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { canFlowTo } from "../core/types/classification.ts";
import {
  readSentinelLocalUsageSteps,
  type SentinelLinkedUsageStep,
  type SentinelTrafficBatchUsageStep,
  type SentinelTrafficResultUsageStep,
  type SentinelWorkflowUsageStep,
} from "../sentinel/local_tool_usage.ts";
import type { OperatorRunToolContext } from "./operator_run_tool.ts";
import { readSentinelFindingReceiptScope } from "./sentinel_worker_findings.ts";
import { readProjectedSentinelTrafficReceipt } from "./sentinel_traffic_tool.ts";

/** Authorize every counted step before returning an exact local-tool rollup. */
export async function readAuthorizedSentinelLocalToolUsage(
  path: string,
  caseId: string,
  revision: number,
  args: Record<string, unknown>,
  context: OperatorRunToolContext | undefined,
  reopenLinked?: (step: SentinelLinkedUsageStep) => Promise<string | undefined>,
  authorizeExactResult?: (
    step:
      | SentinelWorkflowUsageStep
      | SentinelTrafficResultUsageStep
      | SentinelTrafficBatchUsageStep,
  ) => Promise<boolean>,
) {
  const owner = context?.authorizeOwnerRunCall;
  const authorizeTrace = context?.authorizeSentinelTraceRead;
  if (
    !context?.authenticatedOwnerSessionId || !owner || !authorizeTrace ||
    !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC")
  ) return;
  const currentCase = () =>
    context.authorizeSelectedSentinelCase?.() !== false &&
    context.authorizeSentinelCaseRead?.(caseId, revision) !== false;
  const load = () => {
    if (!currentCase()) return;
    const scope = readSentinelFindingReceiptScope(path, revision);
    if (!scope || scope.runId !== args.runId) return;
    const rows = readSentinelLocalUsageSteps(
      path,
      revision,
      scope.runId,
      args.includeRetainedTopology === true,
      args.includeRetainedFindingSources === true,
      args.includeRetainedTrafficMetadata === true,
      args.includeSavedWorkflowReceipts === true,
      args.includeOriginalWorkflowReceipts === true,
      args.includeRetainedTrafficResults === true,
    );
    if (
      !rows ||
      rows.some((step) =>
        ("target" in step && step.tool !== "sentinel_shared_finding_source" &&
          !scope.allows(step.target)) ||
        ("assignedTarget" in step && !scope.allows(step.assignedTarget))
      )
    ) return;
    return { runId: scope.runId, rows };
  };

  if (!currentCase() || !await owner(args)) return;
  const selected = load();
  if (!selected) return;
  const groups = new Map<
    string,
    { role: "planner" | "worker"; tool: string; calls: number; failed: number }
  >();
  for (const step of selected.rows) {
    if ("receiptSha256" in step) {
      if (
        !currentCase() || !await authorizeExactResult?.(step) ||
        !currentCase()
      ) return;
      const role = "taskId" in step ? "worker" : "planner";
      const key = role + "/" + step.tool;
      const group = groups.get(key) ??
        { role, tool: step.tool, calls: 0, failed: 0 };
      group.calls++;
      groups.set(key, group);
      continue;
    }
    const scope = "taskId" in step
      ? { caseId, revision, taskId: step.taskId }
      : {
        caseId,
        revision,
        plannerIdentity: step.plannerIdentity,
        attempt: step.attempt,
      };
    const selector = "goalReceiptRead" in step
      ? step.goalReceiptRead.args
      : "trafficRead" in step
      ? step.trafficRead.args
      : "taskId" in step
      ? {}
      : { revision };
    const metadata = JSON.stringify({
      _classification: "INTERNAL",
      tool: step.tool,
      outcome: step.outcome,
      ordinal: step.ordinal,
    });
    if (
      !currentCase() || !await authorizeTrace(scope, step.tool, selector) ||
      !currentCase()
    ) return;
    const reopen = async () => {
      if ("goalReceiptRead" in step) return await reopenLinked?.(step);
      if ("trafficRead" in step) {
        const result = readProjectedSentinelTrafficReceipt(
          path,
          caseId,
          revision,
          step.trafficRead.args,
          "assignedTarget" in step ? step.assignedTarget : undefined,
        );
        const text = result && JSON.stringify(result);
        return text && createHash("sha256").update(text).digest("hex") ===
            step.trafficRead.sha256
          ? text
          : undefined;
      }
      return metadata;
    };
    const text = await reopen();
    if (
      !text || !currentCase() ||
      !await authorizeTrace(scope, step.tool, selector, text) || !currentCase()
    ) return;
    if (
      ("goalReceiptRead" in step || "trafficRead" in step) &&
      (text !== await reopen() ||
        !currentCase())
    ) return;
    const role = "taskId" in step ? "worker" : "planner";
    const groupKey = role + "/" + step.tool;
    const group = groups.get(groupKey) ??
      { role, tool: step.tool, calls: 0, failed: 0 };
    group.calls++;
    if (step.outcome === "error") group.failed++;
    groups.set(groupKey, group);
  }
  if (!await owner(args) || !isDeepStrictEqual(load(), selected)) return;
  return { runId: selected.runId, totals: [...groups.values()] };
}
