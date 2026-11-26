export const sentinelIncidentRecommendationToolName =
  "sentinel_recommend_incident_disposition";

export const sentinelIncidentDispositions = [
  "investigating",
  "resolved",
  "dismissed",
  "requires_review",
] as const;

export function parseSentinelIncidentRecommendation(
  args: Record<string, unknown>,
  parseNote: (value: unknown) => string | undefined,
) {
  const { incidentId, disposition } = args;
  const decision = sentinelIncidentDispositions.find((value) =>
    value === disposition
  );
  const note = parseNote(args.note);
  if (
    Object.keys(args).length !== 3 ||
    typeof incidentId !== "string" ||
    !/^incident:[a-f0-9]{64}$/.test(incidentId) ||
    !decision || !note
  ) return;
  return { incidentId, disposition: decision, note };
}

export type SentinelIncidentRecommendation = NonNullable<
  ReturnType<typeof parseSentinelIncidentRecommendation>
>;

export interface SentinelIncidentRecommendationEvidence {
  readonly assignmentId: string;
  readonly attempt: number;
  readonly pages: readonly {
    readonly offset: number;
    readonly limit: number;
    readonly nextOffset: number | null;
    readonly sha256: string;
  }[];
}

/** The incident and evidence revision live on the enclosing decision row. */
export function readSentinelIncidentRecommendationEvidence(
  value: unknown,
): SentinelIncidentRecommendationEvidence | undefined {
  if (typeof value === "string") {
    if (value.length > 4_096) return;
    try {
      value = JSON.parse(value);
    } catch {
      return;
    }
  }
  if (!value || typeof value !== "object") return;
  const { assignmentId, attempt, pages } = value as Record<string, unknown>;
  if (
    Object.keys(value).length !== 3 ||
    typeof assignmentId !== "string" ||
    !/^adaptive:[a-f0-9]{64}$/.test(assignmentId) ||
    typeof attempt !== "number" || !Number.isSafeInteger(attempt) ||
    attempt < 1 ||
    !Array.isArray(pages) || !pages.length || pages.length > 12
  ) return;
  const checked: SentinelIncidentRecommendationEvidence["pages"][number][] = [];
  let expected: number | null = 0;
  for (const page of pages) {
    if (!page || typeof page !== "object" || Object.keys(page).length !== 4) {
      return;
    }
    const { offset, limit, nextOffset, sha256 } = page;
    if (
      expected === null || offset !== expected ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 10 ||
      nextOffset !== null &&
        (!Number.isSafeInteger(nextOffset) || nextOffset <= offset ||
          nextOffset > offset + limit) ||
      typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)
    ) return;
    checked.push({ offset, limit, nextOffset, sha256 });
    expected = nextOffset;
  }
  if (expected !== null) return;
  return { assignmentId, attempt, pages: checked };
}
