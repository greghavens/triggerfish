/**
 * Main session tool executor assembly.
 *
 * Combines all individual tool executors into the composite executor
 * used by the main daemon session, including auxiliary LLM-powered
 * executors and dynamic tool/prompt getters.
 *
 * @module
 */

import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { createSession } from "../../../core/types/session.ts";
import type { createProviderRegistry } from "../../../agent/llm.ts";
import type { createSqliteStorage } from "../../../core/storage/sqlite.ts";
import type {
  CredentialPromptCallback,
  SecretPromptCallback,
} from "../../../tools/secrets.ts";
import type { createExecTools } from "../../../exec/tools.ts";
import type { FilesystemSandbox } from "../../../exec/sandbox/mod.ts";
import type { createPersistentCronManager } from "../../../scheduler/cron/cron.ts";
import type { createTodoManager } from "../../../tools/mod.ts";
import {
  createHealthcheckToolExecutor,
  createLlmTaskToolExecutor,
  createReleaseNotesToolExecutor,
  createSummarizeToolExecutor,
} from "../../../tools/mod.ts";
import { fetchChangelogRange } from "../../../cli/daemon/updater/changelog.ts";
import { VERSION } from "../../../cli/version.ts";
import type { createAutoLaunchBrowserExecutor } from "../../../tools/browser/mod.ts";
import type { createTidepoolToolExecutor } from "../../../tools/tidepool/mod.ts";
import { TIDEPOOL_SYSTEM_PROMPT } from "../../../tools/tidepool/mod.ts";
import { BUMPERS_SYSTEM_PROMPT } from "../../../core/session/bumpers.ts";
import type { createImageToolExecutor } from "../../../tools/image/mod.ts";
import type { createExploreToolExecutor } from "../../../tools/explore/mod.ts";
import type { createSessionToolExecutor } from "../../tools/session/session_tools.ts";
import type { createGitHubToolExecutor } from "../../../integrations/github/mod.ts";
import type { createCalDavToolExecutor } from "../../../integrations/caldav/mod.ts";
import type { createClaudeToolExecutor } from "../../../exec/claude.ts";
import type { createSecretToolExecutor } from "../../../tools/secrets.ts";
import type { createTriggerToolExecutor } from "../../tools/trigger/trigger_tools.ts";
import type { createSkillToolExecutor } from "../../../tools/skills/mod.ts";
import type { SkillContextTracker } from "../../../tools/skills/mod.ts";
import type { createPlanToolExecutor } from "../../../agent/plan/plan.ts";
import type { createMemoryToolExecutor } from "../../../tools/memory/mod.ts";
import type { buildWebTools } from "../factory/web_tools.ts";
import type { buildSubagentFactory } from "../factory/subagent.ts";
import type {
  buildObsidianExecutor,
  discoverSkills,
} from "../infra/subsystems.ts";
import { buildGoogleExecutor } from "../factory/google_executor.ts";
import { createToolExecutor, TOOL_GROUPS } from "../../tools/agent_tools.ts";
import type { SubsystemExecutor } from "../../tools/executor/executor_types.ts";
import type { buildTeamExecutor } from "../factory/team_executor.ts";
import type { wireMcpServers } from "../infra/mcp.ts";
import type { PluginRegistry } from "../../../plugin/registry.ts";
import { PLUGIN_TOOL_DEFINITIONS } from "../../../plugin/tools.ts";
import {
  createWorkflowStore,
  createWorkflowToolExecutor,
  type WorkflowRunRegistry,
} from "../../../workflow/mod.ts";
import type { MemoryStore } from "../../../tools/memory/store.ts";
import { loadPersonaContext } from "../../../tools/memory/mod.ts";
import { createSshToolExecutor } from "../../../tools/ssh/mod.ts";
import { createLogger } from "../../../core/logger/logger.ts";

const log = createLogger("persona-prompt");

/** Callback for out-of-band user confirmation. */
export type ConfirmPromptCallback = (message: string) => Promise<boolean>;

/** Mutable state bag for the main daemon session. */
export interface MainSessionState {
  session: ReturnType<typeof createSession>;
  activeSecretPrompt: SecretPromptCallback;
  activeCredentialPrompt: CredentialPromptCallback;
  activeConfirmPrompt: ConfirmPromptCallback;
}

/** Classification-partitioned workspace directory paths. */
export interface WorkspacePaths {
  readonly publicPath: string;
  readonly internalPath: string;
  readonly confidentialPath: string;
  readonly restrictedPath: string;
}

const TAINT_TO_PATH_KEY: Record<ClassificationLevel, keyof WorkspacePaths> = {
  PUBLIC: "publicPath",
  INTERNAL: "internalPath",
  CONFIDENTIAL: "confidentialPath",
  RESTRICTED: "restrictedPath",
};

