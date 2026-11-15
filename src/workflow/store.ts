/**
 * Workflow persistence via StorageProvider.
 *
 * Stores workflow definitions and run history using key prefixes:
 * - `workflows:{name}` for definitions (YAML string)
 * - `workflow-runs:{runId}` for execution results
 * @module
 */

import type { StorageProvider } from "../core/storage/provider.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import { canFlowTo } from "../core/types/classification.ts";
import { createLogger } from "../core/logger/logger.ts";
import type { WorkflowRunResult } from "./types.ts";

const log = createLogger("workflow-store");

const WORKFLOW_PREFIX = "workflows:";
const RUN_PREFIX = "workflow-runs:";

/** Stored workflow metadata alongside the raw YAML. */
export interface StoredWorkflow {
  readonly name: string;
  readonly yaml: string;
  readonly classification: ClassificationLevel;
  readonly savedAt: string;
  readonly description?: string;
}

/** Workflow store for CRUD operations on definitions and run history. */
export interface WorkflowStore {
  saveWorkflowDefinition(
    name: string,
    yaml: string,
    classification: ClassificationLevel,
    description?: string,
  ): Promise<void>;
  loadWorkflowDefinition(
    name: string,
    sessionTaint: ClassificationLevel,
  ): Promise<StoredWorkflow | null>;
  listWorkflowDefinitions(
    sessionTaint: ClassificationLevel,
  ): Promise<readonly StoredWorkflow[]>;
  deleteWorkflowDefinition(name: string): Promise<void>;
  saveWorkflowRun(result: WorkflowRunResult): Promise<void>;
  loadWorkflowRun(
    runId: string,
    sessionTaint: ClassificationLevel,
  ): Promise<WorkflowRunResult | null>;
  listWorkflowRuns(
    sessionTaint: ClassificationLevel,
    options?: { readonly workflowName?: string; readonly limit?: number },
  ): Promise<readonly WorkflowRunResult[]>;
}

/** Create a WorkflowStore backed by a StorageProvider. */
export function createWorkflowStore(
  storage: StorageProvider,
): WorkflowStore {
  return {
    saveWorkflowDefinition: (name, yaml, classification, description) =>
      saveDefinition(storage, name, yaml, classification, description),
    loadWorkflowDefinition: (name, sessionTaint) =>
      loadDefinition(storage, name, sessionTaint),
    listWorkflowDefinitions: (sessionTaint) =>
      listDefinitions(storage, sessionTaint),
    deleteWorkflowDefinition: (name) =>
      storage.delete(`${WORKFLOW_PREFIX}${name}`),
    saveWorkflowRun: (result) => saveRun(storage, result),
    loadWorkflowRun: (runId, sessionTaint) =>
      loadRun(storage, runId, sessionTaint),
    listWorkflowRuns: (sessionTaint, options) =>
      listRuns(storage, sessionTaint, options),
  };
}

async function saveDefinition(
  storage: StorageProvider,
  name: string,
  yaml: string,
  classification: ClassificationLevel,
  description?: string,
): Promise<void> {
  const stored: StoredWorkflow = {
    name,
    yaml,
    classification,
    savedAt: new Date().toISOString(),
    description,
  };
  await storage.set(
    `${WORKFLOW_PREFIX}${name}`,
    JSON.stringify(stored),
  );
}

async function loadDefinition(
  storage: StorageProvider,
  name: string,
  sessionTaint: ClassificationLevel,
): Promise<StoredWorkflow | null> {
  const raw = await storage.get(`${WORKFLOW_PREFIX}${name}`);
  if (!raw) return null;

  const stored = JSON.parse(raw) as StoredWorkflow;
  if (!canFlowTo(stored.classification, sessionTaint)) {
    log.warn("Workflow load denied: classification exceeds session taint", {
      operation: "loadWorkflowDefinition",
      workflow: name,
      workflowClassification: stored.classification,
      sessionTaint,
    });
    return null;
  }
  return stored;
}

async function listDefinitions(
  storage: StorageProvider,
  sessionTaint: ClassificationLevel,
): Promise<readonly StoredWorkflow[]> {
  const keys = await storage.list(WORKFLOW_PREFIX);
  const results: StoredWorkflow[] = [];

  for (const key of keys) {
    const raw = await storage.get(key);
    if (!raw) continue;
    const stored = JSON.parse(raw) as StoredWorkflow;
    if (canFlowTo(stored.classification, sessionTaint)) {
      results.push(stored);
    } else {
      log.warn(
        "Workflow filtered from listing: classification exceeds session taint",
        {
          operation: "listWorkflowDefinitions",
          workflow: stored.name,
          workflowClassification: stored.classification,
          sessionTaint,
        },
      );
    }
  }

  return results;
}

async function saveRun(
  storage: StorageProvider,
  result: WorkflowRunResult,
): Promise<void> {
  await storage.set(
    `${RUN_PREFIX}${result.runId}`,
    JSON.stringify(result),
  );
}

async function loadRun(
  storage: StorageProvider,
  runId: string,
  sessionTaint: ClassificationLevel,
): Promise<WorkflowRunResult | null> {
  const raw = await storage.get(`${RUN_PREFIX}${runId}`);
  if (!raw) return null;
  const run = JSON.parse(raw) as WorkflowRunResult;
  // Fail closed: an unclassified run is treated as RESTRICTED so it can
  // never be read down by a lower-taint session.
  const runClassification = run.classification ?? "RESTRICTED";
  if (!canFlowTo(runClassification, sessionTaint)) {
    log.warn("Workflow run load denied: classification exceeds session taint", {
      operation: "loadWorkflowRun",
      runId,
      runClassification,
      sessionTaint,
    });
    return null;
  }
  return run;
}

async function listRuns(
  storage: StorageProvider,
  sessionTaint: ClassificationLevel,
  options?: { readonly workflowName?: string; readonly limit?: number },
): Promise<readonly WorkflowRunResult[]> {
  const keys = await storage.list(RUN_PREFIX);
  const results: WorkflowRunResult[] = [];

  for (const key of keys) {
    const raw = await storage.get(key);
    if (!raw) continue;
    const run = JSON.parse(raw) as WorkflowRunResult;
    // Fail closed: unclassified runs are RESTRICTED for filtering purposes.
    const runClassification = run.classification ?? "RESTRICTED";
    if (!canFlowTo(runClassification, sessionTaint)) {
      log.warn(
        "Workflow run filtered from listing: classification exceeds session taint",
        {
          operation: "listWorkflowRuns",
          runId: run.runId,
          runClassification,
          sessionTaint,
        },
      );
      continue;
    }
    if (options?.workflowName && run.workflowName !== options.workflowName) {
      continue;
    }
    results.push(run);
  }

  results.sort((a, b) =>
    new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  if (options?.limit && results.length > options.limit) {
    return results.slice(0, options.limit);
  }

  return results;
}
