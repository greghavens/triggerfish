/**
 * X executor factory — builds the X tool executor at startup.
 *
 * Resolves the X OAuth tokens from the OS keychain, creates the API client,
 * services, and returns a chain-compatible executor. Returns undefined if
 * X is not configured or tokens are not found (lazy error at tool-call time).
 *
 * @module
 */

import type { TriggerFishConfig } from "../../../core/config.ts";
import type { SecretStore } from "../../../core/secrets/backends/secret_store.ts";
import { createKeychain } from "../../../core/secrets/keychain/keychain.ts";
import { createLogger } from "../../../core/logger/mod.ts";
import {
  createXApiClient,
  createXAuthManager,
  createXToolExecutor,
} from "../../../integrations/x/mod.ts";
import {
  createXQuotaTracker,
  createXRateLimiter,
} from "../../../integrations/x/client/mod.ts";
import { createPostsService } from "../../../integrations/x/posts/mod.ts";
import { createUsersService } from "../../../integrations/x/users/mod.ts";
import { createEngageService } from "../../../integrations/x/engage/mod.ts";
import { createListsService } from "../../../integrations/x/lists/mod.ts";
import type { XAuthManager } from "../../../integrations/x/auth/types_auth.ts";

const log = createLogger("gateway.x");

/** Key for the authenticated user's X user ID in the keychain. */
const USER_ID_KEY = "x:user_id";

/** Auth state loaded from the keychain, or null if unavailable. */
interface XAuthState {
  readonly authManager: XAuthManager;
  readonly authenticatedUserId: string;
}

/** Load X auth tokens and user ID from keychain. Returns null if unavailable. */
async function loadXAuthState(
  keychain: SecretStore,
  authManager: XAuthManager,
): Promise<XAuthState | null> {
  const hasTokens = await authManager.hasTokens();
  if (!hasTokens) {
    log.warn("X enabled but tokens not found in keychain", {
      operation: "loadXAuthState",
    });
    return null;
  }

  const userIdResult = await keychain.getSecret(USER_ID_KEY);
  if (!userIdResult.ok) {
    log.warn("X tokens found but user ID not stored", {
      operation: "loadXAuthState",
      err: userIdResult.error,
    });
    return null;
  }

  return { authManager, authenticatedUserId: userIdResult.value };
}

/** Options for assembling X services. */
interface AssembleXServicesOpts {
  readonly config: TriggerFishConfig;
  readonly authState: XAuthState;
  readonly keychain: SecretStore;
  readonly workspacePath?: string;
}

/** Create all X service instances and wire up the tool executor. */
function assembleXServices(
  opts: AssembleXServicesOpts,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  const tier = opts.config.x?.tier ?? "free";
  const rateLimiter = createXRateLimiter();
  const quotaTracker = createXQuotaTracker(opts.keychain, tier, {
    warningThreshold: opts.config.x?.quota?.log_warning_ratio,
    cutoffThreshold: opts.config.x?.quota?.response_warning_ratio,
  });
  const apiClient = createXApiClient(opts.authState.authManager, rateLimiter);
  const uid = opts.authState.authenticatedUserId;

  return createXToolExecutor({
    posts: createPostsService(apiClient, uid, opts.workspacePath),
    users: createUsersService(apiClient, uid),
    engage: createEngageService(apiClient, uid),
    lists: createListsService(apiClient, uid),
    quotaTracker,
    tier,
    authenticatedUserId: uid,
  });
}

/**
 * Build the X tool executor from config and keychain.
 *
 * Returns undefined if X is not enabled. Returns a graceful "not configured"
 * executor if tokens are not found.
 */
export async function buildXExecutor(
  config: TriggerFishConfig,
  opts?: { readonly workspacePath?: string },
): Promise<
  | ((name: string, input: Record<string, unknown>) => Promise<string | null>)
  | undefined
> {
  if (config.x?.enabled !== true) {
    return undefined;
  }

  const keychain = createKeychain();
  const authManager = createXAuthManager(keychain);
  const authState = await loadXAuthState(keychain, authManager);

  if (!authState) {
    return createXToolExecutor(undefined);
  }

  return assembleXServices({
    config,
    authState,
    keychain,
    workspacePath: opts?.workspacePath,
  });
}
