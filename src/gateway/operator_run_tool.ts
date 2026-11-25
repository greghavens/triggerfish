/** Owner-only root tool for exact Sentinel and admitted workflow runs. */
import { join } from "@std/path";
import {
  openOperatorRunLinkStore,
  OperatorRunController,
  type OperatorRunKind,
  type OperatorRunProvider,
  type OperatorRunRef,
  type OperatorRunSummary,
} from "../core/operator_runs.ts";
import type { ToolDefinition } from "../core/types/tool.ts";
import { resolveSentinelCasePath } from "../sentinel/cases.ts";
import {
  inspectSentinelProvenance,
  searchSentinelProvenance,
  searchSentinelWorkerTraces,
} from "./sentinel_agent.ts";
import { createOperatorSentinelRuns } from "./operator_sentinel_runs.ts";
import type {
  OperatorWorkflowRun,
  OperatorWorkflowRuns,
} from "./operator_workflow_runs.ts";

export const operatorRunTool: ToolDefinition = {
  name: "operator_runs",
  description:
    "List and inspect approved Sentinel and workflow runs. Request operator confirmation to start, link, pause, resume, or steer an exact assigned Sentinel worker.",
  parameters: {
    action: {
      type: "string",
      description: "Run operation",
      enum: [
        "list",
        "inspect",
        "start",
        "link",
        "pause",
        "resume",
        "steer",
        "hint",
        "profiles",
        "graph",
        "findings",
        "node",
        "traces",
      ],
      required: true,
    },
    kind: {
      type: "string",
      description: "Run type",
      enum: ["sentinel", "workflow"],
    },
    id: {
      type: "string",
      description: "Exact run, published case, or configured plan ID",
    },
    revision: {
      type: "integer",
      description: "Exact Sentinel evidence revision",
    },
    targetKind: {
      type: "string",
      description: "Linked run type",
      enum: ["sentinel", "workflow"],
    },
    targetId: { type: "string", description: "Exact linked run ID" },
    targetRevision: {
      type: "integer",
      description: "Exact linked Sentinel evidence revision",
    },
    requestId: {
      type: "string",
      description:
        "Stable request UUID for linking, starting workflows, or giving guidance",
    },
    taskId: {
      type: "string",
      description: "Exact active Sentinel assignment ID",
    },
    note: {
      type: "string",
      description: "Bounded assignment guidance or case-wide planner hint",
    },
    query: {
      type: "string",
      description: "Search text for graph records or worker history",
    },
    node: { type: "string", description: "Exact saved provenance node ID" },
    stepIndices: {
      type: "array",
      items: { type: "integer" },
      description: "Exact worker step indices for the selected assignment",
    },
    offset: { type: "integer", description: "Saved result offset" },
    limit: { type: "integer", description: "Bounded result page size" },
  },
};

export type OperatorRunToolExecutor = (
  args: Record<string, unknown>,
) => Promise<string>;

function kind(value: unknown): OperatorRunKind | undefined {
  return value === "sentinel" || value === "workflow" ? value : undefined;
}

function reference(
  type: unknown,
  id: unknown,
  revision: unknown,
): OperatorRunRef | undefined {
  const parsed = kind(type);
  if (
    !parsed || typeof id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id) ||
    revision !== undefined &&
      (parsed !== "sentinel" || typeof revision !== "number" ||
        !Number.isSafeInteger(revision) || revision < 1)
  ) return;
  return { kind: parsed, id, ...(revision !== undefined && { revision }) };
}

function safeProjection(value: Record<string, unknown>) {
  const text = JSON.stringify({ ...value, _classification: "INTERNAL" });
  return text.length <= 8000
    ? text
    : "Error: Select a run type or exact run to narrow the response.";
}

function asWorkflowSummary(
  run: OperatorWorkflowRun | undefined,
): OperatorRunSummary | undefined {
  return run && {
    ref: { kind: "workflow", id: run.runId },
    label: run.planId,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    classification: run.classification,
    details: { currentStep: run.currentStep ?? null, steps: run.steps },
  };
}

function workflowProvider(
  workflows: OperatorWorkflowRuns,
): OperatorRunProvider {
  function project(run: OperatorWorkflowRun) {
    return asWorkflowSummary(run)!;
  }
  return {
    list: () => [
      ...workflows.list().map(project),
      ...workflows.listPlans().map(({ id, classification, stepCount }) => ({
        ref: { kind: "workflow" as const, id },
        label: id,
        status: "configured",
        classification,
        details: { stepCount },
      })),
    ],
    inspect(ref) {
      return asWorkflowSummary(workflows.inspect(ref.id));
    },
    mutations: {
      start: (ref, context) =>
        asWorkflowSummary(
          workflows.start(ref.id, "INTERNAL", context?.requestId),
        ),
      pause: (ref) => asWorkflowSummary(workflows.pause(ref.id)),
      resume: (ref) => asWorkflowSummary(workflows.resume(ref.id)),
    },
  };
}

