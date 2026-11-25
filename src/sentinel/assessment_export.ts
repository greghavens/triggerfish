/** Render a saved defensive assessment without writing files or fetching data. */

import {
  type SentinelReportLanguage,
  sentinelReportText,
} from "./report_language.ts";
import type { AdaptiveTaskEvent } from "./adaptive_store.ts";
import type {
  readSentinelAssessment,
  SentinelFindingReview,
  SentinelIncidentReview,
  SentinelReviewStep,
} from "./assessment_store.ts";
import {
  readSentinelDecisions,
  readSentinelFindingReviews,
  readSentinelIncidentReviews,
} from "./assessment_store.ts";
import { exportSentinelFindingTrafficLinks } from "./finding_traffic_links.ts";
import { loadSentinelGraph } from "./graph.ts";
import { readSentinelWorkerFindingReport } from "./worker_finding_store.ts";
import {
  type AdaptiveProvenanceView,
  buildSentinelProvenance,
} from "./provenance.ts";

type CurrentAssessment = NonNullable<ReturnType<typeof readSentinelAssessment>>;
export type SentinelAssessmentExportInput =
  & Pick<CurrentAssessment, "revision" | "updatedAt" | "result" | "reviews">
  & Partial<
    Pick<CurrentAssessment, "plan" | "active" | "paused" | "completion">
  >
  & {
    readonly incidentReviews?: readonly SentinelIncidentReview[];
    readonly findingReviews?: readonly SentinelFindingReview[];
    readonly workerFindings?: ReturnType<
      typeof readSentinelWorkerFindingReport
    >;
  };

export function renderSentinelAlertsJson(
  caseId: string,
  revision: number,
  alerts: readonly import("./telemetry.ts").TelemetryAlert[],
): string {
  return JSON.stringify({ version: 1, caseId, revision, alerts }, null, 2) +
    "\n";
}

/** Export the complete review history visible from a retained revision. */
export function renderSentinelDecisionHistoryJson(
  path: string,
  caseId: string,
  revision: number,
): string {
  const options = { fullHistory: true };
  return JSON.stringify(
    {
      version: 1,
      caseId,
      revision,
      findingReviews: readSentinelFindingReviews(path, revision, options),
      incidentReviews: readSentinelIncidentReviews(path, revision, options),
    },
    null,
    2,
  ) + "\n";
}

interface ExportPlanningAttempt {
  readonly identity?: string;
  readonly hintId?: number;
  readonly hintIds?: readonly number[];
  readonly attempt: number;
  readonly findingReviewId?: number;
  readonly findingReviewIds?: readonly number[];
  readonly incidentReviewIds?: readonly number[];
  readonly incidentCandidateIds?: readonly string[];
  readonly incidentReviewId?: number;
  readonly started: string;
  readonly finished: string | null;
  readonly outcome: string;
}