/** Map a session taint level to the corresponding workspace directory. */
export function resolveWorkspacePathForTaint(
  taint: ClassificationLevel,
  paths: WorkspacePaths,
): string {
  return paths[TAINT_TO_PATH_KEY[taint]];
}

/** Build a dynamic system prompt section describing the agent's workspace. */
export function buildWorkspacePrompt(
  _taint: ClassificationLevel,
  _paths: WorkspacePaths,
): string {
  return [
    "## Workspace",
    "Your working directory is the current directory (`.`).",
    "All file operations are relative to your workspace.",
    "When you use `cd <dir>` via run_command, subsequent file operations resolve relative to that directory.",
    "Stay within your workspace for all file reads and writes.",
  ].join("\n");
}

/** Build LLM-powered auxiliary executors (task, summarize, healthcheck, release notes). */
export function buildAuxiliaryExecutors(
  registry: ReturnType<typeof createProviderRegistry>,
  storage: ReturnType<typeof createSqliteStorage>,
  skillLoader: Awaited<ReturnType<typeof discoverSkills>>["loader"],
) {
  return {
    llmTaskExecutor: registry ? createLlmTaskToolExecutor(registry) : undefined,
    summarizeExecutor: registry
      ? createSummarizeToolExecutor(registry)
      : undefined,
    healthcheckExecutor: createHealthcheckToolExecutor({
      providerRegistry: registry,
      storageProvider: storage,
      skillLoader,
    }),
    releaseNotesExecutor: createReleaseNotesToolExecutor(
      fetchChangelogRange,
      VERSION,
    ),
  };
}

/** Assemble the composite tool executor for the main session. */
export function assembleMainToolExecutor(
  deps: {
    readonly execTools: ReturnType<typeof createExecTools>;
    readonly filesystemSandbox?: FilesystemSandbox;
    readonly cronManager: Awaited<
      ReturnType<typeof createPersistentCronManager>
    >;
    readonly todoManager: ReturnType<typeof createTodoManager>;
    readonly searchProvider: ReturnType<typeof buildWebTools>["searchProvider"];
    readonly webFetcher: ReturnType<typeof buildWebTools>["webFetcher"];
    readonly memoryExecutor: ReturnType<typeof createMemoryToolExecutor>;
    readonly planExecutor: ReturnType<typeof createPlanToolExecutor>;
    readonly browserExecutor: ReturnType<
      typeof createAutoLaunchBrowserExecutor
    >["executor"];
    readonly tidepoolExecutor: ReturnType<typeof createTidepoolToolExecutor>;
    readonly imageExecutor: ReturnType<typeof createImageToolExecutor>;
    readonly sessionExecutor: ReturnType<typeof createSessionToolExecutor>;
    readonly exploreExecutor: ReturnType<typeof createExploreToolExecutor>;
    readonly state: MainSessionState;
    readonly githubExecutor: ReturnType<typeof createGitHubToolExecutor>;
    readonly caldavExecutor?: ReturnType<typeof createCalDavToolExecutor>;
    readonly notionExecutor?: SubsystemExecutor;
    readonly xExecutor?: SubsystemExecutor;
    readonly obsidianExecutor:
      | Awaited<ReturnType<typeof buildObsidianExecutor>>
      | undefined;
    readonly registry: ReturnType<typeof createProviderRegistry>;
    readonly storage: ReturnType<typeof createSqliteStorage>;
    readonly skillLoader: Awaited<ReturnType<typeof discoverSkills>>["loader"];
    readonly claudeExecutor: ReturnType<typeof createClaudeToolExecutor>;
    readonly mcpExecutor:
      | ((
        name: string,
        input: Record<string, unknown>,
      ) => Promise<string | null>)
      | undefined;
    readonly subagentFactory: ReturnType<typeof buildSubagentFactory>;
    readonly secretExecutor: ReturnType<typeof createSecretToolExecutor>;
    readonly triggerExecutor: ReturnType<typeof createTriggerToolExecutor>;
    readonly skillExecutor: ReturnType<typeof createSkillToolExecutor>;
    readonly triggerManageExecutor?: SubsystemExecutor;
    readonly skillContextTracker?: SkillContextTracker;
    readonly simulateExecutor?: SubsystemExecutor;
    readonly teamExecutor?: ReturnType<typeof buildTeamExecutor>;
    readonly workflowRunRegistry?: WorkflowRunRegistry;
    readonly pluginExecutor?: SubsystemExecutor;
    readonly pluginToolExecutor?: SubsystemExecutor;
    readonly configManageExecutor?: SubsystemExecutor;
    readonly mcpManageExecutor?: SubsystemExecutor;
    readonly daemonManageExecutor?: SubsystemExecutor;
    readonly spineManageExecutor?: SubsystemExecutor;
  },
) {
  const aux = buildAuxiliaryExecutors(
    deps.registry,
    deps.storage,
    deps.skillLoader,
  );

  // Workflow executor needs the composite tool executor for dispatching
  // call tasks. Use late-binding via mutable ref to break the circular dependency.
  const compositeRef: {
    current?: (name: string, input: Record<string, unknown>) => Promise<string>;
  } = {};
  const workflowExecutor = deps.storage
    ? createWorkflowToolExecutor({
      store: createWorkflowStore(deps.storage),
      toolExecutor: (name, input) => compositeRef.current!(name, input),
      getSessionTaint: () => deps.state.session.taint,
      registry: deps.workflowRunRegistry,
    })
    : undefined;

  const sshExecutor = createSshToolExecutor();

  const toolExecutor = createToolExecutor({
    ...deps,
    googleExecutor: buildGoogleExecutor({
      getSessionTaint: () => deps.state.session.taint,
      sourceSessionId: deps.state.session.id,
    }),
    ...aux,
    providerRegistry: deps.registry,
    workflowExecutor,
    sshExecutor,
  });
  compositeRef.current = toolExecutor;
  return toolExecutor;
}

