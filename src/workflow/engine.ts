/**
 * Workflow engine — parse, store, and execute CNCF Serverless Workflow DSL 1.0 workflows.
 *
 * Classification enforcement:
 * - Workflow definitions stored at session taint level.
 * - Execution history stored at terminal taint level.
 * - Optional classification ceiling halts workflow with CLASSIFICATION_BLOCKED.
 * - Taint propagates across task boundaries via the injected escalateTaint callback.
 *
 * @module
 */

import type { ClassificationLevel, Result } from "../core/types/classification.ts";
import { canFlowTo, maxClassification, compareClassification } from "../core/types/classification.ts";
import type {
  WorkflowDefinition,
  WorkflowExecutionContext,
  WorkflowEngine,
  CreateWorkflowEngineOptions,
  ExecutionState,
  ExecutionStatus,
  TaskResult,
  WorkflowError,
} from "./types.ts";
import { parseWorkflowYaml } from "./parser.ts";
import { createWorkflowContext, applyOutputTransform, scrubSecrets } from "./context.ts";
import { executeTask } from "./tasks.ts";

// ─── Storage key format ───────────────────────────────────────────────────────

function defKey(agentId: string, name: string): string {
  return `workflow:def:${agentId}:${name}`;
}

function defClassKey(agentId: string, name: string): string {
  return `workflow:def:${agentId}:${name}:classification`;
}

function runKey(agentId: string, workflowName: string, runId: string): string {
  return `workflow:run:${agentId}:${workflowName}:${runId}`;
}

function runClassKey(agentId: string, workflowName: string, runId: string): string {
  return `workflow:run:${agentId}:${workflowName}:${runId}:classification`;
}

// ─── Task type string ─────────────────────────────────────────────────────────

function getTaskType(task: { readonly call?: { readonly type: string }; readonly run?: { readonly type: string }; readonly set?: unknown; readonly switch?: unknown; readonly for?: unknown; readonly raise?: unknown; readonly emit?: unknown; readonly listen?: unknown; readonly wait?: unknown }): string {
  if (task.call) return `call:${task.call.type}`;
  if (task.run) return `run:${task.run.type}`;
  if (task.set) return "set";
  if (task.switch) return "switch";
  if (task.for) return "for";
  if (task.raise) return "raise";
  if (task.emit) return "emit";
  if (task.listen) return "listen";
  if (task.wait) return "wait";
  return "unknown";
}

function isDeterministicTask(taskType: string): boolean {
  return !taskType.includes("triggerfish:llm") && !taskType.includes("triggerfish:agent");
}

// ─── createWorkflowEngine ────────────────────────────────────────────────────

/**
 * Create a workflow engine instance.
 *
 * The engine is stateless between executions — all state is in
 * ExecutionState and StorageProvider. Each execute() call is independent.
 */
