/**
 * Workflow version store — full-snapshot versioning with approval lifecycle.
 * Validation logic lives in version_validation.ts; record persistence in version_records.ts.
 * @module
 */

import type { StorageProvider } from "../../core/storage/provider.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import { canFlowTo } from "../../core/types/classification.ts";
import { createLogger } from "../../core/logger/logger.ts";
import type { ParseResult } from "../parser.ts";
import { err, ok, parseWorkflowYaml } from "../parser.ts";
import type { WorkflowStore } from "../store.ts";
import type { WorkflowVersion } from "./types.ts";
import { validateConfigImmutability } from "./version_validation.ts";
import {
  computeNextVersionNumber,
  loadVersionRecordById,
  saveVersionRecord,
  supersedeExistingProposals,
  versionKeyPrefix,
  type VersionRecord,
  workflowVersionKeyPrefix,
} from "./version_records.ts";

const log = createLogger("workflow-version-store");

/** Options for proposing a new workflow version. */
export interface ProposeVersionOptions {
  readonly workflowName: string;
  readonly agentId: string;
  readonly definition: string;
  readonly diff: string;
  readonly source: "human" | "self_healing";
  readonly authorReasoning: string;
  readonly runId?: string;
  readonly classification: ClassificationLevel;
}

/** Workflow version store for proposal/approval lifecycle. */
export interface WorkflowVersionStore {
  /** Create a PROPOSED version. Validates config immutability for self_healing source. */
  proposeWorkflowVersion(
    options: ProposeVersionOptions,
  ): Promise<ParseResult<WorkflowVersion>>;

  /** Approve a proposed version — saves to main WorkflowStore and supersedes prior. */
  approveWorkflowVersion(
    versionId: string,
    reviewedBy: string,
  ): Promise<ParseResult<WorkflowVersion>>;

  /** Reject a proposed version — preserved for future lead context. */
  rejectWorkflowVersion(
    versionId: string,
    reviewedBy: string,
    reason: string,
  ): Promise<ParseResult<WorkflowVersion>>;

  /** List all versions for a workflow, filtered by classification. */
  listWorkflowVersions(
    workflowName: string,
    sessionTaint: ClassificationLevel,
  ): Promise<readonly WorkflowVersion[]>;

  /** Load a single version by ID, filtered by classification. */
  loadWorkflowVersion(
    versionId: string,
    sessionTaint: ClassificationLevel,
  ): Promise<WorkflowVersion | null>;

  /** Load all REJECTED proposals for a workflow (for lead context). */
  loadRejectedProposals(
    workflowName: string,
  ): Promise<readonly WorkflowVersion[]>;
}

/** Create a WorkflowVersionStore backed by StorageProvider. */
export function createWorkflowVersionStore(options: {
  readonly storage: StorageProvider;
  readonly workflowStore: WorkflowStore;
}): WorkflowVersionStore {
  const { storage, workflowStore } = options;

  return {
    proposeWorkflowVersion: (opts) =>
      proposeVersion(storage, workflowStore, opts),
    approveWorkflowVersion: (id, by) =>
      approveVersion(storage, workflowStore, id, by),
    rejectWorkflowVersion: (id, by, reason) =>
      rejectVersion(storage, id, by, reason),
    listWorkflowVersions: (name, taint) => listVersions(storage, name, taint),
    loadWorkflowVersion: (id, taint) => loadVersion(storage, id, taint),
    loadRejectedProposals: (name) => loadRejected(storage, name),
  };
}

async function proposeVersion(
  storage: StorageProvider,
  workflowStore: WorkflowStore,
  opts: ProposeVersionOptions,
): Promise<ParseResult<WorkflowVersion>> {
  if (opts.source === "self_healing") {
    const configCheck = await validateConfigImmutability(
      workflowStore,
      opts.workflowName,
      opts.definition,
      opts.classification,
    );
    if (!configCheck.ok) return configCheck;
  }

  const versionNumber = await computeNextVersionNumber(
    storage,
    opts.workflowName,
  );

  await supersedeExistingProposals(storage, opts.workflowName);

  const version: WorkflowVersion = {
    versionId: crypto.randomUUID(),
    workflowName: opts.workflowName,
    agentId: opts.agentId,
    versionNumber,
    definition: opts.definition,
    diff: opts.diff,
    status: "PROPOSED",
    source: opts.source,
    authorReasoning: opts.authorReasoning,
    runId: opts.runId,
    proposedAt: new Date().toISOString(),
  };

  await saveVersionRecord(storage, version, opts.classification);

  log.info("Workflow version proposed", {
    operation: "proposeWorkflowVersion",
    workflowName: opts.workflowName,
    versionId: version.versionId,
    versionNumber,
    source: opts.source,
  });

  return ok(version);
}

