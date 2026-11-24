/**
 * Session-scoped and media executor initialization.
 *
 * Builds the main session state, media executors (vision, browser,
 * tidepool, image), and session/channel management executors.
 *
 * @module
 */

import type { TriggerFishConfig } from "../../../core/config.ts";
import type {
  ChannelId,
  SessionId,
  UserId,
} from "../../../core/types/session.ts";
import { createSession, restoreSession } from "../../../core/types/session.ts";
import type { StorageProvider } from "../../../core/storage/provider.ts";
import { createLogger } from "../../../core/logger/logger.ts";
import type { createProviderRegistry } from "../../../agent/llm.ts";
import { resolveVisionProvider } from "../../../agent/providers/config.ts";
import type { ModelsConfig } from "../../../agent/providers/config.ts";
import type { createSqliteStorage } from "../../../core/storage/sqlite.ts";
import type {
  CredentialPromptCallback,
  SecretPromptCallback,
} from "../../../tools/secrets.ts";
import { createImageToolExecutor } from "../../../tools/image/mod.ts";
import { createTidepoolToolExecutor } from "../../../tools/tidepool/mod.ts";
import {
  createPlanManager,
  createPlanToolExecutor,
} from "../../../agent/plan/plan.ts";
import type { createWorkspace } from "../../../exec/workspace.ts";
import type { RegisteredChannel } from "../../tools/session/session_tools.ts";
import { createSessionToolExecutor } from "../../tools/session/session_tools.ts";
import type { BootstrapResult } from "../bootstrap.ts";
import type { CoreInfraResult } from "../infra/core_infra.ts";
import { initializeBrowserExecutor } from "../services/browser_init.ts";
import { initializeMemorySystem } from "../infra/workspace_init.ts";
import {
  createCliConfirmPrompt,
  createCliCredentialPrompt,
  createCliSecretPrompt,
} from "../infra/subsystems.ts";
import type { ConfirmPromptCallback } from "./tool_executor.ts";
import type { MainSessionState } from "./tool_executor.ts";
import type { TidepoolToolsRef } from "./tool_infra_types.ts";

const log = createLogger("session-persistence");

/** Storage key for the persisted main session ID. */
export const MAIN_SESSION_ID_KEY = "main-session-id";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate that a persisted session ID is a well-formed UUID. */
export function isValidSessionId(value: string): boolean {
  return UUID_RE.test(value);
}

/** Create the main session state and core session-level executors. */
export async function initializeMainSessionState(opts?: {
  readonly bumpersEnabled?: boolean;
  readonly storage?: StorageProvider;
}): Promise<{
  state: MainSessionState;
  cliSecretPrompt: SecretPromptCallback;
  cliCredentialPrompt: CredentialPromptCallback;
  cliConfirmPrompt: ConfirmPromptCallback;
}> {
  const session = await restoreOrCreateMainSession(opts);
  const state: MainSessionState = {
    session,
    activeSecretPrompt: createCliSecretPrompt(),
    activeCredentialPrompt: createCliCredentialPrompt(),
    activeConfirmPrompt: createCliConfirmPrompt(),
  };
  return {
    state,
    cliSecretPrompt: state.activeSecretPrompt,
    cliCredentialPrompt: state.activeCredentialPrompt,
    cliConfirmPrompt: state.activeConfirmPrompt,
  };
}

/** Restore a persisted main session ID from storage, or create a new one. */
async function restoreOrCreateMainSession(opts?: {
  readonly bumpersEnabled?: boolean;
  readonly storage?: StorageProvider;
}) {
  const sessionOpts = {
    userId: "owner" as UserId,
    channelId: "daemon" as ChannelId,
    bumpersEnabled: opts?.bumpersEnabled,
  };

  if (opts?.storage) {
    const restored = await loadPersistedSession(opts.storage);
    if (restored) {
      return restoreSession({
        ...sessionOpts,
        id: restored.id as SessionId,
        createdAt: new Date(restored.createdAt),
      });
    }
    const session = createSession(sessionOpts);
    await persistSessionRecord(opts.storage, session.id as string);
    return session;
  }

  return createSession(sessionOpts);
}

/** Persisted session record shape stored as JSON in StorageProvider. */
interface PersistedSessionRecord {
  readonly id: string;
  readonly createdAt: string;
}

