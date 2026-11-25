import { withRecoveredDelegatedGoalPolicy } from "./recovered_delegated_goal.ts";
import { configuredSentinelWorkflowReader } from "./sentinel_workflow_source.ts";
import { withGitHubCancellationRecovery } from "../../github_cancellation_recovery.ts";
import type { OwnerAgentRecoveryExecutor } from "../../chat_session_config.ts";
import {
  withExecutionChecklistRecoveryPolicy,
  withExecutionChecklistScope,
} from "../../execution_checklist_recovery.ts";
import { openExecutionTraces } from "../../../core/execution_traces.ts";
import type { SessionId } from "../../../core/types/session.ts";
import { teamDeliveryExecutionId } from "./delegated_agent_recovery.ts";
import { readAuthorizedSentinelCaseEvidence } from "../../operator_run_tool.ts";
import {
  exactExecutionRecheckCandidate,
  executionControlReceipt,
} from "../../sentinel_execution_rechecks.ts";
import { resolveSentinelCasePath } from "../../../sentinel/cases.ts";
import { readSentinelAssessment } from "../../../sentinel/assessment_store.ts";
import { withSentinelAssignmentRecovery } from "../../sentinel_assignment_recovery.ts";
import { isSentinelCaseId } from "../../../sentinel/cases.ts";
import { createHash } from "node:crypto";
import {
  type DelegatedObservationSource,
  type ScheduledObservationSource,
  selectSentinelDelegatedObservationRead,
  selectSentinelScheduledObservationRead,
  selectSentinelTeamObservationRead,
  sentinelLocalObservationKind,
  type TeamObservationSource,
} from "../../../core/config_types.ts";
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
import { runRecoverableAgentTurn } from "../../../core/agent_recovery.ts";
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
      signal: options?.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)])
        : AbortSignal.timeout(5000),
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
        runStatus: config.agent_recovery?.github_run_status === true,
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
  config: Pick<
    TriggerFishConfig,
    "agent_recovery" | "github" | "sentinel" | "delegated_goal_completion"
  >,
  baseDir: string,
  secretStore: SecretStore,
  classification?: () => ClassificationLevel,
  observationSource?:
    | ScheduledObservationSource
    | DelegatedObservationSource
    | TeamObservationSource
    | string,
  ownerChat = false,
  recheckSources:
    & Omit<
      Parameters<typeof readAuthorizedSentinelCaseEvidence>[0],
      "baseDir"
    >
    & {
      readonly githubFetch?: typeof fetch;
      readonly authorizeObservationScope?: () => Promise<boolean>;
      readonly checklistRole?: "delegated" | "scheduled" | "team";
    } = {},
): OwnerAgentRecoveryExecutor | undefined {
  if (
    typeof observationSource === "object" &&
    "ownerSessionId" in observationSource &&
    !recheckSources.authorizeObservationScope
  ) return;
  const repositories = configuredWorkflowRepositories(config);
  const ownerChecklists = ownerChat &&
    config.agent_recovery?.owner_checklists === true;
  const backgroundChecklistRole = !ownerChat &&
      config.agent_recovery?.background_checklists === true
    ? recheckSources.checklistRole
    : undefined;
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
  const cancelTargets = ownerChat
    ? config.agent_recovery?.github_cancel_runs
    : undefined;
  if (cancelTargets !== undefined) {
    if (
      !Array.isArray(cancelTargets) || cancelTargets.length > 64 ||
      cancelTargets.some((entry) =>
        !entry || !repositories?.includes(entry.repo) ||
        [entry.repository_id, entry.run_id, entry.attempt].some((value) =>
          !Number.isSafeInteger(value) || value < 1
        )
      ) || new Set(cancelTargets.map(({ repo, run_id }) =>
          `${repo}:${run_id}`
        )).size !== cancelTargets.length
    ) {
      throw new Error(
        "Configure exact approved repository, run and attempt identities for cancellation recovery.",
      );
    }
  }
  const checkAccess = buildWorkflowMetadataAccess(
    config,
    secretStore,
    recheckSources.githubFetch ?? fetchGitHubMetadata,
  );
  const path = join(baseDir, "agent-recovery.db");
  const grant = observationSource && typeof observationSource === "object" &&
      ("ownerSessionId" in observationSource ||
        "parentSessionId" in observationSource)
    ? "ownerSessionId" in observationSource
      ? selectSentinelTeamObservationRead(
        config.sentinel?.team_observation_reads,
        observationSource,
      )
      : selectSentinelDelegatedObservationRead(
        config.sentinel?.delegated_observation_reads,
        observationSource,
      )
    : selectSentinelScheduledObservationRead(
      config.sentinel?.scheduled_observation_reads,
      observationSource,
    );
  const localObservation = grant &&
    sentinelLocalObservationKind(grant.observation_id);
  if (
    !repositories && !assignmentCases?.length && !localObservation &&
    !ownerChecklists && !backgroundChecklistRole
  ) return;
  const authorizeObservation = grant
    ? buildExecutionTracePayloadAuthorizer(
      config,
      secretStore,
      recheckSources.githubFetch,
    )
    : undefined;
  const readObservation = grant && (authorizeObservation || localObservation) &&
    createScheduledObservationRead(
      baseDir,
      grant,
      authorizeObservation,
      recheckSources.authorizeObservationScope,
      localObservation === "finding_recheck" || localObservation === "finding"
        ? recheckSources.readLiveWorkflow ??
          configuredSentinelWorkflowReader(config, baseDir, () => secretStore)
        : undefined,
    );
  const { readLiveWorkflow, authorizeExecutionTracePayload } = recheckSources;
  return async (id, orchestrator, options, control, ownerContext) => {
    const github: AgentRecoveryPolicy = repositories
      ? createWorkflowRecoveryPolicy({
        repositories,
        repositoryStatus:
          config.agent_recovery?.github_repository_status === true,
        pullStatus: config.agent_recovery?.github_pull_status === true,
        runStatus: config.agent_recovery?.github_run_status === true,
        releaseStatus: config.agent_recovery?.github_release_status === true,
        branchProtection:
          config.agent_recovery?.github_branch_protection === true,
        branchNames: config.agent_recovery?.github_branch_names,
        classification: classification ?? (() => options.targetClassification),
        authorizeRepository: checkAccess,
      })
      : {
        version: "owner-recovery-v1",
        classification: () =>
          localObservation || ownerChecklists || backgroundChecklistRole
            ? options.targetClassification
            : "INTERNAL",
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
        authorize: async (receipt, sourceAuthorization) => {
          if (!isObservation(receipt.name)) {
            return await github.authorize(
              receipt,
            );
          }
          if (
            !canFlowTo("INTERNAL", options.targetClassification) ||
            Object.keys(receipt.args).length
          ) return false;
          const result = await readObservation({}, sourceAuthorization);
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
    const withCancellation = cancelTargets?.length
      ? withGitHubCancellationRecovery(
        policy,
        cancelTargets,
        async (target, signal) => {
          const credential = await resolveGitHubToken({ secretStore });
          if (!credential.ok || signal?.aborted) return;
          const overrides = config.github?.classification_overrides as
            | Readonly<Record<string, ClassificationLevel>>
            | undefined;
          const client = createGitHubClient({
            token: credential.value,
            classificationConfig: overrides ? { overrides } : undefined,
            fetchFn: (url, init) =>
              (recheckSources.githubFetch ?? fetchGitHubMetadata)(url, {
                ...init,
                signal,
              }),
          });
          const [owner, repo] = target.repo.split("/");
          const result = await client.getWorkflowRun(
            owner,
            repo,
            target.run_id,
          );
          return result.ok ? result.value : undefined;
        },
      )
      : policy;
    const baseExecutionPolicy = assignmentCases?.length
      ? withSentinelAssignmentRecovery(
        baseDir,
        new Set(assignmentCases),
        withCancellation,
        ownerContext && (readLiveWorkflow || authorizeExecutionTracePayload)
          ? async ({ caseId, runId, revision, evidenceId, findingId }) => {
            const path = resolveSentinelCasePath(baseDir, caseId);
            function current() {
              if (options.signal?.aborted) return;
              const state = readSentinelAssessment(path);
              if (
                state?.active && state.revision === revision &&
                state.plan.runId === runId
              ) return state;
            }
            const evidence = await readAuthorizedSentinelCaseEvidence(
              {
                baseDir,
                readLiveWorkflow,
                authorizeExecutionTracePayload,
              },
              caseId,
              path,
              revision,
              evidenceId,
              ownerContext,
              () => !!current(),
              options.signal,
            );
            const proof = evidence &&
              executionControlReceipt(evidence.payload);
            const state = current();
            return !!(proof && state &&
              exactExecutionRecheckCandidate(
                path,
                state,
                evidenceId,
                findingId,
                proof,
              ));
          }
          : undefined,
      )
      : withCancellation;
    const executionPolicy =
      !ownerChat && recheckSources.checklistRole === "delegated" &&
        repositories &&
        config.delegated_goal_completion?.some(({ criteria }) =>
          criteria.some(({ kind }) => kind === "subagent")
        )
        ? withRecoveredDelegatedGoalPolicy(
          baseExecutionPolicy,
          baseDir,
          id,
          options.session.id,
        )
        : baseExecutionPolicy;
    const checklistRole = ownerChecklists
      ? "owner_chat"
      : backgroundChecklistRole === "team"
      ? "delegated"
      : backgroundChecklistRole;
    if (checklistRole) {
      if (
        ownerChecklists &&
        ownerContext?.ownerRecoverySessionId !== options.session.id
      ) {
        return Promise.resolve({
          ok: false,
          error: "Owner recovery authorization is unavailable.",
        });
      }
      const checklistPath = ownerChecklists
        ? path
        : join(baseDir, "execution-traces.db");
      const teamScope = backgroundChecklistRole === "team" &&
          observationSource && typeof observationSource === "object" &&
          "ownerSessionId" in observationSource
        ? observationSource
        : undefined;
      const isCurrent = backgroundChecklistRole === "team"
        ? async () => {
          if (
            !teamScope || options.signal?.aborted ||
            teamScope.memberSessionId !== options.session.id
          ) return false;
          return id === await teamDeliveryExecutionId(
                teamScope.ownerSessionId as SessionId,
                options.session.id,
                teamScope.deliveryId,
              ) && await recheckSources.authorizeObservationScope?.() === true;
        }
        : backgroundChecklistRole
        ? () => {
          if (options.signal?.aborted) return false;
          try {
            const journal = openExecutionTraces(checklistPath);
            try {
              const current = journal.readRun(
                backgroundChecklistRole,
                id,
                options.targetClassification,
              );
              return current?.status === "running" &&
                current.scope.sessionId === options.session.id &&
                !current.operatorCancelled;
            } finally {
              journal.close();
            }
          } catch {
            return false;
          }
        }
        : undefined;
      if (await isCurrent?.() === false) {
        return Promise.resolve({
          ok: false,
          error:
            "The background execution checklist is outside current admission.",
        });
      }
      if (teamScope) {
        try {
          // Initialize the trace schema before the checklist opens this database.
          openExecutionTraces(checklistPath).close();
        } catch {
          return {
            ok: false,
            error: "The team execution checklist is unavailable.",
          };
        }
      }
      const scope = {
        role: checklistRole,
        sessionId: options.session.id,
        runId: id,
        ceiling: options.targetClassification,
        signal: options.signal,
        path: checklistPath,
        isCurrent,
      } as const;
      return withExecutionChecklistScope(scope, () =>
        runRecoverableAgentTurn(
          path,
          id,
          withExecutionChecklistRecoveryPolicy(executionPolicy, scope),
          orchestrator,
          teamScope && isCurrent
            ? {
              ...options,
              async workerBoundary(phase) {
                if (!await isCurrent()) return { stop: true };
                return await options.workerBoundary?.(phase) ?? {};
              },
            }
            : options,
          control,
        ));
    }
    return runRecoverableAgentTurn(
      path,
      id,
      executionPolicy,
      orchestrator,
      options,
      control,
    );
  };
}