async function approveVersion(
  storage: StorageProvider,
  workflowStore: WorkflowStore,
  versionId: string,
  reviewedBy: string,
): Promise<ParseResult<WorkflowVersion>> {
  const record = await loadVersionRecordById(storage, versionId);
  if (!record) {
    return err(`Workflow version not found: ${versionId}`);
  }

  if (record.version.status !== "PROPOSED") {
    return err(
      `Workflow version cannot be approved: current status is ${record.version.status}`,
    );
  }

  const approved: WorkflowVersion = {
    ...record.version,
    status: "APPROVED",
    resolvedAt: new Date().toISOString(),
    resolvedBy: reviewedBy,
  };

  await saveVersionRecord(storage, approved, record.classification);

  const parsed = parseWorkflowYaml(approved.definition);
  if (parsed.ok) {
    await workflowStore.saveWorkflowDefinition(
      approved.workflowName,
      approved.definition,
      record.classification,
    );
  } else {
    log.warn("Approved workflow version has unparseable YAML definition", {
      operation: "approveWorkflowVersion",
      versionId,
      workflowName: approved.workflowName,
      parseError: parsed.error,
    });
  }

  log.info("Workflow version approved", {
    operation: "approveWorkflowVersion",
    versionId,
    workflowName: approved.workflowName,
    reviewedBy,
  });

  return ok(approved);
}

async function rejectVersion(
  storage: StorageProvider,
  versionId: string,
  reviewedBy: string,
  reason: string,
): Promise<ParseResult<WorkflowVersion>> {
  const record = await loadVersionRecordById(storage, versionId);
  if (!record) {
    return err(`Workflow version not found: ${versionId}`);
  }

  if (record.version.status !== "PROPOSED") {
    return err(
      `Workflow version cannot be rejected: current status is ${record.version.status}`,
    );
  }

  const rejected: WorkflowVersion = {
    ...record.version,
    status: "REJECTED",
    resolvedAt: new Date().toISOString(),
    resolvedBy: `${reviewedBy}: ${reason}`,
  };

  await saveVersionRecord(storage, rejected, record.classification);

  log.info("Workflow version rejected", {
    operation: "rejectWorkflowVersion",
    versionId,
    workflowName: rejected.workflowName,
    reviewedBy,
    reason,
  });

  return ok(rejected);
}

async function listVersions(
  storage: StorageProvider,
  workflowName: string,
  sessionTaint: ClassificationLevel,
): Promise<readonly WorkflowVersion[]> {
  const keys = await storage.list(workflowVersionKeyPrefix(workflowName));
  const versions: WorkflowVersion[] = [];

  for (const key of keys) {
    const raw = await storage.get(key);
    if (!raw) continue;
    const record = JSON.parse(raw) as VersionRecord;
    if (!canFlowTo(record.classification, sessionTaint)) {
      log.debug(
        "Workflow version filtered: classification exceeds session taint",
        {
          operation: "listWorkflowVersions",
          versionId: record.version.versionId,
          classification: record.classification,
          sessionTaint,
        },
      );
      continue;
    }
    versions.push(record.version);
  }

  return versions.sort((a, b) => b.versionNumber - a.versionNumber);
}

async function loadVersion(
  storage: StorageProvider,
  versionId: string,
  sessionTaint: ClassificationLevel,
): Promise<WorkflowVersion | null> {
  const keys = await storage.list(versionKeyPrefix());
  for (const key of keys) {
    if (!key.includes(versionId)) continue;
    const raw = await storage.get(key);
    if (!raw) continue;
    const record = JSON.parse(raw) as VersionRecord;
    if (record.version.versionId !== versionId) continue;
    if (!canFlowTo(record.classification, sessionTaint)) {
      log.warn(
        "Workflow version load denied: classification exceeds session taint",
        {
          operation: "loadWorkflowVersion",
          versionId,
          classification: record.classification,
          sessionTaint,
        },
      );
      return null;
    }
    return record.version;
  }
  return null;
}

async function loadRejected(
  storage: StorageProvider,
  workflowName: string,
): Promise<readonly WorkflowVersion[]> {
  const keys = await storage.list(workflowVersionKeyPrefix(workflowName));
  const rejected: WorkflowVersion[] = [];

  for (const key of keys) {
    const raw = await storage.get(key);
    if (!raw) continue;
    const record = JSON.parse(raw) as VersionRecord;
    if (record.version.status === "REJECTED") {
      rejected.push(record.version);
    }
  }

  return rejected.sort((a, b) => b.versionNumber - a.versionNumber);
}
