/**
 * Web search provider interface and Brave Search implementation.
 *
 * Defines a pluggable SearchProvider interface with a default Brave Search
 * backend. Other providers (SearXNG, Google, etc.) can implement the same
 * interface.
 *
 * @module
 */

import type { Result } from "../core/types/classification.ts";

// ─── Interfaces ─────────────────────────────────────────────────────────────

/** Options for a web search query. */
export interface SearchOptions {
  readonly maxResults?: number;
  readonly language?: string;
  readonly region?: string;
  readonly safeSearch?: "off" | "moderate" | "strict";
}

/** A single search result item. */
export interface SearchResultItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly publishedDate?: string;
}

/** The complete result of a search query. */
export interface SearchResult {
  readonly query: string;
  readonly results: readonly SearchResultItem[];
  readonly totalEstimate?: number;
}

/** A pluggable web search provider. */
export interface SearchProvider {
  readonly id: string;
  readonly name: string;
  /** Execute a search query. */
  search(
    query: string,
    options?: SearchOptions,
  ): Promise<Result<SearchResult, string>>;
}

// ─── Brave Search Implementation ────────────────────────────────────────────

/** Configuration for the Brave Search provider. */
export interface BraveSearchConfig {
  readonly apiKey: string;
  readonly endpoint?: string;
}

/** Shape of a Brave API web search result. */
interface BraveWebResult {
  readonly title?: string;
  readonly url?: string;
  readonly description?: string;
  readonly page_age?: string;
}

/** Shape of the Brave API response. */
interface BraveApiResponse {
  readonly web?: {
    readonly results?: readonly BraveWebResult[];
    readonly totalEstimatedMatches?: number;
  };
}

/**
 * Wrap a SearchProvider with minimum-interval rate limiting.
 *
 * Concurrent calls are serialized — each waits for the previous to start
 * before beginning its own delay. This prevents bursts from exceeding the
 * configured requests-per-second limit.
 *
 * @param provider - The underlying search provider to wrap
 * @param requestsPerSecond - Maximum requests per second (e.g. 1 for Brave free tier)
 * @returns A rate-limited SearchProvider with the same interface
 */
export function createRateLimitedSearchProvider(
  provider: SearchProvider,
  requestsPerSecond: number,
): SearchProvider {
  const minIntervalMs = 1000 / requestsPerSecond;
  let lastRequestTime = 0;
  let pending: Promise<unknown> = Promise.resolve();

  return {
    id: provider.id,
    name: provider.name,
    search(query, options) {
      const job = pending.then(async () => {
        const now = Date.now();
        const elapsed = now - lastRequestTime;
        if (elapsed < minIntervalMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, minIntervalMs - elapsed)
          );
        }
        lastRequestTime = Date.now();
        return provider.search(query, options);
      });
      pending = job.catch(() => {}); // errors don't break the chain
      return job;
    },
  };
}

// ─── Triggerfish Cloud Search Implementation ─────────────────────────────────

/** Configuration for the Triggerfish Cloud search proxy. */
export interface CloudSearchConfig {
  /** Gateway base URL. */
  readonly gatewayUrl: string;
  /** License key for Bearer auth. */
  readonly licenseKey: string;
}

/**
 * Create a search provider backed by the Triggerfish Cloud gateway.
 *
 * Proxies search requests through POST /v1/search/web using the
 * subscriber's license key. No separate Brave API key needed.
 *
 * @param config - Gateway URL and license key
 * @returns A SearchProvider backed by the Triggerfish Cloud search proxy
 */
export function createCloudSearchProvider(
  config: CloudSearchConfig,
): SearchProvider {
  const endpoint = `${config.gatewayUrl}/v1/search/web`;

  return {
    id: "triggerfish-cloud",
    name: "Triggerfish Cloud Search",

    async search(
      query: string,
      options?: SearchOptions,
    ): Promise<Result<SearchResult, string>> {
      if (query.trim().length === 0) {
        return { ok: false, error: "Search query cannot be empty" };
      }

      const body: Record<string, unknown> = { q: query };
      if (options?.maxResults !== undefined) {
        body.count = Math.min(options.maxResults, 20);
      }
      if (options?.language) {
        body.search_lang = options.language;
      }
      if (options?.region) {
        body.country = options.region;
      }
      if (options?.safeSearch) {
        body.safesearch = options.safeSearch;
      }

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.licenseKey}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        return {
          ok: false,
          error: `Cloud search request failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return {
          ok: false,
          error: `Cloud search error ${response.status}: ${text}`,
        };
      }

      let data: BraveApiResponse;
      try {
        data = (await response.json()) as BraveApiResponse;
      } catch {
        return { ok: false, error: "Failed to parse cloud search response" };
      }

      const items: SearchResultItem[] = (data.web?.results ?? [])
        .filter(
          (r): r is BraveWebResult & { title: string; url: string } =>
            typeof r.title === "string" && typeof r.url === "string",
        )
        .map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description ?? "",
          ...(r.page_age ? { publishedDate: r.page_age } : {}),
        }));

      return {
        ok: true,
        value: {
          query,
          results: items,
          totalEstimate: data.web?.totalEstimatedMatches,
        },
      };
    },
  };
}

// ─── Brave Search Implementation (Direct API Key) ───────────────────────────

/**
 * Create a Brave Search provider.
 *
 * @param config - API key and optional endpoint override
 * @returns A SearchProvider backed by the Brave Web Search API
 */
export function createBraveSearchProvider(
  config: BraveSearchConfig,
): SearchProvider {
  const endpoint =
    config.endpoint ?? "https://api.search.brave.com/res/v1/web/search";

  return {
    id: "brave",
    name: "Brave Search",

    async search(
      query: string,
      options?: SearchOptions,
    ): Promise<Result<SearchResult, string>> {
      if (query.trim().length === 0) {
        return { ok: false, error: "Search query cannot be empty" };
      }

      const params = new URLSearchParams({ q: query });

      if (options?.maxResults !== undefined) {
        params.set("count", String(Math.min(options.maxResults, 20)));
      }
      if (options?.language) {
        params.set("search_lang", options.language);
      }
      if (options?.region) {
        params.set("country", options.region);
      }
      if (options?.safeSearch) {
        params.set("safesearch", options.safeSearch);
      }

      const url = `${endpoint}?${params.toString()}`;

      let response: Response;
      try {
        response = await fetch(url, {
          headers: {
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": config.apiKey,
          },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        return {
          ok: false,
          error: `Brave Search request failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          ok: false,
          error: `Brave Search API error ${response.status}: ${body}`,
        };
      }

      let data: BraveApiResponse;
      try {
        data = (await response.json()) as BraveApiResponse;
      } catch {
        return { ok: false, error: "Failed to parse Brave Search response" };
      }

      const items: SearchResultItem[] = (data.web?.results ?? [])
        .filter(
          (r): r is BraveWebResult & { title: string; url: string } =>
            typeof r.title === "string" && typeof r.url === "string",
        )
        .map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.description ?? "",
          ...(r.page_age ? { publishedDate: r.page_age } : {}),
        }));

      return {
        ok: true,
        value: {
          query,
          results: items,
          totalEstimate: data.web?.totalEstimatedMatches,
        },
      };
    },
  };
}
