/**
 * CalDAV tool executor builder.
 *
 * Creates the full auth → client → discovery → executor chain.
 * Auth failures are lazy — if credentials don't exist, the user gets
 * a clear error at tool-call time, not at startup.
 *
 * @module
 */

import type { ClassificationLevel } from "../../../core/types/classification.ts";
import type { SessionId } from "../../../core/types/session.ts";
import type { CalDavConfig } from "../../../integrations/caldav/mod.ts";
import {
  buildAuthHeaders,
  createCalDavClient,
  createCalDavToolExecutor,
  discoverCalDavEndpoint,
  resolveCalDavCredentials,
} from "../../../integrations/caldav/mod.ts";
import { createKeychain } from "../../../core/secrets/keychain/keychain.ts";
import { createSsrfCheckedFetch } from "../../../core/security/mod.ts";
import { parseClassification } from "../../../core/types/classification.ts";
import { createLogger } from "../../../core/logger/logger.ts";

const log = createLogger("caldav:executor");

/**
 * Build CalDAV tool executor.
 *
 * Creates the full auth → client → discovery → executor chain.
 * Returns undefined if CalDAV is not configured or credentials are missing.
 * Returns the executor directly if configured — discovery errors surface at tool-call time.
 */
export async function buildCalDavExecutor(
  config: CalDavConfig | undefined,
  getSessionTaint: () => ClassificationLevel,
  sourceSessionId: SessionId,
): Promise<
  | ((name: string, input: Record<string, unknown>) => Promise<string | null>)
  | undefined
> {
  if (!config?.enabled || !config.server_url) {
    return undefined;
  }

  try {
    const secretStore = createKeychain();
    const credResult = await resolveCalDavCredentials({
      secretStore,
      config,
    });

    if (!credResult.ok) {
      log.warn("CalDAV credentials not available, executor deferred", {
        operation: "buildCalDavExecutor",
        err: { message: credResult.error },
      });
      // Return executor that surfaces the error at tool-call time
      return createCalDavToolExecutor(undefined);
    }

    const authHeaders = buildAuthHeaders(credResult.value);
    // SSRF-checked fetch covers the config server_url AND every
    // server-returned URL (principal, calendar-home) used during discovery.
    const client = createCalDavClient({
      baseUrl: config.server_url,
      authHeaders,
      fetchFn: createSsrfCheckedFetch(),
    });

    const discovery = await discoverCalDavEndpoint({
      serverUrl: config.server_url,
      client,
    });

    if (!discovery.ok) {
      log.warn("CalDAV discovery failed, executor will report error", {
        operation: "buildCalDavExecutor",
        err: { message: discovery.error },
      });
      return createCalDavToolExecutor(undefined);
    }

    const classificationFloor = config.classification
      ? parseClassification(config.classification).ok
        ? (parseClassification(config.classification) as {
          ok: true;
          value: ClassificationLevel;
        }).value
        : undefined
      : undefined;

    log.info("CalDAV executor built successfully", {
      operation: "buildCalDavExecutor",
      calendarHomeUrl: discovery.value.calendarHomeUrl,
      serverType: discovery.value.serverType,
    });

    return createCalDavToolExecutor({
      client,
      calendarHomeUrl: discovery.value.calendarHomeUrl,
      defaultCalendar: config.default_calendar,
      sessionTaint: getSessionTaint,
      sourceSessionId,
      classificationFloor,
    });
  } catch (err) {
    log.error("CalDAV executor build failed", {
      operation: "buildCalDavExecutor",
      err,
    });
    return undefined;
  }
}
