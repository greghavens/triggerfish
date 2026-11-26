/** Project committed Sentinel state into scheduler event metadata. */
import { dirname, join } from "@std/path";
import { openExecutionTraces } from "../core/execution_traces.ts";
import { openSentinelAdaptiveStore } from "../sentinel/adaptive_store.ts";
import type { AgentEventSchedulerConfig } from "../scheduler/service_agent_events.ts";
import {
  readSentinelGoalCompletionEvents,
  readSentinelRunStartEvents,
  readSentinelTimeoutEvents,
} from "../sentinel/assessment_store.ts";
import {
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import { readSentinelWorkerFindingHistory } from "../sentinel/worker_finding_store.ts";

export function sentinelAgentEventSources(
  baseDir: string,
): AgentEventSchedulerConfig {
  return {
    baseDir,
    readSources(entries, publish, earliestRegistration) {
      const subscriptions = entries.map(({ subscription }) => subscription);
      const toolNames = new Set(
        subscriptions.flatMap(({ tool, tools }) =>
          tools ?? (tool ? [tool] : [])
        ),
      );
      const cases = new Set(
        subscriptions.flatMap(({ caseId, kinds }) =>
          kinds.some((kind) => kind !== "interval")
            ? caseId ? [caseId] : ["main", ...listSentinelCaseIds(baseDir)]
            : []
        ),
      );
      for (const caseId of cases) {
        const selected = subscriptions.filter((s) =>
          !s.caseId || s.caseId === caseId
        );
        const kinds = new Set(selected.flatMap((s) => s.kinds));
        const path = resolveSentinelCasePath(baseDir, caseId);
        if (kinds.has("task_created")) {
          for (const start of readSentinelRunStartEvents(path)) {
            publish({ kind: "task_created", caseId, ...start });
          }
        }
        if (kinds.has("timeout")) {
          for (const timeout of readSentinelTimeoutEvents(path)) {
            publish({ kind: "timeout", caseId, ...timeout });
          }
        }
        if (kinds.has("finding")) {
          for (const finding of readSentinelWorkerFindingHistory(path)) {
            if (finding.kind === "finding" && finding.caseId === caseId) {
              publish({
                kind: "finding",
                receipt: finding.id,
                caseId,
                recordedAt: Date.parse(finding.recordedAt),
              });
            }
          }
        }
        if (kinds.has("goal_completed")) {
          for (const completion of readSentinelGoalCompletionEvents(path)) {
            publish({ kind: "goal_completed", caseId, ...completion });
          }
        }
        if (kinds.has("tool_completed")) {
          const history = join(dirname(path), "sentinel-adaptive.db");
          try {
            Deno.lstatSync(history);
          } catch (error) {
            if (error instanceof Deno.errors.NotFound) continue;
            throw error;
          }
          const store = openSentinelAdaptiveStore(history);
          try {
            for (const review of store.modelReviewNotes()) {
              for (const [index, step] of review.steps.entries()) {
                if (
                  !toolNames.has(step.tool) ||
                  (step.outcome !== "returned" && step.outcome !== "error") ||
                  (step.outcome === "error" &&
                    step.tool === "sentinel_report_finding")
                ) {
                  continue;
                }
                publish({
                  kind: "tool_completed",
                  receipt: `${review.taskId}:${index}`,
                  caseId,
                  tool: step.tool,
                  ...(step.outcome === "error" && { outcome: "error" }),
                  recordedAt: Date.parse(review.at),
                });
              }
            }
          } finally {
            store.close();
          }
        }
      }
      // Trusted execution traces already omit raw arguments and results.
      const backgroundTools = new Set(
        subscriptions.flatMap(({ caseId, tool, tools }) =>
          caseId ? [] : tools ?? (tool ? [tool] : [])
        ),
      );
      const tracePath = join(baseDir, "execution-traces.db");
      if (!backgroundTools.size) return;
      try {
        Deno.statSync(tracePath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return;
        throw error;
      }
      const journal = openExecutionTraces(tracePath);
      try {
        for (const tool of backgroundTools) {
          let cursor: string | null = null;
          do {
            const hits = journal.search({
              query: tool,
              ceiling: "INTERNAL",
              limit: 50,
              backgroundOwner: null,
              recordedSince: earliestRegistration,
              ...(cursor && { cursor }),
            });
            for (const hit of hits?.matches ?? []) {
              if (
                hit.tool !== tool ||
                (hit.outcome !== "returned" && hit.outcome !== "failed") ||
                (hit.outcome === "failed" && tool === "sentinel_report_finding")
              ) continue;
              const source = journal.readRun(hit.role, hit.runId, "INTERNAL")
                ?.scope.sourceId;
              if (source === undefined || source.startsWith("agent-event:")) {
                continue;
              }
              publish({
                kind: "tool_completed",
                receipt: hit.id,
                tool,
                ...(hit.outcome === "failed" && { outcome: "error" }),
                recordedAt: Date.parse(hit.recordedAt),
              });
            }
            cursor = hits?.nextCursor ?? null;
          } while (cursor);
        }
      } finally {
        journal.close();
      }
    },
  };
}
