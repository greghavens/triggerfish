/** Assemble the opt-in recovery policy from operator settings. */
import { join } from "@std/path";
import type { TriggerFishConfig } from "../../../core/config_types.ts";
import type { ExecutionTraceApprovedPayload } from "../../../core/execution_traces.ts";
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
} from "../../agent_recovery.ts";
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
    const path = `/repos/${encodeURIComponent(owner)}/${
      encodeURIComponent(name)
    }/actions/workflows`;
    const selector = workflow
      ? `/${encodeURIComponent(workflow)}`
      : "?per_page=1";
    // Recheck Actions permission without executing the saved run-listing call.
    try {
      const response = await checkFetch(
        `https://api.github.com${path}${selector}`,
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

/** Build current access validation for the one saved historical payload type. */
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
        !repositories || payload.kind !== "github_actions_status" ||
        !Number.isSafeInteger(payload.repositoryId) || payload.repositoryId < 1
      ) {
        return false;
      }
      const policy = createWorkflowRecoveryPolicy({
        repositories,
        classification: () => prior,
        authorizeRepository: checkAccess,
      });
      if (
        !policy.projectCall({
          name: "github_actions",
          args: {
            action: "list_runs",
            repo: payload.repo,
            ...(payload.workflow !== undefined &&
              { workflow: payload.workflow }),
            ...(payload.perPage !== undefined && { per_page: payload.perPage }),
          },
        })
      ) return false;
      return await checkAccess(
        payload.repo,
        prior,
        payload.workflow,
        payload.repositoryId,
      );
    } catch {
      return false;
    }
  };
}

export function buildWorkflowRecoveryExecutor(
  config: TriggerFishConfig,
  baseDir: string,
  secretStore: SecretStore,
  classification?: () => ClassificationLevel,
): AgentRecoveryExecutor | undefined {
  const repositories = configuredWorkflowRepositories(config);
  if (!repositories) return undefined;
  const checkAccess = buildWorkflowMetadataAccess(
    config,
    secretStore,
    fetchGitHubMetadata,
  );
  const path = join(baseDir, "agent-recovery.db");
  return (id, orchestrator, options, control) =>
    runRecoverableAgentTurn(
      path,
      id,
      createWorkflowRecoveryPolicy({
        repositories,
        classification: classification ?? (() => options.targetClassification),
        authorizeRepository: checkAccess,
      }),
      orchestrator,
      options,
      control,
    );
}
