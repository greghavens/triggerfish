/** Owner skill history for exact, retained background execution scopes. */
import type { MessageStore } from "../core/conversation/conversation_types.ts";
import { openExecutionTraces } from "../core/execution_traces.ts";
import {
  executionTraceSourceVisible,
  isOwnerBoundExecutionTraceSource,
  parseTeamDeliveryTraceSource,
} from "../core/team_delivery_trace_source.ts";
import { canFlowTo } from "../core/types/classification.ts";
import type { SessionState } from "../core/types/session.ts";
import { recoverySessionId } from "../scheduler/service_execution.ts";
import type { SkillHistoryRun } from "../tools/skills/tools.ts";
import { delegatedSubagentSessionId } from "./startup/factory/delegated_agent_recovery.ts";

export async function loadSkillUsageHistory(
  tracePath: string,
  messages: MessageStore,
  ownerSession: () => SessionState,
  run?: SkillHistoryRun,
) {
  const owner = ownerSession().id;
  if (!run) {
    const rows = await messages.loadSession(owner);
    return ownerSession().id === owner ? rows : undefined;
  }

  const traces = openExecutionTraces(tracePath);
  try {
    const authorized = () => {
      const session = ownerSession();
      if (session.id !== owner || !canFlowTo("INTERNAL", session.taint)) return;
      const saved = traces.readRun(run.kind, run.id, session.taint);
      if (!saved) return;
      const { scope } = saved;
      // Team deliveries can share one session and use a separate turn journal.
      if (
        parseTeamDeliveryTraceSource(scope.sourceId) ||
        (scope.role === "delegated" &&
          (!isOwnerBoundExecutionTraceSource(scope.role, scope.sourceId) ||
            !/^[a-f0-9]{64}$/.test(scope.runId) ||
            delegatedSubagentSessionId(scope.runId) !== scope.sessionId)) ||
        (scope.role === "scheduled" &&
          recoverySessionId(scope.runId) !== scope.sessionId) ||
        !executionTraceSourceVisible(scope.role, scope.sourceId, owner)
      ) return;
      return saved;
    };
    const initial = authorized();
    if (!initial) return;
    const rows = await messages.loadSession(initial.scope.sessionId);
    const current = authorized();
    if (
      !current || current.admittedAt !== initial.admittedAt ||
      current.scope.sessionId !== initial.scope.sessionId ||
      current.scope.sourceId !== initial.scope.sourceId
    ) return;
    return rows;
  } finally {
    traces.close();
  }
}
