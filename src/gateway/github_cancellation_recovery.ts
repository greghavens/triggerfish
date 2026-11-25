import { createHash } from "node:crypto";
/** Recovery for an approved cancellation of a single configured GitHub Actions run. */
import type { AgentRecoveryPolicy } from "../core/agent_recovery.ts";
import type { TriggerFishConfig } from "../core/config_types.ts";
import {
  canFlowTo,
  type ClassificationLevel,
} from "../core/types/classification.ts";
import type { GitHubWorkflowRunState } from "../integrations/github/types.ts";

type Target = NonNullable<
  NonNullable<TriggerFishConfig["agent_recovery"]>["github_cancel_runs"]
>[number];

export function withGitHubCancellationRecovery(
  fallback: AgentRecoveryPolicy,
  targets: readonly Target[],
  readState: (
    target: Target,
    signal?: AbortSignal,
  ) => Promise<GitHubWorkflowRunState | undefined>,
): AgentRecoveryPolicy {
  const cancellation = (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) =>
    name === "github_actions" && args.action === "cancel_run" &&
      (Object.keys(args).length === 3 || Object.keys(args).length === 5) &&
      targets.find((entry) =>
        entry.repo === args.repo && entry.run_id === args.run_id &&
        (Object.keys(args).length === 3 ||
          (args.repositoryId === entry.repository_id &&
            args.attempt === entry.attempt))
      ) || undefined;
  const projection = (target: Target, outcome: "accepted" | "cancelled") =>
    JSON.stringify({
      repositoryId: target.repository_id,
      runId: target.run_id,
      attempt: target.attempt,
      outcome,
    });
  async function checkedState(
    target: Target,
    ceiling: ClassificationLevel,
    signal?: AbortSignal,
  ) {
    const state = await readState(target, signal);
    return state && canFlowTo(state.classification, ceiling) &&
        state.repositoryId === target.repository_id &&
        state.id === target.run_id &&
        state.attempt === target.attempt
      ? state
      : undefined;
  }
  return {
    ...fallback,
    projectCall(call) {
      const target = cancellation(call.name, call.args);
      return target
        ? {
          action: "cancel_run",
          repo: target.repo,
          run_id: target.run_id,
          repositoryId: target.repository_id,
          attempt: target.attempt,
        }
        : fallback.projectCall(call);
    },
    canReconcile: (call) =>
      !!cancellation(call.name, call.args) || !!fallback.canReconcile?.(call),
    async authorizeDispatch(call, rule, signal) {
      const target = cancellation(call.name, call.args);
      if (!target) {
        return await fallback.authorizeDispatch?.(call, rule, signal) ?? true;
      }
      if (!rule) return false;
      const state = await checkedState(
        target,
        fallback.classification(),
        signal,
      );
      return !!state && state.status !== "completed" &&
        state.conclusion === null;
    },
    async reconcile(call, signal) {
      const target = cancellation(call.name, call.args);
      if (!target) return await fallback.reconcile?.(call, signal);
      if (!call.approvedRuleId) return;
      const state = await checkedState(target, call.classification, signal);
      if (state?.status === "completed" && state.conclusion === "cancelled") {
        return projection(target, "cancelled");
      }
    },
    projectResult(call, text) {
      const target = cancellation(call.name, call.args);
      if (!target) return fallback.projectResult(call, text);
      if (text === projection(target, "cancelled")) return text;
      try {
        const result = JSON.parse(text);
        if (result?.cancelled === true) return projection(target, "accepted");
      } catch {
        // An unconfirmed result cannot establish the outcome.
      }
    },
    resultResourceId: (text) =>
      JSON.parse(text).repositoryId ?? fallback.resultResourceId?.(text),
    authorizeSavedProjection(receipt, text) {
      const target = cancellation(receipt.name, receipt.args);
      return target
        ? text === projection(target, "accepted") ||
          text === projection(target, "cancelled")
        : fallback.authorizeSavedProjection?.(receipt, text) ?? true;
    },
    async authorize(receipt) {
      const target = cancellation(receipt.name, receipt.args);
      if (!target) return await fallback.authorize(receipt);
      if (
        !receipt.approvedRuleId || receipt.resourceId !== target.repository_id
      ) return false;
      const state = await checkedState(target, receipt.classification);
      if (!state) return false;
      const digest = (outcome: "accepted" | "cancelled") =>
        createHash("sha256").update(projection(target, outcome)).digest("hex");
      return receipt.resultSha256 === digest("accepted") ||
        (receipt.resultSha256 === digest("cancelled") &&
          state.status === "completed" && state.conclusion === "cancelled");
    },
  };
}
