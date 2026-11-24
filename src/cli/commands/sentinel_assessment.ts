/** Operator commands for the gateway's shared defensive assessment. */
import { isSentinelReportLanguage } from "../../sentinel/report_language.ts";
import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
  readHistoricalAdaptiveSentinel,
} from "../../gateway/sentinel_adaptive_runtime.ts";
import {
  renderSentinelAlertsJson,
  renderSentinelDecisionHistoryJson,
  renderSentinelFindingsCsv,
  renderSentinelInvestigationMarkdown,
  renderSentinelProvenanceJson,
} from "../../sentinel/assessment_export.ts";
import { renderSavedSentinelIncidentJson } from "../../sentinel/incident_archive.ts";
import { loadConfig } from "../../core/config.ts";
import {
  completeSentinelAssessmentGoal,
  continueSentinelAssessment,
  pauseSentinelAssessment,
  readSentinelAssessment,
  readSentinelAssessmentAlerts,
  readSentinelAssessmentHistory,
  readSentinelAssessmentRevision,
  readSentinelFindingReviews,
  readSentinelIncidentReviews,
  refreshSentinelAssessment,
  resumeSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
  updateSentinelAssessmentGoal,
} from "../../sentinel/assessment_store.ts";
import {
  listSentinelCaseIds,
  resolveSentinelCasePath,
} from "../../sentinel/cases.ts";
import { resolveBaseDir, resolveConfigPath } from "../config/paths.ts";

export function webContainmentConfigured(): boolean | undefined {
  const config = loadConfig(resolveConfigPath());
  return config.ok
    ? config.value.web?.domains?.sentinel_containment === true
    : undefined;
}

/** Re-evaluate a running assessment after an atomic evidence publication. */
export function resolveSentinelCliCase(caseId: string | boolean | undefined) {
  if (typeof caseId === "boolean") {
    throw new Error("Supply a case ID with --case=ID");
  }
  return resolveSentinelCasePath(resolveBaseDir(), caseId);
}

export function refreshAfterPublish(path: string) {
  try {
    const state = refreshSentinelAssessment(
      path,
      webContainmentConfigured(),
    );
    if (state) {
      advanceAdaptiveSentinel(path, state);
    }
    return state?.active ? { assessmentRevision: state.revision } : {};
  } catch {
    return {
      assessmentError:
        "Published evidence, but the assessment could not refresh",
    };
  }
}

function parseRevision(
  revision: string | boolean | undefined,
): number | undefined {
  if (revision === undefined) return;
  if (
    typeof revision !== "string" || !/^[1-9]\d*$/.test(revision) ||
    !Number.isSafeInteger(Number(revision))
  ) {
    throw new Error("Pass a positive revision number with --revision=N");
  }
  return Number(revision);
}

