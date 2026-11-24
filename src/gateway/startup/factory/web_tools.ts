/**
 * Web search and fetch infrastructure builder.
 *
 * Assembles a SearchProvider, WebFetcher, and DomainClassifier
 * from the application config's web section.
 * @module
 */

import { createSentinelEgressChecker } from "../../../sentinel/egress.ts";
import { createLogger } from "../../../core/logger/mod.ts";
import { canFlowTo } from "../../../core/types/classification.ts";
import {
  publishSentinelWebCapture,
  sentinelCaptureOrigins,
} from "../../../sentinel/native_capture.ts";
import {
  sentinelContainmentPath,
  sentinelNativeCapturePath,
  sentinelSnapshotPath,
} from "../../../sentinel/paths.ts";
import type { TriggerFishConfig } from "../../../core/config.ts";
import type { ClassificationLevel } from "../../../core/types/classification.ts";
import {
  createBraveSearchProvider,
  createCloudSearchProvider,
  createDomainClassifier,
  createDomainPolicy,
  createRateLimitedSearchProvider,
  createWebFetcher,
} from "../../../tools/web/mod.ts";
import type {
  DomainClassifier,
  DomainSecurityConfig,
  SearchProvider,
  WebFetcher,
} from "../../../tools/web/mod.ts";

/** Result of building web tools from config. */
export interface WebToolsResult {
  readonly searchProvider: SearchProvider | undefined;
  readonly webFetcher: WebFetcher;
  readonly domainClassifier: DomainClassifier;
}

/** Build domain security config from the application YAML config. */
function buildDomainSecurityConfig(
  config: TriggerFishConfig,
): DomainSecurityConfig {
  const webConfig = config.web;
  return {
    allowlist: webConfig?.domains?.allowlist ?? [],
    denylist: webConfig?.domains?.denylist ?? [],
    classificationMap: (webConfig?.domains?.classifications ?? []).map((c) => ({
      pattern: c.pattern,
      classification: c.classification as ClassificationLevel,
    })),
  };
}

/** Build search provider from config, applying rate limiting if configured. */
function buildSearchProvider(
  config: TriggerFishConfig,
): SearchProvider | undefined {
  const searchConfig = config.web?.search;

  // Cloud search provider for Triggerfish Gateway subscribers
  if (searchConfig?.provider === "cloud") {
    const tfProvider = config.models.providers["triggerfish"];
    return createCloudSearchProvider({
      gatewayUrl: (tfProvider as unknown as Record<string, string>)
        ?.gatewayUrl,
      licenseKey: (tfProvider as unknown as Record<string, string>)
        ?.licenseKey,
    });
  }

  if (!searchConfig?.api_key) return undefined;

  const provider = createBraveSearchProvider({
    apiKey: searchConfig.api_key,
  });

  if (searchConfig.rate_limit) {
    return createRateLimitedSearchProvider(provider, searchConfig.rate_limit);
  }
  return provider;
}

/**
 * Build web search/fetch infrastructure from config.
 *
 * Returns a SearchProvider (if configured) and a WebFetcher.
 */
export function buildWebTools(
  config: TriggerFishConfig,
  baseDir: string,
): WebToolsResult {
  const domainSecConfig = buildDomainSecurityConfig(config);
  const domainPolicy = createDomainPolicy(domainSecConfig);

  const containment = config.web?.domains?.sentinel_containment;
  const dnsChecker = containment === true
    ? createSentinelEgressChecker(sentinelContainmentPath(baseDir))
    : undefined;
  const origins = sentinelCaptureOrigins(config.sentinel?.capture_origins);
  const webFetcher = createWebFetcher({ domainPolicy, dnsChecker });
  const capturePath = sentinelNativeCapturePath(sentinelSnapshotPath(baseDir));
  const log = createLogger("sentinel.web");
  return {
    searchProvider: buildSearchProvider(config),
    webFetcher: origins.size === 0 ? webFetcher : {
      async fetch(url, options) {
        const startedAt = new Date().toISOString();
        const result = await webFetcher.fetch(url, options);
        if (
          !result.ok || options?.captureForSentinel !== true ||
          result.value.directResponse !== true
        ) return result;
        const requested = URL.parse(url);
        const response = URL.parse(result.value.url);
        if (
          requested && response && origins.has(requested.origin) &&
          origins.has(response.origin) &&
          canFlowTo(domainPolicy.getClassification(url), "INTERNAL") &&
          canFlowTo(
            domainPolicy.getClassification(result.value.url),
            "INTERNAL",
          )
        ) {
          try {
            await publishSentinelWebCapture(
              capturePath,
              response.origin,
              result.value.statusCode,
              startedAt,
            );
          } catch {
            log.warn("Sentinel could not publish web fetch metadata");
          }
        }
        return result;
      },
    },
    domainClassifier: createDomainClassifier(domainPolicy),
  };
}
