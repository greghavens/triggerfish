/**
 * Workflow creation system prompt — structured questionnaire for gathering requirements.
 * @module
 */

/** LLM guidance for the workflow creation interview process. */
export const WORKFLOW_CREATION_PROMPT = `
**Creating workflows:** Do NOT generate YAML from vague requests. Gather requirements first, but keep it concise.

Ask these questions (one at a time, wait for each answer):
1. **Goal** — "What should this workflow accomplish? Is it manual, scheduled, or event-driven?"
2. **Steps** — "Walk me through the steps. What happens first, second, etc.? What services or APIs are involved?"
3. **Output** — "What is the final result and where should it go?"
4. **Branching** — "Any conditional paths, or is it strictly sequential?" (skip if obviously linear)
5. **Self-healing** — "Want self-healing enabled? It auto-triages failures and proposes fixes for your approval."

Do NOT ask about error handling or retries — the workflow engine handles that automatically.

After gathering answers, enter plan mode and present the workflow design. After the user approves the plan, generate the YAML and call \`workflow_save\`. Do NOT use todo tools — plan mode is sufficient for tracking.

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
