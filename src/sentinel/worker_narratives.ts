/** Bounded worker context derived from a saved local evidence read. */
import { redactCredentialText } from "../core/logger/redactor.ts";

export const SENTINEL_WORKER_NARRATIVE_READ = "sentinel_worker_narrative";
export const SENTINEL_WORKER_NARRATIVE_COMMIT =
  "sentinel_publish_worker_narrative";
export const isWorkerNarrativeId = (value: unknown): value is string =>
  typeof value === "string" && /^worker-narrative:[a-f0-9]{64}$/.test(value);

export interface SentinelWorkerNarrativeReceipt {
  readonly summary: string;
  readonly confidence: "observed" | "inferred";
  readonly sourceSha256: string;
  readonly evidenceId: string;
}

export function readWorkerNarrativeReceipt(
  value: unknown,
): SentinelWorkerNarrativeReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { summary, confidence, sourceSha256, evidenceId } = value as Record<
    string,
    unknown
  >;
  if (
    Object.keys(value).length !== 4 || typeof summary !== "string" ||
    !summary || summary.trim() !== summary || summary.length > 600 ||
    /[\p{Cc}\p{Cf}]/u.test(summary) ||
    redactCredentialText(summary) !== summary ||
    (confidence !== "observed" && confidence !== "inferred") ||
    typeof evidenceId !== "string" || !evidenceId || evidenceId.length > 256 ||
    redactCredentialText(evidenceId) !== evidenceId ||
    typeof sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(sourceSha256)
  ) return;
  return { summary, confidence, sourceSha256, evidenceId };
}
