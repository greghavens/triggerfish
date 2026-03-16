/**
 * Team tool definitions and system prompt.
 *
 * Declares the four agent-facing tools (team_create, team_status,
 * team_disband, team_message) and the system prompt section that
 * explains team capabilities to the LLM.
 *
 * @module
 */

import type { ToolDefinition } from "../../core/types/tool.ts";
import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { SessionId } from "../../core/types/session.ts";
import type { TeamManager } from "./manager.ts";

// ─── Tool context ────────────────────────────────────────────────────────────

/** Context required by team tool executors. */
export interface TeamToolContext {
  /** The team manager instance. */
  readonly teamManager: TeamManager;
  /** The caller's session ID (injected, not from LLM). */
  readonly callerSessionId: SessionId;
  /** Live taint getter for the caller session. */
  readonly getCallerTaint?: () => ClassificationLevel;
}

// ─── Tool definitions ────────────────────────────────────────────────────────

function buildTeamCreateDef(): ToolDefinition {
  return {
    name: "team_create",
    description:
      "Create a persistent team of agents that collaborate on a task. " +
      "Define member roles, tools, and models. One member must be the lead.",
    parameters: {
      name: {
        type: "string",
        description: "Team name",
        required: true,
      },
      task: {
        type: "string",
        description: "The team's objective",
        required: true,
      },
      members: {
        type: "array",
        description: "Team member definitions",
        required: true,
        items: {
          type: "object",
          properties: {
            role: { type: "string", description: "Role identifier" },
            description: {
              type: "string",
              description: "What this member does",
            },
            is_lead: {
              type: "boolean",
              description: "Whether this is the team lead",
            },
            model: { type: "string", description: "Model override (optional)" },
            classification_ceiling: {
              type: "string",
              description: "Max classification (optional)",
            },
            initial_task: {
              type: "string",
              description: "Initial instructions (optional)",
            },
          },
        },
      },
      idle_timeout_seconds: {
        type: "number",
        description: "Per-member idle timeout. Default 300.",
      },
      max_lifetime_seconds: {
        type: "number",
        description: "Team lifetime limit. Default 3600.",
      },
      classification_ceiling: {
        type: "string",
        description: "Team-wide classification ceiling (optional)",
      },
    },
  };
}

function buildTeamStatusDef(): ToolDefinition {
  return {
    name: "team_status",
    description: "Check the current state of an active team.",
    parameters: {
      team_id: {
        type: "string",
        description: "Team ID",
        required: true,
      },
    },
  };
}

function buildTeamDisbandDef(): ToolDefinition {
  return {
    name: "team_disband",
    description:
      "Disband an active team. Only the team lead or the session that " +
      "created the team can disband it.",
    parameters: {
      team_id: {
        type: "string",
        description: "Team ID",
        required: true,
      },
      reason: {
        type: "string",
        description: "Why the team is being disbanded (optional)",
      },
    },
  };
}

function buildTeamMessageDef(): ToolDefinition {
  return {
    name: "team_message",
    description: "Send a message to a team member from outside the team. " +
      "Useful for providing additional context, redirecting work, or asking for updates.",
    parameters: {
      team_id: {
        type: "string",
        description: "Team ID",
        required: true,
      },
      role: {
        type: "string",
        description: "Target member role. Defaults to lead.",
      },
      message: {
        type: "string",
        description: "Message content",
        required: true,
      },
    },
  };
}

/** Get all team tool definitions. */
export function buildTeamToolDefinitions(): readonly ToolDefinition[] {
  return [
    buildTeamCreateDef(),
    buildTeamStatusDef(),
    buildTeamDisbandDef(),
    buildTeamMessageDef(),
  ];
}

// ─── Tool names ──────────────────────────────────────────────────────────────

/** @deprecated Use buildTeamToolDefinitions instead */
export const getTeamToolDefinitions = buildTeamToolDefinitions;

/** All team tool names recognized by the executor. */
export const TEAM_TOOL_NAMES = new Set([
  "team_create",
  "team_status",
  "team_disband",
  "team_message",
]);

// ─── System prompt ───────────────────────────────────────────────────────────

/** System prompt section explaining team tools to the LLM. */
export const TEAM_SYSTEM_PROMPT = `## Agent Teams

You can create persistent teams of collaborating agents using team_create.
Each team member gets its own session, role, and tools. One member is the lead
who coordinates the work and decides when the team is done.

IMPORTANT: Do NOT call team_create until you have confirmed ALL of the following
with the user:
1. The specific problem/task the team will work on
2. The team name
3. The exact roles and which role is the lead
4. Classification level and timeout preferences (or confirm defaults are fine)

Each team member spawns a separate agent session that consumes resources. Never
create a team with placeholder or generic roles. Always gather the full
specification from the user first, then call team_create once with the correct
configuration.

- Use team_create to define roles and spawn the team
- Use team_status to check progress
- Use team_message to send instructions to a specific member
- Use team_disband to shut down the team

Team members communicate with each other via sessions_send. You do not need to
relay messages between them. Once created, the team operates autonomously until
the lead disbands it, the lifetime limit is reached, or you disband it manually.

Teams are best for open-ended tasks that benefit from specialized roles working
in parallel: research + analysis + writing, architecture + implementation + review,
or any task where different perspectives need to iterate on each other's work.`;
