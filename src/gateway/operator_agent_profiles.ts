import type { SelectedModelProfile } from "../core/model_profile_selection.ts";
/** Owner gateway operations for the durable agent registry. */
import {
  agentProfilePromptVariables,
  isAgentProfileId,
  openAgentProfiles,
  parseAgentProfileDefinition,
  parseAgentProfileMutation,
  renderAgentProfilePrompt,
} from "../core/agent_profiles.ts";
import { canFlowTo } from "../core/types/classification.ts";
import type { OperatorRunToolContext } from "./operator_run_tool.ts";

const reads = new Set([
  "agent_profiles",
  "agent_profile",
  "agent_profile_history",
  "preview_agent_prompt",
  "agent_prompt_variables",
]);

export function isAgentProfileRead(action: unknown): boolean {
  return typeof action === "string" && reads.has(action);
}

export function isAgentProfileAction(action: unknown): boolean {
  return isAgentProfileRead(action) || action === "set_agent_profile" ||
    action === "delete_agent_profile";
}

const unavailable = "Error: The agent profile operation is unavailable.";

export async function executeAgentProfileAction(
  baseDir: string,
  args: Record<string, unknown>,
  context: OperatorRunToolContext | undefined,
  confirm: (message: string) => Promise<boolean>,
  permitsModel?: (profile: SelectedModelProfile, role: string) => boolean,
): Promise<string> {
  const operator = context?.authenticatedOwnerSessionId;
  const authorize = context?.authorizeOwnerRunCall;
  if (
    !operator || !authorize ||
    !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC")
  ) {
    return unavailable;
  }
  const {
    action,
    id,
    profileSettings,
    promptVariables,
    expectedVersion,
    requestId,
  } = args;
  const registry = openAgentProfiles(baseDir);
  const output = (data: object) =>
    JSON.stringify({ ...data, _classification: "INTERNAL" });
  const only = (keys: readonly string[]) =>
    Object.keys(args).every((key) => keys.includes(key));

  try {
    if (action === "agent_profiles" && only(["action"])) {
      return output({
        profiles: registry.list().map(({ id, version, definition }) => ({
          id,
          version,
          name: definition?.name,
          description: definition?.description,
          role: definition?.role,
        })),
      });
    }
    if (!isAgentProfileId(id)) return unavailable;
    const positiveVersion = (version: unknown): version is number =>
      typeof version === "number" && Number.isSafeInteger(version) &&
      version > 0;
    if (
      action === "agent_profile" && only(["action", "id", "version"]) &&
      (args.version === undefined || positiveVersion(args.version))
    ) {
      const profile = args.version === undefined
        ? registry.read(id)
        : registry.version(id, args.version);
      return profile ? output({ profile }) : unavailable;
    }
    if (
      action === "agent_profile_history" && only(["action", "id", "before"]) &&
      (args.before === undefined ||
        (typeof args.before === "number" && Number.isSafeInteger(args.before) &&
          args.before > 0))
    ) {
      const history = registry.history(id, args.before as number | undefined);
      const nextBefore = history.length === 32 ? history.at(-1)?.version : null;
      return output({
        history: history.map(({ id, version, recordedAt, definition }) => ({
          id,
          version,
          recordedAt,
          name: definition?.name ?? null,
          role: definition?.role ?? null,
        })),
        nextBefore,
      });
    }
    if (
      action === "agent_prompt_variables" &&
      only(["action", "id", "version"]) &&
      (args.version === undefined || positiveVersion(args.version))
    ) {
      const profile = args.version === undefined
        ? registry.read(id)
        : registry.version(id, args.version);
      return profile?.definition
        ? output({ variables: agentProfilePromptVariables(profile.definition) })
        : unavailable;
    }
    if (
      action === "preview_agent_prompt" &&
      only(["action", "id", "promptVariables", "profileSettings"])
    ) {
      const profile = registry.read(id);
      const draft = profileSettings ?? profile?.definition;
      const parsed = parseAgentProfileDefinition(draft);
      const prompt = parsed &&
        renderAgentProfilePrompt(parsed, promptVariables);
      return prompt ? output({ prompt }) : unavailable;
    }
    const deletion = action === "delete_agent_profile";
    if (
      (!deletion && action !== "set_agent_profile") ||
      !only([
        "action",
        "id",
        "expectedVersion",
        "requestId",
        ...(!deletion ? ["profileSettings"] : []),
      ])
    ) return unavailable;

    if (!canFlowTo(context.inputClassification ?? "INTERNAL", "INTERNAL")) {
      return unavailable;
    }
    const mutation = parseAgentProfileMutation({
      id,
      expectedVersion,
      requestId,
      definition: deletion ? null : profileSettings,
    });
    if (!mutation || (!deletion && mutation.definition === null)) {
      return unavailable;
    }
    const model = mutation.definition?.modelProfile;
    const modelAllowed = () =>
      !model || permitsModel?.(model, mutation.definition!.role) === true;
    const saved = registry.receipt(mutation);
    if (!modelAllowed() || !await authorize(args) || !modelAllowed()) {
      return unavailable;
    }
    if (saved !== undefined) {
      return saved ? output({ profile: saved }) : unavailable;
    }
    if (
      (registry.read(id)?.version ?? 0) !== mutation.expectedVersion ||
      !await confirm(
        `Approve this exact agent profile revision?\n${
          JSON.stringify(mutation)
        }`,
      ) ||
      !await authorize(args) || !modelAllowed()
    ) return unavailable;
    const profile = registry.commit(mutation, operator);
    return profile ? output({ profile }) : unavailable;
  } catch {
    return unavailable;
  }
}
