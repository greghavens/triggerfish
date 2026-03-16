/**
 * Task-level validators for CNCF Serverless Workflow DSL 1.0.
 *
 * Each function validates and parses a single task type from raw YAML
 * into its typed representation. Used by the top-level parser.
 * @module
 */

import type {
  EmitTask,
  ForTask,
  RaiseTask,
  RunTask,
  SetTask,
  SwitchTask,
  TaskBase,
  WaitTask,
  WorkflowTaskEntry,
} from "./types.ts";
import { err, isRecord, ok, type ParseResult } from "./parser.ts";

/** Validate and parse a set task. */
export function enforceSetTaskSchema(
  raw: Record<string, unknown>,
  base: TaskBase,
  context: string,
): ParseResult<SetTask> {
  const set = raw["set"];
  if (!isRecord(set)) {
    return err(`${context}: 'set' must be an object of key-value pairs`);
  }

  return ok({
    ...base,
    type: "set" as const,
    set: set as Readonly<Record<string, unknown>>,
  });
}

/** Validate and parse a switch task. */
export function enforceSwitchTaskSchema(
  raw: Record<string, unknown>,
  base: TaskBase,
  context: string,
): ParseResult<SwitchTask> {
  const sw = raw["switch"];
  if (!Array.isArray(sw)) {
    return err(`${context}: 'switch' must be an array of case entries`);
  }

  const cases: { name: string; when?: string; then: string }[] = [];
  for (let i = 0; i < sw.length; i++) {
    const entry = sw[i];
    if (!isRecord(entry)) {
      return err(`${context}: switch case ${i} must be an object`);
    }
    const keys = Object.keys(entry);
    if (keys.length !== 1) {
      return err(
        `${context}: switch case ${i} must have exactly one key (the case name)`,
      );
    }
    const caseName = keys[0];
    const caseDef = entry[caseName];
    if (!isRecord(caseDef)) {
      return err(`${context}: switch case '${caseName}' must be an object`);
    }
    if (typeof caseDef["then"] !== "string") {
      return err(
        `${context}: switch case '${caseName}' must have a 'then' string`,
      );
    }
    cases.push({
      name: caseName,
      when: typeof caseDef["when"] === "string" ? caseDef["when"] : undefined,
      then: caseDef["then"] as string,
    });
  }

  return ok({
    ...base,
    type: "switch" as const,
    switch: cases,
  });
}

/** Validate and parse a raise task. */
export function enforceRaiseTaskSchema(
  raw: Record<string, unknown>,
  base: TaskBase,
  context: string,
): ParseResult<RaiseTask> {
  const raise = raw["raise"];
  if (!isRecord(raise)) {
    return err(`${context}: 'raise' must be an object with 'error'`);
  }
  const error = raise["error"];
  if (!isRecord(error)) {
    return err(`${context}: raise.error must be an object`);
  }
  if (typeof error["status"] !== "number") {
    return err(`${context}: raise.error.status must be a number`);
  }
  if (typeof error["type"] !== "string") {
    return err(`${context}: raise.error.type must be a string`);
  }
  if (typeof error["title"] !== "string") {
    return err(`${context}: raise.error.title must be a string`);
  }

  return ok({
    ...base,
    type: "raise" as const,
    raise: {
      error: {
        status: error["status"] as number,
        type: error["type"] as string,
        title: error["title"] as string,
        detail: typeof error["detail"] === "string"
          ? error["detail"]
          : undefined,
      },
    },
  });
}

/** Validate and parse an emit task. */
export function enforceEmitTaskSchema(
  raw: Record<string, unknown>,
  base: TaskBase,
  context: string,
): ParseResult<EmitTask> {
  const emit = raw["emit"];
  if (!isRecord(emit)) {
    return err(`${context}: 'emit' must be an object with 'event'`);
  }
  const event = emit["event"];
  if (!isRecord(event)) {
    return err(`${context}: emit.event must be an object`);
  }
  if (typeof event["type"] !== "string") {
    return err(`${context}: emit.event.type must be a string`);
  }

  return ok({
    ...base,
    type: "emit" as const,
    emit: {
      event: {
        type: event["type"] as string,
        source: typeof event["source"] === "string"
          ? event["source"]
          : undefined,
        data: isRecord(event["data"])
          ? (event["data"] as Readonly<Record<string, unknown>>)
          : undefined,
      },
    },
  });
}

