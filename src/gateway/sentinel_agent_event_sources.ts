/** Project committed Sentinel state into scheduler event metadata. */
import { join } from "@std/path";
import { openExecutionTraces } from "../core/execution_traces.ts";
import type { AgentEventSchedulerConfig } from "../scheduler/service_agent_events.ts";
import {
  readSentinelAssessment,
  readSentinelCaseStatus,
} from "../sentinel/assessment_store.ts";
import {
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import { readSentinelWorkerFindingHistory } from "../sentinel/worker_finding_store.ts";
import { readAdaptiveSentinel } from "./sentinel_adaptive_runtime.ts";

export function sentinelAgentEventSources(
  baseDir: string,
): AgentEventSchedulerConfig {
  return {
    baseDir,
    readSources(entries, publish) {
      const subscriptions = entries.map(({ subscription }) => subscription);
      const toolNames = new Set(
        subscriptions.flatMap(({ tool }) => tool ? [tool] : []),
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
        const status = readSentinelCaseStatus(path, true);
        const runId = status?.discovery?.runId;
        if (!status || !runId) continue;
        const startedAt = status.discovery?.startedAt;
        if (startedAt && kinds.has("task_created")) {
          publish({
            kind: "task_created",
            receipt: runId,
            caseId,
            recordedAt: Date.parse(startedAt),
          });
        }
        if (status.status === "timed_out" && kinds.has("timeout")) {
          publish({
            kind: "timeout",
            receipt: runId,
            caseId,
            recordedAt: Date.parse(status.updatedAt),
          });
        }
        if (kinds.has("finding")) {
          for (const finding of readSentinelWorkerFindingHistory(path)) {
            if (finding.kind === "finding" && finding.runId === runId) {
              publish({
                kind: "finding",
                receipt: finding.id,
                caseId,
                recordedAt: Date.parse(finding.recordedAt),
              });
            }
          }
        }
        if (!kinds.has("goal_completed") && !kinds.has("tool_completed")) {
          continue;
        }
        const assessment = readSentinelAssessment(path);
        if (!assessment) continue;
        if (assessment.completion && kinds.has("goal_completed")) {
          publish({
            kind: "goal_completed",
            receipt: `${runId}:${assessment.revision}`,
            caseId,
            recordedAt: Date.parse(assessment.completion.at),
          });
        }
        if (kinds.has("tool_completed")) {
          for (
            const review
              of readAdaptiveSentinel(path, assessment)?.modelReviews ?? []
          ) {
            for (const [index, step] of review.steps.entries()) {
              if (step.outcome !== "returned" || !toolNames.has(step.tool)) {
                continue;
              }
              publish({
                kind: "tool_completed",
                receipt: `${review.taskId}:${index}`,
                caseId,
                tool: step.tool,
                recordedAt: Date.parse(review.at),
              });
            }
          }
        }
      }
      // Trusted execution traces already omit raw arguments and results.
      const backgroundTools = new Set(
        subscriptions.flatMap(({ caseId, tool }) =>
          !caseId && tool ? [tool] : []
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
          const hits = journal.search({
            query: tool,
            ceiling: "INTERNAL",
            limit: 50,
            backgroundOwner: null,
          });
          for (const hit of hits?.matches ?? []) {
            if (hit.tool !== tool || hit.outcome !== "returned") continue;
            const source = journal.readRun(hit.role, hit.runId, "INTERNAL")
              ?.scope.sourceId;
            if (source?.startsWith("agent-event:")) continue;
            publish({
              kind: "tool_completed",
              receipt: hit.id,
              tool,
              recordedAt: Date.parse(hit.recordedAt),
            });
          }
        }
      } finally {
        journal.close();
      }
    },
  };
}
