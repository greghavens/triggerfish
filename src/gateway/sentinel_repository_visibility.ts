/** Reauthorize and query one exact operator-configured GitHub repository. */
import { canFlowTo } from "../core/types/classification.ts";
import type { ClassificationLevel } from "../core/types/classification.ts";
import type { TriggerFishConfig } from "../core/config_types.ts";
import type { SsrfChecker } from "../core/security/safe_fetch.ts";
import { visibilityToClassification } from "../integrations/github/client.ts";
import {
  repositoryVisibilityReceipt,
  type SentinelRepositoryVisibilityReceipt,
} from "../sentinel/github_repository_visibility.ts";
import {
  readSentinelGitHubRepositoryVisibility,
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
      if (
        saved
          ? saved.repository !== repository ||
            saved.repositoryId !== repositoryId ||
            saved.evidenceRevision !== request.evidenceRevision
          : request.resumeOnly
      ) return;
      const destination = {
        url: sentinelGitHubRepositoryUrl(owner, repo),
        caseId: request.caseId,
        repository,
        repositoryId,
      };
      if (!await request.authorize(destination) || !current()) return;
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
      const visibility = await (options.readVisibility ??
        readSentinelGitHubRepositoryVisibility)({ owner, repo, repositoryId }, {
          token: credential.token,
          signal: request.signal,
          ssrfChecker: options.ssrfChecker,
        });
      if (
        !mayRead(visibility) || !current() ||
        (await options.resolveCredential(credential.ref))?.ref !==
          credential.ref ||
        !current()
      ) return;
      const receipt = repositoryVisibilityReceipt({
        repository,
        repositoryId,
        visibility,
        observedAt,
        evidenceRevision: request.evidenceRevision,
        credentialRef: credential.ref,
      });
      return receipt && request.saveResult(receipt);
    } catch {
      return;
    }
  };
}
