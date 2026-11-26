/** Bounded worker context derived from a saved local evidence read. */
import { redactCredentialText } from "../core/logger/redactor.ts";

export const SENTINEL_WORKER_NARRATIVE_READ = "sentinel_worker_narrative";
export const SENTINEL_WORKER_NARRATIVE_COMMIT =
  "sentinel_publish_worker_narrative";
export const isWorkerNarrativeId = (
  value: unknown,
): value is `worker-narrative:${string}` =>
  typeof value === "string" && /^worker-narrative:[a-f0-9]{64}$/.test(value);

interface FactConclusion {
  readonly summary: string;
  readonly confidence: "observed" | "inferred";
  readonly conclusion: "positive" | "negative";
  readonly detail?: string;
}

export interface SentinelWorkerNarrativeReceipt {
  readonly summary: string;
  readonly confidence: "observed" | "inferred";
  readonly sourceSha256: string;
  readonly evidenceId: string;
  readonly trafficDigest?: string;
  readonly upstreamCheck?: string;
  readonly conclusion?: FactConclusion["conclusion"];
  readonly detail?: string;
  readonly facts?: readonly FactConclusion[];
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && !!value &&
    value.trim() === value && value.length <= max &&
    !/[\p{Cc}\p{Cf}]/u.test(value) && redactCredentialText(value) === value;
}

function readFactConclusion(value: unknown): FactConclusion | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { summary, confidence, conclusion, detail } = value as Record<
    string,
    unknown
  >;
  if (
    Object.keys(value).some((key) =>
      !["summary", "confidence", "conclusion", "detail"].includes(key)
    ) ||
    !validText(summary, 300) ||
    (confidence !== "observed" && confidence !== "inferred") ||
    (conclusion !== "positive" && conclusion !== "negative") ||
    (detail !== undefined && !validText(detail, 300))
  ) return;
  return { summary, confidence, conclusion, ...(detail && { detail }) };
}

/** Normalize tool submissions without accepting model-supplied source digests. */
export function readWorkerNarrativeSubmission(
  args: Record<string, unknown>,
  sourceSha256: string,
) {
  if (Object.hasOwn(args, "sourceSha256")) return;
  if (!Object.hasOwn(args, "facts")) {
    return readWorkerNarrativeReceipt({ ...args, sourceSha256 });
  }
  const { facts } = args;
  if (
    !Array.isArray(facts) ||
    Object.keys(args).some((key) =>
      !["evidenceId", "trafficDigest", "upstreamCheck", "facts"].includes(key)
    )
  ) return;
  const first = readFactConclusion(facts[0]);
  return first && readWorkerNarrativeReceipt({
    ...args,
    summary: first.summary,
    confidence: first.confidence,
    sourceSha256,
  });
}

export function readWorkerNarrativeReceipt(
  value: unknown,
): SentinelWorkerNarrativeReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const {
    summary,
    confidence,
    sourceSha256,
    evidenceId,
    trafficDigest,
    upstreamCheck,
    conclusion,
    detail,
    facts,
  } = value as Record<
    string,
    unknown
  >;
  if (
    Object.keys(value).some((key) =>
      ![
        "summary",
        "confidence",
        "evidenceId",
        "sourceSha256",
        "trafficDigest",
        "upstreamCheck",
        "conclusion",
        "detail",
        "facts",
      ].includes(key)
    ) ||
    (conclusion !== undefined && conclusion !== "positive" &&
      conclusion !== "negative") ||
    (detail !== undefined &&
      (conclusion === undefined || !validText(detail, 300))) ||
    (facts !== undefined &&
      (conclusion !== undefined || detail !== undefined ||
        !Array.isArray(facts) || facts.length < 1 || facts.length > 8)) ||
    (upstreamCheck !== undefined &&
      (trafficDigest !== undefined ||
        typeof upstreamCheck !== "string" ||
        !/^[a-z][a-z0-9_]{0,127}$/.test(upstreamCheck) ||
        typeof evidenceId !== "string" ||
        !/^case-alert:[a-f0-9]{64}$/.test(evidenceId))) ||
    (trafficDigest !== undefined &&
      (typeof trafficDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(trafficDigest))) ||
    typeof summary !== "string" ||
    !summary || summary.trim() !== summary || summary.length > 600 ||
    /[\p{Cc}\p{Cf}]/u.test(summary) ||
    redactCredentialText(summary) !== summary ||
    (confidence !== "observed" && confidence !== "inferred") ||
    typeof evidenceId !== "string" || !evidenceId || evidenceId.length > 256 ||
    redactCredentialText(evidenceId) !== evidenceId ||
    typeof sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(sourceSha256)
  ) return;
  const conclusions = Array.isArray(facts)
    ? facts.map(readFactConclusion)
    : undefined;
  if (
    conclusions &&
    (conclusions.some((fact) => !fact) ||
      JSON.stringify(conclusions).length > 4000 ||
      conclusions[0]?.summary !== summary ||
      conclusions[0]?.confidence !== confidence ||
      new Set(conclusions.map((fact) => JSON.stringify(fact))).size !==
        conclusions.length)
  ) return;
  return {
    summary,
    confidence,
    sourceSha256,
    evidenceId,
    ...(trafficDigest && { trafficDigest }),
    ...(typeof upstreamCheck === "string" && { upstreamCheck }),
    ...(conclusion && { conclusion }),
    ...(detail && { detail }),
    ...(conclusions && { facts: conclusions as FactConclusion[] }),
  };
}

/** Stable projection used to verify a recovered publication request. */
export function workerNarrativeArguments(
  receipt: SentinelWorkerNarrativeReceipt,
) {
  const {
    summary,
    confidence,
    evidenceId,
    trafficDigest,
    upstreamCheck,
    conclusion,
    detail,
    facts,
  } = receipt;
  return {
    ...(facts ? {} : { summary, confidence }),
    evidenceId,
    ...(trafficDigest && { trafficDigest }),
    ...(upstreamCheck && { upstreamCheck }),
    ...(conclusion && { conclusion }),
    ...(detail && { detail }),
    ...(facts && { facts }),
  };
}