export function renderSentinelProvenanceJson(
  caseId: string,
  assessment: SentinelAssessmentExportInput,
  adaptive:
    | (AdaptiveProvenanceView & {
      readonly modelPlannerHistory?: readonly ExportPlanningAttempt[];
      readonly provenancePlanningAttempts?: readonly ExportPlanningAttempt[];
      readonly provenancePlanningHints?: readonly {
        readonly id: number;
        readonly revision: number | null;
        readonly at: string;
        readonly text: string;
      }[];
    })
    | undefined,
  path: string,
): string {
  const planningAttempts = adaptive?.provenancePlanningAttempts ??
    adaptive?.modelPlannerHistory ?? [];
  const workerFindings = assessment.workerFindings ??
    readSentinelWorkerFindingReport(path, assessment.revision);
  const findingTrafficLinks = exportSentinelFindingTrafficLinks(
    path,
    assessment.revision,
  );
  const planningDecisions = [
    ...readSentinelDecisions(
      path,
      "finding",
      planningAttempts.flatMap(({ findingReviewId, findingReviewIds }) =>
        findingReviewIds ??
          (findingReviewId === undefined ? [] : [findingReviewId])
      ),
    ),
    ...readSentinelDecisions(
      path,
      "incident",
      planningAttempts.flatMap(({ incidentReviewId, incidentReviewIds }) =>
        incidentReviewIds ??
          (incidentReviewId === undefined ? [] : [incidentReviewId])
      ),
    ),
  ];
  return JSON.stringify(
    {
      version: 1,
      caseId,
      revision: assessment.revision,
      updatedAt: assessment.updatedAt,
      ...(assessment.completion && { completion: assessment.completion }),
      ...(workerFindings && { workerFindings }),
      ...(findingTrafficLinks.length > 0 && { findingTrafficLinks }),
      inventory: assessment.result?.sharedGraph.snapshot ?? null,
      provenance: buildSentinelProvenance(
        assessment.result,
        adaptive && { ...adaptive, evidenceRevision: assessment.revision },
        undefined,
        assessment.incidentReviews,
        assessment.findingReviews,
      )
        .snapshot(),
      planningAttempts,
      planningHints: adaptive?.provenancePlanningHints ?? [],
      planningDecisions,
      observations: assessment.result?.sharedGraph.observations ?? [],
      reviews: assessment.reviews,
      incidentReviews: assessment.incidentReviews ?? [],
      findingReviews: assessment.findingReviews ?? [],
    },
    null,
    2,
  ) + "\n";
}

const csvColumns = [
  "id",
  "severity",
  "label",
  "affected_asset_ids",
  "mitigation_control_ids",
  "supporting_evidence_ids",
  "supporting_evidence_status",
  "disposition",
];
const MAX_FACTS_PREVIEW_CHARACTERS = 4096;
const MAX_UNRESOLVED_REFERENCES = 50;
// Escape Markdown syntax and URL/mention punctuation in one pass. Rendering
// character references preserves visible punctuation without parsing it as markup.
const markdownPunctuation = new Set("\\`*_{}[]<>()#+-.!|~=:/@&^$");

function csvCell(value: string): string {
  const leading = /^[\p{White_Space}\p{Cc}\p{Cf}]*/u.exec(value)?.[0] ?? "";
  const first = value.slice(leading.length).normalize("NFKC").charAt(0);
  const textPrefix = /[\p{Cc}\p{Cf}]/u.test(leading) ||
    /^[=+@\-−]$/.test(first);
  const printable = (textPrefix ? "'" : "") + value;
  return '"' + printable.replaceAll('"', '""') + '"';
}

function markdownText(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character)) {
      result += `&#91;U+${
        code.toString(16).toUpperCase().padStart(4, "0")
      }&#93;`;
    } else if (markdownPunctuation.has(character)) {
      result += `&#${code};`;
    } else {
      result += character;
    }
  }
  return result;
}

function linkedIds(ids: readonly string[], empty = "None linked"): string {
  return ids.length ? ids.map(markdownText).join(", ") : empty;
}

function appendReviewSteps(
  lines: string[],
  steps: readonly SentinelReviewStep[],
) {
  for (const step of steps) {
    const target = step.target ? ` · ${markdownText(step.target)}` : "";
    lines.push(
      `  - ${markdownText(step.tool)}${target} · ${markdownText(step.outcome)}`,
    );
    for (const source of step.sourceSnapshots ?? []) {
      const asset = source.assetId ? ` · ${markdownText(source.assetId)}` : "";
      lines.push(
        `    - ${markdownText(source.caseId)}${asset} · ${
          markdownText(source.snapshotDigest)
        }`,
      );
    }
  }
}

function tableRow(values: readonly string[]): string {
  return `| ${values.join(" | ")} |`;
}

function factsPreview(facts: unknown): string {
  const data = JSON.stringify(facts);
  if (data === undefined) return "No facts recorded";
  if (data.length <= MAX_FACTS_PREVIEW_CHARACTERS) return markdownText(data);
  return markdownText(data.slice(0, MAX_FACTS_PREVIEW_CHARACTERS)) +
    " … (preview truncated)";
}

