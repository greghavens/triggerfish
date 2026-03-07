/**
 * Web module — search, fetch, and domain security.
 *
 * Provides web_search and web_fetch tools for the agent, SSRF prevention,
 * domain allowlist/denylist, and classification mappings.
 *
 * `domains.ts` is the single source of truth for domain security —
 * both this module and `src/browser/` import from it.
 *
 * @module
 */

export {
  createDomainPolicy,
  createDomainPolicyFromLegacy,
  createDomainClassifier,
  isPrivateIp,
  resolveAndCheck,
  type DomainClassification,
  type DomainClassificationResult,
  type DomainClassifier,
  type DomainPolicy,
  type DomainPolicyConfig,
  type DomainSecurityConfig,
} from "./domains.ts";

export {
  createBraveSearchProvider,
  createCloudSearchProvider,
  createRateLimitedSearchProvider,
  type BraveSearchConfig,
  type CloudSearchConfig,
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
  createWebToolExecutor,
  getWebToolDefinitions,
  WEB_TOOLS_SYSTEM_PROMPT,
} from "./tools.ts";
