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
    const repositoryId = parsed.repositoryId;
    return JSON.stringify({
      runs,
      ...(Number.isSafeInteger(repositoryId) && repositoryId > 0 &&
        { repositoryId }),
    });
  } catch {
    return undefined;
  }
}

/** Verify current access separately from the completed Actions call. */
export function createWorkflowRecoveryPolicy(options: {
  readonly repositories: readonly string[];
  readonly classification: () => ClassificationLevel;
  readonly repositoryStatus?: boolean;
  readonly pullStatus?: boolean;
  readonly authorizeRepository: (
    repo: string,
    classification: ClassificationLevel,
    workflow: string | undefined,
    repositoryId: number,
    metadataOnly?: boolean,
    pullAccess?: boolean,
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
  const projectCall = (
    { name, args }: { name: string; args: Record<string, unknown> },
  ) => {
    if (
      args.action === "get" && typeof args.repo === "string" &&
      repos.has(args.repo)
    ) {
      if (
        options.repositoryStatus && name === "github_repos" &&
        Object.keys(args).length === 2
      ) {
        return { action: "get", repo: args.repo };
      }
      if (
        options.pullStatus && name === "github_pulls" &&
        Object.keys(args).length === 3 &&
        typeof args.pr_number === "number" &&
        Number.isSafeInteger(args.pr_number) &&
        args.pr_number > 0
      ) {
        return { action: "get", repo: args.repo, pr_number: args.pr_number };
      }
    }
    return approvedWorkflowArgs(name, args, repos);
  };
  function projectPullStatus(number: number, text: string): string | undefined {
    if (text.length > 512_000) return;
    try {
      const result = JSON.parse(text);
      const { repositoryId, state, mergeable } = result;
      if (
        result.number !== number || !Number.isSafeInteger(repositoryId) ||
        repositoryId < 1 || (state !== "open" && state !== "closed") ||
        (mergeable !== null && typeof mergeable !== "boolean")
      ) return;
      return JSON.stringify({ number, repositoryId, state, mergeable });
    } catch {
      return undefined;
    }
  }
  function projectRepositoryStatus(
    repo: string,
    text: string,
  ): string | undefined {
    if (text.length > 512_000) return;
    try {
      const { name, repositoryId, visibility } = JSON.parse(text);
      if (
        typeof name !== "string" || name.toLowerCase() !== repo.toLowerCase() ||
        !Number.isSafeInteger(repositoryId) || repositoryId < 1 ||
        !["public", "internal", "private"].includes(visibility)
      ) return;
      return JSON.stringify({ name: repo, repositoryId, visibility });
    } catch {
      return undefined;
    }
  }
  return {
    version: "github-actions-status-v1",
    classification: options.classification,
    projectCall,
    projectResult(call, text) {
      const args = projectCall(call);
      if (!args) return;
      if (typeof args.pr_number === "number") {
        return projectPullStatus(args.pr_number, text);
      }
      return args.action === "get"
        ? projectRepositoryStatus(String(args.repo), text)
        : projectWorkflowStatus(text);
    },
    resultResourceId(projected) {
      return JSON.parse(projected).repositoryId;
    },
    projectTracePayload(call, projected) {
      const args = projectCall(call);
      if (typeof args?.pr_number === "number") {
        const safe = projectPullStatus(args.pr_number, projected);
        if (safe !== projected || !safe) return;
        return {
          kind: "github_pull_status",
          repo: String(args.repo),
          ...JSON.parse(safe),
        };
      }
      if (args?.action === "get") {
        const safe = projectRepositoryStatus(String(args.repo), projected);
        if (safe !== projected) return;
        const { repositoryId, visibility } = JSON.parse(safe);
        return {
          kind: "github_repository_status",
          repo: String(args.repo),
          repositoryId,
          visibility,
        };
      }
      const safe = projectWorkflowStatus(projected);
      if (!args || !safe || safe !== projected) return undefined;
      const { runs, repositoryId } = JSON.parse(safe);
      if (!Number.isSafeInteger(repositoryId) || repositoryId < 1) {
        return undefined;
      }
      return {
        kind: "github_actions_status",
        repo: String(args.repo),
        repositoryId,
        ...(typeof args.workflow === "string" && { workflow: args.workflow }),
        ...(typeof args.per_page === "number" && { perPage: args.per_page }),
        runs,
      };
    },

    authorize(receipt) {
      const args = projectCall(receipt);
      if (!args || receipt.resourceId === undefined) {
        return Promise.resolve(false);
      }
      return options.authorizeRepository(
        String(args.repo),
        receipt.classification,
        typeof args.workflow === "string" ? args.workflow : undefined,
        receipt.resourceId,
        args.action === "get" && typeof args.pr_number !== "number",
        typeof args.pr_number === "number",
      );
    },
  };
}
