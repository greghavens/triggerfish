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
import {
  readSentinelAssessment,
  readSentinelAssessmentRevision,
  readSentinelOperatingConstraintHistory,
  readSentinelOperatingConstraints,
  readSentinelOperatingConstraintVersion,
  recordSentinelOperatingConstraints,
} from "../sentinel/assessment_store.ts";
import { resolveSentinelCaseMembership } from "../sentinel/case_membership.ts";
import { resolveSentinelCasePath } from "../sentinel/cases.ts";
import {
  normalizeSentinelOperatingConstraints,
  validateSentinelOperatingConstraintAssets,
} from "../sentinel/operating_constraints.ts";
import {
  inspectSentinelProvenance,
  searchSentinelProvenance,
  searchSentinelWorkerTraces,
} from "./sentinel_agent.ts";
import { submitSentinelAssignmentIntent } from "./sentinel_adaptive_runtime.ts";
import { executeOperatorSentinelArchive } from "./operator_sentinel_archive.ts";
import { readOperatorSentinelInventory } from "./operator_sentinel_inventory.ts";
import { createOperatorSentinelRuns } from "./operator_sentinel_runs.ts";
import type {
  OperatorWorkflowRun,
  OperatorWorkflowRuns,
} from "./operator_workflow_runs.ts";

