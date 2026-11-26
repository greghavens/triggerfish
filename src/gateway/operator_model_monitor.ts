import {
  canFlowTo,
  maxClassification,
  parseClassification,
} from "../core/types/classification.ts";
import { modelMonitor } from "../core/model_monitor.ts";
import type { OperatorRunToolContext } from "./operator_run_tool.ts";

export const modelMonitoringActions = [
  "model_retry_policy",
  "set_model_retry_policy",
  "model_health",
  "reset_model_health",
  "model_usage",
  "model_call_records",
  "model_call_record",
  "delete_model_call_record",
] as const;
type ModelMonitoringAction = typeof modelMonitoringActions[number];

function exactInteger(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= min && value <= max;
}

/** Each usage partition is independently authorized, including its record cursors. */
export async function executeOperatorModelMonitor(
  baseDir: string,
  confirm: (question: string) => Promise<boolean>,
  action: ModelMonitoringAction,
  args: Record<string, unknown>,
  context: OperatorRunToolContext | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (
    !context?.authenticatedOwnerSessionId ||
    !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC")
  ) return;
  const authorize = context.authorizeOwnerRunCall;
  if (!authorize || !await authorize(args)) return;
  const monitor = modelMonitor(baseDir);
  const {
    modelProfile,
    modelRouteModel,
    modelRouteClassification,
    expectedVersion,
    requestId,
    modelRetryCount,
    modelRetryDelayMs,
    modelRecordId,
    modelUsageDays,
  } = args;
  const fields: Record<ModelMonitoringAction, readonly string[]> = {
    model_retry_policy: [],
    set_model_retry_policy: [
      "expectedVersion",
      "requestId",
      "modelRetryCount",
      "modelRetryDelayMs",
    ],
    model_health: [],
    reset_model_health: ["expectedVersion"],
    model_usage: ["modelUsageDays"],
    model_call_records: ["modelRecordId"],
    model_call_record: ["modelRecordId"],
    delete_model_call_record: ["modelRecordId"],
  };
  const retry = action === "model_retry_policy" ||
    action === "set_model_retry_policy";
  const allowed = new Set([
    "action",
    ...fields[action],
    ...(retry
      ? []
      : ["modelProfile", "modelRouteModel", "modelRouteClassification"]),
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key))) return;
  if (action === "model_retry_policy") {
    return { retryPolicy: monitor.retryPolicy() };
  }
  if (action === "set_model_retry_policy") {
    if (
      !exactInteger(expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1) ||
      typeof requestId !== "string" ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(requestId) ||
      !exactInteger(modelRetryCount, 0, 8) ||
      !exactInteger(modelRetryDelayMs, 0, 5000)
    ) return;
    const current = monitor.retryPolicy();
    const request = requestId.toLowerCase();
    if (current.version !== expectedVersion) {
      const same = current.version === expectedVersion + 1 &&
        current.requestId === request &&
        current.retries === modelRetryCount &&
        current.delayMs === modelRetryDelayMs;
      return same ? { retryPolicy: current } : undefined;
    }
    if (
      !await confirm(
        `Approve provider retry policy ${JSON.stringify(args)}?`,
      ) ||
      !await authorize(args)
    ) return;
    const retryPolicy = monitor.setRetry(
      expectedVersion,
      request,
      modelRetryCount,
      modelRetryDelayMs,
    );
    return retryPolicy ? { retryPolicy } : undefined;
  }
  const parsed = parseClassification(
    typeof modelRouteClassification === "string"
      ? modelRouteClassification
      : "INTERNAL",
  );
  if (
    (modelRouteClassification !== undefined &&
      typeof modelRouteClassification !== "string") ||
    !parsed.ok || !canFlowTo(parsed.value, context.ceiling ?? "PUBLIC")
  ) return;
  const level = parsed.value;
  const _classification = maxClassification("INTERNAL", level);
  if (
    typeof modelProfile !== "string" ||
    !/^[\da-z_.-]{1,80}$/i.test(modelProfile) ||
    typeof modelRouteModel !== "string" ||
    !/^[\da-z/_.:@-]{0,160}$/i.test(modelRouteModel)
  ) return;
  if (action === "model_health") {
    return {
      _classification,
      health: monitor.health(level, modelProfile, modelRouteModel),
    };
  }
  if (action === "reset_model_health") {
    if (
      !exactInteger(expectedVersion, 1, Number.MAX_SAFE_INTEGER - 1) ||
      monitor.health(level, modelProfile, modelRouteModel).version !==
        expectedVersion ||
      !await confirm(
        `Reset provider health for ${level} ${modelProfile}/${modelRouteModel} at version ${expectedVersion}?`,
      ) ||
      !await authorize(args)
    ) return;
    return monitor.reset(level, modelProfile, modelRouteModel, expectedVersion)
      ? { _classification, reset: true, version: expectedVersion + 1 }
      : undefined;
  }
  if (action === "model_usage") {
    const days = modelUsageDays ?? 7;
    if (!exactInteger(days, 1, 30)) return;
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - days + 1);
    return {
      _classification,
      days: monitor.usage(
        level,
        modelProfile,
        modelRouteModel,
        date.toISOString().slice(0, 10),
      ),
    };
  }
  if (action === "model_call_records") {
    const before = modelRecordId ?? Number.MAX_SAFE_INTEGER;
    if (!exactInteger(before, 1, Number.MAX_SAFE_INTEGER)) return;
    const records = monitor.page(
      level,
      modelProfile,
      modelRouteModel,
      before,
      21,
    );
    return {
      _classification,
      records: records.slice(0, 20),
      ...(records.length > 20 && { nextBefore: records[19].id }),
    };
  }
  if (action === "model_call_record") {
    if (!exactInteger(modelRecordId, 1, Number.MAX_SAFE_INTEGER)) return;
    const record = monitor.get(
      level,
      modelProfile,
      modelRouteModel,
      modelRecordId,
    );
    return record ? { _classification, record } : undefined;
  }
  if (
    !exactInteger(modelRecordId, 1, Number.MAX_SAFE_INTEGER) ||
    !await confirm(
      `Delete metadata record ${modelRecordId} for ${level} ${modelProfile}/${modelRouteModel}?`,
    ) ||
    !await authorize(args)
  ) return;
  return monitor.remove(level, modelProfile, modelRouteModel, modelRecordId)
    ? { _classification, deleted: modelRecordId }
    : undefined;
}
