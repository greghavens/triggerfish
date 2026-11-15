/**
 * Legacy plugin evaluation helper. This is not an isolation boundary.
 * Same-process JavaScript can access globals; never run untrusted code here.
 *
 * Injected API shims hide some direct APIs but cannot restrict access through
 * globalThis or other JavaScript escape paths. Dynamic plugins do not use it.
 *
 * @module
 */

import type {
  ClassificationLevel,
  Result,
} from "../core/types/classification.ts";
import { createLogger } from "../core/logger/logger.ts";

const log = createLogger("security");

/**
 * SSRF DNS checker for plugin network access.
 *
 * Resolves the hostname and checks all returned IPs against the SSRF denylist.
 * Inject `resolveAndCheck` from `src/tools/web/ssrf.ts` at the gateway wiring
 * layer — plugin/ cannot import from tools/ directly (dependency layer constraint).
 */
export type SandboxDnsChecker = (
  hostname: string,
) => Promise<Result<string, string>>;

/** Configuration for a plugin sandbox. */
export interface SandboxConfig {
  /** Plugin name. */
  readonly name: string;
  /** Plugin version. */
  readonly version: string;
  /** Allowlisted network endpoints. */
  readonly declaredEndpoints: readonly string[];
  /** Maximum classification level the plugin can handle. */
  readonly maxClassification: ClassificationLevel;
  /**
   * Optional SSRF DNS checker. If provided, all plugin fetch calls also
   * validate resolved IPs against the SSRF denylist, preventing declared
   * endpoints from bypassing protection via DNS rebinding.
   */
  readonly dnsChecker?: SandboxDnsChecker;
}

/** Sandbox instance for executing plugin code. */
export interface Sandbox {
  /** Execute plugin code in the sandbox and return the result. */
  executePluginCode(code: string): Promise<unknown>;
  /** Destroy the sandbox and release resources. */
  destroy(): Promise<void>;
}

/** Parse declared endpoint URLs into a set of allowed hostnames. */
function parseAllowedHosts(
  endpoints: readonly string[],
): Set<string> {
  const hosts = new Set<string>();
  for (const endpoint of endpoints) {
    try {
      const url = new URL(endpoint);
      hosts.add(url.host);
    } catch (err) {
      log.warn("Plugin sandbox: ignoring invalid declared endpoint URL", {
        endpoint,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return hosts;
}

/** Extract the URL string from a fetch input (string, URL, or Request). */
function extractFetchUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** Build a fetch function that only permits requests to allowed hosts. */
function buildRestrictedFetch(
  allowedHosts: ReadonlySet<string>,
  pluginName: string,
  dnsChecker?: SandboxDnsChecker,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init?) => {
    const urlStr = extractFetchUrl(input);
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch (err) {
      log.warn("Plugin network access blocked: invalid URL", {
        plugin: pluginName,
        url: urlStr,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new Error(
        `Network access blocked: invalid URL "${urlStr}" in plugin ${pluginName}`,
      );
    }
    if (!allowedHosts.has(url.host)) {
      log.warn("Plugin network access blocked", {
        plugin: pluginName,
        host: url.host,
      });
      throw new Error(
        `Network access blocked: ${url.host} not in declared endpoints`,
      );
    }
    if (dnsChecker) {
      const ssrfResult = await dnsChecker(url.hostname);
      if (!ssrfResult.ok) {
        log.warn("Plugin SSRF blocked", {
          plugin: pluginName,
          hostname: url.hostname,
          reason: ssrfResult.error,
        });
        throw new Error(`Network access blocked: ${ssrfResult.error}`);
      }
    }
    log.debug("Plugin network access allowed", {
      plugin: pluginName,
      host: url.host,
    });
    return fetch(input, init);
  };
}

/** Build a Deno proxy that blocks all filesystem and system access. */
function buildRestrictedDeno(): Record<string, never> {
  return new Proxy(
    {} as Record<string, never>,
    {
      get(_target, prop) {
        throw new Error(
          `Sandbox: access to Deno.${String(prop)} is blocked`,
        );
      },
    },
  );
}

/** Execute plugin code as an async function with restricted globals. */
async function executeSandboxedCode(
  code: string,
  allowedHosts: ReadonlySet<string>,
  pluginName: string,
  dnsChecker?: SandboxDnsChecker,
): Promise<unknown> {
  const restrictedFetch = buildRestrictedFetch(
    allowedHosts,
    pluginName,
    dnsChecker,
  );
  const restrictedDeno = buildRestrictedDeno();
  const fn = new Function(
    "fetch",
    "Deno",
    `return (async function() { ${code} })()`,
  );
  return await fn(restrictedFetch, restrictedDeno);
}

/**
 * Create a legacy evaluation helper with injected API shims.
 * These shims do not isolate globals or enforce process permissions.
 */
// deno-lint-ignore require-await
export async function createSandbox(config: SandboxConfig): Promise<Sandbox> {
  const allowedHosts = parseAllowedHosts(config.declaredEndpoints);
  let destroyed = false;

  return {
    // deno-lint-ignore require-await
    async executePluginCode(code: string): Promise<unknown> {
      if (destroyed) throw new Error("Sandbox has been destroyed");
      return executeSandboxedCode(
        code,
        allowedHosts,
        config.name,
        config.dnsChecker,
      );
    },

    // deno-lint-ignore require-await
    async destroy(): Promise<void> {
      destroyed = true;
    },
  };
}
