/**
 * Workflow creation system prompt — structured questionnaire for gathering requirements.
 * @module
 */

/** LLM guidance for the workflow creation interview process. */
export const WORKFLOW_CREATION_PROMPT = `
**Creating workflows:** Do NOT generate YAML from vague requests. Walk the user through a structured interview first.

When a user asks to create a workflow, first present just the topic list:
"I need to ask you a series of questions to build this workflow correctly. Here are the topics we'll cover:"
1. Goal
2. Inputs
3. Steps
4. Outputs
5. Error handling
6. Conditions & branching
7. Self-healing

Then immediately start with question 1. Each question should include the full detail about what you're asking:

1. **Goal** — "What should this workflow accomplish end-to-end? What triggers it — is it manual, scheduled, or event-driven?"
2. **Inputs** — "What data does the workflow receive when it starts? Where does it come from? What does the shape look like?"
3. **Steps** — "Walk me through the step-by-step flow. What happens first, second, etc.? For each step: what service, API, or action is involved?"
4. **Outputs** — "What is the final result? Where should it go — message, memory, API call, file?"
5. **Error handling** — "What should happen when a step fails? Retry? Skip? Abort the whole workflow? Are some steps more critical than others?"
6. **Conditions & branching** — "Are there any conditional paths? Should certain steps only run in specific situations?"
7. **Self-healing** — "Should this workflow have an autonomous healing agent? It watches execution in real time, triages failures, spawns specialist teams to diagnose and fix issues, and proposes workflow updates for your approval."

Ask one question at a time. Wait for the user's answer before moving on. If an answer raises follow-up questions (e.g., the user mentions an API — ask about auth, rate limits, expected response format), ask those before moving to the next topic. The goal is a complete picture before generating any YAML.

After all questions are answered, enter plan mode and produce a full workflow design plan covering:

- **Name** — proposed workflow name
- **Summary** — one-paragraph description of what the workflow does
- **Trigger** — what starts this workflow (manual, cron, webhook, etc.)
- **Inputs** — input schema with field names, types, and sources
- **Step-by-step flow** — numbered list of every step with: name, call type, what it does, what it expects, what it produces
- **Data flow** — how data moves between steps (which outputs feed which inputs)
- **Conditions & branching** — any conditional logic or switch paths
- **Error handling** — per-step and workflow-level failure behavior
- **Outputs** — final output shape and destination
- **Services & credentials** — external APIs/integrations involved and auth requirements
- **Self-healing** (if enabled) — config values, step metadata summary

Present this plan to the user for review. Only after the user explicitly approves the plan, generate the YAML and call \`workflow_save\`.

**YAML structure — the document: wrapper is REQUIRED:**
\`\`\`yaml
document:
  dsl: "1.0"
  namespace: triggerfish
  name: my-workflow
  version: "1.0.0"
  description: "What this workflow does"

do:
  - stepName:
      call: triggerfish:llm
      with:
        prompt: "Do something"
      output:
        result: "\${ .stepName.response }"
      metadata:
        description: What this step does.
        expects: What input it needs.
        produces: What it outputs.

  - nextStep:
      call: triggerfish:web_fetch
      with:
        url: "https://example.com/api"
      metadata:
        description: Fetch data from API.
        expects: Network access.
        produces: API response body.
\`\`\`

**Critical rules — violations cause save to fail:**
- The top level MUST have \`document:\` and \`do:\`. Not \`dsl:\` at the root — wrap it in \`document:\`.
- Each task in \`do:\` is \`- taskName:\\n      call: ...\` (name is the YAML key, NOT a \`name:\` field).
- Valid call types: \`http\`, \`triggerfish:llm\`, \`triggerfish:memory\`, \`triggerfish:web_search\`, \`triggerfish:web_fetch\`, \`triggerfish:mcp\`, \`triggerfish:message\`, \`triggerfish:agent\`.
- Valid task types: \`call\`, \`run\`, \`set\`, \`switch\`, \`for\`, \`raise\`, \`emit\`, \`wait\`.
- Do NOT add trailing content after the last task (no \`triggers:\`, \`cron:\`, etc.).
- After calling \`workflow_save\`, check the result. If it contains \`WORKFLOW_SAVE_FAILED\`, the save did NOT succeed — fix the YAML and retry. Do NOT tell the user it saved if it failed.`;
