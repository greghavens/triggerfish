/** Bind live workflow telemetry to an operator-configured Sentinel assignment. */
import { createHash } from "node:crypto";
import type { TriggerFishConfig } from "../core/config_types.ts";
import type { SsrfChecker } from "../core/security/safe_fetch.ts";
import type { SentinelGitHubWorkflowReadReceipt } from "../sentinel/assessment_store.ts";
import {
  readSentinelGitHubWorkflowRuns,
  sentinelGitHubWorkflowMetadataUrl,
  sentinelGitHubWorkflowRunsUrl,
  verifySentinelGitHubWorkflowAccess,
} from "../sentinel/github_workflow_runs.ts";

type WorkflowReads = NonNullable<
  TriggerFishConfig["sentinel"]
>["github_workflow_reads"];

interface WorkflowReadRequest {
  readonly caseId: string;
  readonly assetId: string;
  readonly evidenceRevision: number;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly loadSaved?: () => SentinelGitHubWorkflowReadReceipt | undefined;
  readonly resumeOnly?: boolean;
  readonly saveResult?: (
    receipt: SentinelGitHubWorkflowReadReceipt,
  ) => SentinelGitHubWorkflowReadReceipt | undefined;
  readonly authorize: (destination: {
    url: string;
    caseId: string;
    repository: string;
    workflowId: number;
  }) => Promise<boolean>;
}

export function createSentinelLiveWorkflowReader(options: {
  readonly scopes: WorkflowReads;
  readonly resolveToken: () => Promise<string | undefined>;
  readonly ssrfChecker: SsrfChecker;
  readonly readRuns?: typeof readSentinelGitHubWorkflowRuns;
  readonly verifyAccess?: typeof verifySentinelGitHubWorkflowAccess;
}) {
  return async (
    request: WorkflowReadRequest,
  ): Promise<SentinelGitHubWorkflowReadReceipt | undefined> => {
    const scope = options.scopes?.find((entry) =>
      entry.case === request.caseId && entry.asset === request.assetId
    );
    if (!scope || request.signal.aborted || !request.isCurrent()) return;
    const target = {
      owner: scope.owner,
      repo: scope.repo,
      workflowId: scope.workflow_id,
    };
    const repository = `${target.owner}/${target.repo}`;
    try {
      const saved = request.loadSaved?.();
      if (
        saved
          ? saved.repository !== repository ||
            saved.workflowId !== target.workflowId ||
            saved.evidenceRevision !== request.evidenceRevision
          : request.resumeOnly
      ) return;
      if (
        !await request.authorize({
          url: saved
            ? sentinelGitHubWorkflowMetadataUrl(target)
            : sentinelGitHubWorkflowRunsUrl(target),
          caseId: request.caseId,
          repository,
          workflowId: target.workflowId,
        }) || request.signal.aborted || !request.isCurrent()
      ) return;
      const token = await options.resolveToken();
      if (!token || request.signal.aborted || !request.isCurrent()) return;
      const transport = {
        token,
        signal: request.signal,
        ssrfChecker: options.ssrfChecker,
      };
      if (saved) {
        const allowed = await (options.verifyAccess ??
          verifySentinelGitHubWorkflowAccess)(target, transport);
        return allowed && !request.signal.aborted && request.isCurrent()
          ? saved
          : undefined;
      }
      const records =
        await (options.readRuns ?? readSentinelGitHubWorkflowRuns)(
          target,
          transport,
        );
      if (request.signal.aborted || !request.isCurrent()) return;
      const runs = records.map(({ id, status, conclusion }) => ({
        id,
        status,
        conclusion,
      }));
      const receipt = {
        repository,
        workflowId: target.workflowId,
        connectorId: "github-actions",
        observedAt: new Date().toISOString(),
        evidenceRevision: request.evidenceRevision,
        resultSha256: createHash("sha256").update(JSON.stringify(runs)).digest(
          "hex",
        ),
        runs,
      };
      return request.saveResult ? request.saveResult(receipt) : receipt;
    } catch {
      return undefined;
    }
  };
}
