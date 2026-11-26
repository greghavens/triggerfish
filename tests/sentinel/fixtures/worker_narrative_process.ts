import { join } from "@std/path";
import { createProviderRegistry } from "../../../src/agent/llm.ts";
import {
  createSentinelModelPlanner,
  readAdaptiveSentinel,
} from "../../../src/gateway/sentinel_adaptive_runtime.ts";
import { createSentinelSubagent } from "../../../src/gateway/sentinel_agent.ts";
import { readSentinelAssessment } from "../../../src/sentinel/assessment_store.ts";
import { resolveSentinelCasePath } from "../../../src/sentinel/cases.ts";
import { SENTINEL_WORKER_NARRATIVE_COMMIT } from "../../../src/sentinel/worker_narratives.ts";

const [baseDir, taskId, phase, clock, count] = Deno.args;
const publications = Number(count);
const summaries = [
  "The retained inventory check needs review.",
  "The retained inventory check has an unresolved owner.",
];
const wallTime = Date.now;
if (clock) Date.now = () => Math.max(wallTime(), Number(clock));
const path = resolveSentinelCasePath(baseDir);
const state = readSentinelAssessment(path);
if (!state) throw new Error("Missing assessment fixture");

const registry = createProviderRegistry();
const tool = (name: string, args: object, step: number) => ({
  type: "function" as const,
  id: `${name}-${step}`,
  function: { name, arguments: JSON.stringify(args) },
});
const usage = { inputTokens: 1, outputTokens: 1 };
let denied = false;
registry.register({
  name: "narrative-crash-fixture",
  supportsStreaming: false,
  async complete(messages) {
    const results = messages.filter(({ role }) => role === "tool");
    if (phase === "interrupt") {
      const step = results.length;
      if (step >= publications * 2) {
        throw new Error("Expected publication interruption");
      }
      return {
        content: "",
        usage,
        toolCalls: step % 2 === 0
          ? [tool("sentinel_assigned_target", {}, step)]
          : [tool(SENTINEL_WORKER_NARRATIVE_COMMIT, {
            summary: summaries[(step - 1) / 2],
            confidence: "inferred",
            evidenceId: "retained-check",
          }, step)],
      };
    }
    if (phase !== "resume" || results.length !== publications * 2) {
      Deno.exit(74);
    }
    await Deno.writeTextFile(
      join(baseDir, "resumed-narrative"),
      JSON.stringify(results.map(({ content }) => JSON.parse(String(content)))),
    );
    return {
      content:
        '{"summary":"Reviewed the saved inventory observation.","followUps":[]}',
      usage,
      toolCalls: [],
    };
  },
});
registry.setDefault("narrative-crash-fixture");
const planner = createSentinelModelPlanner(
  path,
  (current, id, token) =>
    id !== taskId
      ? { execute: () => Promise.resolve(), clear() {} }
      : createSentinelSubagent({
        snapshotPath: path,
        assessmentRevision: current.revision,
        assignedTaskId: id,
        assignedTaskLeaseToken: token,
        providerRegistry: registry,
        allowModelAccess: true,
        hookRunner: {
          evaluateHook(hook, { input }) {
            if (
              phase === "interrupt" && hook === "POST_TOOL_RESPONSE" &&
              input.tool_name === SENTINEL_WORKER_NARRATIVE_COMMIT &&
              typeof input.tool_response === "string" &&
              JSON.parse(input.tool_response).receipt?.summary ===
                summaries[publications - 1]
            ) Deno.exit(73);
            if (
              phase === "deny" && hook === "PRE_TOOL_CALL" &&
              input.tool_name === "sentinel_provenance_node" &&
              input.case_id === "main"
            ) {
              denied = true;
              return Promise.resolve({
                allowed: false,
                action: "BLOCK",
                duration: 0,
                ruleId: null,
              });
            }
            return Promise.resolve({
              allowed: true,
              action: "ALLOW",
              duration: 0,
              ruleId: null,
            });
          },
        },
      }),
);
try {
  const until = wallTime() + 8000;
  while (wallTime() < until) {
    planner.advance(state);
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (!planner.hasInFlightWork()) {
      if (phase === "deny" && denied) break;
      const review = readAdaptiveSentinel(path, state, "revision")?.modelReviews
        .find((item) => item.taskId === taskId);
      if (phase === "resume" && review) break;
    }
  }
  if (phase !== "resume" && !denied) {
    throw new Error("Recovery did not reach source policy");
  }
  if (
    phase === "resume" &&
    !readAdaptiveSentinel(path, state, "revision")?.modelReviews
      .some((item) => item.taskId === taskId)
  ) {
    throw new Error("Recovered publication did not settle");
  }
} finally {
  planner.stop();
}
