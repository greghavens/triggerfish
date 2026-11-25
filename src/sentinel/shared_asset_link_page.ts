/** Bounded projection shared by live reads, trace readback, and archival. */
import { redactCredentialText } from "../core/logger/redactor.ts";
import { createHash } from "node:crypto";
import type {
  readSharedSentinelAssetLinks,
  SharedAssetMappingSource,
} from "./shared_inventory.ts";
import type { sentinelSharedAssetLinksArgs } from "./worker_goal_recovery.ts";

export type SharedAssetLinkPage =
  & Omit<
    Awaited<ReturnType<typeof readSharedSentinelAssetLinks>>,
    "unavailable" | "mappingSources"
  >
  & {
    source: string;
    caseEvidenceRevision: number;
    unavailableSourceCount: number;
    mappingProof?: string;
  };

export function parseSharedAssetLinkPage(
  result: string,
  revision: number,
  args: NonNullable<ReturnType<typeof sentinelSharedAssetLinksArgs>>,
): SharedAssetLinkPage | undefined {
  if (
    result.length > 7000 || redactCredentialText(result) !== result
  ) return;
  let page;
  try {
    page = JSON.parse(result);
  } catch {
    return;
  }
  const { offset = 0, limit = 5, includeFindings = false } = args;
  if (
    page?.source !== "live_published_inventory" ||
    page.caseEvidenceRevision !== revision ||
    page.asset !== args.asset || page.offset !== offset ||
    !Array.isArray(page.links) || page.links.length > limit ||
    !Array.isArray(page.sourceSnapshots) ||
    !Number.isSafeInteger(page.totalLinks) || page.totalLinks < 0 ||
    !Number.isSafeInteger(page.unavailableSourceCount) ||
    page.unavailableSourceCount < 0 ||
    (page.mappingProof !== undefined &&
      (typeof page.mappingProof !== "string" ||
        !/^[a-f0-9]{64}$/.test(page.mappingProof))) ||
    Object.keys(page).length !== (includeFindings ? 11 : 9) +
        (page.mappingProof === undefined ? 0 : 1) ||
    (includeFindings &&
      (!Array.isArray(page.findings) || page.findings.length > limit ||
        !Number.isSafeInteger(page.totalFindings) || page.totalFindings < 0))
  ) return;
  const total = Math.max(page.totalLinks, page.totalFindings ?? 0);
  if (
    page.nextOffset !== (offset + limit < total ? offset + limit : null) ||
    page.links.length !==
      Math.max(0, Math.min(limit, page.totalLinks - offset)) ||
    (includeFindings &&
      page.findings.length !==
        Math.max(0, Math.min(limit, page.totalFindings - offset)))
  ) return;
  return page;
}

export function assetLinkProof(
  caseId: string,
  page: Omit<SharedAssetLinkPage, "mappingProof">,
  sources: readonly SharedAssetMappingSource[] | undefined,
): string {
  return createHash("sha256")
    .update(JSON.stringify([caseId, page, sources]))
    .digest("hex");
}
