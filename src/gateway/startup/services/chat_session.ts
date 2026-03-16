/**
 * Chat session assembly, Tidepool host, and Gateway server wiring.
 *
 * Re-exports from split sub-modules for backward compatibility.
 * See chat_session_assembly.ts and chat_session_network.ts for implementations.
 *
 * @module
 */

import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { TriggerFishConfig } from "../../../core/config.ts";
import type { createLogger } from "../../../core/logger/mod.ts";
import type { createProviderRegistry } from "../../../agent/llm.ts";
import type { resolveVisionProvider } from "../../../agent/providers/config.ts";
import type { createHookRunner } from "../../../core/policy/hooks/hooks.ts";
import type { createKeychain } from "../../../core/secrets/keychain/keychain.ts";
import type { createPathClassifier } from "../../../core/security/path_classification.ts";
import type { createToolFloorRegistry } from "../../../core/security/tool_floors.ts";
import type { createAutoLaunchBrowserExecutor } from "../../../tools/browser/mod.ts";
import type { createPairingService } from "../../../channels/pairing.ts";
import type { TriggerStore } from "../../../scheduler/triggers/store.ts";
import type { StorageProvider } from "../../../core/storage/provider.ts";
import type { createToolExecutor } from "../../tools/agent_tools.ts";
import type { wireMcpServers } from "../infra/mcp.ts";
import type { buildWebTools } from "../factory/web_tools.ts";
import type {
  MainSessionState,
  WorkspacePaths,
} from "../tools/tool_executor.ts";
import type { PersonaRecallOptions } from "../tools/tool_executor.ts";
import type { ServiceAvailability } from "../../tools/defs/tool_profiles.ts";

// Re-exports
export {
  assembleChatSession,
  buildChatSessionDynamicOptions,
  buildSessionLifecycleCallbacks,
} from "./chat_session_assembly.ts";

export {
  startGatewayServer,
  startTidepoolHost,
  wireMessageChannels,
  wrapChatSessionForGateway,
  wrapChatSessionForTidepool,
} from "./chat_session_network.ts";

/** Shared deps shape for assembleChatSession. */
export interface ChatSessionDeps {
  readonly hookRunner: ReturnType<typeof createHookRunner>;
  readonly registry: ReturnType<typeof createProviderRegistry>;
  readonly spinePath: string;
  readonly mcpWiring: ReturnType<typeof wireMcpServers> | null;
  readonly isTidepoolCallRef: { value: boolean };
  readonly tidepoolToolsRef: {
    value: import("../../../tools/tidepool/mod.ts").TidePoolTools | undefined;
  };
  readonly toolExecutor: ReturnType<typeof createToolExecutor>;
  readonly skillsPrompt: string;
  readonly triggersPrompt: string;
  readonly mainKeychain: ReturnType<typeof createKeychain>;
  readonly state: MainSessionState;
  readonly streamingPref: unknown;
  readonly config: TriggerFishConfig;
  readonly visionProvider: ReturnType<typeof resolveVisionProvider>;
  readonly toolClassifications: Map<string, ClassificationLevel>;
  readonly integrationClassifications: Map<string, ClassificationLevel>;
  readonly browserHandle: ReturnType<typeof createAutoLaunchBrowserExecutor>;
  readonly log: ReturnType<typeof createLogger>;
  readonly pairingService: ReturnType<typeof createPairingService>;
  readonly pathClassifier: ReturnType<typeof createPathClassifier>;
  readonly domainClassifier: ReturnType<
    typeof buildWebTools
  >["domainClassifier"];
  readonly toolFloorRegistry: ReturnType<typeof createToolFloorRegistry>;
  /** Active skill context getter for tool filtering (optional). */
  readonly getActiveSkillContext?: () =>
    | import("../../../agent/orchestrator/orchestrator_types.ts").ActiveSkillContext
    | null;
  /** Trigger store for retrieving trigger results on prompt acceptance. */
  readonly triggerStore?: TriggerStore;
  /** Broadcast a chat event to all connected sockets. */
  readonly broadcastChatEvent?: (
    event: import("../../../core/types/chat_event.ts").ChatEvent,
  ) => void;
  /** Classification-partitioned workspace paths for dynamic prompt injection. */
  readonly workspacePaths: WorkspacePaths;
  /** Returns the taint-aware workspace path for shell command classification. */
  readonly getWorkspacePath: () => string | null;
  /** Which external services are configured and have credentials. */
  readonly serviceAvailability: ServiceAvailability;
  /** Persona auto-recall options (memory store + agent ID). */
  readonly personaOptions?: PersonaRecallOptions;
  /** Mutable ref toggled by non-owner turn wrappers. */
  readonly isOwnerTurnRef?: { value: boolean };
  /** Message store for conversation persistence. */
  readonly messageStore?:
    import("../../../core/conversation/mod.ts").MessageStore;
  /** Lineage store for automatic data provenance tracking. */
  readonly lineageStore?:
    import("../../../core/session/lineage.ts").LineageStore;
  /** Storage provider for bumper preference persistence. */
  readonly storage?: StorageProvider;
  /** Owner identifier for bumper preference storage key. */
  readonly ownerId?: string;
}
