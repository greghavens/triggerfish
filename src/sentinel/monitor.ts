/** Detect defensive regressions between successive graph snapshots. */
import type { loadSentinelGraph } from "./graph.ts";

type Finding = ReturnType<
  ReturnType<typeof loadSentinelGraph>["report"]
>[number];

export type SentinelAlert =
  | { readonly type: "finding_added"; readonly finding: Finding }
  | {
    readonly type: "finding_escalated";
    readonly finding: Finding;
    readonly previousSeverity: Finding["severity"];
  }
  | {
    readonly type: "assets_added" | "mitigation_links_removed";
    readonly finding: Finding;
    readonly ids: readonly string[];
  };

const severityRank = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

function difference(current: readonly string[], previous: readonly string[]) {
  const known = new Set(previous);
  return current.filter((id) => !known.has(id)).sort();
}

export function detectSentinelRegressions(
  previous: readonly Finding[],
  current: readonly Finding[],
): SentinelAlert[] {
  const baseline = new Map(previous.map((finding) => [finding.id, finding]));
  const alerts: SentinelAlert[] = [];
  for (const finding of current) {
    const prior = baseline.get(finding.id);
    if (!prior) {
      alerts.push({ type: "finding_added", finding });
      continue;
    }
    if (severityRank[finding.severity] > severityRank[prior.severity]) {
      alerts.push({
        type: "finding_escalated",
        finding,
        previousSeverity: prior.severity,
      });
    }
    const assets = difference(finding.assets, prior.assets);
    if (assets.length) {
      alerts.push({ type: "assets_added", finding, ids: assets });
    }
    const controls = difference(prior.controls, finding.controls);
    if (controls.length) {
      alerts.push({ type: "mitigation_links_removed", finding, ids: controls });
    }
  }
  return alerts;
}