/** Build the dynamic extra tools getter for the chat session. */
export function buildExtraToolsGetter(
  mcpWiring: ReturnType<typeof wireMcpServers> | null,
  isTidepoolCallRef: { value: boolean },
  tidepoolToolsRef: {
    value: import("../../../tools/tidepool/mod.ts").TidePoolTools | undefined;
  },
  pluginRegistry?: PluginRegistry,
) {
  return () => [
    ...(mcpWiring ? mcpWiring.getToolDefinitions() : []),
    ...(pluginRegistry ? pluginRegistry.getToolDefinitions() : []),
    ...(pluginRegistry ? PLUGIN_TOOL_DEFINITIONS : []),
    ...(isTidepoolCallRef.value && tidepoolToolsRef.value
      ? TOOL_GROUPS.tidepool()
      : []),
  ];
}

/** Options for persona auto-recall in the system prompt getter. */
export interface PersonaRecallOptions {
  readonly memoryStore: MemoryStore;
  readonly agentId: string;
  readonly getSessionTaint: () => ClassificationLevel;
  /** Only inject persona context when the active session is the owner. */
  readonly isOwnerSession: () => boolean;
}

/** Build the dynamic extra system prompt sections getter. */
export function buildExtraSystemPromptGetter(
  mcpWiring: ReturnType<typeof wireMcpServers> | null,
  isTidepoolCallRef: { value: boolean },
  getSessionTaint: () => ClassificationLevel,
  workspacePaths: WorkspacePaths,
  personaOptions?: PersonaRecallOptions,
  getBumpersEnabled?: () => boolean,
  pluginRegistry?: PluginRegistry,
) {
  // Cache persona context with a short TTL to avoid querying the store
  // on every single LLM iteration within a rapid tool loop.
  let cachedPersona = "";
  let cacheTimestamp = 0;
  const CACHE_TTL_MS = 30_000; // 30 seconds

  return async () => {
    const sections: string[] = [];
    // MCP and plugin sections arrive pre-fenced as external metadata
    // (see fenceExternalMetadata in core/security/prompt_fencing.ts) —
    // never inject their raw text here.
    if (mcpWiring) {
      const mcpPrompt = mcpWiring.getSystemPrompt();
      if (mcpPrompt) sections.push(mcpPrompt);
    }
    if (isTidepoolCallRef.value) sections.push(TIDEPOOL_SYSTEM_PROMPT);
    if (getBumpersEnabled?.()) sections.push(BUMPERS_SYSTEM_PROMPT);
    if (pluginRegistry) {
      sections.push(...pluginRegistry.getSystemPrompts());
    }
    sections.push(buildWorkspacePrompt(getSessionTaint(), workspacePaths));

    if (personaOptions && personaOptions.isOwnerSession()) {
      const now = Date.now();
      if (now - cacheTimestamp > CACHE_TTL_MS) {
        try {
          cachedPersona = await loadPersonaContext({
            store: personaOptions.memoryStore,
            agentId: personaOptions.agentId,
            sessionTaint: personaOptions.getSessionTaint(),
          });
          cacheTimestamp = now;
        } catch (err) {
          log.error("Persona context load failed", {
            operation: "buildExtraSystemPromptGetter",
            err,
          });
        }
      }
      if (cachedPersona.length > 0) sections.push(cachedPersona);
    }

    return sections;
  };
}
