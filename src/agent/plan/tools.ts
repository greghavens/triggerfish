/**
 * Plan mode tool definitions.
 *
 * Defines the 3 plan tools available to the agent and the platform-level
 * system prompt section that introduces plan mode capabilities.
 *
 * Consolidated from 8 tools:
 * - plan_manage (action: enter, exit, approve, reject, complete, modify)
 * - plan_step_complete (kept separate — called frequently mid-plan)
 * - plan_status (kept separate — lightweight status check)
 *
 * @module
 */

import type { ToolDefinition } from "../../core/types/tool.ts";

function buildPlanManageDef(): ToolDefinition {
  return {
    name: "plan_manage",
    description:
      "Plan lifecycle management. Actions: enter, exit, approve, reject, complete, modify.\n" +
      "- enter: enter plan mode. Params: goal (required), scope?\n" +
      "- exit: present plan for approval. Params: plan (required, object)\n" +
      "- approve: approve pending plan. No extra params.\n" +
      "- reject: reject pending plan. No extra params.\n" +
      "- complete: mark plan as complete. Params: summary (required), deviations?\n" +
      "- modify: modify a plan step. Params: step_id (required), reason (required), new_description (required), new_files?, new_verification?",
    parameters: {
      action: {
        type: "string",
        description:
          "The operation: enter, exit, approve, reject, complete, modify",
        required: true,
      },
      goal: {
        type: "string",
        description: "What the agent is planning to build/change (enter)",
        required: false,
      },
      scope: {
        type: "string",
        description:
          "Constrain exploration to specific directories or modules (enter)",
        required: false,
      },
      plan: {
        type: "object",
        description:
          "Implementation plan object with summary, approach, steps, etc. (exit)",
        required: false,
      },
      summary: {
        type: "string",
        description: "What was accomplished (complete)",
        required: false,
      },
      deviations: {
        type: "array",
        description: "Changes from the original plan (complete)",
        required: false,
        items: { type: "string" },
      },
      step_id: {
        type: "number",
        description: "Which step to modify (modify)",
        required: false,
      },
      reason: {
        type: "string",
        description: "Why the change is needed (modify)",
        required: false,
      },
      new_description: {
        type: "string",
        description: "Updated step description (modify)",
        required: false,
      },
      new_files: {
        type: "array",
        description: "Updated file list (modify)",
        required: false,
        items: { type: "string" },
      },
      new_verification: {
        type: "string",
        description: "Updated verification command (modify)",
        required: false,
      },
    },
  };
}

function buildPlanStepCompleteDef(): ToolDefinition {
  return {
    name: "plan_step_complete",
    description:
      "Mark a plan step as complete during execution of an approved plan.",
    parameters: {
      step_id: {
        type: "number",
        description: "The step ID to mark as complete",
        required: true,
      },
      verification_result: {
        type: "string",
        description: "Output from the verification command",
        required: true,
      },
    },
  };
}

function buildPlanStatusDef(): ToolDefinition {
  return {
    name: "plan_status",
    description:
      "Returns current plan mode state: mode, goal, active plan progress.",
    parameters: {},
  };
}

/** Tool definitions for plan mode tools. */
export function buildPlanToolDefinitions(): readonly ToolDefinition[] {
  return [
    buildPlanManageDef(),
    buildPlanStepCompleteDef(),
    buildPlanStatusDef(),
  ];
}

/**
 * Platform-level system prompt section for plan mode.
 *
 * Appended AFTER SPINE.md + tool definitions, alongside TODO_SYSTEM_PROMPT.
 * Briefly describes plan mode availability so the agent knows when to use it.
 */
export const PLAN_SYSTEM_PROMPT = `## Plan Mode

You have access to plan mode tools for structured planning before implementation:
- \`plan_manage\`: action = enter | exit | approve | reject | complete | modify
- \`plan_step_complete\`: mark individual steps as done
- \`plan_status\`: check current plan state

When the user asks you to **build, implement, create, refactor, or redesign** code or infrastructure:
- Consider entering plan mode first with plan_manage(action: "enter", goal: "...")
- Explore the codebase thoroughly before proposing changes
- Present a concrete plan via plan_manage(action: "exit", plan: {...}) for user approval
- After approval, execute step by step, marking progress with plan_step_complete

Do NOT use plan mode for: research, lookups, questions, analysis, reports, skill-driven tasks, or anything that is not code/infrastructure implementation. For simple tasks (fix a typo, add a comment, rename), skip plan mode and just do it.`;

/** @deprecated Use buildPlanToolDefinitions instead */
export const getPlanToolDefinitions = buildPlanToolDefinitions;