export function createOperatorRunToolExecutor(options: {
  readonly baseDir: string;
  readonly confirm: (message: string) => Promise<boolean>;
  readonly workflows?: OperatorWorkflowRuns;
  readonly webContainmentConfigured?: boolean;
  readonly profiles?: () => readonly { provider: string; model: string }[];
}): OperatorRunToolExecutor {
  const providers = {
    sentinel: createOperatorSentinelRuns(
      options.baseDir,
      options.webContainmentConfigured,
    ),
    ...(options.workflows && { workflow: workflowProvider(options.workflows) }),
  };
  const digestPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  const unavailable = "Error: This operation or exact run is unavailable.";

  return async (args) => {
    if (
      Object.keys(args).some((key) =>
        !Object.hasOwn(operatorRunTool.parameters, key)
      )
    ) {
      return "Error: Supply only defined operator run fields.";
    }
    const action = args.action;
    if (action === "profiles") {
      return safeProjection({
        profiles: options.profiles?.().slice(0, 10) ?? [],
      });
    }
    const links = openOperatorRunLinkStore(
      join(options.baseDir, "operator-run-links.db"),
    );
    try {
      const controller = new OperatorRunController({
        scope: "workspace-operator",
        operatorId: "owner",
        authorize: (_action, ref) => Object.hasOwn(providers, ref.kind),
        providers,
        links,
        approveLink: ({ left, right }) =>
          options.confirm(
            `Link these exact operator runs?\n${
              JSON.stringify({ left, right })
            }`,
          ),
      });
      if (action === "list") {
        const filter = kind(args.kind);
        if (args.kind !== undefined && !filter) return unavailable;
        return safeProjection({
          runs: (await controller.list(filter)).slice(0, 20),
        });
      }
      const ref = reference(args.kind, args.id, args.revision);
      if (!ref) return unavailable;
      if (
        action === "graph" || action === "findings" || action === "node" ||
        action === "traces"
      ) {
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !await controller.inspect(ref)
        ) return unavailable;
        const scope = {
          snapshotPath: resolveSentinelCasePath(options.baseDir, ref.id),
          assessmentRevision: ref.revision,
        };
        const page = {
          revision: ref.revision,
          ...(args.offset !== undefined && { offset: args.offset }),
          ...(args.limit !== undefined && { limit: args.limit }),
        };
        const query = args.query !== undefined ? { query: args.query } : {};
        const response = action === "node"
          ? inspectSentinelProvenance(scope, { ...page, node: args.node })
          : action === "traces"
          ? searchSentinelWorkerTraces(scope, {
            ...page,
            ...query,
            ...(args.taskId !== undefined && { task: args.taskId }),
            ...(args.stepIndices !== undefined &&
              { stepIndices: args.stepIndices }),
          })
          : searchSentinelProvenance(scope, {
            ...page,
            ...query,
            ...(action === "findings" && { kind: "finding" }),
          });
        return response.startsWith("Error:")
          ? response
          : safeProjection({ run: ref, page: JSON.parse(response) });
      }
      if (action === "inspect") {
        const run = await controller.inspect(ref);
        return run
          ? safeProjection({ run, links: await controller.listLinks(run.ref) })
          : unavailable;
      }
      if (action === "link") {
        const other = reference(
          args.targetKind,
          args.targetId,
          args.targetRevision,
        );
        const requestId = args.requestId;
        if (
          !other || typeof requestId !== "string" ||
          !digestPattern.test(requestId) ||
          ref.kind === "sentinel" && ref.revision === undefined ||
          other.kind === "sentinel" && other.revision === undefined
        ) return unavailable;
        const link = await controller.link({
          requestId: requestId.toLowerCase(),
          left: ref,
          right: other,
        });
        return link ? safeProjection({ link }) : unavailable;
      }
      if (
        action !== "start" && action !== "pause" && action !== "resume" &&
        action !== "steer" && action !== "hint"
      ) {
        return unavailable;
      }
      if (
        ref.kind === "sentinel" && action !== "start" &&
        ref.revision === undefined
      ) {
        return "Error: Use the exact Sentinel evidence revision from run inspection.";
      }
      let control;
      if (action === "start" && ref.kind === "workflow") {
        if (
          typeof args.requestId !== "string" ||
          !digestPattern.test(args.requestId)
        ) {
          return "Error: Start a configured workflow with a stable request UUID.";
        }
        control = { requestId: args.requestId.toLowerCase() };
      }
      if (action === "steer" || action === "hint") {
        if (
          ref.kind !== "sentinel" ||
          (action === "steer"
            ? typeof args.taskId !== "string" ||
              !/^adaptive:[a-f0-9]{64}$/.test(args.taskId)
            : args.taskId !== undefined) ||
          typeof args.note !== "string" || !args.note.trim() ||
          args.note.length > 1000 ||
          typeof args.requestId !== "string" ||
          !digestPattern.test(args.requestId)
        ) return unavailable;
        control = {
          ...(typeof args.taskId === "string" && { taskId: args.taskId }),
          note: args.note.trim(),
          requestId: args.requestId.toLowerCase(),
        };
      }
      if (
        !await options.confirm(
          `Approve operator run action ${action}?\n${
            JSON.stringify({ ref, ...control })
          }`,
        )
      ) {
        return "Error: The operator declined the run action.";
      }
      const run = await controller.mutate(action, ref, control);
      return run ? safeProjection({ run }) : unavailable;
    } catch {
      return unavailable;
    } finally {
      links.close();
    }
  };
}
