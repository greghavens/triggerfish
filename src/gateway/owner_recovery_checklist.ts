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

type ChecklistScope = NonNullable<ReturnType<typeof currentChecklist.getStore>>;
const checklistIdentity = ({ sessionId, runId }: ChecklistScope) => ({
  role: "owner_chat" as const,
  sessionId,
  runId,
});
const withinRecoveryBudget = (todos: readonly unknown[]) =>
  todos.length <= 20 && JSON.stringify(todos).length <= 5_500;

export function withOwnerRecoveryChecklist<T>(
  scope: ChecklistScope,
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
    storage: scopedOwnerChecklistStorage(scope.path, checklistIdentity(scope)),
    getClassification,
    allowScopedItems: withinRecoveryBudget,
  }))(name, input, { todoAuthorization: { readCeiling: scope.ceiling } });
}

export function withOwnerRecoveryChecklistPolicy(
  base: AgentRecoveryPolicy,
  scope: ChecklistScope,
): AgentRecoveryPolicy {
  const identity = checklistIdentity(scope);
  const currentRecord = async () => {
    const contents = await scopedOwnerChecklistStorage(scope.path, identity)
      .get(`todos:${scope.runId}`);
    if (contents === null) return { revision: "empty" };
    if (
      !validExecutionChecklist(
        { ...identity, contents },
        identity,
        scope.ceiling,
      )
    ) {
      return;
    }
    const row = JSON.parse(contents);
    return {
      revision: String(row.revision),
      result: JSON.stringify(row, null, 2),
    };
  };
  const isTodo = (name: string) =>
    name === "todo_read" || name === "todo_write";
  const validResult = (text: string) =>
    /^No todos\. Use todo_write to create your task list\. Revision: (?:empty|[a-f0-9-]{36})$/i
      .test(text) ||
    (text.length <= 7_000 && validExecutionChecklist(
      { ...identity, contents: text },
      identity,
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
          Array.isArray(todos) && canPersistExecutionChecklistItems(todos) &&
          withinRecoveryBudget(todos)
        ? { expected_revision: revision }
        : undefined;
    },
    isReplaySafeRead: (call) =>
      call.name === "todo_read" ||
      base.isReplaySafeRead?.(call) === true,
    canReconcile: (call) =>
      call.name === "todo_write" || base.canReconcile?.(call) === true,
    async authorizeDispatch(call, approvedRuleId, signal) {
      if (call.name !== "todo_write") {
        return await base.authorizeDispatch?.(call, approvedRuleId, signal) ??
          false;
      }
      const current = await currentRecord();
      return !signal?.aborted && !scope.signal?.aborted &&
        current?.revision === call.args.expected_revision;
    },
    async reconcile(call, signal) {
      if (call.name !== "todo_write") {
        return await base.reconcile?.(call, signal);
      }
      if (
        call.executionId !== scope.runId || signal?.aborted ||
        scope.signal?.aborted
      ) return;
      // The recovery lock admits one compare-and-set from the recorded
      // revision. Reopening the committed row avoids repeating that write.
      const current = await currentRecord();
      return current?.result && current.revision !== call.args.expected_revision
        ? current.result
        : undefined;
    },
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
