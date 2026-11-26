/**
 * Integration executor initialization — MCP, GitHub, Obsidian, triggers, skills.
 *
 * Builds external service executors, agent-local tool executors, and
 * assembles them into the integration set used by tool infrastructure.
 *
 * @module
 */

import { join } from "@std/path";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import { openAgentProfiles } from "../../../core/agent_profiles.ts";
import { updateTaint } from "../../../core/types/session.ts";
import type { TriggerFishConfig } from "../../../core/config.ts";
import { createProviderRegistry } from "../../../agent/llm.ts";
import type { createHookRunner } from "../../../core/policy/hooks/hooks.ts";
import {
  createClaudeSessionManager,
  createClaudeToolExecutor,
} from "../../../exec/claude.ts";
import { createSecretToolExecutor } from "../../../tools/secrets.ts";
import {
  createSkillContextTracker,
  createSkillScanner,
  createSkillToolExecutor,
} from "../../../tools/skills/mod.ts";
import type { SkillContextTracker } from "../../../tools/skills/mod.ts";
import {
  buildSkillsSystemPrompt,
  buildTriggersSystemPrompt,
} from "../../../tools/skills/prompts.ts";
import { createKeychain } from "../../../core/secrets/keychain/keychain.ts";
import type { createWorkspace } from "../../../exec/workspace.ts";
import { createTriggerToolExecutor } from "../../tools/trigger/trigger_tools.ts";
import { createTriggerStore } from "../../../scheduler/triggers/store.ts";
import type { McpBroadcastRefs } from "../infra/mcp.ts";
import { buildSubagentFactory } from "../factory/subagent.ts";
import { createOrchestratorFactory } from "../factory/orchestrator_factory.ts";
import { buildObsidianExecutor, discoverSkills } from "../infra/subsystems.ts";
import type { ObsidianPluginConfig } from "../infra/subsystems.ts";
import type { BootstrapResult } from "../bootstrap.ts";
import type { CoreInfraResult } from "../infra/core_infra.ts";
import type { LineageStore } from "../../../core/session/lineage_types.ts";
import type { MainSessionState } from "../tools/tool_executor.ts";
import { loadSkillUsageHistory } from "../../skill_usage_history.ts";
import {
  buildExploreExecutor,
  buildGitHubExecutor,
  initializeMcpServers,
} from "./browser_init.ts";
import { buildCalDavExecutor } from "../factory/caldav_executor.ts";
import type { CalDavConfig } from "../../../integrations/caldav/mod.ts";
import { buildNotionExecutor } from "../factory/notion_executor.ts";
import { buildXExecutor } from "../factory/x_executor.ts";

/** Initialize MCP servers and create broadcast refs. */
export function initializeMcpInfrastructure(
  config: TriggerFishConfig,
  hookRunner: ReturnType<typeof createHookRunner>,
  state: MainSessionState,
  toolClassifications: Map<string, ClassificationLevel>,
  integrationClassifications: Map<string, ClassificationLevel>,
  keychain: ReturnType<typeof createKeychain>,
  lineageStore: LineageStore,
) {
  const mcpBroadcastRefs: McpBroadcastRefs = {
    chatSession: null,
    gatewayServer: null,
    tidepoolHost: null,
  };
  const { mcpExecutor, mcpWiring } = initializeMcpServers(
    config,
    hookRunner,
    () => state.session,
    toolClassifications,
    integrationClassifications,
    mcpBroadcastRefs,
    keychain,
    lineageStore,
  );
  return { mcpBroadcastRefs, mcpExecutor, mcpWiring };
}

/** Build external service integrations (GitHub, Obsidian, MCP). */
export async function buildExternalServiceExecutors(
  config: TriggerFishConfig,
  hookRunner: ReturnType<typeof createHookRunner>,
  state: MainSessionState,
  toolClassifications: Map<string, ClassificationLevel>,
  integrationClassifications: Map<string, ClassificationLevel>,
  lineageStore: LineageStore,
  opts?: { readonly workspacePath?: string },
) {
  const { executor: githubExecutor, keychain } = await buildGitHubExecutor(
    config,
    state.session,
    { workspacePath: opts?.workspacePath },
  );
  const caldavExecutor = await buildCalDavExecutor(
    config.caldav as CalDavConfig | undefined,
    () => state.session.taint,
    state.session.id,
  );
  const notionExecutor = await buildNotionExecutor(
    config,
    () => state.session.taint,
    state.session.id,
  );
  const xExecutor = await buildXExecutor(
    config,
    { workspacePath: opts?.workspacePath },
  );
  const obsidianExecutor = config.plugins?.obsidian
    ? await buildObsidianExecutor(
      config.plugins.obsidian as ObsidianPluginConfig,
      () => state.session.taint,
      state.session.id,
    )
    : undefined;
  const mcp = initializeMcpInfrastructure(
    config,
    hookRunner,
    state,
    toolClassifications,
    integrationClassifications,
    keychain,
    lineageStore,
  );
  return {
    githubExecutor,
    caldavExecutor,
    notionExecutor,
    xExecutor,
    keychain,
    obsidianExecutor,
    ...mcp,
  };
}

