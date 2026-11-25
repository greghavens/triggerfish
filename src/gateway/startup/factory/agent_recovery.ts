import { withSentinelAssignmentRecovery } from "../../sentinel_assignment_recovery.ts";
import { isSentinelCaseId } from "../../../sentinel/cases.ts";
import { createHash } from "node:crypto";
import { selectSentinelScheduledObservationRead } from "../../../core/config_types.ts";
import {
  createScheduledObservationRead,
  matchesScheduledObservationProjection,
  scheduledObservationTool,
} from "../../scheduled_observation_tool.ts";
import type { AgentRecoveryPolicy } from "../../../core/agent_recovery.ts";
/** Assemble the opt-in recovery policy from operator settings. */
import { join } from "@std/path";
import type { TriggerFishConfig } from "../../../core/config_types.ts";
import {
  type ExecutionTraceApprovedPayload,
  executionTracePayloadCall,
} from "../../../core/execution_traces.ts";
import type { SecretStore } from "../../../core/secrets/keychain/keychain.ts";
import { safeFetchWithRedirects } from "../../../core/security/safe_fetch.ts";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../../../core/types/classification.ts";
import { resolveGitHubToken } from "../../../integrations/github/auth.ts";
import { createGitHubClient } from "../../../integrations/github/client.ts";
import {
  type AgentRecoveryExecutor,
  runRecoverableAgentTurn,
} from "../../../core/agent_recovery.ts";
import { createWorkflowRecoveryPolicy } from "../../workflow_recovery_policy.ts";

type GitHubWorkflowAuthorizationConfig = Pick<
  TriggerFishConfig,
  "agent_recovery" | "github"
>;

function configuredWorkflowRepositories(
  config: GitHubWorkflowAuthorizationConfig,
) {
  const repositories = config.agent_recovery?.github_repositories;
  if (repositories === undefined) return undefined;
  if (!Array.isArray(repositories) || !repositories.length) {
    throw new Error("Configure exact GitHub repositories for agent recovery.");
  }
  const baseUrl = config.github?.base_url;
  if (
    baseUrl !== undefined && baseUrl !== "https://api.github.com" &&
    baseUrl !== "https://api.github.com/"
  ) {
    throw new Error(
      "GitHub agent recovery requires the GitHub cloud endpoint.",
    );
  }
  return repositories;
}

const fetchGitHubMetadata: typeof fetch = async (url, options) => {
  if (url instanceof Request) throw new Error("Invalid recovery request.");
  const result = await safeFetchWithRedirects(
    url,
    {
      ...options,
      signal: AbortSignal.timeout(5000),
    },
    undefined,
    { maxRedirects: 0 },
  );
  if (!result.ok) throw new Error("Recovery access could not be verified.");
  return result.value;
};

function buildWorkflowMetadataAccess(
  config: GitHubWorkflowAuthorizationConfig,
  secretStore: SecretStore,
  checkFetch: typeof fetch,
) {
  return async (
    repo: string,
    prior: ClassificationLevel,
    workflow?: string,
    repositoryId?: number,
    metadataOnly = false,
    pullAccess = false,
    contentsProbe?: "branches" | "commits",
  ) => {
    const overrides = config.github?.classification_overrides as
      | Readonly<Record<string, ClassificationLevel>>
      | undefined;
    const credential = await resolveGitHubToken({ secretStore });
    if (!credential.ok) return false;
    const client = createGitHubClient({
      token: credential.value,
      classificationConfig: overrides ? { overrides } : undefined,
      fetchFn: checkFetch,
    });
    const [owner, name] = repo.split("/");
    const result = await client.getRepo(owner, name);
    if (
      !result.ok ||
      (repositoryId !== undefined && result.value.id !== repositoryId) ||
      result.value.fullName?.toLowerCase() !== repo.toLowerCase() ||
      !["public", "internal", "private"].includes(result.value.visibility) ||
      !canFlowTo(result.value.classification, prior)
    ) {
      return false;
    }
    if (metadataOnly) return true;
    const path = `/repos/${encodeURIComponent(owner)}/${
      encodeURIComponent(name)
    }/actions/workflows`;
    const selector = workflow
      ? `/${encodeURIComponent(workflow)}`
      : "?per_page=1";
    const permissionPath = contentsProbe
      ? `/repositories/${repositoryId}/${contentsProbe}?per_page=1`
      : pullAccess
      ? `/repos/${encodeURIComponent(owner)}/${
        encodeURIComponent(name)
      }/pulls?per_page=1`
      : path + selector;
    // Probe current repo permissions without repeating the saved operation.
    try {
      const response = await checkFetch(
        `https://api.github.com${permissionPath}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${credential.value}`,
          },
        },
      );
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  };
}

