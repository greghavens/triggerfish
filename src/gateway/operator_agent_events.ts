/** Reviewed owner admission for shared agent event subscriptions. */
import { readAgentProfile } from "../core/agent_profiles.ts";
import { canFlowTo } from "../core/types/classification.ts";
import {
  openAgentEventSchedule,
  parseAgentEventSubscription,
} from "../scheduler/agent_events.ts";
import { agentEventSchedulePath } from "../scheduler/service_agent_events.ts";
import type { OperatorRunToolContext } from "./operator_run_tool.ts";

export async function executeAgentEventAction(
  baseDir: string,
  args: Record<string, unknown>,
  context: OperatorRunToolContext | undefined,
  confirm: (message: string) => Promise<boolean>,
): Promise<string> {
  const unavailable = "Error: The agent event operation is unavailable.";
  const owner = context?.authenticatedOwnerSessionId;
  const authorize = context?.authorizeOwnerRunCall;
  if (
    !owner || !authorize || !canFlowTo("INTERNAL", context.ceiling ?? "PUBLIC")
  ) {
    return unavailable;
  }
  const path = agentEventSchedulePath(baseDir);
  const output = (value: object) =>
    JSON.stringify({ ...value, _classification: "INTERNAL" });
  const { action, id, subscriptionSettings, expectedVersion } = args;
  if (
    action === "agent_event_subscriptions" && Object.keys(args).length === 1
  ) {
    if (!(await authorize(args))) return unavailable;
    try {
      Deno.statSync(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return output({ subscriptions: [], deliveries: [] });
      }
      return unavailable;
    }
    const schedule = openAgentEventSchedule(path);
    try {
      return output({
        subscriptions: schedule.list(),
        deliveries: schedule.deliveries(),
      });
    } finally {
      schedule.close();
    }
  }
  if (action === "delete_agent_event_subscription") {
    if (
      Object.keys(args).length !== 3 ||
      typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(id) ||
      typeof expectedVersion !== "number" ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 1 || expectedVersion >= Number.MAX_SAFE_INTEGER ||
      !await authorize(args)
    ) return unavailable;
    const schedule = openAgentEventSchedule(path);
    try {
      const saved = schedule.deletion(id, expectedVersion);
      if (saved) return output({ saved });
      if (
        !schedule.list().some((row) =>
          row.subscription.id === id && row.version === expectedVersion
        )
      ) return unavailable;
      if (
        !await confirm(
          `Remove this exact agent event subscription?\n${
            JSON.stringify({ id, expectedVersion })
          }`,
        )
      ) {
        return "Error: The operator declined the run action.";
      }
      if (!await authorize(args)) return unavailable;
      const removed = schedule.remove(id, expectedVersion) ??
        schedule.deletion(id, expectedVersion);
      return removed ? output({ saved: removed }) : unavailable;
    } finally {
      schedule.close();
    }
  }
  const subscription = parseAgentEventSubscription(subscriptionSettings);
  const profile = subscription && readAgentProfile(baseDir, subscription.agent);
  if (
    action !== "set_agent_event_subscription" ||
    Object.keys(args).length !== 3 ||
    !canFlowTo(context.inputClassification ?? "INTERNAL", "INTERNAL") ||
    !subscription || profile?.definition?.role !== "event" ||
    typeof expectedVersion !== "number" ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0 || expectedVersion >= Number.MAX_SAFE_INTEGER
  ) return unavailable;
  const approved = await confirm(
    "Approve the exact agent event subscription? Its deliveries are bounded by the configured agent role and existing hooks.\n" +
      JSON.stringify({
        subscription,
        expectedVersion,
        agentVersion: profile.version,
      }),
  );
  if (!approved) return "Error: The operator declined the run action.";
  if (
    !(await authorize(args)) ||
    readAgentProfile(baseDir, subscription.agent)?.version !== profile.version
  ) return unavailable;
  const schedule = openAgentEventSchedule(path);
  try {
    const saved = schedule.set(subscription, expectedVersion);
    return saved ? output({ saved }) : unavailable;
  } finally {
    schedule.close();
  }
}