/** Build trigger executor with session taint escalation. */
export function buildMainTriggerExecutor(
  triggerStore: ReturnType<typeof createTriggerStore>,
  state: MainSessionState,
) {
  return createTriggerToolExecutor({
    triggerStore,
    sessionTaint: state.session.taint,
    getSessionTaint: () => state.session.taint,
    escalateTaint: (level: ClassificationLevel) => {
      state.session = updateTaint(
        state.session,
        level,
        "trigger context injection",
      );
    },
  });
}

/** Build agent-local tool executors (claude, secrets, triggers, skills). */
export function buildAgentToolExecutors(
  mainWorkspace: Awaited<ReturnType<typeof createWorkspace>>,
  state: MainSessionState,
  triggerStore: ReturnType<typeof createTriggerStore>,
  skillLoader: Awaited<ReturnType<typeof discoverSkills>>["loader"],
  messageStore: CoreInfraResult["messageStore"],
  baseDir: string,
): {
  claudeExecutor: ReturnType<typeof createClaudeToolExecutor>;
  mainKeychain: ReturnType<typeof createKeychain>;
  secretExecutor: ReturnType<typeof createSecretToolExecutor>;
  triggerExecutor: ReturnType<typeof createTriggerToolExecutor>;
  skillExecutor: ReturnType<typeof createSkillToolExecutor>;
  skillContextTracker: SkillContextTracker;
} {
  const claudeExecutor = createClaudeToolExecutor(
    createClaudeSessionManager({ workspacePath: mainWorkspace.path }),
  );
  const mainKeychain = createKeychain();
  const secretExecutor = createSecretToolExecutor(
    mainKeychain,
    (name, hint) => state.activeSecretPrompt(name, hint),
    (name, hint) => state.activeCredentialPrompt(name, hint),
  );
  const skillContextTracker = createSkillContextTracker();
  return {
    claudeExecutor,
    mainKeychain,
    secretExecutor,
    triggerExecutor: buildMainTriggerExecutor(triggerStore, state),
    skillExecutor: createSkillToolExecutor({
      skillLoader,
      skillContextTracker,
      getSessionTaint: () => state.session.taint,
      skillScanner: createSkillScanner(),
      getConfirmPrompt: () => state.activeConfirmPrompt,
      loadOwnerSkillHistory: (run) =>
        loadSkillUsageHistory(
          join(baseDir, "execution-traces.db"),
          messageStore,
          () => state.session,
          run,
        ),
      listReviewedAgentProfiles: () => openAgentProfiles(baseDir).list(),
    }),
    skillContextTracker,
  };
}

/** Discover skills and build agent-local + skill executors. */
export async function buildSkillAndAgentExecutors(
  bootstrap: BootstrapResult,
  coreInfra: CoreInfraResult,
  mainWorkspace: Awaited<ReturnType<typeof createWorkspace>>,
  state: MainSessionState,
) {
  const { skills, loader: skillLoader } = await discoverSkills(
    bootstrap.baseDir,
  );
  const agentTools = buildAgentToolExecutors(
    mainWorkspace,
    state,
    coreInfra.triggerStore,
    skillLoader,
    coreInfra.messageStore,
    bootstrap.baseDir,
  );
  return {
    skillLoader,
    skillsPrompt: buildSkillsSystemPrompt(skills),
    triggersPrompt: buildTriggersSystemPrompt(bootstrap.baseDir),
    ...agentTools,
  };
}

/** Build integration executors (GitHub, Obsidian, MCP, Skills, Secrets, Triggers). */
export async function buildIntegrationExecutors(
  bootstrap: BootstrapResult,
  coreInfra: CoreInfraResult,
  toolInfra: {
    hookRunner: ReturnType<typeof createHookRunner>;
    mainWorkspace: Awaited<ReturnType<typeof createWorkspace>>;
    state: MainSessionState;
    factory: ReturnType<typeof createOrchestratorFactory>;
    registry: ReturnType<typeof createProviderRegistry>;
    toolClassifications: Map<string, ClassificationLevel>;
    integrationClassifications: Map<string, ClassificationLevel>;
  },
) {
  const { state, factory, mainWorkspace } = toolInfra;
  const subagentFactory = buildSubagentFactory(factory, {
    maxIterations: 5,
    workspace: mainWorkspace,
    executionTracePath: join(bootstrap.baseDir, "execution-traces.db"),
  });
  const preflightListDirectory = async (
    path: string,
  ): Promise<string | null> => {
    try {
      const entries: string[] = [];
      for await (const entry of Deno.readDir(path)) {
        entries.push(entry.name + (entry.isDirectory ? "/" : ""));
      }
      return entries.length > 0 ? entries.join("\n") : "(empty directory)";
    } catch {
      return null;
    }
  };
  const exploreExecutor = buildExploreExecutor(
    subagentFactory,
    preflightListDirectory,
  );
  const external = await buildExternalServiceExecutors(
    bootstrap.config,
    toolInfra.hookRunner,
    state,
    toolInfra.toolClassifications,
    toolInfra.integrationClassifications,
    coreInfra.lineageStore,
    { workspacePath: mainWorkspace.path },
  );
  const skillAndAgent = await buildSkillAndAgentExecutors(
    bootstrap,
    coreInfra,
    mainWorkspace,
    state,
  );
  return { subagentFactory, exploreExecutor, ...external, ...skillAndAgent };
}
