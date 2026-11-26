import { assetText } from "../sentinel/asset_properties.ts";
import { isSentinelCaseId } from "../sentinel/cases.ts";
import {
  parseSentinelScopeRules,
  type SentinelScopeRule,
} from "../sentinel/scope_rules.ts";

export const sentinelScopeRuleToolName = "sentinel_propose_scope_rules";

export interface SentinelScopeRuleIntent {
  readonly caseId: string;
  readonly evidenceRevision: number;
  readonly requestId: string;
  readonly organizationId?: string;
  readonly organizationName?: string;
  readonly scope?: "company";
  readonly rules: readonly SentinelScopeRule[];
  readonly reason: string;
}

export function parseSentinelScopeRuleIntent(
  value: unknown,
): SentinelScopeRuleIntent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const args = value as Record<string, unknown>;
  const { caseId, evidenceRevision, organizationId, requestId, scope } = args;
  const organizationName = assetText(args.organizationName, 256);
  const rules = parseSentinelScopeRules(args.rules);
  const reason = assetText(args.reason, 512);
  if (
    !rules || !reason || typeof caseId !== "string" ||
    !isSentinelCaseId(caseId) ||
    typeof evidenceRevision !== "number" ||
    !Number.isSafeInteger(evidenceRevision) ||
    evidenceRevision < 1 || typeof requestId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId) ||
    (organizationId !== undefined && !assetText(organizationId, 256)) ||
    (scope === "company"
      ? typeof organizationId !== "string" || !organizationName
      : scope !== undefined || args.organizationName !== undefined) ||
    Object.keys(args).some((key) =>
      ![
        "caseId",
        "evidenceRevision",
        "organizationId",
        "organizationName",
        "scope",
        "requestId",
        "rules",
        "reason",
      ].includes(key)
    )
  ) return;
  return {
    caseId,
    evidenceRevision,
    requestId,
    ...(typeof organizationId === "string" && { organizationId }),
    ...(scope === "company" && { scope, organizationName }),
    rules,
    reason,
  };
}