export function dispatchSentinelAssessmentCommand(
  subcommand: string,
  flags: Readonly<Record<string, string | boolean>>,
): void {
  if (subcommand === "assess-cases") {
    console.log(
      JSON.stringify({
        cases: ["main", ...listSentinelCaseIds(resolveBaseDir())],
      }),
    );
    return;
  }
  const path = resolveSentinelCliCase(flags.case);
  let state: unknown;
  switch (subcommand) {
    case "assess-start": {
      const { asset, node, evidence, depth, goal } = flags;
      if ([asset, node, evidence].some((value) => typeof value === "boolean")) {
        throw new Error(
          "Supply an exact node ID for --asset, --node, or --evidence",
        );
      }
      if (
        depth !== undefined &&
        (typeof depth !== "string" || !/^\d+$/.test(depth))
      ) {
        throw new Error("Pass a nonnegative integer with --depth=N");
      }
      if (typeof goal === "boolean") {
        throw new Error("Supply a goal with --goal=TEXT");
      }
      const started = startSentinelAssessment(path, {
        goal,
        impactAsset: typeof asset === "string" ? asset : undefined,
        traceNode: typeof node === "string" ? node : undefined,
        evidenceNode: typeof evidence === "string" ? evidence : undefined,
        depth: typeof depth === "string" ? Number(depth) : undefined,
      }, webContainmentConfigured());
      advanceAdaptiveSentinel(path, started);
      state = started;
      break;
    }
    case "assess-continue": {
      const continued = continueSentinelAssessment(
        path,
        webContainmentConfigured(),
      );
      if (!continued) {
        throw new Error("No stopped Sentinel assessment to continue");
      }
      advanceAdaptiveSentinel(path, continued);
      state = continued;
      break;
    }
    case "assess-resume":
    case "assess-refresh": {
      const containment = webContainmentConfigured();
      const resumed = subcommand === "assess-resume"
        ? resumeSentinelAssessment(path, containment)
        : undefined;
      const refreshed = resumed ?? refreshSentinelAssessment(path, containment);
      if (refreshed) advanceAdaptiveSentinel(path, refreshed);
      state = refreshed;
      break;
    }
    case "assess-pause":
      state = { paused: pauseSentinelAssessment(path) };
      break;
    case "assess-goal": {
      if (typeof flags.goal !== "string") {
        throw new Error("Supply a goal with --goal=TEXT");
      }
      state = { updated: updateSentinelAssessmentGoal(path, flags.goal) };
      const active = readSentinelAssessment(path);
      if (active) advanceAdaptiveSentinel(path, active);
      break;
    }
    case "assess-complete": {
      const revision = parseRevision(flags.revision);
      if (
        revision === undefined ||
        typeof flags.note !== "string" ||
        (flags.goal !== undefined && typeof flags.goal !== "string") ||
        !completeSentinelAssessmentGoal(
          path,
          revision,
          flags.goal ?? null,
          flags.note,
          webContainmentConfigured(),
        )
      ) {
        throw new Error(
          "Goal completion could not be saved. Verify the current revision, goal, and evidence.",
        );
      }
      state = readSentinelAssessment(path);
      break;
    }
    case "assess-stop":
      state = { stopped: stopSentinelAssessment(path) };
      break;
    case "assess-export": {
      const format = flags.format ?? "markdown";
      const language = flags.language ?? "en";
      if (!isSentinelReportLanguage(language)) {
        throw new Error("Use --language=en, es, ko, zh, or ja");
      }
      if (flags.language !== undefined && format !== "markdown") {
        throw new Error("--language applies to Markdown reports");
      }
      if (
        format !== "markdown" && format !== "csv" && format !== "alerts" &&
        format !== "provenance" && format !== "inventory" &&
        format !== "decisions" && format !== "incidents"
      ) {
        throw new Error(
          "Use --format=csv, markdown, alerts, provenance, inventory, decisions, or incidents",
        );
      }
      const revision = parseRevision(flags.revision);
      const current = revision === undefined
        ? readSentinelAssessment(path)
        : undefined;
      const selected = current ??
        (revision === undefined
          ? undefined
          : readSentinelAssessmentRevision(path, revision));
      if (!selected) throw new Error("No retained assessment to export");
      const caseId = typeof flags.case === "string" ? flags.case : "main";
      let report: string;
      if (format === "incidents") {
        const incidents = renderSavedSentinelIncidentJson(
          path,
          caseId,
          selected.revision,
        );
        if (incidents === undefined) {
          throw new Error(
            "No full incident feed was saved for this evidence revision",
          );
        }
        report = incidents;
      } else if (format === "decisions") {
        report = renderSentinelDecisionHistoryJson(
          path,
          caseId,
          selected.revision,
        );
      } else if (format === "alerts") {
        const alerts = readSentinelAssessmentAlerts(path, selected.revision);
        if (!alerts) {
          throw new Error(
            "No full alert feed was saved for this evidence revision",
          );
        }
        report = renderSentinelAlertsJson(
          caseId,
          selected.revision,
          alerts,
        );
      } else if (format === "inventory") {
        const inventory = selected.result?.sharedGraph.snapshot;
        if (!inventory) {
          throw new Error("This revision has no evidence inventory to export");
        }
        report = JSON.stringify(inventory) + "\n";
      } else if (format === "csv") {
        report = renderSentinelFindingsCsv({
          ...selected,
          findingReviews: readSentinelFindingReviews(path, selected.revision),
        });
      } else {
        const adaptive = current
          ? readAdaptiveSentinel(path, current, "revision")
          : readHistoricalAdaptiveSentinel(path, selected.revision);
        const exportState = {
          ...selected,
          findingReviews: readSentinelFindingReviews(path, selected.revision),
          incidentReviews: readSentinelIncidentReviews(path, selected.revision),
        };
        report = format === "provenance"
          ? renderSentinelProvenanceJson(
            caseId,
            exportState,
            adaptive ?? undefined,
            path,
          )
          : renderSentinelInvestigationMarkdown(
            exportState,
            adaptive ?? undefined,
            language,
          );
      }
      const bytes = new TextEncoder().encode(report);
      let offset = 0;
      while (offset < bytes.length) {
        offset += Deno.stdout.writeSync(bytes.subarray(offset));
      }
      return;
    }
    case "assess-history":
      state = { revisions: readSentinelAssessmentHistory(path) };
      break;
    default: {
      const revision = parseRevision(flags.revision);
      if (revision === undefined) {
        const current = readSentinelAssessment(path);
        state = current
          ? { ...current, adaptive: readAdaptiveSentinel(path, current) }
          : undefined;
      } else {
        state = readSentinelAssessmentRevision(path, revision) ??
          { revision: revision, retained: false };
      }
    }
  }
  console.log(JSON.stringify(state ?? { active: false }, null, 2));
}
