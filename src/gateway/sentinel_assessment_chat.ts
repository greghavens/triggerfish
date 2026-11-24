/** Deterministic assessment controls for the authenticated Sentinel mode. */
import {
  hasPendingSentinelInputs,
  pauseSentinelAssessment,
  readSentinelAssessment,
  readSentinelAssessmentHistory,
  refreshSentinelAssessment,
  resumeSentinelAssessment,
  startSentinelAssessment,
  stopSentinelAssessment,
  updateSentinelAssessmentGoal,
} from "../sentinel/assessment_store.ts";
import {
  advanceAdaptiveSentinel,
  readAdaptiveSentinel,
} from "./sentinel_adaptive_runtime.ts";
import { formatSentinelChatResult } from "../sentinel/chat_mode.ts";

import {
  type SentinelReportLanguage,
  sentinelReportText,
} from "../sentinel/report_language.ts";

export function handleSentinelAssessmentChat(
  command: string,
  path: string,
  webContainmentConfigured?: boolean,
  language: SentinelReportLanguage = "en",
): string {
  const t = sentinelReportText(language);
  try {
    if (command === "assessment stop") {
      return stopSentinelAssessment(path)
        ? t("Sentinel assessment stopped.")
        : t("There is no active Sentinel assessment.");
    }
    if (command === "assessment history") {
      const history = formatSentinelChatResult(
        readSentinelAssessmentHistory(path),
        language,
      );
      return language === "en"
        ? history
        : `${t("Assessment history")}\n\n${history}`;
    }
    if (command === "assessment pause") {
      return pauseSentinelAssessment(path)
        ? t("Sentinel assessment paused.")
        : t("The assessment state did not change.");
    }
    if (command === "assessment resume") {
      const state = resumeSentinelAssessment(path, webContainmentConfigured);
      if (!state) return t("The assessment state did not change.");
      advanceAdaptiveSentinel(path, state);
      return t("Sentinel assessment resumed.");
    }
    if (command.startsWith("assessment goal ")) {
      if (
        !updateSentinelAssessmentGoal(
          path,
          command.slice("assessment goal ".length),
        )
      ) {
        return t("There is no active Sentinel assessment.");
      }
    }
    const starting = command === "assessment start" ||
      command.startsWith("assessment start ");
    const state = starting
      ? startSentinelAssessment(path, {
        goal: command.slice("assessment start".length).trim() || undefined,
      }, webContainmentConfigured)
      : command === "assessment refresh"
      ? refreshSentinelAssessment(path, webContainmentConfigured)
      : readSentinelAssessment(path);
    if (
      state &&
      (starting || command === "assessment refresh" ||
        command.startsWith("assessment goal "))
    ) {
      advanceAdaptiveSentinel(path, state);
    }
    if (!state) {
      return t("There is no Sentinel assessment. Use `assessment start`.");
    }
    const { active, paused, revision, updatedAt, result, reviews } = state;
    const adaptive = readAdaptiveSentinel(path, state);
    const response = formatSentinelChatResult({
      active,
      paused,
      ...(paused && {
        pendingInputs: hasPendingSentinelInputs(path, webContainmentConfigured),
      }),
      adaptive: adaptive
        ? {
          goal: adaptive.goal.label,
          tasks: adaptive.tasks.map(({ kind, nodeId, status }) => ({
            kind,
            nodeId,
            status,
          })).slice(0, 12),
          totalAssigned: adaptive.tasks.length,
        }
        : null,
      revision,
      updatedAt,
      summary: result?.summary,
      tasks: result?.tasks,
      transitions: result?.transitions,
      ...(command === "assessment observations"
        ? {
          observations: result?.sharedGraph.observations,
          links: result?.sharedGraph.observationLinks,
          reviews,
        }
        : {
          observations: result?.sharedGraph.observations.length,
          reviews: reviews.length,
        }),
    }, language);
    if (language === "en") return response;
    const status = t(paused ? "Paused" : active ? "Active" : "Stopped");
    const heading = command === "assessment observations"
      ? t("Assessment observations")
      : `${t("Assessment state")} · ${status}`;
    return `${heading} · ${t("Evidence revision")} ${revision}\n\n${response}`;
  } catch {
    return t(
      "Sentinel could not update the assessment. Check the current status and operator-published inputs.",
    );
  }
}