function importedFindings(assessment: SentinelAssessmentExportInput) {
  const snapshot = assessment.result?.sharedGraph.snapshot;
  return snapshot === null || snapshot === undefined
    ? undefined
    : loadSentinelGraph(snapshot).report();
}

/** Export imported findings as UTF-8 CSV with formula-safe text cells. */
export function renderSentinelFindingsCsv(
  assessment: SentinelAssessmentExportInput,
): string {
  const findings = importedFindings(assessment) ?? [];
  const dispositions = new Map(
    (assessment.findingReviews ?? []).toReversed().map((
      review,
    ) => [review.findingId, review.disposition]),
  );
  const rows = findings.map((finding) => [
    finding.id,
    finding.severity,
    finding.label,
    JSON.stringify(finding.assets),
    JSON.stringify(finding.controls),
    JSON.stringify(finding.evidence),
    finding.evidence.length ? "linked" : "unlinked",
    dispositions.get(finding.id) ?? "open",
  ]);
  return [csvColumns, ...rows].map((row) => row.map(csvCell).join(","))
    .join("\r\n") +
    "\r\n";
}

/** Export an inert Markdown report separating imported data and analyst review. */
export function renderSentinelInvestigationMarkdown(
  assessment: SentinelAssessmentExportInput,
  adaptive?: AdaptiveProvenanceView & {
    readonly history?: readonly AdaptiveTaskEvent[];
    readonly modelPlannerHistory?: readonly ExportPlanningAttempt[];
    readonly modelPlanner?: {
      readonly attempt: number;
      readonly status: string;
    } | null;
    readonly notes?: readonly {
      readonly taskId: string | null;
      readonly note: string;
      readonly at: string;
      readonly steps?: readonly SentinelReviewStep[];
    }[];
  },
  language: SentinelReportLanguage = "en",
): string {
  const t = sentinelReportText(language);
  const report = assessment.result;
  const findings = importedFindings(assessment);
  const lines = [
    `# ${t("Sentinel investigation report")}`,
    "",
    `- ${t("Saved revision")} ${markdownText(String(assessment.revision))}`,
    `- ${t("Updated")} ${markdownText(assessment.updatedAt)}`,
  ];
  if (assessment.active !== undefined) {
    const state = assessment.completion
      ? t("Goal completed")
      : !assessment.active
      ? t("Stopped")
      : assessment.paused
      ? t("Paused")
      : t("Active");
    lines.push(`- ${t("Assessment state")} ${state}`);
  }
  if (assessment.completion) {
    const { goal, note, at } = assessment.completion;
    if (goal) lines.push(`- ${t("Completed goal")} ${markdownText(goal)}`);
    lines.push(
      `- ${t("Goal completed")} ${markdownText(at)}`,
      `- ${t("Completion note")} ${markdownText(note)}`,
    );
  }
  if (assessment.plan?.goal) {
    lines.push(`- ${t("Operator goal")} ${markdownText(assessment.plan.goal)}`);
  }
  if (report) {
    lines.push(`- ${t("Evidence revision")} ${markdownText(report.revision)}`);
  }
  if (assessment.workerFindings) {
    lines.push("", `## ${t("Worker findings and control rechecks")}`, "");
    for (const finding of assessment.workerFindings.findings) {
      lines.push(
        `- ${markdownText(finding.title)} (${markdownText(finding.id)})`,
        `  - ${markdownText(finding.summary)}`,
        `  - ${t("Evidence revision")} ${finding.evidenceRevision} · ${
          markdownText(finding.evidenceId)
        } · ${markdownText(finding.snapshotDigest)}`,
      );
    }
    for (const recheck of assessment.workerFindings.rechecks) {
      lines.push(
        `- ${t("Control recheck")} ${markdownText(recheck.id)} · ${
          t(recheck.outcome)
        } · ${markdownText(recheck.findingId)}`,
        `  - ${markdownText(recheck.summary)}`,
        `  - ${t("Evidence revision")} ${recheck.evidenceRevision} · ${
          markdownText(recheck.evidenceId)
        } · ${markdownText(recheck.snapshotDigest)}`,
      );
    }
    for (const amendment of assessment.workerFindings.amendments) {
      lines.push(
        `- ${t("Updated")} ${
          markdownText(amendment.findingId)
        } · v${amendment.version} · ${markdownText(amendment.title)}`,
        `  - ${markdownText(amendment.summary)}`,
      );
    }
  }

  lines.push(
    "",
    `## ${t("Imported observations")}`,
    "",
    t("Findings, severities, and links reflect the source graph. A mitigation link alone does not establish that a control was deployed or verified."),
    "",
  );
  if (findings === undefined) {
    lines.push(t("No graph snapshot was supplied."));
  } else if (!findings.length) {
    lines.push(t("The imported graph contains no findings."));
  } else {
    lines.push(
      tableRow([
        t("Finding ID"),
        t("Reported severity"),
        t("Source label"),
        t("Affected asset IDs"),
        t("Mitigation IDs"),
        t("Evidence IDs"),
      ]),
      tableRow(["---", "---", "---", "---", "---", "---"]),
    );
    for (const finding of findings) {
      lines.push(tableRow([
        markdownText(finding.id),
        markdownText(finding.severity),
        markdownText(finding.label),
        linkedIds(finding.assets, t("None linked")),
        linkedIds(finding.controls, t("None linked")),
        linkedIds(finding.evidence, t("None linked")),
      ]));
    }
  }

  const inventory = report?.sharedGraph.snapshot;
  if (inventory?.edges.some(({ relation }) => relation === "verifies")) {
    const verification = loadSentinelGraph(inventory).coverage(
      report?.controlEvaluationAt ?? assessment.updatedAt,
    );
    lines.push(
      "",
      `## ${t("Recorded control verification")}`,
      "",
      tableRow([
        t("Finding ID"),
        t("Control ID"),
        t("State"),
        t("Evidence IDs"),
        t("Verified at"),
        t("Valid until"),
      ]),
      tableRow(["---", "---", "---", "---", "---", "---"]),
    );
    for (const finding of verification.findings) {
      const controls = finding.controlVerification?.controls ?? [];
      for (const { controlId, status, evidenceId, verification } of controls) {
        lines.push(tableRow([
          markdownText(finding.id),
          markdownText(controlId),
          markdownText(t(status)),
          evidenceId === undefined ? "" : markdownText(evidenceId),
          verification?.observedAt ?? "",
          verification?.validUntil ?? "",
        ]));
      }
    }
  }

  if (report?.controlChanges?.length) {
    lines.push(
      "",
      `## ${t("Control verification changes")}`,
      "",
      tableRow([
        t("Finding ID"),
        t("Control ID"),
        t("Earlier state"),
        t("Current state"),
      ]),
      tableRow(["---", "---", "---", "---"]),
    );
    const format = (entry: typeof report.controlChanges[number]["before"]) =>
      entry
        ? markdownText(
          [t(entry.status), entry.evidenceId].filter(Boolean).join(" · "),
        )
        : t("None linked");
    for (
      const { findingId, controlId, before, after } of report.controlChanges
    ) {
      lines.push(tableRow([
        markdownText(findingId),
        markdownText(controlId),
        format(before),
        format(after),
      ]));
    }
  }

  lines.push(
    "",
    `## ${t("Derived assessment observations")}`,
    "",
    t("Task outcomes summarize the supplied evidence. A completed task or correlated alert does not verify an incident, exploitation, or attribution."),
    "",
  );
  if (report) {
    lines.push(
      tableRow([
        t("Task"),
        t("Worker"),
        t("State"),
        t("Prerequisites"),
        t("Required input or reason"),
      ]),
      tableRow(["---", "---", "---", "---", "---"]),
    );
    for (const task of report.tasks) {
      lines.push(tableRow([
        markdownText(task.id),
        markdownText(task.worker),
        markdownText(task.status),
        linkedIds(task.prerequisites, t("None linked")),
        [task.requiredInput, task.reason].flatMap((value) =>
          value === undefined ? [] : [markdownText(value)]
        ).join(" / "),
      ]));
    }
    lines.push("");
    for (const observation of report.sharedGraph.observations) {
      lines.push(
        `- **${markdownText(observation.task)}** ${
          factsPreview(observation.facts)
        }`,
      );
    }
  } else {
    lines.push(t("No assessment results have been saved."));
  }

  if (adaptive) {
    const hasPlannerRounds = adaptive.tasks.some((task) => task.plannerRound);
    lines.push(
      "",
      `## ${t("Adaptive task observations")}`,
      "",
      `${t("Goal")} ${markdownText(adaptive.goal.label)}`,
      "",
      tableRow([
        t("Task ID"),
        t("Task kind"),
        t("State"),
        t("Prerequisite IDs"),
        t("Reported evidence IDs"),
        t("Planner reason"),
        ...(hasPlannerRounds ? [t("Model planner")] : []),
      ]),
      tableRow(Array.from({ length: hasPlannerRounds ? 7 : 6 }, () => "---")),
    );
    for (const task of adaptive.tasks) {
      lines.push(tableRow([
        markdownText(task.id),
        markdownText(task.kind),
        markdownText(task.status),
        linkedIds(task.prerequisites, t("None linked")),
        linkedIds(task.evidenceIds, t("None linked")),
        task.reason === undefined ? "" : markdownText(task.reason),
        ...(hasPlannerRounds
          ? [
            task.plannerRound
              ? `${markdownText(task.plannerRound.identity)} · ${
                t("Attempt")
              } ${task.plannerRound.attempt}`
              : "",
          ]
          : []),
      ]));
    }
    lines.push("");
    for (const task of adaptive.tasks) {
      if (task.observation !== undefined) {
        lines.push(
          `- **${markdownText(task.id)}** ${factsPreview(task.observation)}`,
        );
      }
    }
    if (adaptive.modelPlanner) {
      lines.push(
        "",
        `${t("Model planner")} · ${
          markdownText(adaptive.modelPlanner.status.replaceAll("_", " "))
        } · ${t("Attempt")} ${adaptive.modelPlanner.attempt}`,
      );
    }
    if (adaptive.modelPlannerHistory?.length) {
      lines.push("", `### ${t("Model planning attempts")}`, "");
      for (const entry of adaptive.modelPlannerHistory) {
        const finished = entry.finished
          ? ` · ${t("Finished")} ${markdownText(entry.finished)}`
          : "";
        const inputs = [
          ["Case hint", entry.hintIds ?? (entry.hintId ? [entry.hintId] : [])],
          [
            "Finding decision",
            entry.findingReviewIds ??
              (entry.findingReviewId ? [entry.findingReviewId] : []),
          ],
          [
            "Incident decision",
            entry.incidentReviewIds ??
              (entry.incidentReviewId ? [entry.incidentReviewId] : []),
          ],
        ] as const;
        const references = inputs.flatMap(([label, ids]) =>
          ids.map((id) => ` · ${t(label)} #${id}`)
        ).join("");
        lines.push(
          `- ${t("Attempt")} ${entry.attempt} · ${
            markdownText(entry.outcome)
          } · ${t("Started")} ${
            markdownText(entry.started)
          }${finished}${references}`,
        );
        if (entry.incidentCandidateIds?.length) {
          lines.push(
            `  - ${t("Incident inputs")} ${
              entry.incidentCandidateIds.map(markdownText).join(", ")
            }`,
          );
        }
      }
    }
    if (adaptive.history?.length) {
      lines.push("", `### ${t("Adaptive task transitions")}`, "");
      for (const event of adaptive.history) {
        const attempt = event.attempt > 0
          ? ` · ${t("Attempt")} ${event.attempt}`
          : "";
        const note = event.note ? ` · ${markdownText(event.note)}` : "";
        lines.push(
          `- ${markdownText(event.at)} · ${markdownText(event.taskId)} · ${
            markdownText(event.event)
          }${attempt}${note}`,
        );
      }
    }
    if (adaptive.notes?.length) {
      lines.push("", `### ${t("Adaptive worker notes")}`, "");
      for (const note of adaptive.notes) {
        const task = note.taskId ? ` (${markdownText(note.taskId)})` : "";
        lines.push(
          `- ${markdownText(note.at)}${task} ${markdownText(note.note)}`,
        );
        appendReviewSteps(lines, note.steps ?? []);
      }
    }
  }

  if (assessment.findingReviews?.length) {
    lines.push("", `## ${t("Operator finding reviews")}`, "");
    for (const review of assessment.findingReviews) {
      lines.push(
        `- ${t("Finding decision")} #${review.id} · ${
          markdownText(review.findingId)
        } · ${markdownText(review.disposition)} · ${
          t("Saved revision")
        } ${review.revision} · ${markdownText(review.at)} · ${
          markdownText(review.note)
        }`,
      );
    }
  }

  if (assessment.incidentReviews?.length) {
    lines.push("", `## ${t("Operator incident reviews")}`, "");
    for (const review of assessment.incidentReviews) {
      lines.push(
        `- ${t("Incident decision")} #${review.id} · ${
          markdownText(review.incidentId)
        } · ${markdownText(review.disposition)} · ${
          t("Saved revision")
        } ${review.revision} · ${markdownText(review.at)} · ${
          markdownText(review.note)
        }`,
      );
    }
  }

  if (report) {
    const provenance = buildSentinelProvenance(
      report,
      adaptive,
      undefined,
      assessment.incidentReviews,
      assessment.findingReviews,
    ).snapshot();
    lines.push(
      "",
      `## ${t("Provenance")}`,
      "",
      t(
        "The saved links resolve to {nodes} graph records and {edges} relationships.",
        { nodes: provenance.nodes.length, edges: provenance.edges.length },
      ),
      t("Unresolved references in this report total {count}.", {
        count: provenance.unresolvedReferences.length,
      }),
    );
    if (provenance.unresolvedReferences.length) lines.push("");
    for (
      const reference of provenance.unresolvedReferences.slice(
        0,
        MAX_UNRESOLVED_REFERENCES,
      )
    ) {
      lines.push(
        `- ${markdownText(reference.node)} ${
          markdownText(reference.relation)
        } ${markdownText(reference.reference)}`,
      );
    }
    if (provenance.unresolvedReferences.length > MAX_UNRESOLVED_REFERENCES) {
      lines.push(
        `- ${
          t("First {count} unresolved references shown.", {
            count: MAX_UNRESOLVED_REFERENCES,
          })
        }`,
      );
    }
    const sourceRows = provenance.nodes.flatMap((node) =>
      node.kind === "evidence"
        ? (node.relationshipSources ?? []).map((source) => ({ node, source }))
        : []
    );
    if (sourceRows.length) {
      lines.push(
        "",
        `### ${t("Relationship sources")}`,
        "",
        tableRow([
          t("Evidence IDs"),
          t("Reporting case"),
          t("Original source endpoint"),
          t("Original destination endpoint"),
          t("Snapshot digest"),
        ]),
        tableRow(["---", "---", "---", "---", "---"]),
      );
      const limit = 200;
      for (const { node, source } of sourceRows.slice(0, limit)) {
        lines.push(
          tableRow(
            [
              node.sourceId,
              source.caseId,
              source.from,
              source.to,
              source.snapshotDigest ?? "",
            ].map(markdownText),
          ),
        );
      }
      if (sourceRows.length > limit) {
        lines.push(
          "",
          t("Showing {count} of {total} relationship sources.", {
            count: limit,
            total: sourceRows.length,
          }),
        );
      }
    }
  }

  lines.push("", `## ${t("Review notes")}`, "");
  if (assessment.reviews.length) {
    lines.push(
      t("These notes contain unverified review analysis and require independent corroboration."),
      "",
    );
    for (const item of assessment.reviews) {
      lines.push(
        `- **${markdownText(item.task)}** ${markdownText(item.analysis)}`,
      );
      appendReviewSteps(lines, item.steps ?? []);
    }
  } else {
    lines.push(t("No review notes were saved for this revision."));
  }

  return lines.join("\n") + "\n";
}
