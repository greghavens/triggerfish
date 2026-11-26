/** Bind an opt-in workspace's named adaptive work to its current coordinator. */
import { resolve } from "@std/path";
import { readSentinelAssessmentAdmission } from "../sentinel/assessment_store.ts";
import { locateSentinelCase } from "../sentinel/cases.ts";

type CoordinatorAdmission = (caseId: string, admissionAt: number) => boolean;
const admissions = new Map<string, CoordinatorAdmission>();

export function bindSentinelCaseAdmission(
  baseDir: string,
  admitted: CoordinatorAdmission,
): () => void {
  const root = resolve(baseDir);
  if (admissions.has(root)) {
    throw new Error(
      "Sentinel case admission is already bound for this workspace",
    );
  }
  admissions.set(root, admitted);
  return () => {
    if (admissions.get(root) === admitted) admissions.delete(root);
  };
}

export function allowsSentinelAdaptiveWork(
  snapshotPath: string,
  admissionAt: number | undefined,
): boolean {
  if (!admissions.size) return true;
  const location = locateSentinelCase(snapshotPath);
  if (!location || location.caseId === "main") return true;
  const admitted = admissions.get(location.baseDir);
  if (!admitted) return true;
  const generation = admissionAt ??
    readSentinelAssessmentAdmission(snapshotPath);
  return generation !== undefined && admitted(location.caseId, generation);
}
