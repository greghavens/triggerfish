/** Owner-only recovery of a committed Sentinel assignment intent. */
import { redactCredentialText } from "../core/logger/redactor.ts";
import { createHash } from "node:crypto";
import type { AgentRecoveryPolicy } from "../core/agent_recovery.ts";
import {
  isSentinelCaseId,
  resolveSentinelCasePath,
} from "../sentinel/cases.ts";
import {
  readSentinelAssessment,
  readSentinelOperatingConstraints,
} from "../sentinel/assessment_store.ts";
import { parseSentinelGraphFactRequirement } from "../sentinel/worker_graph_facts.ts";
import { sentinelOperatingConstraintsAllow } from "../sentinel/operating_constraints.ts";
import { submitSentinelAssignmentIntent } from "./sentinel_adaptive_runtime.ts";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function withSentinelAssignmentRecovery(
  baseDir: string,
  cases: ReadonlySet<string>,
  fallback: AgentRecoveryPolicy,
): AgentRecoveryPolicy {
  const assignment = (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => {
    if (name !== "operator_runs") return;
    const {
      action,
      kind,
      id,
      revision,
      runId,
      adaptiveRevision,
      requestId,
      taskKind,
      node,
      graphRelationship,
    } = args;
    if (
      Object.keys(args).length !== (graphRelationship === undefined ? 9 : 10) ||
      action !== "assign" ||
      kind !== "sentinel" || typeof id !== "string" ||
      !isSentinelCaseId(id) || !cases.has(id) ||
      typeof revision !== "number" || !Number.isSafeInteger(revision) ||
      revision < 1 ||
      typeof runId !== "string" || !uuid.test(runId) ||
      typeof requestId !== "string" || !uuid.test(requestId) ||
      typeof adaptiveRevision !== "string" ||
      !/^[a-f0-9]{64}$/.test(adaptiveRevision) ||
      (taskKind !== "trace" && taskKind !== "impact") ||
      typeof node !== "string" || !node.trim() || node.length > 512 ||
      node.includes("\0") || redactCredentialText(node) !== node
    ) return;
    const relationship = graphRelationship === undefined
      ? undefined
      : parseSentinelGraphFactRequirement(graphRelationship, node);
    if (
      graphRelationship !== undefined && (
        taskKind !== "trace" || !relationship ||
        (relationship.from !== undefined &&
          redactCredentialText(relationship.from) !== relationship.from) ||
        redactCredentialText(relationship.to) !== relationship.to
      )
    ) return;
    return {
      action,
      kind,
      id,
      revision,
      runId,
      adaptiveRevision,
      requestId,
      taskKind,
      node,
      ...(relationship && { graphRelationship: relationship }),
    } as const;
  };
  function read(name: string, args: Readonly<Record<string, unknown>>) {
    const request = assignment(name, args);
    if (!request) return;
    const path = resolveSentinelCasePath(baseDir, request.id);
    const state = readSentinelAssessment(path);
    const snapshot = state?.result?.sharedGraph.snapshot;
    if (
      !state?.active || state.revision !== request.revision ||
      state.plan.runId !== request.runId || !snapshot
    ) return;
    const constraints = readSentinelOperatingConstraints(path, request.runId)
      ?.constraints;
    const allows = (nodeId: string) =>
      sentinelOperatingConstraintsAllow(
        constraints,
        { kind: request.taskKind, nodeId },
        snapshot,
      );
    if (!allows(request.node)) return;
    if (request.graphRelationship) {
      const endpoints = [
        request.graphRelationship.from,
        request.graphRelationship.to,
      ];
      if (
        snapshot.nodes.some(({ kind, id }) =>
          kind === "asset" && endpoints.includes(id) && !allows(id)
        )
      ) return;
    }
    const receipt = submitSentinelAssignmentIntent(
      path,
      {
        requestId: request.requestId,
        runId: request.runId,
        evidenceRevision: request.revision,
        adaptiveRevision: request.adaptiveRevision,
        kind: request.taskKind,
        nodeId: request.node,
        ...(request.graphRelationship &&
          { graphRelationship: request.graphRelationship }),
      },
      undefined,
      true,
    );
    if (receipt) {
      return JSON.stringify({
        run: { kind: request.kind, id: request.id, revision: request.revision },
        receipt,
        _classification: "INTERNAL",
      });
    }
  }
  return {
    ...fallback,
    projectCall: (call) =>
      assignment(call.name, call.args) ?? fallback.projectCall(call),
    canReconcile: (call) => !!assignment(call.name, call.args),
    reconcile: (call) => Promise.resolve(read(call.name, call.args)),
    projectResult: (call, text) => {
      if (call.name !== "operator_runs") {
        return fallback.projectResult(call, text);
      }
      return read(call.name, call.args) === text ? text : undefined;
    },
    authorizeSavedProjection: (receipt, text) =>
      receipt.name === "operator_runs"
        ? read(receipt.name, receipt.args) === text
        : fallback.authorizeSavedProjection?.(receipt, text) ?? true,
    async authorize(receipt) {
      if (receipt.name !== "operator_runs") {
        return await fallback.authorize(receipt);
      }
      const text = read(receipt.name, receipt.args);
      return text !== undefined &&
        createHash("sha256").update(text).digest("hex") ===
          receipt.resultSha256;
    },
  };
}
