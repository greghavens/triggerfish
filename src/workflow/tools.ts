/**
 * Workflow agent tools — 6 LLM-callable operations for workflow management.
 *
 * Registers workflow_run, workflow_list, workflow_get, workflow_save,
 * workflow_delete, workflow_history as agent tools.
 *
 * @module
 */

import type { ToolDefinition, ToolExecutor } from "../agent/orchestrator.ts";
import type { WorkflowEngine, WorkflowExecutionContext } from "./types.ts";

/** Tool definitions for the 6 workflow operations. */
export function getWorkflowToolDefinitions(): readonly ToolDefinition[] {
  return [
    {
      name: "workflow_save",
      description:
        "Save a YAML workflow definition. The workflow is stored at the current session " +
        "security level. Use CNCF Serverless Workflow DSL 1.0 format with Triggerfish extensions.",
      parameters: {
        yaml: {
          type: "string",
          description: "The YAML workflow definition string",
          required: true,
        },
      },
    },
    {
      name: "workflow_run",
      description:
        "Execute a saved workflow by name. Returns the execution result including " +
        "final status, taint level, task results, and output data.",
      parameters: {
        name: {
          type: "string",
          description: "The workflow name to execute",
          required: true,
        },
        input: {
          type: "object",
          description: "Input data for the workflow (JSON object)",
          required: false,
        },
      },
    },
    {
      name: "workflow_list",
      description:
        "List all available workflow definitions accessible at the current security level. " +
        "Returns workflow names, descriptions, versions, and tags.",
      parameters: {},
    },
    {
      name: "workflow_get",
      description:
        "Get a specific workflow definition by name. Returns the full YAML definition.",
      parameters: {
        name: {
          type: "string",
          description: "The workflow name to retrieve",
          required: true,
        },
      },
    },
    {
      name: "workflow_delete",
      description:
        "Delete a saved workflow by name. Only workflows at the current session taint " +
        "level can be deleted.",
      parameters: {
        name: {
          type: "string",
          description: "The workflow name to delete",
          required: true,
        },
      },
    },
    {
      name: "workflow_history",
      description:
        "Get execution history for a workflow. Returns past run results including " +
        "status, taint levels, and task outcomes. Filtered by current session security level.",
      parameters: {
        name: {
          type: "string",
          description: "The workflow name to get history for",
          required: true,
        },
        limit: {
          type: "number",
          description: "Maximum number of history entries to return (default: 10)",
          required: false,
        },
      },
    },
  ];
}

/**
 * Create a tool executor for workflow operations.
 *
 * Returns a handler that accepts tool name + args and returns a result string,
 * or null if the tool name is not a workflow tool (so callers can fall through).
 */
