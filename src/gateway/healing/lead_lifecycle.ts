/**
 * Lead agent lifecycle — spawn, context bundling, and teardown.
 *
 * The lead agent is spawned at workflow execution start with a full
 * context bundle. It is torn down when the run completes.
 * @module
 */

import type { ClassificationLevel } from "../../core/types/classification.ts";
import type { SelfHealingConfig } from "../../core/types/healing.ts";
import type { SessionId } from "../../core/types/session.ts";
import type { WorkflowVersion } from "../../workflow/healing/types.ts";
import { createLogger } from "../../core/logger/logger.ts";

const log = createLogger("healing-lead-lifecycle");

/** Options for spawning a healing lead agent. */
export interface SpawnLeadOptions {
  /** The complete workflow definition YAML. */
  readonly workflowDefinition: string;
  /** The workflow name. */
  readonly workflowName: string;
  /** Run input data. */
  readonly runInput: Readonly<Record<string, unknown>>;
  /** The N most recent execution states from run history. */
  readonly runHistory: readonly Readonly<Record<string, unknown>>[];
  /** Most recent successful run (always included). */
  readonly lastSuccessfulRun?: Readonly<Record<string, unknown>>;
  /** REJECTED proposals from prior runs. */
  readonly rejectedProposals: readonly WorkflowVersion[];
  /** Self-healing configuration. */
  readonly config: SelfHealingConfig;
  /** Initial taint level (matches workflow execution taint). */
  readonly initialTaint: ClassificationLevel;
  /** Function to spawn a new agent session. */
  readonly spawnSession: (options: SpawnSessionOptions) => Promise<SessionId>;
  /** Function to tear down a session. */
  readonly terminateSession: (sessionId: SessionId) => Promise<void>;
}

/** Options for spawning a session. */
export interface SpawnSessionOptions {
  readonly systemPrompt: string;
  readonly taint: ClassificationLevel;
}

/** Handle for a spawned healing lead. */
export interface HealingLeadHandle {
  readonly sessionId: SessionId;
  readonly teardown: () => Promise<void>;
}

/** Spawn a healing lead agent with the full context bundle. */
export async function spawnHealingLead(
  options: SpawnLeadOptions,
): Promise<HealingLeadHandle> {
  const systemPrompt = buildLeadSystemPrompt(options);

  const sessionId = await options.spawnSession({
    systemPrompt,
    taint: options.initialTaint,
  });

  log.info("Healing lead agent spawned", {
    operation: "spawnHealingLead",
    workflowName: options.workflowName,
    sessionId,
    taint: options.initialTaint,
  });

  return {
    sessionId,
    teardown: async () => {
      await options.terminateSession(sessionId);
      log.info("Healing lead agent torn down", {
        operation: "teardownHealingLead",
        workflowName: options.workflowName,
        sessionId,
      });
    },
  };
}

/** Build the system prompt for the healing lead agent. */
function buildLeadSystemPrompt(options: SpawnLeadOptions): string {
  const sections: string[] = [
    buildRoleSection(),
    buildWorkflowSection(options),
    buildHistorySection(options),
    buildRejectedProposalsSection(options),
    buildConstraintsSection(options),
  ];

  return sections.join("\n\n");
}

function buildRoleSection(): string {
  return `# Self-Healing Workflow Lead Agent

You are the self-healing lead agent for a workflow execution. You observe
step-level events as the workflow runs and intervene when needed.

Your intervention categories:
1. **Transient retry** — Environmental failures (network, rate limits). Retry with backoff.
2. **Runtime workaround** — Alternative approach for this run only. Does not change the definition.
3. **Structural fix** — The definition is wrong or stale. Propose a new version.
4. **Plugin gap** — Integration/plugin is broken or missing. Author or update the plugin.
5. **Unresolvable** — Exhausted retry budget. Escalate with structured diagnosis.

You are a co-pilot, not a post-mortem investigator. You are present from the start.`;
}

function buildWorkflowSection(options: SpawnLeadOptions): string {
  return `## Workflow Definition

\`\`\`yaml
${options.workflowDefinition}
\`\`\`

**Run input:**
\`\`\`json
${JSON.stringify(options.runInput, null, 2)}
\`\`\``;
}

function buildHistorySection(options: SpawnLeadOptions): string {
  if (options.runHistory.length === 0 && !options.lastSuccessfulRun) {
    return "## Run History\n\nNo prior runs available.";
  }

  const parts = ["## Run History"];
  if (options.lastSuccessfulRun) {
    parts.push(
      `### Last Successful Run\n\`\`\`json\n${
        JSON.stringify(options.lastSuccessfulRun, null, 2)
      }\n\`\`\``,
    );
  }
  if (options.runHistory.length > 0) {
    parts.push(
      `### Recent Runs (${options.runHistory.length})\n\`\`\`json\n${
        JSON.stringify(options.runHistory, null, 2)
      }\n\`\`\``,
    );
  }
  return parts.join("\n\n");
}

function buildRejectedProposalsSection(options: SpawnLeadOptions): string {
  if (options.rejectedProposals.length === 0) {
    return "## Prior Rejected Proposals\n\nNone.";
  }

  const proposals = options.rejectedProposals.map((p) =>
    `- **v${p.versionNumber}** (${p.proposedAt}): ${p.authorReasoning} — Rejected by: ${
      p.resolvedBy ?? "unknown"
    }`
  ).join("\n");

  return `## Prior Rejected Proposals

Do NOT re-propose these unless you have new information justifying the change.

${proposals}`;
}

function buildConstraintsSection(options: SpawnLeadOptions): string {
  return `## Constraints

- Retry budget: ${options.config.retry_budget} attempts
- Approval required: ${options.config.approval_required}
- You CANNOT modify the \`metadata.triggerfish.self_healing\` config block
- All your tool calls pass through standard PRE_TOOL_CALL/POST_TOOL_RESPONSE hooks
- Plugin changes trigger PENDING_APPROVAL — no exceptions`;
}
