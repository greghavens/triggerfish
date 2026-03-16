/**
 * Workflow healing tool handlers — implementations for version management tools.
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { WorkflowVersionStore } from "../../workflow/healing/version_store.ts";
import type { WorkflowRunRegistry } from "../../workflow/registry_types.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("workflow-healing-tools");

/** Context needed by the workflow healing tool handlers. */
export interface WorkflowHealingToolContext {
  readonly versionStore: WorkflowVersionStore;
  readonly getSessionTaint: () => ClassificationLevel;
  readonly getUserId: () => string;
  readonly registry?: WorkflowRunRegistry;
}

/** List all versions for a workflow. */
export async function listWorkflowVersions(
  ctx: WorkflowHealingToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const workflowName = input.workflow_name as string | undefined;
  if (!workflowName) {
    return JSON.stringify({
      error: "workflow_version_list requires 'workflow_name' parameter",
    });
  }

  const taint = ctx.getSessionTaint();
  const versions = await ctx.versionStore.listWorkflowVersions(
    workflowName,
    taint,
  );

  const summary = versions.map((v) => ({
    versionId: v.versionId,
    versionNumber: v.versionNumber,
    status: v.status,
    source: v.source,
    authorReasoning: v.authorReasoning,
    proposedAt: v.proposedAt,
    resolvedAt: v.resolvedAt,
  }));

  return JSON.stringify({ versions: summary });
}

/** Approve a proposed version. */
export async function approveWorkflowVersion(
  ctx: WorkflowHealingToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const versionId = input.version_id as string | undefined;
  if (!versionId) {
    return JSON.stringify({
      error: "workflow_version_approve requires 'version_id' parameter",
    });
  }

  const reviewedBy = ctx.getUserId();
  log.info("Approving workflow version", {
    operation: "approveWorkflowVersion",
    versionId,
    reviewedBy,
  });

  const result = await ctx.versionStore.approveWorkflowVersion(
    versionId,
    reviewedBy,
  );
  if (!result.ok) {
    log.warn("Workflow version approval failed", {
      operation: "approveWorkflowVersion",
      versionId,
      reviewedBy,
      error: result.error,
    });
    return JSON.stringify({ error: result.error });
  }

  return JSON.stringify({
    approved: result.value.versionId,
    workflowName: result.value.workflowName,
    versionNumber: result.value.versionNumber,
  });
}

/** Reject a proposed version. */
export async function rejectWorkflowVersion(
  ctx: WorkflowHealingToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const versionId = input.version_id as string | undefined;
  const reason = input.reason as string | undefined;
  if (!versionId || !reason) {
    return JSON.stringify({
      error:
        "workflow_version_reject requires 'version_id' and 'reason' parameters",
    });
  }

  const reviewedBy = ctx.getUserId();
  log.info("Rejecting workflow version", {
    operation: "rejectWorkflowVersion",
    versionId,
    reviewedBy,
    reason,
  });

  const result = await ctx.versionStore.rejectWorkflowVersion(
    versionId,
    reviewedBy,
    reason,
  );
  if (!result.ok) {
    log.warn("Workflow version rejection failed", {
      operation: "rejectWorkflowVersion",
      versionId,
      reviewedBy,
      error: result.error,
    });
    return JSON.stringify({ error: result.error });
  }

  return JSON.stringify({
    rejected: result.value.versionId,
    workflowName: result.value.workflowName,
  });
}

/** Get healing status for a running workflow. */
export function queryHealingStatus(
  ctx: WorkflowHealingToolContext,
  input: Record<string, unknown>,
): Promise<string> {
  const runId = input.run_id as string | undefined;
  if (!runId) {
    return Promise.resolve(
      JSON.stringify({
        error: "workflow_healing_status requires 'run_id' parameter",
      }),
    );
  }

  if (!ctx.registry) {
    return Promise.resolve(
      JSON.stringify({ error: "Workflow run registry not available" }),
    );
  }

  const run = ctx.registry.getActiveRun(runId);
  if (!run) {
    return Promise.resolve(
      JSON.stringify({ error: `Workflow run not found: ${runId}` }),
    );
  }

  return Promise.resolve(JSON.stringify({
    runId: run.runId,
    workflowName: run.workflowName,
    status: run.status,
    currentTaskIndex: run.currentTaskIndex,
    currentTaskName: run.currentTaskName,
    paused: run.paused,
    taint: run.taint,
  }));
}

/** @deprecated Use listWorkflowVersions instead */
export const executeVersionList = listWorkflowVersions;
/** @deprecated Use approveWorkflowVersion instead */
export const executeVersionApprove = approveWorkflowVersion;
/** @deprecated Use rejectWorkflowVersion instead */
export const executeVersionReject = rejectWorkflowVersion;
/** @deprecated Use queryHealingStatus instead */
export const executeHealingStatus = queryHealingStatus;