export function createWorkflowToolExecutor(
  engine: WorkflowEngine,
  context: WorkflowExecutionContext,
): (name: string, input: Record<string, unknown>) => Promise<string | null> {
  return async (
    name: string,
    input: Record<string, unknown>,
  ): Promise<string | null> => {
    switch (name) {
      case "workflow_save": {
        const yaml = input.yaml;
        if (typeof yaml !== "string" || yaml.length === 0) {
          return "Error: workflow_save requires a 'yaml' argument (non-empty string).";
        }

        const parseResult = engine.parse(yaml);
        if (!parseResult.ok) {
          return `Error: Invalid workflow YAML: ${parseResult.error}`;
        }

        const storeResult = await engine.store(
          parseResult.value,
          context.agentId,
          context.sessionTaint,
        );

        if (!storeResult.ok) {
          return `Error: Failed to save workflow: ${storeResult.error}`;
        }

        return JSON.stringify({
          saved: true,
          name: parseResult.value.name,
          version: parseResult.value.version,
          approvalRequired: parseResult.value.approvalRequired,
          classification: context.sessionTaint,
        });
      }

      case "workflow_run": {
        const workflowName = input.name;
        if (typeof workflowName !== "string" || workflowName.length === 0) {
          return "Error: workflow_run requires a 'name' argument.";
        }

        const definition = await engine.get(
          workflowName,
          context.agentId,
          context.sessionTaint,
        );

        if (!definition) {
          return `Error: Workflow "${workflowName}" not found or not accessible at current security level.`;
        }

        const workflowInput = (input.input && typeof input.input === "object" && !Array.isArray(input.input))
          ? input.input as Record<string, unknown>
          : {};

        const executionState = await engine.execute(definition, workflowInput, context);

        return JSON.stringify({
          runId: executionState.runId,
          status: executionState.status,
          taintAtStart: executionState.taintAtStart,
          taintFinal: executionState.taintCurrent,
          tasksRun: executionState.taskResults.length,
          tasksSucceeded: executionState.taskResults.filter((t) => t.status === "SUCCESS").length,
          tasksBlocked: executionState.taskResults.filter((t) => t.status === "BLOCKED").length,
          tasksFailed: executionState.taskResults.filter((t) => t.status === "FAILED").length,
          output: executionState.data,
          ...(executionState.error ? { error: executionState.error } : {}),
        });
      }

      case "workflow_list": {
        const workflows = await engine.list(context.agentId, context.sessionTaint);

        if (workflows.length === 0) {
          return "No workflows found.";
        }

        return JSON.stringify({
          workflows: workflows.map((w) => ({
            name: w.name,
            version: w.version,
            description: w.description,
            tags: w.tags,
            approvalRequired: w.approvalRequired,
            namespace: w.namespace,
          })),
        });
      }

      case "workflow_get": {
        const workflowName = input.name;
        if (typeof workflowName !== "string" || workflowName.length === 0) {
          return "Error: workflow_get requires a 'name' argument.";
        }

        const definition = await engine.get(
          workflowName,
          context.agentId,
          context.sessionTaint,
        );

        if (!definition) {
          return `Error: Workflow "${workflowName}" not found or not accessible at current security level.`;
        }

        return JSON.stringify(definition);
      }

      case "workflow_delete": {
        const workflowName = input.name;
        if (typeof workflowName !== "string" || workflowName.length === 0) {
          return "Error: workflow_delete requires a 'name' argument.";
        }

        const result = await engine.delete(
          workflowName,
          context.agentId,
          context.sessionTaint,
        );

        if (!result.ok) {
          return `Error: ${result.error}`;
        }

        return JSON.stringify({ deleted: true, name: workflowName });
      }

      case "workflow_history": {
        const workflowName = input.name;
        if (typeof workflowName !== "string" || workflowName.length === 0) {
          return "Error: workflow_history requires a 'name' argument.";
        }

        const limit = typeof input.limit === "number" ? input.limit : 10;

        const runs = await engine.history(
          workflowName,
          context.agentId,
          context.sessionTaint,
          limit,
        );

        if (runs.length === 0) {
          return `No execution history found for workflow "${workflowName}".`;
        }

        return JSON.stringify({
          workflow: workflowName,
          runs: runs.map((r) => ({
            runId: r.runId,
            status: r.status,
            startedAt: r.startedAt,
            completedAt: r.completedAt,
            taintAtStart: r.taintAtStart,
            taintFinal: r.taintCurrent,
            tasksRun: r.taskResults.length,
            ...(r.error ? { error: r.error } : {}),
          })),
        });
      }

      default:
        return null;
    }
  };
}

/** System prompt section for workflow tools. */
export const WORKFLOW_SYSTEM_PROMPT = `## Workflow Engine

You have access to a CNCF Serverless Workflow DSL 1.0 engine with 6 tools:

- **workflow_save** — Save a YAML workflow definition
- **workflow_run** — Execute a saved workflow with input data
- **workflow_list** — List all available workflows
- **workflow_get** — Get a workflow definition by name
- **workflow_delete** — Delete a workflow
- **workflow_history** — Get execution history for a workflow

### Workflow YAML Format

Workflows use CNCF Serverless Workflow DSL 1.0 with Triggerfish extensions in the \`metadata.triggerfish\` block:

\`\`\`yaml
document:
  dsl: "1.0.0"
  namespace: default
  name: my-workflow
  version: "1.0.0"
  metadata:
    triggerfish:
      requires_tools: [web_search, memory_save]
      tags: [automation]
do:
  - fetchData:
      call: triggerfish:web_search
      with:
        query: "latest news on AI"
      output:
        as: .searchResults

  - analyzeResults:
      call: triggerfish:llm
      with:
        task: |
          Analyze these search results: \${ .searchResults }
          Summarize the key findings.
      output:
        as: .analysis
\`\`\`

### Triggerfish Custom Call Types

- \`call: http\` — HTTP request (with.endpoint.uri, with.method)
- \`call: triggerfish:llm\` — LLM sub-agent (non-deterministic)
- \`call: triggerfish:memory\` — Memory CRUD (operation: save|search|get|list|delete)
- \`call: triggerfish:web_search\` — Web search (query, maxResults)
- \`call: triggerfish:web_fetch\` — Web fetch (url, maxLength)
- \`call: triggerfish:mcp\` — MCP tool call (server, tool, arguments)
- \`call: triggerfish:message\` — Send message (channel, recipient, text)
- \`run: shell\` — Shell command (with.command)
- \`set\` — Set workflow data variables

### Security Notes

- Classification ceiling (\`metadata.triggerfish.classification_ceiling: CONFIDENTIAL\`) halts workflow if taint exceeds the ceiling
- Workflows containing \`triggerfish:llm\` or \`triggerfish:agent\` have \`approvalRequired: true\`
- Workflow definitions are stored at current session taint level and only visible to sessions at that level or above`;
