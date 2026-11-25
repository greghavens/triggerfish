/** Durable projection for an explicitly approved GitHub Actions status read. */
import type { AgentRecoveryPolicy } from "./agent_recovery.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";

const statuses = new Set([
  "queued",
  "in_progress",
  "completed",
  "requested",
  "waiting",
  "pending",
]);
const conclusions = new Set([
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "success",
  "timed_out",
  "startup_failure",
]);
const repoPattern = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;
const workflowPattern = /^(?:[1-9][0-9]{0,11}|[a-zA-Z0-9_.-]{1,100}\.ya?ml)$/;

function approvedWorkflowArgs(
  name: string,
  args: Record<string, unknown>,
  repositories: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (
    name !== "github_actions" || args.action !== "list_runs" ||
    typeof args.repo !== "string" || !repositories.has(args.repo) ||
    args.workflow !== undefined &&
      (typeof args.workflow !== "string" ||
        !workflowPattern.test(args.workflow)) ||
    args.per_page !== undefined &&
      (typeof args.per_page !== "number" ||
        !Number.isSafeInteger(args.per_page) ||
        args.per_page < 1 || args.per_page > 100) ||
    Object.keys(args).some((key) =>
      key !== "action" && key !== "repo" && key !== "workflow" &&
      key !== "per_page"
    )
  ) return undefined;
  return {
    action: "list_runs",
    repo: args.repo,
    ...(args.workflow !== undefined && { workflow: args.workflow }),
    ...(args.per_page !== undefined && { per_page: args.per_page }),
  };
}

function projectWorkflowStatus(text: string): string | undefined {
  if (text.length > 512_000) return;
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.runs) || parsed.runs.length > 100) return;
    const runs = [];
    for (const value of parsed.runs) {
      if (
        !value || !Number.isSafeInteger(value.id) || value.id < 1 ||
        !statuses.has(value.status) ||
        (value.conclusion !== null && !conclusions.has(value.conclusion))
      ) {
        return;
      }
      runs.push({
        id: value.id,
        status: value.status,
        conclusion: value.conclusion,
      });
    }
    return JSON.stringify({ runs });
  } catch {
    return undefined;
  }
}

/** Verify current access separately from the completed Actions call. */
export function createWorkflowRecoveryPolicy(options: {
  readonly repositories: readonly string[];
  readonly classification: () => ClassificationLevel;
  readonly authorizeRepository: (
    repo: string,
    classification: ClassificationLevel,
    workflow?: string,
  ) => Promise<boolean>;
}): AgentRecoveryPolicy {
  if (
    !options.repositories.length || options.repositories.length > 64 ||
    options.repositories.some((repo) =>
      !repoPattern.test(repo) || /\/(?:\.|\.\.)$/.test(repo)
    )
  ) {
    throw new Error(
      "Agent recovery requires approved GitHub repository names.",
    );
  }
  const repos = new Set(options.repositories);
  return {
    version: "github-actions-status-v1",
    classification: options.classification,
    projectCall: ({ name, args }) => approvedWorkflowArgs(name, args, repos),
    projectResult: (_call, text) => projectWorkflowStatus(text),
    authorize(receipt) {
      const args = approvedWorkflowArgs(receipt.name, receipt.args, repos);
      if (!args) return Promise.resolve(false);
      return options.authorizeRepository(
        String(args.repo),
        receipt.classification,
        typeof args.workflow === "string" ? args.workflow : undefined,
      );
    },
  };
}