/** Build current access validation for approved historical payloads. */
export function buildExecutionTracePayloadAuthorizer(
  config: GitHubWorkflowAuthorizationConfig,
  secretStore: SecretStore,
  checkFetch: typeof fetch = fetchGitHubMetadata,
):
  | ((
    payload: ExecutionTraceApprovedPayload,
    prior: ClassificationLevel,
  ) => Promise<boolean>)
  | undefined {
  if (!configuredWorkflowRepositories(config)) return undefined;
  const checkAccess = buildWorkflowMetadataAccess(
    config,
    secretStore,
    checkFetch,
  );
  return async (payload, prior) => {
    try {
      const repositories = configuredWorkflowRepositories(config);
      if (
        !repositories ||
        !Number.isSafeInteger(payload.repositoryId) || payload.repositoryId < 1
      ) {
        return false;
      }
      const policy = createWorkflowRecoveryPolicy({
        repositories,
        repositoryStatus:
          config.agent_recovery?.github_repository_status === true,
        pullStatus: config.agent_recovery?.github_pull_status === true,
        releaseStatus: config.agent_recovery?.github_release_status === true,
        branchProtection:
          config.agent_recovery?.github_branch_protection === true,
        branchNames: config.agent_recovery?.github_branch_names,
        classification: () => prior,
        authorizeRepository: checkAccess,
      });
      if (
        !policy.projectCall(executionTracePayloadCall(payload))
      ) return false;
      if (
        payload.kind === "github_branch_protection" &&
        payload.approvedBranches?.some(
          ({ name }) =>
            !config.agent_recovery?.github_branch_names?.[payload.repo]
              ?.includes(name),
        )
      ) return false;
      return await checkAccess(
        payload.repo,
        prior,
        payload.kind === "github_actions_status" ? payload.workflow : undefined,
        payload.repositoryId,
        payload.kind === "github_repository_status",
        payload.kind === "github_pull_status",
        payload.kind === "github_release_status"
          ? "branches"
          : payload.kind === "github_branch_protection"
          ? "commits"
          : undefined,
      );
    } catch {
      return false;
    }
  };
}

export function buildWorkflowRecoveryExecutor(
  config: Pick<TriggerFishConfig, "agent_recovery" | "github" | "sentinel">,
  baseDir: string,
  secretStore: SecretStore,
  classification?: () => ClassificationLevel,
  cronJobId?: string,
  ownerChat = false,
): AgentRecoveryExecutor | undefined {
  const repositories = configuredWorkflowRepositories(config);
  const assignmentCases = ownerChat
    ? config.agent_recovery?.sentinel_assignment_cases
    : undefined;
  if (
    assignmentCases !== undefined &&
    (!Array.isArray(assignmentCases) ||
      !assignmentCases.every((id) =>
        typeof id === "string" && isSentinelCaseId(id)
      ))
  ) {
    throw new Error(
      "Configure exact Sentinel case IDs for assignment recovery.",
    );
  }
  if (!repositories && !assignmentCases?.length) return undefined;
  const checkAccess = buildWorkflowMetadataAccess(
    config,
    secretStore,
    fetchGitHubMetadata,
  );
  const path = join(baseDir, "agent-recovery.db");
  const grant = selectSentinelScheduledObservationRead(
    config.sentinel?.scheduled_observation_reads,
    cronJobId,
  );
  const authorizeObservation = grant &&
    buildExecutionTracePayloadAuthorizer(config, secretStore);
  const readObservation = grant && authorizeObservation &&
    createScheduledObservationRead(baseDir, grant, authorizeObservation);
  return (id, orchestrator, options, control) => {
    const github: AgentRecoveryPolicy = repositories
      ? createWorkflowRecoveryPolicy({
        repositories,
        repositoryStatus:
          config.agent_recovery?.github_repository_status === true,
        pullStatus: config.agent_recovery?.github_pull_status === true,
        releaseStatus: config.agent_recovery?.github_release_status === true,
        branchProtection:
          config.agent_recovery?.github_branch_protection === true,
        branchNames: config.agent_recovery?.github_branch_names,
        classification: classification ?? (() => options.targetClassification),
        authorizeRepository: checkAccess,
      })
      : {
        version: "owner-recovery-v1",
        classification: () => "INTERNAL",
        projectCall: () => undefined,
        projectResult: () => undefined,
        authorize: () => Promise.resolve(false),
      };
    const isObservation = (name: string) =>
      name === scheduledObservationTool.name;
    const policy: AgentRecoveryPolicy = grant && readObservation
      ? {
        ...github,
        version: `${github.version}:observation:${
          createHash("sha256").update(JSON.stringify(grant)).digest("hex")
        }`,
        projectCall: (call) =>
          isObservation(call.name)
            ? Object.keys(call.args).length === 0 ? {} : undefined
            : github.projectCall(call),
        projectResult: (call, text) =>
          isObservation(call.name)
            ? matchesScheduledObservationProjection(baseDir, grant, text)
              ? text
              : undefined
            : github.projectResult(call, text),
        authorize: async (receipt) => {
          if (!isObservation(receipt.name)) {
            return await github.authorize(
              receipt,
            );
          }
          if (
            !canFlowTo("INTERNAL", options.targetClassification) ||
            Object.keys(receipt.args).length
          ) return false;
          const result = await readObservation({});
          return !result.startsWith("Error:") &&
            createHash("sha256").update(result).digest("hex") ===
              receipt.resultSha256;
        },
        authorizeSavedProjection: (receipt, text) =>
          isObservation(receipt.name)
            ? matchesScheduledObservationProjection(baseDir, grant, text)
            : github.authorizeSavedProjection?.(receipt, text) ?? true,
      }
      : github;
    return runRecoverableAgentTurn(
      path,
      id,
      assignmentCases?.length
        ? withSentinelAssignmentRecovery(
          baseDir,
          new Set(assignmentCases),
          policy,
        )
        : policy,
      orchestrator,
      options,
      control,
    );
  };
}
