/**
 * Daemon management tool definition.
 *
 * Provides a `daemon_manage` tool for restarting and checking status
 * of the Triggerfish daemon. Restart requires out-of-band user approval
 * unless auto-approve is configured.
 *
 * @module
 */

import type { ToolDefinition } from "../../../core/types/tool.ts";

/** Build the daemon_manage tool definition. */
function buildDaemonManageDef(): ToolDefinition {
  return {
    name: "daemon_manage",
    description: "Daemon lifecycle management. Actions: restart, status.\n" +
      "- restart: restart the Triggerfish daemon to apply config changes. " +
      "Prompts user for approval unless auto-approve is configured.\n" +
      "- status: show daemon running state, PID, uptime, and manager type.",
    parameters: {
      action: {
        type: "string",
        description: "The operation: restart, status",
        required: true,
      },
      reason: {
        type: "string",
        description:
          "Why the restart is needed (restart only). Shown to the user in the approval prompt.",
        required: false,
      },
    },
  };
}

/** Get the daemon management tool definitions. */
export function getDaemonManageToolDefinitions(): readonly ToolDefinition[] {
  return [buildDaemonManageDef()];
}

/** System prompt section explaining daemon_manage to the LLM. */
export const DAEMON_MANAGE_SYSTEM_PROMPT = `## Daemon Management

Use \`daemon_manage\` to restart the Triggerfish daemon after configuration changes.

- \`action: "status"\` — check if daemon is running, PID, uptime
- \`action: "restart", reason: "Applied new channel configuration"\` — restart to apply config changes

**When to restart:** After any \`config_manage\` write action that returns \`restart_needed: true\`, call \`daemon_manage(action: "restart", reason: "...")\` to apply the changes. Always provide a reason explaining what changed.

The user will be prompted to approve the restart through a secure out-of-band prompt (not in chat). If they have configured \`daemon.auto_approve_restart: true\` in triggerfish.yaml, the restart proceeds automatically.

Restart after an approved MCP configuration change when \`mcp_manage\` returns \`restart_needed: true\`. The running daemon continues to use the previous connector configuration until it restarts.`;
