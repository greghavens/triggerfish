/**
 * Triggerfish Gateway cloud search provider implementation.
 *
 * Routes search queries through the Triggerfish Gateway's search proxy,
 * which provides Brave Search access using the subscriber's license key.
 *
 * @module
 */

import type { Result } from "../../core/types/classification.ts";
import { createLogger } from "../../core/logger/logger.ts";
import type {
  SearchOptions,
  SearchProvider,
  SearchResult,
  SearchResultItem,
} from "./search_types.ts";

const log = createLogger("search");

/** Configuration for the Triggerfish Gateway search provider. */
export interface CloudSearchConfig {
  /** Gateway base URL. Falls back to TRIGGERFISH_GATEWAY_URL env var. */
  readonly gatewayUrl?: string;
  /** License key. Falls back to TRIGGERFISH_LICENSE_KEY env var. */
  readonly licenseKey?: string;
}

/** Shape of the cloud search API response. */
interface CloudSearchResponse {
  readonly query?: string;
  readonly results?: readonly {
    readonly title?: string;
    readonly url?: string;
    readonly snippet?: string;
    readonly publishedDate?: string;
  }[];
  readonly totalEstimate?: number;
}

/** Build the JSON request body from query and options. */
function buildCloudSearchBody(
  query: string,
  options?: SearchOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = { query };
  if (options?.maxResults !== undefined) {
    body.max_results = Math.min(options.maxResults, 20);
  }
  if (options?.language) body.language = options.language;
  if (options?.region) body.region = options.region;
  if (options?.safeSearch) body.safe_search = options.safeSearch;
  return body;
}

/** Execute the cloud search HTTP request. */
async function fetchCloudResults(
  endpoint: string,
  licenseKey: string,
  query: string,
  body: Record<string, unknown>,
): Promise<Result<CloudSearchResponse, string>> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${licenseKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Cloud search request failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    log.warn("Cloud Search API error", {
      operation: "cloudSearch",
      status: response.status,
      body: text.slice(0, 200),
      query,
    });
    return {
      ok: false,
      error: `Cloud Search API error ${response.status}: ${text.slice(0, 200)}`,
    };
  }

  try {
    return { ok: true, value: (await response.json()) as CloudSearchResponse };
  } catch {
    return { ok: false, error: "Failed to parse Cloud Search response" };
  }
}

/** Parse a cloud search response into a SearchResult. */
function parseCloudResults(
  query: string,
  data: CloudSearchResponse,
): SearchResult {
  const items: SearchResultItem[] = (data.results ?? [])
    .filter(
      (
        r,
      ): r is {
        readonly title: string;
        readonly url: string;
        readonly snippet?: string;
        readonly publishedDate?: string;
      } => typeof r.title === "string" && typeof r.url === "string",
    )
    .map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet ?? "",
      ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}),
    }));

  return {
    query,
    results: items,
    totalEstimate: data.totalEstimate,
  };
}

/**
 * Create a Triggerfish Gateway search provider.
 *
 * Routes search queries through the Triggerfish Gateway gateway's search proxy,
 * which provides Brave Search access using the subscriber's license key.
 *
 * @param config - Gateway URL and license key
 * @returns A SearchProvider backed by the Triggerfish Gateway gateway
 */
export function createCloudSearchProvider(
  config: CloudSearchConfig,
): SearchProvider {
  const gatewayUrl = config.gatewayUrl ??
    Deno.env.get("TRIGGERFISH_GATEWAY_URL") ??
    "https://api.trigger.fish";
  const licenseKey = config.licenseKey ??
    Deno.env.get("TRIGGERFISH_LICENSE_KEY") ?? "";
  const endpoint = `${gatewayUrl}/v1/search/web`;

  return {
    id: "cloud",
    name: "Triggerfish Gateway Search",

    async search(
      query: string,
      options?: SearchOptions,
    ): Promise<Result<SearchResult, string>> {
      if (query.trim().length === 0) {
        return { ok: false, error: "Search query cannot be empty" };
      }

      const body = buildCloudSearchBody(query, options);
      const fetchResult = await fetchCloudResults(
        endpoint,
        licenseKey,
        query,
        body,
      );
      if (!fetchResult.ok) return fetchResult;

      return {
        ok: true,
        value: parseCloudResults(query, fetchResult.value),
      };
    },
  };
}
