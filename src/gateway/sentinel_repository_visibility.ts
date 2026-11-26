/** Reauthorize and query one exact operator-configured GitHub repository. */
import { canFlowTo } from "../core/types/classification.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import type { TriggerFishConfig } from "../core/config_types.ts";
import type { SsrfChecker } from "../core/security/safe_fetch.ts";
import { visibilityToClassification } from "../integrations/github/client.ts";
import {
  repositoryVisibilityReceipt,
  SENTINEL_LIVE_BRANCH_PROTECTION,
  SENTINEL_LIVE_REPOSITORY_VISIBILITY,
  type SentinelRepositoryVisibilityReceipt,
} from "../sentinel/github_repository_visibility.ts";
import {
  readSentinelGitHubBranchProtection,
  readSentinelGitHubRepositoryVisibility,
  sentinelGitHubBranchUrl,
  sentinelGitHubRepositoryUrl,
} from "../sentinel/github_workflow_runs.ts";

type Scopes = NonNullable<
  TriggerFishConfig["sentinel"]
>["github_repository_visibility_reads"];

export interface SentinelRepositoryVisibilityDestination {
  readonly url: string;
  readonly caseId: string;
  readonly repository: string;
  readonly repositoryId: number;
  readonly branch?: string;
}

export function repositoryVisibilityDestinationMetadata(
  destination: SentinelRepositoryVisibilityDestination,
  evidenceRevision: number,
  taskId: string,
  replay: boolean,
) {
  return {
    tool_name: destination.branch
      ? SENTINEL_LIVE_BRANCH_PROTECTION
      : SENTINEL_LIVE_REPOSITORY_VISIBILITY,
    operation_type: "read",
    resource_classification: "INTERNAL",
    is_outbound_request: true,
    is_owner: true,
    url: destination.url,
    sentinel_case_id: destination.caseId,
    sentinel_evidence_revision: evidenceRevision,
    sentinel_task_id: taskId,
    repository: destination.repository,
    repository_id: destination.repositoryId,
    ...(destination.branch && { branch: destination.branch }),
    replay,
  };
}

export function createSentinelRepositoryVisibilityReader(options: {
  readonly scopes: Scopes;
  readonly classificationOverrides?: Readonly<
    Record<string, ClassificationLevel>
  >;
  readonly resolveCredential: (expectedRef?: string) => Promise<
    {
      readonly token: string;
      readonly ref: string;
    } | undefined
  >;
  readonly ssrfChecker: SsrfChecker;
  readonly readVisibility?: typeof readSentinelGitHubRepositoryVisibility;
  readonly branchNames?: Readonly<Record<string, readonly string[]>>;
  readonly request?: Parameters<
    typeof readSentinelGitHubBranchProtection
  >[1]["request"];
  readonly now?: () => Date;
}) {
  return async (request: {
    readonly caseId: string;
    readonly assetId: string;
    readonly evidenceRevision: number;
    readonly signal: AbortSignal;
    readonly isCurrent: () => boolean;
    readonly authorize: (
      destination: SentinelRepositoryVisibilityDestination,
    ) => Promise<boolean>;
    readonly loadSaved: () => SentinelRepositoryVisibilityReceipt | undefined;
    readonly saveResult: (
      receipt: SentinelRepositoryVisibilityReceipt,
    ) => SentinelRepositoryVisibilityReceipt | undefined;
    readonly resumeOnly?: boolean;
    readonly branch?: string;
  }) => {
    const scope = options.scopes?.find(({ case: caseId, asset }) =>
      caseId === request.caseId && asset === request.assetId
    );
    const current = () => !request.signal.aborted && request.isCurrent();
    if (!scope || !current()) return;
    try {
      const { owner, repo, repository_id: repositoryId } = scope;
      const repository = `${owner}/${repo}`.toLowerCase();
      const saved = request.loadSaved();
      const branch = request.branch ??
        (request.resumeOnly ? saved?.branch : undefined);
      if (branch && !options.branchNames?.[repository]?.includes(branch)) {
        return;
      }
      if (
        saved
          ? saved.repository !== repository ||
            saved.repositoryId !== repositoryId ||
            saved.branch !== branch ||
            saved.evidenceRevision !== request.evidenceRevision
          : request.resumeOnly
      ) return;
      const destination = {
        url: sentinelGitHubRepositoryUrl(owner, repo),
        caseId: request.caseId,
        repository,
        repositoryId,
        ...(branch && { branch }),
      };
      const branchDestination = branch && {
        ...destination,
        url: sentinelGitHubBranchUrl(owner, repo, branch),
      };
      if (!await request.authorize(destination) || !current()) return;
      if (
        branchDestination &&
        (!await request.authorize(branchDestination) || !current())
      ) return;
      const credential = await options.resolveCredential(saved?.credentialRef);
      if (
        !credential || !current() ||
        (saved && credential.ref !== saved.credentialRef)
      ) return;
      const mayRead = (
        visibility: SentinelRepositoryVisibilityReceipt["visibility"],
      ) =>
        canFlowTo(
          visibilityToClassification(visibility, repository, {
            overrides: options.classificationOverrides,
          }),
          "INTERNAL",
        );
      if (saved) return mayRead(saved.visibility) ? saved : undefined;
      const observedAt = (options.now?.() ?? new Date()).toISOString();
      const http = {
        token: credential.token,
        signal: request.signal,
        ssrfChecker: options.ssrfChecker,
        request: options.request,
      };
      const target = { owner, repo, repositoryId };
      const readVisibility = options.readVisibility ??
        readSentinelGitHubRepositoryVisibility;
      if (
        branchDestination &&
        (!await request.authorize(destination) || !current() ||
          !await request.authorize(branchDestination) || !current())
      ) return;
      const visibility = await readVisibility(target, http);
      let enabled: boolean | undefined;
      if (branch && branchDestination) {
        if (
          !mayRead(visibility) || !current() ||
          !await request.authorize(branchDestination) || !current() ||
          (await options.resolveCredential(credential.ref))?.ref !==
            credential.ref ||
          !current()
        ) return;
        enabled = await readSentinelGitHubBranchProtection(
          { ...target, branch },
          http,
        );
        if (
          !current() || !await request.authorize(destination) || !current() ||
          (await options.resolveCredential(credential.ref))?.ref !==
            credential.ref ||
          !current() ||
          visibility !== await readVisibility(target, http)
        ) return;
      }
      if (
        !mayRead(visibility) || !current() ||
        (await options.resolveCredential(credential.ref))?.ref !==
          credential.ref ||
        !current()
      ) return;
      if (
        branchDestination &&
        (!await request.authorize(destination) || !current() ||
          !await request.authorize(branchDestination) || !current() ||
          !mayRead(visibility))
      ) return;
      const receipt = repositoryVisibilityReceipt({
        repository,
        repositoryId,
        visibility,
        observedAt,
        evidenceRevision: request.evidenceRevision,
        credentialRef: credential.ref,
        ...(branch && { branch, protected: enabled }),
      });
      return receipt && request.saveResult(receipt);
    } catch {
      return;
    }
  };
}