/** Validate and parse a run task. */
export function enforceRunTaskSchema(
  raw: Record<string, unknown>,
  base: TaskBase,
  context: string,
): ParseResult<RunTask> {
  const run = raw["run"];
  if (!isRecord(run)) {
    return err(
      `${context}: 'run' must be an object with shell, script, or workflow`,
    );
  }

  if ("shell" in run) {
    const shell = run["shell"];
    if (!isRecord(shell) || typeof shell["command"] !== "string") {
      return err(`${context}: run.shell must have a 'command' string`);
    }
    return ok({
      ...base,
      type: "run" as const,
      run: {
        shell: {
          command: shell["command"] as string,
          arguments: isRecord(shell["arguments"])
            ? (shell["arguments"] as Readonly<Record<string, string>>)
            : undefined,
          environment: isRecord(shell["environment"])
            ? (shell["environment"] as Readonly<Record<string, string>>)
            : undefined,
        },
      },
    });
  }

  if ("script" in run) {
    const script = run["script"];
    if (
      !isRecord(script) || typeof script["language"] !== "string" ||
      typeof script["code"] !== "string"
    ) {
      return err(
        `${context}: run.script must have 'language' and 'code' strings`,
      );
    }
    return ok({
      ...base,
      type: "run" as const,
      run: {
        script: {
          language: script["language"] as string,
          code: script["code"] as string,
          arguments: isRecord(script["arguments"])
            ? (script["arguments"] as Readonly<Record<string, string>>)
            : undefined,
        },
      },
    });
  }

  if ("workflow" in run) {
    const wf = run["workflow"];
    if (!isRecord(wf) || typeof wf["name"] !== "string") {
      return err(`${context}: run.workflow must have a 'name' string`);
    }
    return ok({
      ...base,
      type: "run" as const,
      run: {
        workflow: {
          name: wf["name"] as string,
          version: typeof wf["version"] === "string"
            ? wf["version"]
            : undefined,
          input: isRecord(wf["input"])
            ? (wf["input"] as Readonly<Record<string, unknown>>)
            : undefined,
        },
      },
    });
  }

  return err(
    `${context}: run task must have 'shell', 'script', or 'workflow' target`,
  );
}

/** Validate and parse a for-loop task. */
export function enforceForTaskSchema(
  raw: Record<string, unknown>,
  base: TaskBase,
  context: string,
  validateDoBlock: (
    raw: unknown,
    ctx: string,
  ) => ParseResult<readonly WorkflowTaskEntry[]>,
): ParseResult<ForTask> {
  const forDef = raw["for"];
  if (!isRecord(forDef)) {
    return err(`${context}: 'for' must be an object with 'each' and 'in'`);
  }
  if (typeof forDef["each"] !== "string") {
    return err(`${context}: for.each must be a string (variable name)`);
  }
  if (typeof forDef["in"] !== "string") {
    return err(
      `${context}: for.in must be a string (expression referencing a collection)`,
    );
  }
  const doResult = validateDoBlock(raw["do"], `${context}.for`);
  if (!doResult.ok) return doResult;
  return ok({
    ...base,
    type: "for" as const,
    for: {
      each: forDef["each"] as string,
      in: forDef["in"] as string,
      at: typeof forDef["at"] === "string" ? forDef["at"] : undefined,
    },
    do: doResult.value,
  });
}

/** Validate and parse a wait task. */
export function enforceWaitTaskSchema(
  raw: Record<string, unknown>,
  base: TaskBase,
): ParseResult<WaitTask> {
  if (typeof raw["wait"] !== "string") {
    return err("Wait task requires a duration string (e.g., 'PT5S')");
  }
  return ok({ ...base, type: "wait" as const, wait: raw["wait"] as string });
}

// --- Deprecated aliases ---

/** @deprecated Use enforceSetTaskSchema instead */
export const validateSetTask = enforceSetTaskSchema;

/** @deprecated Use enforceSwitchTaskSchema instead */
export const validateSwitchTask = enforceSwitchTaskSchema;

/** @deprecated Use enforceRaiseTaskSchema instead */
export const validateRaiseTask = enforceRaiseTaskSchema;

/** @deprecated Use enforceEmitTaskSchema instead */
export const validateEmitTask = enforceEmitTaskSchema;

/** @deprecated Use enforceRunTaskSchema instead */
export const validateRunTask = enforceRunTaskSchema;

/** @deprecated Use enforceForTaskSchema instead */
export const validateForTask = enforceForTaskSchema;

/** @deprecated Use enforceWaitTaskSchema instead */
export const validateWaitTask = enforceWaitTaskSchema;
