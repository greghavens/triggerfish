/**
 * Tool infrastructure result types and service availability detection.
 *
 * @module
 */

import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { TriggerFishConfig } from "../../../core/config.ts";
import type { createProviderRegistry } from "../../../agent/llm.ts";
import type { resolveVisionProvider } from "../../../agent/providers/config.ts";
import type { createHookRunner } from "../../../core/policy/hooks/hooks.ts";
import type { createSqliteStorage } from "../../../core/storage/sqlite.ts";
import type { createWorkspace } from "../../../exec/workspace.ts";
import type { createPathClassifier } from "../../../core/security/path_classification.ts";
import type {
  CredentialPromptCallback,
  SecretPromptCallback,
} from "../../../tools/secrets.ts";
import type { RegisteredChannel } from "../../tools/session/session_tools.ts";
import type { McpBroadcastRefs } from "../infra/mcp.ts";
import type { wireMcpServers } from "../infra/mcp.ts";
import type { createToolExecutor } from "../../tools/agent_tools.ts";
import type { buildWebTools } from "../factory/web_tools.ts";
import type { CoreInfraResult } from "../infra/core_infra.ts";
import type { initializeMemorySystem } from "../infra/workspace_init.ts";
import type { initializeBrowserExecutor } from "../services/browser_init.ts";
import type { MainSessionState } from "./tool_executor.ts";
import type { SkillContextTracker } from "../../../tools/skills/mod.ts";
import type { ServiceAvailability } from "../../tools/defs/tool_profiles.ts";
import type { WorkflowRunRegistry } from "../../../workflow/mod.ts";
import type { PluginRegistry } from "../../../plugin/mod.ts";
import { createLogger } from "../../../core/logger/logger.ts";

const availabilityLog = createLogger("service-availability");

/** Mutable ref to tidepool tools, set after host starts. */
export type TidepoolToolsRef = {
  value: import("../../../tools/tidepool/mod.ts").TidePoolTools | undefined;
};

/** Result of tool infrastructure initialization. */
export interface ToolInfraResult {
  readonly registry: ReturnType<typeof createProviderRegistry>;
  readonly hookRunner: ReturnType<typeof createHookRunner>;
  readonly spinePath: string;
  readonly mainWorkspace: Awaited<ReturnType<typeof createWorkspace>>;
  readonly pathClassifier: ReturnType<typeof createPathClassifier>;
  readonly visionProvider: ReturnType<typeof resolveVisionProvider>;
  readonly state: MainSessionState;
  readonly cliSecretPrompt: SecretPromptCallback;
  readonly cliCredentialPrompt: CredentialPromptCallback;
  readonly cliConfirmPrompt: (message: string) => Promise<boolean>;
  readonly memoryDb: Awaited<
    ReturnType<typeof initializeMemorySystem>
  >["memoryDb"];
  readonly memoryStore: Awaited<
    ReturnType<typeof initializeMemorySystem>
  >["memoryStore"];
  readonly memorySearchProvider: Awaited<
    ReturnType<typeof initializeMemorySystem>
  >["memorySearchProvider"];
  readonly browserHandle: ReturnType<typeof initializeBrowserExecutor>;
  readonly channelAdapters: Map<string, RegisteredChannel>;
  readonly toolClassifications: Map<string, ClassificationLevel>;
  readonly integrationClassifications: Map<string, ClassificationLevel>;
  readonly classifyGitHubRepo: (
    repoFullName: string,
  ) => ClassificationLevel | null;
  readonly keychain: ReturnType<
    typeof import("../../../core/secrets/keychain/keychain.ts").createKeychain
  >;
  readonly mcpBroadcastRefs: McpBroadcastRefs;
  readonly mcpWiring: ReturnType<typeof wireMcpServers> | null;
  readonly toolExecutor: ReturnType<typeof createToolExecutor>;
  readonly skillsPrompt: string;
  readonly triggersPrompt: string;
  readonly mainKeychain: ReturnType<
    typeof import("../../../core/secrets/keychain/keychain.ts").createKeychain
  >;
  readonly domainClassifier: ReturnType<
    typeof buildWebTools
  >["domainClassifier"];
  readonly toolFloorRegistry: CoreInfraResult["toolFloorRegistry"];
  readonly tidepoolToolsRef: TidepoolToolsRef;
  /** Per-session skill context tracker for tool/domain enforcement. */
  readonly skillContextTracker?: SkillContextTracker;
  /** Which external services are configured and have credentials. */
  readonly serviceAvailability: ServiceAvailability;
  /** Shared workflow run registry for tracking active executions. */
  readonly workflowRunRegistry: WorkflowRunRegistry;
  /** Registry of dynamically loaded plugins. */
  readonly pluginRegistry: PluginRegistry;
}

/**
 * Detect which external services have credentials/config available.
 *
 * Probes the keychain for Google tokens and GitHub PAT,
 * and checks config for CalDAV, Obsidian, Signal, Telegram, Discord, WhatsApp.
 */
export async function detectServiceAvailability(
  config: TriggerFishConfig,
  keychain: ReturnType<
    typeof import("../../../core/secrets/keychain/keychain.ts").createKeychain
  >,
): Promise<ServiceAvailability> {
  const [googleResult, githubResult, notionResult, xResult] = await Promise.all(
    [
      keychain.getSecret("google:tokens"),
      keychain.getSecret("github-pat"),
      keychain.getSecret("notion-api-key"),
      keychain.getSecret("x:tokens"),
    ],
  );

  const availability: ServiceAvailability = {
    google: googleResult.ok,
    github: githubResult.ok,
    caldav: config.caldav?.enabled === true,
    notion: config.notion?.enabled === true && notionResult.ok,
    x: config.x?.enabled === true && xResult.ok,
    obsidian: config.plugins?.obsidian?.enabled === true,
    signal: config.channels?.signal !== undefined,
    telegram: (config.channels?.telegram as { botToken?: string } | undefined)
      ?.botToken !== undefined,
    discord: config.channels?.discord !== undefined,
    whatsapp: config.channels?.whatsapp !== undefined,
  };

  availabilityLog.info("Service availability detected", {
    operation: "detectServiceAvailability",
    ...availability,
  });

  return availability;
}

/** Load persisted bumper preference from storage. */
export async function loadBumpersPreference(
  storage: ReturnType<typeof createSqliteStorage>,
): Promise<boolean | undefined> {
  const log = createLogger("tool-infra");
  try {
    const raw = await storage.get("prefs:owner:bumpers_default");
    if (raw !== null) return JSON.parse(raw) as boolean;
  } catch (err: unknown) {
    log.warn("Bumper preference load failed, using default", {
      operation: "loadBumpersPreference",
      err,
    });
  }
  return undefined;
}
