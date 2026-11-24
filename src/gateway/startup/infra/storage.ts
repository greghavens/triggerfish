/**
 * Persistent storage, session infrastructure, and LLM provider initialization.
 *
 * Creates the SQLite storage backend, session manager, notification service,
 * and LLM provider registry with policy engine.
 *
 * @module
 */

import { join } from "@std/path";
import { createSqliteStorage } from "../../../core/storage/sqlite.ts";
import { createPairingService } from "../../../channels/pairing.ts";
import { createPersistentCronManager } from "../../../scheduler/cron/cron.ts";
import { createSessionManager } from "../../../core/session/manager.ts";
import { createEnhancedSessionManager } from "../../sessions.ts";
import { createNotificationService } from "../../notifications/notifications.ts";
import { createTriggerStore } from "../../../scheduler/triggers/store.ts";
import { createMessageStore } from "../../../core/conversation/mod.ts";
import { createLineageStore } from "../../../core/session/lineage.ts";
import { createProviderRegistry } from "../../../agent/llm.ts";
import { loadProvidersFromConfig } from "../../../agent/providers/config.ts";
import type { ModelsConfig } from "../../../agent/providers/config.ts";
import { createPolicyEngine } from "../../../core/policy/engine.ts";
import {
  createDefaultRules,
  createHookRunner,
} from "../../../core/policy/hooks/hooks.ts";
import type { createLogger } from "../../../core/logger/mod.ts";
import type { TriggerFishConfig } from "../../../core/config.ts";

/** Initialize persistent storage, pairing service, and cron manager. */
export async function initializePersistentStorage(
  baseDir: string,
  log: ReturnType<typeof createLogger>,
) {
  const dataDir = join(baseDir, "data");
  const storage = createSqliteStorage(join(dataDir, "triggerfish.db"));
  const pairingService = createPairingService(storage);
  const cronManager = await createPersistentCronManager(storage);
  const existingJobs = cronManager.list();
  if (existingJobs.length > 0) {
    log.info(`Loaded ${existingJobs.length} persistent cron job(s)`);
  }
  return { dataDir, storage, pairingService, cronManager };
}

/** Create session manager, notification service, trigger store, message store, and lineage store. */
export function initializeSessionInfrastructure(
  storage: ReturnType<typeof createSqliteStorage>,
  sentinelNotifications?: Parameters<typeof createNotificationService>[1],
) {
  const baseSessionManager = createSessionManager(storage);
  const enhancedSessionManager = createEnhancedSessionManager(
    baseSessionManager,
  );
  const notificationService = createNotificationService(
    storage,
    sentinelNotifications,
  );
  const triggerStore = createTriggerStore(storage);
  const messageStore = createMessageStore(storage);
  const lineageStore = createLineageStore(storage);
  return {
    enhancedSessionManager,
    notificationService,
    triggerStore,
    messageStore,
    lineageStore,
  };
}

/** Build LLM provider registry, policy engine, and hook runner. */
export function initializeLlmProviders(
  config: TriggerFishConfig,
  log: ReturnType<typeof createLogger>,
) {
  const registry = createProviderRegistry();
  loadProvidersFromConfig(config.models as ModelsConfig, registry);
  if (!registry.getDefault()) {
    log.error("No LLM provider configured. Check triggerfish.yaml.");
    Deno.exit(1);
  }
  const engine = createPolicyEngine();
  for (const rule of createDefaultRules()) {
    engine.addRule(rule);
  }
  const hookRunner = createHookRunner(engine);
  return { registry, hookRunner };
}
