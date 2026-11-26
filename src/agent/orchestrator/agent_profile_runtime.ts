/** Apply reviewed agent settings by intersecting the existing runtime policy. */
import type { AgentProfileRevision } from "../../core/agent_profiles.ts";
import {
  MAX_TOOL_ITERATIONS,
  type OrchestratorConfig,
} from "./orchestrator_config.ts";

export function withAgentProfileRuntime(
  config: OrchestratorConfig,
  readProfile: () => AgentProfileRevision | null | undefined,
): OrchestratorConfig {
  function permits(
    profile: AgentProfileRevision,
    name: string,
    args?: Readonly<Record<string, unknown>>,
  ) {
    const settings = profile.definition;
    if (!settings || (settings.tools && !settings.tools.includes(name))) {
      return false;
    }
    if (!settings.skills) return true;
    if (name === "list_skills" || name === "skill_discover") return false;
    return name !== "read_skill" || !args ||
      (typeof args.skill_name === "string" &&
        settings.skills.includes(args.skill_name));
  }

  return {
    ...config,
    async getExtraSystemPromptSections() {
      const prior = await config.getExtraSystemPromptSections?.() ?? [];
      const profile = readProfile()?.definition;
      return [
        ...prior,
        ...(profile
          ? [`Reviewed agent role: ${profile.role}
${profile.prompt}`]
          : []),
      ];
    },
    filterTools(tools, isOwner) {
      const available = config.filterTools?.(tools, isOwner) ?? tools;
      const profile = readProfile();
      if (profile === undefined) return available;
      return profile
        ? available.filter(({ name }) => permits(profile, name))
        : [];
    },
    configureToolCall(name, args) {
      const configured = config.configureToolCall?.(name, args);
      const profile = readProfile();
      if (profile === undefined) return configured;
      const effective = configured?.args ?? args;
      return {
        args: { ...effective },
        isCurrent() {
          const current = readProfile();
          return !!profile && current?.id === profile.id &&
            current.version === profile.version &&
            permits(profile, name, effective) &&
            (configured?.isCurrent() ?? true);
        },
      };
    },
    getMaxIterations() {
      const limit = readProfile()?.definition?.maxTurns;
      const original = config.getMaxIterations?.() ?? config.maxIterations;
      return limit === undefined
        ? original
        : Math.min(limit, original ?? MAX_TOOL_ITERATIONS);
    },
    getTaskTimeoutWrapup() {
      const original = config.getTaskTimeoutWrapup?.();
      const settings = readProfile()?.definition;
      if (settings?.runSeconds === undefined) return original;
      return {
        durationMs: Math.min(
          settings.runSeconds * 1000,
          original?.durationMs ?? Infinity,
        ),
        prompt: settings.timeoutWrapupPrompt ?? original?.prompt,
        maxAttempts: Math.min(
          settings.timeoutWrapupTurns ?? 1,
          original?.maxAttempts ?? 8,
        ),
      };
    },
    getIterationWrapupPrompt() {
      return readProfile()?.definition?.wrapupPrompt ??
        config.getIterationWrapupPrompt?.();
    },
  };
}
