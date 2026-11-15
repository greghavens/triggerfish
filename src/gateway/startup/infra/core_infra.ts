/**
 * Core infrastructure initialization phase.
 *
 * Combines persistent storage, session management, filesystem/tool-floor
 * security config, and scheduler infrastructure into a single result.
 *
 * @module
 */

import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { MessageStore } from "../../../core/conversation/mod.ts";
import type { LineageStore } from "../../../core/session/lineage.ts";
import type { UserId } from "../../../core/types/session.ts";
import type { createSqliteStorage } from "../../../core/storage/sqlite.ts";
import type { createLogger } from "../../../core/logger/mod.ts";
import type { TriggerFishConfig } from "../../../core/config.ts";
import type { createPairingService } from "../../../channels/pairing.ts";
import type { createPersistentCronManager } from "../../../scheduler/cron/cron.ts";
import { createSchedulerService } from "../../../scheduler/service.ts";
import type { createEnhancedSessionManager } from "../../sessions.ts";
import type { createNotificationService } from "../../notifications/notifications.ts";
import type { createTriggerStore } from "../../../scheduler/triggers/store.ts";
import type { createToolFloorRegistry } from "../../../core/security/tool_floors.ts";
import { createOrchestratorFactory } from "../factory/orchestrator_factory.ts";
import { buildSchedulerConfig } from "../factory/scheduler_config.ts";
import { createDeferredMemoryCheck } from "./trigger_memory.ts";
import type { DeferredMemoryCheck } from "./trigger_memory.ts";
import type { GatewayServer } from "../../server/server.ts";
import type { A2UIHost } from "../../../tools/tidepool/host/host_types.ts";
import type { BootstrapResult } from "../bootstrap.ts";
import {
  buildFilesystemPathMap,
  buildToolFloorRegistryFromConfig,
} from "../bootstrap.ts";
import {
  initializePersistentStorage,
  initializeSessionInfrastructure,
} from "./storage.ts";

/** Mutable ref for the gateway server, populated after server start. */
export interface GatewayServerRef {
  value: GatewayServer | null;
}

/** Mutable ref for the Tidepool host, populated after Tidepool start. */
export interface TidepoolHostRef {
  value: A2UIHost | null;
}

/** Result of core infrastructure initialization. */
export interface CoreInfraResult {
  readonly dataDir: string;
  readonly storage: ReturnType<typeof createSqliteStorage>;
  readonly pairingService: ReturnType<typeof createPairingService>;
  readonly cronManager: Awaited<ReturnType<typeof createPersistentCronManager>>;
  readonly enhancedSessionManager: ReturnType<
    typeof createEnhancedSessionManager
  >;
  readonly notificationService: ReturnType<typeof createNotificationService>;
  readonly triggerStore: ReturnType<typeof createTriggerStore>;
  readonly fsPathMap: Map<string, ClassificationLevel>;
  readonly fsDefault: ClassificationLevel;
  readonly toolFloorRegistry: ReturnType<typeof createToolFloorRegistry>;
  readonly schedulerConfig: ReturnType<typeof buildSchedulerConfig>;
  readonly schedulerService: ReturnType<typeof createSchedulerService>;
  readonly factory: ReturnType<typeof createOrchestratorFactory>;
  readonly gatewayServerRef: GatewayServerRef;
  readonly tidepoolHostRef: TidepoolHostRef;
  readonly deferredMemoryCheck: DeferredMemoryCheck;
  readonly messageStore: MessageStore;
  readonly lineageStore: LineageStore;
}

/** Warn if filesystem default is PUBLIC. */
export function warnPublicFilesystemDefault(
  fsDefault: ClassificationLevel,
  log: ReturnType<typeof createLogger>,
): void {
  if (fsDefault === "PUBLIC") {
    log.warn(
      "filesystem.default is set to PUBLIC — all unmapped paths are accessible at PUBLIC level",
    );
  }
}

/** Build filesystem and tool-floor security config from YAML. */
export function buildSecurityConfig(
  config: TriggerFishConfig,
  log: ReturnType<typeof createLogger>,
) {
  const { fsPathMap, fsDefault } = buildFilesystemPathMap(
    config.filesystem as Record<string, unknown> | undefined,
  );
  warnPublicFilesystemDefault(fsDefault, log);
  const toolFloorRegistry = buildToolFloorRegistryFromConfig(
    config.tools as Record<string, unknown> | undefined,
  );
  return { fsPathMap, fsDefault, toolFloorRegistry };
}

/** Build orchestrator factory and scheduler service. */
export function buildSchedulerInfrastructure(
  config: TriggerFishConfig,
  baseDir: string,
  coreInfra: {
    cronManager: CoreInfraResult["cronManager"];
    storage: CoreInfraResult["storage"];
    enhancedSessionManager: CoreInfraResult["enhancedSessionManager"];
    notificationService: CoreInfraResult["notificationService"];
    triggerStore: CoreInfraResult["triggerStore"];
    fsPathMap: Map<string, ClassificationLevel>;
    fsDefault: ClassificationLevel;
    toolFloorRegistry: CoreInfraResult["toolFloorRegistry"];
  },
) {
  const factory = createOrchestratorFactory(
    config,
    baseDir,
    coreInfra.cronManager,
    coreInfra.storage,
    coreInfra.enhancedSessionManager,
    coreInfra.fsPathMap,
    coreInfra.fsDefault,
    coreInfra.toolFloorRegistry,
  );
  const schedulerConfig = buildSchedulerConfig(config, baseDir, factory);
  const gatewayServerRef: GatewayServerRef = { value: null };
  const tidepoolHostRef: TidepoolHostRef = { value: null };
  const deferredMemoryCheck = createDeferredMemoryCheck();
  const schedulerService = createSchedulerService({
    ...schedulerConfig,
    // Persist the webhook replay guard so a daemon restart within the
    // freshness window cannot reopen the replay hole (SCHEDULER-2).
    webhooks: {
      ...schedulerConfig.webhooks,
      replayStorage: coreInfra.storage,
    },
    checkMemoryInstructions: deferredMemoryCheck.check,
    cronManager: coreInfra.cronManager,
    notificationService: coreInfra.notificationService,
    ownerId: "owner" as UserId,
    triggerStore: coreInfra.triggerStore,
    onTriggerOutput: (source, classification, preview, firedAt) => {
      const event = {
        type: "trigger_prompt" as const,
        source,
        classification,
        preview,
        firedAt,
      };
      gatewayServerRef.value?.broadcastChatEvent(event);
      tidepoolHostRef.value?.broadcastChatEvent(event);
    },
  });
  return {
    factory,
    schedulerConfig,
    schedulerService,
    gatewayServerRef,
    tidepoolHostRef,
    deferredMemoryCheck,
  };
}

/** Initialize storage, sessions, security config, and scheduler. */
export async function initializeCoreInfrastructure(
  bootstrap: BootstrapResult,
): Promise<CoreInfraResult> {
  const { baseDir, config, log } = bootstrap;
  const persisted = await initializePersistentStorage(baseDir, log);
  const sessions = initializeSessionInfrastructure(persisted.storage);
  const security = buildSecurityConfig(config, log);
  const scheduler = buildSchedulerInfrastructure(config, baseDir, {
    ...persisted,
    ...sessions,
    ...security,
  });
  return { ...persisted, ...sessions, ...security, ...scheduler };
}
