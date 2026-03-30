/**
 * Tidepool workflows host handler — bridges store/registry to WebSocket topics.
 * @module
 */

import { createLogger } from "../../../core/logger/logger.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import {
  approveWorkflowVersion,
  broadcastRegistryEvent,
  broadcastRichEvent,
  dispatchControlAction,
  dispatchScheduleRun,
  dispatchStartRun,
  rejectWorkflowVersion,
} from "./host_workflows_dispatch.ts";
import type {
  MinimalCronManager,
  MinimalRunRegistry,
  MinimalWorkflowStore,
  MinimalWorkflowVersionStore,
  SimplifiedTask,
  TidepoolWorkflowsHandler,
  WorkflowExecutorFn,
} from "./host_workflows_types.ts";

export type {
  TidepoolWorkflowsHandler,
  WorkflowsHandlerOptions,
} from "./host_workflows_types.ts";

const log = createLogger("tidepool-workflows");

/** Create a TidepoolWorkflowsHandler. */
export function createTidepoolWorkflowsHandler(
  store: MinimalWorkflowStore,
  registry: MinimalRunRegistry,
  options?: {
    readonly workflowExecutor?: WorkflowExecutorFn;
    readonly cronManager?: MinimalCronManager;
    readonly versionStore?: MinimalWorkflowVersionStore;
    readonly parseWorkflow?: (yaml: string) => SimplifiedTask[];
  },
): TidepoolWorkflowsHandler {
  const workflowExecutor = options?.workflowExecutor;
  const cronManager = options?.cronManager;
  const versionStore = options?.versionStore;
  const parseWorkflow = options?.parseWorkflow;
  const subscribers = new Set<WebSocket>();

  const unsubscribeRegistry = registry.subscribe((event) => {
    broadcastRegistryEvent(subscribers, event);
  });

  const unsubscribeRichEvents = registry.subscribeRichEvents((event) => {
    broadcastRichEvent(subscribers, event);
  });

  log.debug("Tidepool workflows handler created", {
    operation: "createTidepoolWorkflowsHandler",
  });

  // Prevent unused variable warning — cleanup on GC
  void unsubscribeRegistry;
  void unsubscribeRichEvents;

  return {
    subscribeLive: (socket) => subscribers.add(socket),
    unsubscribeLive: (socket) => subscribers.delete(socket),
    fetchWorkflowList: () => fetchWorkflowList(store),
    fetchWorkflowDetail: (name, taint) =>
      fetchWorkflowDetail(store, parseWorkflow, name, taint),
    fetchActiveRuns: () => ({ topic: "workflows", type: "active_runs", runs: registry.listActiveRuns() }),
    fetchRunHistory: (taint, name, limit) =>
      fetchRunHistory(store, taint, name, limit),
    controlRun: (runId, action) => dispatchControlAction(registry, runId, action),
    deleteWorkflow: (name) => deleteWorkflow(store, name),
    startRun: (name, taint) => dispatchStartRun(store, workflowExecutor, name, taint),
    scheduleRun: (name, expr, cls) => dispatchScheduleRun(cronManager, name, expr, cls),
    fetchRunDetail: (runId, taint, wfName) =>
      fetchRunDetail(store, registry, parseWorkflow, runId, taint, wfName),
    fetchHealingStatus: (name, taint) =>
      fetchHealingStatus(store, versionStore, name, taint),
    approveVersion: (id, by) => approveWorkflowVersion(versionStore, id, by),
    rejectVersion: (id, by, reason) =>
      rejectWorkflowVersion(versionStore, id, by, reason),
    broadcastWorkflowList: async () => {
      const data = await fetchWorkflowList(store);
      const payload = JSON.stringify(data);
      for (const socket of subscribers) {
        try {
          socket.send(payload);
        } catch {
          subscribers.delete(socket);
        }
      }
    },
    removeSocket: (socket) => subscribers.delete(socket),
  };
}

/** Fetch the full workflow list at RESTRICTED ceiling. */
async function fetchWorkflowList(
  store: MinimalWorkflowStore,
): Promise<Record<string, unknown>> {
  const workflows = await store.listWorkflowDefinitions("RESTRICTED");
  return {
    topic: "workflows",
    type: "workflow_list",
    workflows: workflows.map((w) => ({
      name: w.name,
      description: w.description,
      classification: w.classification,
      savedAt: w.savedAt,
    })),
  };
}