export function createWorkflowEngine(options: CreateWorkflowEngineOptions): WorkflowEngine {
  const { storage } = options;

  // ─── parse ─────────────────────────────────────────────────────────────────

  function parse(yaml: string): Result<WorkflowDefinition, string> {
    return parseWorkflowYaml(yaml);
  }

  // ─── store ────────────────────────────────────────────────────────────────

  async function store(
    definition: WorkflowDefinition,
    agentId: string,
    sessionTaint: ClassificationLevel,
  ): Promise<Result<void, string>> {
    try {
      await storage.set(defKey(agentId, definition.name), JSON.stringify(definition));
      await storage.set(defClassKey(agentId, definition.name), sessionTaint);
      return { ok: true, value: undefined };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // ─── list ─────────────────────────────────────────────────────────────────

  async function list(
    agentId: string,
    sessionTaint: ClassificationLevel,
  ): Promise<readonly WorkflowDefinition[]> {
    const prefix = `workflow:def:${agentId}:`;
    const keys = await storage.list(prefix);

    // Filter out classification keys
    const defKeys = keys.filter((k) => !k.endsWith(":classification"));

    const results: WorkflowDefinition[] = [];
    for (const key of defKeys) {
      // Check classification
      const classKey = key + ":classification";
      const storedClass = await storage.get(classKey) as ClassificationLevel | null;
      const effectiveClass = storedClass ?? "PUBLIC";

      // Can the session read this?
      if (!canFlowTo(effectiveClass, sessionTaint)) continue;

      const raw = await storage.get(key);
      if (!raw) continue;

      try {
        results.push(JSON.parse(raw) as WorkflowDefinition);
      } catch {
        // Skip malformed entries
      }
    }

    return results;
  }

  // ─── get ──────────────────────────────────────────────────────────────────

  async function get(
    name: string,
    agentId: string,
    sessionTaint: ClassificationLevel,
  ): Promise<WorkflowDefinition | null> {
    const classRaw = await storage.get(defClassKey(agentId, name)) as ClassificationLevel | null;
    const storedClass = classRaw ?? "PUBLIC";

    if (!canFlowTo(storedClass, sessionTaint)) return null;

    const raw = await storage.get(defKey(agentId, name));
    if (!raw) return null;

    try {
      return JSON.parse(raw) as WorkflowDefinition;
    } catch {
      return null;
    }
  }

  // ─── delete ───────────────────────────────────────────────────────────────

  async function deleteWorkflow(
    name: string,
    agentId: string,
    sessionTaint: ClassificationLevel,
  ): Promise<Result<void, string>> {
    // Check classification before allowing delete
    const classRaw = await storage.get(defClassKey(agentId, name)) as ClassificationLevel | null;
    const storedClass = classRaw ?? "PUBLIC";

    if (!canFlowTo(storedClass, sessionTaint)) {
      return {
        ok: false,
        error: `Cannot delete workflow "${name}": session taint ${sessionTaint} insufficient for ${storedClass}-level workflow`,
      };
    }

    await storage.delete(defKey(agentId, name));
    await storage.delete(defClassKey(agentId, name));
    return { ok: true, value: undefined };
  }

  // ─── execute ──────────────────────────────────────────────────────────────

  async function execute(
    definition: WorkflowDefinition,
    input: Record<string, unknown>,
    context: WorkflowExecutionContext,
  ): Promise<ExecutionState> {
    const runId = crypto.randomUUID();
    const startedAt = new Date();

    // Track resolved secret values for scrubbing (populated by secret resolver)
    const resolvedSecretValues: string[] = [];

    // Create a secret resolver that tracks resolved values for scrubbing
    const secretResolver = {
      resolve: async (name: string): Promise<string | null> => {
        // No secret store provided — return null
        return null;
      },
    };

    // Build workflow execution context
    let workflowCtx = createWorkflowContext({
      input,
      sessionId: context.sessionId,
      sessionTaint: context.sessionTaint,
      agentId: context.agentId,
      workflowName: definition.name,
      workflowVersion: definition.version,
      secretResolver,
    });

    // Running taint — escalates as tasks execute
    let taintCurrent = context.sessionTaint;

    // Wrap escalateTaint so calls from within tool executors also update taintCurrent.
    // This is critical: the tool executor may discover a resource classification
    // and call escalateTaint before returning — the engine needs to see that update
    // in its ceiling check at the start of the next task.
    const innerContext: WorkflowExecutionContext = {
      ...context,
      escalateTaint: (level: ClassificationLevel, reason: string) => {
        taintCurrent = maxClassification(taintCurrent, level);
        context.escalateTaint(level, reason);
      },
    };

    // Pre-execution requiresTools validation.
    // If the caller supplies availableTools, verify every declared dependency
    // is present before running a single task. This surfaces missing tool
    // errors immediately instead of at the point of failure deep in execution.
    if (definition.requiresTools.length > 0 && context.availableTools !== undefined) {
      const missing = definition.requiresTools.filter(
        (tool) => !context.availableTools!.includes(tool),
      );
      if (missing.length > 0) {
        const failedAt = new Date();
        return {
          runId,
          workflowName: definition.name,
          workflowVersion: definition.version,
          status: "FAULTED",
          startedAt,
          completedAt: failedAt,
          currentTaskIndex: 0,
          currentTaskName: "",
          data: {},
          taintAtStart: context.sessionTaint,
          taintCurrent: context.sessionTaint,
          taskResults: [],
          error: {
            type: "missing_required_tools",
            status: 400,
            title: "Required tools not available",
            detail: `Workflow "${definition.name}" requires tools not registered in this execution context: ${missing.join(", ")}`,
          },
        };
      }
    }

    const taskResults: TaskResult[] = [];
    let status: ExecutionStatus = "RUNNING";
    let workflowError: WorkflowError | undefined;

    // Build task index for named jumps
    const taskByName = new Map<string, number>();
    for (let i = 0; i < definition.do.length; i++) {
      taskByName.set(definition.do[i].name, i);
    }

    let taskIndex = 0;
    const maxTasks = 100; // hard limit
    let totalTasksRun = 0;

    while (taskIndex < definition.do.length && totalTasksRun < maxTasks) {
      const task = definition.do[taskIndex];
      const taskType = getTaskType(task);
      const taintBefore = taintCurrent;
      const taskStart = new Date();

      // Check classification ceiling (if set)
      if (definition.classificationCeiling !== undefined) {
        if (compareClassification(taintCurrent, definition.classificationCeiling) > 0) {
          status = "CLASSIFICATION_BLOCKED";
          workflowError = {
            type: "classification_ceiling_exceeded",
            status: 403,
            title: "Classification ceiling exceeded",
            detail: `Workflow taint ${taintCurrent} exceeds ceiling ${definition.classificationCeiling}`,
          };
          break;
        }
      }

      totalTasksRun++;

      // Execute task (use innerContext so escalateTaint calls update taintCurrent)
      const { result, nextCtx, directive } = await executeTask(
        task,
        workflowCtx,
        innerContext,
        taintCurrent,
      );

      workflowCtx = nextCtx;

      // For set tasks, merge the set values into context data
      if (task.set && result.output && typeof result.output === "object") {
        const setData = result.output as Record<string, unknown>;
        workflowCtx = { ...workflowCtx, data: { ...workflowCtx.data, ...setData } };
      }

      // Escalate taint via result.taintDelta (innerContext.escalateTaint already
      // handles direct calls from within tool executors above)
      const newTaint = maxClassification(taintCurrent, result.taintDelta);
      if (newTaint !== taintCurrent) {
        taintCurrent = newTaint;
        context.escalateTaint(taintCurrent, `Task ${task.name} taintDelta escalation`);
      }

      const taintAfter = taintCurrent;
      const taskEnd = new Date();

      // Record task result (scrub secrets from output)
      const scrubbedOutput = scrubSecrets(result.output, resolvedSecretValues);
      const taskResult: TaskResult = {
        taskName: task.name,
        taskType,
        status: result.skipped ? "SKIPPED"
          : result.blocked ? "BLOCKED"
          : result.error ? "FAILED"
          : "SUCCESS",
        startedAt: taskStart,
        completedAt: taskEnd,
        duration: taskEnd.getTime() - taskStart.getTime(),
        taintBefore,
        taintAfter,
        deterministic: isDeterministicTask(taskType),
        ...(scrubbedOutput !== null ? { output: scrubbedOutput } : {}),
        ...(result.error ? { error: result.error } : {}),
      };
      taskResults.push(taskResult);

      // Handle raise task (fault the workflow)
      if (task.raise && result.error) {
        status = "FAULTED";
        try {
          workflowError = JSON.parse(result.error) as WorkflowError;
        } catch {
          workflowError = { type: "workflow_error", status: 500, title: result.error };
        }
        break;
      }

      // Handle blocked task (fault the workflow)
      if (result.blocked) {
        status = "FAULTED";
        workflowError = {
          type: "task_blocked",
          status: 403,
          title: `Task "${task.name}" was blocked by policy`,
          detail: result.error,
        };
        break;
      }

      // Handle failed task (fault the workflow)
      if (result.error && !result.blocked) {
        status = "FAULTED";
        workflowError = {
          type: "task_failed",
          status: 500,
          title: `Task "${task.name}" failed`,
          detail: result.error,
        };
        break;
      }

      // Process flow directive
      if (directive === "end" || directive === "exit") {
        break;
      } else if (directive === "continue" || directive === undefined) {
        taskIndex++;
      } else {
        // Named task jump
        const targetIndex = taskByName.get(directive);
        if (targetIndex !== undefined) {
          taskIndex = targetIndex;
        } else {
          taskIndex++;
        }
      }
    }

    // Check ceiling after final task
    if (status === "RUNNING" && definition.classificationCeiling !== undefined) {
      if (compareClassification(taintCurrent, definition.classificationCeiling) > 0) {
        status = "CLASSIFICATION_BLOCKED";
        workflowError = {
          type: "classification_ceiling_exceeded",
          status: 403,
          title: "Classification ceiling exceeded",
          detail: `Workflow final taint ${taintCurrent} exceeds ceiling ${definition.classificationCeiling}`,
        };
      }
    }

    if (status === "RUNNING") status = "COMPLETED";

    const completedAt = new Date();

    // Apply output transform
    if (status === "COMPLETED" && definition.output?.as) {
      workflowCtx = await applyOutputTransform(workflowCtx, definition.output.as, workflowCtx.data);
    }

    // Scrub secrets from final data
    const finalData = scrubSecrets(workflowCtx.data, resolvedSecretValues) as Record<string, unknown>;

    const executionState: ExecutionState = {
      runId,
      workflowName: definition.name,
      workflowVersion: definition.version,
      status,
      startedAt,
      completedAt,
      currentTaskIndex: taskIndex,
      currentTaskName: definition.do[Math.min(taskIndex, definition.do.length - 1)]?.name ?? "",
      data: finalData,
      taintAtStart: context.sessionTaint,
      taintCurrent,
      ...(definition.classificationCeiling ? { classificationCeiling: definition.classificationCeiling } : {}),
      taskResults,
      ...(workflowError ? { error: workflowError } : {}),
    };

    // Store execution history at terminal taint level
    await storage.set(
      runKey(context.agentId, definition.name, runId),
      JSON.stringify(executionState),
    );
    await storage.set(
      runClassKey(context.agentId, definition.name, runId),
      taintCurrent,
    );

    return executionState;
  }

  // ─── history ──────────────────────────────────────────────────────────────

  async function history(
    workflowName: string,
    agentId: string,
    sessionTaint: ClassificationLevel,
    limit = 20,
  ): Promise<readonly ExecutionState[]> {
    const prefix = `workflow:run:${agentId}:${workflowName}:`;
    const keys = await storage.list(prefix);

    // Filter out classification keys
    const runKeys = keys.filter((k) => !k.endsWith(":classification"));

    const results: ExecutionState[] = [];
    for (const key of runKeys) {
      const classKey = key + ":classification";
      const storedClass = await storage.get(classKey) as ClassificationLevel | null;
      const effectiveClass = storedClass ?? "PUBLIC";

      if (!canFlowTo(effectiveClass, sessionTaint)) continue;

      const raw = await storage.get(key);
      if (!raw) continue;

      try {
        results.push(JSON.parse(raw) as ExecutionState);
      } catch {
        // Skip malformed
      }

      if (results.length >= limit) break;
    }

    // Sort by startedAt descending
    return results.sort((a, b) =>
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
  }

  return {
    parse,
    store,
    list,
    get,
    delete: deleteWorkflow,
    execute,
    history,
  };
}
