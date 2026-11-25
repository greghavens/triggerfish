/** Bind recoverable turns to their classified, exact execution checklists. */

import { AsyncLocalStorage } from "node:async_hooks";
import { type AgentRecoveryPolicy } from "../core/agent_recovery.ts";
import { scopedOwnerChecklistStorage } from "../core/agent_recovery_store.ts";
import {
  canPersistExecutionChecklistItems,
  type ExecutionChecklistScope,
  validExecutionChecklist,
} from "../core/execution_checklists.ts";
import { scopedExecutionChecklistStorage } from "../core/execution_traces.ts";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../core/types/classification.ts";
import type { ToolExecutionContext } from "../core/types/tool.ts";
import { createTodoToolExecutor } from "../tools/todo_executor.ts";
import { createTodoManager } from "../tools/todo_manager.ts";

const revisionPattern =
  /^(?:empty|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;

const currentChecklist = new AsyncLocalStorage<
  ExecutionChecklistScope & {
    ceiling: ClassificationLevel;
    signal?: AbortSignal;
    path: string;
    readonly isCurrent?: () => boolean;
  }
>();

type ChecklistScope = NonNullable<ReturnType<typeof currentChecklist.getStore>>;
const checklistIdentity = ({ role, sessionId, runId }: ChecklistScope) => ({
  role,
  sessionId,
  runId,
});
const withinRecoveryBudget = (todos: readonly unknown[]) =>
  todos.length <= 20 && JSON.stringify(todos).length <= 5_500;

export function withExecutionChecklistScope<T>(
  scope: ChecklistScope,
  operation: () => T,
): T {
  return currentChecklist.run(scope, operation);
}

/** Apply the checkpoint size limit to merged items only inside an admitted run. */
export function allowRecoverableChecklistItems(
  identity: ExecutionChecklistScope,
  todos: readonly unknown[],
): boolean {
  const current = currentChecklist.getStore();
  return !current || current.role !== identity.role ||
    current.sessionId !== identity.sessionId ||
    current.runId !== identity.runId ||
    withinRecoveryBudget(todos);
}

export function dispatchOwnerRecoveryChecklist(
  sessionId: string,
  name: string,
  input: Record<string, unknown>,
  context: ToolExecutionContext | undefined,
  getClassification: () => ClassificationLevel,
): Promise<string | null> | undefined {
  const scope = currentChecklist.getStore();
  if (
    scope?.role !== "owner_chat" ||
    (name !== "todo_read" && name !== "todo_write")
  ) return;
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

export function withExecutionChecklistRecoveryPolicy(
  base: AgentRecoveryPolicy,
  scope: ChecklistScope,
): AgentRecoveryPolicy {
  const identity = checklistIdentity(scope);
  const currentRecord = async () => {
    const storage = scope.role === "owner_chat"
      ? scopedOwnerChecklistStorage(scope.path, identity)
      : scopedExecutionChecklistStorage(scope.path, identity);
    const contents = await storage.get(`todos:${scope.runId}`);
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
    version: `${base.version}:${
      scope.role === "owner_chat" ? "owner" : scope.role
    }-checklist-v1`,
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
        scope.isCurrent?.() !== false &&
        current?.revision === call.args.expected_revision;
    },
    async reconcile(call, signal) {
      if (call.name !== "todo_write") {
        return await base.reconcile?.(call, signal);
      }
      if (
        call.executionId !== scope.runId || signal?.aborted ||
        scope.isCurrent?.() === false ||
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
            scope.isCurrent?.() !== false &&
            canFlowTo(receipt.classification, scope.ceiling),
        )
        : base.authorize(receipt),
    authorizeSavedProjection: (receipt, text) =>
      isTodo(receipt.name)
        ? validResult(text)
        : base.authorizeSavedProjection?.(receipt, text) ?? true,
  };
}
