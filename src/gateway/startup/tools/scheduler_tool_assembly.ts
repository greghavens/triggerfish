/**
 * Tool executor assembly for scheduler agent sessions.
 *
 * Builds the composite tool executor used by scheduler, trigger,
 * and subagent sessions, including memory, GitHub, plan, session,
 * Google, and skill executors.
 * @module
 */

import { join } from "@std/path";
import type { TriggerFishConfig } from "../../../core/config.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { SessionId } from "../../../core/types/session.ts";
import type { createSession } from "../../../core/types/session.ts";
import type { createProviderRegistry } from "../../../agent/llm.ts";
import type { resolveVisionProvider } from "../../../agent/providers/config.ts";
import type { createWorkspace } from "../../../exec/workspace.ts";
import { createExecTools } from "../../../exec/tools.ts";
import {
  createFilesystemSandbox,
  probeDenoRuntime,
} from "../../../exec/sandbox/mod.ts";
import { createPathClassifier } from "../../../core/security/path_classification.ts";
import {
  createHealthcheckToolExecutor,
  createLlmTaskToolExecutor,
  createSummarizeToolExecutor,
  createTodoManager,
} from "../../../tools/mod.ts";
import {
  createMemoryStore,
  createMemoryToolExecutor,
} from "../../../tools/memory/mod.ts";
import {
  createPlanManager,
  createPlanToolExecutor,
} from "../../../agent/plan/plan.ts";
import {
  createGitHubClient,
  createGitHubToolExecutor,
  resolveGitHubToken,
} from "../../../integrations/github/mod.ts";
import type { createKeychain } from "../../../core/secrets/keychain/keychain.ts";
import { createSessionToolExecutor } from "../../tools/session/session_tools.ts";
import type { EnhancedSessionManager } from "../../sessions.ts";
import type { CronManager } from "../../../scheduler/cron/parser.ts";
import type { StorageProvider } from "../../../core/storage/provider.ts";
import { createSkillLoader } from "../../../tools/skills/loader.ts";
import {
  createSkillScanner,
  createSkillToolExecutor,
} from "../../../tools/skills/mod.ts";
import type { SkillContextTracker } from "../../../tools/skills/mod.ts";
import { createToolExecutor } from "../../tools/agent_tools.ts";
import type { buildWebTools } from "../factory/web_tools.ts";
import { buildGoogleExecutor } from "../factory/google_executor.ts";
import { resolveWorkspacePathForTaint } from "./tool_executor.ts";
import { createSimulateToolExecutor } from "../../tools/simulate/mod.ts";

/** Shared infrastructure captured once at factory creation. */
export interface FactoryInfra {
  readonly registry: ReturnType<typeof createProviderRegistry>;
  readonly searchProvider: ReturnType<typeof buildWebTools>["searchProvider"];
  readonly webFetcher: ReturnType<typeof buildWebTools>["webFetcher"];
  readonly domainClassifier: ReturnType<
    typeof buildWebTools
  >["domainClassifier"];
  readonly keychain: ReturnType<typeof createKeychain>;
  readonly toolClassifications: ReadonlyMap<string, ClassificationLevel>;
  readonly integrationClassifications: ReadonlyMap<string, ClassificationLevel>;
  readonly visionProvider: ReturnType<typeof resolveVisionProvider>;
  readonly skillLoader: ReturnType<typeof createSkillLoader>;
}

/** Build memory tool executor for a scheduler agent. */
function buildSchedulerMemoryExecutor(opts: {
  readonly storage: StorageProvider;
  readonly agentId: string;
  readonly sessionTaint: ClassificationLevel;
  readonly sourceSessionId: SessionId;
}) {
  const store = createMemoryStore({ storage: opts.storage });
  return createMemoryToolExecutor({
    store,
    agentId: opts.agentId,
    sessionTaint: opts.sessionTaint,
    sourceSessionId: opts.sourceSessionId,
  });
}

/** Build GitHub tool executor for a scheduler agent. */
export async function buildSchedulerGitHubExecutor(opts: {
  readonly keychain: ReturnType<typeof createKeychain>;
  readonly config: TriggerFishConfig;
  readonly sessionTaint: ClassificationLevel;
  readonly sourceSessionId: SessionId;
  readonly workspacePath?: string;
}) {
  const tokenResult = await resolveGitHubToken({
    secretStore: opts.keychain,
  });
  return createGitHubToolExecutor(
    tokenResult.ok
      ? {
        client: createGitHubClient({
          token: tokenResult.value,
          baseUrl: opts.config.github?.base_url,
          classificationConfig: opts.config.github?.classification_overrides
            ? {
              overrides: opts.config.github
                .classification_overrides as Readonly<
                  Record<string, ClassificationLevel>
                >,
            }
            : undefined,
        }),
        sessionTaint: opts.sessionTaint,
        sourceSessionId: opts.sourceSessionId,
        workspacePath: opts.workspacePath,
      }
      : undefined,
  );
}

