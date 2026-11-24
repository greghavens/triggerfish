/** Apply Sentinel policy to the URL host and the SSRF-approved connection IP. */
import type { SsrfChecker } from "../core/security/safe_fetch.ts";
import { resolveAndCheck } from "../core/security/ssrf.ts";
import { checkSentinelContainment } from "./containment.ts";

export function createSentinelEgressChecker(
  path: string,
  checkOutbound: SsrfChecker = resolveAndCheck,
): SsrfChecker {
  return async (hostname) => {
    const hostBlock = checkPolicy(hostname);
    if (hostBlock) return hostBlock;
    const resolved = await checkOutbound(hostname);
    if (!resolved.ok || resolved.value === hostname) return resolved;
    // Safe fetch pins the connection to this approved address for each hop.
    return checkPolicy(resolved.value) ?? resolved;
  };

  function checkPolicy(destination: string) {
    try {
      const { decision, target } = checkSentinelContainment(path, destination);
      if (decision === "deny") {
        return {
          ok: false as const,
          error: `Destination blocked by Sentinel: ${target}`,
        };
      }
    } catch {
      return {
        ok: false as const,
        error: "Sentinel destination policy unavailable",
      };
    }
  }
}
