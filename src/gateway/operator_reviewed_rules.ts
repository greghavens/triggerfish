import { approvalAdviceStore } from "../core/policy/approval_advice.ts";
import {
  isSelectedModelProfile,
  type SelectedModelProfile,
} from "../core/model_profile_selection.ts";
import {
  parseReviewedToolRule,
  reviewedRuleId,
  reviewedToolRules,
} from "../core/policy/reviewed_tool_rules.ts";
import { canFlowTo } from "../core/types/classification.ts";
import type { OperatorRunToolContext } from "./operator_run_tool.ts";

export { reviewedRuleActions } from "../core/policy/reviewed_tool_rules.ts";

export async function executeReviewedRuleAction(
  baseDir: string,
  args: Record<string, unknown>,
  context: OperatorRunToolContext | undefined,
  confirm: (message: string) => Promise<boolean>,
  profiles?: () => readonly SelectedModelProfile[],
): Promise<string> {
  const unavailable = "Error: The reviewed tool rule operation is unavailable.";
  const authorize = context?.authorizeOwnerRunCall;
  if (
    !context?.authenticatedOwnerSessionId || !authorize ||
    !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC")
  ) return unavailable;
  const output = (data: object) =>
    JSON.stringify({ ...data, _classification: "INTERNAL" });
  const store = reviewedToolRules(baseDir);
  const { action, id, requestId, expectedVersion } = args;
  const only = (...keys: string[]) =>
    Object.keys(args).every((key) => key === "action" || keys.includes(key));
  try {
    if (action === "reviewed_tool_reviewer" && only()) {
      if (!await authorize(args)) return unavailable;
      const advice = approvalAdviceStore(baseDir);
      return output({
        setting: advice.setting(),
        profiles: profiles?.() ?? [],
        usage: advice.usage(),
      });
    }
    if (action === "reviewed_tool_advice" && only("id")) {
      if (
        typeof id !== "string" || !reviewedRuleId.test(id) ||
        !await authorize(args)
      ) return unavailable;
      return output({ advice: approvalAdviceStore(baseDir).read(id) ?? null });
    }
    if (action === "set_reviewed_tool_reviewer") {
      const { modelProfile, modelRouteModel } = args;
      const profile =
        modelProfile === undefined && modelRouteModel === undefined ? null : {
          provider: modelProfile,
          ...(modelRouteModel !== undefined && { model: modelRouteModel }),
        };
      if (
        !only(
          "expectedVersion",
          "requestId",
          "modelProfile",
          "modelRouteModel",
        ) ||
        typeof requestId !== "string" || !reviewedRuleId.test(requestId) ||
        typeof expectedVersion !== "number" ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER ||
        (profile !== null && (!isSelectedModelProfile(profile) ||
          !profiles?.().some((allowed) =>
            allowed.provider === profile.provider &&
            allowed.model === profile.model
          ))) ||
        !canFlowTo(context.inputClassification ?? "INTERNAL", "INTERNAL") ||
        !await authorize(args)
      ) return unavailable;
      const exact = profile as SelectedModelProfile | null;
      const advice = approvalAdviceStore(baseDir);
      const replay = advice.receipt(requestId, expectedVersion, exact);
      if (!replay) {
        if (advice.setting().version !== expectedVersion) return unavailable;
        if (
          !await confirm(
            "Approve this exact advisory reviewer configuration?\n" +
              JSON.stringify({ requestId, expectedVersion, profile: exact }),
          )
        ) {
          return "Error: The operator declined the run action.";
        }
      }
      if (!await authorize(args)) return unavailable;
      const setting = replay ?? advice.set(requestId, expectedVersion, exact);
      return setting ? output({ setting }) : unavailable;
    }
    if (action === "reviewed_tool_rules") {
      const { limit = 20, offset = 0 } = args;
      if (
        !only("limit", "offset") || typeof limit !== "number" ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 30 ||
        typeof offset !== "number" || !Number.isSafeInteger(offset) ||
        offset < 0 || offset > 256 || !await authorize(args)
      ) return unavailable;
      const records = store.list(limit + 1, offset);
      return output({
        rules: records.slice(0, limit),
        nextOffset: records.length > limit ? offset + limit : null,
      });
    }
    const setting = action === "set_reviewed_tool_rule";
    const rule = setting ? parseReviewedToolRule(args.reviewedRule) : null;
    if (
      !only(
        "id",
        "requestId",
        "expectedVersion",
        ...(setting ? ["reviewedRule"] : []),
      ) ||
      (setting && !rule) ||
      typeof expectedVersion !== "number" ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < (setting ? 0 : 1) ||
      expectedVersion >= Number.MAX_SAFE_INTEGER ||
      typeof id !== "string" || !reviewedRuleId.test(id) ||
      typeof requestId !== "string" || !reviewedRuleId.test(requestId) ||
      !canFlowTo(context.inputClassification ?? "INTERNAL", "INTERNAL") ||
      !await authorize(args)
    ) return unavailable;
    const change = { id, expectedVersion, rule: rule ?? null };
    const saved = store.receipt(requestId, change);
    if (!saved) {
      if (store.version(id) !== expectedVersion) return unavailable;
      if (
        !await confirm(
          "Approve this exact tool policy change?\n" +
            JSON.stringify({ requestId, change }),
        )
      ) return "Error: The operator declined the run action.";
    }
    if (!await authorize(args)) return unavailable;
    const result = saved ?? store.apply(requestId, change);
    return result ? output({ result }) : unavailable;
  } catch {
    return unavailable;
  }
}