/** Build skill loader for scheduler agents. */
export function buildSchedulerSkillLoader(
  baseDir: string,
  srcDir: string,
) {
  const bundledDir = join(srcDir, "..", "..", "skills", "bundled");
  const managedDir = join(baseDir, "skills");
  const workspaceDir = join(baseDir, "workspaces", "main", "skills");
  return createSkillLoader({
    directories: [bundledDir, managedDir, workspaceDir],
    dirTypes: {
      [bundledDir]: "bundled",
      [managedDir]: "managed",
      [workspaceDir]: "workspace",
    },
  });
}

/** Build path classifier for scheduler workspace if config available. */
export function buildSchedulerPathClassifier(
  fsPathMap: ReadonlyMap<string, ClassificationLevel> | undefined,
  fsDefault: ClassificationLevel | undefined,
  workspace: Awaited<ReturnType<typeof createWorkspace>>,
  opts?: { readonly resolveCwd?: () => string },
) {
  if (!fsPathMap) return undefined;
  return createPathClassifier(
    {
      paths: fsPathMap,
      defaultClassification: fsDefault ?? "CONFIDENTIAL",
    },
    {
      basePath: workspace.path,
      publicPath: workspace.publicPath,
      internalPath: workspace.internalPath,
      confidentialPath: workspace.confidentialPath,
      restrictedPath: workspace.restrictedPath,
    },
    opts?.resolveCwd ? { resolveCwd: opts.resolveCwd } : undefined,
  );
}

/** Assemble composite tool executor for a scheduler session. */
export function assembleSchedulerToolExecutor(opts: {
  readonly infra: FactoryInfra;
  readonly session: ReturnType<typeof createSession>;
  readonly workspace: Awaited<ReturnType<typeof createWorkspace>>;
  readonly cronManager?: CronManager;
  readonly storage?: StorageProvider;
  readonly enhancedSessionManager?: EnhancedSessionManager;
  readonly agentId: string;
  readonly githubExecutor: ReturnType<typeof createGitHubToolExecutor>;
  /** Per-session skill context tracker for tool/domain enforcement. */
  readonly skillContextTracker?: SkillContextTracker;
  /** Live getter for session taint, used for taint-aware command cwd. */
  readonly getSessionTaint?: () => ClassificationLevel;
  /** Override memory namespace (e.g. triggers share the owner namespace). */
  readonly memoryAgentId?: string;
}) {
  const { infra, session, workspace, agentId, storage } = opts;

  const memoryExecutor = storage
    ? buildSchedulerMemoryExecutor({
      storage,
      agentId: opts.memoryAgentId ?? agentId,
      sessionTaint: session.taint,
      sourceSessionId: session.id,
    })
    : undefined;

  const sessionExecutor = opts.enhancedSessionManager
    ? createSessionToolExecutor({
      sessionManager: opts.enhancedSessionManager,
      callerSessionId: session.id,
      callerTaint: session.taint,
    })
    : undefined;

  const workspacePaths = {
    publicPath: workspace.publicPath,
    internalPath: workspace.internalPath,
    confidentialPath: workspace.confidentialPath,
    restrictedPath: workspace.restrictedPath,
  };
  const getTaint = opts.getSessionTaint ?? (() => session.taint);
  const filesystemSandbox = probeDenoRuntime()
    ? createFilesystemSandbox({
      resolveWorkspacePath: () =>
        resolveWorkspacePathForTaint(getTaint(), workspacePaths),
    })
    : undefined;

  return createToolExecutor({
    execTools: createExecTools(workspace, {
      cwdOverride: () =>
        resolveWorkspacePathForTaint(getTaint(), workspacePaths),
    }),
    filesystemSandbox,
    cronManager: opts.cronManager,
    todoManager: storage ? createTodoManager({ storage, agentId }) : undefined,
    searchProvider: infra.searchProvider,
    webFetcher: infra.webFetcher,
    memoryExecutor,
    planExecutor: createPlanToolExecutor(
      createPlanManager({ plansDir: `${workspace.path}/plans` }),
      session.id,
    ),
    sessionExecutor,
    googleExecutor: buildGoogleExecutor({
      getSessionTaint: () => session.taint,
      sourceSessionId: session.id,
    }),
    githubExecutor: opts.githubExecutor,
    llmTaskExecutor: createLlmTaskToolExecutor(infra.registry),
    summarizeExecutor: createSummarizeToolExecutor(infra.registry),
    healthcheckExecutor: createHealthcheckToolExecutor({
      providerRegistry: infra.registry,
      storageProvider: storage,
      skillLoader: infra.skillLoader,
    }),
    skillExecutor: createSkillToolExecutor({
      skillLoader: infra.skillLoader,
      skillContextTracker: opts.skillContextTracker,
      getSessionTaint: () => session.taint,
      skillScanner: createSkillScanner(),
    }),
    skillContextTracker: opts.skillContextTracker,
    providerRegistry: infra.registry,
    simulateExecutor: createSimulateToolExecutor({
      getSessionTaint: getTaint,
      isOwner: () => false,
      isTrigger: () => true,
      toolClassifications: infra.toolClassifications
        ? new Map(infra.toolClassifications)
        : undefined,
      integrationClassifications: infra.integrationClassifications
        ? new Map(infra.integrationClassifications)
        : undefined,
      getWorkspacePath: () => workspace.path,
    }),
  });
}
