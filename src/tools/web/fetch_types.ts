/**
 * Web fetch interfaces, types, and constants.
 *
 * Defines the WebFetcher interface, fetch options/results,
 * and shared constants used by the fetch implementation.
 *
 * @module
 */

import type { Result } from "../../core/types/classification.ts";

/** DNS resolution + SSRF check function signature. */
export type DnsChecker = (hostname: string) => Promise<Result<string, string>>;

/** Content extraction mode. */
export type FetchMode = "readability" | "raw";

/** Options for fetching a web page. */
export interface FetchOptions {
  readonly mode?: FetchMode;
  readonly maxContentLength?: number;
  readonly timeout?: number;
  readonly userAgent?: string;
}

/** Result of fetching a web page. */
export interface FetchResult {
  readonly url: string;
  readonly title: string;
  readonly content: string;
  readonly contentType: string;
  readonly statusCode: number;
  readonly mode: FetchMode;
  readonly byteLength: number;
}

/** Web fetcher interface. */
export interface WebFetcher {
  /** Fetch a URL and extract content. */
  fetch(
    url: string,
    options?: FetchOptions,
  ): Promise<Result<FetchResult, string>>;
}

/** Configuration for the web fetcher. */
export interface WebFetcherConfig {
  readonly domainPolicy: import("./policy.ts").DomainPolicy;
  /** Override DNS resolution for testing. Defaults to resolveAndCheck. */
  readonly dnsChecker?: DnsChecker;
}

/** Options for the internal page fetch operation. */
export interface FetchPageOptions {
  readonly url: string;
  readonly userAgent: string;
  readonly timeout: number;
  readonly maxBytes: number;
  /** SSRF checker re-applied to every redirect hop. */
  readonly ssrfChecker: DnsChecker;
}

export const DEFAULT_MAX_CONTENT_LENGTH = 512 * 1024; // 512 KB
export const DEFAULT_TIMEOUT = 30_000; // 30 seconds
export const DEFAULT_USER_AGENT =
  "Triggerfish/1.0 (Web Fetch; +https://trigger.fish)";
export const MIN_READABILITY_LENGTH = 100;
