/** Export operator-mapped evidence as a MITRE ATT&CK Navigator layer. */
import { parseSentinelTelemetryAlert } from "./case_report.ts";
import {
  isSentinelTelemetryAction,
  telemetryAlertSeverities,
} from "./telemetry.ts";

interface TechniqueSignals {
  readonly techniqueID: string;
  readonly signals: Map<string, { signal: string; triggeringAction?: string }>;
}

export function buildSentinelNavigatorLayer(
  rawMapping: unknown,
  alerts?: readonly unknown[],
) {
  if (!Array.isArray(rawMapping) || rawMapping.length > 1000) {
    throw new Error("Expected an array of up to 1,000 ATT&CK mappings");
  }
  const techniques = new Map<string, TechniqueSignals>();
  for (const row of rawMapping) {
    if (
      !row || typeof row !== "object" ||
      typeof row.techniqueID !== "string" ||
      !/^T\d{4}(?:\.\d{3})?$/.test(row.techniqueID) ||
      typeof row.signal !== "string" ||
      !Object.hasOwn(telemetryAlertSeverities, row.signal) ||
      (row.triggeringAction !== undefined &&
        !isSentinelTelemetryAction(row.triggeringAction))
    ) {
      throw new Error(
        "Invalid ATT&CK technique ID, Sentinel signal, or triggering action",
      );
    }
    const technique = techniques.get(row.techniqueID) ??
      {
        techniqueID: row.techniqueID,
        signals: new Map<
          string,
          { signal: string; triggeringAction?: string }
        >(),
      };
    const triggeringAction = row.triggeringAction as string | undefined;
    technique.signals.set(JSON.stringify([row.signal, triggeringAction]), {
      signal: row.signal,
      triggeringAction,
    });
    techniques.set(row.techniqueID, technique);
  }

  const counts = new Map<string, Set<string>>();
  for (const [index, raw] of (alerts ?? []).entries()) {
    const alert = parseSentinelTelemetryAlert(raw, index + 1);
    const evidence = JSON.stringify([
      alert.asset,
      [...alert.evidenceIds].sort(),
    ]);
    const selectors = [JSON.stringify([alert.type, undefined])];
    if (alert.triggeringAction) {
      selectors.push(JSON.stringify([alert.type, alert.triggeringAction]));
    }
    for (const key of selectors) {
      const distinct = counts.get(key) ?? new Set<string>();
      distinct.add(evidence);
      counts.set(key, distinct);
    }
  }

  return {
    name: "Triggerfish Sentinel",
    description:
      "Operator-supplied Enterprise ATT&CK mappings and observed Sentinel signals. The layer does not establish attribution or validate prevention.",
    domain: "enterprise-attack",
    versions: { layer: "4.5", navigator: "5.0.0" },
    techniques: [...techniques.values()].sort((a, b) =>
      a.techniqueID.localeCompare(b.techniqueID)
    ).map(({ techniqueID, signals }) => ({
      techniqueID,
      comment: alerts === undefined
        ? "No alert batch supplied"
        : "Observed signals reflect the supplied alert batch",
      metadata: [...signals].sort(([left], [right]) =>
        left.localeCompare(right)
      )
        .map(([key, { signal, triggeringAction }]) => ({
          name: triggeringAction ? `${signal} · ${triggeringAction}` : signal,
          value: alerts === undefined
            ? "Mapped by operator"
            : `${counts.get(key)?.size ?? 0} distinct alert(s)`,
        })),
    })),
  };
}
