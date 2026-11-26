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

export interface WorkerNarrativeEvidence {
  readonly evidenceId: string;
  readonly trafficDigest?: string;
  readonly upstreamCheck?: string;
}

interface WorkerNarrativeFact extends FactConclusion, WorkerNarrativeEvidence {}

export interface WorkerNarrativeFactSource extends WorkerNarrativeEvidence {
  readonly sourceSha256: string;
  readonly stepIndex: number;
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
  readonly factSources?: readonly WorkerNarrativeFactSource[];
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

/** Per-conclusion source selectors. Source steps and digests are server-owned. */
export function readWorkerNarrativeFactBatch(
  args: Record<string, unknown>,
): WorkerNarrativeFact[] | undefined {
  if (
    Object.keys(args).length !== 1 || !Array.isArray(args.facts) ||
    !args.facts.length || args.facts.length > 8
  ) return;
  const entries: WorkerNarrativeFact[] = [];
  for (const value of args.facts) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const { evidenceId, trafficDigest, upstreamCheck, ...text } = value;
    const fact = readFactConclusion(text);
    const source = readWorkerNarrativeReceipt({
      evidenceId,
      ...(trafficDigest !== undefined && { trafficDigest }),
      ...(upstreamCheck !== undefined && { upstreamCheck }),
      summary: fact?.summary,
      confidence: fact?.confidence,
      sourceSha256: "0".repeat(64),
    });
    if (!fact || !source) return;
    entries.push({
      ...fact,
      evidenceId: source.evidenceId,
      ...(source.trafficDigest && { trafficDigest: source.trafficDigest }),
      ...(source.upstreamCheck && { upstreamCheck: source.upstreamCheck }),
    });
  }
  return entries;
}

/** Every exact source of a persisted batch, or the single legacy source. */
export function workerNarrativeSources(
  receipt: SentinelWorkerNarrativeReceipt,
  stepIndex: number,
): readonly WorkerNarrativeFactSource[] {
  const {
    evidenceId,
    sourceSha256,
    trafficDigest,
    upstreamCheck,
    factSources,
  } = receipt;
  return factSources ?? [{
    evidenceId,
    sourceSha256,
    stepIndex,
    ...(trafficDigest && { trafficDigest }),
    ...(upstreamCheck && { upstreamCheck }),
  }];
}

/** Normalize tool submissions without accepting model-supplied source digests. */
export function readWorkerNarrativeSubmission(
  args: Record<string, unknown>,
  source: string | readonly WorkerNarrativeFactSource[],
) {
  if (Object.hasOwn(args, "sourceSha256")) return;
  const batch = readWorkerNarrativeFactBatch(args);
  if (batch) {
    const facts: FactConclusion[] = [];
    const factSources = batch.map(
      ({ evidenceId, trafficDigest, upstreamCheck, ...fact }, i) => {
        facts.push(fact);
        const proof = typeof source === "string"
          ? {
            sourceSha256: source,
            stepIndex: 0,
            evidenceId,
            trafficDigest,
            upstreamCheck,
          }
          : source[i];
        if (
          !proof || proof.evidenceId !== evidenceId ||
          proof.trafficDigest !== trafficDigest ||
          proof.upstreamCheck !== upstreamCheck
        ) return;
        return {
          evidenceId,
          sourceSha256: proof.sourceSha256,
          stepIndex: proof.stepIndex,
          ...(trafficDigest && { trafficDigest }),
          ...(upstreamCheck && { upstreamCheck }),
        };
      },
    );
    if (
      factSources.some((proof) => !proof) ||
      typeof source !== "string" && source.length !== batch.length
    ) return;
    const { stepIndex: _step, ...primary } = factSources[0]!;
    return readWorkerNarrativeReceipt({
      summary: facts[0].summary,
      confidence: facts[0].confidence,
      ...primary,
      facts,
      factSources,
    });
  }
  if (typeof source !== "string") return;
  const sourceSha256 = source;
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
    factSources,
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
        "factSources",
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
  let sources: WorkerNarrativeFactSource[] | undefined;
  if (factSources !== undefined) {
    if (
      !Array.isArray(factSources) || !conclusions ||
      factSources.length !== conclusions.length
    ) return;
    sources = [];
    for (const value of factSources) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const { stepIndex, ...source } = value;
      if (
        typeof stepIndex !== "number" || !Number.isSafeInteger(stepIndex) ||
        stepIndex < 0 || stepIndex >= 16 ||
        Object.hasOwn(source, "factSources") ||
        Object.keys(source).some((key) =>
          !["evidenceId", "sourceSha256", "trafficDigest", "upstreamCheck"]
            .includes(key)
        )
      ) return;
      const parsed = readWorkerNarrativeReceipt({
        ...source,
        summary,
        confidence,
      });
      if (!parsed) return;
      sources.push({
        evidenceId: parsed.evidenceId,
        sourceSha256: parsed.sourceSha256,
        stepIndex,
        ...(parsed.trafficDigest && { trafficDigest: parsed.trafficDigest }),
        ...(parsed.upstreamCheck && { upstreamCheck: parsed.upstreamCheck }),
      });
    }
    const first = sources[0];
    if (
      first.evidenceId !== evidenceId || first.sourceSha256 !== sourceSha256 ||
      first.trafficDigest !== trafficDigest ||
      first.upstreamCheck !== upstreamCheck
    ) return;
  }
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
    ...(sources && { factSources: sources }),
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
    factSources,
  } = receipt;
  if (facts && factSources) {
    return {
      facts: facts.map((fact, i) => {
        const { evidenceId, trafficDigest, upstreamCheck } = factSources[i];
        return {
          ...fact,
          evidenceId,
          ...(trafficDigest && { trafficDigest }),
          ...(upstreamCheck && { upstreamCheck }),
        };
      }),
    };
  }
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
