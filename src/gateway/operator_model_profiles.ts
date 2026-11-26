/** Reviewed named profiles over currently configured live model routes. */
import type { liveProviderRouteSettings } from "../agent/providers/live_routes.ts";
import {
  isModelProfileName,
  isSelectedModelProfile,
} from "../core/model_profile_selection.ts";
import type { NamedModelProfile } from "../agent/providers/live_route_journal.ts";
import {
  canFlowTo,
  maxClassification,
  parseClassification,
} from "../core/types/classification.ts";
import type { OperatorRunToolContext } from "./operator_run_tool.ts";

export const namedModelProfileActions = [
  "model_profiles",
  "model_profile",
  "set_model_profile",
  "delete_model_profile",
  "activate_model_profile",
] as const;
type NamedModelProfileAction = typeof namedModelProfileActions[number];
const requestPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

function validVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value < Number.MAX_SAFE_INTEGER;
}

export async function executeNamedModelProfileAction(
  action: NamedModelProfileAction,
  args: Record<string, unknown>,
  routes: ReturnType<typeof liveProviderRouteSettings> | undefined,
  context: OperatorRunToolContext | undefined,
  confirm: (message: string) => Promise<boolean>,
) {
  const authorize = context?.authorizeOwnerRunCall;
  const { modelRouteClassification, id, expectedVersion, requestId } = args;
  if (
    !routes || !authorize || !context.authenticatedOwnerSessionId ||
    typeof modelRouteClassification !== "string"
  ) return;
  const parsed = parseClassification(modelRouteClassification);
  if (!parsed.ok) return;
  const classification = parsed.value;
  const label = maxClassification("INTERNAL", classification);
  if (!canFlowTo(label, context.ceiling ?? "PUBLIC")) return;

  const only = (...fields: readonly string[]) =>
    Object.keys(args).every((key) =>
      key === "action" || key === "modelRouteClassification" ||
      fields.includes(key)
    );
  const output = (payload: object) => ({ ...payload, _classification: label });
  if (action === "model_profiles") {
    const { modelProfileAfter = "" } = args;
    if (
      !only("modelProfileAfter") ||
      (modelProfileAfter !== "" && !isModelProfileName(modelProfileAfter)) ||
      !await authorize(args)
    ) return;
    const profiles = routes.listProfiles(classification, modelProfileAfter);
    return output({
      profiles: profiles.slice(0, 50),
      next: profiles.length > 50 ? profiles[49].id : null,
    });
  }
  if (!isModelProfileName(id)) return;
  if (action === "model_profile") {
    if (!only("id") || !await authorize(args)) return;
    const stored = routes.inspectProfile(id);
    return stored?.classification === classification
      ? output({ profile: stored })
      : undefined;
  }
  if (
    typeof requestId !== "string" || !requestPattern.test(requestId) ||
    !validVersion(expectedVersion) ||
    !canFlowTo(context.inputClassification ?? "INTERNAL", label)
  ) return;
  const request = requestId.toLowerCase();
  const stored = routes.inspectProfile(id);
  const route = routes.read(classification);
  if (!route || (stored && stored.classification !== classification)) return;
  if (action === "activate_model_profile") {
    const profile = stored?.profile;
    if (
      !only("id", "expectedVersion", "modelProfileVersion", "requestId") ||
      !stored || stored.version !== args.modelProfileVersion || !profile ||
      expectedVersion > route.version ||
      !routes.eligible(profile, classification)
    ) return;
    const edit = {
      classification,
      requestId: request,
      version: expectedVersion + 1,
      override: profile,
      effective: profile,
      previous: route.effective,
      named: { id, version: stored.version },
    };
    if (
      (expectedVersion === route.version &&
        !await confirm(
          `Approve this exact named model activation?\n${JSON.stringify(edit)}`,
        )) ||
      !await authorize(args)
    ) return;
    const saved = routes.commit(edit);
    return saved ? output({ edit: saved }) : undefined;
  }

  const setting = action === "set_model_profile";
  if (
    !only(
      "id",
      "expectedVersion",
      "requestId",
      ...(setting ? ["modelProfile", "modelRouteModel"] : []),
    ) || expectedVersion > (stored?.version ?? 0)
  ) return;
  const candidate = setting
    ? {
      provider: args.modelProfile,
      ...(args.modelRouteModel !== undefined &&
        { model: args.modelRouteModel }),
    }
    : null;
  if (
    candidate && (!isSelectedModelProfile(candidate) ||
      !routes.eligible(candidate, classification))
  ) return;
  const next: NamedModelProfile = {
    id,
    classification,
    requestId: request,
    version: expectedVersion + 1,
    profile: candidate,
  };
  if (expectedVersion === (stored?.version ?? 0)) {
    if (
      (!setting && (!stored?.profile || route.named?.id === id)) ||
      !await confirm(
        `Approve this exact named model profile change?\n${
          JSON.stringify({
            next,
            active: route.named?.id === id,
            expectedRoute: route.version,
          })
        }`,
      )
    ) return;
  }
  if (!await authorize(args)) return;
  const saved = routes.commitProfile(next, route.version);
  return saved ? output({ profile: saved }) : undefined;
}
