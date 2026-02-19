/**
 * YAML parser for CNCF Serverless Workflow DSL 1.0.
 *
 * Parses and validates workflow YAML, extracts Triggerfish metadata,
 * and auto-detects non-deterministic tasks for the approvalRequired flag.
 *
 * @module
 */

import { parse as parseYaml } from "@std/yaml";
import type { Result, ClassificationLevel } from "../core/types/classification.ts";
import { parseClassification } from "../core/types/classification.ts";
import type {
  WorkflowDefinition,
  TaskNode,
  CallTask,
  RunTask,
  ForTask,
  SwitchCase,
  RaiseTask,
  EmitTask,
  ListenTask,
  WorkflowInput,
  WorkflowOutput,
  WorkflowResources,
  InputTransform,
  OutputTransform,
  ExportTransform,
} from "./types.ts";

/** Non-deterministic call types that trigger approvalRequired. */
const NON_DETERMINISTIC_CALL_TYPES = new Set([
  "triggerfish:llm",
  "triggerfish:agent",
]);

/**
 * Recursively scan task nodes for non-deterministic call types.
 */
function detectNonDeterministicTasks(tasks: readonly unknown[]): boolean {
  for (const raw of tasks) {
    if (!raw || typeof raw !== "object") continue;
    const task = raw as Record<string, unknown>;

    // Check all values of the task (task name is the key, task body is the value)
    for (const [_key, value] of Object.entries(task)) {
      if (!value || typeof value !== "object") continue;
      const body = value as Record<string, unknown>;

      // Check call type
      if (typeof body.call === "string") {
        if (NON_DETERMINISTIC_CALL_TYPES.has(body.call)) return true;
      }

      // Recurse into for-loop's do block
      if (body.for && typeof body.for === "object") {
        const forBlock = body.for as Record<string, unknown>;
        if (Array.isArray(forBlock.do)) {
          if (detectNonDeterministicTasks(forBlock.do)) return true;
        }
      }

      // Recurse into run:workflow sub-task (check its tasks if inlined)
      if (body.run && typeof body.run === "object") {
        const runBlock = body.run as Record<string, unknown>;
        if (Array.isArray(runBlock.do)) {
          if (detectNonDeterministicTasks(runBlock.do)) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Parse a raw task from YAML into a TaskNode.
 *
 * CNCF DSL uses named map entries: each array element is an object
 * with exactly one key (the task name), whose value contains the task body.
 */
function parseTask(raw: unknown): Result<TaskNode, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Task must be a YAML mapping object" };
  }

  const taskObj = raw as Record<string, unknown>;
  const entries = Object.entries(taskObj);
  if (entries.length !== 1) {
    return {
      ok: false,
      error: `Task must have exactly one name key, found: ${entries.map(([k]) => k).join(", ")}`,
    };
  }

  const [taskName, taskBody] = entries[0];

  if (!taskBody || typeof taskBody !== "object" || Array.isArray(taskBody)) {
    return { ok: false, error: `Task "${taskName}" body must be a YAML mapping` };
  }

  const body = taskBody as Record<string, unknown>;

  // Count how many task-type keys are present
  const taskTypeKeys = ["call", "run", "set", "switch", "for", "raise", "emit", "listen", "wait"];
  const presentTypes = taskTypeKeys.filter((k) => k in body);

  if (presentTypes.length === 0) {
    // `wait` can also be the value directly (per CNCF spec)
    // Some tasks may have no task type if they are pure flow control — allow it
  }
  if (presentTypes.length > 1) {
    return {
      ok: false,
      error: `Task "${taskName}" has multiple task type keys: ${presentTypes.join(", ")}`,
    };
  }

  const node: TaskNode = {
    name: taskName,
    ...(body.call !== undefined ? { call: parseCallTask(body.call) } : {}),
    ...(body.run !== undefined ? { run: parseRunTask(body.run) } : {}),
    ...(body.set !== undefined ? { set: body.set as Record<string, unknown> } : {}),
    ...(body.switch !== undefined ? { switch: parseSwitchCases(body.switch) } : {}),
    ...(body.for !== undefined ? { for: parseForTask(body.for) } : {}),
    ...(body.raise !== undefined ? { raise: body.raise as RaiseTask } : {}),
    ...(body.emit !== undefined ? { emit: body.emit as EmitTask } : {}),
    ...(body.listen !== undefined ? { listen: body.listen as ListenTask } : {}),
    ...(body.wait !== undefined ? { wait: String(body.wait) } : {}),
    ...(body.if !== undefined ? { if: String(body.if) } : {}),
    ...(body.input !== undefined ? { input: body.input as InputTransform } : {}),
    ...(body.output !== undefined ? { output: body.output as OutputTransform } : {}),
    ...(body.export !== undefined ? { export: body.export as ExportTransform } : {}),
    ...(body.timeout !== undefined ? { timeout: String(body.timeout) } : {}),
    ...(body.then !== undefined ? { then: String(body.then) as string } : {}),
    ...(body.metadata !== undefined ? { metadata: body.metadata as Record<string, unknown> } : {}),
  };

  return { ok: true, value: node };
}

function parseCallTask(raw: unknown): CallTask {
  if (typeof raw === "string") {
    return { type: raw, with: {} };
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      type: typeof obj.type === "string" ? obj.type : "http",
      with: (obj.with as Record<string, unknown>) ?? {},
      ...(obj.retry !== undefined ? { retry: obj.retry as string } : {}),
    };
  }
  return { type: "http", with: {} };
}

function parseRunTask(raw: unknown): RunTask {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    return {
      type: (obj.type as "container" | "script" | "shell" | "workflow") ?? "shell",
      with: (obj.with as Record<string, unknown>) ?? {},
    };
  }
  return { type: "shell", with: {} };
}

function parseSwitchCases(raw: unknown): readonly SwitchCase[] {
  if (!Array.isArray(raw)) return [];
  const cases: SwitchCase[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    // Each switch case is a named map entry
    const entries = Object.entries(obj);
    for (const [name, caseBody] of entries) {
      if (caseBody && typeof caseBody === "object") {
        const cb = caseBody as Record<string, unknown>;
        cases.push({
          name,
          ...(cb.when !== undefined ? { when: String(cb.when) } : {}),
          then: String(cb.then ?? "continue") as string,
        });
      }
    }
  }
  return cases;
}

function parseForTask(raw: unknown): ForTask {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const doTasks: TaskNode[] = [];
    if (Array.isArray(obj.do)) {
      for (const t of obj.do) {
        const result = parseTask(t);
        if (result.ok) doTasks.push(result.value);
      }
    }
    return {
      each: typeof obj.each === "string" ? obj.each : "item",
      in: typeof obj.in === "string" ? obj.in : "${ .items }",
      ...(obj.at !== undefined ? { at: String(obj.at) } : {}),
      do: doTasks,
    };
  }
  return { each: "item", in: "${ .items }", do: [] };
}