export const operatorRunTool: ToolDefinition = {
  name: "operator_runs",
  description:
    "List and inspect approved runs. With operator confirmation, control an exact run or narrow which defensive tasks and assets Sentinel may schedule. Constraints do not grant capabilities.",
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
        "assign",
        "archive",
        "restore",
        "archive_history",
        "steer",
        "stop",
        "hint",
        "profiles",
        "graph",
        "findings",
        "node",
        "inventory",
        "preview_membership",
        "set_case_membership",
        "traces",
        "constraints",
        "narrow_constraints",
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
    archiveId: {
      type: "string",
      description: "Exact UUID of an existing workspace run archive",
    },
    before: {
      type: "integer",
      description: "Continuation for archive action history",
    },
    runId: {
      type: "string",
      description: "Exact Sentinel assessment run UUID from inspection",
    },
    adaptiveRevision: {
      type: "string",
      description:
        "Exact Sentinel worker assignment revision from run inspection",
    },
    expectedVersion: {
      type: "integer",
      description:
        "Exact current operating constraint version, or zero before the first constraint",
    },
    version: {
      type: "integer",
      description: "Read one exact saved operating constraint version",
    },
    deniedKinds: {
      type: "array",
      items: { type: "string" },
      description: "Complete set of defensive task kinds to disable in the run",
    },
    allowedAssetIds: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional exact asset IDs to restrict future tasks within baseline authorization",
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
    taskKind: {
      type: "string",
      description: "Supported defensive investigation kind for an exact node",
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
    node: {
      type: "string",
      description:
        "Exact graph node for assignment or saved provenance ID for inspection",
    },
    stepIndices: {
      type: "array",
      items: { type: "integer" },
      description: "Exact worker step indices for the selected assignment",
    },
    scope: {
      type: "string",
      description: "Published case inventory or approved case membership",
      enum: ["case", "membership"],
    },
    view: {
      type: "string",
      description: "Saved case inventory view",
      enum: ["assets", "organizations", "coverage"],
    },
    assetId: { type: "string", description: "Exact published case asset ID" },
    organizationId: {
      type: "string",
      description: "Exact organization ID declared in the selected case",
    },
    assetType: { type: "string", description: "Published asset type filter" },
    parentId: { type: "string", description: "Exact published parent ID" },
    alias: { type: "string", description: "Exact published asset alias" },
    cursor: {
      type: "string",
      description: "Opaque continuation cursor for workflow trace events",
    },
    sequence: {
      type: "integer",
      description: "Exact workflow trace event sequence",
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
        action === "archive" || action === "restore" ||
        action === "archive_history"
      ) {
        const result = await executeOperatorSentinelArchive(
          options.baseDir,
          ref,
          args,
          options.confirm,
        );
        return typeof result === "string" ? result : safeProjection(result);
      }
      if (action === "assign") {
        const { runId, adaptiveRevision, requestId, taskKind, node } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "adaptiveRevision",
              "requestId",
              "taskKind",
              "node",
            ].includes(key)
          ) ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof adaptiveRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(adaptiveRevision) ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          typeof taskKind !== "string" || !/^[a-z_]{1,64}$/.test(taskKind) ||
          typeof node !== "string" || !node.trim() || node.length > 4096 ||
          node.includes("\0")
        ) return unavailable;
        const before = await controller.inspect(ref);
        if (
          !before || before.details?.runId !== runId.toLowerCase() ||
          before.details.adaptiveRevision !== adaptiveRevision ||
          (before.status !== "running" && before.status !== "paused")
        ) return unavailable;
        const intent = {
          requestId: requestId.toLowerCase(),
          runId: runId.toLowerCase(),
          evidenceRevision: ref.revision,
          adaptiveRevision,
          kind: taskKind,
          nodeId: node,
        };
        if (
          !await options.confirm(
            `Approve this exact Sentinel investigation?\n${
              JSON.stringify({ ref, ...intent })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        const receipt = submitSentinelAssignmentIntent(
          resolveSentinelCasePath(options.baseDir, ref.id),
          intent,
        );
        return receipt ? safeProjection({ run: ref, receipt }) : unavailable;
      }
      if (action === "steer" || action === "stop") {
        const { runId, adaptiveRevision, taskId, requestId, note } = args;
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "adaptiveRevision",
              "taskId",
              "requestId",
              "note",
            ].includes(key)
          ) ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          typeof adaptiveRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(adaptiveRevision) ||
          typeof taskId !== "string" ||
          !/^adaptive:[a-f0-9]{64}$/.test(taskId) ||
          typeof requestId !== "string" || !digestPattern.test(requestId) ||
          (action === "steer"
            ? typeof note !== "string" || !note.trim() ||
              note.length > 1000 || note.includes("\x00")
            : note !== undefined)
        ) return unavailable;
        const before = await controller.inspect(ref);
        if (
          !before || before.details?.runId !== runId.toLowerCase() ||
          before.details.adaptiveRevision !== adaptiveRevision ||
          before.status !== "running"
        ) return unavailable;
        const target = {
          runId: runId.toLowerCase(),
          adaptiveRevision,
          taskId,
          requestId: requestId.toLowerCase(),
          ...(typeof note === "string" && { note: note.trim() }),
        };
        if (
          !await options.confirm(
            `Approve ${action} for this exact Sentinel assignment?\n${
              JSON.stringify({ ref, ...target })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        const receipt = providers.sentinel.workerControl(ref, action, target);
        return receipt
          ? safeProjection({ run: ref, runId: target.runId, receipt })
          : unavailable;
      }
      if (action === "preview_membership" || action === "set_case_membership") {
        const {
          runId,
          allowedAssetIds,
          organizationId,
          expectedVersion,
          requestId,
        } = args;
        const update = action === "set_case_membership";
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          typeof runId !== "string" || !digestPattern.test(runId) ||
          (organizationId === undefined
            ? !Array.isArray(allowedAssetIds) ||
              allowedAssetIds.some((id) => typeof id !== "string")
            : typeof organizationId !== "string" ||
              allowedAssetIds !== undefined) ||
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "allowedAssetIds",
              "organizationId",
              ...(update ? ["expectedVersion", "requestId"] : []),
            ].includes(key)
          ) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const current = readSentinelAssessment(path);
        const activeRunId = runId.toLowerCase();
        if (
          !current?.active || current.revision !== ref.revision ||
          current.plan.runId !== activeRunId ||
          !current.result?.sharedGraph.snapshot
        ) return unavailable;
        const membership = resolveSentinelCaseMembership(
          current.result.sharedGraph.snapshot,
          {
            caseId: ref.id,
            evidenceRevision: ref.revision,
            selector: typeof organizationId === "string"
              ? { kind: "organization", organizationId }
              : { kind: "assets", assetIds: allowedAssetIds as string[] },
          },
        );
        if (!membership) return unavailable;
        const prior = readSentinelOperatingConstraints(path, activeRunId);
        const version = prior?.version ?? 0;
        if (!update) {
          return safeProjection({
            run: ref,
            runId: activeRunId,
            version,
            membership,
          });
        }
        if (
          typeof expectedVersion !== "number" ||
          !Number.isSafeInteger(expectedVersion) ||
          expectedVersion < 0 || expectedVersion >= 1024 ||
          typeof requestId !== "string" || !digestPattern.test(requestId)
        ) return unavailable;
        const constraints = normalizeSentinelOperatingConstraints({
          ...(prior?.constraints ?? { deniedKinds: [] }),
          allowedAssetIds: membership.assetIds,
        });
        const request = requestId.toLowerCase();
        if (version !== expectedVersion) {
          const replay = readSentinelOperatingConstraintVersion(
            path,
            activeRunId,
            expectedVersion + 1,
          );
          if (
            replay?.requestId !== request ||
            replay.evidenceRevision !== ref.revision ||
            JSON.stringify(replay.membership) !== JSON.stringify(membership)
          ) return unavailable;
          return safeProjection({
            run: ref,
            version: replay.version,
            digest: replay.digest,
            sourceDigest: membership.snapshotDigest,
          });
        }
        if (
          !await options.confirm(
            `Approve this exact Sentinel case membership?\n${
              JSON.stringify({
                run: ref,
                runId: activeRunId,
                expectedVersion,
                requestId: request,
                selector: membership.selector,
                snapshotDigest: membership.snapshotDigest,
                assetIds: membership.assetIds,
              })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        const committed = recordSentinelOperatingConstraints(path, {
          runId: activeRunId,
          evidenceRevision: ref.revision,
          expectedVersion,
          requestId: request,
          operatorScope: "workspace-operator",
          constraints,
          membership,
        });
        return committed
          ? safeProjection({
            run: ref,
            version: committed.version,
            digest: committed.digest,
            sourceDigest: membership.snapshotDigest,
          })
          : unavailable;
      }
      if (action === "constraints" || action === "narrow_constraints") {
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          typeof args.runId !== "string" || !digestPattern.test(args.runId) ||
          !await controller.inspect(ref)
        ) return unavailable;
        const path = resolveSentinelCasePath(options.baseDir, ref.id);
        const current = readSentinelAssessment(path);
        const runId = args.runId.toLowerCase();
        const revision = ref.revision;
        if (action === "constraints") {
          if (
            Object.keys(args).some((key) =>
              !["action", "kind", "id", "revision", "runId", "limit", "version"]
                .includes(
                  key,
                )
            )
          ) return unavailable;
          const limit = args.limit ?? 3;
          const version = args.version;
          if (
            typeof limit !== "number" || !Number.isSafeInteger(limit) ||
            limit < 1 || limit > 10 ||
            (version !== undefined && (typeof version !== "number" ||
              !Number.isSafeInteger(version) || version < 1))
          ) return unavailable;
          const history = readSentinelOperatingConstraintHistory(
            path,
            runId,
            30,
            revision,
          );
          const matchesRun = current?.plan.runId === runId &&
              current.revision === ref.revision ||
            readSentinelAssessmentRevision(path, ref.revision)?.plan?.runId ===
              runId ||
            history.some((record) => record.evidenceRevision === ref.revision);
          if (!matchesRun) return unavailable;
          const record = version === undefined
            ? undefined
            : readSentinelOperatingConstraintVersion(path, runId, version);
          if (
            version !== undefined &&
            (!record || record.evidenceRevision > revision)
          ) return unavailable;
          return safeProjection({
            run: ref,
            runId,
            version: history[0]?.version ?? 0,
            history: record ? [record] : history.slice(0, limit),
          });
        }
        const { expectedVersion, requestId } = args;
        if (
          Object.keys(args).some((key) =>
            ![
              "action",
              "kind",
              "id",
              "revision",
              "runId",
              "expectedVersion",
              "requestId",
              "deniedKinds",
              "allowedAssetIds",
              "note",
            ].includes(key)
          ) ||
          !current?.active || current.plan.runId !== runId ||
          current.revision !== ref.revision ||
          typeof expectedVersion !== "number" ||
          !Number.isSafeInteger(expectedVersion) ||
          expectedVersion < 0 || expectedVersion >= 1024 ||
          typeof requestId !== "string" ||
          !digestPattern.test(requestId)
        ) return unavailable;
        const constraints = normalizeSentinelOperatingConstraints({
          deniedKinds: args.deniedKinds,
          ...(args.allowedAssetIds !== undefined &&
            { allowedAssetIds: args.allowedAssetIds }),
          ...(args.note !== undefined && { note: args.note }),
        });
        if (
          !validateSentinelOperatingConstraintAssets(
            constraints,
            current.result?.sharedGraph.snapshot,
          )
        ) return unavailable;
        const update = {
          runId,
          evidenceRevision: ref.revision,
          expectedVersion,
          requestId: requestId.toLowerCase(),
          operatorScope: "workspace-operator",
          constraints,
        };
        const existing = readSentinelOperatingConstraints(path, runId);
        if ((existing?.version ?? 0) !== expectedVersion) {
          const replay = readSentinelOperatingConstraintVersion(
            path,
            runId,
            expectedVersion + 1,
          );
          if (
            replay?.requestId !== update.requestId ||
            replay.evidenceRevision !== revision ||
            JSON.stringify(replay.constraints) !== JSON.stringify(constraints)
          ) return unavailable;
        }
        if (
          !await options.confirm(
            `Approve these exact Sentinel task restrictions?\n${
              JSON.stringify({ caseId: ref.id, ...update })
            }`,
          )
        ) return "Error: The operator declined the run action.";
        const recorded = recordSentinelOperatingConstraints(path, update);
        return recorded
          ? safeProjection({ run: ref, record: recorded })
          : unavailable;
      }
      if (action === "inventory") {
        if (
          ref.kind !== "sentinel" || ref.revision === undefined ||
          !await controller.inspect(ref)
        ) return unavailable;
        const {
          action: _action,
          kind: _kind,
          id: _id,
          revision: _revision,
          ...query
        } = args;
        const page = readOperatorSentinelInventory(
          options.baseDir,
          ref,
          query,
          "INTERNAL",
        );
        return page ? safeProjection({ run: ref, page }) : unavailable;
      }
      if (action === "traces" && ref.kind === "workflow") {
        const { cursor, limit, sequence } = args;
        if (
          Object.keys(args).some((key) =>
            !["action", "kind", "id", "cursor", "sequence", "limit"]
              .includes(key)
          ) ||
          (cursor !== undefined && typeof cursor !== "string") ||
          (limit !== undefined && typeof limit !== "number") ||
          (sequence !== undefined && typeof sequence !== "number") ||
          !await controller.inspect(ref)
        ) return unavailable;
        const page = options.workflows?.traces(ref.id, "INTERNAL", {
          cursor,
          limit,
          sequence,
        });
        return page ? safeProjection({ run: ref, page }) : unavailable;
      }
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
        action !== "hint"
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
      if (action === "hint") {
        if (
          ref.kind !== "sentinel" ||
          args.taskId !== undefined ||
          typeof args.note !== "string" || !args.note.trim() ||
          args.note.length > 1000 ||
          typeof args.requestId !== "string" ||
          !digestPattern.test(args.requestId)
        ) return unavailable;
        control = {
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
