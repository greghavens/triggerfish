/**
 * Web module — search, fetch, and domain security.
 *
 * Provides web_search and web_fetch tools for the agent, SSRF prevention,
 * domain allowlist/denylist, and classification mappings.
 *
 * `domains.ts` is the single source of truth for domain security —
 * both this module and `src/tools/browser/` import from it.
 *
 * @module
 */

export { checkIpListForSsrf, isPrivateIp, resolveAndCheck } from "./ssrf.ts";
export { safeFetch, type SsrfChecker } from "./safe_fetch.ts";

export {
  createDomainPolicy,
  type DomainClassification,
  type DomainPolicy,
  type DomainSecurityConfig,
} from "./policy.ts";

export {
  createDomainClassifier,
  createDomainPolicyFromLegacy,
  type DomainClassificationResult,
  type DomainClassifier,
  type DomainPolicyConfig,
} from "./classifier.ts";

export {
  type BraveSearchConfig,
  type CloudSearchConfig,
  createBraveSearchProvider,
  createCloudSearchProvider,
  createRateLimitedSearchProvider,
  type SearchOptions,
  type SearchProvider,
  type SearchResult,
  type SearchResultItem,
} from "./search.ts";

export {
  createWebFetcher,
  type DnsChecker,
  type FetchMode,
  type FetchOptions,
  type FetchResult,
  type WebFetcher,
  type WebFetcherConfig,
} from "./fetch.ts";

export {
  buildWebToolDefinitions,
  checkSkillDomainRestriction,
  createWebToolExecutor,
  enforceSkillDomainRestriction,
  getWebToolDefinitions,
  WEB_TOOLS_SYSTEM_PROMPT,
  type WebToolExecutorOptions,
} from "./tools.ts";

export { globToRegex } from "./glob.ts";