/**
 * Extract Triggerfish metadata from `metadata.triggerfish` block.
 */
function extractTriggerfish(metadata: unknown): {
  classificationCeiling?: ClassificationLevel;
  requiresTools: readonly string[];
  networkDomains: readonly string[];
  tags: readonly string[];
} {
  const defaults = { requiresTools: [], networkDomains: [], tags: [] };

  if (!metadata || typeof metadata !== "object") return defaults;
  const meta = metadata as Record<string, unknown>;

  if (!meta.triggerfish || typeof meta.triggerfish !== "object") return defaults;
  const tf = meta.triggerfish as Record<string, unknown>;

  let classificationCeiling: ClassificationLevel | undefined;
  if (typeof tf.classification_ceiling === "string") {
    const parsed = parseClassification(tf.classification_ceiling.toUpperCase());
    if (parsed.ok) classificationCeiling = parsed.value;
  }

  const requiresTools = Array.isArray(tf.requires_tools)
    ? tf.requires_tools.filter((t): t is string => typeof t === "string")
    : [];

  const networkDomains = Array.isArray(tf.network_domains)
    ? tf.network_domains.filter((d): d is string => typeof d === "string")
    : [];

  const tags = Array.isArray(tf.tags)
    ? tf.tags.filter((t): t is string => typeof t === "string")
    : [];

  return {
    ...(classificationCeiling !== undefined ? { classificationCeiling } : {}),
    requiresTools,
    networkDomains,
    tags,
  };
}

/**
 * Parse and validate a YAML workflow definition string.
 *
 * Returns a Result<WorkflowDefinition, string> — never throws.
 */
export function parseWorkflowYaml(yaml: string): Result<WorkflowDefinition, string> {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (err) {
    return { ok: false, error: `YAML parse error: ${(err as Error).message}` };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Workflow must be a YAML mapping object" };
  }

  const obj = raw as Record<string, unknown>;

  // CNCF spec puts all fields under `document` — support both with and without wrapper
  const doc = (obj.document && typeof obj.document === "object" && !Array.isArray(obj.document))
    ? obj.document as Record<string, unknown>
    : obj;

  // Required: dsl
  if (typeof doc.dsl !== "string" || !doc.dsl.startsWith("1.0")) {
    return {
      ok: false,
      error: `Missing or invalid 'dsl' field. Expected DSL version starting with '1.0', got: ${JSON.stringify(doc.dsl)}`,
    };
  }

  // Required: name
  if (typeof doc.name !== "string" || doc.name.length === 0) {
    return { ok: false, error: "Missing required 'name' field" };
  }

  // Required: do
  if (!Array.isArray(doc.do) || doc.do.length === 0) {
    return { ok: false, error: "Missing or empty 'do' task list" };
  }

  // Parse all tasks
  const tasks: TaskNode[] = [];
  for (let i = 0; i < doc.do.length; i++) {
    const result = parseTask(doc.do[i]);
    if (!result.ok) {
      return { ok: false, error: `Task ${i}: ${result.error}` };
    }
    tasks.push(result.value);
  }

  // Extract Triggerfish metadata
  const meta = extractTriggerfish(doc.metadata);

  // Auto-detect approvalRequired
  const approvalRequired = detectNonDeterministicTasks(doc.do as unknown[]);

  const definition: WorkflowDefinition = {
    dsl: doc.dsl,
    namespace: typeof doc.namespace === "string" ? doc.namespace : "default",
    name: doc.name,
    version: typeof doc.version === "string" ? doc.version : "1.0.0",
    ...(typeof doc.description === "string" ? { description: doc.description } : {}),
    ...(doc.input ? { input: doc.input as WorkflowInput } : {}),
    ...(doc.output ? { output: doc.output as WorkflowOutput } : {}),
    do: tasks,
    ...(doc.use ? { use: doc.use as WorkflowResources } : {}),
    ...(doc.timeout !== undefined ? { timeout: String(doc.timeout) } : {}),
    ...(meta.classificationCeiling !== undefined
      ? { classificationCeiling: meta.classificationCeiling }
      : {}),
    requiresTools: meta.requiresTools,
    networkDomains: meta.networkDomains,
    tags: meta.tags,
    approvalRequired,
  };

  return { ok: true, value: definition };
}
