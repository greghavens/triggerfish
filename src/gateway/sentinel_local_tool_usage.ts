import { isDeepStrictEqual } from "node:util";
import { canFlowTo } from "../core/types/classification.ts";
import { readSentinelLocalUsageSteps } from "../sentinel/local_tool_usage.ts";
import type { OperatorRunToolContext } from "./operator_run_tool.ts";
import { readSentinelFindingReceiptScope } from "./sentinel_worker_findings.ts";

/** Authorize every counted step before returning an exact local-tool rollup. */
export async function readAuthorizedSentinelLocalToolUsage(
  path: string,
  caseId: string,
  revision: number,
  args: Record<string, unknown>,
  context: OperatorRunToolContext | undefined,
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
    const rows = readSentinelLocalUsageSteps(path, revision, scope.runId);
    if (
      !rows ||
      rows.some((step) => "target" in step && !scope.allows(step.target))
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
    const scope = "taskId" in step
      ? { caseId, revision, taskId: step.taskId }
      : {
        caseId,
        revision,
        plannerIdentity: step.plannerIdentity,
        attempt: step.attempt,
      };
    const selector = "taskId" in step ? {} : { revision };
    const metadata = JSON.stringify({
      _classification: "INTERNAL",
      tool: step.tool,
      outcome: step.outcome,
      ordinal: step.ordinal,
    });
    if (
      !currentCase() || !await authorizeTrace(scope, step.tool, selector) ||
      !currentCase() ||
      !await authorizeTrace(scope, step.tool, selector, metadata) ||
      !currentCase()
    ) return;
    const role = "taskId" in step ? "worker" : "planner";
    const group = groups.get(step.tool) ??
      { role, tool: step.tool, calls: 0, failed: 0 };
    group.calls++;
    if (step.outcome === "error") group.failed++;
    groups.set(step.tool, group);
  }
  if (!await owner(args) || !isDeepStrictEqual(load(), selected)) return;
  return { runId: selected.runId, totals: [...groups.values()] };
}
