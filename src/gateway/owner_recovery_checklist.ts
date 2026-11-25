/** Bind a recoverable owner turn to its exact checklist behind root dispatch. */

import { AsyncLocalStorage } from "node:async_hooks";
import { type AgentRecoveryPolicy } from "../core/agent_recovery.ts";
import { scopedOwnerChecklistStorage } from "../core/agent_recovery_store.ts";
import {
  canPersistExecutionChecklistItems,
  validExecutionChecklist,
} from "../core/execution_checklists.ts";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../core/types/classification.ts";
import type { ToolExecutionContext } from "../core/types/tool.ts";
import { createTodoToolExecutor } from "../tools/todo_executor.ts";
import { createTodoManager } from "../tools/todo_manager.ts";

const revisionPattern =
  /^(?:empty|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;

const currentChecklist = new AsyncLocalStorage<{
  sessionId: string;
  ceiling: ClassificationLevel;
  signal?: AbortSignal;
  path: string;
  runId: string;
}>();

export function withOwnerRecoveryChecklist<T>(
  scope: NonNullable<ReturnType<typeof currentChecklist.getStore>>,
  operation: () => T,
): T {
  return currentChecklist.run(scope, operation);
}

export function dispatchOwnerRecoveryChecklist(
  sessionId: string,
  name: string,
  input: Record<string, unknown>,
  context: ToolExecutionContext | undefined,
  getClassification: () => ClassificationLevel,
): Promise<string | null> | undefined {
  const scope = currentChecklist.getStore();
  if (!scope || (name !== "todo_read" && name !== "todo_write")) return;
  if (
    scope.sessionId !== sessionId || scope.signal?.aborted ||
    !context?.todoAuthorization ||
    !canFlowTo(getClassification(), scope.ceiling)
  ) return Promise.resolve("Error: Owner execution checklist is unavailable.");
  return createTodoToolExecutor(createTodoManager({
    agentId: scope.runId,
    storage: scopedOwnerChecklistStorage(scope.path, {
      role: "owner_chat",
      sessionId,
      runId: scope.runId,
    }),
    getClassification,
  }))(name, input, { todoAuthorization: { readCeiling: scope.ceiling } });
}

export function withOwnerRecoveryChecklistPolicy(
  base: AgentRecoveryPolicy,
  scope: NonNullable<ReturnType<typeof currentChecklist.getStore>>,
): AgentRecoveryPolicy {
  const isTodo = (name: string) =>
    name === "todo_read" || name === "todo_write";
  const validResult = (text: string) =>
    /^No todos\. Use todo_write to create your task list\. Revision: (?:empty|[a-f0-9-]{36})$/i
      .test(text) ||
    (text.length <= 7_000 && validExecutionChecklist(
      {
        role: "owner_chat",
        sessionId: scope.sessionId,
        runId: scope.runId,
        contents: text,
      },
      { role: "owner_chat", sessionId: scope.sessionId, runId: scope.runId },
      scope.ceiling,
    ));
  return {
    ...base,
    version: `${base.version}:owner-checklist-v1`,
    projectCall(call) {
      if (!isTodo(call.name)) return base.projectCall(call);
      const { expected_revision: revision, todos } = call.args;
      if (call.name === "todo_read") {
        return Object.keys(call.args).length === 0 ? {} : undefined;
      }
      if (typeof revision !== "string" || !revisionPattern.test(revision)) {
        return;
      }
      // Saved-call policy sees just the receipt. A live write still requires
      // the item array at its executor and cannot mutate from this projection.
      if (Object.keys(call.args).length === 1) {
        return { expected_revision: revision };
      }
      return Object.keys(call.args).length === 2 &&
          Array.isArray(todos) && todos.length <= 20 &&
          canPersistExecutionChecklistItems(todos) &&
          JSON.stringify(todos).length <= 5_500
        ? { expected_revision: revision }
        : undefined;
    },
    isReplaySafeRead: (call) =>
      call.name === "todo_read" ||
      base.isReplaySafeRead?.(call) === true,
    projectResult: (call, text) =>
      isTodo(call.name)
        ? validResult(text) ? text : undefined
        : base.projectResult(call, text),
    authorize: (receipt) =>
      isTodo(receipt.name)
        ? Promise.resolve(
          !scope.signal?.aborted &&
            canFlowTo(receipt.classification, scope.ceiling),
        )
        : base.authorize(receipt),
    authorizeSavedProjection: (receipt, text) =>
      isTodo(receipt.name)
        ? validResult(text)
        : base.authorizeSavedProjection?.(receipt, text) ?? true,
  };
}
