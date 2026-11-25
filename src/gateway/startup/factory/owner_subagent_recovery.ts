/** Authenticated owner command adapter for the existing subagent factory. */
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { SessionState } from "../../../core/types/session.ts";
import type { AgentRecoveryExecutor } from "../../../core/agent_recovery.ts";
import type { buildSubagentFactory } from "./subagent.ts";

const usage =
  "Usage: /recover-subagent [--resume-paused] <execution UUID> <task>";
const commandPattern =
  /^\/recover-subagent (?:(--resume-paused) )?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}) ([\s\S]+)$/i;

/** Call only inside the authenticated owner turn with its current session and ceiling. */
export function buildOwnerSubagentRecoveryCommand(
  subagentFactory: ReturnType<typeof buildSubagentFactory>,
  run?: AgentRecoveryExecutor,
) {
  return async (
    command: string,
    parent: SessionState,
    signal?: AbortSignal,
    targetClassification: ClassificationLevel = parent.taint,
  ): Promise<string | undefined> => {
    if (!/^\/recover-subagent(?:\s|$)/.test(command)) {
      return undefined;
    }
    if (!run) return "Durable subagent execution is unavailable.";
    const parsed = commandPattern.exec(command);
    if (!parsed) return usage;
    const [, resumeFlag, executionId, task] = parsed;
    if (!task.trim() || task.length > 8_000 || task.includes("\x00")) {
      return usage;
    }
    if (signal?.aborted) return "Operation cancelled by user.";
    try {
      return await subagentFactory(task, undefined, {
        recovery: {
          parentSessionId: parent.id,
          executionId: executionId.toLowerCase(),
          targetClassification,
          run: resumeFlag
            ? (id, orchestrator, options) =>
              run(id, orchestrator, options, { resumePaused: true })
            : run,
        },
        signal,
      });
    } catch {
      return signal?.aborted
        ? "Operation cancelled by user."
        : "Durable subagent execution failed.";
    }
  };
}