/** Fetch a single workflow definition by name and taint. */
async function fetchWorkflowDetail(
  store: MinimalWorkflowStore,
  parseWorkflow: ((yaml: string) => SimplifiedTask[]) | undefined,
  name: string,
  sessionTaint: ClassificationLevel,
): Promise<Record<string, unknown>> {
  const wf = await store.loadWorkflowDefinition(name, sessionTaint);
  log.debug("Workflow definition load for detail view", {
    operation: "fetchWorkflowDetail",
    workflow: name,
    sessionTaint,
    found: !!wf,
  });
  if (!wf) {
    return { topic: "workflows", type: "workflow_detail", name, found: false };
  }
  const tasks = parseWorkflow ? parseWorkflow(wf.yaml) : [];
  return {
    topic: "workflows",
    type: "workflow_detail",
    name: wf.name,
    found: true,
    yaml: wf.yaml,
    tasks,
    classification: wf.classification,
    savedAt: wf.savedAt,
    description: wf.description,
  };
}

/** Fetch run history, optionally filtered by workflow name. */
async function fetchRunHistory(
  store: MinimalWorkflowStore,
  sessionTaint: ClassificationLevel,
  workflowName?: string,
  limit?: number,
): Promise<Record<string, unknown>> {
  const runs = await store.listWorkflowRuns(sessionTaint, {
    workflowName,
    limit: limit ?? 20,
  });
  return {
    topic: "workflows",
    type: "run_history",
    runs: runs.map((r) => ({
      runId: r.runId,
      workflowName: r.workflowName,
      status: r.status,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      taskCount: r.taskCount,
      error: r.error,
    })),
  };
}

/** Delete a workflow definition and return the result payload. */
async function deleteWorkflow(
  store: MinimalWorkflowStore,
  name: string,
): Promise<Record<string, unknown>> {
  await store.deleteWorkflowDefinition(name);
  log.info("Workflow definition deleted via Tidepool", {
    operation: "deleteWorkflow",
    workflow: name,
  });
  return { topic: "workflows", type: "workflow_deleted", name, ok: true };
}

/** Fetch run detail including parsed tasks and step history. */
async function fetchRunDetail(
  store: MinimalWorkflowStore,
  registry: MinimalRunRegistry,
  parseWorkflow: ((yaml: string) => SimplifiedTask[]) | undefined,
  runId: string,
  sessionTaint: ClassificationLevel,
  explicitWorkflowName?: string,
): Promise<Record<string, unknown>> {
  const steps = registry.getRunStepHistory(runId);
  const activeRun = registry.listActiveRuns().find((r) => r.runId === runId);
  const workflowName = explicitWorkflowName ?? activeRun?.workflowName ?? "";

  let tasks: SimplifiedTask[] = [];
  if (workflowName && parseWorkflow) {
    const wf = await store.loadWorkflowDefinition(workflowName, sessionTaint);
    log.debug("Workflow definition load for run detail", {
      operation: "fetchRunDetail",
      runId,
      workflowName,
      sessionTaint,
      found: !!wf,
    });
    if (wf) {
      tasks = parseWorkflow(wf.yaml);
    }
  }

  return { topic: "workflows", type: "run_detail", runId, workflowName, tasks, steps };
}

/** Fetch healing status including versions and current YAML. */
async function fetchHealingStatus(
  store: MinimalWorkflowStore,
  versionStore: MinimalWorkflowVersionStore | undefined,
  workflowName: string,
  sessionTaint: ClassificationLevel,
): Promise<Record<string, unknown>> {
  if (!versionStore) {
    log.warn("Healing status unavailable: version store not configured", {
      operation: "fetchHealingStatus",
      workflowName,
    });
    return {
      topic: "workflows",
      type: "healing_status",
      workflowName,
      versions: [],
      status: null,
    };
  }

  const versions = await versionStore.listWorkflowVersions(workflowName);
  const wf = await store.loadWorkflowDefinition(workflowName, sessionTaint);
  log.debug("Workflow definition load for healing status", {
    operation: "fetchHealingStatus",
    workflowName,
    sessionTaint,
    found: !!wf,
    versionCount: versions.length,
  });

  return {
    topic: "workflows",
    type: "healing_status",
    workflowName,
    versions,
    yaml: wf?.yaml ?? null,
  };
}

