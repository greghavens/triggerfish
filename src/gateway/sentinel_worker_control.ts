/** Validate authenticated Sentinel assignment controls for native and Tidepool chat. */
import { readSentinelAssessment } from "../sentinel/assessment_store.ts";
import {
  readAdaptiveSentinel,
  requestSentinelWorkerControl,
  SentinelAssignmentError,
} from "./sentinel_adaptive_runtime.ts";

export function readSentinelWorkerControlStatus(path: string) {
  const state = readSentinelAssessment(path);
  const adaptive = state?.result ? readAdaptiveSentinel(path, state) : null;
  return {
    revision: adaptive?.revision ?? null,
    evidenceRevision: adaptive?.evidenceRevision ?? state?.revision ?? null,
    workers: adaptive?.modelReviewStates ?? [],
  };
}

export function applySentinelWorkerControlRequest(
  path: string,
  action: "steer" | "stop",
  fields: Record<string, unknown>,
) {
  const { revision, taskId, controlRequestId, note } = fields;
  if (
    typeof revision !== "string" || !revision.length || revision.length > 512 ||
    typeof taskId !== "string" || !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
    typeof controlRequestId !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(controlRequestId) ||
    note !== undefined && (typeof note !== "string" ||
        !note.trim() || note.length > 1000 || note.includes("\x00")) ||
    (action === "steer" ? typeof note !== "string" : note !== undefined)
  ) {
    throw new SentinelAssignmentError(
      "Supply the exact worker revision, assignment, control UUID, and a note for steering.",
    );
  }
  const receipt = requestSentinelWorkerControl(
    path,
    revision,
    taskId,
    controlRequestId.toLowerCase(),
    action,
    typeof note === "string" ? note.trim() : undefined,
  );
  if (!receipt) {
    throw new SentinelAssignmentError(
      "The worker assignment or request changed. Refresh its status before trying again.",
    );
  }
  return receipt;
}

/** Native chat uses the selected case and the same validated controls as Tidepool. */
export function runSentinelWorkerControlChat(
  path: string,
  text: string,
): string {
  if (text === "assessment workers status") {
    return JSON.stringify(readSentinelWorkerControlStatus(path));
  }
  const action = /^assessment workers (steer|stop) ([\s\S]+)$/.exec(text);
  if (!action || action[2].length > 8192) {
    return "Use assessment workers status, steer <JSON>, or stop <JSON>.";
  }
  let input: unknown;
  try {
    input = JSON.parse(action[2]);
  } catch {
    throw new SentinelAssignmentError("Supply a JSON worker control request.");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SentinelAssignmentError("Supply a JSON worker control request.");
  }
  return JSON.stringify(applySentinelWorkerControlRequest(
    path,
    action[1] === "steer" ? "steer" : "stop",
    input as Record<string, unknown>,
  ));
}
