/** Compile exact, operator-supplied indicators into passive sensor rules. */
import { stringify } from "@std/yaml";
import { parseSentinelIndicatorCatalog } from "./indicators.ts";

function sigmaLiteral(value: string): string {
  return value.replace(/[\\*?]/g, "\\$&");
}

export function renderSentinelSigma(raw: unknown): string {
  return parseSentinelIndicatorCatalog(raw).map((rule, index) =>
    stringify({
      title: `Sentinel ${rule.kind} ${rule.field} indicator ${index + 1}`,
      status: "experimental",
      description: `Sentinel indicator ${rule.id} from ${rule.source}`,
      logsource: {
        product: "sentinel",
        service: "indicators",
        definition:
          "Flatten normalized Sentinel indicator events and normalize DNS/HTTP hosts and hashes before indexing.",
      },
      detection: {
        selection: {
          kind: rule.kind,
          [`fields.${rule.field}|cased`]: sigmaLiteral(rule.value),
          ...(rule.asset === undefined
            ? {}
            : { "asset|cased": sigmaLiteral(rule.asset) }),
        },
        condition: "selection",
      },
      level: rule.severity,
    }).trimEnd()
  ).join("\n---\n");
}

export function renderSentinelSuricata(raw: unknown, sidStart = 9_100_000) {
  if (
    !Number.isSafeInteger(sidStart) || sidStart < 1 || sidStart > 0xffffffff
  ) {
    throw new Error("Pass a valid first Suricata signature ID");
  }
  const lines: string[] = [];
  const skipped: string[] = [];
  for (const rule of parseSentinelIndicatorCatalog(raw)) {
    const dns = rule.kind === "dns" && rule.field === "query";
    const agent = rule.kind === "http" && rule.field === "userAgent";
    if (rule.asset !== undefined || (!dns && !agent)) {
      skipped.push(rule.id);
      continue;
    }
    const sid = sidStart + lines.length;
    if (sid > 0xffffffff) {
      throw new Error("Too many signatures for the selected ID range");
    }
    const bytes = new TextEncoder().encode(rule.value);
    const content = Array.from(
      bytes,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(" ");
    const buffer = dns ? "dns.query" : "http.user_agent";
    const qualifiers = dns ? " nocase;" : "";
    lines.push(
      `alert ${
        dns ? "dns" : "http"
      } $HOME_NET any -> any any (msg:"Sentinel exact indicator ${sid}"; ${buffer}; content:"|${content}|";${qualifiers} bsize:${bytes.length}; sid:${sid}; rev:1;)`,
    );
  }
  return { rules: lines.join("\n"), skipped };
}