/** Load and validate a persisted session record from storage. */
async function loadPersistedSession(
  storage: StorageProvider,
): Promise<PersistedSessionRecord | null> {
  const raw = await storage.get(MAIN_SESSION_ID_KEY);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as PersistedSessionRecord;
    if (!isValidSessionId(record.id)) {
      log.warn("Persisted main session ID has invalid format, generating new", {
        operation: "loadPersistedSession",
        invalidId: record.id,
      });
      return null;
    }
    log.info("Restored persisted main session ID", {
      operation: "loadPersistedSession",
      sessionId: record.id,
    });
    return record;
  } catch {
    return migrateLegacySessionRecord(raw, storage);
  }
}

/** Migrate a bare-UUID legacy record to JSON format, or return null if corrupt. */
async function migrateLegacySessionRecord(
  raw: string,
  storage: StorageProvider,
): Promise<PersistedSessionRecord | null> {
  if (!isValidSessionId(raw)) {
    log.warn("Persisted session record is corrupt, generating new", {
      operation: "migrateLegacySessionRecord",
    });
    return null;
  }
  const migrated: PersistedSessionRecord = {
    id: raw,
    createdAt: new Date().toISOString(),
  };
  await storage.set(MAIN_SESSION_ID_KEY, JSON.stringify(migrated));
  log.info("Migrated legacy persisted session ID to JSON format", {
    operation: "migrateLegacySessionRecord",
    sessionId: raw,
  });
  return migrated;
}

/** Persist a session ID and creation timestamp to storage. */
export async function persistSessionRecord(
  storage: StorageProvider,
  sessionId: string,
): Promise<void> {
  const record: PersistedSessionRecord = {
    id: sessionId,
    createdAt: new Date().toISOString(),
  };
  await storage.set(MAIN_SESSION_ID_KEY, JSON.stringify(record));
  log.info("Persisted new main session ID", {
    operation: "persistSessionRecord",
    sessionId,
  });
}

/** Build media-related executors (vision, browser, tidepool, image). */
export function buildMediaExecutors(
  config: TriggerFishConfig,
  dataDir: string,
  storage: ReturnType<typeof createSqliteStorage>,
  state: MainSessionState,
  registry: ReturnType<typeof createProviderRegistry>,
) {
  const visionProvider = resolveVisionProvider(config.models as ModelsConfig);
  const browserHandle = initializeBrowserExecutor(
    config,
    dataDir,
    storage,
    () => state.session.taint,
    visionProvider,
    registry.getDefault(),
  );
  // deno-lint-ignore prefer-const
  let tidepoolToolsRef: TidepoolToolsRef = { value: undefined };
  const tidepoolExecutor = createTidepoolToolExecutor(
    () => tidepoolToolsRef.value,
  );
  const imageExecutor = createImageToolExecutor(registry, visionProvider);
  return {
    visionProvider,
    browserHandle,
    tidepoolToolsRef,
    tidepoolExecutor,
    imageExecutor,
  };
}

/** Build session and channel management executors. */
export function buildSessionChannelExecutors(
  coreInfra: CoreInfraResult,
  state: MainSessionState,
) {
  const channelAdapters = new Map<string, RegisteredChannel>();
  const sessionExecutor = createSessionToolExecutor({
    sessionManager: coreInfra.enhancedSessionManager,
    callerSessionId: state.session.id,
    callerTaint: state.session.taint,
    getCallerTaint: () => state.session.taint,
    channels: channelAdapters,
    pairingService: coreInfra.pairingService,
  });
  return { channelAdapters, sessionExecutor };
}

/** Create session-scoped executors (memory, plan, browser, tidepool, image, session). */
export async function buildSessionScopedExecutors(
  bootstrap: BootstrapResult,
  coreInfra: CoreInfraResult,
  toolInfra: {
    registry: ReturnType<typeof createProviderRegistry>;
    mainWorkspace: Awaited<ReturnType<typeof createWorkspace>>;
    state: MainSessionState;
  },
) {
  const { state, mainWorkspace, registry } = toolInfra;
  const { memoryDb, memoryStore, memorySearchProvider, memoryExecutor } =
    await initializeMemorySystem({
      dataDir: coreInfra.dataDir,
      storage: coreInfra.storage,
      session: state.session,
      lineageStore: coreInfra.lineageStore,
    });
  const mainPlanExecutor = createPlanToolExecutor(
    createPlanManager({ plansDir: `${mainWorkspace.path}/plans` }),
    state.session.id,
  );
  const media = buildMediaExecutors(
    bootstrap.config,
    coreInfra.dataDir,
    coreInfra.storage,
    state,
    registry,
  );
  const channels = buildSessionChannelExecutors(coreInfra, state);
  return {
    memoryDb,
    memoryStore,
    memorySearchProvider,
    memoryExecutor,
    mainPlanExecutor,
    ...media,
    ...channels,
  };
}
