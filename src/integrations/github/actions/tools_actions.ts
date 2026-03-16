/**
 * GitHub Actions tool handlers — workflow runs, trigger, cancel.
 *
 * Each handler validates inputs, calls the GitHubClient, and
 * formats the response as a JSON string for the agent.
 *
 * @module
 */

import type { GitHubClient } from "../client.ts";
import {
  assertPositiveIntValue,
  assertValidRepoInput,
  formatGitHubError,
} from "../tools_shared.ts";

/** Validate that a value is a Record<string, string> (all values are strings). */
function validateStringRecord(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  for (const v of Object.values(obj)) {
    if (typeof v !== "string") return undefined;
  }
  return obj as Readonly<Record<string, string>>;
}

// ─── List Workflow Runs ──────────────────────────────────────────────────────

/** Handle the github_list_runs tool invocation. */
export async function listGitHubWorkflowRuns(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_list_runs");
  if (typeof repoResult === "string") return repoResult;

  const workflow = typeof input.workflow === "string"
    ? input.workflow
    : undefined;
  const branch = typeof input.branch === "string" ? input.branch : undefined;
  const perPage = typeof input.per_page === "number"
    ? input.per_page
    : undefined;
  const result = await client.listWorkflowRuns(
    repoResult.owner,
    repoResult.name,
    { workflow, branch, perPage },
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    runs: result.value.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      branch: r.headBranch,
      url: r.htmlUrl,
      _classification: r.classification,
    })),
  });
}

/** @deprecated Use listGitHubWorkflowRuns instead */
export const executeListRuns = listGitHubWorkflowRuns;

// ─── Trigger Workflow ────────────────────────────────────────────────────────

/** Handle the github_trigger_workflow tool invocation. */
export async function triggerGitHubWorkflow(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_trigger_workflow");
  if (typeof repoResult === "string") return repoResult;

  const workflow = input.workflow;
  if (typeof workflow !== "string" || workflow.length === 0) {
    return "Error: github_trigger_workflow requires a 'workflow' argument.";
  }
  const ref = input.ref;
  if (typeof ref !== "string" || ref.length === 0) {
    return "Error: github_trigger_workflow requires a 'ref' argument.";
  }
  const inputs = validateStringRecord(input.inputs);

  const result = await client.triggerWorkflow(
    repoResult.owner,
    repoResult.name,
    workflow,
    ref,
    inputs,
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    triggered: result.value.triggered,
    _classification: result.value.classification,
  });
}

/** @deprecated Use triggerGitHubWorkflow instead */
export const executeTriggerWorkflow = triggerGitHubWorkflow;

// ─── Cancel Workflow Run ──────────────────────────────────────────────────────

/** Handle the github_cancel_run tool invocation. */
export async function cancelGitHubWorkflowRun(
  client: GitHubClient,
  input: Record<string, unknown>,
): Promise<string> {
  const repoResult = assertValidRepoInput(input, "github_cancel_run");
  if (typeof repoResult === "string") return repoResult;

  const runId = assertPositiveIntValue(
    input.run_id,
    "run_id",
    "github_cancel_run",
  );
  if (typeof runId === "string") return runId;

  const result = await client.cancelRun(
    repoResult.owner,
    repoResult.name,
    runId,
  );
  if (!result.ok) return formatGitHubError(result.error);
  return JSON.stringify({
    cancelled: result.value.cancelled,
    _classification: result.value.classification,
  });
}

/** @deprecated Use cancelGitHubWorkflowRun instead */
export const executeCancelRun = cancelGitHubWorkflowRun;
